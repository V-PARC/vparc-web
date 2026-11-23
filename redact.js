// V-PARC 사람 가림(A3) — 휴대폰 안에서만 실행. 원본 픽셀·EXIF는 밖으로 나가지 않는다.
// 사용: const r = await redact(canvas, scooterBox, { segmenter, faceDetector });
//       r.blob(흐림 처리된 JPEG, EXIF 없음)을 전송. r.lost(근거 손실)여도 흐린 사진은 보낸다:
//       API는 가림 실패(FAILED)만 사진 없이 받고, 근거 손실은 사진이 있어야 추가 확인으로 접수한다(없으면 400)
export const MARGIN = 0.08;      // 사람 영역 상하좌우 여유 8%
export const BOX_LOSS = 0.20;    // 가린 영역이 킥보드 박스의 20% 이상이면 근거 손실
export const FLOOR_LOSS = 0.50;  // 바닥(박스 아래쪽 띠)의 절반 이상을 가리면 근거 손실

// 사람 마스크(Uint8 0/1, W×H)에서 덩어리별 사각형을 찾는다 (4-이웃, 작은 잡음은 버림)
export function maskRects(mask, W, H, minArea = 0.002) {
  const seen = new Uint8Array(W * H), rects = [], q = new Int32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || seen[i]) continue;
    let h = 0, t = 0, x0 = W, y0 = H, x1 = 0, y1 = 0, n = 0;
    q[t++] = i; seen[i] = 1;
    while (h < t) {
      const k = q[h++], x = k % W, y = (k / W) | 0; n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const j of [k - 1, k + 1, k - W, k + W]) {
        if (j < 0 || j >= W * H || seen[j] || !mask[j]) continue;
        if ((j === k - 1 && x === 0) || (j === k + 1 && x === W - 1)) continue;
        seen[j] = 1; q[t++] = j;
      }
    }
    if (n >= minArea * W * H) rects.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  return rects;
}
// 사각형을 8%씩 넓힌다 (이미지 밖은 잘라 냄)
export function expand(r, W, H, m = MARGIN) {
  const dx = r.w * m, dy = r.h * m;
  const x = Math.max(0, r.x - dx), y = Math.max(0, r.y - dy);
  return { x, y, w: Math.min(W, r.x + r.w + dx) - x, h: Math.min(H, r.y + r.h + dy) - y };
}
// 가린 사각형들이 킥보드 박스·바닥 띠를 얼마나 덮는지 (격자로 근사)
export function coverLoss(rects, box, W, H) {
  if (!box) return { box: 0, floor: 0, lost: rects.length > 0 };
  const floorBand = { x: box.x, y: box.y + box.h * 0.75, w: box.w, h: Math.min(H - (box.y + box.h * 0.75), box.h * 0.35) };
  const frac = (a) => { let c = 0, n = 0; const sx = a.w / 40, sy = a.h / 40;
    for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) { const px = a.x + (i + .5) * sx, py = a.y + (j + .5) * sy; n++;
      if (rects.some(r => px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h)) c++; }
    return n ? c / n : 0; };
  const b = frac(box), f = frac(floorBand);
  return { box: b, floor: f, lost: b >= BOX_LOSS || f >= FLOOR_LOSS };
}

// 강한 흐림: 영역을 짧은 변 BLUR_CELLS칸으로 줄였다가 부드럽게 다시 키운다(두 번).
// 얼굴 하나가 몇 칸 안에 뭉개져 알아볼 수 없고, ctx.filter(blur)를 못 쓰는 iOS 17 사파리에서도 똑같이 동작한다.
export const BLUR_CELLS = 8;
export function blurRect(g, r, cells = BLUR_CELLS) {
  const x = Math.floor(r.x), y = Math.floor(r.y), w = Math.ceil(r.w), h = Math.ceil(r.h);
  if (w < 2 || h < 2) return;
  const k = cells / Math.min(w, h), sw = Math.max(2, Math.round(w * k)), sh = Math.max(2, Math.round(h * k));
  const t = document.createElement('canvas'); t.width = sw; t.height = sh;
  const tg = t.getContext('2d'); tg.imageSmoothingEnabled = true; tg.imageSmoothingQuality = 'high';
  tg.drawImage(g.canvas, x, y, w, h, 0, 0, sw, sh);
  // 한 번 더 줄였다 키워 칸 경계(모자이크 느낌)를 없앰
  const t2 = document.createElement('canvas'); t2.width = Math.max(2, sw >> 1); t2.height = Math.max(2, sh >> 1);
  const t2g = t2.getContext('2d'); t2g.imageSmoothingEnabled = true; t2g.imageSmoothingQuality = 'high';
  t2g.drawImage(t, 0, 0, t2.width, t2.height);
  tg.clearRect(0, 0, sw, sh); tg.drawImage(t2, 0, 0, sw, sh);
  g.save(); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(t, 0, 0, sw, sh, x, y, w, h); g.restore();
}

// 실제 가림: MediaPipe ImageSegmenter(사람)와 FaceDetector 결과를 받아 강하게 흐리게 한다
// personIndex: 분할 모델에서 사람 클래스 번호 (DeepLab v3 = 15). 없으면 0보다 큰 값을 모두 사람으로 봄
export async function redact(src, box, { segmenter, faceDetector, personIndex } = {}) {
  const W = src.width, H = src.height;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'); g.drawImage(src, 0, 0);                 // 픽셀만 다시 그림 → EXIF 없음
  let rects = [];
  try {
    if (segmenter) {
      const seg = segmenter.segment(c);
      const m = seg.categoryMask, mw = m.width, mh = m.height, raw = m.getAsUint8Array();
      const bin = new Uint8Array(mw * mh); for (let i = 0; i < raw.length; i++) bin[i] = (personIndex == null ? raw[i] > 0 : raw[i] === personIndex) ? 1 : 0;
      rects = maskRects(bin, mw, mh).map(r => ({ x: r.x * W / mw, y: r.y * H / mh, w: r.w * W / mw, h: r.h * H / mh }));
      m.close?.();
    }
    if (faceDetector) for (const d of faceDetector.detect(c).detections) {
      const b = d.boundingBox; rects.push({ x: b.originX, y: b.originY, w: b.width, h: b.height });
    }
  } catch (e) {
    return { lost: true, failed: true, reason: '가림 실패', blob: null };        // S6: 사진 없이 접수
  }
  rects = rects.map(r => expand(r, W, H));
  for (const r of rects) blurRect(g, r);
  const loss = coverLoss(rects, box, W, H);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  return { ...loss, rects, canvas: c, blob };
}
