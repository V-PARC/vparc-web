// 설계서 6.2 검사 항목 끝-끝 자동 시험 (웹 화면 + 로컬 판정 API): T2, T7, T8, T12
//
//   VPARC_API_DIR=../vparc-api node e2e/t_items.mjs            # 결과: e2e/out/t_items_result.json
//
// - 판정 API는 e2e/run_api.py로 임시 DB에 띄우고, 판정기는 고정 확률(+지연)으로 대신한다.
// - 휴대폰 카메라 대신 ?test=img, 검출기·판단 가능성 모델·사람 분할은 페이지의 시험 훅(__mockDets, __mockJudge, __mockSeg)을 쓴다.
// - 127.0.0.1 밖으로 나가는 요청은 모두 막고 기록한다(T7: 페이지가 어디로 무엇을 보내는지 전수 확인).
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');   // 전역 설치본도 찾도록 require 사용
const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = resolve(process.env.VPARC_API_DIR || join(WEB, '..', 'vparc-api'));
const WEB_PORT = 8766, ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const GPS = { latitude: 37.281234, longitude: 127.043456, accuracy: 8 };
const results = [];
const procs = [];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function record(id, name, pass, evidence) {
  results.push({ id, name, pass, evidence });
  console.log(`${pass === true ? 'PASS' : pass === false ? 'FAIL' : 'NOTE'}  ${id}  ${name}\n      ${JSON.stringify(evidence)}`);
}

async function waitHttp(url, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await fetch(url); if (r.ok) return; } catch {} await sleep(200); }
  throw new Error('timeout ' + url);
}
let apiN = 0;
async function startApi(delay = 0) {
  const port = 8770 + (apiN++), dir = mkdtempSync(join(tmpdir(), 'vparc_e2e_'));
  const p = spawn('python3', [join(WEB, 'e2e', 'run_api.py'), String(port), dir, String(delay)],
    { env: { ...process.env, VPARC_API_DIR: API_DIR, E2E_ORIGIN: ORIGIN }, stdio: ['ignore', 'inherit', 'inherit'] });
  procs.push(p);
  await waitHttp(`http://127.0.0.1:${port}/v1/health`);
  return { base: `http://127.0.0.1:${port}/v1`, dir, db: join(dir, 'vparc.sqlite3'), stop: () => p.kill() };
}
function sql(db, q) {
  const out = execFileSync('python3', ['-c', `import sqlite3,json,sys;c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row;print(json.dumps([dict(r) for r in c.execute(sys.argv[2])]))`, db, q]);
  return JSON.parse(out.toString());
}
function dbDump(db) {
  return execFileSync('python3', ['-c', `import sqlite3,sys;print('\\n'.join(sqlite3.connect(sys.argv[1]).iterdump()))`, db]).toString();
}

// ---- 원본 사진(EXIF에 GPS·기종 포함)을 만들어 둠: 전송본에 이 값이 남는지 본다 ----
const FIX = mkdtempSync(join(tmpdir(), 'vparc_fix_'));
execFileSync('python3', ['-c', `
from PIL import Image
import sys
im = Image.open(sys.argv[1]).convert('RGB')
ex = Image.Exif()
ex[0x010F] = 'Apple'; ex[0x0110] = 'iPhone 15 Pro'
gps = {1: 'N', 2: (37.0, 16.0, 52.44), 3: 'E', 4: (127.0, 2.0, 36.44)}
ex[0x8825] = gps
im.save(sys.argv[2], 'JPEG', exif=ex.tobytes(), quality=92)
`, join(WEB, 'photos', '1-JTW-001.jpg'), join(FIX, 'orig.jpg')]);
const ORIG = readFileSync(join(FIX, 'orig.jpg'));

// ---- 정적 서버 ----
const web = spawn('python3', ['-m', 'http.server', String(WEB_PORT), '--bind', '127.0.0.1', '--directory', WEB], { stdio: 'ignore' });
procs.push(web);
await waitHttp(ORIGIN + '/index.html');

const browser = await chromium.launch();

