/* Nib — 페이지 컨텍스트(MAIN world) 수집기
 *
 * 왜 여기 있나:
 *   콘텐츠 스크립트는 격리된 JS 컨텍스트라 (a) 페이지가 DOM 노드에 붙여둔 React 내부 속성과
 *   (b) 페이지의 window.fetch 를 건드릴 수 없다. 둘 다 필요해서 이 파일만 MAIN world에서 돈다.
 *
 * 무엇을 보내나 (window.postMessage → content.js):
 *   1. nib-usage : { percent, timeUntilNextPercent, isNegative, anlas }
 *   2. nib-gen   : { id, at, images, model, free, ref, sig }   성공한 생성 요청 하나
 *   3. nib-anlas : { id, cost, before, after }            그 생성의 Anlas 차감액
 *   4. nib-genfail : { status }                           실패한 생성 (예약 큐가 멈추는 신호)
 *
 * 사용량에 대해 확인된 사실:
 *   percent 는 정수로만 내려온다. timeUntilNextPercent 는 카운트다운이 아니라
 *   "1%를 회복하는 데 걸리는 초"다. 한때 7888(하루 10.95%)이었고 2026-09-23 현재 6048
 *   (100%까지 정확히 7일 — 공지의 "약 일주일")이다. 값이 바뀌므로 background.js가 마크마다 남긴다.
 *   1% 미만 잔량은 알 수 없고, 장당 소모량은 여러 번의 정수 하락과
 *   그 사이 생성을 나눠서 추정해야 한다. 계산은 overlay.js가 한다.
 */

