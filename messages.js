// V-PARC 안내 문구 규칙 (A2 촬영 안내 + UI-07 부적합 사유 + UI-08 추가 확인)
// 원칙: 한 줄, 해요체, 위반 코드는 화면에 보이지 않음. 무엇을 하면 되는지(행동)로 끝맺음.

// 1) 촬영 안내 (A2) — 판단 가능성 모델 사유 → 미리보기 아래 한 줄. 우선순위는 배열 순서.
export const SHOOT_PRIORITY = ['none', 'cut', 'floor', 'blur', 'light'];
export const SHOOT_TEXT = {
  loading: '준비 중이에요',
  none:  '킥보드가 화면 안에 들어오게 비춰 주세요',
  cut:   '킥보드가 잘렸어요. 한 걸음 뒤로 가 주세요',
  floor: '바퀴 아래 바닥까지 보이게 찍어 주세요',
  blur:  '흔들렸어요. 잠깐 멈춰 주세요',
  light: '너무 어둡거나 눈부셔요. 빛을 등지고 찍어 주세요',
  ready: '좋아요. 이대로 찍어 주세요',
  wait:  '지금 찍어도 돼요. 애매하면 확인 후 알려 드려요',   // 15초 미달(S2)
};

// 사유별 기준값: 판단 가능성 모델 meta.json의 a2.reason_need를 쓰고, 없으면 0.6 (1차와 같음)
export function reasonThresholds(meta) {
  const t = meta?.a2?.reason_need;
  return Object.fromEntries(SHOOT_PRIORITY.map(r => [r, typeof t === 'object' ? (t[r] ?? 0.6) : (t ?? 0.6)]));
}
// 최근 프레임 확률 평균이 기준값을 넘는 첫 사유 (우선순위 순). 없으면 null
export function pickReason(recent, th) {
  if (!recent.length) return null;
  for (const r of SHOOT_PRIORITY) {
    const avg = recent.reduce((s, p) => s + (p[r] ?? 0), 0) / recent.length;
    if (avg > th[r]) return r;
  }
  return null;
}

// 2) 부적합 결과 (UI-07, 10/13 와이어프레임 형식)
//    tag: 사진 위 빨간 태그 · title: 결과 제목 · detail: 사유 카드 둘째 줄
//    여러 코드가 걸리면 판정 결합(A4)이 고른 코드 하나만 보여 준다
export const RESULT_TEXT = {
  A1: { tag: '차도·갓길', title: '차도 쪽에 주차했어요', detail: '바퀴가 차도나 갓길에 있어요' },
  A2: { tag: '자전거도로', title: '자전거도로에 주차했어요', detail: '킥보드가 자전거도로 위에 있어요' },
  A3: { tag: '횡단보도 3m', title: '횡단보도 가까이 주차했어요', detail: '횡단보도에서 3m 안에 있어요' },
  A4: { tag: '소화전 5m', title: '소화전 가까이 주차했어요', detail: '소화전에서 5m 안에 있어요' },
  A5: { tag: '교통섬', title: '교통섬에 주차했어요', detail: '차도 가운데 교통섬 위에 있어요' },
  A6: { tag: '정류장·역 출구', title: '정류장 가까이 주차했어요', detail: '정류장·역 출구에서 5m 안에 있어요' },
  A7: { tag: '출입구 앞', title: '출입구 앞에 주차했어요', detail: '출입구·계단에서 1m 안에 있어요' },
  A8: { tag: '주차 금지', title: '주차 금지 구역이에요', detail: '주차 금지 표시가 있는 곳이에요' },
  B1: { tag: '점자블록 위', title: '점자블록 위에 주차했어요', detail: '바퀴가 점자블록에 올라가 있어요' },
  B2: { tag: '점자블록 근처', title: '점자블록에 너무 붙었어요', detail: '점자블록에서 한 칸(30cm) 안에 있어요' },
  C1: { tag: '가장자리 아님', title: '보도 가운데 쪽에 주차했어요', detail: '바퀴가 가장자리에서 50cm 넘게 떨어져 있어요' },
  C2: { tag: '통행 폭 부족', title: '지나갈 길이 좁아졌어요', detail: '남은 보도 폭이 1.5m보다 좁아요' },
  C4: { tag: '좁은 보도', title: '좁은 길에 주차했어요', detail: '보도가 좁아 지나가기 어려워요' },
  D1: { tag: '넘어짐', title: '킥보드가 넘어져 있어요', detail: '세운 뒤 받침대를 내려 주세요' },
};

// 3) 추가 확인 (UI-08) — 왜 애매했는지에 따라 사진 위 알림·설명·다음 팁
export const REVIEW_TEXT = {
  blur:  { pill: '흔들림이 감지됐어요', sub: '사진이 흔들려 나중에 다시 확인할게요.', tip: '멈춘 뒤 찍어 주세요' },
  cut:   { pill: '킥보드가 잘렸어요', sub: '킥보드가 다 나오지 않아 나중에 다시 확인할게요.', tip: '한 걸음 뒤에서 찍어 주세요' },
  floor: { pill: '바닥이 안 보여요', sub: '바퀴 아래가 안 보여 나중에 다시 확인할게요.', tip: '바닥까지 보이게 찍어 주세요' },
  light: { pill: '너무 어두워요', sub: '사진이 어두워 나중에 다시 확인할게요.', tip: '빛을 등지고 찍어 주세요' },
  none:  { pill: '킥보드를 못 찾았어요', sub: '킥보드가 안 보여 나중에 다시 확인할게요.', tip: '킥보드 전체가 나오게 찍어 주세요' },
  unsure:{ pill: '판정이 애매해요', sub: '주차 위치가 애매해 나중에 다시 확인할게요.', tip: '가장자리에 붙여 세워 주세요' },
  nophoto:{ pill: '', sub: '사람을 가리지 못해 사진 없이 접수했어요.', tip: '사람이 없을 때 찍어 주세요' },
};

// 4) 결과 화면 공통 문구 (UI-06~08)
export const SCREEN_TEXT = {
  ok:     { label: '적합', title: '주차 확인 완료', chip: '실증용', sub: '통행에 방해되지 않는 위치예요.', left: '다시 찍기', main: '완료' },
  bad:    { label: '부적합', sub: '표시한 자리로 옮긴 뒤 다시 찍어 주세요.', bubble: '이쪽으로 옮겨 주세요',
            note: '그대로 끝내면 부적합으로 기록돼요.', left: '이대로 끝내기', main: '다시 세우고 찍기' },
  review: { label: '추가 확인 필요', title: '반납은 끝났어요', main: '확인' },
};
