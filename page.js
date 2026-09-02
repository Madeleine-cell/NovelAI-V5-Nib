/* Nib — 페이지 컨텍스트(MAIN world) 수집기
 *
 * 왜 여기 있나:
 *   콘텐츠 스크립트는 격리된 JS 컨텍스트라 (a) 페이지가 DOM 노드에 붙여둔 React 내부 속성과
 *   (b) 페이지의 window.fetch 를 건드릴 수 없다. 둘 다 필요해서 이 파일만 MAIN world에서 돈다.
 *
 * 무엇을 보내나 (window.postMessage → content.js):
 *   1. nib-usage : { percent, timeUntilNextPercent, isNegative, anlas }
 *   2. nib-gen   : { id, at, images, model, free, sig }   성공한 생성 요청 하나
 *   3. nib-anlas : { id, cost, before, after }            그 생성의 Anlas 차감액
 *   4. nib-genfail : { status }                           실패한 생성 (예약 큐가 멈추는 신호)
 *
 * 사용량에 대해 확인된 사실:
 *   percent 는 정수로만 내려온다. timeUntilNextPercent 는 카운트다운이 아니라
 *   "1%를 회복하는 데 걸리는 초"라는 상수다(7888 ≈ 하루 10.95%). 관측으로 확인함.
 *   따라서 1% 미만 잔량은 알 수 없고, 장당 소모량은 여러 번의 정수 하락과
 *   그 사이 생성 장수를 나눠서 추정해야 한다. 계산은 background.js가 한다.
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

  // 캐릭터 레퍼런스가 붙으면 무료가 아니다. 본문에서 이 이름으로 나간다.
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
    const hasRef = REF_KEYS.some((k) => Array.isArray(params[k]) && params[k].length > 0);
    return !hasRef && w * h <= FREE_PIXELS && st <= FREE_STEPS;
  }

  /** 생성 직후 잔액이 갱신되기를 기다렸다 차감액을 잰다.
   *  끝내 안 바뀌면 — 무료가 맞으면 0, 아니면 null(모름). 0으로 때려 넣지 않는다. */
  function measureAnlas(id, before, free) {
    if (!Number.isFinite(before)) return;
    let done = false;
    ANLAS_PROBES.forEach((ms, i) => {
      setTimeout(() => {
        if (done) return;
        const after = sampleUsage(true);
        if (Number.isFinite(after) && after !== before) {
          done = true;
          post({ __nib: ANLAS_TAG, id, cost: before - after, before, after });
        } else if (i === ANLAS_PROBES.length - 1) {
          done = true;
          post({ __nib: ANLAS_TAG, id, cost: free === true ? 0 : null, before, after: before });
        }
      }, ms);
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

    post({ __nib: GEN_TAG, id, at: startedAt, images: info.images, model, free, sig: paramSig(info.params) });

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
      let anlasBefore = null;
      try {
        const url = typeof input === 'string' ? input : input && input.url;
        if (url && isGenerationUrl(url)) {
          watch = true;
          startedAt = Date.now();
          // 5초마다 갱신되는 캐시값을 쓴다. 여기서 파이버를 훑으면 생성 버튼이 그만큼 늦어진다.
          anlasBefore = lastAnlas;
          infoP = readRequestInfo(init && init.body);
        }
      } catch {}

      const p = origFetch.apply(this, arguments);
      if (!watch) return p;

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
        const anlasBefore = lastAnlas;
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
      }
      return origSend.apply(this, arguments);
    };
  }

  /* ---------- 시작 ---------- */

  sampleUsage(true);
  setInterval(() => sampleUsage(false), POLL_MS);
})();
