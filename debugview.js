// V-PARC 시험 화면(vparc.app/test) 판정 근거 보기.
// 기록 하나(rec)를 받아 휴대폰 쪽(킥보드 검출·판단 가능성 모델·가림)과 서버 쪽(시설물 검출·판정기·판정 결합)을 그린다.
// rec 형식은 shoot.html의 makeDebugRecord 참고. result.html과 test/index.html이 같이 쓴다.

const CSS = `
.dv{--dv-bg:#fff;--dv-fg:#16181d;--dv-mut:#6b7280;--dv-line:#e5e7eb;--dv-soft:#f3f4f6;--dv-ok:#1a7f37;--dv-bad:#cf222e;--dv-warn:#9a6700;--dv-acc:#1f6feb;
  font:13px/1.5 Pretendard Variable,-apple-system,"Apple SD Gothic Neo",sans-serif;color:var(--dv-fg);background:var(--dv-bg);text-align:left}
@media (prefers-color-scheme:dark){.dv{--dv-bg:#16181d;--dv-fg:#e8eaee;--dv-mut:#9aa2ae;--dv-line:#2a2f37;--dv-soft:#1f232a;--dv-ok:#3fb950;--dv-bad:#f85149;--dv-warn:#d29922;--dv-acc:#4c8dff}}
.dv h3{font-size:14px;margin:18px 0 6px;font-weight:700}
.dv h3:first-child{margin-top:4px}
.dv .row{display:flex;gap:8px;flex-wrap:wrap}
.dv .chip{display:inline-block;padding:2px 8px;border-radius:999px;background:var(--dv-soft);font-size:12px}
.dv .chip.ok{background:color-mix(in srgb,var(--dv-ok) 18%,transparent);color:var(--dv-ok)}
.dv .chip.bad{background:color-mix(in srgb,var(--dv-bad) 18%,transparent);color:var(--dv-bad)}
.dv .chip.warn{background:color-mix(in srgb,var(--dv-warn) 18%,transparent);color:var(--dv-warn)}
.dv table{width:100%;border-collapse:collapse;font-size:12.5px}
.dv td,.dv th{padding:5px 4px;border-bottom:1px solid var(--dv-line);vertical-align:middle}
.dv th{color:var(--dv-mut);font-weight:500;text-align:left}
.dv td.n{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.dv .bar{position:relative;height:10px;background:var(--dv-soft);border-radius:5px;min-width:90px}
.dv .bar i{position:absolute;left:0;top:0;bottom:0;border-radius:5px;background:var(--dv-acc)}
.dv .bar b{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--dv-fg);opacity:.55}
.dv .bar b.bad{background:var(--dv-bad);opacity:.9}
.dv .bar b.ok{background:var(--dv-ok);opacity:.9}
.dv .mut{color:var(--dv-mut)}
.dv ol{margin:4px 0;padding-left:20px}
.dv .pic{position:relative;width:100%;max-width:420px;border-radius:10px;overflow:hidden;background:#000}
.dv .pic img{display:block;width:100%}
.dv .pic svg{position:absolute;inset:0;width:100%;height:100%}
.dv details{margin-top:8px}
.dv summary{cursor:pointer;color:var(--dv-acc)}
.dv pre{white-space:pre-wrap;word-break:break-all;font-size:11px;background:var(--dv-soft);padding:8px;border-radius:8px;max-height:320px;overflow:auto}
.dv .legend span{margin-right:10px;font-size:12px}
.dv .legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}
`;
const RES = { SUITABLE: ['적합', 'ok'], UNSUITABLE: ['부적합', 'bad'], REVIEW: ['추가 확인', 'warn'] };
const JNAME = { sufficient: '판단 충분', none: '기체 없음', cut: '잘림', floor: '바닥 안 보임', blur: '흔들림', light: '역광' };
const FAC_COLOR = ['#e11d48', '#7c3aed', '#0891b2', '#16a34a', '#ea580c', '#db2777', '#4f46e5', '#65a30d'];

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f3 = (x) => (x == null || Number.isNaN(+x) ? '-' : (+x).toFixed(3));
const ms = (x) => (x == null ? '-' : Math.round(x) + 'ms');

