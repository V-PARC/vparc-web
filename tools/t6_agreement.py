"""T6 가림 누락 집계: 두 판독자의 CSV(test/redact.html에서 내보낸 것)를 합쳐 누락률·95% 신뢰구간·일치도를 낸다.

  python3 tools/t6_agreement.py 판독자1.csv 판독자2.csv

- 두 사람 모두 판독한 사진만 쓴다. 둘 다 '사람 없음'이면 누락률 계산에서 뺀다.
- 누락 = '몸 일부 누락' 또는 '얼굴 누락'. 두 사람 중 한 명이라도 누락으로 보면 누락으로 센다(보수적).
- 얼굴 누락은 둘 중 한 명이라도 표시하면 1건 (목표 0건).
- 일치도: 누락 여부(이진)와 4범주 판정 각각 Cohen's kappa.
"""
import csv
import math
import sys
from collections import Counter

CATS = ["none", "body", "face", "noperson"]


def read(path):
    with open(path, encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    return rows[0]["reviewer"] if rows else path, {r["file"]: r for r in rows}


def wilson(k, n, z=1.96):
    if n == 0:
        return (float("nan"),) * 2
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, c - h), min(1.0, c + h)


def kappa(a, b, cats):
    n = len(a)
    if n == 0:
        return float("nan")
    po = sum(x == y for x, y in zip(a, b)) / n
    ca, cb = Counter(a), Counter(b)
    pe = sum(ca[c] * cb[c] for c in cats) / (n * n)
    return 1.0 if pe == 1 else (po - pe) / (1 - pe)


def main(p1, p2):
    w1, r1 = read(p1)
    w2, r2 = read(p2)
    both = sorted(set(r1) & set(r2))
    only = sorted(set(r1) ^ set(r2))
    v1 = [r1[f]["verdict"] for f in both]
    v2 = [r2[f]["verdict"] for f in both]
    person = [i for i, f in enumerate(both) if not (v1[i] == "noperson" and v2[i] == "noperson")]
    miss = [i for i in person if v1[i] in ("body", "face") or v2[i] in ("body", "face")]
    face = [i for i in person if v1[i] == "face" or v2[i] == "face"]
    lo, hi = wilson(len(miss), len(person))
    flo, fhi = wilson(len(face), len(person))
    bin1 = ["miss" if v in ("body", "face") else "ok" for v in v1]
    bin2 = ["miss" if v in ("body", "face") else "ok" for v in v2]
    fp = sum(1 for f in both if r1[f]["false_positive"] == "1" or r2[f]["false_positive"] == "1")

    print(f"판독자: {w1}, {w2}  |  둘 다 판독한 사진 {len(both)}장 (한 명만 판독 {len(only)}장은 제외)")
    print(f"사람이 있는 사진: {len(person)}장")
    print(f"누락(몸 일부 또는 얼굴): {len(miss)}건, 누락률 {len(miss) / max(1, len(person)):.1%} (95% CI {lo:.1%}–{hi:.1%})")
    print(f"얼굴 식별 가능 누락: {len(face)}건 (목표 0건) {'통과' if not face else '불합격'}, 95% CI {flo:.1%}–{fhi:.1%}")
    print(f"오탐(사람 아닌 것을 가림) 표시: {fp}장")
    print(f"일치도 kappa: 누락 여부 {kappa(bin1, bin2, ['miss', 'ok']):.3f}, 4범주 {kappa(v1, v2, CATS):.3f}")
    dis = [f for i, f in enumerate(both) if v1[i] != v2[i]]
    if dis:
        print(f"\n두 사람 판정이 다른 사진 {len(dis)}장:")
        for f in dis:
            print(f"  {f}: {w1}={r1[f]['verdict']}, {w2}={r2[f]['verdict']}")
    if face:
        print("\n얼굴 누락 사진:")
        for i in face:
            print(f"  {both[i]}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
