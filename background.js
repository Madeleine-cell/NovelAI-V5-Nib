/* Nib — 서비스 워커
 *
 *  1) 툴바 아이콘 → 사이드 패널
 *  2) 사용량 원장(ledger)의 유일한 기록자
 *
 * 원장을 여기서만 쓰는 이유:
 *   chrome.storage 는 읽고-고치고-쓰는 사이에 원자성이 없다. NovelAI 탭을 두 개 열어두면
 *   양쪽 콘텐츠 스크립트가 동시에 써서 기록이 조용히 사라진다.
 *   서비스 워커는 프로필당 하나뿐이므로, 여기서 프로미스 체인으로 직렬화하면 그 경합이 사라진다.
 *   콘텐츠 스크립트는 절대 원장을 직접 쓰지 않는다. 메시지만 보낸다.
 */

const LEDGER_KEY = 'nib.ledger';
const LEGACY_KEY = 'nib.usage'; // v1의 잘못된 계산 결과. 발견하면 지운다.

const MAX_GENS = 8000;
const MAX_MARKS = 3000;
const MAX_IDS = 400;

/* ---------- 사이드 패널 ---------- */

function applyPanelBehavior() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn('[Nib] setPanelBehavior 실패:', e?.message || e));
}

applyPanelBehavior();
chrome.runtime.onInstalled.addListener(applyPanelBehavior);
chrome.runtime.onStartup.addListener(applyPanelBehavior);

chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (tab?.windowId != null) await chrome.sidePanel.open({ windowId: tab.windowId });
    else if (tab?.id != null) await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    console.warn('[Nib] 사이드 패널을 열지 못했습니다:', e?.message || e);
  }
});

/* ---------- 원장 ---------- */

function emptyLedger() {
  return {
    version: 2,
    spp: null,
    marks: [], // { t, p, s? }  p는 부호 있는 정수 퍼센트, s는 그때의 회복 주기(초/1%)
    gens: [], // { id, t, n, model, free, ref, cost, sig }  cost: 숫자 | null(모름) | 없음(측정 전)
    ids: [], // 최근 처리한 생성 id (중복 방지)
    current: null, // { t, p, tun, isNegative }
    anlas: null, // { t, v }  화면의 Anlas 잔액 = 지급분 + 구매분
    anlasFixed: 0, // 옛 원장의 Anlas 기록을 한 번 정리했는가 (repairAnlas)
  };
}

/** 옛 원장의 Anlas 기록을 **한 번만** 정리한다 — 새 규칙은 새로 들어오는 값에만 걸리므로,
 *  이미 쌓인 "충전 −9918"(음수)과 "앞 null, 뒤 2배"는 그대로 화면에 남아 있었다(2026-09-23 브라우저 확인).
 *  recordAnlasCost 와 같은 규칙(음수 → null, splitDoubled)을 시각순으로 한 번 돌린다. 합계는 바뀌지 않는다. */
function repairAnlas(l) {
  if (l.anlasFixed >= 1) return false;
  for (const g of l.gens) if (Number.isFinite(g.cost) && g.cost < 0) g.cost = null;
  for (let i = 1; i < l.gens.length; i++) splitDoubled(l, i);
  l.anlasFixed = 1;
  return true;
}