function bar(p, marks = []) {
  const w = Math.max(0, Math.min(1, +p || 0)) * 100;
  return `<div class="bar"><i style="width:${w}%"></i>${marks.map(([v, k]) => v == null ? '' : `<b class="${k || ''}" style="left:calc(${v * 100}% - 1px)" title="${k} ${v}"></b>`).join('')}</div>`;
}

function picture(rec) {
  if (!rec.thumb) return '<p class="mut">사진 없음 (가림 실패 또는 근거 손실이면 사진을 보내지 않음)</p>';
  const boxes = [];
  const kb = rec.client?.detector?.box_sent;
  if (kb) boxes.push({ x1: kb.x1, y1: kb.y1, x2: kb.x2, y2: kb.y2, c: '#facc15', t: `킥보드 ${f3(kb.score)}`, w: 3 });
  const fac = rec.server?.facilities || {};
  const names = Object.keys(fac);
  names.forEach((n, i) => (fac[n] || []).forEach(b => boxes.push({ x1: b[0], y1: b[1], x2: b[2], y2: b[3], c: FAC_COLOR[i % FAC_COLOR.length], t: `${n} ${f3(b[4])}`, w: 2 })));
  const svg = boxes.map(b => `<rect x="${b.x1 * 100}%" y="${b.y1 * 100}%" width="${(b.x2 - b.x1) * 100}%" height="${(b.y2 - b.y1) * 100}%" fill="none" stroke="${b.c}" stroke-width="${b.w}"/>`
    + `<text x="${b.x1 * 100}%" y="${b.y1 * 100}%" dy="-3" fill="${b.c}" font-size="11" font-weight="700" stroke="#000" stroke-width="2.5" paint-order="stroke">${esc(b.t)}</text>`).join('');
  const legend = `<div class="legend"><span><i style="background:#facc15"></i>킥보드(휴대폰 검출기)</span>${names.map((n, i) => `<span><i style="background:${FAC_COLOR[i % FAC_COLOR.length]}"></i>${esc(n)}</span>`).join('')}</div>`;
  return `<div class="pic"><img src="${rec.thumb}" alt="가린 사진"><svg>${svg}</svg></div>${legend}
    <p class="mut">검은 칸은 휴대폰에서 가린 사람·얼굴 영역입니다. 서버가 본 사진도 이 가린 사진입니다.</p>`;
}

function clientPart(c) {
  if (!c) return '<p class="mut">휴대폰 쪽 기록 없음</p>';
  const d = c.detector || {}, j = c.judgeability || {}, r = c.redaction || {};
  const need = j.need || {};
  const rows = Object.keys(JNAME).map(k => {
    const p = j.probs?.[k], th = k === 'sufficient' ? j.ready : need[k];
    const hit = p != null && th != null && (k === 'sufficient' ? p >= th : p > th);
    return `<tr><td>${JNAME[k]}</td><td class="n">${f3(p)}</td><td style="width:45%">${bar(p, [[th, k === 'sufficient' ? 'ok' : 'bad']])}</td>
      <td class="n mut">${th == null ? '' : (k === 'sufficient' ? '≥ ' : '> ') + th}${hit ? (k === 'sufficient' ? ' ✓' : ' ⚠') : ''}</td></tr>`;
  }).join('');
  return `
  <h3>① 킥보드 검출기 (휴대폰, ${esc(d.version || '-')})</h3>
  <div class="row">
    <span class="chip">${d.box_sent ? '검출 점수 ' + f3(d.box_sent.score) : '킥보드 못 찾음'}</span>
    <span class="chip">셔터 때 박스 ${d.box_live ? '있음' : '없음'}</span>
    <span class="chip">찍은 사진으로 다시 검출 ${d.redetected ? '함' : '안 함'}</span>
  </div>
  <h3>② 판단 가능성 분류기 (휴대폰, ${esc(j.model || '-')})</h3>
  <p class="mut">셔터 직전 프레임의 확률. 촬영 안내는 '판단 충분'이 ${j.ready ?? '-'} 이상인 프레임이 ${j.ready_frames ?? '-'}번 이어지면 '잘 찍혔어요', 아니면 최근 평균이 기준을 넘는 문제를 안내합니다.</p>
  <table><tr><th>항목</th><th class="n">확률</th><th>막대 (세로선 = 기준)</th><th class="n">기준</th></tr>${rows}</table>
  <div class="row" style="margin-top:6px"><span class="chip ${j.state === 'ready' ? 'ok' : 'warn'}">안내 상태: ${esc(j.state_name || j.state || '-')}</span>
    <span class="chip">촬영까지 ${ms(j.elapsed_ms)}</span>${j.timeout_15s ? '<span class="chip warn">15초 초과</span>' : ''}</div>
  <h3>③ 사람 가림 (휴대폰)</h3>
  <div class="row">
    <span class="chip ${r.status === 'OK' ? 'ok' : 'warn'}">${esc(r.status || '-')}</span>
    <span class="chip">가린 영역 ${r.rects ?? 0}개</span>
    <span class="chip">킥보드 박스 가림 ${Math.round((r.masked_ratio_box || 0) * 100)}% (20% 이상이면 손실)</span>
    <span class="chip">바닥 띠 가림 ${Math.round((r.masked_ratio_ground || 0) * 100)}% (50% 이상이면 손실)</span>
  </div>`;
}

