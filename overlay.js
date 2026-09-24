/* Nib — NovelAI 위에 띄우는 사용량 창
 *
 * 사이드 패널은 좁아서 그래프와 기록표를 같이 놓기 어렵다. 이 창은 NovelAI 화면 위에 뜬다.
 * NovelAI의 CSS가 새어 들어오지 않도록 shadow DOM 안에 만든다.
 *
 * 정확도에 대해:
 *   잔량은 정수 퍼센트로만 관측된다(page.js 주석 참고). 그래서 "이번 생성이 얼마 썼는지"는
 *   원리적으로 알 수 없다. 대신 구간의 하락을 그 사이 생성의 "기준 장" 합으로 나눠 평균을 낸다.
 *
 *   구간의 양 끝을 **생성 직후 퍼센트가 한 칸 떨어진 순간**(아래 dropAnchors)으로 잡으면
 *   그 순간의 실제 잔량은 경계 바로 아래라, 끝점 오차가 ±1%p가 아니라 **생성 한 장 분량**이다.
 *   그런 순간이 둘 없을 때만 예전 방식(구간 첫 생성 시점의 퍼센트 ~ 지금 퍼센트, ±1%p)으로 떨어진다.
 */

(() => {
  const HOST_ID = 'nib-usage-overlay';
  const POS_KEY = 'nib.overlayPos';
  const LEDGER_KEY = 'nib.ledger';
  /* 회복 주기(초/1%). 원장에 값이 없을 때만 쓴다. 2026-09-23 실측 6048 = 100%까지 정확히 7일
   * (공지의 "A full recharge from completely empty takes about a week"). 예전 값은 7888이었다. */
  const DEFAULT_SPP = 6048;

  /* 오차 ±10%가 실용 하한이다. 예약 창(queue.js)도 같은 문장을 쓰므로 값도 계산도 여기 한 벌만 둔다. */
  const TARGET_RELATIVE = 0.1;
  /* 예전 방식(끝점 ±1%p)에서 누적 하락이 이만큼도 안 되면 오차가 100%를 넘는다. */
  const MIN_CONSUMED = 1;
  /* 퍼센트 하락 마크가 "생성 직후"라고 볼 수 있는 최대 지연. 생성 ~5s + 잔량 갱신 + 5초 폴링,
   * 탭이 뒤에 있으면 타이머가 1분 단위로 늦춰진다. */
  const ANCHOR_LAG_MS = 120000;
  /* 기준 장 하나가 **적어도** 쓰는 양(%p). 오염 판정에서 생성이 깎은 몫을 빼는 데만 쓴다.
   * 실측 0.065~0.069의 약 2/3로 낮춰 잡았다 — 크게 잡으면 진짜 오염을 놓친다. */
  const MIN_UNIT_COST = 0.045;

  /* ── 할당량 소모 모델 ─────────────────────────────────────────────────
   *
   * 공지(journal.novelai.net, "Subscription Updates: Usage Limits", 2025):
   *   "Both resolution and step count affect how much of your usage limit a generation consumes."
   *   "cost scales with the pixel count of your chosen resolution"
   * **식은 공개돼 있지 않다.** 아래는 원장 실측으로 맞춘 모델이고, 틀렸다면 이 상수만 고치면 된다.
   *
   *     한 장 소모 ∝ (픽셀 수) × (STEP_FIXED + (1 − STEP_FIXED) × 스텝/28)
   *
   *   [A1 · 실측] Anlas가 나가는 V5 생성(1MP 초과 · 28스텝 초과)은 할당량을 안 쓴다.
   *             근거 — 2026-09-22 원장: 1920×1088 과금 32장이 섞인 구간과 거의 없는 구간에서
   *             "과금은 0"으로 보면 무료 한 장당 0.0506 / 0.0510으로 일치, "과금도 픽셀만큼"으로 보면
   *             0.016 / 0.049로 3배 어긋났다.
   *             캐릭터 레퍼런스는 **V5에 아직 없다**(2026-09, V4.5 전용). 생기면 같은 규칙으로 두지만 실측은 없다.
   *   [A2 · 가정] 한 요청에 여러 장이면 무료인 첫 장만 할당량을 쓴다(나머지는 Anlas). 실측 없음.
   *   [A3 · 실측] 픽셀 수에 **정비례**(PIXEL_EXP = 1). 2026-09-23 1024×768·25스텝 19장이
   *             한 장 0.046~0.049 — 비례 예측 0.048, "픽셀 무관" 예측 0.059.
   *   [A4 · 실측] 스텝에는 **정비례가 아니다.** 28스텝 기준 약 19%가 스텝과 무관한 고정분
   *             (STEP_FIXED). 2026-09-23 1216×832·25스텝 17장이 한 장 0.0594 — 정비례 예측 0.066,
   *             "스텝 무관" 예측 0.051 둘 다 오차 밖. 하락 구간 6개를 함께 맞추면 한 장 ≈
   *             (픽셀/832×1216) × (0.0125 + 0.00196×스텝)%p, 잔차는 모두 ±0.04 안(측정 오차 ±0.06).
   *             고정분도 픽셀에 비례한다 — 픽셀 무관으로 두면 1024×768 예측이 0.050으로 벗어난다.
   *             재검증(구간 21개, 무료 458장): 고정분 최적 0.22~0.25(±0.05)지만 0.19/0.22/0.25의 맞춤 품질이
   *             같아(RMS 0.0416/0.0413/0.0415) 바꾸지 않았다. 스텝별 예측은 실측과 ±3% 안.
   *
   * "기준 장" = 832×1216 · 28스텝 한 장(≈ 0.067%p). 공지의 "normal resolutions and up to 28 steps" 상한이다. */
  const UNIT = { w: 832, h: 1216, steps: 28 };
  const PIXEL_EXP = 1;
  const STEP_FIXED = 0.19;
  /* page.js 에 같은 값이 있다(무료 판정 — MAIN world라 못 빌려 쓴다). queue.js 는 NibUsage.paidSize 로 빌려 쓴다.
   * 둘이 어긋나면 "무료"라 적고 돈이 나간다. */
  const FREE_PIXELS = 1048576;
  const FREE_STEPS = 28;

  /* Opus 할당량을 쓰는 모델. **V5 뿐이다** — V4.5로 생성하면 percent가 전혀 안 줄어든다(실측).
   * page.js는 V4.5도 기록한다(Anlas와 예약 큐 때문에). 평균에서 거르는 것은 여기 한 곳이다. */
  const OPUS_MODEL = /^nai-diffusion-5(-|$)/;

  /** 이 모델이 Opus 할당량을 쓰는가.
   *  예약 창(queue.js)도 같은 판정이 필요해 NibUsage로 내보낸다 — 정규식을 두 벌 두면
   *  "V5만 깎는다"는 실측이 두 곳에 적히고, 언젠가 한쪽만 고쳐진다. */
  const usesOpus = (model) => OPUS_MODEL.test(String(model || ''));

  /** model이 없는 옛 기록은 V5만 기록하던 시절의 것이라 포함한다. */
  const countsForOpus = (g) => g.model == null || usesOpus(g.model);

  /** 이 크기·스텝이 Anlas 과금 구간인가(장수·레퍼런스 제외). */
  const paidSize = (w, h, steps) => w * h > FREE_PIXELS || steps > FREE_STEPS;

  /** 이 크기·스텝 한 장이 몇 "기준 장"인가. [A3·A4] */
  const unitsPerImage = (w, h, steps) =>
    Math.pow((w * h) / (UNIT.w * UNIT.h), PIXEL_EXP) *
    (STEP_FIXED + (1 - STEP_FIXED) * (steps / UNIT.steps));

  function parseSig(sig) {
    const m = /^(\d+)x(\d+)x(\d+)$/.exec(String(sig || ''));
    return m ? { w: +m[1], h: +m[2], steps: +m[3] } : null;
  }

  /** 이 생성이 할당량에서 몇 기준 장을 썼는가. 0 = 안 씀, null = 크기를 몰라 알 수 없음.
   *
   *  **과금 판정에 잰 차감액(cost)을 쓰지 않는다.** 예전 page.js는 뒤 생성의 차감을 앞 생성에
   *  찍는 버그가 있어, 원장에 "무료인데 cost 45"인 기록이 남아 있다. 크기·스텝·장수는
   *  요청 본문에서 읽은 값이라 그런 오염이 없다.
   *
   *  레퍼런스 두 줄(`ref`, "크기는 무료인데 과금 예측")은 V5에 캐릭터 레퍼런스가 없는 지금은
   *  걸릴 일이 없다. V5에 그 기능이 들어오는 날을 위한 자리다. */
  function quotaUnits(g) {
    if (!countsForOpus(g)) return 0;
    if (g.ref === true) return 0; // [A1] 레퍼런스 — V5에는 아직 없음
    const s = parseSig(g.sig);
    if (!s) return g.free === false && g.n === 1 ? 0 : null;
    if (paidSize(s.w, s.h, s.steps)) return 0; // [A1]
    // 크기는 무료인데 한 장 요청이 과금 예측 = 레퍼런스(ref를 기록하기 전의 원장). [A1]
    if (g.free === false && g.n === 1) return 0;
    // 여러 장 요청이어도 할당량은 첫 장만. [A2]
    return unitsPerImage(s.w, s.h, s.steps);
  }

  /** 기록표에 적을 "왜 평균에서 뺐나". 뺀 것이 아니면 ''. */
  function whyExcluded(g) {
    if (!countsForOpus(g)) return '할당량 안 쓰는 모델';
    if (quotaUnits(g) === 0) return 'Anlas 과금 생성 — 할당량 안 씀';
    return '';
  }

  let host = null;
  let root = null;
  let windowSize = 200; // 0 = 전체
  let ledger = null;

  /* ---------- 계산 ---------- */

  function percentAt(l, t) {
    let p = null;
    for (const m of l.marks) {
      if (m.t <= t) p = m.p;
      else break;
    }
    return p;
  }

  /** 시각 t에 유효한 회복 주기. 마크에 남은 값(s)을 쓰고, 그 이전 원장이면 최신 값으로 대신한다. */
  function sppAt(l, t) {
    let s = null;
    for (const m of l.marks || []) {
      if (m.t > t) break;
      if (m.s > 0) s = m.s;
    }
    return s || (l.spp > 0 ? l.spp : DEFAULT_SPP);
  }

  /** a→b 사이의 회복량(%p). 주기가 바뀐 마크에서 끊어 더한다. */
  function refillBetween(l, a, b) {
    let s = sppAt(l, a);
    let t = a;
    let total = 0;
    for (const m of l.marks || []) {
      if (m.t <= a) continue;
      if (m.t >= b) break;
      if (m.s > 0 && m.s !== s) {
        total += (m.t - t) / 1000 / s;
        t = m.t;
        s = m.s;
      }
    }
    return total + Math.max(0, b - t) / 1000 / s;
  }

  /** 측정을 오염시키는 구간들 [{from, to}]. 이 구간을 가로지르는 측정은 쓰지 않는다.
   *
   * 잔량이 100%에 닿으면 회복분이 버려진다. 그 상태에서 생성하면 곧바로 다시 채워져
   * 소모가 흔적을 남기지 않는다. 보정으로는 복구할 수 없는 정보 손실이라 잘라내는 게 맞다.
   *
   *   1. 관측된 잔량이 100% 이상이던 구간
   *   2. 구간 동안의 회복이 여유분보다 커서, 중간에 가득 찼을 수 있는 구간
   *      — 브라우저를 오래 꺼두면 그 사이 마크가 안 남으므로 이 검사가 유일한 단서다.
   *      **화면 퍼센트는 반올림이다**(2026-09-23 실측: 100%에서 약 0.5%p를 쓴 뒤에야 99가 됐다).
   *      그래서 p로 보일 때 실제 값은 최대 p + 0.5이고, 여유분은 100 − p가 아니라 99.5 − p다.
   *
   * 예전에는 "마지막 오염 이후"만 썼다. 지금은 오염 **이전** 구간도 그 자체로 멀쩡하면 쓴다 —
   * 끝점이 "지금"이 아니라 과거의 하락 순간이어도 되기 때문이다(잔량 100%인 지금도 숫자가 나온다). */
  function badSpans(l, rows) {
    const marks = l.marks || [];
    const cur = l.current;
    const out = [];
    let ri = 0;
    for (let i = 0; i < marks.length; i++) {
      const p = marks[i].p;
      const from = marks[i].t;
      const to = i + 1 < marks.length ? marks[i + 1].t : cur ? cur.t : from;
      /* 그 사이 생성이 쓴 양의 **하한**을 빼고 본다. 빼지 않으면 99%로 보이는 채 50분만 지나도
         (회복 0.5%p) 계속 생성 중이었는데도 오염으로 버려진다. rows 는 시각순이라 한 번만 훑는다. */
      let units = 0;
      while (ri < rows.length && rows[ri].g.t <= from) ri++;
      for (let j = ri; j < rows.length && rows[j].g.t <= to; j++) {
        if (rows[j].u !== 0) units += rows[j].u == null ? 1 : rows[j].u;
      }
      const rise = (to - from) / 1000 / sppAt(l, from) - units * MIN_UNIT_COST;
      if (p >= 100 || rise > 99.5 - p) out.push({ from, to });
    }
    return out;
  }

  const crossesBad = (bad, a, b) => bad.some((s) => s.from < b && s.to > a);

  /** 생성 직후 퍼센트가 한 칸(이상) 떨어진 순간들.
   *
   *  떨어졌다는 것은 방금 실제 잔량이 정수 경계를 아래로 넘었다는 뜻이라, 그 순간의 실제 값은
   *  "경계 − (생성 한 장 분량 미만)"이다. 두 순간 사이의 소모는 퍼센트 차이 + 회복량이고
   *  오차는 **한 장 분량**이다(표시가 버림이든 반올림이든 양 끝에서 같은 쪽으로 어긋나 상쇄된다).
   *
   *  **올라간 순간은 쓰지 않는다.** 가만히 있을 때의 퍼센트 상승은 화면에 늦게 반영된다 —
   *  2026-09-22 원장에서 계산상 22:06에 올랐어야 할 97%가 23:03에야 찍혔다(탭이 뒤에 있었던 듯). */
  function dropAnchors(l) {
    const marks = l.marks || [];
    const gens = l.gens || [];
    const out = [];
    let gi = 0;
    for (let i = 1; i < marks.length; i++) {
      const m = marks[i];
      if (!(m.p < marks[i - 1].p)) continue;
      // 방금 생성이 있었어야 "경계 바로 아래"다. 다른 기기에서 쓴 하락은 언제 넘었는지 모른다.
      while (gi < gens.length && gens[gi].t <= m.t) gi++;
      const g = gens[gi - 1];
      if (g && m.t - g.t <= ANCHOR_LAG_MS) out.push(m);
    }
    return out;
  }

  /** (a, b] 구간의 할당량 생성을 모은다. */
  function collect(rows, a, b) {
    let units = 0;
    let images = 0;
    let guessed = 0;
    let uMax = 0;
    let excluded = 0;
    for (const r of rows) {
      if (r.g.t <= a || r.g.t > b) continue;
      if (r.u === 0) {
        excluded++;
        continue;
      }
      const u = r.u == null ? 1 : r.u; // 크기를 모르면 기준 한 장으로 센다
      if (r.u == null) guessed++;
      units += u;
      images++;
      if (u > uMax) uMax = u;
    }
    return { units, images, guessed, uMax, excluded };
  }

  /** 끝점이 둘 다 하락 순간인 **구간들**을 모은다. 없으면 null.
   *
   *  가장 최근 하락부터 거꾸로, 이웃한 하락 쌍을 하나씩 붙여 창 크기(장)를 채운다.
   *  오염 구간(100% 도달)을 가로지르는 쌍은 건너뛰고 **그 앞 세션에서 이어서 모은다** —
   *  예전에는 거기서 멈춰서, 매일 100%까지 차는 사람은 "전체"를 골라도 마지막 세션(20장 남짓)만 썼다.
   *
   *  이어진 쌍은 한 덩어리(세그먼트)로 합친다. 안쪽 끝점의 오차는 앞뒤 쌍에서 서로 상쇄되므로
   *  덩어리 하나의 오차는 바깥 두 끝점에서 온 한 장 분량뿐이다. 덩어리끼리는 독립이라
   *  오차를 제곱합으로 더한다(analyze). */
  function pickAnchored(l, rows, bad, windowImages) {
    const anchors = dropAnchors(l);
    const segs = [];
    let seg = null;
    let images = 0;
    let clamped = false;
    for (let e = anchors.length - 1; e > 0; e--) {
      const S = anchors[e - 1];
      const E = anchors[e];
      if (crossesBad(bad, S.t, E.t)) {
        seg = null; // 여기서 끊고, 더 앞의 멀쩡한 쌍은 새 덩어리로 모은다
        clamped = true;
        continue;
      }
      if (seg && seg.S === E) seg.S = S;
      else segs.push((seg = { S, E }));
      images += collect(rows, S.t, E.t).images;
      if (windowImages && images >= windowImages) break;
    }
    const parts = segs
      .map((s) => ({ ...s, c: collect(rows, s.S.t, s.E.t) }))
      .filter((s) => s.c.images > 0);
    return parts.length ? { parts, clamped } : null;
  }

  /** 예전 방식: 최근 생성들 ~ 지금. 끝점 오차 ±1%p. */
  function pickLoose(l, rows, bad, windowImages) {
    const cur = l.current;
    const q = rows.filter((r) => r.u !== 0);
    let startIdx = -1;
    let n = 0;
    let clamped = false;
    for (let i = q.length - 1; i >= 0; i--) {
      if (crossesBad(bad, q[i].g.t, cur.t)) {
        clamped = true;
        break;
      }
      startIdx = i;
      n++;
      if (windowImages && n >= windowImages) break;
    }
    if (startIdx < 0) return null;
    const t0 = q[startIdx].g.t;
    const pStart = percentAt(l, t0);
    if (pStart == null) return null;
    return { t0, pStart, c: collect(rows, t0 - 1, cur.t), clamped };
  }

  function analyze(l, windowImages) {
    const cur = l.current;
    const all = l.gens || [];
    if (!cur || !all.length) return { ok: false, reason: 'no-data' };

    const rows = all.map((g) => ({ g, u: quotaUnits(g) }));
    if (!rows.some((r) => r.u !== 0)) return { ok: false, reason: 'no-data' };
    const bad = badSpans(l, rows);

    /* 구간(들)을 고른다. 하락 끝점 구간이 하나라도 있으면 그것들을, 없으면 예전 방식 하나를.
     * 아래는 전부 "구간 목록"으로 다룬다 — 예전 방식은 구간이 하나인 경우일 뿐이다. */
    let parts, clamped, anchored;
    const A = pickAnchored(l, rows, bad, windowImages);
    if (A) {
      anchored = true;
      ({ parts, clamped } = A);
    } else {
      const B = pickLoose(l, rows, bad, windowImages);
      if (!B) return { ok: false, reason: bad.length ? 'capped' : 'no-mark' };
      anchored = false;
      clamped = B.clamped;
      // −1ms: 구간은 "시작 이후"라, 첫 생성 자신이 구간 밖으로 빠지지 않게
      parts = [{ S: { t: B.t0 - 1, p: B.pStart }, E: { t: cur.t, p: cur.p }, c: B.c }];
    }

    const c = { units: 0, images: 0, guessed: 0, uMax: 0, excluded: 0 };
    let refill = 0;
    let consumed = 0;
    let elapsedSec = 0;
    for (const s of parts) {
      s.refill = refillBetween(l, s.S.t, s.E.t);
      s.consumed = s.S.p - s.E.p + s.refill;
      refill += s.refill;
      consumed += s.consumed;
      elapsedSec += Math.max(0, (s.E.t - s.S.t) / 1000);
      c.units += s.c.units;
      c.images += s.c.images;
      c.guessed += s.c.guessed;
      c.excluded += s.c.excluded;
      c.uMax = Math.max(c.uMax, s.c.uMax);
    }
    const first = parts[parts.length - 1]; // 가장 오래된 구간
    const lastPart = parts[0]; // 가장 최근 구간
    const t0 = first.S.t;
    const t1 = lastPart.E.t;
    const pStart = first.S.p;
    const pEnd = lastPart.E.p;
    const avg = c.units > 0 ? consumed / c.units : 0; // 기준 한 장당 %p

    /* 소모 오차: 하락 끝점 덩어리마다 생성 한 장 분량(그 덩어리에서 가장 큰 것, 보수적으로),
     * 덩어리끼리는 독립이라 제곱합. 예전 방식이면 끝점 ±1%p. */
    const consumedErr = anchored
      ? Math.sqrt(parts.reduce((sum, s) => sum + (Math.max(0, avg) * s.c.uMax) ** 2, 0))
      : 1;
    const avgErr = c.units > 0 ? consumedErr / c.units : Infinity;
    const relative = consumed > 0 ? consumedErr / consumed : Infinity;

    /* ±10%까지 기준 몇 장이 더 필요한가. 0이면 이미 도달. avg가 0 이하이면 답이 없어 null.
     * 사용량 창과 예약 창이 같은 문장을 쓰므로 계산은 여기 한 곳에서만 한다. */
    let toTarget = null;
    if (avg > 0) {
      toTarget = Math.ceil(
        Math.max(0, anchored ? c.uMax / TARGET_RELATIVE - c.units : (consumedErr / TARGET_RELATIVE - consumed) / avg)
      );
    }

    /* Anlas 합은 **거르지 않은 전체**에서 낸다. 돈은 모델을 가리지 않고 나가므로,
     * Opus 평균에서 뺀 생성이라고 지출까지 빼면 합계가 실제 잔액 변화와 어긋난다. */
    const spans = parts.map((s) => [s.S.t, s.E.t]);
    const inSpans = (t) => spans.some(([a, b]) => t > a && t <= b);
    let anlas = 0;
    let anlasUnknown = 0;
    for (const g of all) {
      if (!inSpans(g.t)) continue;
      // 음수는 충전이다(옛 원장). 차감 합에 넣지 않는다.
      if (Number.isFinite(g.cost) && g.cost >= 0) anlas += g.cost;
      else anlasUnknown++;
    }

    /* "지금 설정 한 장" — 가장 최근 할당량 생성의 크기·스텝으로 환산한다. 기준 장은 28스텝이라
     * 16~19스텝으로 쓰는 사람에게는 그대로 보여주면 실제보다 커 보인다. */
    let last = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const s = rows[i].u ? parseSig(rows[i].g.sig) : null;
      if (s) {
        const u = unitsPerImage(s.w, s.h, s.steps);
        last = { ...s, units: u, per: avg * u, remaining: avg > 0.00001 ? cur.p / (avg * u) : null };
        break;
      }
    }

    return {
      ok: true,
      spp: sppAt(l, cur.t),
      anchored,
      t0,
      t1,
      spans, // 실제로 쓴 구간들 [시작, 끝] — 사이의 빈틈(100% 도달 등)은 안 썼다
      segments: parts.length,
      images: c.images,
      units: c.units,
      guessed: c.guessed,
      excluded: c.excluded,
      anlas,
      anlasUnknown,
      pStart,
      pEnd,
      elapsedSec,
      refill,
      clamped,
      consumed,
      consumedErr,
      avg,
      avgErr,
      relative,
      reliable: anchored ? consumed > consumedErr : consumed > MIN_CONSUMED,
      toTarget,
      remainingUnits: avg > 0.00001 ? cur.p / avg : null,
      last,
    };
  }

  /* ---------- 서식 ---------- */

  const pad = (n) => String(n).padStart(2, '0');

  function stamp(t) {
    const d = new Date(t);
    return (
      d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
    );
  }

  function dur(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '—';
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d) return `${d}일 ${h}시간`;
    if (h) return `${h}시간 ${m}분`;
    return `${m}분`;
  }

  /* ---------- 그래프 ---------- */

  function buildGraph(l, a) {
    const W = 520, H = 150, PADL = 34, PADR = 10, PADT = 12, PADB = 26;
    const marks = l.marks || [];
    const cur = l.current;
    if (!marks.length || !cur) return '<div class="empty">아직 표본이 없습니다.</div>';

    const t0 = marks[0].t;
    const t1 = Math.max(cur.t, marks[marks.length - 1].t);
    const span = Math.max(1, t1 - t0);

    const ps = marks.map((m) => m.p).concat([cur.p]);
    let lo = Math.min(...ps), hi = Math.max(...ps);
    if (hi - lo < 4) { const mid = (hi + lo) / 2; lo = mid - 2; hi = mid + 2; }

    /* 여백 1%p씩. 0과 100은 눈금을 멈춰 세우는 자리이지 **상한·하한이 아니다** —
     * 잔량은 100을 넘을 수 있고(V5 출시 기념으로 130%를 본 적이 있다) isNegative면 음수다.
     * 그래서 데이터가 이미 밖에 있으면 눈금도 거기까지 따라 나간다.
     * 무턱대고 100으로 자르면 lo > hi 가 되어 축이 뒤집히고 눈금이 통째로 사라진다. */
    const floorAt = Math.min(0, ...ps);
    const ceilAt = Math.max(100, ...ps);
    lo = Math.max(floorAt, Math.floor(lo - 1));
    hi = Math.min(ceilAt, Math.ceil(hi + 1));
    if (hi - lo < 2) hi = lo + 2;

    const x = (t) => PADL + ((t - t0) / span) * (W - PADL - PADR);
    const y = (p) => PADT + (1 - (p - lo) / (hi - lo)) * (H - PADT - PADB);

    // 계단선: 값이 유지되다가 관측 시점에 한 칸 떨어진다
    let d = '';
    marks.forEach((m, i) => {
      const px = x(m.t), py = y(m.p);
      if (i === 0) d += `M ${px.toFixed(1)} ${py.toFixed(1)}`;
      else d += ` L ${px.toFixed(1)} ${py.toFixed(1)}`;
      const nextT = i + 1 < marks.length ? marks[i + 1].t : cur.t;
      d += ` L ${x(nextT).toFixed(1)} ${py.toFixed(1)}`;
    });

    // Y축 눈금
    let grid = '';
    const steps = Math.min(5, hi - lo);
    for (let i = 0; i <= steps; i++) {
      const p = lo + ((hi - lo) * i) / steps;
      const py = y(p);
      grid += `<line class="grid" x1="${PADL}" y1="${py.toFixed(1)}" x2="${W - PADR}" y2="${py.toFixed(1)}"/>`;
      grid += `<text class="tick" x="${PADL - 6}" y="${(py + 3).toFixed(1)}" text-anchor="end">${Math.round(p)}%</text>`;
    }

    // 생성 눈금 (창 범위 안은 강조)
    let ticks = '';
    for (const g of l.gens || []) {
      if (g.t < t0) continue;
      const gx = x(g.t);
      const inWin = a.ok && a.spans.some(([s, e]) => g.t > s && g.t <= e);
      ticks += `<line class="gen ${inWin ? 'in' : ''}" x1="${gx.toFixed(1)}" y1="${H - PADB}" x2="${gx.toFixed(1)}" y2="${H - PADB + 7}"/>`;
    }

    const leftLabel = stamp(t0).slice(5, 16);
    const rightLabel = stamp(t1).slice(5, 16);

    return `
      <svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="xMidYMid meet">
        ${grid}
        <path class="line" d="${d}"/>
        ${ticks}
        <text class="axis" x="${PADL}" y="${H - 4}">${leftLabel}</text>
        <text class="axis" x="${W - PADR}" y="${H - 4}" text-anchor="end">${rightLabel}</text>
      </svg>`;
  }

  /* ---------- 본문 ---------- */

  const esc = NibUI.esc;

  function render() {
    if (!root || !ledger) return;
    const body = root.getElementById('body');
    const a = analyze(ledger, windowSize);
    const cur = ledger.current;

    const stat = (label, value, sub, cls) => `
      <div class="stat ${cls || ''}">
        <div class="s-label">${label}</div>
        <div class="s-value">${value}</div>
        <div class="s-sub">${sub || ''}</div>
      </div>`;

    /* Anlas는 퍼센트와 달리 회복이 없고 정수라, 잔액 차이가 곧 차감액이다.
     * 기본 크기 생성은 0이 정상이므로 0을 "고장"처럼 보이게 두지 않는다. */
    const anlasStat = (analysis) => {
      const bal = ledger.anlas;
      if (!bal) return stat('Anlas', '—', '아직 못 읽었습니다', 'weak soft');
      let sub = '기본 크기 생성은 0입니다';
      if (analysis && analysis.ok) {
        sub = '이 구간 −' + analysis.anlas;
        if (analysis.anlasUnknown) sub += ' · ' + analysis.anlasUnknown + '건 확인 못 함';
      }
      return stat('Anlas', String(bal.v), sub);
    };

    let stats = '';
    if (!cur) {
      stats = '<div class="empty">NovelAI에서 잔량을 아직 못 읽었습니다.</div>';
    } else if (!a.ok) {
      const why =
        a.reason === 'capped'
          ? '잔량이 가득 차 있어 소모가 흔적을 남기지 않습니다'
          : a.reason === 'no-mark'
            ? '기준 시점 기록 없음'
            : '생성 기록 없음';
      stats =
        stat('현재 잔량', cur.p + '%', '정수 단위로만 관측됩니다') +
        anlasStat(null) +
        stat('표본', '없음', why, 'weak soft');
    } else {
      /* **숫자는 늘 띄운다.** 가려버리면 기능이 고장난 것처럼 보이고, 신뢰도가 낮다는 사실은
       * 숫자를 지우는 것이 아니라 밑에 적어서 알려야 한다. */
      // 오차가 0.001%p 아래로 내려가면 toFixed(3)이 "± 0.000"을 찍는다 — 그땐 상대오차만 적는다.
      const sub = ['832×1216·28스텝 환산'];
      if (a.avgErr >= 0.0005) sub.push('± ' + a.avgErr.toFixed(3) + '%p');
      if (!a.reliable) {
        sub.push('아직 오차가 100%를 넘습니다');
      } else if (a.toTarget) {
        sub.push('오차 ±' + Math.round(a.relative * 100) + '% · ±10%까지 기준 ' + a.toTarget + '장 더');
      } else {
        sub.push(a.relative < 0.01 ? '오차 ±1% 미만' : '오차 ±' + Math.round(a.relative * 100) + '%');
      }
      if (a.guessed) sub.push('크기 모르는 ' + a.guessed + '건은 기준 1장으로 셈');
      const avgSub = sub.join(' · ');

      const span = !a.anchored
        ? '첫 생성 ~ 지금 (끝점 ±1%p)'
        : a.segments > 1
          ? `생성 직후 하락 사이 구간 ${a.segments}개 (100% 도달로 끊긴 세션들)`
          : '생성 직후 하락 두 순간 사이';
      const old = a.anchored && cur.t - a.t1 > 3600000 ? ' · ' + stamp(a.t1).slice(5, 16) + '까지' : '';
      const range = a.segments > 1 ? `구간 ${a.segments}개 합` : `${a.pStart}% → ${a.pEnd}%`;

      stats =
        stat('현재 잔량', cur.p + '%', '정수 단위로만 관측됩니다') +
        anlasStat(a) +
        stat(
          '표본',
          a.images + '장',
          dur(a.elapsedSec) + ' · ' + span + old +
            (a.clamped ? ' · 100% 도달 구간 제외' : '') +
            (a.excluded ? ' · 과금·V4.5 ' + a.excluded + '건 제외' : '')
        ) +
        stat(
          '누적 소모',
          a.consumed.toFixed(2) + '%p',
          `${range} · 회복 +${a.refill.toFixed(2)}%p · ±${a.consumedErr.toFixed(2)}` +
            (a.consumed < 0 ? ' · 회복이 소모보다 커 음수' : ''),
          a.reliable ? '' : 'weak'
        ) +
        stat('기준 1장당', a.avg.toFixed(3) + '%', avgSub, a.reliable ? 'good' : 'weak') +
        (a.last
          ? stat(
              '지금 설정 1장',
              a.last.per.toFixed(3) + '%',
              `${a.last.w}×${a.last.h}·${a.last.steps}스텝 = 기준 ${a.last.units.toFixed(2)}장`,
              a.reliable ? '' : 'weak'
            )
          : '');
    }

    let est = '';
    const refillTxt = a.ok
      ? `회복 속도는 1%당 ${dur(a.spp)} (하루 약 ${(86400 / a.spp).toFixed(1)}%, 0→100% ${(a.spp * 100 / 86400).toFixed(1)}일).`
      : '';
    if (a.ok && a.reliable && a.last && a.last.remaining) {
      est = `<p class="note">현재 잔량으로 지금 설정(${a.last.w}×${a.last.h}·${a.last.steps}스텝) <b>약 ${Math.round(
        a.last.remaining
      )}장</b> 더 생성할 수 있습니다. ${refillTxt}</p>`;
    } else if (a.ok) {
      est = `<p class="note">${refillTxt}</p>`;
    }

    const gens = (ledger.gens || []).slice().reverse().slice(0, 60);
    const rows = gens.length
      ? gens
          .map((g) => {
            const p = percentAt(ledger, g.t);
            // 0과 "모름"은 다르다. 못 잰 것을 0으로 적으면 합계가 조용히 틀어진다.
            // 음수는 옛 원장의 충전 기록이다 — 차감처럼 "−-9918"로 찍지 않는다.
            const cost = !Number.isFinite(g.cost) ? '—' : g.cost < 0 ? '충전' : g.cost ? '−' + g.cost : '0';
            // 할당량을 안 쓴 생성은 흐리게. 숨기지는 않는다 — 돈은 실제로 나갔을 수 있다.
            const why = whyExcluded(g);
            const off = why ? ` class="off" title="${esc(why)}"` : '';
            const s = parseSig(g.sig);
            const size = s ? `${s.w}×${s.h}·${s.steps}` : '—';
            return `<tr${off}>
              <td class="t">${esc(stamp(g.t))}</td>
              <td class="n">${g.n}장</td>
              <td class="z">${size}</td>
              <td class="p">${p == null ? '—' : p + '%'}</td>
              <td class="a">${cost}</td>
              <td class="m">${esc(g.model || '')}</td>
            </tr>`;
          })
          .join('')
      : '<tr><td colspan="6" class="empty-row">아직 생성 기록이 없습니다.</td></tr>';

    body.innerHTML = `
      <div class="stats">${stats}</div>
      ${est}
      <div class="section">
        <div class="section-head">
          <span>잔량 추이</span>
          <span class="legend"><i class="sw-line"></i>잔량 <i class="sw-tick"></i>생성</span>
        </div>
        ${buildGraph(ledger, a)}
      </div>
      <div class="section">
        <div class="section-head"><span>최근 생성 기록</span><span class="legend">${(ledger.gens || []).length}건 보관</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>시각</th><th>장수</th><th>크기·스텝</th><th>그때 잔량</th><th>Anlas</th><th>모델</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
      <p class="fine">NovelAI는 정수 퍼센트만 알려줍니다. 한 번의 생성이 얼마를 썼는지는 알 수 없고,
      구간의 하락을 그 사이 생성으로 나눈 <b>평균</b>만 구할 수 있습니다.
      구간의 양 끝을 <b>생성 직후 퍼센트가 떨어진 순간</b>으로 잡으면 끝점 오차가 한 장 분량으로 줄어듭니다.<br>
      크기·스텝이 다른 생성은 <b>832×1216·28스텝 한 장</b>으로 환산해 셉니다 — 실측으로 맞춘 식입니다:
      소모는 <b>픽셀 수에 비례</b>하고, 스텝은 <b>약 19%의 고정분 + 스텝에 비례하는 나머지</b>입니다.
      <b>Anlas가 나가는 생성은 할당량을 쓰지 않는다고 보고</b> 평균에서 뺍니다(원장 실측으로 확인).</p>`;

    /* 범위 버튼만 고른다. `기록 지우기`도 생김새 때문에 .win-btn 을 걸치고 있는데,
       클래스로 잡으면 그 버튼까지 범위 버튼으로 다뤄져 windowSize 가 NaN 이 된다. */
    root.querySelectorAll('[data-win]').forEach((b) => {
      b.setAttribute('aria-selected', String(Number(b.dataset.win) === windowSize));
    });

    // 자리를 잡을 때는 본문이 비어 있어 창이 낮았다. 내용이 채워진 지금 다시 재서 화면 안으로 넣는다.
    NibUI.clampIntoView(root.querySelector('.win'));
  }

  async function refresh() {
    try {
      const res = await chrome.runtime.sendMessage({ cmd: 'ledger.get' });
      if (res?.ok) {
        ledger = res.ledger;
        render();
      }
    } catch {}
  }

  /* ---------- 창 ---------- */
  /* 창틀·색·드래그·마크는 shared-ui.js에 모여 있다. 여기엔 이 창에만 있는 것만 적는다.
     shadow DOM 안이라 NovelAI CSS는 새어 들어오지 않는다. */
  const CSS = NibUI.shellCSS('592px') + `

    .wins { display: flex; gap: 4px; padding: 11px 13px 0; flex: 0 0 auto; }
    .win-btn {
      height: 25px; padding: 0 11px;
      border: 1px solid var(--hairline); border-radius: 999px;
      background: var(--surface); color: var(--ink-3);
      font-family: inherit; font-size: 11px; font-weight: 500; cursor: pointer;
      transition: background-color .18s var(--ease), border-color .18s var(--ease), color .18s var(--ease), transform .18s var(--ease);
    }
    .win-btn:hover { color: var(--ink); border-color: var(--hairline-2); }
    .win-btn[aria-selected="true"] {
      /* --accent 는 --accent-soft 위에서 4.36:1 — 11px 글자에는 모자란다.
         예약 창의 .chip.on 과 같은 잉크를 쓴다. */
      background: var(--accent-soft); color: var(--accent-hi);
      border-color: var(--accent-line); font-weight: 600;
    }
    .wins-gap { flex: 1; }
    .win-btn.danger { color: var(--ink-3); }
    .win-btn.danger:hover {
      color: var(--danger);
      border-color: color-mix(in srgb, var(--danger) 40%, transparent);
      background: var(--danger-soft);
    }
    .win-btn:active { transform: scale(.94); }
    @media (prefers-reduced-motion: reduce) {
      .win-btn:active { transform: none; }
    }

    .body { padding: 12px 13px 15px; }

    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(126px, 1fr)); gap: 6px; }
    .stat {
      padding: 10px 11px;
      background: var(--surface); border: 1px solid var(--hairline);
      border-radius: var(--r-card); box-shadow: var(--inner-hi);
    }
    .stat.good { border-color: color-mix(in srgb, var(--good) 34%, var(--hairline)); }
    .stat.weak { border-color: color-mix(in srgb, var(--warn) 34%, var(--hairline)); }
    .s-label {
      font-size: 9.5px; font-weight: 600; letter-spacing: .14em;
      text-transform: uppercase; color: var(--ink-3);
    }
    .s-value {
      margin-top: 4px; font-family: var(--font-display);
      font-size: 18px; font-weight: 700; letter-spacing: -0.02em;
    }
    /* 숫자가 아닌 안내 문구는 숫자만큼 크게 외칠 필요가 없다 */
    .stat.soft .s-value { font-size: 13.5px; font-weight: 600; }
    .stat.good .s-value { color: var(--good); }
    .stat.weak .s-value { color: var(--warn); }
    .s-sub { margin-top: 3px; font-size: 10px; color: var(--ink-3); line-height: 1.5; }

    .note {
      margin: 11px 0 0; padding: 9px 11px;
      background: var(--accent-soft); border: 1px solid var(--accent-line);
      border-radius: var(--r-card);
      font-size: 11.5px; color: var(--ink-2); line-height: 1.65;
    }
    .note b { color: var(--accent); font-weight: 700; }

    .section { margin-top: 15px; }
    .section-head {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 7px;
      font-size: 9.5px; font-weight: 600; letter-spacing: .14em;
      text-transform: uppercase; color: var(--ink-3);
    }
    .legend {
      display: flex; align-items: center; gap: 5px;
      text-transform: none; letter-spacing: 0; font-weight: 500; font-size: 10px;
    }
    .sw-line { display: inline-block; width: 12px; height: 2px; border-radius: 2px; background: var(--accent); }
    .sw-tick { display: inline-block; width: 2px; height: 9px; border-radius: 1px; background: var(--mark); margin-left: 7px; }

    .chart {
      width: 100%; height: auto; display: block;
      background: var(--surface); border: 1px solid var(--hairline);
      border-radius: var(--r-core); box-shadow: var(--inner-hi);
    }
    .chart .grid { stroke: var(--hairline); stroke-width: 1; }
    .chart .tick, .chart .axis {
      fill: var(--ink-3); font-size: 8.5px; font-family: var(--font-mono);
    }
    .chart .line { fill: none; stroke: var(--accent); stroke-width: 1.75; stroke-linejoin: round; stroke-linecap: round; }
    .chart .gen { stroke: var(--mark); stroke-width: 1.5; opacity: .3; }
    .chart .gen.in { opacity: 1; }

    .table-wrap {
      max-height: 244px; overflow-y: auto;
      border: 1px solid var(--hairline); border-radius: var(--r-core);
      background: var(--surface);
    }
    /* 스크롤바 모양은 shellCSS 의 전역(*) 규칙 한 벌이 전부 맡는다.
       투명 테두리 + background-clip 이라 이 --surface 바탕 위에도 그대로 앉는다.
       **이 주석은 템플릿 리터럴 안이다 — 백틱을 쓰면 문자열이 거기서 끊긴다.** */
    table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
    thead th {
      position: sticky; top: 0; z-index: 1;
      background: var(--shell); color: var(--ink-3);
      font-size: 9.5px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase;
      text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--hairline);
    }
    tbody td { padding: 7px 10px; border-bottom: 1px solid var(--hairline); color: var(--ink-2); }
    tbody tr:last-child td { border-bottom: 0; }
    tbody tr:hover td { background: var(--sunken); }
    td.t { font-family: var(--font-mono); font-size: 11px; color: var(--ink); white-space: nowrap; }
    td.n, td.z, td.p, td.a { font-family: var(--font-mono); font-size: 11px; white-space: nowrap; }
    td.z { color: var(--ink-3); font-size: 10.5px; }
    td.a { color: var(--ink-2); }
    td.m { color: var(--ink-3); font-size: 10px; }
    tr.off td { opacity: .45; }
    tr.off td.t::after { content: ' · 평균 제외'; color: var(--ink-3); font-size: 9.5px; }

    .empty, .empty-row {
      padding: 22px; text-align: center; color: var(--ink-3); font-size: 11.5px;
    }
    .fine {
      margin: 13px 0 0; padding-top: 12px;
      border-top: 1px solid var(--hairline);
      font-size: 10.5px; color: var(--ink-3); line-height: 1.75;
    }
    .fine b { color: var(--ink-2); font-weight: 600; }
  `;

  function build() {
    host = document.createElement('div');
    host.id = HOST_ID;
    root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;

    const win = document.createElement('div');
    win.className = 'win';
    win.innerHTML = `
      <div class="head" id="head">
        ${NibUI.markSVG('ov')}
        <span class="title">Nib · Opus 사용량</span>
        <span class="spacer"></span>
        <button class="hbtn" id="reload" title="새로고침">⟳</button>
        <button class="hbtn" id="close" title="닫기">✕</button>
      </div>
      <div class="wins">
        <button class="win-btn" data-win="50">최근 50장</button>
        <button class="win-btn" data-win="200">최근 200장</button>
        <button class="win-btn" data-win="0">전체</button>
        <span class="wins-gap"></span>
        <button class="win-btn" id="export" title="원장을 다운로드 폴더에 JSON으로 저장합니다">기록 내보내기</button>
        <button class="win-btn danger" id="reset" title="쌓인 생성·잔량 기록을 모두 지웁니다">기록 지우기</button>
      </div>
      <div class="body" id="body"></div>`;

    root.append(style, win);
    document.documentElement.appendChild(host);

    root.getElementById('close').addEventListener('click', () => toggleOverlay(false));
    root.getElementById('reload').addEventListener('click', refresh);

    /* 원장은 chrome.storage 안에만 있어 밖에서 읽을 길이 없다. 실측 분석을 하려면 파일로 꺼내야 한다.
     * 저장은 서비스 워커가 downloads API로 한다 — 페이지에서 <a download>로 내리던 첫 판은
     * NovelAI 페이지 안에서 조용히 실패했다. **결과는 반드시 화면에 적는다**(콘솔만 보면 모른다). */
    root.getElementById('export').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        const res = await chrome.runtime.sendMessage({ cmd: 'ledger.export' });
        if (!res?.ok) throw new Error(res?.error || '응답 없음');
        btn.textContent = '저장됨 ✓';
        btn.title = res.path;
        alert('기록을 저장했습니다.\n\n' + res.path);
      } catch (e) {
        alert('기록을 내보내지 못했습니다.\n\n' + (e?.message || e) +
          '\n\n확장을 새로고침(chrome://extensions → Nib ↻)한 뒤 NovelAI 탭도 F5 해 주세요.');
      } finally {
        btn.disabled = false;
        setTimeout(() => { if (btn.isConnected) btn.textContent = '기록 내보내기'; }, 4000);
      }
    });

    root.getElementById('reset').addEventListener('click', async () => {
      const n = (ledger?.gens || []).length;
      const msg = n
        ? `생성 기록 ${n}건과 잔량 추이를 모두 지웁니다.\n되돌릴 수 없고, 평균은 처음부터 다시 쌓아야 합니다.\n\n계속할까요?`
        : '쌓인 기록이 없습니다. 그래도 초기화할까요?';
      if (!confirm(msg)) return;
      try {
        const res = await chrome.runtime.sendMessage({ cmd: 'ledger.reset' });
        if (!res?.ok) throw new Error(res?.error || 'reset failed');
      } catch (e) {
        console.warn('[Nib] 기록을 지우지 못했습니다:', e?.message || e);
      }
      await refresh();
    });
    root.querySelectorAll('[data-win]').forEach((b) => {
      b.addEventListener('click', () => {
        windowSize = Number(b.dataset.win);
        render();
      });
    });

    NibUI.makeDraggable(win, root.getElementById('head'), POS_KEY);
    NibUI.restorePosition(win, POS_KEY, () => ({ x: Math.max(10, window.innerWidth - 620), y: 70 }));
    NibUI.syncTheme(host);
  }

  function toggleOverlay(show) {
    const want = show === undefined ? !host : !!show;
    if (want) {
      if (!host) build();
      refresh();
    } else if (host) {
      host.remove();
      host = null;
      root = null;
    }
  }

  globalThis.toggleOverlay = toggleOverlay;

  /* 예약 창(queue.js)이 소모량 예측에 같은 분석기·모델 판정·환산식을 쓴다.
   * 복사해 두면 오염 구간 판정이나 "V5만 깎는다", 가정 A1~A4가 두 벌이 되어 조용히 갈라진다. */
  globalThis.NibUsage = { analyze, usesOpus, unitsPerImage, paidSize, UNIT };

  NibUI.watchTheme(() => host);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !host) return;
    if (changes[LEDGER_KEY]) refresh();
  });
})();
