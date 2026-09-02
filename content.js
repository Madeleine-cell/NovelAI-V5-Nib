/* Nib — NovelAI Diffusion V5 프롬프트 삽입 엔진
 *
 * 실제 페이지에서 확인한 사실 (2026-08, V5 Curated):
 *  - 입력란은 textarea가 아니라 ProseMirror contenteditable이다.
 *    el.value / innerText 대입은 무시된다. execCommand만 내부 상태까지 갱신된다.
 *  - 모바일/데스크톱 레이아웃이 둘 다 마운트돼 있다. 안 보이는 쪽에 쓰면 아무 일도 안 난다.
 *  - 접힌 캐릭터와 비활성 탭은 visibility:hidden이라 focus()가 거부된다. 먼저 클릭해서 열어야 한다.
 *  - 캐릭터 프롬프트는 localStorage['imagegen-character-prompts']에
 *    [{prompt, uc, center, enabled}] 형태로 그대로 들어 있다. 읽기는 여기서 하면 된다.
 *
 * **파일 전체가 IIFE 안에 있다.** 다른 콘텐츠 스크립트와 모양을 맞춘 것이기도 하지만,
 * 그보다 두 번 실행돼도 죽지 않아야 하기 때문이다 — 사이드 패널의 send()는 메시지가 안 닿으면
 * chrome.scripting.executeScript로 콘텐츠 스크립트 목록을 통째로 다시 주입한다.
 * 콘텐츠 스크립트는 하나의 격리 world를 나눠 쓰므로, 최상위 const가 IIFE 밖에 있으면
 * 두 번째 주입이 "Identifier 'SEL' has already been declared"로 통째로 실패한다.
 * 밖에 내놓는 이름은 맨 아래 globalThis.NibEngine 하나뿐이다.
 */

