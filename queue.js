/* Nib — 예약 생성 큐 (독립 모듈)
 *
 * 얼려둔 베이스 위에 세트마다 다른 프리셋을 얹어 순차로 생성한다.
 * 열기: 사이드 패널 → content.js 라우터 → globalThis.openQueue()
 *
 * ── 이 파일이 지키는 선 ────────────────────────────────────────────────
 *
 * 이용약관 §9.1.6은 자동화 자체가 아니라 **한도를 무시하거나 과부하를 주는** 자동화를 금한다.
 * 그래서 "사람이 클릭하는 것보다 부하가 크지 않다"를 구조로 증명한다.
 *
 *   - 동시 요청 없음. 언제나 1건. 이전 것이 끝나야 다음을 시작한다.
 *   - 딜레이는 **완료 시점부터** 잰다. 시작 기준 고정 주기는 서버가 느릴 때 요청이 겹친다.
 *   - 지터를 준다. 정확히 주기적인 신호가 봇 탐지의 1차 지표다.
 *   - **재시도하지 않는다.** 실패하면 즉시 멈춘다. 재시도 폭주가 진짜 어뷰징처럼 보인다.
 *   - API를 직접 부르지 않는다. **Generate 버튼을 클릭**한다.
 *     요청을 손으로 조립하는 순간 "클릭 대행"이라는 근거가 사라지고,
 *     NovelAI가 붙이는 파라미터를 우리가 흉내 내야 해서 틀리기도 쉽다.
 *   - 서비스 워커가 아니라 **탭에 붙어 산다.** 탭을 닫으면 함께 죽는다.
 *     사용자가 모르는 사이에 돌아가는 상태를 만들지 않는다.
 *
 * ── 실측으로 정한 값 ──────────────────────────────────────────────────
 *
 *   요청당 1장    **묶으면 안 된다.** Opus 무료는 요청당 한 장까지다 —
 *                 실측: 832×1216·16스텝 4장 요청 −60 Anlas, 같은 설정 1장 요청 0.
 *                 요청 수는 줄지만 돈이 나가므로 배칭은 이득이 아니다.
 *   장당 4.48초   localStorage의 image-gen-ms-per-step-megapixel(290.3) × steps × 메가픽셀
 *   200장 ≈ 310MB  이미지는 IndexedDB로 간다. JS 힙에 쌓이지 않고 캔버스는 화면 밖 타일을 컬링한다.
 *                 즉 200장은 기술적 한계가 아니라 **정책**이다 — 무인 25분이 경계선이라 봤다.
 *
 * NovelAI의 imageAutoDownload / persistImageGenHistory 설정은 **읽을 수 없다.**
 * jotai 모듈 스코프에 있어 파이버 순회로 안 잡힌다(566ms를 태우고 실패). 그래서 상태를 띄우는 대신
 * 50장을 넘기면 안내만 한다.
 */

