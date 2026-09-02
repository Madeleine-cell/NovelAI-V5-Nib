/* Nib — 태그 정리기 (독립 모듈)
 *
 * 붙여넣은 프롬프트의 **형태만** 다듬는다. 위 칸에 원본을 넣으면 아래 칸에 결과가 즉시 나온다.
 * 열기: 사이드 패널 → content.js 라우터 → globalThis.openCleaner()
 *
 * ── 하는 것과 안 하는 것 ──────────────────────────────────────────────
 *
 * 한다     WebUI 가중치 → NAI 수치 강조 · 레거시 괄호 → 수치 · 표기 정규화 · 공백과 쉼표 정리
 * 안 한다  어휘 검증, 오탈자 교정, 태그 존재 확인, 의미 분석, 순서 재배치, 외부 통신.
 *
 * 이 파일은 순수 함수 하나(convert)와 그것을 보여주는 창으로 끝난다.
 * 엔진은 openCleaner.convert 로 매달아 두었다 — 콘솔에서 창 없이 바로 잴 수 있다.
 * (파일당 전역 이름은 하나라는 규약을 지키려고 별도 전역을 만들지 않았다.)
 *
 * ── 공식 문서에서 확인한 값 ──────────────────────────────────────────
 * https://docs.novelai.net/en/image/strengthening-weakening/
 *
 *   { }              초점 ×1.05 (쌍마다 곱셈 — {{ }} 는 1.1025)
 *   [ ]              초점 ÷1.05
 *   숫자::텍스트 ::   수치 강조. 숫자 없는 `::` 가 닫기이며, 안 닫힌 괄호도 함께 닫는다
 *   음수             -1 ~ -3 지원. **V4.5 이상에서만** 동작한다
 *   UC 칸            { } 가 회피를 강화한다 — 즉 수치 매핑은 칸과 무관하게 같다. 분기하지 않는다
 *
 * 그래서 순깊이 d에서의 가중치는 1.05^d 이고, 소수 둘째 자리에서 반올림한다.
 * {{{tag}}} 는 1.157625 이므로 **1.16** 이다. 1.15가 아니다.
 *
 * ── 절대 건드리지 않는 것 ────────────────────────────────────────────
 *
 *   줄바꿈    여러 줄로 짠 프롬프트가 한 줄로 뭉개지면 안 된다. 공백 정리에 \s 를 쓰지 말 것
 *             (같은 함정이 content.js 의 readEditor·splitParts 에 실측 기록으로 남아 있다)
 *   맨 괄호   `hakurei reimu (touhou)` 의 괄호는 태그의 일부다. `:숫자` 가 있을 때만 손댄다
 *   태그의 철자와 순서
 */

