/* Nib — NovelAI 화면 위에 띄우는 창들의 공용 바탕
 *
 * 사용량 창(overlay.js) · 편집 창(editor.js) · 예약 창(queue.js)이 같은 토큰·같은 창틀·
 * 같은 드래그·같은 테마 배선을 쓴다. 세 파일에 따로 적어두면 한쪽만 고치는 실수가 반드시
 * 나므로 여기 한 곳에 모았다. **여기 있는 것을 각 창에 다시 적지 말 것.**
 *
 * 창틀 말고 두 가지가 더 얹혀 있다. 둘 다 이유는 같다 — 두 벌이 되면 조용히 갈라진다.
 *   normalizeSlots            프리셋 칸 스키마. 편집 창과 예약 창이 같은 모양으로 읽어야 한다
 *   THEME_KEY · watchTheme    테마. 세 창이 같은 키를 듣고 같은 순간에 따라간다
 *
 * 콘텐츠 스크립트는 같은 격리 world를 공유하므로 globalThis 하나면 충분하다.
 * manifest의 js 배열에서 이 파일이 overlay.js·editor.js·queue.js보다 **앞에** 있어야 한다 —
 * 세 파일 모두 로드 시점에 NibUI.shellCSS()를 부른다.
 *
 * 색 정의는 sidepanel.css와 같은 값이다. 한쪽만 고치면 창마다 색이 어긋난다.
 * 예외는 --shadow-l 하나뿐이다. 이 창들은 NovelAI 화면 **위에** 뜨므로 사이드 패널보다
 * 조금 더 깊게 드리운다 — 어긋난 것이 아니라 일부러 다르게 둔 값이다.
 */