function normalize(raw) {
  if (!raw || raw.version !== 2) return emptyLedger();
  const l = emptyLedger();
  if (Number.isFinite(raw.spp) && raw.spp > 0) l.spp = raw.spp;
  /* marks 와 gens 는 **시간순이라는 전제 위에서** 읽힌다 — recordUsage 는 마지막 칸을 "지금 값"으로
     보고, overlay.js 의 percentAt · sppAt · dropAnchors 는 앞에서부터 훑다 멈춘다. gens 는 넣을 때마다
     정렬하므로, 읽어 들일 때 marks 도 같이 세워 두 목록의 규칙을 하나로 맞춘다. */
  if (Array.isArray(raw.marks)) {
    l.marks = raw.marks
      .filter((m) => m && Number.isFinite(m.t) && Number.isFinite(m.p))
      .sort((a, b) => a.t - b.t);
  }
  if (Array.isArray(raw.gens)) {
    l.gens = raw.gens.filter((g) => g && Number.isFinite(g.t) && Number.isFinite(g.n)).sort((a, b) => a.t - b.t);
  }
  if (Array.isArray(raw.ids)) l.ids = raw.ids.filter((x) => typeof x === 'string');
  /* marks·gens와 같은 잣대로 잰다 — 시각이 없는 칸은 버린다. overlay.js의 analyze는
     current.t를 구간의 끝으로 쓰므로, 여기서 새면 화면의 숫자가 통째로 NaN이 된다. */
  if (raw.current && Number.isFinite(raw.current.p) && Number.isFinite(raw.current.t)) {
    l.current = raw.current;
  }
  if (raw.anlas && Number.isFinite(raw.anlas.v) && Number.isFinite(raw.anlas.t)) {
    l.anlas = raw.anlas;
  }
  if (Number.isFinite(raw.anlasFixed)) l.anlasFixed = raw.anlasFixed;
  return l;
}

// 모든 원장 접근을 한 줄로 세운다.
let chain = Promise.resolve();

function withLedger(fn) {
  const next = chain.then(async () => {
    const store = await chrome.storage.local.get([LEDGER_KEY, LEGACY_KEY]);
    if (store[LEGACY_KEY] !== undefined) {
      await chrome.storage.local.remove(LEGACY_KEY);
    }
    const ledger = normalize(store[LEDGER_KEY]);
    const repaired = repairAnlas(ledger); // 한 번만 돈다 — 그 뒤로는 anlasFixed 로 건너뛴다
    const result = await fn(ledger);
    if ((result && result.dirty) || repaired) {
      await chrome.storage.local.set({ [LEDGER_KEY]: ledger });
    }
    return result ? result.value : undefined;
  });
  // 한 번의 실패가 이후 모든 기록을 막지 않도록 체인은 항상 성공 상태로 잇는다.
  chain = next.catch((e) => {
    console.warn('[Nib] 원장 처리 실패:', e?.message || e);
  });
  return next;
}

const nowSane = (t) => {
  const now = Date.now();
  // 시계가 튀었거나 말이 안 되는 시각은 현재 시각으로 대체한다.
  if (!Number.isFinite(t) || t > now + 60000 || t < now - 7 * 24 * 3600 * 1000) return now;
  return t;
};

function recordUsage(ledger, msg) {
  const p = msg.isNegative ? -Math.abs(msg.percent) : msg.percent;
  if (!Number.isFinite(p)) return false;
  const t = nowSane(msg.at);

  /* 한 번만 다듬고 아래에서는 이 값만 본다.
     날것을 그대로 current 에 넣으면 undefined 가 null 로 굳어, 다음번 비교에서
     null !== undefined 가 되어 값이 그대로인데도 매번 저장이 일어난다. */
  const tun = Number.isFinite(msg.timeUntilNextPercent) ? msg.timeUntilNextPercent : null;

  let dirty = false;

  // timeUntilNextPercent 는 회복 주기 상수다. 값이 바뀌면(요금제 변경 등) 따라간다.
  if (tun !== null && tun > 0 && ledger.spp !== tun) {
    ledger.spp = tun;
    dirty = true;
  }

  /* 마크마다 그때의 회복 주기(s)를 함께 남긴다. 주기는 바뀐다(7888 → 6048을 실제로 겪었다) —
     최신 값 하나만 들고 있으면 바뀌기 전 구간의 회복분을 새 값으로 잘못 되돌린다.
     퍼센트가 그대로여도 주기가 바뀌면 마크를 남겨 경계를 긋는다. */
  const last = ledger.marks[ledger.marks.length - 1];
  const sppMoved = tun !== null && tun > 0 && last && last.s !== tun;
  if (!last || last.p !== p || sppMoved) {
    const mark = { t, p };
    if (tun !== null && tun > 0) mark.s = tun;
    ledger.marks.push(mark);
    if (ledger.marks.length > MAX_MARKS) ledger.marks.splice(0, ledger.marks.length - MAX_MARKS);
    dirty = true;
  }

  const cur = ledger.current;
  if (!cur || cur.p !== p || cur.tun !== tun || t - cur.t > 60000) {
    ledger.current = { t, p, tun, isNegative: !!msg.isNegative };
    dirty = true;
  }

  // Anlas 잔액은 회복이 없어 값이 바뀔 때만 남기면 된다.
  if (Number.isFinite(msg.anlas) && (!ledger.anlas || ledger.anlas.v !== msg.anlas)) {
    ledger.anlas = { t, v: msg.anlas };
    dirty = true;
  }

  return dirty;
}

