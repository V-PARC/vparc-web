// V-PARC 서비스 워커: 버전이 주소에 박힌 외부 파일(MediaPipe·ONNX Runtime wasm, 사람 가림 모델)을
// 휴대폰에 한 번만 받아 두고 다음부터는 저장본을 쓴다 (캐시 우선).
// 아이폰 사파리는 HTTP 캐시를 자주 비우고, Google 모델 저장소는 캐시 유효 시간이 1시간이라 매번 다시 받던 문제 (11/20).
// 우리 사이트 파일(html·js·models/*.onnx)은 건드리지 않는다. onnx는 judge.js가 따로 저장한다.
const CACHE = 'vparc-ext-v1';
const PINNED = [
  /^https:\/\/cdn\.jsdelivr\.net\/npm\/@mediapipe\/tasks-vision@[\d.]+\//,
  /^https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@[\d.]+\//,
  /^https:\/\/storage\.googleapis\.com\/mediapipe-models\/.+\/\d+\/[^/]+$/,   // .../float32/1/deeplab_v3.tflite
];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('vparc-ext-') && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || !PINNED.some(r => r.test(req.url))) return;
  e.respondWith(cacheFirst(req));
});

async function cacheFirst(req) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req.url);
  if (hit) return hit;
  // <script> 태그 요청(no-cors)도 CORS로 받아 저장한다. 불투명 응답은 저장하지 않음 (나중에 cors 요청에 못 씀)
  let res;
  try { res = await fetch(req.url, { mode: 'cors', credentials: 'omit' }); }
  catch (err) { return fetch(req); }
  if (res.ok) { try { await c.put(req.url, res.clone()); } catch (err) { /* 저장 공간 부족 등: 저장 없이 그대로 씀 */ } }
  return res;
}