(() => {
  const SEL = {
    base: '.prompt-input-box-base-prompt',
    uc: '.prompt-input-box-undesired-content',
    charRow: (n) => `.character-prompt-input-${n}`,
    charBox: (n, uc) => `.prompt-input-box-character-prompts-${n}` + (uc ? '-undesired-content' : ''),
  };

  const TAB_LABELS = ['Prompt', 'Undesired Content'];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isVisible(el) {
    if (!el) return false;
    if (el.getClientRects().length === 0) return false;
    return getComputedStyle(el).visibility !== 'hidden';
  }

  function visibleAll(selector, root = document) {
    return [...root.querySelectorAll(selector)].filter(isVisible);
  }

  /* ---------- 타겟 해석 ----------
   * target: { kind: 'base' | 'uc' | 'char', index?: number, uc?: boolean }
   */

  function boxSelector(target) {
    if (target.kind === 'base') return SEL.base;
    if (target.kind === 'uc') return SEL.uc;
    return SEL.charBox(target.index, target.uc);
  }

  function pickEditor(target) {
    return visibleAll(boxSelector(target) + ' .ProseMirror')[0] || null;
  }

  /** 접힌 캐릭터를 펼치고 올바른 탭을 활성화한 뒤 에디터를 돌려준다. */
  async function ensureEditor(target) {
    const editor = pickEditor(target);
    if (editor) return editor;
    if (target.kind !== 'char') return null;

    const row = visibleAll(SEL.charRow(target.index))[0];
    if (!row) return null;

    // 접혀 있으면 미리보기 버튼을 눌러 펼친다.
    //
    // 글자로 찾으면 안 된다. 칸이 비면 미리보기에 글자가 없어져 못 찾고,
    // 그 캐릭터는 다시는 대상이 되지 못한다. 폭으로 구분한다 —
    // 미리보기는 행 전체를 차지하고(360px 남짓), 위/아래/활성/삭제/드래그 아이콘은 30px 남짓이다.
    const candidates = [...row.querySelectorAll('button')]
      .filter((b) => isVisible(b) && !TAB_LABELS.includes(b.innerText.trim()))
      .map((b) => ({ b, w: b.getBoundingClientRect().width }))
      .sort((a, z) => z.w - a.w);

    // 실측: 아이콘 버튼 34px, 미리보기 373px. 80px면 확실히 갈린다.
    // 그래도 못 고르면 가장 넓은 것을 쓴다 — 아무것도 안 누르는 것보다 낫다.
    const preview = (candidates.find((x) => x.w > 80) || candidates[0])?.b;

    if (preview) {
      preview.click();
      await sleep(250);
    }

    // Prompt / Undesired Content 탭 전환
    const wanted = target.uc ? 'Undesired Content' : 'Prompt';
    const tab = [...row.querySelectorAll('button')].find(
      (b) => isVisible(b) && b.innerText.trim() === wanted
    );
    if (tab) {
      tab.click();
      await sleep(200);
    }

    return pickEditor(target);
  }

  /* ---------- 태그 ---------- */

  /* NovelAI 프롬프트는 **쉼표와 줄바꿈 둘 다**로 태그를 나눈다.
   * 쉼표만 보면 줄 끝 태그가 다음 줄 첫 태그와 한 덩어리로 읽혀 영영 안 잡힌다.
   * sidepanel.js에도 같은 함수가 있다 — 한쪽만 고치면 활성 표시와 빼기가 어긋난다. */
  const splitTags = (s) =>
    String(s || '')
      .split(/[,\n]/)
      .map((t) => t.trim())
      .filter(Boolean);

  /* 태그와 **그 뒤에 붙어 있던 구분자**를 짝으로 뜯는다.
   * 넣고 뺀 뒤 다시 이어 붙일 때 줄 구조를 그대로 돌려놓기 위해서다.
   * 그냥 splitTags → join(', ') 하면 여러 줄로 짠 프롬프트가 한 줄로 뭉개진다.
   * (execCommand('insertText')는 줄바꿈을 그대로 넣는다 — 실측 확인.) */
  function splitParts(text) {
    const s = String(text || '');
    const sep = /[ \t]*[,\n][\s,]*/g;
    const out = [];
    let last = 0;
    let m;
    while ((m = sep.exec(s)) !== null) {
      const tag = s.slice(last, m.index).trim();
      if (tag) out.push({ tag, sep: m[0] });
      else if (out.length) out[out.length - 1].sep += m[0]; // 빈 칸은 앞 구분자에 합친다
      last = sep.lastIndex;
    }
    const tail = s.slice(last).trim();
    if (tail) out.push({ tag: tail, sep: '' });
    return out;
  }

  /** 마지막 태그 뒤의 구분자는 버린다 — 쉼표가 대롱대롱 남지 않게. */
  const joinParts = (parts) =>
    parts.map((x, i) => x.tag + (i === parts.length - 1 ? '' : x.sep || ', ')).join('');

  /** 비교용 정규화: 대소문자·공백·가중치 문법({} [] 1.2::tag::)을 벗겨낸다.
   *
   *  **공백 정리와 trim 이 먼저다.** 가중치의 앞머리와 꼬리를 떼는 두 규칙은 줄 처음·끝에
   *  걸려 있어서, 앞뒤에 공백이 남아 있으면 아무것도 못 떼고 지나간다. 그러면 같은 태그가
   *  서로 다른 키가 되어 활성 표시와 빼기가 어긋난다.
   *  sidepanel.js에 같은 함수가 있다 — 한쪽만 고치면 두 화면의 판정이 갈린다. */
  function normalizeTag(tag) {
    return String(tag)
      .replace(/[{}\[\]]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^-?\d+(?:\.\d+)?::/, '')
      .replace(/::$/, '')
      .trim()
      .toLowerCase();
  }

  /* ---------- 자동 성별 태그 ----------
   *
   * NovelAI는 캐릭터 칸을 만들 때 고른 성별에 따라 `girl, ` 또는 `boy, `를 미리 넣어둔다
   * (성별을 안 고르면 빈 칸). 여기에 성별이 들어 있는 캐릭터 프리셋을 넣으면
   * `girl, 1girl` 처럼 둘이 나란히 남는다.
   *
   * **정규화만으로는 못 잡는다.** normalizeTag는 가중치와 대소문자만 벗기므로
   * `girl` 과 `1girl` 은 끝까지 서로 다른 키다. 그래서 넣기 직전에
   * 자동으로 생긴 쪽(`girl` / `boy` 낱개)만 골라 걷어낸다.
   *
   * 걷어내는 조건을 좁게 잡은 이유:
   *   - 캐릭터 **프롬프트** 칸에서만 (UC와 Base에는 NovelAI가 이 태그를 넣지 않는다)
   *   - 넣으려는 태그에 성별 태그가 있을 때만 (없으면 지울 이유가 없다 — 그냥 지우면
   *     "화풍만 넣었는데 성별이 사라졌다"가 된다)
   *   - 지우는 것은 낱개 `girl` / `boy` 뿐. `1girl`, `2girls` 같은 사용자 태그는 건드리지 않는다.
   */

  /** NovelAI가 스스로 넣는 태그. 이것만 삭제 대상이다. */
  const AUTO_GENDER = new Set(['girl', 'boy']);

  /** 성별을 뜻하는 태그 전반: girl, boy, 1girl, 2girls, 3boys ... */
  const GENDER_RE = /^[0-9]*[ ]*(?:girl|boy)s?$/;

  const isAutoGenderTag = (t) => AUTO_GENDER.has(normalizeTag(t));
  const isGenderTag = (t) => GENDER_RE.test(normalizeTag(t));

  /* ---------- 읽기 · 쓰기 ---------- */

  function readEditor(editor) {
    // ProseMirror는 빈 상태에서도 개행을 남기고, 줄바꿈에 nbsp(U+00A0)를 쓰기도 한다.
    // nbsp는 소스에서 보통 공백과 구분되지 않는다. 정규식에 글자를 직접 넣지 말고 이스케이프로 쓴다.
    // **줄바꿈을 공백으로 바꾸지 않는다.** 바꾸면 줄 끝 태그가 다음 줄 첫 태그와 붙는다 — splitTags가 함께 나눈다.
    return editor.innerText.replace(/\u00a0/g, ' ').replace(/\n+/g, '\n').trim();
  }

  /** 삽입 직후 캐럿이 마지막 태그 안에 남으면 NovelAI가 "Did you mean?" 자동완성을 띄운다.
   *  Escape로 팝업을 닫고 포커스를 빼서 캐럿을 토큰 밖으로 보낸다. */
  async function dismissSuggestions(editor) {
    for (const type of ['keydown', 'keyup']) {
      editor.dispatchEvent(
        new KeyboardEvent(type, {
          key: 'Escape',
          code: 'Escape',
          keyCode: 27,
          which: 27,
          bubbles: true,
          cancelable: true,
        })
      );
    }
    await sleep(30);
    editor.blur();
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur?.();
    }
  }

  async function writeEditor(editor, text) {
    editor.focus();
    if (document.activeElement !== editor) return false;
    document.execCommand('selectAll');
    const ok = text
      ? document.execCommand('insertText', false, text)
      : document.execCommand('delete');
    await sleep(150); // NovelAI가 내부 상태·localStorage에 반영할 여유
    await dismissSuggestions(editor);
    return ok;
  }

  /* ---------- 명령 ---------- */

  async function applyTags(target, tags, mode) {
    const editor = await ensureEditor(target);
    if (!editor) {
      return { ok: false, error: '입력란을 찾지 못했습니다. 해당 캐릭터가 있는지 확인해 주세요.' };
    }

    const current = splitParts(readEditor(editor));
    const incoming = splitTags(tags);
    const keyOf = normalizeTag;

    const addTo = (list, extra) => {
      const out = list.slice();
      const have = new Set(out.map((x) => keyOf(x.tag)));
      for (const t of extra) {
        if (!have.has(keyOf(t))) {
          out.push({ tag: t, sep: ', ' });
          have.add(keyOf(t));
        }
      }
      return out;
    };
    const removeFrom = (list, extra) => {
      const drop = new Set(extra.map(keyOf));
      const out = [];
      for (const x of list) {
        if (!drop.has(keyOf(x.tag))) {
          out.push(x);
        } else if (out.length) {
          // 지운 자리의 구분자를 앞 태그가 물려받는다 — 줄바꿈을 잃지 않기 위해서다.
          out[out.length - 1] = { ...out[out.length - 1], sep: x.sep };
        }
      }
      return out;
    };

    // 캐릭터 프롬프트 칸에 성별 태그를 넣을 때만, 자동으로 생긴 girl/boy를 먼저 걷어낸다.
    // `some`은 첫 성별 태그에서 멈추므로 대개 태그 하나만 보고 끝난다.
    const cleanGender =
      target.kind === 'char' && !target.uc && incoming.some(isGenderTag)
        ? (list) => list.filter((x) => !isAutoGenderTag(x.tag))
        : (list) => list;

    let next;
    if (mode === 'replace') {
      next = incoming.map((t) => ({ tag: t, sep: ', ' }));
    } else if (mode === 'remove') {
      next = removeFrom(current, incoming);
    } else if (mode === 'toggle') {
      // 뺄지 넣을지는 **손대지 않은** 현재 내용으로 판단한다.
      const presentKeys = current.map((x) => keyOf(x.tag));
      const allPresent = incoming.length > 0 && incoming.every((t) => presentKeys.includes(keyOf(t)));
      next = allPresent ? removeFrom(current, incoming) : addTo(cleanGender(current), incoming);
    } else {
      next = addTo(cleanGender(current), incoming);
    }

    const text = joinParts(next);
    const ok = await writeEditor(editor, text);
    return { ok, text };
  }

  /** 페이지 현황. 캐릭터는 localStorage에서 읽어 칸을 펼치지 않아도 되게 한다. */
  function readState() {
    const peek = (target) => {
      const ed = pickEditor(target);
      return ed ? readEditor(ed) : '';
    };

    let charTexts = [];
    try {
      const raw = localStorage.getItem('imagegen-character-prompts');
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        // NovelAI가 담아둔 항목은 { prompt, uc, center, enabled }이지만, 읽는 쪽(사이드 패널·
        // 예약 창)이 쓰는 것은 두 칸의 글자뿐이다. 안 쓰는 값을 실어 나르지 않는다.
        charTexts = parsed.map((c) => ({
          prompt: String(c?.prompt || '').trim(),
          uc: String(c?.uc || '').trim(),
        }));
      }
    } catch {
      charTexts = [];
    }

    // DOM에 실제로 붙어 있는 캐릭터 행 번호 (localStorage와 어긋날 때의 안전판)
    const domIndices = [
      ...new Set(
        visibleAll('[class*="character-prompt-input-"]')
          .map((el) => (String(el.className).match(/character-prompt-input-(\d+)/) || [])[1])
          .filter(Boolean)
          .map(Number)
      ),
    ].sort((a, b) => a - b);

    const characters = domIndices.length ? domIndices : charTexts.map((_, i) => i + 1);

    return {
      onNovelAI: !!document.querySelector(SEL.base),
      characters,
      charTexts,
      base: peek({ kind: 'base' }),
      uc: peek({ kind: 'uc' }),
    };
  }

  /* ---------- "Did you mean?" 제안 숨기기 ----------
   *
   * NovelAI 태그 DB에 없는 태그를 쓰면 교정 제안이 뜬다. 클래스명이 바뀌어도 견디도록
   * 선택자 대신 텍스트로 찾는다. 대신 다음 두 가지를 반드시 지킨다:
   *   - ProseMirror(입력란 자체)를 품은 요소는 절대 숨기지 않는다.
   *   - 위로 올라가며 감싸는 범위를 넓힐 때, 내용이 급격히 늘면 멈춘다 (엉뚱한 큰 블록 방지).
   */

  const SUPPRESS_KEY = 'nib.hideSuggestions';
  const SUGGEST_RE = /did you mean/i;
  const HIDDEN_ATTR = 'data-nib-hidden';

  let suppressEnabled = false;
  let suppressObserver = null;
  let suppressTimer = null;

  /** el 아래에서 제안 문구를 가진 '가장 깊은' 요소들을 모은다. */
  function collectSuggestionNodes(root, out) {
    if (!(root instanceof HTMLElement)) return;
    if (!SUGGEST_RE.test(root.textContent || '')) return;

    const deeper = [...root.children].filter((c) => SUGGEST_RE.test(c.textContent || ''));
    if (deeper.length) {
      for (const c of deeper) collectSuggestionNodes(c, out);
    } else {
      out.push(root);
    }
  }

  function hideSuggestionsIn(root) {
    if (!suppressEnabled) return;
    const found = [];
    collectSuggestionNodes(root, found);

    for (const node of found) {
      // 사용자가 프롬프트에 그 문구를 직접 써넣은 경우 — 입력란 내부는 건드리지 않는다.
      if (node.closest('.ProseMirror')) continue;

      let target = node;
      // 문구만 딸랑 있는 게 아니라 제목/버튼까지 한 덩어리인 경우가 많아 조금 위로 올린다.
      for (let i = 0; i < 3; i++) {
        const parent = target.parentElement;
        if (!parent || parent === document.body) break;
        if (parent.querySelector('.ProseMirror')) break;
        const tLen = (target.textContent || '').trim().length;
        const pLen = (parent.textContent || '').trim().length;
        if (pLen > tLen * 1.6 + 12) break; // 부모가 훨씬 크면 남의 영역이다
        target = parent;
      }
      if (target.querySelector('.ProseMirror')) continue;
      if (target === document.body || target === document.documentElement) continue;

      target.setAttribute(HIDDEN_ATTR, '1');
      target.style.setProperty('display', 'none', 'important');
    }
  }

  function unhideAllSuggestions() {
    for (const el of document.querySelectorAll('[' + HIDDEN_ATTR + ']')) {
      el.style.removeProperty('display');
      el.removeAttribute(HIDDEN_ATTR);
    }
  }

  function setSuppress(enabled) {
    suppressEnabled = !!enabled;

    if (!suppressEnabled) {
      suppressObserver?.disconnect();
      suppressObserver = null;
      unhideAllSuggestions();
      return;
    }

    hideSuggestionsIn(document.body);

    if (suppressObserver) return;
    suppressObserver = new MutationObserver((records) => {
      // 새로 붙은 노드만 검사한다. 디바운스로 연타를 묶는다.
      const roots = [];
      for (const r of records) {
        for (const n of r.addedNodes) if (n instanceof HTMLElement) roots.push(n);
      }
      if (!roots.length) return;
      clearTimeout(suppressTimer);
      suppressTimer = setTimeout(() => {
        for (const r of roots) {
          if (r.isConnected) hideSuggestionsIn(r);
        }
      }, 80);
    });
    suppressObserver.observe(document.body, { childList: true, subtree: true });
  }

  // 저장된 설정을 읽어 적용하고, 사이드 패널에서 바뀌면 즉시 반영한다.
  chrome.storage.local
    .get(SUPPRESS_KEY)
    .then((got) => setSuppress(got[SUPPRESS_KEY] === true))
    .catch(() => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SUPPRESS_KEY]) {
      setSuppress(changes[SUPPRESS_KEY].newValue === true);
    }
  });

  /* ---------- 사용량 릴레이 ----------
   *
   * MAIN world의 page.js가 관측한 것을 서비스 워커로 넘기기만 한다.
   * 계산도 저장도 여기서 하지 않는다 — 탭이 여러 개일 때 기록이 서로를 덮어쓰기 때문이다.
   */

  const RELAY_ATTEMPTS = 3;

  /* 같은 실패를 이 간격 안에서는 한 줄만 적는다.
     page.js 는 5초마다 관측을 밀어 넣으므로, 막지 않으면 실패 하나가 확장 프로그램
     오류 목록을 5초에 한 줄씩 덮어 **진짜 오류를 파묻는다.** 묻은 건수는 함께 적는다. */
  const WARN_EVERY_MS = 60000;

  /** 이 탭의 콘텐츠 스크립트가 아직 살아 있는 확장에 붙어 있는가.
   *
   *  확장을 새로고침·업데이트·비활성화하면 그전에 열려 있던 탭의 콘텐츠 스크립트는
   *  껍데기만 남는다. 그 뒤의 모든 chrome.* 호출은 `Extension context invalidated` 로
   *  죽고, **페이지를 새로 불러오기 전에는 절대 되살아나지 않는다.**
   *  chrome.runtime.id 가 사라지는 것이 그 신호다. */
  function extensionAlive() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  let orphaned = false;
  const lastWarnAt = new Map(); // cmd → 마지막으로 적은 시각
  const muted = new Map(); // cmd → 적지 않고 넘어간 실패 수

  function warnFailure(cmd) {
    const now = Date.now();
    if (now - (lastWarnAt.get(cmd) || 0) < WARN_EVERY_MS) {
      muted.set(cmd, (muted.get(cmd) || 0) + 1);
      return;
    }
    lastWarnAt.set(cmd, now);
    const skipped = muted.get(cmd) || 0;
    muted.set(cmd, 0);
    console.warn(
      '[Nib] 기록을 전달하지 못했습니다:',
      cmd + (skipped ? ' (직전 1분간 ' + skipped + '건 더 실패)' : '')
    );
  }

  /** 서비스 워커가 잠들어 있으면 첫 메시지가 떨어질 수 있다.
   *  생성 기록은 놓치면 복구할 방법이 없으므로 몇 번 더 시도한다.
   *  원장은 id로 중복을 걸러내니 여러 번 도착해도 안전하다.
   *
   *  **끊긴 확장에는 재시도하지 않는다.** 되살아날 수 없는 상태라 1.8초를 태우고
   *  실패할 것이 확정돼 있고, page.js 의 5초 주기와 맞물려 영원히 반복된다. */
  async function relay(msg) {
    if (orphaned) return false;

    for (let i = 0; i < RELAY_ATTEMPTS; i++) {
      if (!extensionAlive()) break;
      try {
        const res = await chrome.runtime.sendMessage(msg);
        if (res?.ok) return true;
      } catch {
        /* 워커 기동 중일 수 있다 */
      }
      await sleep(300 * (i + 1));
    }

    if (!extensionAlive()) {
      /* 한 번만 알리고 이후로는 조용히 버린다. 할 수 있는 일이 새로고침뿐이라 그것만 적는다.
       *
       * **warn 이 아니라 info 다.** 확장 프로그램 오류 목록은 warn·error 만 걷어 간다.
       * 이건 고장이 아니라 확장을 새로고침하면 **반드시** 생기는 정상 상태라, warn 으로 적으면
       * 새로고침할 때마다 오류가 한 건씩 쌓여 정작 봐야 할 오류를 밀어낸다.
       * 진짜 실패(warnFailure)는 그대로 warn 이다 — 그건 목록에 올라와야 한다. */
      orphaned = true;
      console.info('[Nib] 확장이 새로고침되어 이 탭과의 연결이 끊겼습니다 — NovelAI 페이지를 새로고침해 주세요.');
      return false;
    }

    warnFailure(msg.cmd);
    return false;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || typeof d.__nib !== 'string') return;

    if (d.__nib === 'nib-usage' && typeof d.percent === 'number') {
      relay({
        cmd: 'ledger.usage',
        percent: d.percent,
        timeUntilNextPercent: d.timeUntilNextPercent,
        isNegative: d.isNegative,
        anlas: d.anlas,
        at: d.at,
      });
    } else if (d.__nib === 'nib-gen' && typeof d.id === 'string') {
      relay({
        cmd: 'ledger.gen',
        id: d.id,
        at: d.at,
        images: d.images,
        model: d.model,
        free: d.free,
        sig: d.sig,
      });
    } else if (d.__nib === 'nib-anlas' && typeof d.id === 'string') {
      relay({
        cmd: 'ledger.anlas',
        id: d.id,
        cost: d.cost,
        before: d.before,
        after: d.after,
      });
    }
  });

  /* ---------- 메시지 라우터 ---------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        switch (msg?.cmd) {
          /* 네 창은 모두 NovelAI 화면 위에 뜬다(사이드 패널이 좁아서 옮겼다).
             그 파일이 안 실려 있을 때 "정의되지 않음" 대신 할 일을 알려주는 것도 넷이 같다. */
          case 'overlay':
            if (typeof toggleOverlay !== 'function') {
              throw new Error('사용량 창을 불러오지 못했습니다. NovelAI 페이지를 새로고침해 주세요.');
            }
            toggleOverlay(msg.show);
            sendResponse({ ok: true });
            break;
          case 'editor':
            if (typeof openPresetEditor !== 'function') {
              throw new Error('편집 창을 불러오지 못했습니다. NovelAI 페이지를 새로고침해 주세요.');
            }
            openPresetEditor(msg);
            sendResponse({ ok: true });
            break;
          case 'queue':
            if (typeof openQueue !== 'function') {
              throw new Error('예약 창을 불러오지 못했습니다. NovelAI 페이지를 새로고침해 주세요.');
            }
            openQueue();
            sendResponse({ ok: true });
            break;
          case 'cleaner':
            if (typeof openCleaner !== 'function') {
              throw new Error('정리 창을 불러오지 못했습니다. NovelAI 페이지를 새로고침해 주세요.');
            }
            openCleaner();
            sendResponse({ ok: true });
            break;
          case 'ping':
            sendResponse({ ok: true });
            break;
          case 'state':
            sendResponse({ ok: true, state: readState() });
            break;
          case 'apply':
            sendResponse(await applyTags(msg.target, msg.tags, msg.mode || 'toggle'));
            break;
          case 'clear':
            sendResponse(await applyTags(msg.target, '', 'replace'));
            break;
          default:
            sendResponse({ ok: false, error: 'unknown command' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true; // 비동기 응답
  });

  /* ---------- 엔진 노출 ----------
   *
   * 콘텐츠 스크립트들은 한 컨텍스트를 공유하므로 queue.js 가 이 파일의 함수를 그냥 부를 수도 있다.
   * 그러면 파일 사이 의존이 소스 어디에도 안 적힌다. 이름을 하나로 묶어 **드러내 둔다.**
   * queue.js 는 이 객체만 쓰고, 여기 없는 것은 안 쓴다.
   *
   * visibleAll 이 여기 있는 이유: NovelAI는 모바일·데스크톱 레이아웃을 둘 다 마운트해 둔다.
   * 안 보이는 쪽을 눌러도 아무 일이 안 나므로 **보이는 것만 고르는 규칙이 한 벌이어야 한다.**
   * 두 벌이면 한쪽만 고쳐지고, 그 순간 예약 큐가 유령 버튼을 누른다. */
  globalThis.NibEngine = { readState, applyTags, splitTags, normalizeTag, visibleAll };
})();