// 페이지 하나를 열고 모든 요청을 기록. 바깥 주소는 막음
async function openPage({ gps = true } = {}) {
  const ctx = await browser.newContext({ geolocation: GPS, permissions: gps ? ['geolocation'] : [], viewport: { width: 390, height: 844 } });
  const log = [];
  await ctx.route('**/*', async (route) => {
    const req = route.request(), u = new URL(req.url());
    if (u.pathname === '/e2e/orig.jpg') return route.fulfill({ body: ORIG, contentType: 'image/jpeg' });
    if (u.hostname !== '127.0.0.1') { log.push({ blocked: true, method: req.method(), url: req.url() }); return route.abort(); }
    return route.fallback();
  });
  ctx.on('request', (req) => {
    if (new URL(req.url()).hostname !== '127.0.0.1') return;
    if (req.method() === 'GET') return;
    log.push({ method: req.method(), url: req.url(), headers: req.headers(), body: req.postDataBuffer() });
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('   [console]', m.text().slice(0, 200)); });
  return { ctx, page, log };
}

// ---- multipart 분해 ----
function parts(buf, ctype) {
  const b = '--' + /boundary=(.+)$/.exec(ctype)[1];
  const s = buf.toString('latin1'), out = [];
  for (const chunk of s.split(b).slice(1, -1)) {
    const i = chunk.indexOf('\r\n\r\n'), head = chunk.slice(0, i), body = chunk.slice(i + 4, -2);
    out.push({ name: /name="([^"]+)"/.exec(head)?.[1], type: /Content-Type: (.+)/i.exec(head)?.[1]?.trim() || null, body: Buffer.from(body, 'latin1') });
  }
  return out;
}
const hasExif = (jpg) => jpg.includes(Buffer.from('Exif\0\0', 'latin1'));
const judgmentReqs = (log) => log.filter(r => r.method === 'POST' && /\/judgments$/.test(r.url));

// ---- 촬영 화면 한 번 돌리기 ----
// seg: 'fail' | 'throw' | 'person' | 'cover' (사람 마스크가 킥보드를 덮음)
const BOX = { x: 0.30, y: 0.35, w: 0.40, h: 0.50 };
async function shoot(api, { seg = 'person', route = null, gps = true, extra = '' } = {}) {
  const { ctx, page, log } = await openPage({ gps });
  if (route) await ctx.route('**/judgments', route);
  await page.addInitScript(({ seg, BOX }) => {
    window.__mockDets = (src) => { const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
      return [{ boundingBox: { originX: BOX.x * w, originY: BOX.y * h, width: BOX.w * w, height: BOX.h * h }, categories: [{ score: 0.91 }] }]; };
    window.__mockJudge = async () => ({ sufficient: 0.95, none: 0.01, cut: 0.01, floor: 0.01, blur: 0.01, light: 0.01 });
    const mask = (fill) => ({ segment: (c) => { const W = 64, H = 48, a = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (fill(x / W, y / H)) a[y * W + x] = 1;
      return { categoryMask: { width: W, height: H, getAsUint8Array: () => a, close() {} } }; } });
    if (seg === 'fail') window.__mockSeg = 'fail';
    else if (seg === 'throw') window.__mockSeg = { segment() { throw new Error('주입한 가림 오류'); } };
    else if (seg === 'person') window.__mockSeg = mask((x, y) => x < 0.22 && y < 0.40);          // 왼쪽 위 행인 (킥보드 박스 밖)
    else if (seg === 'cover') window.__mockSeg = mask((x, y) => x > 0.28 && x < 0.72 && y > 0.3);  // 행인이 킥보드를 가림
  }, { seg, BOX });
  const q = new URLSearchParams({ api: api.base, test: 'img', src: '/e2e/orig.jpg', new: '1', op: 'BEAM', zone: 'Z1-001', place: 'e2e' });
  await page.goto(`${ORIGIN}/shoot.html?${q}${extra}`);
  await page.click('#btnStart');
  await page.waitForFunction(() => !document.getElementById('btnShutter').disabled);
  await sleep(1800);                                         // 안내가 '잘 찍혔어요'가 될 시간
  await page.click('#btnShutter');
  await page.click('#btnUse');
  let ended = 'result';
  try { await page.waitForURL(/result\.html/, { timeout: 20000 }); }
  catch { ended = 'error'; }
  const state = await page.evaluate(() => {
    const ss = {}, ls = {};
    for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); ss[k] = sessionStorage.getItem(k); }
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k); }
    return { ss, ls, text: document.body.innerText, buttons: [...document.querySelectorAll('#btns button')].map(b => b.textContent.trim()), pill: document.getElementById('hintText')?.textContent || null };
  });
  return { ctx, page, log, ended, state };
}