function recordGeneration(ledger, msg) {
  if (typeof msg.id !== 'string') return false;
  if (ledger.ids.includes(msg.id)) return false; // 중복 전달 방어

  const n = Number.isFinite(msg.images) && msg.images > 0 ? Math.min(64, Math.floor(msg.images)) : 1;
  const entry = { id: msg.id, t: nowSane(msg.at), n };
  if (typeof msg.model === 'string') entry.model = msg.model;
  if (typeof msg.free === 'boolean') entry.free = msg.free;
  // 캐릭터 레퍼런스(V4.5 전용 — V5에는 아직 없다). free 하나로는 "레퍼런스 때문에 과금"과
  // "여러 장이라 과금"을 못 가른다.
  if (typeof msg.ref === 'boolean') entry.ref = msg.ref;
  // 크기·스텝 서명. Anlas 단가 예측은 서명이 같은 표본만 써야 한다.
  if (typeof msg.sig === 'string') entry.sig = msg.sig;

  ledger.gens.push(entry);
  ledger.gens.sort((a, b) => a.t - b.t);
  if (ledger.gens.length > MAX_GENS) ledger.gens.splice(0, ledger.gens.length - MAX_GENS);

  ledger.ids.push(msg.id);
  if (ledger.ids.length > MAX_IDS) ledger.ids.splice(0, ledger.ids.length - MAX_IDS);

  return true;
}

/** 나중에 도착하는 차감액을 이미 기록된 생성에 붙인다.
 *  gens 는 id 를 들고 있고 ids 가 중복을 막으므로, 짝은 id 하나로 정확히 맞는다. */
function recordAnlasCost(ledger, msg) {
  if (typeof msg.id !== 'string') return false;
  const i = ledger.gens.findIndex((x) => x.id === msg.id);
  if (i < 0) return false;
  const g = ledger.gens[i];
  // 음수는 차감이 아니라 충전이다(page.js가 거르지만 옛 탭에서 올 수 있다).
  const cost = Number.isFinite(msg.cost) && msg.cost >= 0 ? msg.cost : null;
  if (g.cost === cost) return false;
  g.cost = cost;
  splitDoubled(ledger, i);
  return true;
}

/** 과금 생성을 연달아 누르면 앞 생성의 차감이 화면에 늦게 떠서 "앞 null, 뒤 2배"로 찍힌다
 *  (2026-09-23 원장: 1024×1536 32 Anlas가 null → 64). 합계는 맞지만 장당 값이 틀린다.
 *
 *  **값이 정확히 맞을 때만** 나눈다 — 두 생성의 서명(w×h×steps)별로 이미 잰 단가가 3건 이상 같은 값으로
 *  있고, 뒤 생성의 값이 그 둘의 합과 정확히 같을 때. 그 밖에는 손대지 않는다(추측으로 나누지 않는다). */