(() => {
  const HOST_ID = 'nib-cleaner';
  const POS_KEY = 'nib.cleanerPos';
  const MERGE_KEY = 'nib.cleanerMerge';

  /* 문서가 권하는 가중치 범위. 밖으로 나가도 막지 않고 알리기만 한다. */
  const WEIGHT_LIMIT = 3;
  /* 변경 목록을 화면에 몇 줄까지 펼칠지. 나머지는 수만 적는다. */
  const CHANGES_SHOWN = 12;

  let host = null;
  let root = null;
  let merge = false;

  const esc = NibUI.esc;

  /* ══════════════════════════════════════════════════════════════════
     규칙 엔진 — 여기부터는 DOM을 모른다. 문자열 in, 문자열 out.
     ══════════════════════════════════════════════════════════════════ */

  const round2 = (n) => Math.round(n * 100) / 100;
  /* Number→String 이 알아서 꼬리 0을 뗀다: 1.10 → "1.1", 1.05 → "1.05" */
  const fmtNum = (n) => String(round2(n));

  /** 순깊이 d의 가중치. `{` 는 ×1.05, `[` 는 ÷1.05 이므로 곧 1.05^d 다. */
  const weightAtDepth = (d) => round2(Math.pow(1.05, d));

  /** 변경 목록에 보여줄 원래 모양. 순수 중첩일 때만 정확하지만 이건 표시용이다. */
  const bracketLabel = (d, t) =>
    d > 0 ? '{'.repeat(d) + t + '}'.repeat(d) : '['.repeat(-d) + t + ']'.repeat(-d);

  /* ---------- R7. 이스케이프 해제 ----------
     WebUI에서 복사해 오면 `artoria pendragon \(fate\)` 처럼 딸려 온다. NAI는 이스케이프가 없다. */
  function unescapeParens(s, ctx) {
    return s.replace(/\\([()])/g, (m, c) => {
      ctx.changes.push({ rule: '이스케이프', from: m, to: c });
      return c;
    });
  }

  /* ---------- R1. WebUI 가중치 → 수치 강조 ----------
   *
   * **`:숫자` 가 있을 때만 매치한다.** 이것이 이 규칙의 전부다.
   * 맨 괄호까지 잡으면 `hakurei reimu (touhou)` 의 시리즈명이 가중치로 둔갑한다.
   *
   * `[^()]*?` 가 게을러서 콜론이 든 태그도 옳게 걸린다 —
   * `(re:zero:1.2)` 는 `re` 로 시작해 보다가 숫자가 아니어서 되돌아가 `re:zero` 를 고른다.
   * 중첩 대비로 더 이상 안 바뀔 때까지 돌린다. */
  function convertWebUI(s, ctx) {
    const RE = /\(([^()]*?):\s*(-?\d+(?:\.\d+)?|-?\.\d+)\s*\)/g;
    for (let i = 0; i < 8; i++) {
      let hit = false;
      s = s.replace(RE, (m, body, num) => {
        const inner = body.trim();
        if (!inner) return m;
        hit = true;
        const to = num + '::' + inner + '::';
        ctx.changes.push({ rule: 'WebUI 가중치', from: m, to });
        return to;
      });
      if (!hit) break;
    }
    return s;
  }

  /* ---------- R2. 레거시 괄호 → 수치 ----------
   *
   * **정규식이 아니라 스캐너다.** 정규식은 중첩 깊이를 셀 수 없다.
   *
   * 쌍마다 감싸면 안 된다 — `{{tag}}` 를 안쪽부터 두 번 감싸면 `1.05::1.05::tag::::` 가 된다.
   * 글자마다 순깊이를 세어 **같은 깊이가 이어지는 구간**을 한 번에 싸는 이유가 이것이다.
   * `{` 는 +1, `[` 는 -1 이므로 `{[tag]}` 는 순깊이 0 — 괄호만 벗고 가중치는 안 붙는다.
   *
   * 중첩된 `::` 가 서로 곱해지는지는 문서에 없다. 그래서 구간을 **평평하게** 낸다 —
   * 깊이가 바뀌면 열려 있던 것을 닫고 새로 연다.
   *
   * 짝이 안 맞으면 **통째로 그대로 둔다.** `{{{{{rain ::` 는 `::` 가 괄호까지 닫아주는,
   * 문서에 적힌 유효한 입력이다. 임의로 손대면 결과가 바뀐다. */
  function convertBrackets(s, ctx) {
    if (!/[{}[\]]/.test(s)) return s;

    const runs = [];
    const stack = [];
    let depth = 0;
    let buf = '';
    const flush = () => {
      if (buf) runs.push({ depth, text: buf });
      buf = '';
    };

    for (const ch of s) {
      if (ch === '{' || ch === '[') {
        flush();
        stack.push(ch);
        depth += ch === '{' ? 1 : -1;
      } else if (ch === '}' || ch === ']') {
        if (stack[stack.length - 1] !== (ch === '}' ? '{' : '[')) {
          ctx.looseBrackets = true;
          return s;
        }
        flush();
        stack.pop();
        depth += ch === '}' ? -1 : 1;
      } else {
        buf += ch;
      }
    }
    flush();
    if (stack.length) {
      ctx.looseBrackets = true;
      return s;
    }

    return runs
      .map((r) => {
        if (!r.depth) return r.text;
        // 구간의 앞뒤 공백은 가중치 **밖에** 남긴다. `{ tag }` → `1.05::tag::`
        const m = r.text.match(/^(\s*)([\s\S]*?)(\s*)$/);
        if (!m[2]) return r.text;
        const w = weightAtDepth(r.depth);
        const to = w === 1 ? m[2] : fmtNum(w) + '::' + m[2] + '::';
        ctx.changes.push({ rule: '레거시 괄호', from: bracketLabel(r.depth, m[2]), to });
        return m[1] + to + m[3];
      })
      .join('');
  }

  /* ---------- R4. 가중치 표기 정규화 ----------
   *
   * 여는 `숫자::` 와 닫는 `::` 를 짝지어 훑는다. 짝을 봐야 하는 이유는 하나뿐이다 —
   * **곱하기 1은 무의미해서 걷어내는데, 그러려면 짝인 닫기도 같이 지워야 한다.**
   *
   * 숫자 앞의 `(?<![\w.])` 는 `girl2::` 의 `2` 를 가중치로 오해하지 않게 한다.
   * 이 검사가 실패하면 그 자리는 그냥 닫는 `::` 로 읽힌다.
   *
   * 이미 올바른 `1.2::tag::` 는 여기서 자기 자신으로 다시 쓰인다 — 두 번 돌려도 안 늘어난다. */
  function normalizeWeights(s, ctx) {
    const TOK = /(?:(?<![\w.])(-?\d+(?:\.\d+)?|-?\.\d+))?::/g;
    const stack = [];
    let out = '';
    let last = 0;
    let m;

    while ((m = TOK.exec(s)) !== null) {
      out += s.slice(last, m.index);
      last = TOK.lastIndex;

      if (m[1] == null) {
        // 닫기
        if (!stack.length) {
          // 짝 없는 닫기. 다만 괄호가 안 맞아 그대로 둔 입력이면 그쪽 알림으로 충분하다.
          if (!ctx.looseBrackets) ctx.warnings.push('짝을 찾지 못한 `::` 가 있습니다.');
          out += m[0];
          continue;
        }
        if (!stack.pop().drop) out += '::';
        continue;
      }

      // 열기
      const w = round2(Number(m[1]));
      if (!Number.isFinite(w)) {
        out += m[0];
        continue;
      }
      if (w < 0) ctx.hasNeg = true;
      if (Math.abs(w) > WEIGHT_LIMIT) {
        ctx.warnings.push(`가중치 ${fmtNum(w)} 는 문서가 권하는 범위(-3 ~ 3) 밖입니다.`);
      }
      if (w === 1) {
        // 곱하기 1 — 여는 쪽도 닫는 쪽도 안 남긴다.
        stack.push({ drop: true });
        ctx.changes.push({ rule: '무의미한 가중치', from: m[0], to: '(삭제)' });
        continue;
      }
      stack.push({ drop: false });
      const canon = fmtNum(w) + '::';
      if (canon !== m[0]) ctx.changes.push({ rule: '표기 정규화', from: m[0], to: canon });
      out += canon;
    }

    out += s.slice(last);
    if (stack.length) ctx.warnings.push('닫히지 않은 `::` 구간이 있습니다.');
    return out;
  }

  /* ---------- R5. 공백과 쉼표 ----------
   *
   * **`\s` 를 쓰면 안 된다.** 줄바꿈까지 먹어 여러 줄 프롬프트가 한 줄로 뭉개진다.
   * 가로 공백만 건드리려고 `[^\S\n]` 과 `[ ]` 만 쓴다. */
  function tidy(s) {
    return (
      s
        .replace(/[^\S\n]+/g, ' ')
        // 여는 `숫자::` 바로 뒤와 닫는 `::` 바로 앞의 공백을 턴다.
        //
        // **닫기 앞은 숫자로 끝날 때 건드리면 안 된다.** `hp 5 ::` 의 공백을 지우면
        // `hp 5::` 가 되고, 다음 실행에서 그 `5` 가 여는 가중치로 읽힌다 —
        // 한 번 더 돌렸다고 결과가 달라지면 정리기가 아니다. 그래서 앞 글자를 보고 판단한다.
        .replace(/(-?\d+(?:\.\d+)?::)[ ]+/g, '$1')
        .replace(/([^\d. ])[ ]+::/g, '$1::')
        // 내용이 사라져 껍데기만 남은 강조
        .replace(/(?<![\w.])-?\d+(?:\.\d+)?::[ ]*::/g, '')
        .replace(/[ ]*,[ ]*/g, ', ')
        .replace(/(?:,[ ]*){2,}/g, ', ')
        .replace(/[ ]*\n[ ]*/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^[\s,]+/, '')
        .replace(/[\s,]+$/, '')
    );
  }

  /* ---------- R6. 인접한 같은 가중치 병합 (기본 꺼짐) ----------
   *
   * `1.1::a::, 1.1::b::` → `1.1::a, b::`
   *
   * **같은 줄 안에서만** 붙인다(`[^\n]`). 줄을 넘으면 위에서 지킨 줄 구조가 무너진다.
   *
   * 기본을 끈 이유: 병합하면 구분자 `, ` 가 가중치 구간 **안으로** 들어간다.
   * 두 형태의 출력이 같다는 근거를 공식 문서에서 못 찾았다. 확인 전까지는 사용자가 켠다. */
  function mergeAdjacent(s, ctx) {
    const RE = /(-?\d+(?:\.\d+)?)::((?:(?!::)[^\n])*)::([ \t]*,[ \t]*)(-?\d+(?:\.\d+)?)::/g;
    for (let i = 0; i < 40; i++) {
      let hit = false;
      s = s.replace(RE, (m, w1, body, sep, w2) => {
        if (w1 !== w2) return m;
        hit = true;
        ctx.changes.push({
          rule: '인접 병합',
          from: `${w1}::${body}::${sep}${w2}::…`,
          to: `${w1}::${body}${sep}…`,
        });
        return `${w1}::${body}${sep}`;
      });
      if (!hit) break;
    }
    return s;
  }

  /* ---------- 맨 괄호 알림 ----------
   *
   * WebUI의 `(masterpiece)` 는 강조지만 `hakurei reimu (touhou)` 의 괄호는 태그의 일부다.
   * 기계적으로 구분할 방법이 없으므로 **바꾸지 않고 알리기만** 한다.
   *
   * 가르는 선은 위치다 — 구분자 사이의 토막이 통째로 괄호에 싸여 있으면 강조로 본다.
   * danbooru 태그의 괄호는 언제나 이름 **뒤에** 붙으므로 이 검사에 안 걸린다. */
  function scanBareParens(s, ctx) {
    for (const seg of s.split(/[,\n]/)) {
      const t = seg.trim();
      if (t.length > 2 && t.startsWith('(') && t.endsWith(')')) {
        ctx.warnings.push(`${t} — 괄호 강조로 보이지만 수치가 없어 그대로 두었습니다.`);
      }
    }
  }

  /** 태그 정리기의 전부. 순서가 곧 규칙이다. */
  function convert(input, opt) {
    const ctx = { changes: [], warnings: [], looseBrackets: false, hasNeg: false };

    // 0. NBSP는 소스에서 보통 공백과 구분되지 않는다. 글자를 직접 넣지 말고 이스케이프로 쓴다.
    let s = String(input ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/\u00a0/g, ' ');

    s = unescapeParens(s, ctx);
    s = convertWebUI(s, ctx);
    s = convertBrackets(s, ctx);
    s = normalizeWeights(s, ctx);
    s = tidy(s);
    if (opt && opt.merge) s = mergeAdjacent(s, ctx);

    scanBareParens(s, ctx);
    if (ctx.looseBrackets) {
      ctx.warnings.push('짝이 맞지 않는 중괄호·대괄호가 있어 괄호 변환을 건너뛰었습니다.');
    }
    if (ctx.hasNeg) {
      ctx.warnings.push('음수 가중치는 V4.5 이상 모델에서만 동작합니다.');
    }

    return { text: s, changes: ctx.changes, warnings: [...new Set(ctx.warnings)] };
  }

  /* ══════════════════════════════════════════════════════════════════
     창
     ══════════════════════════════════════════════════════════════════ */

  const CSS =
    NibUI.shellCSS('560px') +
    `
    .foot {
      display: flex; align-items: center; gap: 9px; flex: 0 0 auto;
      padding: 10px 13px; background: var(--shell);
      border-top: 1px solid var(--hairline);
    }
    .sec { padding: 12px 13px; }
    .sec + .sec { border-top: 1px solid var(--hairline); }
    .lab {
      display: flex; align-items: center; gap: 7px; margin-bottom: 8px;
      font-family: var(--font-mono); font-size: 10px; font-weight: 600;
      letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3);
    }
    textarea {
      display: block; width: 100%; resize: vertical;
      font-family: var(--font-mono); font-size: 12px; line-height: 1.65;
      padding: 9px 10px; border-radius: var(--r-ctl);
      border: 1px solid var(--hairline-2); background: var(--surface); color: var(--ink);
      transition: border-color .18s var(--ease);
    }
    textarea:focus { outline: none; border-color: var(--accent-line); }
    textarea#in { min-height: 96px; height: 118px; }
    textarea#out { min-height: 96px; height: 118px; background: var(--sunken); color: var(--ink-2); }
    textarea::placeholder { color: var(--ink-3); opacity: .75; }

    .mini {
      font: inherit; font-size: 10px; font-weight: 600; letter-spacing: .04em;
      cursor: pointer; padding: 2px 8px; border-radius: var(--r-chip);
      border: 1px solid var(--hairline-2); background: var(--surface); color: var(--ink-3);
      text-transform: none;
      transition: background-color .18s var(--ease), color .18s var(--ease);
    }
    .mini:hover { background: var(--raised); color: var(--ink); }
    .mini:disabled { opacity: .4; cursor: not-allowed; }

    .stat { font-size: 10px; letter-spacing: .04em; color: var(--ink-3); text-transform: none; }
    .stat b { color: var(--accent-hi); font-weight: 600; }
    .stat b.warn { color: var(--warn); }

    .rows { margin-top: 9px; display: grid; gap: 3px; }
    .row {
      display: grid; grid-template-columns: 74px 1fr; gap: 0 8px; align-items: baseline;
      font-size: 11px; line-height: 1.5;
    }
    .row .r {
      font-family: var(--font-mono); font-size: 9.5px; letter-spacing: .04em;
      color: var(--ink-3); text-align: right;
    }
    .row .d { font-family: var(--font-mono); font-size: 11px; color: var(--ink-2); word-break: break-all; }
    .row .d s { color: var(--ink-3); text-decoration-color: var(--hairline-2); }
    .row .d i { color: var(--ink-3); font-style: normal; }
    .row .d em { color: var(--good); font-style: normal; }
    .more { font-size: 11px; color: var(--ink-3); padding-left: 82px; margin-top: 3px; }

    .note {
      display: grid; grid-template-columns: auto 1fr; gap: 0 8px;
      border-radius: var(--r-ctl); padding: 8px 10px; margin-top: 9px;
      font-size: 11.5px; line-height: 1.55;
      background: var(--sunken); border: 1px solid var(--warn); color: var(--ink);
    }
    .note .t {
      font-family: var(--font-mono); font-size: 9.5px; font-weight: 600;
      letter-spacing: .08em; text-transform: uppercase; color: var(--warn); padding-top: 2px;
    }
    .note ul { margin: 0; padding-left: 15px; }
    .note li + li { margin-top: 3px; }

    .chk {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 11.5px; color: var(--ink-2); cursor: pointer; user-select: none;
    }
    .chk input { accent-color: var(--accent); width: 13px; height: 13px; cursor: pointer; }
    .msg { font-size: 11.5px; font-weight: 500; }
    .msg.good { color: var(--good); }
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
        ${NibUI.markSVG('cl')}
        <span class="title">Nib · 태그 정리</span>
        <span class="spacer"></span>
        <button class="hbtn" id="close" title="닫기 (Esc)">✕</button>
      </div>
      <div class="body">
        <div class="sec">
          <div class="lab">
            원본
            <span class="spacer"></span>
            <button type="button" class="mini" id="wipe">지우기</button>
          </div>
          <textarea id="in" spellcheck="false" autocomplete="off"
            placeholder="(blue eyes:1.2), {{masterpiece}}, [wind], hakurei reimu (touhou)"></textarea>
        </div>
        <div class="sec">
          <div class="lab">
            결과
            <span class="spacer"></span>
            <span class="stat" id="stat"></span>
            <button type="button" class="mini" id="copy">복사</button>
          </div>
          <textarea id="out" readonly spellcheck="false"></textarea>
          <div id="notes"></div>
        </div>
      </div>
      <div class="foot">
        <label class="chk" title="가중치 구간 안으로 구분자가 들어갑니다. 출력이 같다는 근거를 공식 문서에서 찾지 못해 기본은 꺼둡니다.">
          <input type="checkbox" id="merge"> 인접한 같은 가중치 병합
        </label>
        <span class="spacer"></span>
        <span class="msg" id="msg"></span>
      </div>`;

    root.append(style, win);
    document.documentElement.appendChild(host);

    root.getElementById('close').addEventListener('click', close);
    root.getElementById('in').addEventListener('input', run);
    root.getElementById('copy').addEventListener('click', onCopy);
    root.getElementById('wipe').addEventListener('click', () => {
      const el = root.getElementById('in');
      el.value = '';
      el.focus();
      run();
    });
    root.getElementById('merge').addEventListener('change', (e) => {
      merge = e.target.checked;
      chrome.storage.local.set({ [MERGE_KEY]: merge }).catch(() => {});
      run();
    });

    NibUI.makeDraggable(win, root.getElementById('head'), POS_KEY);
    NibUI.restorePosition(win, POS_KEY, () => ({
      x: Math.max(10, Math.round((window.innerWidth - 560) / 2)),
      y: 56,
    }));
    NibUI.syncTheme(host);
  }

  /* ---------- 그리기 ---------- */

  /** 변경 한 줄. 지운 것과 넣은 것을 나란히 보여준다. */
  const changeRow = (c) =>
    `<div class="row"><span class="r">${esc(c.rule)}</span><span class="d">` +
    `<s>${esc(c.from)}</s> <i>→</i> ` +
    (c.to === '(삭제)' ? '<i>삭제</i>' : `<em>${esc(c.to)}</em>`) +
    '</span></div>';

  function run() {
    const src = root.getElementById('in').value;
    const res = convert(src, { merge });

    root.getElementById('out').value = res.text;

    const stat = root.getElementById('stat');
    if (!src.trim()) {
      stat.innerHTML = '';
    } else if (!res.changes.length && !res.warnings.length) {
      stat.textContent = '고칠 것 없음';
    } else {
      const parts = [];
      if (res.changes.length) parts.push(`<b>${res.changes.length}</b>건 고침`);
      if (res.warnings.length) parts.push(`<b class="warn">${res.warnings.length}</b>건 알림`);
      stat.innerHTML = parts.join(' · ');
    }

    let html = '';
    if (res.changes.length) {
      html += `<div class="rows">${res.changes.slice(0, CHANGES_SHOWN).map(changeRow).join('')}</div>`;
      if (res.changes.length > CHANGES_SHOWN) {
        html += `<div class="more">외 ${res.changes.length - CHANGES_SHOWN}건</div>`;
      }
    }
    if (res.warnings.length) {
      html +=
        '<div class="note"><span class="t">알림</span><ul>' +
        res.warnings.map((w) => `<li>${esc(w)}</li>`).join('') +
        '</ul></div>';
    }
    root.getElementById('notes').innerHTML = html;

    root.getElementById('copy').disabled = !res.text;
  }

  let sayTimer = 0;
  function say(text) {
    const el = root && root.getElementById('msg');
    if (!el) return;
    el.textContent = text;
    el.className = 'msg good';
    clearTimeout(sayTimer);
    sayTimer = setTimeout(() => {
      const m = root && root.getElementById('msg');
      if (m) m.textContent = '';
    }, 2000);
  }

  async function onCopy() {
    const text = root.getElementById('out').value;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      say('복사했습니다.');
    } catch {
      // 클립보드가 막히면 선택만 해준다 — 사용자가 Ctrl+C 를 누를 수 있다.
      const out = root.getElementById('out');
      out.focus();
      out.select();
      say('Ctrl+C 로 복사해 주세요.');
    }
  }

  /* ---------- 열고 닫기 ---------- */

  async function openCleaner() {
    if (host) {
      close();
      return;
    }
    try {
      const got = await chrome.storage.local.get(MERGE_KEY);
      merge = got[MERGE_KEY] === true;
    } catch {
      merge = false;
    }

    build();
    root.getElementById('merge').checked = merge;
    run();
    root.getElementById('in').focus();
    document.addEventListener('keydown', onKey, true);
  }

  function onKey(e) {
    if (e.key === 'Escape' && host) {
      e.stopPropagation();
      close();
    }
  }

  function close() {
    document.removeEventListener('keydown', onKey, true);
    clearTimeout(sayTimer);
    if (host) host.remove();
    host = null;
    root = null;
  }

  /* 전역은 하나다. 순수 엔진은 그 위에 매달아 콘솔에서 창 없이 잴 수 있게 둔다. */
  openCleaner.convert = convert;
  globalThis.openCleaner = openCleaner;

  NibUI.watchTheme(() => host);
})();
