// V-PARC 판단 가능성 모델 (A2) — 휴대폰 브라우저에서 ONNX로 실행
// 입력: 224x224 RGB(ImageNet 평균·표준편차) + 수치 특징 6개 (학습 노트북 degrade.features()와 같은 계산)
// 출력: [판단 충분, 기체 없음, 잘림, 바닥 안 보임, 흔들림, 역광] 확률
export const MODEL_URL = 'models/judgeability_v2.onnx';
export const META_URL = 'models/meta.json';
export const ORT_VER = '1.19.2';
export const REASONS = ['none', 'cut', 'floor', 'blur', 'light'];
const CACHE = 'vparc-models-v2';
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

// ---- 수치 특징: 160x120 회색조 (학습 때와 같은 식) ----
const small = document.createElement('canvas'); small.width = 160; small.height = 120;
const sctx = small.getContext('2d', { willReadFrequently: true });
sctx.imageSmoothingEnabled = true; sctx.imageSmoothingQuality = 'high';
export function grayStats(src) {
  sctx.drawImage(src, 0, 0, 160, 120);
  const d = sctx.getImageData(0, 0, 160, 120).data, g = new Float32Array(160 * 120);
  let sum = 0, top = 0, mid = 0;
  for (let i = 0; i < g.length; i++) {
    g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; sum += g[i];
    const y = (i / 160) | 0; if (y < 40) top += g[i]; else if (y < 80) mid += g[i];
  }
  let m = 0, m2 = 0, n = 0;                                   // 라플라시안 분산 (낮을수록 흐림)
  for (let y = 1; y < 119; y++) for (let x = 1; x < 159; x++) {
    const i = y * 160 + x, v = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - 160] - g[i + 160];
    m += v; m2 += v * v; n++;
  }
  m /= n;
  return { bright: sum / g.length, back: (top - mid) / (160 * 40), sharp: m2 / n - m * m };
}
// box: 0~1 정규화 {x, y, w, h} 또는 null
export function features(stats, box) {
  const f = [stats.bright / 255, stats.back / 255, Math.log1p(Math.max(0, stats.sharp)) / 10, 0, 0, 0];
  if (box) {
    f[3] = Math.min(box.x, 1 - (box.x + box.w), box.y);
    f[4] = 1 - (box.y + box.h);
    f[5] = box.w * box.h;
  }
  return Float32Array.from(f);
}

// ---- 224x224 텐서 ----
const big = document.createElement('canvas'); big.width = 224; big.height = 224;
const bctx = big.getContext('2d', { willReadFrequently: true });
bctx.imageSmoothingEnabled = true; bctx.imageSmoothingQuality = 'high';
export function imageTensor(src) {
  bctx.drawImage(src, 0, 0, 224, 224);                        // 학습 때처럼 비율 무시하고 224로 맞춤
  const d = bctx.getImageData(0, 0, 224, 224).data, N = 224 * 224, out = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) out[c * N + i] = (d[i * 4 + c] / 255 - MEAN[c]) / STD[c];
  return out;
}