(() => {
  const HOST_ID = 'nib-queue';
  const POS_KEY = 'nib.queuePos';
  const LIB_KEY = 'nib.library';
  const LEDGER_KEY = 'nib.ledger';
  const PLAN_KEY = 'nib.queuePlan';

  const MAX_SETS = 5;
  const MAX_TOTAL = 200;
  const MAX_PER_SET = 100;
  const WARN_AUTODL_OVER = 50;

  /* 1로 못 박는다. 올리면 첫 장 말고는 전부 Anlas가 나간다. */
  const BATCH_MAX = 1;
  /* 생성 자체가 장당 4.5초쯤 걸리므로 요청 간격은 그 시간이 정한다.
   * 딜레이는 "겹치지 않게" 하는 장치이지 속도 조절 장치가 아니다 —
   * 완료를 확인한 뒤에 세므로 0.4~0.9초면 충분하고, 사람이 연달아 누르는 간격과 비슷하다. */
  const DELAY_MS = 400;
  const JITTER_MS = 500;

  const OPUS_FLOOR = 10;
  const MAX_WALL_MS = 60 * 60 * 1000;
  const WATCHDOG_MULT = 3;
  const WATCHDOG_MIN_MS = 90000;

  /* page.js 에 같은 값이 있다. 그쪽은 MAIN world 라 서로를 못 읽어 어쩔 수 없는 사본이다 —
   * **한쪽만 고치면 예약 창이 "무료"라고 적어 둔 채로 돈이 나간다.** */
  const FREE_PIXELS = 1048576;
  const FREE_STEPS = 28;
  /* 장당 시간은 메가픽셀 단위로 잰다. 값이 FREE_PIXELS 와 같은 것은 우연이다 —
   * 무료 상한이 바뀌어도 1메가픽셀은 그대로 1메가픽셀이다. 뜻이 다르면 이름도 달라야 한다. */
  const MEGAPIXEL = 1024 * 1024;
  /* 큐가 돌 수 있는 모델. page.js 의 RECORD_MODEL 과 같아야 완료 신호(nib-gen)가 온다 —
   * 이것도 world 가 달라 생긴 사본이다. */
  const SUPPORTED_MODEL = /^nai-diffusion-(4-5|5)(-|$)/;

  let host = null;
  let root = null;

  const st = {
    base: null,
    sets: [],
    lib: { items: [] },
    ledger: null,
    live: { percent: null, anlas: null },
    run: null,
    msg: '',
    msgTone: '',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = NibUI.esc;
  const newId = () =>
    crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);

  /* ---------- 페이지에서 읽는 값 ---------- */

  function currentModel() {
    try {
      return JSON.parse(localStorage.getItem('imagegen-model') || 'null');
    } catch {
      return null;
    }
  }

  /** 얼려둔 베이스의 모델. 세 곳(예측·사전 점검·중단 판정)이 같은 값을 같은 모양으로 봐야 한다. */
  const baseModel = () => st.base?.params?.model || '';

  /** 베이스가 Opus 할당량을 쓰는 모델인가. **판정은 overlay.js 것을 쓴다**(NibUsage.usesOpus) —
   *  정규식을 여기 한 벌 더 두면 "V5만 깎는다"는 실측이 두 곳에 적히고 언젠가 한쪽만 고쳐진다.
   *  overlay.js 가 안 실렸으면 판정을 포기한다(예측을 안 내는 쪽이 틀린 예측보다 낫다). */
  const usesOpus = () => globalThis.NibUsage?.usesOpus(baseModel()) === true;

  function readParams() {
    const model = currentModel();
    try {
      const p = JSON.parse(localStorage.getItem('imagegen-params-' + model) || '{}');
      return {
        model,
        width: Number(p.width) || 0,
        height: Number(p.height) || 0,
        steps: Number(p.steps) || 0,
        n_samples: Number(p.n_samples) || 1,
      };
    } catch {
      return { model, width: 0, height: 0, steps: 0, n_samples: 1 };
    }
  }

  /* 보이는 것만 고른다. NovelAI는 모바일·데스크톱 레이아웃을 둘 다 마운트해 두고,
   * 안 보이는 쪽을 눌러도 아무 일이 안 난다. 판정은 content.js 에 한 벌만 있다. */
  const visible = (sel) => NibEngine.visibleAll(sel);

  /* 실측: 클래스는 `image-gen-generate-button`이고 **두 벌이 마운트돼 있다**(모바일 + 데스크톱).
   * 안 보이는 쪽을 누르면 아무 일도 안 일어난다 — visible()을 반드시 거쳐야 한다.
   * 클래스가 바뀔 때를 대비해 글자로 한 번 더 찾되, 글자는 언어 설정을 타므로 클래스가 먼저다. */
  function generateButton() {
    const byClass = visible('.image-gen-generate-button')[0];
    if (byClass) return byClass;
    const cands = visible('button').filter((b) => /generate/i.test(b.textContent));
    return cands.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0] || null;
  }

  const countBox = () => visible('.image-gen-image-count')[0] || null;

  /** 생성 중에는 버튼 글자가 바뀐다. 쉬는 상태의 첫 낱말을 기억해 두었다가 그 글자가 돌아오면 끝난 것으로 본다.
   *  disabled 만 보면, NovelAI가 버튼을 잠그는 대신 취소 버튼으로 바꿔치는 경우 **취소를 눌러버린다.** */
  const firstWord = (el) => String(el?.textContent || '').trim().split(/\s+/)[0] || '';

  /** 장수 조절. 클릭한 뒤 localStorage로 되읽어 확인한다 — 눌렀다고 바뀐 것은 아니다. */
  async function setImageCount(k) {
    if (readParams().n_samples === k) return true;
    const box = countBox();
    if (!box) return false;
    const btn = [...box.querySelectorAll('button')].find((b) => b.textContent.trim() === String(k));
    if (!btn) return false;
    btn.click();
    for (let i = 0; i < 12; i++) {
      await sleep(60);
      if (readParams().n_samples === k) return true;
    }
    return false;
  }

  /* ---------- 베이스 ---------- */

  /** 창을 여는 순간의 상태를 통째로 얼린다.
   *  텍스트는 **원문 그대로** 들고 있어야 한다. 태그 배열로 쪼개 보관하면 줄 구조가 사라져
   *  복원할 때 여러 줄 프롬프트가 한 줄로 뭉개진다. */
  function captureBase() {
    const s = NibEngine.readState();
    const slots = [
      { key: 'Base', target: { kind: 'base' }, text: s.base || '' },
      { key: 'UC', target: { kind: 'uc' }, text: s.uc || '' },
    ];
    for (const n of s.characters || []) {
      const c = (s.charTexts || [])[n - 1] || {};
      slots.push({ key: 'C' + n, target: { kind: 'char', index: n, uc: false }, text: c.prompt || '' });
      slots.push({ key: 'C' + n + ' UC', target: { kind: 'char', index: n, uc: true }, text: c.uc || '' });
    }
    return {
      onNovelAI: !!s.onNovelAI,
      chars: s.characters || [],
      slots,
      params: readParams(),
      active: activePresetIds(s),
      at: Date.now(),
    };
  }

  const normKeys = (text) => NibEngine.splitTags(text).map(NibEngine.normalizeTag);

  function textInState(s, target) {
    if (target.kind === 'base') return s.base || '';
    if (target.kind === 'uc') return s.uc || '';
    const c = (s.charTexts || [])[target.index - 1] || {};
    return (target.uc ? c.uc : c.prompt) || '';
  }

  const containsAll = (text, tagStr) => {
    const have = normKeys(text);
    const want = normKeys(tagStr);
    return want.length > 0 && want.every((t) => have.includes(t));
  };

  /** 지금 활성인 프리셋. 사이드 패널의 isActive와 같은 판정을 쓴다. */
  function activePresetIds(s) {
    const out = [];
    for (const it of st.lib.items || []) {
      const jobs = jobsFor(it, s.characters || [], 0);
      if (!jobs.length) continue;
      if (jobs.every((j) => containsAll(textInState(s, j.target), j.tags))) out.push(it.id);
    }
    return out;
  }

  /* ---------- 프리셋 → 작업 ---------- */

  /* 칸 스키마는 편집 창(editor.js)과 같은 것을 써야 한다 — shared-ui.js에 한 벌만 둔다. */
  const normalizeSlots = NibUI.normalizeSlots;

  /** 프리셋 하나가 만드는 작업들. charSlot은 캐릭터 대상 프리셋일 때만 쓴다. */
  function jobsFor(item, pageChars, charSlot) {
    const jobs = [];
    if (item?.multi === true) {
      const sl = normalizeSlots(item.slots);
      if (sl.base.trim()) jobs.push({ key: 'Base', target: { kind: 'base' }, tags: sl.base });
      if (sl.uc.trim()) jobs.push({ key: 'UC', target: { kind: 'uc' }, tags: sl.uc });
      sl.chars.forEach((text, i) => {
        const n = i + 1;
        if (!pageChars.includes(n)) return;
        const uc = sl.charUCs[i] || '';
        if (text.trim()) jobs.push({ key: 'C' + n, target: { kind: 'char', index: n, uc: false }, tags: text });
        if (uc.trim()) jobs.push({ key: 'C' + n + ' UC', target: { kind: 'char', index: n, uc: true }, tags: uc });
      });
      return jobs;
    }

    const tags = String(item?.tags || '');
    if (!tags.trim()) return jobs;
    if (item.target === 'uc') return [{ key: 'UC', target: { kind: 'uc' }, tags }];
    if (item.target === 'char' || item.target === 'charuc') {
      const n = charSlot || pageChars[0];
      if (!n || !pageChars.includes(n)) return jobs;
      const uc = item.target === 'charuc';
      return [{ key: 'C' + n + (uc ? ' UC' : ''), target: { kind: 'char', index: n, uc }, tags }];
    }
    return [{ key: 'Base', target: { kind: 'base' }, tags }];
  }

  const itemById = (id) => (st.lib.items || []).find((x) => x.id === id) || null;
  const isCharPreset = (it) => !it?.multi && (it?.target === 'char' || it?.target === 'charuc');

  function setJobs(set) {
    const chars = st.base?.chars || [];
    const out = [];
    for (const e of set.entries) {
      const it = itemById(e.presetId);
      if (!it) continue;
      out.push(...jobsFor(it, chars, e.charSlot));
    }
    return out;
  }

  /** 이 세트가 요구하지만 페이지에 없는 캐릭터 번호. */
  function missingChars(set) {
    const chars = st.base?.chars || [];
    const miss = new Set();
    for (const e of set.entries) {
      const it = itemById(e.presetId);
      if (!it) continue;
      if (it.multi === true) {
        const sl = normalizeSlots(it.slots);
        sl.chars.forEach((text, i) => {
          const uc = sl.charUCs[i] || '';
          if ((text.trim() || uc.trim()) && !chars.includes(i + 1)) miss.add(i + 1);
        });
      } else if (isCharPreset(it)) {
        const n = e.charSlot || chars[0];
        if (!n || !chars.includes(n)) miss.add(n || 1);
      }
    }
    return [...miss].sort((a, b) => a - b);
  }

  /* ---------- 예측 ---------- */

  const totalImages = () => st.sets.reduce((a, s) => a + (s.count || 0), 0);

  function batchCount() {
    let n = 0;
    for (const s of st.sets) {
      let r = s.count || 0;
      while (r > 0) {
        r -= Math.min(BATCH_MAX, r);
        n++;
      }
    }
    return n;
  }

  /** 이미지 한 장에 걸리는 시간(초). NovelAI가 스스로 재둔 값을 그대로 쓴다. */
  function perImageSeconds() {
    const p = st.base?.params || readParams();
    const mspm = Number(localStorage.getItem('image-gen-ms-per-step-megapixel')) || 300;
    const mp = (p.width * p.height) / MEGAPIXEL;
    return (mspm * p.steps * mp) / 1000;
  }

  function timeEstimate(total) {
    const perImage = perImageSeconds();
    const batches = batchCount();
    return {
      perImage,
      seconds: total * perImage + Math.max(0, batches - 1) * ((DELAY_MS + JITTER_MS / 2) / 1000),
      batches,
    };
  }

  /* Opus 예측. 상대오차 = avgErr/avg = (1/n)/(c/n) = 1/c 이므로 **표본 수가 아니라 누적 하락량**이
   * 정확도를 정한다. "몇 장 더"(toTarget)도 그 환산이라 analyze 가 이미 들고 있다. */
  function opusEstimate(total) {
    /* 분석기가 없으면 모델 판정도 못 한다. **"V4.5라서 0%"와 순서를 바꾸면 안 된다** —
       usesOpus 는 판정 실패도 false 로 돌려주므로, 먼저 물으면 "0%"라고 단정해 버린다. */
    if (!globalThis.NibUsage || !st.ledger) return { ok: false, why: '원장을 아직 못 읽었습니다' };
    // V4.5는 할당량을 안 쓴다. 예측을 낼 것이 아니라 0이라고 말해야 한다.
    if (!usesOpus()) return { ok: false, free: true };
    let a;
    try {
      a = NibUsage.analyze(st.ledger, 0);
    } catch {
      return { ok: false, why: '분석 실패' };
    }
    if (!a.ok) {
      return {
        ok: false,
        why:
          a.reason === 'capped' ? '잔량이 가득 차 있던 구간뿐입니다' : '생성 기록이 부족합니다',
      };
    }
    const drop = a.avg * total;
    return {
      ok: true,
      drop,
      relative: a.relative,
      consumed: a.consumed,
      reliable: a.reliable,
      // 오차 ±10%까지 몇 장이 더 필요한가. 낼 수 없으면 null — analyze 가 그렇게 준다.
      toTarget: a.toTarget,
      after: st.live.percent != null ? st.live.percent - drop : null,
    };
  }

  /** 이 크기·스텝이 무료 구간인가. 합계 칸과 베이스 칸이 같은 답을 써야 해서 한 곳에 둔다.
   *
   *  **page.js 의 expectFree 와 완전히 같지는 않다.** 그쪽은 캐릭터 레퍼런스가 붙었는지도
   *  보지만(`director_reference_images`), 그 값은 요청 본문에만 있고 localStorage 에는 없다 —
   *  얼려둔 베이스만 보는 여기서는 알 수 없다. 즉 **레퍼런스를 붙인 채 돌리면
   *  `무료 구간`이라고 적혀 있어도 실제로는 Anlas 가 나간다.**
   *  그래서 이 값은 표시용일 뿐이고, 실제 안전판은 잔액을 되읽는 guardStop 이다.
   *
   *  장수 조건(`요청당 1장`)은 따지지 않는다. 큐는 BATCH_MAX 가 1이라 언제나 충족된다. */
  const isFreeSize = (p) => p.width * p.height <= FREE_PIXELS && p.steps <= FREE_STEPS;

  /* Anlas는 예측이 아니라 계산이다 — 베이스가 얼어 있어 크기·스텝이 고정이기 때문이다.
   * 과금 구간이면 **서명이 같은** 표본만 쓴다. 크기가 다른 표본을 섞으면 평균이 거짓말이 된다. */
  function anlasEstimate(total) {
    const p = st.base?.params || readParams();
    if (isFreeSize(p)) return { kind: 'free', total: 0 };

    const sig = p.width + 'x' + p.height + 'x' + p.steps;
    const per = (st.ledger?.gens || [])
      .filter((g) => g.sig === sig && Number.isFinite(g.cost) && g.cost > 0 && g.n > 0)
      .map((g) => g.cost / g.n)
      .sort((x, y) => x - y);
    if (!per.length) return { kind: 'unknown' };
    const median = per[Math.floor(per.length / 2)];
    return { kind: 'known', per: median, total: Math.round(median * total), samples: per.length };
  }

  /* ---------- 사전 점검 ---------- */

  /** 시작 전 점검. 두 목록의 성격이 다르다 —
   *  errs 는 **바깥에서 흘러든 값**(모델 이름 · 캐릭터 번호)이 섞이므로 그리는 쪽에서 이스케이프한다.
   *  warns 는 여기서 쓴 문장뿐이라 강조 태그를 그대로 담는다. 섞어 쓰지 말 것. */
  function preflight() {
    const errs = [];
    const warns = [];
    const total = totalImages();

    if (!st.base?.onNovelAI) errs.push('NovelAI 이미지 생성 화면이 아닙니다.');
    if (!st.sets.length) errs.push('세트를 하나 이상 추가해 주세요.');
    if (st.sets.some((s) => !s.entries.length)) errs.push('프리셋이 비어 있는 세트가 있습니다.');
    if (st.sets.some((s) => !s.count || s.count < 1)) errs.push('장수가 0인 세트가 있습니다.');
    if (total > MAX_TOTAL) errs.push(`총 ${total}장 — 상한 ${MAX_TOTAL}장을 넘습니다.`);

    const model = baseModel();
    if (!SUPPORTED_MODEL.test(model)) {
      errs.push(`V4.5 · V5 모델만 됩니다(지금 ${model || '알 수 없음'}). 진행 상황을 셀 수 없어 시작하지 않습니다.`);
    }
    if (!generateButton()) errs.push('Generate 버튼을 찾지 못했습니다.');
    if (!countBox()) errs.push('장수(Number of Images) 조절 칸을 찾지 못했습니다. 사이드바가 접혀 있지는 않은지 확인해 주세요.');

    for (const [i, s] of st.sets.entries()) {
      const miss = missingChars(s);
      if (miss.length) errs.push(`${i + 1}세트: 캐릭터 ${miss.join(', ')}번이 NovelAI에 없습니다.`);
      if (!setJobs(s).length) errs.push(`${i + 1}세트: 적용할 내용이 없습니다.`);
    }

    if (total > WARN_AUTODL_OVER) {
      warns.push(
        `${total}장은 한 번에 오래 돕니다. NovelAI 설정에서 <b>Auto Download</b>를 켜두세요 — ` +
          '탭이 죽으면 화면 배치가 디스크에 안 남아 결과를 되찾지 못합니다.'
      );
    }
    if (usesOpus() && st.live.percent != null && st.live.percent < OPUS_FLOOR + 5) {
      warns.push(`Opus 잔량이 ${st.live.percent}%입니다. ${OPUS_FLOOR}%에 닿으면 자동으로 멈춥니다.`);
    }
    return { errs, warns };
  }

  /* ---------- 실행 ---------- */

  function waitForGeneration(timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      // 이름을 finish로 두면 큐를 마무리하는 바깥 finish()를 가린다.
      const settle = (r) => {
        if (done) return;
        done = true;
        window.removeEventListener('message', onMsg);
        clearTimeout(timer);
        resolve(r);
      };
      const onMsg = (e) => {
        if (e.source !== window) return;
        const d = e.data;
        if (!d || typeof d.__nib !== 'string') return;
        if (d.__nib === 'nib-gen') settle({ ok: true });
        else if (d.__nib === 'nib-genfail') settle({ ok: false, status: d.status });
      };
      const timer = setTimeout(() => settle({ ok: false, timeout: true }), timeoutMs);
      window.addEventListener('message', onMsg);
    });
  }

  async function waitFor(fn, timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (st.run?.cancel) return false;
      try {
        if (fn()) return true;
      } catch {}
      await sleep(150);
    }
    return false;
  }

  /** 한 배치 = 클릭 한 번 = 이미지 k장. */
  async function runBatch(k) {
    const btn = generateButton();
    if (!btn) return { ok: false, why: 'Generate 버튼이 사라졌습니다.' };
    if (btn.disabled || (st.run.idleWord && firstWord(btn) !== st.run.idleWord)) {
      const freed = await waitFor(() => {
        const b = generateButton();
        return b && !b.disabled && (!st.run.idleWord || firstWord(b) === st.run.idleWord);
      }, 20000);
      if (!freed) return { ok: false, why: 'Generate 버튼이 아직 쉬는 상태가 아닙니다.' };
    }

    const est = perImageSeconds() * k * 1000;
    const watchdog = Math.max(WATCHDOG_MIN_MS, est * WATCHDOG_MULT);

    // 기다리기를 **먼저** 걸고 나서 누른다. 순서를 바꾸면 빠른 응답을 놓친다.
    const wait = waitForGeneration(watchdog);
    generateButton()?.click();
    const r = await wait;

    if (!r.ok) {
      if (r.timeout) return { ok: false, why: '응답이 없어 멈췄습니다. NovelAI 화면을 확인해 주세요.' };
      return { ok: false, why: `생성이 실패했습니다 (HTTP ${r.status || '연결 실패'}).` };
    }

    // 응답만 보면 이미지가 앉기 전에 다음 클릭이 나간다. 버튼이 쉬는 상태로 돌아올 때까지 기다린다.
    await waitFor(() => {
      const b = generateButton();
      return b && !b.disabled && (!st.run.idleWord || firstWord(b) === st.run.idleWord);
    }, 30000);
    return { ok: true };
  }

  /** 세트 하나를 화면에 앉힌다. 앞 세트를 빼서 되돌리지 않는다 — 바닥을 다시 깔고 그 위에 올린다.
   *
   *  `remove`로 되돌리면 세 가지가 조용히 틀어진다.
   *    - 두 세트가 같은 태그를 공유하면 뒤 세트 것까지 빠진다
   *    - NovelAI가 자동으로 넣는 girl/boy가 판정에 섞인다
   *    - 한 번 실패하면 그 뒤 모든 세트가 오염된 채 진행된다 */
  async function applySet(set) {
    const now = NibEngine.readState();

    // 1) 바닥 다시 깔기 — 지금 값이 베이스와 다른 칸만 쓴다. 같은 칸을 다시 쓸 이유가 없다.
    for (const slot of st.base.slots) {
      if (st.run?.cancel) return { ok: false, why: '취소했습니다.' };
      const cur = textInState(now, slot.target).trim();
      if (cur === String(slot.text).trim()) continue;
      const r = await NibEngine.applyTags(slot.target, slot.text, 'replace');
      if (!r?.ok) return { ok: false, why: `${slot.key} 칸을 베이스로 되돌리지 못했습니다.` };
    }

    // 2) 프리셋 주입 — toggle이 아니라 add다. toggle은 이미 있는 태그를 만나면 빼버린다.
    for (const job of setJobs(set)) {
      if (st.run?.cancel) return { ok: false, why: '취소했습니다.' };
      const r = await NibEngine.applyTags(job.target, job.tags, 'add');
      if (!r?.ok) return { ok: false, why: `${job.key} 칸에 프리셋을 넣지 못했습니다.` };
    }

    // 3) 되읽어 검증 — 하나라도 어긋나면 생성하지 않는다. 잘못된 그림을 만드는 것이 더 나쁘다.
    const after = NibEngine.readState();
    for (const job of setJobs(set)) {
      if (!containsAll(textInState(after, job.target), job.tags)) {
        return { ok: false, why: `${job.key} 칸 확인에 실패했습니다. 화면을 확인해 주세요.` };
      }
    }
    return { ok: true };
  }

  function guardStop(remainingTotal) {
    // V4.5는 할당량을 안 쓰므로 잔량을 볼 이유가 없다.
    const opus = usesOpus();
    if (opus && st.live.percent != null && st.live.percent < OPUS_FLOOR) {
      return `Opus 잔량 ${st.live.percent}% — 중단선 ${OPUS_FLOOR}%에 닿아 멈췄습니다.`;
    }
    if (Date.now() - st.run.startedAt > MAX_WALL_MS) return '60분을 넘겨 멈췄습니다.';

    // Anlas 안전판: 지금까지의 실측 단가로 남은 장수를 못 채우면 그 자리에서 멈춘다.
    const startA = st.run.anlasStart;
    const nowA = st.live.anlas;
    if (Number.isFinite(startA) && Number.isFinite(nowA) && st.run.doneTotal > 0) {
      const spent = startA - nowA;
      if (spent > 0) {
        const per = spent / st.run.doneTotal;
        if (per * remainingTotal > nowA) {
          return `남은 Anlas ${nowA}로는 남은 ${remainingTotal}장을 채울 수 없어 멈췄습니다.`;
        }
      }
    }
    return null;
  }

  /** 취소는 두 곳(시작 버튼 · 닫기)에서 들어온다. 문구도 다시 그리기도 여기 한 벌만 둔다 —
   *  갈라져 있던 시절에는 닫기로 취소하면 안내가 화면에 안 나타났다. */
  function cancelRun() {
    if (!st.run) return;
    st.run.cancel = true;
    say('취소하는 중… 진행 중인 생성은 끝까지 둡니다.', '');
    render();
  }

  async function start() {
    const { errs } = preflight();
    // 버튼은 막혀 있지만, 그리고 나서 화면이 바뀌었을 수 있다. 이유는 말해주고 멈춘다.
    if (errs.length) {
      say(errs[0], 'bad');
      render();
      return;
    }

    st.run = {
      setIdx: 0,
      doneInSet: 0,
      doneTotal: 0,
      startedAt: Date.now(),
      cancel: false,
      anlasStart: st.live.anlas,
      origCount: readParams().n_samples,
      idleWord: firstWord(generateButton()),
    };
    say('', '');
    render();

    let stopped = null;
    const total = totalImages();

    for (let si = 0; si < st.sets.length && !stopped; si++) {
      const set = st.sets[si];
      st.run.setIdx = si;
      st.run.doneInSet = 0;
      render();

      const applied = await applySet(set);
      if (!applied.ok) {
        stopped = applied.why;
        break;
      }

      let remaining = set.count;
      while (remaining > 0) {
        if (st.run.cancel) {
          stopped = '취소했습니다.';
          break;
        }
        const g = guardStop(total - st.run.doneTotal);
        if (g) {
          stopped = g;
          break;
        }

        const k = Math.min(BATCH_MAX, remaining);
        if (!(await setImageCount(k))) {
          stopped = `장수를 ${k}로 바꾸지 못했습니다.`;
          break;
        }

        const r = await runBatch(k);
        if (!r.ok) {
          stopped = r.why;
          break;
        }

        remaining -= k;
        st.run.doneInSet += k;
        st.run.doneTotal += k;
        render();

        const last = remaining === 0 && si === st.sets.length - 1;
        if (!last) await sleep(DELAY_MS + Math.random() * JITTER_MS);
      }
    }

    await finish(stopped);
  }

  /** 끝나든 멈추든 화면을 원래대로 돌려놓는다. 큐를 돌리기 전과 같은 상태여야 한다. */
  async function finish(stopped) {
    const done = st.run?.doneTotal || 0;
    try {
      if (st.run?.origCount) await setImageCount(st.run.origCount);
      for (const slot of st.base.slots) {
        const cur = textInState(NibEngine.readState(), slot.target).trim();
        if (cur !== String(slot.text).trim()) {
          await NibEngine.applyTags(slot.target, slot.text, 'replace');
        }
      }
    } catch {}
    st.run = null;
    say(stopped ? `${done}장에서 멈췄습니다 — ${stopped}` : `${done}장을 모두 마쳤습니다.`, stopped ? 'bad' : 'good');
    render();
  }

  /* ---------- 창 ---------- */

  const CSS =
    NibUI.shellCSS('560px') +
    `
    .foot {
      display: flex; align-items: center; gap: 8px; flex: 0 0 auto;
      padding: 11px 13px; background: var(--shell);
      border-top: 1px solid var(--hairline);
    }
    .btn {
      font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
      padding: 7px 14px; border-radius: var(--r-ctl);
      border: 1px solid var(--hairline-2); background: var(--surface); color: var(--ink-2);
      transition: background-color .18s var(--ease), color .18s var(--ease);
    }
    .btn:hover { background: var(--raised); color: var(--ink); }
    .btn.accent { background: var(--accent); border-color: var(--accent); color: var(--accent-on); }
    .btn.accent:hover { background: var(--accent-hi); color: var(--accent-on); }
    .btn:disabled { opacity: .45; cursor: not-allowed; }
    .btn.danger { color: var(--danger); border-color: var(--hairline); background: transparent; }

    .sec { padding: 13px; border-bottom: 1px solid var(--hairline); }
    .sec:last-child { border-bottom: 0; }
    .lab {
      display: flex; align-items: center; gap: 7px; margin-bottom: 9px;
      font-family: var(--font-mono); font-size: 10px; font-weight: 600;
      letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3);
    }
    .lock {
      font-size: 9px; letter-spacing: .05em; padding: 1px 5px;
      border-radius: var(--r-chip); color: var(--accent-hi);
      border: 1px solid var(--accent-line); background: var(--accent-soft);
    }

    .brow { display: grid; grid-template-columns: 66px 1fr; gap: 8px; align-items: start; margin-bottom: 5px; }
    .brow .k { font-family: var(--font-mono); font-size: 10.5px; color: var(--ink-3); padding-top: 4px; }
    .brow .v {
      background: var(--sunken); border: 1px solid var(--hairline); border-radius: var(--r-ctl);
      padding: 5px 9px; font-size: 11.5px; color: var(--ink-2); line-height: 1.5;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .brow .v.wrap { white-space: normal; overflow: visible; }
    .brow .v:empty::before { content: '(비어 있음)'; color: var(--ink-3); }

    .chips { display: flex; flex-wrap: wrap; gap: 4px; }
    .chip {
      font-size: 11px; padding: 2px 7px; border-radius: var(--r-chip);
      border: 1px solid var(--hairline-2); background: var(--surface); color: var(--ink-2);
      display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
    }
    .chip.on { border-color: var(--accent-line); background: var(--accent-soft); color: var(--accent-hi); }
    .chip .x { cursor: pointer; color: var(--ink-3); font-size: 12px; line-height: 1; }
    .chip .x:hover { color: var(--danger); }
    .chip select {
      font: inherit; font-size: 10px; padding: 0 2px; border-radius: 3px;
      border: 1px solid var(--hairline-2); background: var(--canvas); color: var(--ink-2);
    }

    .set {
      display: grid; grid-template-columns: 20px 1fr auto; gap: 0 9px; align-items: start;
      padding: 9px 10px; margin-bottom: 6px;
      border: 1px solid var(--hairline); border-radius: var(--r-card); background: var(--surface);
    }
    .set.running { border-color: var(--accent-line); background: var(--accent-soft); }
    .set.done { opacity: .5; }
    .set .n { font-family: var(--font-mono); font-size: 10.5px; font-weight: 600; color: var(--ink-3); padding-top: 4px; }
    .set .right { display: flex; align-items: center; gap: 5px; }
    .set input[type=number] {
      font: inherit; font-size: 12px; width: 52px; text-align: right;
      padding: 4px 6px; border-radius: var(--r-ctl);
      border: 1px solid var(--hairline-2); background: var(--canvas); color: var(--ink);
    }
    .set select.add {
      font: inherit; font-size: 11px; max-width: 148px; margin-top: 5px;
      padding: 3px 5px; border-radius: var(--r-ctl);
      border: 1px dashed var(--hairline-2); background: transparent; color: var(--ink-3);
    }
    .bar { height: 3px; border-radius: 2px; background: var(--sunken); overflow: hidden; margin-top: 6px; }
    .bar i { display: block; height: 100%; background: var(--accent); }

    .totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(104px, 1fr)); gap: 6px; }
    .tot { background: var(--sunken); border: 1px solid var(--hairline); border-radius: var(--r-ctl); padding: 7px 9px; }
    .tot .l { display: block; font-family: var(--font-mono); font-size: 9.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); }
    .tot .v { display: block; font-family: var(--font-mono); font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 2px; }
    .tot .v.good { color: var(--good); }
    .tot .v.weak { color: var(--ink-3); font-size: 12px; }
    .tot .s { display: block; font-size: 10.5px; color: var(--ink-3); margin-top: 2px; line-height: 1.45; }

    .note {
      display: grid; grid-template-columns: auto 1fr; gap: 0 8px;
      border-radius: var(--r-ctl); padding: 8px 10px; margin-top: 8px;
      font-size: 11.5px; line-height: 1.55;
      background: var(--sunken); border: 1px solid var(--warn); color: var(--ink);
    }
    .note.bad { border-color: var(--danger); background: var(--danger-soft); }
    .note .t {
      font-family: var(--font-mono); font-size: 9.5px; font-weight: 600;
      letter-spacing: .08em; text-transform: uppercase; color: var(--warn); padding-top: 2px;
    }
    .note.bad .t { color: var(--danger); }

    .msg { font-size: 11.5px; font-weight: 500; }
    .msg.bad { color: var(--danger); }
    .msg.good { color: var(--good); }
    .empty { font-size: 12px; color: var(--ink-3); padding: 6px 0; }
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
        ${NibUI.markSVG('qu')}
        <span class="title">Nib · 예약 생성</span>
        <span class="spacer"></span>
        <button class="hbtn" id="close" title="닫기 (Esc)">✕</button>
      </div>
      <div class="body" id="body"></div>
      <div class="foot">
        <button type="button" class="btn accent" id="start">시작</button>
        <button type="button" class="btn" id="addset">세트 추가</button>
        <span class="msg" id="msg"></span>
        <span class="spacer"></span>
        <span class="msg" id="hint" style="color:var(--ink-3);font-weight:400"></span>
      </div>`;

    root.append(style, win);
    document.documentElement.appendChild(host);

    root.getElementById('close').addEventListener('click', close);
    root.getElementById('start').addEventListener('click', onStartClick);
    root.getElementById('addset').addEventListener('click', addSet);
    root.getElementById('body').addEventListener('click', onBodyClick);
    root.getElementById('body').addEventListener('change', onBodyChange);

    NibUI.makeDraggable(win, root.getElementById('head'), POS_KEY);
    NibUI.restorePosition(win, POS_KEY, () => ({
      x: Math.max(10, Math.round((window.innerWidth - 560) / 2)),
      y: 56,
    }));
    NibUI.syncTheme(host);
  }

  const say = (text, tone) => {
    st.msg = text;
    st.msgTone = tone || '';
  };

  /* ---------- 그리기 ---------- */

  const fmtDur = (sec) => {
    if (!Number.isFinite(sec) || sec < 0) return '—';
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return m ? `${m}분 ${s}초` : `${s}초`;
  };

  const presetLabel = (it) => (it.emoji ? it.emoji + ' ' : '') + it.name;

  function renderBase() {
    const b = st.base;
    const p = b.params;
    const free = isFreeSize(p);
    const rows = b.slots
      .filter((s) => s.key === 'Base' || s.key === 'UC' || s.text.trim())
      .map((s) => `<div class="brow"><span class="k">${esc(s.key)}</span><span class="v">${esc(s.text)}</span></div>`)
      .join('');

    const act = b.active
      .map((id) => itemById(id))
      .filter(Boolean)
      .map((it) => `<span class="chip on">${esc(presetLabel(it))}</span>`)
      .join('');

    return `
      <div class="sec">
        <div class="lab">베이스 <span class="lock">읽기 전용</span></div>
        ${rows}
        <div class="brow"><span class="k">활성 프리셋</span><span class="v wrap">${
          act ? `<span class="chips">${act}</span>` : '<span style="color:var(--ink-3)">없음</span>'
        }</span></div>
        <div class="brow"><span class="k">설정</span><span class="v">${esc(p.model || '?')} · ${p.width}×${p.height} · ${
          p.steps
        } steps · ${free ? '<span style="color:var(--good)">무료 구간</span>' : '<span style="color:var(--warn)">과금 구간</span>'}</span></div>
      </div>`;
  }

  function renderSets() {
    const chars = st.base.chars;
    const opts = (st.lib.items || [])
      .slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko'))
      .map((it) => `<option value="${esc(it.id)}">${esc(presetLabel(it))}</option>`)
      .join('');

    const rows = st.sets
      .map((s, i) => {
        const running = st.run && st.run.setIdx === i;
        const done = st.run && st.run.setIdx > i;
        const cls = running ? ' running' : done ? ' done' : '';
        const chips = s.entries
          .map((e, j) => {
            const it = itemById(e.presetId);
            if (!it) return '';
            const sel =
              isCharPreset(it) && chars.length > 1
                ? `<select data-set="${i}" data-entry="${j}" class="slot">${chars
                    .map((n) => `<option value="${n}"${n === (e.charSlot || chars[0]) ? ' selected' : ''}>C${n}</option>`)
                    .join('')}</select>`
                : '';
            const x = st.run ? '' : `<span class="x" data-del="${i}.${j}" title="빼기">✕</span>`;
            return `<span class="chip">${esc(presetLabel(it))}${sel}${x}</span>`;
          })
          .join('');

        const prog = running
          ? `<div class="bar"><i style="width:${Math.round((st.run.doneInSet / Math.max(1, s.count)) * 100)}%"></i></div>`
          : '';

        const right = st.run
          ? `<span style="font-family:var(--font-mono);font-size:11px;color:var(--ink-3)">${
              running ? `${st.run.doneInSet} / ${s.count}` : done ? '완료' : `${s.count}장`
            }</span>`
          : `<input type="number" min="1" max="${MAX_PER_SET}" value="${s.count}" data-count="${i}">
             <button type="button" class="btn danger" data-delset="${i}" style="padding:4px 8px">✕</button>`;

        return `
          <div class="set${cls}">
            <span class="n">${i + 1}</span>
            <div>
              <div class="chips">${chips || '<span style="color:var(--ink-3);font-size:11px">프리셋을 고르세요</span>'}</div>
              ${st.run ? '' : `<select class="add" data-add="${i}"><option value="">＋ 프리셋 추가…</option>${opts}</select>`}
              ${prog}
            </div>
            <div class="right">${right}</div>
          </div>`;
      })
      .join('');

    return `
      <div class="sec">
        <div class="lab">세트 <span style="letter-spacing:0;text-transform:none;font-size:10.5px">${st.sets.length} / ${MAX_SETS}</span></div>
        ${rows || '<div class="empty">아래 <b>세트 추가</b>로 시작하세요.</div>'}
      </div>`;
  }

  function renderTotals(check) {
    const total = totalImages();
    const t = timeEstimate(total);
    const o = opusEstimate(total);
    const a = anlasEstimate(total);

    const opusV = o.free
      ? `<span class="v good">0%</span><span class="s">V4.5는 할당량을 쓰지 않습니다</span>`
      : !o.ok
        ? `<span class="v weak">—</span><span class="s">${esc(o.why)}</span>`
        : `<span class="v">−${o.drop.toFixed(1)}%</span><span class="s">±${Math.round(o.relative * 100)}%${
            o.after != null ? ` · ${st.live.percent}% → ${Math.max(0, o.after).toFixed(0)}%` : ''
          }</span>`;

    const anlasV =
      a.kind === 'free'
        ? `<span class="v good">0</span><span class="s">무료 조건 충족</span>`
        : a.kind === 'known'
          ? `<span class="v">−${a.total}</span><span class="s">장당 ${a.per.toFixed(1)} · 표본 ${a.samples}건</span>`
          : `<span class="v weak">알 수 없음</span><span class="s">이 크기·스텝의 실측 표본 없음</span>`;

    const { errs, warns } = check;
    let notes = '';
    if (o.ok && !o.reliable) {
      /* toTarget 이 null 인 구간(회복이 소모보다 커서 avg 가 0 이하)에서는 장수를 낼 수 없다.
         숫자를 지어내지 말고 그 자리만 말로 바꾼다 — 예전에는 `Infinity장`이 찍혔다. */
      const more = o.toTarget != null ? `약 <b>${o.toTarget}장</b>의 실측이` : '실측이 조금 더';
      notes += `<div class="note"><span class="t">표본</span><div>Opus 예측은 누적 하락 <b>${o.consumed.toFixed(
        2
      )}%p</b>에서 낸 값이라 <b>±${Math.round(
        o.relative * 100
      )}%</b> 틀릴 수 있습니다. 오차 ±10%까지 ${more} 더 필요합니다 — 이번 큐가 그 표본을 채웁니다.</div></div>`;
    }
    if (a.kind === 'unknown') {
      notes += `<div class="note"><span class="t">Anlas</span><div>이 설정으로 과금된 표본이 없어 총액을 계산하지 않았습니다. 첫 장을 생성하면 실측 단가가 잡히고, <b>남은 잔액으로 못 채울 상황이면 그 자리에서 멈춥니다.</b></div></div>`;
    }
    // warns 는 preflight 가 쓴 문장뿐이라 강조 태그를 살린다. errs 는 바깥 값이 섞이므로 escape 한다.
    for (const w of warns) notes += `<div class="note"><span class="t">확인</span><div>${w}</div></div>`;
    for (const e of errs) notes += `<div class="note bad"><span class="t">막힘</span><div>${esc(e)}</div></div>`;

    return `
      <div class="sec">
        <div class="lab">합계</div>
        <div class="totals">
          <div class="tot"><span class="l">총 장수</span><span class="v">${total}</span><span class="s">요청 ${t.batches}회 · 한 장씩</span></div>
          <div class="tot"><span class="l">예상 시간</span><span class="v">${esc(fmtDur(t.seconds))}</span><span class="s">장당 ${t.perImage.toFixed(
            1
          )}s + 딜레이 ${(DELAY_MS / 1000).toFixed(1)}s</span></div>
          <div class="tot"><span class="l">Opus</span>${opusV}</div>
          <div class="tot"><span class="l">Anlas</span>${anlasV}</div>
        </div>
        ${notes}
      </div>`;
  }

  function render() {
    if (!root || !st.base) return;
    const check = preflight();
    root.getElementById('body').innerHTML = renderBase() + renderSets() + renderTotals(check);

    const running = !!st.run;
    const { errs } = check;
    const startBtn = root.getElementById('start');
    startBtn.textContent = running ? '취소' : '시작';
    startBtn.className = running ? 'btn danger' : 'btn accent';
    startBtn.disabled = !running && errs.length > 0;
    root.getElementById('addset').disabled = running || st.sets.length >= MAX_SETS;

    const msg = root.getElementById('msg');
    msg.textContent = st.msg;
    msg.className = 'msg ' + st.msgTone;

    root.getElementById('hint').textContent = running
      ? `${st.run.doneTotal} / ${totalImages()}장`
      : `잔량 ${OPUS_FLOOR}% 도달 시 자동 중단`;

    NibUI.clampIntoView(root.querySelector('.win'));
  }

  /* ---------- 조작 ---------- */

  function addSet() {
    if (st.sets.length >= MAX_SETS) return;
    st.sets.push({ id: newId(), entries: [], count: 4 });
    savePlan();
    render();
  }

  function onBodyClick(e) {
    if (st.run) return;
    const del = e.target.closest('[data-del]');
    if (del) {
      const [i, j] = del.dataset.del.split('.').map(Number);
      st.sets[i].entries.splice(j, 1);
      savePlan();
      return render();
    }
    const ds = e.target.closest('[data-delset]');
    if (ds) {
      st.sets.splice(Number(ds.dataset.delset), 1);
      savePlan();
      return render();
    }
  }

  function onBodyChange(e) {
    if (st.run) {
      // 실행 중에는 세트를 못 고친다. 화면만 되돌린다.
      return render();
    }
    const add = e.target.closest('[data-add]');
    if (add && add.value) {
      const i = Number(add.dataset.add);
      st.sets[i].entries.push({ presetId: add.value, charSlot: st.base.chars[0] || 1 });
      savePlan();
      return render();
    }
    const cnt = e.target.closest('[data-count]');
    if (cnt) {
      const i = Number(cnt.dataset.count);
      st.sets[i].count = Math.max(1, Math.min(MAX_PER_SET, Number(cnt.value) || 1));
      savePlan();
      return render();
    }
    const slot = e.target.closest('select.slot');
    if (slot) {
      st.sets[Number(slot.dataset.set)].entries[Number(slot.dataset.entry)].charSlot = Number(slot.value);
      savePlan();
      return render();
    }
  }

  function onStartClick() {
    if (st.run) return cancelRun();
    start();
  }

  /* ---------- 저장 ---------- */

  function savePlan() {
    const plan = st.sets.map((s) => ({ entries: s.entries, count: s.count }));
    chrome.storage.local.set({ [PLAN_KEY]: plan }).catch(() => {});
  }

  async function loadPlan() {
    try {
      const got = await chrome.storage.local.get(PLAN_KEY);
      const plan = got[PLAN_KEY];
      if (!Array.isArray(plan)) return;
      st.sets = plan.slice(0, MAX_SETS).map((s) => ({
        id: newId(),
        entries: Array.isArray(s.entries) ? s.entries.filter((e) => itemById(e.presetId)) : [],
        count: Math.max(1, Math.min(MAX_PER_SET, Number(s.count) || 1)),
      }));
    } catch {}
  }

  /* ---------- 살아 있는 수치 ---------- */

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__nib !== 'nib-usage') return;
    if (typeof d.percent === 'number') st.live.percent = d.isNegative ? -Math.abs(d.percent) : d.percent;
    if (Number.isFinite(d.anlas)) st.live.anlas = d.anlas;
  });

  async function loadLedger() {
    try {
      const res = await chrome.runtime.sendMessage({ cmd: 'ledger.get' });
      if (res?.ok) {
        st.ledger = res.ledger;
        if (res.ledger?.current && st.live.percent == null) st.live.percent = res.ledger.current.p;
        if (res.ledger?.anlas && st.live.anlas == null) st.live.anlas = res.ledger.anlas.v;
      }
    } catch {}
  }

  /* ---------- 열고 닫기 ---------- */

  async function openQueue() {
    if (host) {
      close();
      return;
    }
    if (!globalThis.NibEngine) {
      console.warn('[Nib] 엔진이 없습니다. 페이지를 새로고침해 주세요.');
      return;
    }

    try {
      const got = await chrome.storage.local.get(LIB_KEY);
      const lib = got[LIB_KEY] || {};
      st.lib = { items: Array.isArray(lib.items) ? lib.items : [] };
    } catch {
      st.lib = { items: [] };
    }

    st.base = captureBase();
    await loadPlan();
    await loadLedger();
    say('', '');

    build();
    render();
    document.addEventListener('keydown', onKey, true);
  }

  function onKey(e) {
    if (e.key === 'Escape' && host && !st.run) {
      e.stopPropagation();
      close();
    }
  }

  function close() {
    // 도는 중에는 창을 닫지 않는다. 닫기는 곧 취소이고, 되돌리기는 큐가 스스로 한다.
    if (st.run) return cancelRun();
    document.removeEventListener('keydown', onKey, true);
    if (host) host.remove();
    host = null;
    root = null;
  }

  globalThis.openQueue = openQueue;

  NibUI.watchTheme(() => host);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !host) return;
    if (changes[LEDGER_KEY]) {
      st.ledger = changes[LEDGER_KEY].newValue;
      if (!st.run) render();
    }
  });
})();