// =========================================================================================== T8
{
  const api = await startApi();
  for (const seg of ['fail', 'throw']) {
    const r = await shoot(api, { seg });
    const jr = judgmentReqs(r.log);
    const imgParts = jr.flatMap(x => parts(x.body, x.headers['content-type'])).filter(p => p.name === 'photo' || (p.type || '').startsWith('image/'));
    const meta = JSON.parse(parts(jr[0].body, jr[0].headers['content-type']).find(p => p.name === 'meta').body.toString('utf8'));
    const res = JSON.parse(r.state.ss['vparc.result'] || '{}');
    const ok = r.ended === 'result' && jr.length === 1 && imgParts.length === 0 && meta.redaction.status === 'FAILED'
      && res.result === 'review' && res.why === 'nophoto' && !!res.receipt && !r.state.buttons.some(t => /다시/.test(t));
    record('T8', `가림 오류 주입(${seg === 'fail' ? '가림 실패 신호' : '분할 함수 예외'}) → 사진 없이 접수`, ok,
      { judgment_requests: jr.length, image_uploads: imgParts.length, redaction: meta.redaction.status, screen: res.result + '/' + res.why, receipt: res.receipt, buttons: r.state.buttons });
    await r.ctx.close();
  }
  const db = sql(api.db, "SELECT count(*) n, sum(photo_path IS NOT NULL) with_photo FROM judgments");
  record('T8', '서버 DB: 가림 실패 판정에 저장된 사진', db[0].with_photo === 0, db[0]);

  // 참고: 가림이 판정 근거를 덮은 경우(EVIDENCE_LOSS)도 사진 없이 가야 함
  const statuses = [];
  const r = await shoot(api, { seg: 'cover', route: async (rt) => { const resp = await rt.fetch(); const b = await resp.text();
    statuses.push(resp.status() + ' ' + b.slice(0, 120)); return rt.fulfill({ response: resp, body: b }); } });
  const jr = judgmentReqs(r.log);
  record('T8+', '가림이 킥보드를 덮음(근거 손실) → 추가 확인 접수', r.ended === 'result',
    { ended: r.ended, judgment_requests: jr.length, image_uploads: jr.flatMap(x => parts(x.body, x.headers['content-type'])).filter(p => p.name === 'photo').length,
      redaction_sent: jr[0] ? JSON.parse(parts(jr[0].body, jr[0].headers['content-type']).find(p => p.name === 'meta').body.toString('utf8')).redaction : null,
      api_responses: statuses, pill: r.state.pill });
  await r.ctx.close();
  api.stop();
}

