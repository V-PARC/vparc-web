// V-PARC 판정 API 호출 (정태원 API 구조 초안 5.2~5.4 기준)
// 주소: 페이지 주소 뒤 ?api=https://…/v1 로 한 번 넣으면 이 폰에 기억. 주소가 없으면 모의 판정으로 흐름만 시험.
const KEY = 'vparc.api';
export function apiBase() {
  const q = new URLSearchParams(location.search).get('api');
  try {
    if (q === 'off') localStorage.removeItem(KEY);
    else if (q) localStorage.setItem(KEY, q.replace(/\/$/, ''));
    return localStorage.getItem(KEY) || '';
  } catch { return q && q !== 'off' ? q.replace(/\/$/, '') : ''; }
}
export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'r' + Date.now() + Math.random().toString(16).slice(2));

// 통신이 끊기면 같은 request_id로 다시 보냄 (S6, T12). 최대 3번, 1초·2초 쉬고
async function send(url, init, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status >= 500) throw new Error('server ' + res.status);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { const e = new Error(body.detail || ('HTTP ' + res.status)); e.status = res.status; e.body = body; throw e; }
      return body;
    } catch (e) {
      last = e;
      if (e.status && e.status < 500) throw e;            // 4xx는 다시 보내도 같음
      if (i < tries - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw last;
}

// ---- 모의 판정: API 주소가 없을 때. 판단 가능성 모델 상태와 ?mock=ok|bad|review 로 결과를 정함 ----
function mockJudge(meta) {
  const force = new URLSearchParams(location.search).get('mock');
  const now = new Date(), receipt = `V-${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const base = { judgment_id: 'j_mock_' + Date.now(), receipt_no: receipt, reason: null, violations: [], guide: null, caution_note: null, review_reason: null, versions: { judge_model: 'mock' }, elapsed_ms: 0, mock: true };
  if (meta.redaction.status !== 'OK') return { ...base, result: 'REVIEW', review_reason: meta.redaction.status === 'FAILED' ? 'REDACTION_FAILED' : 'EVIDENCE_LOSS', next_actions: ['FINISH'] };
  const kind = force || (meta.capture_guide.ready ? 'ok' : 'review');
  if (kind === 'bad') {
    const b = meta.box || { x1: 0.3, y1: 0.4, x2: 0.6, y2: 0.8 };
    const w = b.x2 - b.x1, h = b.y2 - b.y1, py1 = b.y1 + h * 0.55;
    const tx = b.x2 + 0.05 < 0.7 ? b.x2 + 0.05 : Math.max(0.03, b.x1 - 0.3);
    return { ...base, result: 'UNSUITABLE', reason: { code: 'B1', title: '점자블록 위에 주차했어요', message: '점자블록 위에 있어요. 옆으로 옮겨 주세요' },
      violations: [{ code: 'B1', item: 'tactile', prob: 0.9 }],
      guide: { problem_box: { x1: b.x1, y1: py1, x2: b.x2, y2: b.y2 }, target_line: [[tx, Math.min(0.85, py1)], [Math.min(0.97, tx + Math.max(0.22, w * 0.8)), Math.min(0.97, py1 + Math.max(0.1, h * 0.35))]] },
      next_actions: ['RETAKE', 'FINISH_AS_IS'] };
  }
  if (kind === 'review') return { ...base, result: 'REVIEW', review_reason: 'NOT_JUDGABLE', next_actions: ['FINISH'] };
  return { ...base, result: 'SUITABLE', next_actions: ['FINISH'] };
}

export function makeApi() {
  const base = apiBase();
  if (!base) {
    return {
      mock: true, base: '',
      async startReturn(body) { return { return_id: 'r_mock_' + Date.now(), started_at: new Date().toISOString(), mock: true }; },
      async judge(returnId, meta, photo) { await new Promise(r => setTimeout(r, 600)); return mockJudge(meta); },
      async finish(returnId, body) { return { return_id: returnId, final_result: body.outcome, mock: true }; },
    };
  }
  return {
    mock: false, base,
    startReturn: (body) => send(base + '/returns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    judge(returnId, meta, photo) {
      // FormData는 보낼 때마다 새로 만듦 (재전송에도 같은 request_id)
      const make = () => { const fd = new FormData(); if (photo) fd.append('photo', photo, 'photo.jpg'); fd.append('meta', JSON.stringify(meta)); return fd; };   // meta는 파일이 아니라 문자열로 (vparc-api returns.py: meta: str = Form(...))
      let lastErr;
      return (async () => {
        for (let i = 0; i < 3; i++) {
          try { return await send(`${base}/returns/${encodeURIComponent(returnId)}/judgments`, { method: 'POST', body: make() }, 1); }
          catch (e) { lastErr = e; if (e.status && e.status < 500) throw e; await new Promise(r => setTimeout(r, 1000 * (i + 1))); }
        }
        throw lastErr;
      })();
    },
    finish: (returnId, body) => send(`${base}/returns/${encodeURIComponent(returnId)}/finish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  };
}

// API 응답 → 결과 화면(result.html) 입력
const NOT_JUDGABLE_WHY = { none: 'none', cut: 'cut', floor: 'floor', blur: 'blur', light: 'light' };
export function toScreen(res, ctx) {
  const d = { receipt: res.receipt_no, judgmentId: res.judgment_id, returnId: ctx.returnId, attempt: ctx.attempt,
    time: ctx.time, place: ctx.place, photo: ctx.photoUrl || null, usage: ctx.usage, mock: !!res.mock, caution: res.caution_note || null };
  if (res.result === 'SUITABLE') return { ...d, result: 'ok' };
  if (res.result === 'UNSUITABLE') {
    const g = res.guide, out = { ...d, result: 'bad', code: res.reason?.code || 'C1', title: res.reason?.title, message: res.reason?.message };
    if (g?.problem_box) { const p = g.problem_box; out.box = [p.x1, p.y1, p.x2 - p.x1, p.y2 - p.y1]; }
    // 옮길 자리: 서버 guide.arrow.to(눈금선 위치)를 가운데로, 문제 칸과 같은 크기의 점선 칸 (vparc-api guide.py)
    const pb = g?.problem_box, to = g?.arrow?.to || (g?.target_line ? g.target_line[0] : null);
    if (pb && to) {
      const w = Math.min(0.3, Math.max(0.12, pb.x2 - pb.x1)), h = Math.max(0.08, pb.y2 - pb.y1);
      const right = to[0] >= (pb.x1 + pb.x2) / 2;   // 옮길 방향. 문제 칸과 겹치지 않게 그쪽 바깥에 붙임
      let x = right ? Math.max(to[0] - w / 2, pb.x2 + 0.02) : Math.min(to[0] - w / 2, pb.x1 - 0.02 - w);
      x = Math.min(1 - w, Math.max(0, x));
      out.target = [x, Math.min(1 - h, Math.max(0, pb.y1)), w, h];
    }
    return out;
  }
  const rr = res.review_reason;
  let why = 'unsure';
  if (rr === 'REDACTION_FAILED' || rr === 'EVIDENCE_LOSS' || !ctx.photoUrl) why = 'nophoto';
  else if (rr === 'NOT_JUDGABLE') why = NOT_JUDGABLE_WHY[ctx.lastReason] || 'unsure';
  return { ...d, result: 'review', why, photo: why === 'nophoto' ? null : d.photo };
}