function serverPart(s, rec) {
  if (!s) return `<p class="mut">서버 판정 근거 없음${rec.server_note ? ' (' + esc(rec.server_note) + ')' : ''}. 서버가 아직 이 기능 이전 버전이거나, 시험 세션이 아닌 반납입니다.</p>`;
  const T = s.thresholds || {};
  const rows = (s.items || []).map(i => {
    const st = i.state || '', cls = st.startsWith('위반') ? 'bad' : st.startsWith('깨끗') ? 'ok' : 'warn';
    return `<tr style="${i.used_in_decision ? '' : 'opacity:.6'}"><td>${esc(i.name)}<br><span class="mut">${esc(i.item)} · ${esc(i.code || '')}</span></td>
      <td class="n">${f3(i.prob)}</td><td style="width:42%">${bar(i.prob, [[T.ok, 'ok'], [T.bad, 'bad']])}</td>
      <td><span class="chip ${i.used_in_decision ? cls : ''}">${esc(st)}</span></td></tr>`;
  }).join('');
  const ev = s.evidence || {};
  const fac = s.facilities ? Object.entries(s.facilities).map(([k, v]) => `<span class="chip">${esc(k)} ${v.length}개 (최고 ${f3(Math.max(...v.map(b => b[4])))})</span>`).join('') : '<span class="mut">검출된 시설물 없음</span>';
  const cau = (s.cautions || []).length ? s.cautions.map(c => `<span class="chip warn">${esc(c.type)} · ${esc(c.source)}</span>`).join('') : '<span class="mut">없음 → 기본 기준</span>';
  const a6 = s.a6 || {};
  return `
  <h3>④ 시설물 검출 (서버, YOLOE)</h3>
  <div class="row">${fac}</div>
  <h3>⑤ 주차 판정기 확률 (서버)</h3>
  <p class="mut">기준 ${esc(s.threshold_set)} (bad ${T.bad} · ok ${T.ok} · evidence ${T.evidence}, ${esc(T.version)}). 초록 세로선 = ok, 빨강 세로선 = bad. 흐린 줄은 결합에서 뺀 항목(기록만).</p>
  <table><tr><th>항목</th><th class="n">확률</th><th>막대</th><th>상태</th></tr>${rows}
    <tr><td>판단 근거<br><span class="mut">sufficient</span></td><td class="n">${f3(ev.prob)}</td><td>${bar(ev.prob, [[ev.need_over, 'ok']])}</td>
    <td><span class="chip ${ev.ok ? 'ok' : 'warn'}">${ev.ok ? '충분' : '부족'} (&gt; ${ev.need_over})</span></td></tr></table>
  <h3>⑥ 판정 결합 순서</h3>
  <ol>${(s.steps || []).map(x => `<li>${esc(x)}</li>`).join('')}</ol>
  <div class="row"><span class="mut">주의 구역:</span> ${cau}</div>
  <div class="row" style="margin-top:4px"><span class="mut">위치 판정(A6):</span> <span class="chip">${esc(a6.status || 'NOT_EVALUATED')}${a6.distance_m != null ? ` · ${a6.facility_type} ${a6.distance_m}m` : ''}</span></div>
  ${s.relation ? `<details><summary>판정기에 들어간 공간 관계 특징 ${Object.keys(s.relation).length}개</summary><table>${Object.entries(s.relation).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${f3(v)}</td></tr>`).join('')}</table></details>` : ''}`;
}

function timing(rec) {
  const t = rec.client?.timing || {}, m = rec.server?.model_ms || rec.model_ms || {};
  const cells = [['재검출', t.redetect], ['가림 준비', t.load], ['반납 시작', t.start_return], ['가림', t.redact], ['판정 요청 왕복', t.judge],
    ['서버 전체', rec.elapsed_ms], ['└ 사진 읽기', m.decode], ['└ 시설물 검출', m.facilities], ['└ 판정기', m.judge]];
  return `<h3>⑦ 시간</h3><table>${cells.map(([k, v]) => `<tr><td>${k}</td><td class="n">${ms(v)}</td></tr>`).join('')}</table>
    <p class="mut">가림 파일 미리 받기: ${esc(rec.client?.prefetch || '-')} · 저장(서비스 워커): ${rec.client?.sw ? '켜짐' : '꺼짐'}</p>`;
}

export function renderDebug(rec, el) {
  if (!document.getElementById('dv-css')) { const s = document.createElement('style'); s.id = 'dv-css'; s.textContent = CSS; document.head.appendChild(s); }
  const [rn, rc] = RES[rec.result] || [rec.result || '-', ''];
  el.classList.add('dv');
  el.innerHTML = `
  <div class="row" style="align-items:center"><span class="chip ${rc}" style="font-size:14px;font-weight:700">${rn}</span>
    <span class="chip">접수 ${esc(rec.receipt || '-')}</span><span class="chip">${esc(rec.session || '-')}</span>
    <span class="chip">${esc(new Date(rec.at).toLocaleString('ko-KR'))}</span></div>
  ${rec.review_reason ? `<p class="mut">추가 확인 사유: ${esc(rec.review_reason)}${rec.review_message ? ' · ' + esc(rec.review_message) : ''}</p>` : ''}
  ${rec.reason ? `<p>부적합 사유: <b>${esc(rec.reason.code)}</b> ${esc(rec.reason.title || '')}</p>` : ''}
  <p class="mut">판정기 ${esc(rec.versions?.judge_model || '-')} · 기준표 ${esc(rec.versions?.criteria || '-')} · 기준값 ${esc(rec.versions?.thresholds || '-')}</p>
  ${picture(rec)}
  ${clientPart(rec.client)}
  ${serverPart(rec.server, rec)}
  ${timing(rec)}
  <details><summary>원본 기록(JSON)</summary><pre>${esc(JSON.stringify({ ...rec, thumb: rec.thumb ? '(사진 생략)' : null }, null, 2))}</pre></details>`;
}

// 이 기기의 시험 기록 (localStorage). 서버 로그(judge_debug.jsonl)가 원본이고 이건 화면용 사본
const KEY = 'vparc.testlog';
export function loadLog() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } }
export function saveRecord(rec) {
  let list = loadLog().filter(r => r.id !== rec.id);
  list.unshift(rec);
  for (let n = 30; n >= 1; n = Math.floor(n / 2)) {         // 저장 공간이 모자라면 오래된 것부터 줄임
    try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, n))); return true; } catch {}
  }
  return false;
}
export function clearLog() { try { localStorage.removeItem(KEY); } catch {} }