// =========================================================================================== T7
{
  const api = await startApi();
  const r = await shoot(api, { seg: 'person' });
  const reqs = r.log.filter(x => !x.blocked);
  const jr = judgmentReqs(r.log)[0];
  const ps = parts(jr.body, jr.headers['content-type']);
  const photo = ps.find(p => p.name === 'photo').body, meta = JSON.parse(ps.find(p => p.name === 'meta').body.toString('utf8'));
  // 전송 사진의 행인 영역이 가려졌는지 픽셀로 확인 (원본과 비교)
  const px = await r.page.evaluate(async ({ sent, orig }) => {
    const load = async (b64) => { const bmp = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + b64)).blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d'); g.drawImage(bmp, 0, 0); return { g, w: bmp.width, h: bmp.height }; };
    const mean = ({ g, w, h }, x0, y0, x1, y1) => { const d = g.getImageData(x0 * w, y0 * h, (x1 - x0) * w, (y1 - y0) * h).data; let s = 0, s2 = 0; const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) { const v = (d[i] + d[i + 1] + d[i + 2]) / 3; s += v; s2 += v * v; } const m = s / n;
      // 가장자리 세기: 옆 픽셀과의 밝기 차 평균. 흐리면 크게 줄어듦
      const rw = Math.round((x1 - x0) * w); let e = 0, ne = 0;
      for (let i = 4; i < d.length; i += 4) { if ((i / 4) % rw === 0) continue; e += Math.abs((d[i] + d[i + 1] + d[i + 2]) - (d[i - 4] + d[i - 3] + d[i - 2])) / 3; ne++; }
      return { mean: +m.toFixed(1), std: +Math.sqrt(Math.max(0, s2 / n - m * m)).toFixed(1), edge: +(e / ne).toFixed(2) }; };
    const S = await load(sent), O = await load(orig);
    return { sent_size: [S.w, S.h], orig_size: [O.w, O.h], person_area_sent: mean(S, 0.02, 0.02, 0.18, 0.35), person_area_orig: mean(O, 0.02, 0.02, 0.18, 0.35),
      scooter_area_sent: mean(S, 0.35, 0.45, 0.65, 0.8), scooter_area_orig: mean(O, 0.35, 0.45, 0.65, 0.8) };
  }, { sent: photo.toString('base64'), orig: ORIG.toString('base64') });
  // 가린 칸은 강한 흐림이라 가장자리 세기(옆 픽셀과의 차)가 원본의 1/5 아래로 줄어듦. 킥보드 칸은 원본과 같아야 함
  const masked = px.person_area_sent.edge < px.person_area_orig.edge / 5
    && Math.abs(px.scooter_area_sent.mean - px.scooter_area_orig.mean) < 6;
  const origBytesSent = reqs.some(x => x.body && x.body.includes(ORIG.subarray(200, 264)));
  record('T7', '전송 사진: 행인 영역 가림, 원본 바이트·EXIF 없음', masked && !hasExif(photo) && !origBytesSent,
    { ...px, exif_in_sent: hasExif(photo), exif_in_orig: hasExif(ORIG), original_bytes_in_any_request: origBytesSent });

  // 전송 항목 목록
  const allowed = new Set(['box', 'zone_id', 'operator', 'in_zone', 'caution']);
  const sentKeys = Object.keys(meta);
  const startReq = r.log.find(x => x.method === 'POST' && /\/returns$/.test(x.url));
  const startBody = JSON.parse(startReq.body.toString('utf8'));
  const coordStrs = [GPS.latitude.toFixed(6), GPS.longitude.toFixed(6)];
  const gpsInRequests = reqs.filter(x => x.body && coordStrs.some(s => x.body.toString('latin1').includes(s))).map(x => new URL(x.url).pathname);
  record('T7', '휴대폰 GPS 좌표 전송 (설계 기준: 0건)', gpsInRequests.length === 0,
    { requests_with_gps: gpsInRequests, meta_location: meta.location || null });
  record('T7', 'A3 (4) 밖의 전송 항목', null,
    { judgment_meta_extra_keys: sentKeys.filter(k => !allowed.has(k)), returns_body_keys: Object.keys(startBody),
      client_info: startBody.client || null });
  record('T7', '127.0.0.1(판정 API·페이지) 밖으로 나간 요청', null,
    { blocked_external: [...new Set(r.log.filter(x => x.blocked).map(x => new URL(x.url).origin + new URL(x.url).pathname))] });

  // 서버에 남은 것
  const dump = dbDump(api.db) + readFileSync(join(api.dir, 'judge_debug.jsonl'), { encoding: 'utf8', flag: 'a+' });
  record('T7', '서버 DB·로그에 남은 GPS 좌표', !coordStrs.some(s => dump.includes(s)), { found: coordStrs.filter(s => dump.includes(s)) });
  const stored = sql(api.db, 'SELECT photo_path, exif_found FROM judgments')[0];
  const storedJpg = readFileSync(join(api.dir, 'photos', stored.photo_path.replace(/^.*photos\//, '')));
  record('T7', '서버 저장 사진 EXIF', !hasExif(storedJpg), { exif_found_on_upload: stored.exif_found, exif_in_stored: hasExif(storedJpg) });

  // 브라우저 저장소
  const storeText = JSON.stringify(r.state.ss) + JSON.stringify(r.state.ls);
  const storedPhoto = /data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/.exec(storeText)?.[1];
  const storedMasked = storedPhoto ? await r.page.evaluate(async (b64) => { const bmp = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + b64)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0.02 * bmp.width, 0.02 * bmp.height, 0.16 * bmp.width, 0.33 * bmp.height).data; let s = 0, s2 = 0; const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) { const v = (d[i] + d[i + 1] + d[i + 2]) / 3; s += v; s2 += v * v; } const m = s / n; return +Math.sqrt(Math.max(0, s2 / n - m * m)).toFixed(1); }, storedPhoto) : null;
  record('T7', '브라우저 저장소: 좌표 없음, 저장된 사진은 가린 사진', !coordStrs.some(s => storeText.includes(s)) && (storedMasked === null || storedMasked < px.person_area_orig.std),
    { session_keys: Object.keys(r.state.ss), local_keys: Object.keys(r.state.ls), coords_found: coordStrs.filter(s => storeText.includes(s)), stored_photo_person_area_std: storedMasked });
  await r.ctx.close();
  api.stop();
}