globalThis.NibUI = (() => {
  /** 테마 저장 키. 세 창과 사이드 패널이 같은 값을 본다. */
  const THEME_KEY = 'nib.theme';

  const TOKENS_LIGHT = `
    --canvas: hsl(245 32% 97%);
    --shell: hsl(245 26% 94%);
    --surface: hsl(0 0% 100%);
    --raised: hsl(245 34% 98%);
    --sunken: hsl(245 30% 96%);
    --hairline: hsl(245 20% 89%);
    --hairline-2: hsl(245 18% 82%);
    --ink: hsl(245 30% 15%);
    --ink-2: hsl(245 13% 40%);
    --ink-3: hsl(245 11% 57%);
    --accent: hsl(38 54% 40%);
    --accent-hi: hsl(38 58% 32%);
    --accent-on: hsl(44 60% 99%);
    --accent-soft: hsl(44 62% 94%);
    --accent-line: hsl(44 42% 79%);
    --danger: hsl(354 58% 48%);
    --danger-soft: hsl(354 70% 96%);
    --good: hsl(157 52% 32%);
    --warn: hsl(36 74% 38%);
    --mark: hsl(191 70% 34%);
    --shadow-s: 0 1px 2px hsl(245 32% 22% / 0.05), 0 3px 8px hsl(245 32% 22% / 0.04);
    --shadow-l: 0 10px 24px hsl(245 32% 22% / 0.12), 0 30px 60px hsl(245 32% 22% / 0.18);
    --inner-hi: inset 0 1px 0 hsl(0 0% 100% / 0.8);
  `;

  const TOKENS_DARK = `
    --canvas: hsl(245 26% 7%);
    --shell: hsl(245 22% 10%);
    --surface: hsl(245 21% 12%);
    --raised: hsl(245 19% 16%);
    --sunken: hsl(245 28% 6%);
    --hairline: hsl(245 16% 21%);
    --hairline-2: hsl(245 14% 28%);
    --ink: hsl(245 22% 94%);
    --ink-2: hsl(245 12% 70%);
    --ink-3: hsl(245 10% 50%);
    --accent: hsl(44 60% 79%);
    --accent-hi: hsl(44 70% 87%);
    --accent-on: hsl(245 30% 9%);
    --accent-soft: hsl(44 28% 15%);
    --accent-line: hsl(44 24% 31%);
    --danger: hsl(354 68% 72%);
    --danger-soft: hsl(354 30% 17%);
    --good: hsl(154 54% 60%);
    --warn: hsl(40 76% 66%);
    --mark: hsl(188 62% 58%);
    --shadow-s: 0 1px 2px hsl(245 50% 2% / 0.4), 0 3px 8px hsl(245 50% 2% / 0.3);
    --shadow-l: 0 10px 24px hsl(245 50% 2% / 0.5), 0 30px 60px hsl(245 50% 2% / 0.65);
    --inner-hi: inset 0 1px 0 hsl(0 0% 100% / 0.05);
  `;

  /** shadow DOM 안에 넣을 공통 CSS. 창 너비는 --win-w 로 각 창이 정한다. */
  function shellCSS(winWidth = '592px') {
    return `
    :host {
      all: initial;
      /* 브라우저가 그리는 것(스크롤바)도 테마를 따라가게 한다.
         all:initial 이 상속을 끊으므로 바깥의 color-scheme이 여기까지 못 온다. */
      color-scheme: light;
      --win-w: ${winWidth};
      --r-shell: 16px; --r-core: 12px; --r-card: 10px; --r-ctl: 8px; --r-chip: 6px;
      --ease: cubic-bezier(0.16, 1, 0.3, 1);
      --font-sans: "Segoe UI Variable Text","Segoe UI Variable","Segoe UI","Pretendard Variable",Pretendard,"Noto Sans KR","Malgun Gothic",system-ui,sans-serif;
      --font-display: "Segoe UI Variable Display","Segoe UI Variable","Segoe UI","Pretendard Variable",Pretendard,"Noto Sans KR",system-ui,sans-serif;
      --font-mono: "Cascadia Mono",Consolas,ui-monospace,monospace;
      ${TOKENS_LIGHT}
    }
    @media (prefers-color-scheme: dark) {
      :host(:not([data-theme="light"])) { color-scheme: dark; ${TOKENS_DARK} }
    }
    :host([data-theme="dark"]) { color-scheme: dark; ${TOKENS_DARK} }
    :host([data-theme="light"]) { color-scheme: light; ${TOKENS_LIGHT} }

    *, *::before, *::after { box-sizing: border-box; }

    /* 작성자 규칙(.field{display:block} 등)이 브라우저 기본 [hidden]을 이긴다.
       숨김은 어디서든 이겨야 하므로 못박는다. 사이드 패널 CSS에도 같은 규칙이 있다. */
    [hidden] { display: none !important; }

    .win {
      position: fixed; z-index: 2147483600;
      width: var(--win-w); max-width: calc(100vw - 20px);
      max-height: calc(100vh - 40px);
      display: flex; flex-direction: column;
      background: var(--canvas); color: var(--ink);
      border: 1px solid var(--hairline); border-radius: var(--r-shell);
      box-shadow: var(--shadow-l), var(--inner-hi);
      font-family: var(--font-sans); font-size: 13px; line-height: 1.6;
      font-variant-numeric: tabular-nums; word-break: keep-all;
      -webkit-font-smoothing: antialiased;
      overflow: hidden;
    }
    .head {
      display: flex; align-items: center; gap: 9px;
      padding: 11px 12px; background: var(--shell);
      border-bottom: 1px solid var(--hairline);
      cursor: move; user-select: none; flex: 0 0 auto;
    }
    /* icons/nib.svg 와 같은 그림. 모서리와 색이 SVG 안에 있으므로 CSS로 덧대지 않는다. */
    .dot-mark {
      width: 22px; height: 22px; flex: 0 0 22px;
      filter: drop-shadow(0 2px 5px hsl(245 40% 8% / 0.32));
    }
    .title {
      font-family: var(--font-display);
      font-size: 12.5px; font-weight: 600; letter-spacing: -0.01em; color: var(--ink);
    }
    .spacer { flex: 1; }
    .hbtn {
      width: 27px; height: 27px; display: grid; place-items: center;
      border: 0; border-radius: var(--r-chip); background: transparent; color: var(--ink-3);
      cursor: pointer; font-size: 14px; line-height: 1; font-family: inherit;
      transition: background-color .18s var(--ease), color .18s var(--ease);
    }
    .hbtn:hover { background: var(--surface); color: var(--ink); }

    .body { overflow-y: auto; flex: 1 1 auto; }
    /* 스크롤바는 창 안의 **모든** 스크롤 영역에 같은 모양으로. 본문에만 주면
       편집 창의 이모지 판·예약 창의 세트 목록에서 기본 스크롤바가 튀어나온다.
       테두리를 투명하게 두고 background-clip 으로 안쪽만 칠해 어떤 바탕에든 앉게 한다. */
    * { scrollbar-width: thin; scrollbar-color: var(--hairline-2) transparent; }
    *::-webkit-scrollbar { width: 10px; height: 10px; }
    *::-webkit-scrollbar-track,
    *::-webkit-scrollbar-corner { background: transparent; }
    *::-webkit-scrollbar-thumb {
      background: var(--hairline-2); border-radius: 10px;
      border: 3px solid transparent; background-clip: padding-box;
    }
    *::-webkit-scrollbar-thumb:hover { background: var(--ink-3); background-clip: padding-box; }
    `;
  }

  /** 창 머리의 마크. mask id가 문서 안에서 유일해야 해서 창마다 다른 접미사를 받는다. */
  function markSVG(idSuffix) {
    const id = 'nib-mask-' + idSuffix;
    return `
      <svg class="dot-mark" viewBox="0 0 24 24" aria-hidden="true">
        <mask id="${id}">
          <rect width="24" height="24" fill="#000"/>
          <path d="M9.75 3.45h4.5a2.85 2.85 0 0 1 2.85 2.85v6.85c0 .3-.07.55-.2.8L12 21.35l-4.9-7.4c-.13-.25-.2-.5-.2-.8V6.3a2.85 2.85 0 0 1 2.85-2.85z" fill="#fff"/>
          <circle cx="12" cy="8.9" r="1.32" fill="#000"/>
          <path d="M12 8.9 L12 21.7" stroke="#000" stroke-width="1.05"/>
        </mask>
        <rect width="24" height="24" rx="5.8" fill="#15151d"/>
        <rect width="24" height="24" fill="#efdfb0" mask="url(#${id})"/>
      </svg>`;
  }

  /* 창은 열 때마다 새로 만들어진다. window에 건 이벤트는 창이 사라지면 스스로 떨어져 나가야
     여닫기를 반복해도 쌓이지 않는다 — isConnected를 보고 자기 자신을 지운다. */
  function makeDraggable(win, handle, posKey) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;

    handle.addEventListener('mousedown', (e) => {
      // 머리에 놓인 버튼을 누른 것은 드래그가 아니다.
      if (e.target.closest('button')) return;
      dragging = true;
      const r = win.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      e.preventDefault();
    });

    const detach = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    function onMove(e) {
      if (!win.isConnected) return detach();
      if (!dragging) return;
      const nx = Math.max(0, Math.min(window.innerWidth - 80, ox + e.clientX - sx));
      const ny = Math.max(0, Math.min(window.innerHeight - 40, oy + e.clientY - sy));
      win.style.left = nx + 'px';
      win.style.top = ny + 'px';
      win.style.right = 'auto';
      win.style.bottom = 'auto';
    }
    function onUp() {
      if (!win.isConnected) return detach();
      if (!dragging) return;
      dragging = false;
      const r = win.getBoundingClientRect();
      chrome.storage.local.set({ [posKey]: { x: r.left, y: r.top } }).catch(() => {});
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  /** 창을 화면 안으로 밀어 넣는다.
   *
   *  창 높이는 calc(100vh - 40px)까지 자란다. 그러니 위에서 56px 떨어뜨려 놓으면
   *  화면이 낮을 때 아래가 잘리고, 하필 거기 있는 저장 버튼이 안 보이게 된다.
   *  자리를 잡은 **뒤에** 실제 높이를 재서 되민다. */
  function clampIntoView(win) {
    const r = win.getBoundingClientRect();
    const top = Math.max(10, Math.min(r.top, window.innerHeight - 10 - r.height));
    const left = Math.max(10, Math.min(r.left, window.innerWidth - 10 - r.width));
    win.style.top = top + 'px';
    win.style.left = left + 'px';
  }

  /** 저장된 자리로 되돌린다. 없으면 fallback()이 주는 자리에 둔다. */
  async function restorePosition(win, posKey, fallback) {
    let pos = null;
    try {
      const got = await chrome.storage.local.get(posKey);
      pos = got[posKey];
    } catch {}
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      win.style.left = pos.x + 'px';
      win.style.top = pos.y + 'px';
    } else {
      const p = fallback();
      win.style.left = p.x + 'px';
      win.style.top = p.y + 'px';
    }
    clampIntoView(win);

    // 창 크기가 바뀌면 다시 밀어 넣는다. 창이 사라지면 이 청취자도 스스로 떨어진다.
    const onResize = () => {
      if (!win.isConnected) return window.removeEventListener('resize', onResize);
      clampIntoView(win);
    };
    window.addEventListener('resize', onResize);
  }

  /** 사이드 패널에서 고른 테마를 그대로 따른다. 'auto'면 속성을 지워 매체 질의에 맡긴다. */
  async function syncTheme(host) {
    if (!host) return;
    let mode = 'auto';
    try {
      const got = await chrome.storage.local.get(THEME_KEY);
      if (got[THEME_KEY]) mode = got[THEME_KEY];
    } catch {}
    if (mode === 'light' || mode === 'dark') host.setAttribute('data-theme', mode);
    else host.removeAttribute('data-theme');
  }

  /** 테마가 바뀌면 그때 떠 있는 창에 다시 입힌다.
   *
   *  호스트를 값이 아니라 **함수로** 받는다. 창은 열 때마다 새로 만들어지므로 값으로 받으면
   *  두 번째로 연 창은 첫 번째 호스트를 계속 가리킨다. 청취자는 창보다 오래 살아도 되고
   *  (창이 닫혀 있으면 getHost()가 null을 준다), 파일당 한 번만 걸면 된다. */
  function watchTheme(getHost) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[THEME_KEY]) return;
      const host = getHost();
      if (host) syncTheme(host);
    });
  }

  /** 프리셋의 칸별 슬롯을 성한 모양으로 되돌린다.
   *
   *  `charUCs`는 `chars`와 **짝을 이루는 배열**이다(같은 인덱스 = 같은 캐릭터).
   *  이 키가 없던 시절의 프리셋이 저장소에 그대로 남아 있으므로, 읽는 쪽은 언제나 여기를 거친다.
   *  편집 창과 예약 창이 같은 함수를 쓴다 — 한쪽만 고치면 같은 프리셋이 두 창에서 다르게 보인다.
   *
   *  **사이드 패널에도 같은 함수가 있다**(sidepanel.js). 그쪽은 다른 실행 컨텍스트라
   *  이 파일을 못 읽는다 — 고칠 때 반드시 함께 고칠 것. */
  function normalizeSlots(s) {
    const chars = Array.isArray(s?.chars) ? s.chars.map((x) => String(x || '')) : [];
    const charUCs = Array.isArray(s?.charUCs) ? s.charUCs.map((x) => String(x || '')) : [];
    while (charUCs.length < chars.length) charUCs.push('');
    while (chars.length < charUCs.length) chars.push('');
    return {
      base: typeof s?.base === 'string' ? s.base : '',
      uc: typeof s?.uc === 'string' ? s.uc : '',
      chars,
      charUCs,
    };
  }

  /* 없는 값은 빈 문자열로 본다. String(null)을 그대로 두면 화면에 "null"이 찍힌다. */
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  return {
    THEME_KEY,
    shellCSS,
    markSVG,
    makeDraggable,
    restorePosition,
    clampIntoView,
    syncTheme,
    watchTheme,
    normalizeSlots,
    esc,
  };
})();
