/* Nib — NovelAI 위에 띄우는 프리셋 편집 창
 *
 * 사이드 패널 안의 <dialog>이던 것을 여기로 옮겼다. 사이드 패널은 384px밖에 안 돼서
 * 칸별 입력이 세로로 한없이 길어졌다. 사용량 창(overlay.js)과 같은 창틀·같은 폭을 쓴다.
 *
 * 열기: 사이드 패널 → content.js 라우터 → globalThis.openPresetEditor(payload)
 * 저장: 여기서 chrome.storage['nib.library']에 **직접** 쓴다.
 *       사이드 패널은 storage.onChanged를 듣고 다시 그린다.
 *       메시지로 되돌려주지 않는 이유 — 사이드 패널이 닫혀 있어도 저장이 살아남아야 한다.
 *
 * 캐릭터 칸의 Undesired Content는 책갈피(탭)로 감춰둔다. 쓰는 일이 드물어 늘 펼쳐두면
 * 칸이 두 배로 길어지고, 그러면 정작 자주 쓰는 프롬프트 칸이 눈에서 멀어진다.
 * 감춘 쪽에 내용이 있으면 책갈피에 점을 찍는다 — 안 보이는 내용이 있다는 걸 알려야 한다.
 */

(() => {
  const HOST_ID = 'nib-preset-editor';
  const POS_KEY = 'nib.editorPos';
  const LIB_KEY = 'nib.library';
  const MAX_CHARS = 8;

  let host = null;
  let root = null;

  /* 편집 중인 값. 텍스트는 DOM(textarea)이 원본이고, 여기엔 구조만 담는다. */
  const st = {
    id: null,
    emoji: '',
    multi: false,
    slots: { base: '', uc: '', chars: [], charUCs: [] },
    tabs: [], // 캐릭터별 책갈피: 'p' | 'u'
    categories: [],
    characters: [],
    charSlot: 1,
    emojiTab: 'face',
    dirty: false,
  };

  /* 프롬프트 정리에 쓸 만한 것만 추린 목록. 주제가 가까운 것끼리 한 갈래에 모아둔다.
   *
   * 규칙 둘:
   *   1. 한 이모지는 한 갈래에만 있는다. 같은 것이 두 곳에 있으면 어디서 골랐는지 잊는다
   *      (아래 checkEmojiSets가 중복을 잡는다).
   *   2. 갈래 안의 순서도 주제순이다 — 바다 생물 다음에 숲 생물, 상의 다음에 하의.
   *      가나다순이나 유니코드순으로 늘어놓으면 눈이 훑을 곳을 못 찾는다.
   *
   * 한 줄에 10개씩 적어 둔 것은 그리드가 10칸이기 때문이다. 소스의 한 줄 = 화면의 한 줄.
   */
  const EMOJI_SETS = [
    { id: 'face', name: '표정', list: [
      '😀','😄','😊','🙂','😌','😍','🥰','😳','😏','🙃',
      '😐','😶','😴','😪','😢','😭','😡','😱','🤔','😈',
      '👿','🥶','🥵','😇','🤡','💀',
    ] },
    { id: 'people', name: '인물', list: [
      '👤','👥','👧','👦','👩','👨','🧑','👶','🧒','👸',
      '🤴','🧙','🧚','🧛','🧜','🧝','🦸','🦹','👼','🤖',
      '👻','👽',
    ] },
    { id: 'wear', name: '의상', list: [
      '👗','👘','🥻','👚','👕','👔','🎽','🥋','🩱','🩲',
      '🩳','🧥','🥼','🦺','🧣','🧤','🧦','🩰',
    ] },
    { id: 'gear', name: '장신구', list: [
      '👑','🎩','🎓','🧢','👒','🪖','👓','🕶️','🥽','💍',
      '📿','💎','💄','🪮','👜','👛','👝','💼','🎒','🧳',
      '👠','👡','👢','👞','👟','🥾','🩴',
    ] },
    { id: 'scene', name: '풍경', list: [
      '🏖️','🏝️','🏕️','🏞️','🏜️','⛰️','🏔️','🗻','🌋','🌌',
      '🌉','🌃','🌆','🌇','🌅','🌄','🏙️','🛤️','🛣️',
    ] },
    { id: 'build', name: '건축', list: [
      '🏛️','🏰','🏯','🗼','🗽','⛩️','🕌','🛕','🕍','🏟️',
      '🛖','🏘️','🏠','🏡','🏢','🏣','🏤','🏥','🏦','🏨',
      '🏪','🏫','🏬','🏭','⛲','🚪','🪟','🛋️','🪑',
    ] },
    { id: 'animal', name: '동물', list: [
      '🐋','🐬','🦭','🦈','🐙','🦑','🪼','🐠','🐟','🐡',
      '🐚','🪸','🦦','🦌','🦊','🦉','🐿️','🐇','🐺','🐻',
      '🦔','🐈‍⬛','🐱','🐰','🕊️','🦢','🦆','🦅','🦩','🦚',
      '🦜','🦇','🦋','🐎','🦄','🐆','🐅','🦁','🐾','🪶',
    ] },
    { id: 'plant', name: '식물', list: [
      '🌸','🌷','🌺','🌼','🌻','🌹','🪷','🪻','🍀','🍄',
      '🌿','🍃','🌾','🌲','🌳','🍂','🍁','🪵',
    ] },
    { id: 'sky', name: '날씨', list: [
      '☀️','🌤️','⛅','☁️','🌥️','🌦️','🌧️','⛈️','🌩️','🌨️',
      '❄️','⛄','🌈','☂️','💨','💧','⚡','🔥','🌊','🫧',
      '🌙',
    ] },
    { id: 'spark', name: '반짝', list: [
      '⭐','🌟','💫','✨','🌠','☄️','🪐','🔮','🪄','🧿',
      '💠','⚜️','✴️','❇️','🔆','🪽','🎆','🎇',
    ] },
    { id: 'sweet', name: '하트·달콤', list: [
      '💖','💕','💘','💝','💗','💓','❤️','🧡','💛','💚',
      '💙','💜','🖤','🤍','🍭','🍬','🍰','🧁','🍧','🍓',
      '🍒','☕','🍷',
    ] },
    { id: 'object', name: '소품', list: [
      '🎀','🎊','🎉','🎈','🎁','🎐','🧸','🧺','✉️','📖',
      '📜','🗝️','🧭','⚖️','⌛','⏳','🕰️','🏺','🪞','📻',
      '🪆','🏮','🕯️','🔦','🧲','🪙','🧪','🔭','⚙️','🧵',
      '🪡','🧶','🎧','🪗','🎻','🎸','🎺','🎷',
    ] },
    { id: 'tool', name: '도구', list: [
      '⚔️','🗡️','🏹','🛡️','🪓','🔨','⛏️','🪚','🔧','🪛',
      '🪜',
    ] },
    { id: 'art', name: '화풍', list: [
      '🎨','🖌️','🖍️','✏️','🖊️','🖋️','📐','🎭','🎬','📷',
      '📸','🖼️',
    ] },
    { id: 'symbol', name: '기호', list: [
      '🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🟤','⭕',
      '❌','⚠️','🔷','🔶','♠️','♥️',
    ] },
  ];

  /* 갈래를 늘리거나 옮길 때 중복이 조용히 생긴다. 개발 중에만 콘솔로 알린다 —
   * 목록은 상수라 한 번만 재면 되고, 실패해도 창은 그대로 떠야 한다. */
  function checkEmojiSets() {
    const seen = new Map();
    const dupes = [];
    for (const set of EMOJI_SETS) {
      for (const e of set.list) {
        if (seen.has(e)) dupes.push(`${e} — ${seen.get(e)} / ${set.id}`);
        else seen.set(e, set.id);
      }
    }
    if (dupes.length) console.warn('[Nib] 이모지 중복:', dupes);
  }

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  /* 칸 스키마는 예약 창(queue.js)과 같은 것을 써야 한다 — shared-ui.js에 한 벌만 둔다. */
  const normalizeSlots = NibUI.normalizeSlots;

  /* ---------- 창틀 ---------- */

  const CSS = NibUI.shellCSS('612px') + `
    .body { padding: 16px 17px 18px; display: flex; flex-direction: column; gap: 14px; }

    .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: end; }
    .field { min-width: 0; }
    .lab {
      display: block; margin-bottom: 6px;
      font-size: 9.5px; font-weight: 600; letter-spacing: .14em;
      text-transform: uppercase; color: var(--ink-3);
    }
    .lab em {
      font-style: normal; text-transform: none; letter-spacing: 0;
      font-weight: 400; opacity: .8; margin-left: 6px;
    }
    .hint { margin: 6px 0 0; font-size: 10.5px; color: var(--ink-3); line-height: 1.6; }

    input, select, textarea {
      width: 100%; padding: 8px 11px;
      background: var(--sunken); color: var(--ink);
      border: 1px solid var(--hairline); border-radius: var(--r-ctl);
      outline: none; font-family: var(--font-sans); font-size: 12.5px; line-height: 1.5;
      transition: border-color .18s var(--ease), box-shadow .18s var(--ease), background-color .18s var(--ease);
    }
    select { cursor: pointer; }
    textarea {
      font-family: var(--font-mono); font-size: 11.5px; line-height: 1.7;
      resize: vertical; min-height: 62px;
    }
    input:focus, select:focus, textarea:focus {
      background: var(--surface); border-color: var(--accent-line);
      box-shadow: 0 0 0 3px var(--accent-soft);
    }
    ::placeholder { color: var(--ink-3); opacity: .75; }

    .divider { height: 1px; background: var(--hairline); }

    /* ---- 이름 · 이모지 ---- */
    .name-row { display: flex; gap: 7px; }
    .emoji-wrap { position: relative; flex: 0 0 auto; }
    .emoji-btn {
      width: 40px; height: 36px; display: grid; place-items: center;
      padding: 0; background: var(--sunken); color: var(--ink);
      border: 1px solid var(--hairline); border-radius: var(--r-ctl);
      cursor: pointer; transition: all .18s var(--ease);
    }
    .emoji-btn > * { grid-area: 1 / 1; }
    .emoji-btn:hover { border-color: var(--accent-line); background: var(--accent-soft); }
    .emoji-btn[aria-expanded="true"] { border-color: var(--accent-line); background: var(--accent-soft); }
    .emoji-view {
      font-size: 17px; line-height: 1;
      font-family: "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif;
    }
    .emoji-plus { width: 14px; height: 14px; color: var(--ink-3); fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
    .emoji-btn:hover .emoji-plus { color: var(--accent); }

    /* 폭은 그리드에서 거꾸로 잡은 값이다 — 한 줄에 10개가 **가로 스크롤 없이** 들어가야 한다.
         칸 32 × 10 + 틈 3 × 9 + 세로 스크롤바 8 + 안쪽 여백 9 × 2 = 373  →  376px
       칸을 repeat(10, 1fr)로 두면 안 된다. 1fr은 minmax(auto, 1fr)이라 최소 크기가
       칸 내용에 끌려 올라가고, 그러면 열 열 개의 합이 폭을 넘겨 가로 스크롤이 생긴다
       (10번째가 오른쪽으로 밀려나 있던 원인). minmax(0, 1fr)이라야 폭에 맞춰 눌린다.
       overflow-x: hidden 은 그 위에 덧대는 빗장이다 — 이모지 글리프 폭은 글꼴마다 다르다. */
    .emoji-panel {
      position: absolute; z-index: 5; top: calc(100% + 6px); left: 0;
      width: 376px; padding: 9px;
      background: var(--surface); border: 1px solid var(--hairline-2);
      border-radius: var(--r-core); box-shadow: var(--shadow-l);
    }
    .emoji-tabs { display: flex; flex-wrap: wrap; gap: 3px; margin-bottom: 8px; }
    .emoji-tabs button {
      height: 22px; padding: 0 7px; border: 0; border-radius: 999px;
      background: transparent; color: var(--ink-3);
      font-family: inherit; font-size: 10.5px; white-space: nowrap; cursor: pointer;
    }
    .emoji-tabs button:hover { color: var(--ink); background: var(--sunken); }
    .emoji-tabs button[aria-selected="true"] {
      background: var(--accent-soft); color: var(--accent); font-weight: 600;
    }
    .emoji-grid {
      display: grid; grid-template-columns: repeat(10, minmax(0, 1fr)); gap: 3px;
      max-height: 232px; overflow-y: auto; overflow-x: hidden;
      /* 갈래마다 개수가 달라 스크롤바가 있다 없다 하면 칸 크기가 들썩인다. 자리를 늘 비워둔다. */
      scrollbar-gutter: stable;
    }
    .emoji-grid::-webkit-scrollbar { width: 8px; }
    .emoji-grid::-webkit-scrollbar-thumb {
      background: var(--hairline-2); border-radius: 8px; border: 2px solid var(--surface);
    }
    .emoji-grid button {
      aspect-ratio: 1; min-width: 0; padding: 0;
      border: 0; border-radius: var(--r-chip);
      background: transparent; font-size: 17px; line-height: 1; cursor: pointer;
      font-family: "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif;
      transition: transform .14s var(--ease), background-color .14s var(--ease);
    }
    .emoji-grid button:hover { background: var(--sunken); transform: scale(1.18); }
    .emoji-clear {
      width: 100%; margin-top: 8px; height: 26px;
      border: 1px solid var(--hairline); border-radius: var(--r-ctl);
      background: transparent; color: var(--ink-3);
      font-family: inherit; font-size: 11px; cursor: pointer;
    }
    .emoji-clear:hover { color: var(--ink); background: var(--sunken); }

    /* ---- 저장 방식 ---- */
    .seg {
      display: flex; gap: 3px; padding: 3px;
      background: var(--sunken); border: 1px solid var(--hairline); border-radius: var(--r-ctl);
    }
    .seg button {
      flex: 1; height: 28px; border: 0; border-radius: 6px;
      background: transparent; color: var(--ink-3);
      font-family: inherit; font-size: 11.5px; font-weight: 500; cursor: pointer;
      transition: all .16s var(--ease);
    }
    .seg button:hover { color: var(--ink); }
    .seg button[aria-selected="true"] {
      background: var(--surface); color: var(--accent); font-weight: 600;
      box-shadow: var(--shadow-s);
    }

    /* ---- 칸별 입력 ---- */
    .slots { display: flex; flex-direction: column; gap: 9px; }
    .slot-card {
      background: var(--surface); border: 1px solid var(--hairline);
      border-radius: var(--r-card); box-shadow: var(--inner-hi); overflow: hidden;
      transition: border-color .18s var(--ease), box-shadow .18s var(--ease);
    }
    .slot-card:focus-within { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
    .slot-card.absent { opacity: .82; }

    /* 라벨·책갈피·삭제 버튼이 한 줄에 선다. 셋 다 높이를 정해두고 가운데로 묶는다.
       높이를 안 주면 각자 글자 상자 크기에 끌려다녀 어긋나 보인다.
       (실측으로 확인: 이 규칙에서 네 요소의 중심이 0.01px 안에 든다) */
    .slot-head {
      display: flex; align-items: center; gap: 8px;
      min-height: 33px; padding: 4px 6px 4px 11px;
      background: var(--shell); border-bottom: 1px solid var(--hairline);
    }
    .slot-name {
      font-family: var(--font-mono); font-size: 10.5px; font-weight: 600;
      letter-spacing: .04em; color: var(--ink-2); white-space: nowrap;
    }
    .slot-tag {
      padding: 1px 6px; border-radius: 999px;
      background: var(--sunken); border: 1px solid var(--hairline);
      font-size: 9.5px; color: var(--ink-3); white-space: nowrap;
    }
    .slot-card.absent .slot-tag { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 34%, var(--hairline)); }

    .bookmarks { margin-left: auto; display: flex; gap: 2px; flex: 0 0 auto; }
    .bookmarks button {
      height: 23px; padding: 0 9px;
      display: inline-flex; align-items: center; gap: 5px;
      border: 1px solid transparent; border-radius: 999px;
      background: transparent; color: var(--ink-3);
      font-family: inherit; font-size: 10.5px; line-height: 1; cursor: pointer;
      transition: all .16s var(--ease);
    }
    .bookmarks button:hover { color: var(--ink); background: var(--sunken); }
    .bookmarks button[aria-selected="true"] {
      background: var(--accent-soft); border-color: var(--accent-line);
      color: var(--accent); font-weight: 600;
    }
    .bookmarks .dot {
      width: 5px; height: 5px; border-radius: 50%;
      background: currentColor; opacity: 0; transition: opacity .16s var(--ease);
    }
    .bookmarks .dot.on { opacity: .8; }

    .slot-remove {
      flex: 0 0 auto; width: 23px; height: 23px;
      display: grid; place-items: center; padding: 0;
      border: 1px solid var(--hairline); border-radius: var(--r-chip);
      background: var(--surface); color: var(--ink-3); cursor: pointer;
      transition: all .16s var(--ease);
    }
    /* grid 자식이라 이미 블록화되지만, 나중에 이 버튼을 인라인 문맥으로 옮겨도
       베이스라인만큼 내려앉지 않도록 못박아 둔다. */
    .slot-remove svg {
      display: block; width: 12px; height: 12px;
      fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round;
    }
    .slot-remove:hover {
      color: var(--danger);
      border-color: color-mix(in srgb, var(--danger) 45%, transparent);
      background: var(--danger-soft);
    }

    .slot-card textarea {
      border: 0; border-radius: 0; background: transparent;
      min-height: 58px; padding: 9px 11px;
    }
    .slot-card textarea:focus { box-shadow: none; background: transparent; }

    .slot-add {
      width: 100%; height: 32px;
      border: 1px dashed var(--hairline-2); border-radius: var(--r-ctl);
      background: transparent; color: var(--ink-3);
      font-family: inherit; font-size: 11.5px; font-weight: 500; cursor: pointer;
      transition: all .18s var(--ease);
    }
    .slot-add:hover:not(:disabled) {
      color: var(--accent); border-color: var(--accent-line); background: var(--accent-soft);
    }
    .slot-add:disabled { opacity: .4; cursor: default; }

    /* ---- 바닥 ---- */
    .foot {
      display: flex; align-items: center; gap: 8px;
      padding: 11px 13px; flex: 0 0 auto;
      background: var(--shell); border-top: 1px solid var(--hairline);
    }
    .btn {
      height: 31px; padding: 0 15px;
      border: 1px solid var(--hairline); border-radius: var(--r-ctl);
      background: var(--surface); color: var(--ink-2);
      font-family: inherit; font-size: 12px; font-weight: 500; cursor: pointer;
      transition: all .18s var(--ease);
    }
    .btn:hover { color: var(--ink); border-color: var(--hairline-2); }
    .btn.accent {
      background: var(--accent); border-color: var(--accent); color: var(--accent-on); font-weight: 600;
    }
    .btn.accent:hover { background: var(--accent-hi); border-color: var(--accent-hi); color: var(--accent-on); }
    .btn.danger { color: var(--ink-3); }
    .btn.danger:hover {
      color: var(--danger);
      border-color: color-mix(in srgb, var(--danger) 45%, transparent);
      background: var(--danger-soft);
    }
    .msg { font-size: 11.5px; color: var(--danger); font-weight: 500; }
    .msg:empty { display: none; }
  `;

  const ICON_MINUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>';

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
        ${NibUI.markSVG('ed')}
        <span class="title" id="title">Nib · 새 프리셋</span>
        <span class="spacer"></span>
        <button class="hbtn" id="close" title="닫기 (Esc)">✕</button>
      </div>

      <div class="body" id="body">
        <div class="field">
          <span class="lab">이름</span>
          <div class="name-row">
            <div class="emoji-wrap">
              <button type="button" class="emoji-btn" id="emoji" title="이모지 선택" aria-expanded="false">
                <span class="emoji-view" id="emoji-view"></span>
                <svg class="emoji-plus" id="emoji-plus" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
              </button>
              <div class="emoji-panel" id="emoji-panel" hidden>
                <div class="emoji-tabs" id="emoji-tabs" role="tablist"></div>
                <div class="emoji-grid" id="emoji-grid"></div>
                <button type="button" class="emoji-clear" id="emoji-clear">이모지 없애기</button>
              </div>
            </div>
            <input id="name" maxlength="60" placeholder="예: 파스텔 수채 화풍" autocomplete="off" spellcheck="false">
          </div>
        </div>

        <div class="row2">
          <div class="field">
            <span class="lab">분류</span>
            <select id="category"></select>
          </div>
          <div class="field">
            <span class="lab">저장 방식</span>
            <div class="seg" id="mode" role="tablist">
              <button type="button" data-multi="0" role="tab">한 칸에</button>
              <button type="button" data-multi="1" role="tab">칸별로 나눠서</button>
            </div>
          </div>
        </div>
        <p class="hint" id="mode-hint"></p>

        <div class="divider"></div>

        <div id="single">
          <div class="field" style="margin-bottom:13px">
            <span class="lab">기본 대상</span>
            <select id="target">
              <option value="base">Base Prompt</option>
              <option value="uc">Undesired Content</option>
              <option value="char">캐릭터 프롬프트</option>
              <option value="charuc">캐릭터 UC</option>
            </select>
          </div>
          <div class="field">
            <span class="lab">태그 <em>쉼표로 구분</em></span>
            <textarea id="tags" rows="4" spellcheck="false" placeholder="watercolor, pastel colors, soft lighting"></textarea>
          </div>
        </div>

        <div id="multi" hidden>
          <div class="slots" id="slots"></div>
          <button type="button" class="slot-add" id="slot-add" style="margin-top:9px">＋ 캐릭터 칸 추가</button>
        </div>
      </div>

      <div class="foot">
        <button type="button" class="btn danger" id="delete">삭제</button>
        <span class="msg" id="msg"></span>
        <span class="spacer"></span>
        <button type="button" class="btn" id="cancel">취소</button>
        <button type="button" class="btn accent" id="save">저장</button>
      </div>`;

    root.append(style, win);
    document.documentElement.appendChild(host);

    wire(win);
    NibUI.makeDraggable(win, root.getElementById('head'), POS_KEY);
    NibUI.restorePosition(win, POS_KEY, () => ({
      x: Math.max(10, Math.round((window.innerWidth - 612) / 2)),
      y: 56,
    }));
    NibUI.syncTheme(host);
  }

  const $ = (id) => root.getElementById(id);

  /* ---------- 배선 ---------- */

  function wire(win) {
    $('close').addEventListener('click', () => close());
    $('cancel').addEventListener('click', () => close());
    $('save').addEventListener('click', save);
    $('delete').addEventListener('click', remove);

    $('emoji').addEventListener('click', () => toggleEmoji());
    $('emoji-clear').addEventListener('click', () => {
      setEmoji('');
      toggleEmoji(false);
      st.dirty = true;
    });

    $('category').addEventListener('change', (e) => {
      const c = st.categories.find((x) => x.id === e.target.value);
      if (c) $('target').value = c.target;
      st.dirty = true;
    });

    root.querySelectorAll('#mode button').forEach((b) => {
      b.addEventListener('click', () => switchMode(b.dataset.multi === '1'));
    });

    $('slot-add').addEventListener('click', () => {
      st.slots = collect();
      st.slots.chars.push('');
      st.slots.charUCs.push('');
      st.tabs.push('p');
      renderSlots();
      st.dirty = true;
      // 방금 추가한 칸으로 눈을 옮긴다.
      const last = root.querySelectorAll('#slots .slot-card.char textarea:not([hidden])');
      last[last.length - 1]?.focus();
    });

    // 입력이 있었는지 기록해 둔다. 닫을 때 물어보기 위한 것.
    win.addEventListener('input', () => (st.dirty = true));

    // 창 밖 클릭으로 이모지 패널만 닫는다. 창 자체는 실수로 닫히지 않게 둔다.
    win.addEventListener('mousedown', (e) => {
      if (!$('emoji-panel').hidden && !e.target.closest('.emoji-wrap')) toggleEmoji(false);
    });

    // Esc는 창 안에 포커스가 있을 때만 듣는다. NovelAI의 단축키를 빼앗지 않는다.
    win.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (!$('emoji-panel').hidden) toggleEmoji(false);
        else close();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        save();
      }
    });
  }

  /* ---------- 이모지 ---------- */

  function setEmoji(emoji) {
    st.emoji = emoji || '';
    $('emoji-view').textContent = st.emoji;
    $('emoji-view').hidden = !st.emoji;
    $('emoji-plus').hidden = !!st.emoji;
  }

  function toggleEmoji(open) {
    const panel = $('emoji-panel');
    const next = open ?? panel.hidden;
    panel.hidden = !next;
    $('emoji').setAttribute('aria-expanded', String(next));
    if (next) renderEmoji();
  }

  let emojiChecked = false;

  function renderEmoji() {
    // 처음 펼칠 때 한 번만. 상수 목록이라 두 번 잴 이유가 없다.
    if (!emojiChecked) {
      emojiChecked = true;
      checkEmojiSets();
    }

    const tabs = $('emoji-tabs');
    tabs.innerHTML = '';
    for (const set of EMOJI_SETS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = set.name;
      b.setAttribute('aria-selected', String(st.emojiTab === set.id));
      b.addEventListener('click', () => {
        st.emojiTab = set.id;
        renderEmoji();
      });
      tabs.appendChild(b);
    }

    const grid = $('emoji-grid');
    grid.innerHTML = '';
    const set = EMOJI_SETS.find((s) => s.id === st.emojiTab) || EMOJI_SETS[0];
    for (const e of set.list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = e;
      b.title = e;
      b.addEventListener('click', () => {
        setEmoji(e);
        toggleEmoji(false);
        st.dirty = true;
      });
      grid.appendChild(b);
    }
  }

  /* ---------- 저장 방식 ---------- */

  function setMode(multi) {
    st.multi = multi;
    root.querySelectorAll('#mode button').forEach((b) => {
      b.setAttribute('aria-selected', String((b.dataset.multi === '1') === multi));
    });
    $('single').hidden = multi;
    $('multi').hidden = !multi;
    $('mode-hint').textContent = multi
      ? 'Base Prompt와 캐릭터별로 다른 태그를 담아 한 번에 넣고 뺍니다. 비워둔 칸은 건드리지 않습니다.'
      : '태그 한 묶음을 고른 대상 한 곳에 넣습니다.';
    /* 한 칸 모드로 돌아갈 때는 칸 카드를 **지운다.** 감춰만 두면 앞 프리셋의 textarea가
       DOM에 남고, collect()는 화면이 아니라 DOM을 읽으므로 남의 내용을 주워 올 수 있다. */
    if (multi) renderSlots();
    else $('slots').innerHTML = '';
  }

  function switchMode(multi) {
    if (multi === st.multi) return;

    if (multi) {
      // 켤 때: 지금 쓰던 태그를 '기본 대상'이 가리키는 칸으로 그대로 옮긴다.
      const single = $('tags').value.trim();
      if (single) {
        const target = $('target').value;
        if (target === 'uc') {
          st.slots.uc = st.slots.uc || single;
        } else if (target === 'char' || target === 'charuc') {
          const n = Math.max(1, st.charSlot) - 1;
          while (st.slots.chars.length <= n) {
            st.slots.chars.push('');
            st.slots.charUCs.push('');
            st.tabs.push('p');
          }
          const bucket = target === 'charuc' ? st.slots.charUCs : st.slots.chars;
          if (!bucket[n]) bucket[n] = single;
          if (target === 'charuc') st.tabs[n] = 'u';
        } else {
          st.slots.base = st.slots.base || single;
        }
        $('tags').value = '';
      }
      st.dirty = true;
      setMode(true);
      return;
    }

    // 끌 때: 칸별 내용은 단일 태그 하나로 되돌릴 수 없다. 먼저 알린다.
    const cur = collect();
    const has = [cur.base, cur.uc, ...cur.chars, ...cur.charUCs].some((t) => t.trim());
    if (has && !confirm('칸별로 입력한 내용이 모두 사라집니다.\n하나의 태그 칸으로 되돌릴 수 없기 때문입니다.\n\n계속할까요?')) {
      return;
    }
    st.slots = { base: '', uc: '', chars: [], charUCs: [] };
    st.tabs = [];
    st.dirty = true;
    setMode(false);
  }

  /* ---------- 칸별 입력 ---------- */

  /** 한 칸(카드) 하나를 만든다. 캐릭터 칸만 책갈피와 삭제 버튼을 갖는다. */
  function slotCard(opts) {
    const card = document.createElement('div');
    card.className = 'slot-card' + (opts.char ? ' char' : '') + (opts.absent ? ' absent' : '');

    const head = document.createElement('div');
    head.className = 'slot-head';

    const name = document.createElement('span');
    name.className = 'slot-name';
    name.textContent = opts.label;
    head.appendChild(name);

    if (opts.tag) {
      const t = document.createElement('span');
      t.className = 'slot-tag';
      t.textContent = opts.tag;
      if (opts.tagTitle) t.title = opts.tagTitle;
      head.appendChild(t);
    }

    const mkArea = (key, value, placeholder) => {
      const ta = document.createElement('textarea');
      ta.rows = 2;
      ta.spellcheck = false;
      ta.dataset.slot = key;
      ta.value = value || '';
      ta.placeholder = placeholder;
      return ta;
    };

    if (!opts.char) {
      card.append(head, mkArea(opts.key, opts.value, '비워두면 이 칸은 건드리지 않습니다'));
      return card;
    }

    /* 책갈피 — 프롬프트와 UC가 한 칸을 나눠 쓴다.
       감춘 쪽 textarea는 DOM에 그대로 남는다. 값을 자바스크립트로 옮겨 담지 않는 편이
       "화면에 없는 값이 사라지는" 부류의 버그를 아예 만들지 않는다. */
    const marks = document.createElement('div');
    marks.className = 'bookmarks';
    marks.setAttribute('role', 'tablist');

    const pArea = mkArea('c' + opts.index, opts.value, '비워두면 이 칸은 건드리지 않습니다');
    const uArea = mkArea('u' + opts.index, opts.uc, 'UC를 비워두면 그 칸은 건드리지 않습니다');

    const tabs = [
      { id: 'p', label: '프롬프트', area: pArea },
      { id: 'u', label: 'UC', area: uArea },
    ];

    const buttons = [];
    for (const t of tabs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.append(t.label);
      const dot = document.createElement('i');
      dot.className = 'dot';
      b.appendChild(dot);
      b.title = t.id === 'u' ? `캐릭터 ${opts.index + 1}의 Undesired Content` : `캐릭터 ${opts.index + 1}의 프롬프트`;
      b.addEventListener('click', () => {
        st.tabs[opts.index] = t.id;
        show(t.id);
        t.area.focus();
      });
      buttons.push({ ...t, btn: b, dot });
      marks.appendChild(b);
    }

    function show(id) {
      for (const t of buttons) {
        const on = t.id === id;
        t.btn.setAttribute('aria-selected', String(on));
        t.area.hidden = !on;
        // 감춰진 쪽에 내용이 있으면 점을 찍는다. 보이는 쪽은 눈으로 확인되니 안 찍는다.
        t.dot.classList.toggle('on', !on && !!t.area.value.trim());
      }
    }

    for (const t of buttons) t.area.addEventListener('input', () => show(st.tabs[opts.index] || 'p'));

    marks.addEventListener('mousedown', (e) => e.preventDefault()); // 포커스 튐 방지
    head.appendChild(marks);

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'slot-remove';
    rm.title = opts.label + ' 칸 삭제';
    rm.setAttribute('aria-label', opts.label + ' 칸 삭제');
    rm.innerHTML = ICON_MINUS;
    rm.addEventListener('click', () => {
      st.slots = collect();
      st.slots.chars.splice(opts.index, 1);
      st.slots.charUCs.splice(opts.index, 1);
      st.tabs.splice(opts.index, 1);
      st.dirty = true;
      renderSlots();
    });
    head.appendChild(rm);

    card.append(head, pArea, uArea);
    show(st.tabs[opts.index] || 'p');
    return card;
  }

  function renderSlots() {
    const box = $('slots');
    box.innerHTML = '';

    box.appendChild(
      slotCard({ key: 'base', label: 'Base Prompt', value: st.slots.base, tag: '전체' })
    );
    box.appendChild(
      slotCard({ key: 'uc', label: 'Undesired Content', value: st.slots.uc, tag: '전체' })
    );

    st.slots.chars.forEach((v, i) => {
      const absent = st.characters.length > 0 && !st.characters.includes(i + 1);
      box.appendChild(
        slotCard({
          char: true,
          index: i,
          label: `캐릭터 ${i + 1}`,
          value: v,
          uc: st.slots.charUCs[i] || '',
          absent,
          tag: absent ? '페이지에 없음' : '',
          tagTitle: absent ? '지금 NovelAI에 이 번호의 캐릭터가 없어 적용할 때 건너뜁니다.' : '',
        })
      );
    });

    $('slot-add').disabled = st.slots.chars.length >= MAX_CHARS;

    // 칸이 늘면 창도 자란다. 저장 버튼이 화면 밖으로 밀려나지 않게 다시 밀어 넣는다.
    NibUI.clampIntoView(root.querySelector('.win'));
  }

  /** 화면에 있는 textarea들을 그대로 읽는다.
   *  trim: 저장할 때만 뒤쪽 빈 칸을 버린다. 다시 그리려고 읽을 때 버리면
   *  "칸 추가"가 방금 지운 자리를 도로 채워 제자리걸음이 된다. */
  function collect(trim = false) {
    const out = { base: '', uc: '', chars: [], charUCs: [] };
    for (const ta of root.querySelectorAll('#slots [data-slot]')) {
      const key = ta.dataset.slot;
      const val = ta.value.trim();
      if (key === 'base') out.base = val;
      else if (key === 'uc') out.uc = val;
      else if (key[0] === 'c') out.chars[Number(key.slice(1))] = val;
      else if (key[0] === 'u') out.charUCs[Number(key.slice(1))] = val;
    }
    const n = Math.max(out.chars.length, out.charUCs.length);
    for (let i = 0; i < n; i++) {
      out.chars[i] = out.chars[i] || '';
      out.charUCs[i] = out.charUCs[i] || '';
    }
    if (trim) {
      // 프롬프트와 UC가 **둘 다** 빈 칸만 버린다. UC만 채운 칸을 잃으면 안 된다.
      while (out.chars.length && !out.chars[out.chars.length - 1] && !out.charUCs[out.charUCs.length - 1]) {
        out.chars.pop();
        out.charUCs.pop();
      }
    }
    return out;
  }

  /* ---------- 열기 · 닫기 ---------- */

  function openPresetEditor(payload) {
    if (!host) build();

    const item = payload?.item || null;
    st.categories = Array.isArray(payload?.categories) ? payload.categories : [];
    st.characters = Array.isArray(payload?.characters) ? payload.characters : [];
    st.charSlot = payload?.charSlot || 1;
    st.id = item?.id ?? null;
    st.dirty = false;

    $('title').textContent = item?.id ? 'Nib · 프리셋 편집' : 'Nib · 새 프리셋';
    $('name').value = item?.name || '';
    $('tags').value = item?.tags || '';
    $('msg').textContent = '';
    setEmoji(item?.emoji || '');
    toggleEmoji(false);

    const cat = $('category');
    cat.innerHTML = '';
    for (const c of st.categories) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      cat.appendChild(o);
    }
    cat.value = item?.category || 'style';
    $('target').value =
      item?.target || st.categories.find((c) => c.id === cat.value)?.target || 'base';

    const slots = normalizeSlots(item?.slots);
    // 페이지에 있는 캐릭터 수만큼은 기본으로 칸을 열어둔다 (최소 2, 최대 8)
    const want = Math.min(MAX_CHARS, Math.max(2, st.characters.length, slots.chars.length));
    while (slots.chars.length < want) {
      slots.chars.push('');
      slots.charUCs.push('');
    }
    st.slots = slots;
    // UC만 채워진 칸은 UC 쪽을 펴서 연다. 안 그러면 있는 내용이 안 보인다.
    st.tabs = slots.chars.map((p, i) => (!p.trim() && slots.charUCs[i]?.trim() ? 'u' : 'p'));

    $('delete').hidden = !item?.id;
    setMode(item?.multi === true);

    $('name').focus();
    // 새로 만들 때만 전체 선택. 편집 중인 이름을 통째로 날릴 위험을 만들지 않는다.
    if (!item?.id) $('name').select();
  }

  function close(force = false) {
    if (!host) return;
    if (!force && st.dirty && !confirm('저장하지 않은 내용이 있습니다. 창을 닫을까요?')) return;
    host.remove();
    host = null;
    root = null;
  }

  /* ---------- 저장 ---------- */

  function fail(text) {
    $('msg').textContent = text;
    setTimeout(() => {
      if (root && $('msg').textContent === text) $('msg').textContent = '';
    }, 4000);
  }

  /** 라이브러리는 여기서 직접 쓴다. 사이드 패널이 닫혀 있어도 저장이 남아야 하기 때문이다.
   *  쓰기 직전에 다시 읽어 다른 곳의 변경을 가능한 한 덜 밟는다.
   *
   *  **items만 갈아끼우고 나머지 키(folders, version)는 그대로 옮겨 담는다.**
   *  통째로 `{version, items}`를 써버리면 사이드 패널이 만든 폴더가 조용히 사라진다. */
  async function writeLibrary(mutate) {
    const got = await chrome.storage.local.get(LIB_KEY);
    const lib = got[LIB_KEY] && typeof got[LIB_KEY] === 'object' ? got[LIB_KEY] : {};
    const items = Array.isArray(lib.items) ? lib.items : [];
    const next = mutate(items);
    await chrome.storage.local.set({ [LIB_KEY]: { ...lib, version: lib.version || 2, items: next } });
  }

  async function save() {
    const name = $('name').value.trim();
    if (!name) {
      fail('이름을 입력해 주세요.');
      $('name').focus();
      return;
    }

    const multi = st.multi;
    const tags = $('tags').value.trim();
    const slots = multi ? collect(true) : null;

    if (multi) {
      const filled = [slots.base, slots.uc, ...slots.chars, ...slots.charUCs].some((t) => t.trim());
      if (!filled) {
        fail('칸을 하나 이상 채워 주세요.');
        return;
      }
    } else if (!tags) {
      fail('태그를 입력해 주세요.');
      $('tags').focus();
      return;
    }

    const payload = {
      name,
      tags: multi ? '' : tags,
      multi,
      slots: multi ? slots : null,
      emoji: st.emoji || '',
      category: $('category').value,
      target: $('target').value,
      updatedAt: Date.now(),
    };

    try {
      await writeLibrary((items) => {
        if (st.id) {
          const i = items.findIndex((x) => x.id === st.id);
          if (i >= 0) items[i] = { ...items[i], ...payload };
          else items.unshift({ id: st.id, createdAt: Date.now(), ...payload });
        } else {
          items.unshift({ id: uid(), createdAt: Date.now(), ...payload });
        }
        return items;
      });
    } catch (e) {
      fail('저장하지 못했습니다: ' + (e?.message || e));
      return;
    }

    close(true);
  }

  async function remove() {
    if (!st.id) return;
    if (!confirm(`"${$('name').value.trim() || '이 프리셋'}"을(를) 지웁니다.\n되돌릴 수 없습니다. 계속할까요?`)) return;
    try {
      await writeLibrary((items) => items.filter((x) => x.id !== st.id));
    } catch (e) {
      fail('삭제하지 못했습니다: ' + (e?.message || e));
      return;
    }
    close(true);
  }

  globalThis.openPresetEditor = openPresetEditor;

  NibUI.watchTheme(() => host);
})();