// =========================================================================================== T12
{
  const cases = [
    { name: '첫 전송이 서버에 닿기 전에 끊김', delay: 0, mode: 'drop_before' },
    { name: '서버는 받아 저장했는데 응답이 끊김', delay: 0, mode: 'drop_response' },
    { name: '서버 처리(2.7초) 중 끊김 → 1초 뒤 재전송이 처리 중에 도착', delay: 2.7, mode: 'drop_mid' },
    { name: '세 번 모두 응답이 끊김 → 연결 복구 후 사용자가 다시 누름', delay: 0, mode: 'drop_all_then_tap' },
  ];
  for (const c of cases) {
    const api = await startApi(c.delay);
    let n = 0;
    const route = async (rt) => {
      n++;
      if (c.mode === 'drop_before' && n === 1) return rt.abort('connectionreset');
      if (c.mode === 'drop_response' && n === 1) { await rt.fetch(); return rt.abort('connectionreset'); }
      if (c.mode === 'drop_mid' && n === 1) { rt.fetch().catch(() => {}); await sleep(300); return rt.abort('connectionreset'); }
      if (c.mode === 'drop_all_then_tap' && n <= 3) { await rt.fetch(); return rt.abort('connectionreset'); }
      return rt.fallback();
    };
    const r = await shoot(api, { seg: 'person', route });
    if (c.mode === 'drop_all_then_tap') {
      await r.page.waitForFunction(() => !document.getElementById('btnUse').disabled);
      const pill = await r.page.textContent('#hintText');
      await r.page.click('#btnUse');
      await r.page.waitForURL(/result\.html/, { timeout: 20000 }).catch(() => {});
      r.state.pill = pill;
      r.state.ss = await r.page.evaluate(() => ({ 'vparc.result': sessionStorage.getItem('vparc.result') }));
      r.state.buttons = await r.page.evaluate(() => [...document.querySelectorAll('#btns button')].map(b => b.textContent.trim()));
    }
    await sleep(c.delay * 1000 + 500);
    const jr = judgmentReqs(r.log);
    const ids = jr.map(x => JSON.parse(parts(x.body, x.headers['content-type']).find(p => p.name === 'meta').body.toString('utf8')).request_id);
    const db = sql(api.db, 'SELECT judgment_id, attempt, receipt_no FROM judgments');
    const res = JSON.parse(r.state.ss['vparc.result'] || '{}');
    // 재촬영 요구 = 부적합 화면(다시 찍기가 주 버튼)이나 '다시 찍어' 안내. 적합 화면의 '다시 찍기'는 선택 버튼이라 제외
    const retakeAsked = res.result === 'bad' || /다시 찍어/.test(r.state.pill || '');
    record('T12', c.name, db.length === 1 && !retakeAsked && !!res.receipt,
      { sends: jr.length, distinct_request_ids: new Set(ids).size, judgments_in_db: db.length, attempts: db.map(d => d.attempt),
        screen: res.result || null, receipt: res.receipt || null, buttons: r.state.buttons, error_pill: c.mode === 'drop_all_then_tap' ? r.state.pill : undefined });
    await r.ctx.close();
    api.stop();
  }
}