function splitDoubled(ledger, i) {
  const b = ledger.gens[i];
  const a = ledger.gens[i - 1];
  /* "앞 2배, 뒤 null"이나 두 칸 건너 찍히는 경우도 있지만 짝을 확정할 수 없어 손대지 않는다 —
     2026-09-23 원장으로 돌려 보니 그 규칙을 더해도 바로잡힌 수가 같았다(21건). */
  if (!a || !a.sig || !b.sig) return;
  if (a.cost !== null || a.free !== false || !(b.cost > 0)) return;
  const pa = unitPriceOf(ledger, a.sig);
  // 뒤 생성이 무료가 확실하면 그 몫은 0. 무료인지 모르면(null) 나누지 않는다.
  const pb = b.free === true ? 0 : b.free === false ? unitPriceOf(ledger, b.sig) : null;
  if (pa == null || pb == null || pa + pb !== b.cost) return;
  a.cost = pa;
  b.cost = pb;
}

/** 이 서명(w×h×steps) 한 장의 Anlas 단가. 가장 흔한 값이 3건 이상이고 과반일 때만 — 아니면 null. */
function unitPriceOf(ledger, sig) {
  const seen = {};
  for (const x of ledger.gens) {
    if (x.sig === sig && x.n === 1 && x.cost > 0) seen[x.cost] = (seen[x.cost] || 0) + 1;
  }
  const all = Object.values(seen).reduce((s, v) => s + v, 0);
  const [top, cnt] = Object.entries(seen).sort((p, q) => q[1] - p[1])[0] || [];
  return cnt >= 3 && cnt * 2 > all ? Number(top) : null;
}

/* ---------- 메시지 ---------- */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.cmd !== 'string' || !msg.cmd.startsWith('ledger.')) return;

  (async () => {
    try {
      switch (msg.cmd) {
        case 'ledger.usage':
          await withLedger((l) => ({ dirty: recordUsage(l, msg) }));
          sendResponse({ ok: true });
          break;

        case 'ledger.gen':
          await withLedger((l) => ({ dirty: recordGeneration(l, msg) }));
          sendResponse({ ok: true });
          break;

        case 'ledger.anlas':
          await withLedger((l) => ({ dirty: recordAnlasCost(l, msg) }));
          sendResponse({ ok: true });
          break;

        case 'ledger.get': {
          const value = await withLedger((l) => ({ dirty: false, value: l }));
          sendResponse({ ok: true, ledger: value || emptyLedger() });
          break;
        }

        /* 원장을 다운로드 폴더에 파일로 떨군다. 페이지에서 <a download>로 내리면 NovelAI 페이지 안에서
           조용히 막혔다(파일이 안 생김) — 확장의 downloads API는 페이지와 무관하게 동작한다.
           서비스 워커엔 URL.createObjectURL이 없어 data: URL로 넘긴다(원장은 수십 KB). */
        case 'ledger.export': {
          const value = await withLedger((l) => ({ dirty: false, value: l }));
          const json = JSON.stringify(value || emptyLedger());
          const d = new Date();
          const p2 = (n) => String(n).padStart(2, '0');
          const name =
            `nib-ledger-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-` +
            `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.json`;
          const id = await chrome.downloads.download({
            url: 'data:application/json;charset=utf-8,' + encodeURIComponent(json),
            filename: name,
            conflictAction: 'uniquify',
            saveAs: false,
          });
          // 실제 저장 경로를 돌려준다 — 사용자의 다운로드 폴더가 기본값이 아닐 수 있다.
          let path = name;
          for (let i = 0; i < 20; i++) {
            const [item] = await chrome.downloads.search({ id });
            if (item?.state === 'complete') { path = item.filename || name; break; }
            if (item?.state === 'interrupted') throw new Error('다운로드 중단: ' + (item.error || '원인 모름'));
            await new Promise((r) => setTimeout(r, 150));
          }
          sendResponse({ ok: true, path });
          break;
        }

        case 'ledger.reset':
          await withLedger((l) => {
            l.marks = [];
            l.gens = [];
            l.ids = [];
            return { dirty: true };
          });
          sendResponse({ ok: true });
          break;

        default:
          sendResponse({ ok: false, error: 'unknown ledger command' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();

  return true; // 비동기 응답
});