(() => {
  const USAGE_TAG = 'nib-usage';
  const GEN_TAG = 'nib-gen';
  const ANLAS_TAG = 'nib-anlas';
  const FAIL_TAG = 'nib-genfail';
  const POLL_MS = 5000;
  const MAX_FIBERS = 8000;
  const MAX_HOOKS = 15; // 컴포넌트 하나의 훅 사슬을 이만큼만 따라간다
  const SCAN_DEPTH = 3; // props·훅 상태를 이 깊이까지만 판다

  /* 생성 뒤 Anlas 잔액이 갱신되기까지 기다렸다 재는 지점(ms).
   * 첫 표본에서 이미 바뀌어 있으면 거기서 끝낸다. */
  const ANLAS_PROBES = [1500, 6000, 15000];

  // Opus 무료 판정 기준 (번들 실측). 1메가픽셀.
  const FREE_PIXELS = 1048576;
  const FREE_STEPS = 28;

  /* 캐릭터 레퍼런스가 붙으면 무료가 아니다. 본문에서 이 이름으로 나간다.
   * **V4.5에만 있는 기능이다** — V5에는 2026-09 현재 아직 없다. V4.5의 Anlas 판정용이고,
   * V5에 들어오면 같은 키로 잡힐 것으로 본다(확인 전). */
  const REF_KEYS = [
    'director_reference_images',
    'director_reference_images_cached',
    'director_reference_descriptions',
  ];

  const post = (payload) => {
    try { window.postMessage(payload, window.location.origin); } catch {}
  };

  /* ---------- 1. 사용량 ---------- */

  let lastUsageKey = null;
  let lastAnlas = null; // 가장 최근에 읽은 잔액. 생성 직전 스냅샷으로 쓴다.

  function rootFiber() {
    const candidates = [document.getElementById('__next'), document.body, ...document.body.children];
    for (const el of candidates) {
      if (!el) continue;
      const key = Object.keys(el).find(
        (k) => k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$')
      );
      if (key) return el[key];
    }
    return null;
  }

  /** 화면의 Anlas 잔액 = 지급분 + 구매분. 정수다. */
  function anlasOf(sub) {
    const t = sub && sub.trainingStepsLeft;
    if (!t) return null;
    const fixed = Number(t.fixedTrainingStepsLeft);
    const bought = Number(t.purchasedTrainingSteps);
    if (!Number.isFinite(fixed) && !Number.isFinite(bought)) return null;
    return (Number.isFinite(fixed) ? fixed : 0) + (Number.isFinite(bought) ? bought : 0);
  }

  /** obj 를 깊이 SCAN_DEPTH 까지 훑으며 모든 (key, value) 쌍을 visit 에 넘긴다.
   *  visit 이 true 를 돌려주면 거기서 멈추고 true 를 올려보낸다.
   *
   *  seen 은 순회 **한 번 전체**가 함께 쓴다. 파이버 트리는 같은 객체를 수없이 다시 가리켜서,
   *  호출마다 새로 만들면 같은 자리를 몇 번이고 다시 판다. */
  function scanObject(obj, visit, seen, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > SCAN_DEPTH || seen.has(obj)) return false;
    seen.add(obj);
    for (const key in obj) {
      let val;
      try { val = obj[key]; } catch { continue; }
      if (visit(key, val)) return true;
      if (val && typeof val === 'object' && depth < SCAN_DEPTH) {
        if (scanObject(val, visit, seen, depth + 1)) return true;
      }
    }
    return false;
  }

  /** 파이버 트리를 훑으며 각 노드의 memoizedProps 와 훅 상태를 visit 에 넘긴다.
   *  visit 이 true 를 돌려주면(다 찾았다는 뜻) 즉시 멈춘다.
   *
   *  React 내부로 들어가는 **유일한 통로**다. 뒤지는 방법이 두 벌이 되면 한쪽만 고쳐지고,
   *  그때부터 두 관측값이 서로 다른 트리를 본다. */
  function walkFibers(visit) {
    const root = rootFiber();
    if (!root) return;

    const seen = new WeakSet();
    const stack = [root];
    let n = 0;

    while (stack.length && n < MAX_FIBERS) {
      const f = stack.pop();
      n++;
      if (!f) continue;
      if (f.memoizedProps && scanObject(f.memoizedProps, visit, seen)) return;
      let hook = f.memoizedState;
      for (let i = 0; hook && i < MAX_HOOKS; i++) {
        if (hook.memoizedState && typeof hook.memoizedState === 'object') {
          if (scanObject(hook.memoizedState, visit, seen)) return;
        }
        hook = hook.next;
      }
      if (f.child) stack.push(f.child);
      if (f.sibling) stack.push(f.sibling);
    }
  }

  /** usage 와 trainingStepsLeft 는 같은 subscription 객체의 형제 키다. 한 번에 집어 온다. */
  function findSubscription() {
    let found = null;
    walkFibers((key, val) => {
      if (
        key === 'subscription' &&
        val && typeof val === 'object' &&
        val.usage && typeof val.usage.percent === 'number'
      ) {
        found = val;
        return true;
      }
      return false;
    });
    return found;
  }

  function sampleUsage(force) {
    let sub;
    try { sub = findSubscription(); } catch { return null; }
    if (!sub) return null;

    const usage = sub.usage;
    const percent = usage.percent;
    const tun = typeof usage.timeUntilNextPercent === 'number' ? usage.timeUntilNextPercent : null;
    const isNegative = !!usage.isNegative;
    const anlas = anlasOf(sub);
    if (anlas !== null) lastAnlas = anlas;

    const key = percent + '/' + tun + '/' + isNegative + '/' + anlas;
    if (!force && key === lastUsageKey) return anlas;
    lastUsageKey = key;

    post({ __nib: USAGE_TAG, percent, timeUntilNextPercent: tun, isNegative, anlas, at: Date.now() });
    return anlas;
  }

  /* ---------- 2. 생성 요청 ---------- */

  // request-price / suggest-tags 는 파라미터를 만질 때마다 호출된다. 경로를 정확히 맞춰 걸러낸다.
  const GEN_PATHS = new Set(['/ai/generate-image', '/ai/generate-image-stream']);

  /* **기록하는 범위**다. Opus 할당량을 쓰는 범위와 헷갈리면 안 된다.
   *
   *   기록  V4.5 · V5   — Anlas는 둘 다 나가고, 예약 큐가 완료 신호로 쓴다
   *   할당량 V5 뿐        — 사용자 실측. V4.5로 생성하면 percent가 전혀 안 줄어든다
   *
   * 번들의 무료 판정식에 모델 조건이 없다는 것은 **Anlas 과금 기준**이 그렇다는 뜻이지
   * Opus 할당량까지 같다는 뜻이 아니었다. 둘을 하나로 본 것이 틀렸다.
   * 할당량 필터는 overlay.js의 analyze()가 model로 따로 건다.
   */
  const RECORD_MODEL = /^nai-diffusion-(4-5|5)(-|$)/;

  function isGenerationUrl(url) {
    try {
      return GEN_PATHS.has(new URL(url, location.href).pathname);
    } catch {
      return false;
    }
  }

  /** 요청 본문에서 장수·모델·파라미터를 꺼낸다. 모델을 못 읽으면 집계하지 않는다.
   *
   *  **이미지가 붙는 생성(i2i·레퍼런스)은 multipart/form-data 로 나가고 본문 JSON이
   *  request 칸에 Blob 으로 들어간다.** 문자열만 보면 그 경우 장수와 크기를 통째로 놓친다. */
  async function readRequestInfo(body) {
    const unknown = { images: 1, model: null, params: null };
    let raw = null;
    try {
      if (typeof body === 'string') {
        raw = body;
      } else if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const part = body.get('request');
        if (typeof part === 'string') raw = part;
        else if (part && typeof part.text === 'function') raw = await part.text();
      }
    } catch {
      return unknown;
    }
    if (typeof raw !== 'string') return unknown;

    try {
      const j = JSON.parse(raw);
      const params = j && typeof j.parameters === 'object' ? j.parameters : j;
      const n = params?.n_samples ?? j?.n_samples;
      return {
        images: Number.isFinite(n) && n > 0 ? Math.floor(n) : 1,
        model: typeof j?.model === 'string' ? j.model : null,
        params: params || null,
      };
    } catch {
      return unknown;
    }
  }

  /** 크기·스텝 서명. Anlas 단가는 이 셋에 걸려 있어, 서명이 다른 표본을 섞으면 평균이 거짓말이 된다. */
  function paramSig(params) {
    if (!params) return null;
    const w = Number(params.width);
    const h = Number(params.height);
    const st = Number(params.steps);
    if (!Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(st)) return null;
    return w + 'x' + h + 'x' + st;
  }

  /** 캐릭터 레퍼런스가 붙었는가. 판단할 근거가 없으면 null. */
  const hasRef = (params) =>
    params ? REF_KEYS.some((k) => Array.isArray(params[k]) && params[k].length > 0) : null;

  /** NovelAI 자신의 무료 판정식 그대로 (번들 실측):
   *    !characterRef && width * height <= 1048576 && steps <= 28
   *
   *  **이 식은 이미지 한 장 기준이다.** 한 요청에 여러 장을 담으면 첫 장 말고는 과금된다 —
   *  실측: 832×1216·16스텝으로 4장 요청 −60 Anlas, 같은 설정 1장 요청 0.
   *  그래서 장수를 함께 본다.
   *
   *  차감액의 근거가 아니라 **검산용**이다. 진짜 값은 잔액 차이로 잰다.
   *  판단할 근거가 없으면 null — 0으로 단정하지 않는다. */
  function expectFree(params, images) {
    if (!params) return null;
    const w = Number(params.width);
    const h = Number(params.height);
    const st = Number(params.steps);
    if (!Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(st)) return null;
    if (Number.isFinite(images) && images > 1) return false;
    return !hasRef(params) && w * h <= FREE_PIXELS && st <= FREE_STEPS;
  }

  /* ---------- Anlas 차감액 측정 ----------
   *
   * **측정은 한 번에 하나만 열려 있다.** 예전에는 생성마다 1.5s/6s/15s 탐침을 따로 걸었는데,
   * 무료 생성 뒤 10초 안에 과금 생성을 누르면 뒤 생성의 차감이 앞 생성의 15초 탐침에 걸려
   * **무료 생성에 −45가 찍히고, 과금 생성에도 −45가 찍혀 두 번 셌다**(2026-09-22 원장 실측:
   * 1216×832 무료 생성 13건이 cost 45).
   *
   * 그래서 다음 생성 요청이 나가는 순간 이전 측정을 닫는다. 그 순간의 잔액은 새 요청의 차감이
   * 아직 반영될 수 없는 값이므로(요청을 막 보냈을 뿐이다), 이전 생성의 before와 다르면 그 차이가
   * 이전 생성의 몫이고, 같으면 이전 생성은 (적어도 아직은) 안 깎은 것이다. */
  let pending = null; // { id, before, free, timers[], done }

  function settle(m, now) {
    if (!m || m.done) return;
    m.done = true;
    m.timers.forEach(clearTimeout);
    if (pending === m) pending = null;
    /* 잔액이 **늘었다** = 충전(구매·월 지급)이다. 차감액으로 적으면 −9918 같은 음수가 합계를 망친다
       (2026-09-23 실측). 같은 순간 차감이 있었는지는 가를 수 없으니 모름(null)으로 둔다. */
    if (Number.isFinite(now) && now > m.before) {
      post({ __nib: ANLAS_TAG, id: m.id, cost: null, before: m.before, after: now });
      return;
    }
    if (Number.isFinite(now) && now !== m.before) {
      post({ __nib: ANLAS_TAG, id: m.id, cost: m.before - now, before: m.before, after: now });
    } else {
      // 끝내 안 바뀌었다 — 무료가 맞으면 0, 아니면 null(모름). 0으로 때려 넣지 않는다.
      post({ __nib: ANLAS_TAG, id: m.id, cost: m.free === true ? 0 : null, before: m.before, after: m.before });
    }
  }

  /** 생성 요청이 **나간 직후** 부른다. 이전 측정을 닫고, 이번 생성의 before를 돌려준다.
   *  요청을 보낸 뒤에 파이버를 훑으므로(~20ms) 생성 버튼이 늦어지지 않는다. 캐시값(최대 5초 묵음)을
   *  쓰면 이전 생성의 차감이 아직 안 담겨 있어 이번 생성에 얹힌다. */
  function beginMeasure() {
    const now = sampleUsage(true);
    if (pending) settle(pending, now);
    return Number.isFinite(now) ? now : lastAnlas;
  }

  /** 생성 직후 잔액이 갱신되기를 기다렸다 차감액을 잰다. */
  function measureAnlas(id, before, free) {
    if (!Number.isFinite(before)) return;
    if (pending) settle(pending, lastAnlas); // 동시 요청이 겹친 드문 경우
    const m = { id, before, free, timers: [], done: false };
    pending = m;
    ANLAS_PROBES.forEach((ms, i) => {
      m.timers.push(
        setTimeout(() => {
          if (m.done) return;
          const after = sampleUsage(true);
          if ((Number.isFinite(after) && after !== before) || i === ANLAS_PROBES.length - 1) settle(m, after);
        }, ms)
      );
    });
  }

  const isRecorded = (model) => typeof model === 'string' && RECORD_MODEL.test(model);

  /** 요청 본문에서 모델을 못 읽었을 때의 대비책 — 화면에서 지금 고른 모델을 읽는다.
   *  본문 파싱 하나에만 기대면, 그게 실패하는 순간 아무것도 기록되지 않는다.
   *
   *  주의: 첫 번째로 만나는 값을 그냥 쓰면 안 된다. `model`이라는 이름의 키는 히스토리 항목 등
   *  여러 곳에 붙어 있어 엉뚱한 모델을 집을 수 있고, 파이버 순회 순서는 보장되지도 않는다.
   *  그래서 후보를 모두 모아 **만장일치일 때만** 채택하고, 엇갈리면 판단을 포기한다
   *  (잘못 세는 것보다 안 세는 쪽이 낫다).
   */
  function selectedModel() {
    const strong = new Set(); // key === 'selectedModel' — 화면에서 고른 모델
    const weak = new Set(); // key === 'model' — 다른 것일 수 있다

    walkFibers((key, val) => {
      if (typeof val === 'string' && val.startsWith('nai-diffusion')) {
        if (key === 'selectedModel') strong.add(val);
        else if (key === 'model') weak.add(val);
      }
      return strong.size > 1; // 이미 엇갈렸으면 더 볼 것이 없다
    });

    if (strong.size === 1) return [...strong][0];
    if (strong.size === 0 && weak.size === 1) return [...weak][0];
    return null; // 없거나 엇갈림 — 집계하지 않는다
  }

  const newId = () =>
    (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  function reportGeneration(info, startedAt, anlasBefore) {
    // 본문에서 못 읽으면 화면에서 지금 고른 모델로 대체한다.
    const model = info.model || selectedModel();

    // V4.5 · V5만 기록한다. 그 밖의 세대는 지금 요금 체계와 달라 섞으면 표가 거짓말이 된다.
    if (!isRecorded(model)) {
      console.info('[Nib] V4.5 · V5가 아니라 기록하지 않습니다:', model || '(모델 판별 실패)');
      return;
    }

    const id = newId();
    const free = expectFree(info.params, info.images);

    post({
      __nib: GEN_TAG, id, at: startedAt, images: info.images, model, free,
      ref: hasRef(info.params), sig: paramSig(info.params),
    });

    // 생성 직후 잔량과 Anlas가 갱신되므로 조금 뒤에 다시 읽는다. 이 표본이 곧 차감액 측정이다.
    measureAnlas(id, anlasBefore, free);
  }

  // fetch 후킹
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      let watch = false;
      let infoP = null;
      let startedAt = 0;
      try {
        const url = typeof input === 'string' ? input : input && input.url;
        if (url && isGenerationUrl(url)) {
          watch = true;
          startedAt = Date.now();
          infoP = readRequestInfo(init && init.body);
        }
      } catch {}

      const p = origFetch.apply(this, arguments);
      if (!watch) return p;
      // 요청을 보낸 **뒤에** 잰다 — 파이버 순회가 생성 버튼을 늦추지 않게.
      let anlasBefore = lastAnlas;
      try { anlasBefore = beginMeasure(); } catch {}

      return p.then(
        (res) => {
          try {
            if (res && res.ok) {
              infoP.then((info) => reportGeneration(info, startedAt, anlasBefore)).catch(() => {});
            } else {
              // 세지는 않지만 예약 큐는 이 신호로 멈춘다. 이유 없이 멈추면 사용자가 못 고친다.
              post({ __nib: FAIL_TAG, status: res ? res.status : 0, at: Date.now() });
            }
          } catch {}
          return res;
        },
        (err) => {
          post({ __nib: FAIL_TAG, status: 0, at: Date.now() });
          throw err; // 실패한 생성은 세지 않는다
        }
      );
    };
  }

  // XMLHttpRequest 후킹 (fetch를 안 쓰는 경로 대비)
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      try { this.__nibGen = isGenerationUrl(url); } catch { this.__nibGen = false; }
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      if (this.__nibGen) {
        const startedAt = Date.now();
        let anlasBefore = lastAnlas; // 아래 send 뒤에 beginMeasure 로 바꾼다
        const infoP = readRequestInfo(body);
        this.addEventListener('load', () => {
          try {
            if (this.status >= 200 && this.status < 300) {
              infoP.then((info) => reportGeneration(info, startedAt, anlasBefore)).catch(() => {});
            } else {
              post({ __nib: FAIL_TAG, status: this.status, at: Date.now() });
            }
          } catch {}
        });
        this.addEventListener('error', () => {
          post({ __nib: FAIL_TAG, status: 0, at: Date.now() });
        });
        const ret = origSend.apply(this, arguments);
        try { anlasBefore = beginMeasure(); } catch {}
        return ret;
      }
      return origSend.apply(this, arguments);
    };
  }

  /* ---------- 시작 ---------- */

  sampleUsage(true);
  setInterval(() => sampleUsage(false), POLL_MS);
})();
