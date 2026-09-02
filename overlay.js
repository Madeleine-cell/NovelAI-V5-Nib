/* Nib — NovelAI 위에 띄우는 사용량 창
 *
 * 사이드 패널은 좁아서 그래프와 기록표를 같이 놓기 어렵다. 이 창은 NovelAI 화면 위에 뜬다.
 * NovelAI의 CSS가 새어 들어오지 않도록 shadow DOM 안에 만든다.
 *
 * 정확도에 대해:
 *   잔량은 정수 퍼센트로만 관측된다(page.js 주석 참고). 그래서 "이번 생성이 얼마 썼는지"는
 *   원리적으로 알 수 없다. 대신 여러 번의 정수 하락을 그 사이 생성 장수로 나눠 평균을 낸다.
 *   절단 오차는 누적되지 않고 총합 ±1%p로 고정이므로, 누적 하락이 클수록 평균이 정확해진다.
 */

(() => {
  const HOST_ID = 'nib-usage-overlay';
  const POS_KEY = 'nib.overlayPos';
  const LEDGER_KEY = 'nib.ledger';
  const DEFAULT_SPP = 7888;

  /* 오차 ±10%가 실용 하한이다. 상대오차 = 1 / 누적하락(%p) 이므로 누적 10%p가 목표다.
   * 예약 창(queue.js)도 같은 문장을 쓰므로 값도 계산도 여기 한 벌만 둔다(analyze의 toTarget). */
  const TARGET_CONSUMED = 10;
  /* 누적 하락이 이만큼도 안 되면 오차가 100%를 넘어 숫자를 믿을 수 없다. */
  const MIN_CONSUMED = 1;

  /* Opus 할당량을 쓰는 모델. **V5 뿐이다** — V4.5로 생성하면 percent가 전혀 안 줄어든다(실측).
   * page.js는 V4.5도 기록한다(Anlas와 예약 큐 때문에). 평균에서 거르는 것은 여기 한 곳이다. */
  const OPUS_MODEL = /^nai-diffusion-5(-|$)/;

  /** 이 모델이 Opus 할당량을 쓰는가.
   *  예약 창(queue.js)도 같은 판정이 필요해 NibUsage로 내보낸다 — 정규식을 두 벌 두면
   *  "V5만 깎는다"는 실측이 두 곳에 적히고, 언젠가 한쪽만 고쳐진다. */
  const usesOpus = (model) => OPUS_MODEL.test(String(model || ''));

  /** 이 생성이 할당량을 깎을 수 **있는** 모델인가.
   *  V4.5는 percent를 전혀 안 깎는 것이 확인됐으므로 분모에서 그냥 빼면 된다.
   *  model이 없는 옛 기록은 V5만 기록하던 시절의 것이라 포함한다. */
  const countsForOpus = (g) => g.model == null || usesOpus(g.model);

  /** Anlas가 나간 생성인가.
   *
   *  **이런 생성이 할당량도 함께 깎는지는 관측할 수 없다.** percent는 정수라 한 장의
   *  영향이 눈금에 안 잡히고, 요청·응답 어디에도 "이번엔 할당량을 썼다"는 표시가 없다.
   *
   *  깎는다고 보면(안 깎을 경우) 장당 평균이 작아지고, 안 깎는다고 보면(깎을 경우)
   *  그 하락이 무료 생성들에 얹혀 평균이 커진다. **어느 쪽으로 가정해도 한쪽은 틀린다.**
   *  그래서 가정하지 않고 그 구간을 통째로 잘라낸다 — 100%에 닿았던 구간을 잘라내는 것과
   *  같은 이유다(복구 불가능한 정보 손실은 보정하지 말고 버린다).
   *
   *  cost를 재 봤는데 0이면 실제로 무료였다는 뜻이니 깨끗하다. 못 쟀고(null) 예측이
   *  과금이었으면 오염으로 본다 — 안전한 쪽으로 기운다. */
  const paidGen = (g) => g.cost > 0 || (!Number.isFinite(g.cost) && g.free === false);

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

  /** 측정을 오염시키는 구간의 끝 시각을 찾는다. 그 이전은 아예 쓰지 않는다.
   *
   * 잔량이 100%에 닿으면 회복분이 버려진다. 그 상태에서 생성하면 곧바로 다시 채워져
   * 소모가 흔적을 남기지 않는다. 보정으로는 복구할 수 없는 정보 손실이라 잘라내는 게 맞다.
   *
   * 두 가지를 오염으로 본다.
   *   1. 관측된 잔량이 100% 이상이던 구간
   *   2. 구간 길이가 그 시점의 여유분(100 - p)보다 길어, 중간에 가득 찼을 수밖에 없는 구간
   *      — 브라우저를 오래 꺼두면 그 사이 마크가 안 남으므로 이 검사가 유일한 단서다.
   */
  function contaminatedUntil(l, spp) {
    const marks = l.marks || [];
    const cur = l.current;
    if (!cur || !marks.length) return null;

    for (let i = marks.length - 1; i >= 0; i--) {
      const p = marks[i].p;
      const from = marks[i].t;
      const to = i + 1 < marks.length ? marks[i + 1].t : cur.t;
      const sec = (to - from) / 1000;
      const headroom = 100 - p;
      if (p >= 100 || sec / spp > headroom) return to;
    }
    return null;
  }

  /** Anlas가 나간 마지막 생성 **뒤**로 자를 시각.
   *
   *  그 생성이 하락을 만들었다면 그 하락은 다음 마크에 이미 반영돼 있으므로,
   *  다음 마크부터를 새 구간의 시작으로 삼으면 영향이 pStart 안으로 흡수된다(`settled`).
   *
   *  **다음 마크가 없다고 영원히 막으면 안 된다.** 마크는 퍼센트가 정수로 바뀔 때만 생기고
   *  1%p ≈ 17장이라, 그 전에는 몇 장을 더 뽑아도 마크가 안 생긴다. 그러면 경고가 붙박이가 된다
   *  (실제로 그렇게 만들었다). 그럴 때는 생성 시각에서 자르고 `settled: false`로 알린다 —
   *  그 생성의 영향이 아직 구간 안에 남아 있을 수 있다는 뜻이고, 화면에 그렇게 적는다. */
  function paidUntil(l) {
    const gens = l.gens || [];
    let last = null;
    for (let i = gens.length - 1; i >= 0; i--) {
      if (paidGen(gens[i])) { last = gens[i].t; break; }
    }
    if (last == null) return { t: null, settled: true };
    for (const m of l.marks || []) if (m.t > last) return { t: m.t, settled: true };
    // +1ms — 구간은 "이 시각 이후"라 그 생성 **자신**이 구간에 남으면 안 된다.
    return { t: last + 1, settled: false };
  }

  function analyze(l, windowImages) {
    const spp = l.spp && l.spp > 0 ? l.spp : DEFAULT_SPP;
    const cur = l.current;
    const all = l.gens || [];
    // 할당량을 쓸 수 없는 모델(V4.5)은 분모에서 뺀다. 표에는 흐리게 남는다.
    const gens = all.filter(countsForOpus);
    if (!cur || !gens.length) return { ok: false, reason: 'no-data' };

    const paid = paidUntil(l);
    const capCut = contaminatedUntil(l, spp);

    const pick = (cut) => {
      let images = 0;
      let startIdx = -1;
      let clamped = false;
      for (let i = gens.length - 1; i >= 0; i--) {
        if (cut != null && gens[i].t < cut) {
          clamped = true;
          break;
        }
        images += gens[i].n;
        startIdx = i;
        if (windowImages && images >= windowImages) break;
      }
      return { images, startIdx, clamped };
    };

    /* 과금 생성 뒤로 자르되, **잘라내니 아무것도 안 남으면 덜 자른다.**
     * 숫자를 통째로 감추는 것보다 "무엇이 섞였는지" 적어주는 편이 쓸모 있다. */
    const bothCut = paid.t == null ? capCut : capCut == null ? paid.t : Math.max(capCut, paid.t);
    let w = pick(bothCut);
    let paidMixed = false;
    if ((w.startIdx < 0 || w.images === 0) && paid.t != null) {
      w = pick(capCut);
      paidMixed = true;
    }
    if (w.startIdx < 0 || w.images === 0) return { ok: false, reason: 'capped' };

    const { images, startIdx, clamped } = w;
    const paidUnsettled = paid.t != null && !paid.settled && !paidMixed;

    const t0 = gens[startIdx].t;
    const pStart = percentAt(l, t0);
    if (pStart == null) return { ok: false, reason: 'no-mark' };

    const elapsedSec = Math.max(0, (cur.t - t0) / 1000);
    const refill = elapsedSec / spp; // 오염 구간을 잘라냈으므로 여기선 상한 걱정이 없다
    const consumed = pStart - cur.p + refill;

    const avg = images > 0 ? consumed / images : 0;
    const avgErr = images > 0 ? 1 / images : Infinity;
    /* 상대오차 = avgErr / avg = (1/n) / (consumed/n) = 1 / consumed.
     * **표본 수가 아니라 누적 하락량**이 정확도를 정한다는 뜻이다.
     * 예약 창(queue.js)도 같은 값을 쓴다 — 각자 다시 계산하면 두 화면이 다른 오차를 적는다. */
    const relative = consumed > 0 ? 1 / consumed : Infinity;

    /* Anlas 합은 **거르지 않은 전체**에서 낸다. 돈은 모델을 가리지 않고 나가므로,
     * Opus 평균에서 뺀 생성이라고 지출까지 빼면 합계가 실제 잔액 변화와 어긋난다. */
    let anlas = 0;
    let anlasUnknown = 0;
    for (const g of all) {
      if (g.t < t0) continue;
      if (Number.isFinite(g.cost)) anlas += g.cost;
      else anlasUnknown++;
    }

    return {
      ok: true,
      spp,
      t0,
      images,
      anlas,
      anlasUnknown,
      excluded: all.length - gens.length,
      pStart,
      pEnd: cur.p,
      elapsedSec,
      refill,
      clamped,
      paidMixed,
      paidUnsettled,
      consumed,
      avg,
      avgErr,
      relative,
      // 누적 하락이 MIN_CONSUMED 이하면 오차가 100%를 넘어 의미가 없다
      reliable: consumed > MIN_CONSUMED,
      /* 오차 ±10%(누적 10%p)까지 앞으로 몇 장이 더 필요한가. 0이면 이미 도달했다.
       * 사용량 창과 예약 창이 같은 문장을 쓰므로 계산은 여기 한 곳에서만 한다 —
       * avg가 0 이하인 구간(회복이 소모보다 컸다)에서는 답이 없으므로 null이다. */
      toTarget: avg > 0 ? Math.ceil(Math.max(0, TARGET_CONSUMED - consumed) / avg) : null,
      remainingImages: avg > 0.0001 ? cur.p / avg : null,
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
      const inWin = a.ok && g.t >= a.t0;
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
      const avgTxt = a.avg.toFixed(3) + '%';
      const sub = ['± ' + a.avgErr.toFixed(3) + '%p'];
      if (!a.reliable) {
        sub.push('누적 하락 ' + a.consumed.toFixed(2) + '%p — 아직 오차가 100%를 넘습니다');
      } else if (a.toTarget) {
        sub.push('오차 ±' + Math.round(a.relative * 100) + '% · ±10%까지 ' + a.toTarget + '장 더');
      }
      if (a.paidMixed) sub.push('Anlas 나간 생성이 섞여 있습니다');
      else if (a.paidUnsettled) sub.push('Anlas 나간 생성의 영향이 아직 눈금에 안 잡혔습니다');
      if (a.clamped) sub.push('이전 구간 제외');
      const avgSub = sub.join(' · ');

      stats =
        stat('현재 잔량', cur.p + '%', '정수 단위로만 관측됩니다') +
        anlasStat(a) +
        stat(
          '표본',
          a.images + '장',
          dur(a.elapsedSec) + ' 동안' +
            (a.clamped ? ' · 이전 구간 제외' : '') +
            (a.excluded ? ' · V4.5 ' + a.excluded + '건 제외' : '')
        ) +
        stat(
          '누적 소모',
          a.consumed.toFixed(2) + '%p',
          `${a.pStart}% → ${a.pEnd}% · 회복 +${a.refill.toFixed(1)}%p` +
            (a.consumed < 0 ? ' · 회복이 소모보다 커 음수' : ''),
          a.reliable ? '' : 'weak'
        ) +
        stat('장당 평균', avgTxt, avgSub, a.reliable ? 'good' : 'weak');
    }

    let est = '';
    if (a.ok && a.reliable && a.remainingImages) {
      est = `<p class="note">현재 잔량으로 <b>약 ${Math.round(a.remainingImages)}장</b> 더 생성할 수 있습니다.
             회복 속도는 1%당 ${dur(a.spp)} (하루 약 ${(86400 / a.spp).toFixed(1)}%).</p>`;
    } else if (a.ok) {
      est = `<p class="note">회복 속도는 1%당 ${dur(a.spp)} (하루 약 ${(86400 / a.spp).toFixed(1)}%).</p>`;
    }

    const gens = (ledger.gens || []).slice().reverse().slice(0, 60);
    const rows = gens.length
      ? gens
          .map((g) => {
            const p = percentAt(ledger, g.t);
            // 0과 "모름"은 다르다. 못 잰 것을 0으로 적으면 합계가 조용히 틀어진다.
            const cost = Number.isFinite(g.cost) ? (g.cost ? '−' + g.cost : '0') : '—';
            // 할당량을 안 쓴 생성은 흐리게. 숨기지는 않는다 — 돈은 실제로 나갔을 수 있다.
            const off = countsForOpus(g) && !paidGen(g) ? '' : ' class="off"';
            return `<tr${off}>
              <td class="t">${esc(stamp(g.t))}</td>
              <td class="n">${g.n}장</td>
              <td class="p">${p == null ? '—' : p + '%'}</td>
              <td class="a">${cost}</td>
              <td class="m">${esc(g.model || '')}</td>
            </tr>`;
          })
          .join('')
      : '<tr><td colspan="5" class="empty-row">아직 생성 기록이 없습니다.</td></tr>';

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
            <thead><tr><th>시각</th><th>장수</th><th>그때 잔량</th><th>Anlas</th><th>모델</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
      <p class="fine">NovelAI는 정수 퍼센트만 알려줍니다. 한 번의 생성이 얼마를 썼는지는 알 수 없고,
      여러 번의 하락을 생성 장수로 나눈 <b>평균</b>만 구할 수 있습니다.
      절단 오차는 쌓이지 않고 총합 ±1%p로 고정이라, 누적 하락이 클수록 평균이 정확해집니다.<br>
      <b>Anlas가 나간 생성은 평균에서 뺍니다</b> — 그 생성이 할당량까지 함께 깎았는지는 관측할 수 없어,
      가정하는 대신 그 이전 구간을 잘라냅니다.</p>`;

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
      transition: all .18s var(--ease);
    }
    .win-btn:hover { color: var(--ink); border-color: var(--hairline-2); }
    .win-btn[aria-selected="true"] {
      background: var(--accent-soft); color: var(--accent);
      border-color: var(--accent-line); font-weight: 600;
    }
    .wins-gap { flex: 1; }
    .win-btn.danger { color: var(--ink-3); }
    .win-btn.danger:hover {
      color: var(--danger);
      border-color: color-mix(in srgb, var(--danger) 40%, transparent);
      background: var(--danger-soft);
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
    td.n, td.p, td.a { font-family: var(--font-mono); font-size: 11px; white-space: nowrap; }
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
        <button class="win-btn danger" id="reset" title="쌓인 생성·잔량 기록을 모두 지웁니다">기록 지우기</button>
      </div>
      <div class="body" id="body"></div>`;

    root.append(style, win);
    document.documentElement.appendChild(host);

    root.getElementById('close').addEventListener('click', () => toggleOverlay(false));
    root.getElementById('reload').addEventListener('click', refresh);

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

  /* 예약 창(queue.js)이 소모량 예측에 같은 분석기와 같은 모델 판정을 쓴다.
   * 복사해 두면 오염 구간 판정이나 "V5만 깎는다"가 두 벌이 되어 조용히 갈라진다. */
  globalThis.NibUsage = { analyze, usesOpus };

  NibUI.watchTheme(() => host);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !host) return;
    if (changes[LEDGER_KEY]) refresh();
  });
})();
