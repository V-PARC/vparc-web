// 킥보드 검출기: 이정수 YOLO26n 미세조정 (vparc-ml work/onnx/detector.onnx, 640 입력)
// 전처리·후처리는 vparc/onnx_tools.py(letterbox, decode)와 geometry.py(select_target)를 그대로 옮김
import { ORT_VER, loadOrt, fetchCached, fetchFresh, dropCached } from './judge.js';

export const DET_URL = new URL('./models/detector.onnx', import.meta.url).href;
export const DET_VERSION = 'yolo26n-det_r1';
const SIZE = 640, CONF = 0.25, BAND = [0.2, 0.8], IOU = 0.7;

const cv = document.createElement('canvas'); cv.width = cv.height = SIZE;
const cx = cv.getContext('2d', { willReadFrequently: true });

// ultralytics letterbox: 비율 유지, 가운데 정렬, 회색(114) 여백, RGB 0~1, NCHW
function letterbox(src, w, h) {
  const r = Math.min(SIZE / w, SIZE / h), nw = Math.round(w * r), nh = Math.round(h * r);
  const left = Math.round((SIZE - nw) / 2 - 0.1), top = Math.round((SIZE - nh) / 2 - 0.1);
  cx.fillStyle = 'rgb(114,114,114)'; cx.fillRect(0, 0, SIZE, SIZE);
  cx.drawImage(src, left, top, nw, nh);
  const d = cx.getImageData(0, 0, SIZE, SIZE).data, n = SIZE * SIZE, t = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { t[i] = d[i * 4] / 255; t[n + i] = d[i * 4 + 1] / 255; t[2 * n + i] = d[i * 4 + 2] / 255; }
  return { t, r, left, top };
}
const iou = (a, b) => {
  const iw = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), ih = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const i = iw * ih; return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i + 1e-9);
};
// 출력 두 형식 모두 받음: end2end (1,300,6) [x1,y1,x2,y2,score,cls] / 예전 형식 (1,4+nc,N) [cx,cy,w,h,점수...] + NMS
function decode(out) {
  const { data, dims } = out; let boxes = [];
  if (dims.length === 3 && dims[2] === 6) {
    for (let i = 0; i < dims[1]; i++) { const o = i * 6; if (data[o + 4] >= CONF) boxes.push([data[o], data[o + 1], data[o + 2], data[o + 3], data[o + 4]]); }
  } else {
    const C = dims[1], N = dims[2];
    for (let j = 0; j < N; j++) {
      let s = 0; for (let c = 4; c < C; c++) s = Math.max(s, data[c * N + j]);
      if (s < CONF) continue;
      const x = data[j], y = data[N + j], w = data[2 * N + j], h = data[3 * N + j];
      boxes.push([x - w / 2, y - h / 2, x + w / 2, y + h / 2, s]);
    }
    boxes.sort((a, b) => b[4] - a[4]); const keep = [];
    for (const b of boxes) if (keep.every(k => iou(k, b) <= IOU)) keep.push(b);
    boxes = keep;
  }
  return boxes;
}
// select_target: 가로 중심이 0.2~0.8 안에 있는 것 중 가장 큰 박스, 없으면 전체에서 가장 큰 박스
function selectTarget(bs) {
  if (!bs.length) return null;
  const area = b => b.w * b.h, mid = bs.filter(b => b.x + b.w / 2 >= BAND[0] && b.x + b.w / 2 <= BAND[1]);
  return (mid.length ? mid : bs).sort((a, b) => area(b) - area(a))[0];
}

export async function loadDetector() {
  const t0 = performance.now();
  const ort = await loadOrt();
  ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/`;
  const create = (b) => ort.InferenceSession.create(b, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  let { buf, cached } = await fetchCached(DET_URL), sess;
  try { sess = await create(buf); }
  catch (e1) { buf = null; await dropCached(DET_URL); buf = await fetchFresh(DET_URL); cached = false; sess = await create(buf); }
  buf = null;
  const inName = sess.inputNames[0], outName = sess.outputNames[0];
  // src: video/img/canvas, w·h: 원본 크기. 결과는 0~1 정규화 {x,y,w,h,score} 또는 null
  const detect = async (src, w, h) => {
    const { t, r, left, top } = letterbox(src, w, h);
    const out = (await sess.run({ [inName]: new ort.Tensor('float32', t, [1, 3, SIZE, SIZE]) }))[outName];
    const cl = (v) => Math.min(1, Math.max(0, v));
    const bs = decode(out).map(([x1, y1, x2, y2, s]) => {
      const a = cl((x1 - left) / (w * r)), b = cl((y1 - top) / (h * r)), c = cl((x2 - left) / (w * r)), d = cl((y2 - top) / (h * r));
      return { x: a, y: b, w: c - a, h: d - b, score: s };
    }).filter(b => b.w > 0 && b.h > 0);
    return selectTarget(bs);
  };
  const close = () => { try { sess.release && sess.release(); } catch (e) {} };
  return { detect, close, ms: performance.now() - t0, cached };
}