// =========================================================================================== T2 (+T1 제약: 직선거리 추정 기준)
{
  const api = await startApi();
  const html = readFileSync(join(WEB, 'index.html'), 'utf8');
  const dests = [...html.matchAll(/\{n:'([^']+)',a:'([^']+)',lat:([\d.]+),lon:([\d.]+)\}/g)].map(m => ({ n: m[1], a: m[2] }));
  const rows = [];
  for (const d of dests) {
    const { ctx, page, log } = await openPage();
    await page.goto(`${ORIGIN}/index.html?api=${encodeURIComponent(api.base)}`);
    await page.fill('#q', d.n);
    await page.click(`[data-d="${d.n.replace(/"/g, '\\"')}"]`);
    await page.click('#go1');
    await page.waitForSelector('#sheet h3, #sheet .none');
    await sleep(300);
    const s = await page.evaluate(() => {
      const sh = document.getElementById('sheet');
      const metas = [...sh.querySelectorAll('.meta, .row .num')].map(e => e.textContent);
      return { none: !!sh.querySelector('.none'), go: sh.querySelectorAll('[data-go]').length, cards: sh.querySelectorAll('.card, .row').length,
        metres: metas.map(t => +(/([\d]+)m/.exec(t)?.[1] ?? NaN)), text: sh.innerText };
    });
    let leaveUrl = null;
    if (s.none) { await page.click('#goany'); await page.waitForURL(/return\.html/); leaveUrl = page.url(); }
    const gapPosts = log.filter(x => x.method === 'POST' && /\/gaps$/.test(x.url)).length;
    rows.push({ dest: d.n, area: d.a, no_zone: s.none, recommended: s.cards, start_buttons: s.go, max_m: s.metres.length ? Math.max(...s.metres) : null,
      gap_posts: gapPosts, mentions_nearest: s.none ? /가장 가까운 확인 구역/.test(s.text) : null,
      shoot_has_zone: leaveUrl ? /zone%3D|zone=/.test(decodeURIComponent(new URL(leaveUrl).searchParams.get('next') || '')) : null });
    await ctx.close();
  }
  const noZone = rows.filter(r => r.no_zone);
  const gapsDb = sql(api.db, "SELECT d.name, count(*) n FROM gaps g JOIN destinations d USING(destination_id) GROUP BY d.name");
  const ok = noZone.every(r => r.recommended === 0 && r.start_buttons === 0 && r.gap_posts === 1 && r.shoot_has_zone === false)
    && gapsDb.length === noZone.length && gapsDb.every(g => g.n === 1);
  record('T2', `구역 없는 목적지 ${noZone.length}곳: 구역 밖 안내 + 공백 기록, 먼 구역 추천 0건`, ok,
    { no_zone: noZone.map(r => r.dest), gaps_in_db: gapsDb, rows: noZone });
  const limitM = 120 * 1.2 / 1.25;                            // index.html: 직선거리×1.25 ÷ 1.2m/s < 120초
  const withZone = rows.filter(r => !r.no_zone);
  record('T1*', `구역 있는 목적지 ${withZone.length}곳: 화면에 뜬 구역이 모두 추정 도보 120초 안(${limitM.toFixed(0)}m 미만)`,
    withZone.every(r => r.max_m < limitM && r.recommended <= 3), { rows: withZone.map(r => ({ dest: r.dest, shown: r.recommended, max_m: r.max_m })) });
  api.stop();
}

await browser.close();
for (const p of procs) p.kill();
mkdirSync(join(WEB, 'e2e', 'out'), { recursive: true });
writeFileSync(join(WEB, 'e2e', 'out', 't_items_result.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
const failed = results.filter(r => r.pass === false);
console.log(`\n${results.filter(r => r.pass === true).length} pass, ${failed.length} fail, ${results.filter(r => r.pass === null).length} note`);
process.exit(0);