// ---- 모델 받기 (한 번 받으면 폰에 저장: 10/13 로딩 대책) ----
// 11/17 아이폰: 저장본이 깨지면 계속 실패 → 실패 시 지우고 다시 받음. 저장이 안 되는 경우 대비로 IndexedDB에도 저장하고 이유를 기록
export const store = { note: '' };                 // 화면 맨 아래에 보여 줄 저장 상태
const IDB = 'vparc-models', IDB_STORE = 'files';
const keyOf = (url) => new URL(url, location.href).href;
function idb() {
  return new Promise((ok, bad) => {
    if (!('indexedDB' in self)) return bad(new Error('no indexedDB'));
    const r = indexedDB.open(IDB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
    r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((ok, bad) => { const q = db.transaction(IDB_STORE).objectStore(IDB_STORE).get(key); q.onsuccess = () => { db.close(); ok(q.result || null); }; q.onerror = () => { db.close(); bad(q.error); }; });
}
async function idbPut(key, buf) {
  const db = await idb();
  return new Promise((ok, bad) => { const t = db.transaction(IDB_STORE, 'readwrite'); t.objectStore(IDB_STORE).put(buf, key); t.oncomplete = () => { db.close(); ok(); }; t.onerror = () => { db.close(); bad(t.error); }; });
}
async function idbDel(key) { try { const db = await idb(); await new Promise((ok) => { const t = db.transaction(IDB_STORE, 'readwrite'); t.objectStore(IDB_STORE).delete(key); t.oncomplete = t.onerror = () => { db.close(); ok(); }; }); } catch (e) {} }
const errName = (e) => String(e && (e.name || e.message) || e).slice(0, 40);

async function fetchFresh(url) {
  const key = keyOf(url);
  const res = await fetch(url, { cache: 'reload' }); if (!res.ok) throw new Error(url + ' ' + res.status);
  const buf = await res.arrayBuffer();
  let saved = false, why = '';
  if ('caches' in self) { try { const c = await caches.open(CACHE); await c.put(key, new Response(buf.slice(0), { headers: { 'Content-Type': 'application/octet-stream' } })); saved = true; } catch (e) { why = 'cache ' + errName(e); } }
  if (!saved) { try { await idbPut(key, buf.slice(0)); saved = true; why = ''; } catch (e) { why += ' idb ' + errName(e); } }
  store.note = saved ? '' : '저장 안 됨: ' + why.trim();
  return buf;
}
async function fetchCached(url) {
  const key = keyOf(url); let why = '';
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  if ('caches' in self) {
    try { const c = await caches.open(CACHE), hit = await c.match(key); if (hit) return { buf: await hit.arrayBuffer(), cached: true }; why = '저장본 없음'; }
    catch (e) { why = 'cache 읽기 ' + errName(e); }
  }
  try { const b = await idbGet(key); if (b) return { buf: b, cached: true }; } catch (e) {}
  const buf = await fetchFresh(url);
  if (!store.note) store.note = why === '저장본 없음' ? '' : why;
  return { buf, cached: false };
}
async function dropCached(url) {
  const key = keyOf(url);
  if ('caches' in self) { try { const c = await caches.open(CACHE); await c.delete(key); await c.delete(url); } catch (e) {} }
  await idbDel(key);
}
function loadOrt() {
  if (window.ort) return Promise.resolve(window.ort);
  return new Promise((ok, bad) => {
    const s = document.createElement('script');
    s.src = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/ort.min.js`;
    s.onload = () => ok(window.ort); s.onerror = () => bad(new Error('onnxruntime-web을 불러오지 못했어요'));
    document.head.appendChild(s);
  });
}

export async function loadJudge() {
  const t0 = performance.now();
  const meta = await fetch(META_URL).then(r => r.json()).catch(() => null);
  if (window.__mockJudge) return { meta, run: window.__mockJudge, ms: 0, cached: true, mock: true };   // 시험용
  const ort = await loadOrt();
  ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/`;
  ort.env.wasm.numThreads = (self.crossOriginIsolated && navigator.hardwareConcurrency > 1) ? Math.min(4, navigator.hardwareConcurrency) : 1;
  const create = (b) => ort.InferenceSession.create(b, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  let { buf, cached } = await fetchCached(MODEL_URL), sess, retried = null;
  try { sess = await create(buf); }
  catch (e1) {                                                // 저장본이 깨졌거나 받다 끊긴 경우: 지우고 한 번 더 새로 받음
    retried = String(e1 && e1.message || e1).slice(0, 80); buf = null;
    await dropCached(MODEL_URL);
    try { buf = await fetchFresh(MODEL_URL); cached = false; sess = await create(buf); }
    catch (e2) { const err = new Error('다시 받아도 실패: ' + String(e2 && e2.message || e2).slice(0, 80) + ' / 처음: ' + retried); throw err; }
  }
  buf = null;
  const run = async (src, box) => {
    const img = new ort.Tensor('float32', imageTensor(src), [1, 3, 224, 224]);
    const ft = new ort.Tensor('float32', features(grayStats(src), box), [1, 6]);
    const out = await sess.run({ image: img, feats: ft });
    const p = out.probs.data;
    return { sufficient: p[0], none: p[1], cut: p[2], floor: p[3], blur: p[4], light: p[5] };
  };
  const release = () => { try { sess.release && sess.release(); } catch (e) {} };
  return { meta, run, ms: performance.now() - t0, cached, retried, release };
}

// ---- A2 안내 상태: 초당 3번, 최근 5번 평균, 사유별 기준값, 1.5초 유지, 3번 연속 충분하면 준비 완료 ----
export function makeGuide(meta) {
  const a2 = meta?.a2 || {};
  const need = Object.fromEntries(REASONS.map(r => [r, (a2.reason_need && a2.reason_need[r]) ?? 0.6]));
  const cfg = { need, ready: a2.ready ?? 0.7, readyN: a2.ready_frames ?? 3, holdMs: a2.hold_ms ?? 1500, win: 5, giveUpMs: 15000 };
  const st = { hist: [], okRun: 0, shown: null, shownAt: -1e9, startedAt: performance.now(), current: 'pending', lastProbs: null };
  return {
    cfg, st,
    reset() { Object.assign(st, { hist: [], okRun: 0, shown: null, shownAt: -1e9, startedAt: performance.now(), current: 'pending' }); },
    // probs 하나를 넣으면 화면에 띄울 문구 키를 돌려준다 (바뀌지 않으면 null)
    push(p, now = performance.now()) {
      st.lastProbs = p;
      st.hist.push(p); if (st.hist.length > cfg.win) st.hist.shift();
      st.okRun = p.sufficient >= cfg.ready ? st.okRun + 1 : 0;
      const ready = st.okRun >= cfg.readyN;
      const avg = (k) => st.hist.reduce((s, h) => s + h[k], 0) / st.hist.length;
      const top = ready ? null : REASONS.find(r => avg(r) > need[r]) || null;
      let key = ready ? 'ready' : (top || (st.shown === 'ready' ? 'ready' : (st.shown || 'loading')));
      if (!ready && top && now - st.startedAt > cfg.giveUpMs) key = 'wait';   // S2: 15초 넘게 미달이면 셔터는 열어 두고 안내만
      st.current = ready ? 'ready' : (top || 'pending');
      if (key === st.shown) return null;
      if (st.shown !== null && st.shown !== 'loading' && now - st.shownAt < cfg.holdMs) return null;
      st.shown = key; st.shownAt = now;
      return key;
    },
  };
}
