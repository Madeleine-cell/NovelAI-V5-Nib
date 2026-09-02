/* Nib — 사이드 패널 로직 */

/* 저장 키는 전부 여기 모은다. 흩어 두면 같은 키를 두 이름으로 부르게 된다. */
const LIB_KEY = 'nib.library';
const SLOT_KEY = 'nib.charSlot';
const HIDE_SUGGEST_KEY = 'nib.hideSuggestions';
const FLAT_VIEWER_KEY = 'nib.flatViewer';
const THEME_KEY = 'nib.theme';
const LEDGER_KEY = 'nib.ledger';

const CATEGORIES = [
  { id: 'artist', name: '작가', target: 'base' },
  { id: 'character', name: '캐릭터', target: 'char' },
  { id: 'style', name: '화풍', target: 'base' },
  { id: 'scene', name: '씬·배경', target: 'base' },
  { id: 'negative', name: 'UC', target: 'uc' },
  { id: 'etc', name: '기타', target: 'base' },
];

const TARGET_LABEL = {
  base: 'Base',
  uc: 'UC',
  char: '캐릭터',
  charuc: '캐릭터 UC',
};

const state = {
  items: [],
  folders: [],
  category: 'all',
  query: '',
  charSlot: 1,
  page: { onNovelAI: false, characters: [], base: '', uc: '', charTexts: [] },
  dragId: null, // 지금 끌고 있는 카드의 id
};

/* ---------- 저장소 ----------
 *
 * version 2에서 `folders`가 생겼다. version 1 라이브러리에는 그 키가 없으므로
 * 없으면 빈 배열로 본다 — 프리셋은 전부 폴더 밖에 있는 상태가 된다.
 * **읽는 쪽은 항상 이 두 함수를 거친다.** 편집 창(editor.js)도 items만 갈아끼우고
 * 나머지 키는 그대로 둔다. 통째로 덮으면 폴더가 조용히 날아간다.
 */

const LIB_VERSION = 2;

async function loadLibrary() {
  const got = await chrome.storage.local.get([LIB_KEY, SLOT_KEY]);
  const lib = got[LIB_KEY];
  state.items = Array.isArray(lib?.items) ? lib.items : [];
  state.folders = Array.isArray(lib?.folders) ? lib.folders : [];
  state.charSlot = got[SLOT_KEY] || 1;
}

async function saveLibrary() {
  await chrome.storage.local.set({
    [LIB_KEY]: { version: LIB_VERSION, items: state.items, folders: state.folders },
  });
  backupToFolder().catch(() => {});
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const $ = (sel) => document.querySelector(sel);

/* ---------- NovelAI 탭과 통신 ---------- */

async function novelaiTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.url?.startsWith('https://novelai.net/')) return active;
  const [any] = await chrome.tabs.query({ url: 'https://novelai.net/*' });
  return any || null;
}

async function send(msg) {
  const tab = await novelaiTab();
  if (!tab) return { ok: false, error: 'NovelAI 탭이 열려 있지 않습니다.' };
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    // 확장을 방금 설치했거나 새로고침 전이면 콘텐츠 스크립트가 없다. 한 번 주입해 본다.
    //
    // 목록은 **manifest에서 그대로 읽는다.** 여기 또 적어두면 manifest만 고치는 날이 오고,
    // 그러면 shared-ui.js가 빠져 overlay.js·editor.js가 로드되다 죽는다.
    const scripts = chrome.runtime.getManifest().content_scripts || [];
    const isolated = scripts.find((s) => !s.world || s.world === 'ISOLATED');
    const main = scripts.find((s) => s.world === 'MAIN');
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: isolated.js });
      if (main) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: main.js,
            world: 'MAIN',
          });
        } catch {
          /* 수집만 못 할 뿐 프롬프트 조작은 된다 */
        }
      }
      return await chrome.tabs.sendMessage(tab.id, msg);
    } catch {
      return { ok: false, error: 'NovelAI 페이지를 새로고침해 주세요.' };
    }
  }
}

async function refreshPage() {
  const res = await send({ cmd: 'state' });
  if (res?.ok) {
    state.page = { ...res.state };
    if (state.page.characters.length && !state.page.characters.includes(state.charSlot)) {
      state.charSlot = state.page.characters[0];
    }
  } else {
    state.page = { onNovelAI: false, characters: [], base: '', uc: '', charTexts: [], error: res?.error };
  }
  renderTargets();
  renderList();
}

/* ---------- 타겟 해석 ---------- */

const isCharTarget = (t) => t === 'char' || t === 'charuc';

function currentTextFor(targetKind, charIndex = state.charSlot) {
  if (targetKind === 'base') return state.page.base || '';
  if (targetKind === 'uc') return state.page.uc || '';
  const entry = (state.page.charTexts || [])[charIndex - 1];
  if (!entry) return '';
  return (targetKind === 'charuc' ? entry.uc : entry.prompt) || '';
}

/* content.js의 같은 함수와 **반드시 같아야 한다.**
 * 공백 정리를 앵커 규칙보다 먼저 두는 이유는 거기 적어 두었다. */
const normalizeTag = (tag) =>
  String(tag)
    .replace(/[{}\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^-?\d+(?:\.\d+)?::/, '')
    .replace(/::$/, '')
    .trim()
    .toLowerCase();

/* 쉼표와 줄바꿈 둘 다로 나눈다. content.js의 같은 함수와 반드시 같아야 한다. */
const splitTags = (s) =>
  String(s || '')
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean);

function appliedIn(text, tags) {
  if (!tags.length) return false;
  const present = splitTags(text).map(normalizeTag);
  return tags.every((t) => present.includes(normalizeTag(t)));
}

/* ---------- 칸별 프리셋 ----------
 * 하나의 프리셋이 Base / UC / 캐릭터 1..N 의 프롬프트와 UC 에 각각 다른 태그를 담는다.
 * 비어 있는 칸은 아무 일도 하지 않는다. 페이지에 없는 캐릭터 칸도 건너뛴다.
 *
 * charUCs 는 chars 와 짝을 이루는 배열이다 (같은 인덱스 = 같은 캐릭터).
 * 예전 프리셋에는 이 키가 없으므로 normalizeSlots 가 항상 길이를 맞춰준다.
 *
 * **아래 normalizeSlots 는 shared-ui.js 의 NibUI.normalizeSlots 와 같은 함수다.**
 * 편집 창과 예약 창은 거기 것을 쓴다. 사이드 패널은 다른 실행 컨텍스트라 그 파일을 못 읽어
 * 여기 사본을 둔다 — splitTags · normalizeTag · esc 와 같은 사정이다.
 * 고칠 때는 반드시 양쪽을 함께 고칠 것.
 */

const isMulti = (item) => item?.multi === true;

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

/** 칸별 프리셋이 담고 있는 모든 내용. 검색·미리보기·빈 프리셋 판정이 함께 쓴다. */
const slotTexts = (s) => [s.base, s.uc, ...s.chars, ...s.charUCs];

/** 실제로 적용할 대상 목록. 비어 있거나 페이지에 없는 칸은 빠진다. */
function multiJobs(item) {
  const slots = normalizeSlots(item.slots);
  const pageChars = state.page.characters || [];
  const jobs = [];
  const missing = new Set();

  if (slots.base.trim()) jobs.push({ key: 'Base', target: { kind: 'base' }, tags: slots.base });
  if (slots.uc.trim()) jobs.push({ key: 'UC', target: { kind: 'uc' }, tags: slots.uc });

  // 한 캐릭터의 프롬프트와 UC 는 붙여서 보낸다 — 칸을 펼치고 탭을 바꾸는 조작이 덜 든다.
  slots.chars.forEach((text, i) => {
    const n = i + 1;
    const uc = slots.charUCs[i] || '';
    if (!text.trim() && !uc.trim()) return;
    if (!pageChars.includes(n)) {
      missing.add(n);
      return;
    }
    if (text.trim()) {
      jobs.push({ key: 'C' + n, target: { kind: 'char', index: n, uc: false }, tags: text });
    }
    if (uc.trim()) {
      jobs.push({ key: 'C' + n + ' UC', target: { kind: 'char', index: n, uc: true }, tags: uc });
    }
  });

  return { jobs, missing: [...missing] };
}

function multiTextFor(job) {
  if (job.target.kind === 'base') return currentTextFor('base');
  if (job.target.kind === 'uc') return currentTextFor('uc');
  return currentTextFor(job.target.uc ? 'charuc' : 'char', job.target.index);
}

function multiActive(item) {
  const { jobs } = multiJobs(item);
  if (!jobs.length) return false;
  return jobs.every((j) => appliedIn(multiTextFor(j), splitTags(j.tags)));
}

/** 캐릭터 프리셋은 어느 캐릭터에든 들어 있으면 활성으로 본다. 들어 있는 번호를 돌려준다. */
function activeCharIndices(item) {
  const tags = splitTags(item.tags);
  if (!tags.length) return [];
  const out = [];
  (state.page.characters || []).forEach((n) => {
    if (appliedIn(currentTextFor(item.target, n), tags)) out.push(n);
  });
  return out;
}

function isActive(item) {
  if (isMulti(item)) return multiActive(item);
  const tags = splitTags(item.tags);
  if (!tags.length) return false;
  if (isCharTarget(item.target)) return activeCharIndices(item).length > 0;
  return appliedIn(currentTextFor(item.target), tags);
}

/* ---------- 폴더 ----------
 *
 * 폴더는 프리셋과 **다른 목록**에 산다 (`nib.library.folders`).
 * 프리셋은 `folderId` 하나만 들고 있고, 폴더 안에 폴더는 없다 — 한 겹뿐이다.
 *
 * 어느 탭에 보이는가:
 *   1. 그 탭에서 만든 폴더는 비어 있어도 그 탭에 보인다 (`home`).
 *   2. 그 탭에 보이는 프리셋을 담고 있으면 어느 탭에든 보인다.
 *   3. '전체' 탭에는 모든 폴더가 보인다.
 * 이 규칙 덕분에 **폴더에 넣었다고 프리셋이 탭에서 사라지는 일이 없다.**
 * 자기 분류 탭에서는 언제나 자기 폴더 안에 들어 있는 채로 보인다.
 *
 * 폴더를 지워도 프리셋은 지우지 않는다. `folderId`만 떼어 밖으로 내보낸다.
 */

const ICON_FOLDER =
  '<svg viewBox="0 0 24 24"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5z"/></svg>';
const ICON_FOLDER_OPEN =
  '<svg viewBox="0 0 24 24"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v1.5"/><path d="M3 17.5V8.5m0 9a1.5 1.5 0 0 0 1.5 1.5h13c.7 0 1.3-.5 1.45-1.17L20.6 12.9A1 1 0 0 0 19.6 11.5H6.4a1 1 0 0 0-.98.8L3.4 18.2"/></svg>';
const ICON_FOLDER_MOVE =
  '<svg viewBox="0 0 24 24"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5z"/><path d="M11 13.5h5m0 0-1.8-1.8M16 13.5l-1.8 1.8"/></svg>';
const ICON_FOLDER_OUT =
  '<svg viewBox="0 0 24 24"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5z"/><path d="M11 15.5V10m0 0-1.8 1.8M11 10l1.8 1.8"/></svg>';
const ICON_CHEVRON = '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 24 24"><path d="M4 7h16M9.5 7V5.5h5V7M6.5 7l.8 11.5a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/></svg>';

const folderById = (id) => (id ? state.folders.find((f) => f.id === id) || null : null);

/** 지금 탭에 보여야 할 폴더. 위 주석의 세 규칙 그대로.
 *
 *  검색 중에는 규칙이 하나 더 붙는다 — **걸린 것이 없는 폴더는 감춘다.**
 *  찾는 것만 보려고 검색했는데 빈 폴더가 줄줄이 남아 있으면 그게 더 방해가 된다.
 *  폴더 이름 자체가 검색어에 걸리면 (비어 있어도) 남긴다. */
function visibleFolders(items) {
  const tab = state.category;
  const q = state.query.trim().toLowerCase();
  const used = new Set(items.map((i) => i.folderId).filter(Boolean));

  return state.folders.filter((f) => {
    if (q) return used.has(f.id) || String(f.name || '').toLowerCase().includes(q);
    return tab === 'all' || f.home === tab || used.has(f.id);
  });
}

/** 이름이 겹치지 않게 다듬는다. 같은 이름이 둘이면 어느 쪽에 넣었는지 알 수 없다. */
function uniqueFolderName(name, exceptId) {
  const taken = new Set(
    state.folders.filter((f) => f.id !== exceptId).map((f) => f.name.trim().toLowerCase())
  );
  const out = name.trim();
  if (!taken.has(out.toLowerCase())) return out;
  for (let n = 2; ; n++) {
    const cand = `${out} ${n}`;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
}

/** 새 폴더 / 이름 바꾸기. folder를 주면 이름 바꾸기다. */
function openFolderDialog(folder) {
  const dlg = $('#folderdlg');
  const input = $('#folder-name');
  const isNew = !folder;

  $('#folderdlg-title').textContent = isNew ? '새 폴더' : '폴더 이름 바꾸기';
  $('#folderdlg-where').textContent = isNew
    ? `${tabLabel(state.category)} 탭에 만듭니다. 다른 탭의 프리셋도 넣을 수 있습니다.`
    : `안에 든 프리셋 ${state.items.filter((i) => i.folderId === folder.id).length}개는 그대로 있습니다.`;
  input.value = folder?.name || '';

  $('#folderdlg-ok').onclick = async () => {
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    if (isNew) {
      state.folders.push({
        id: uid(),
        name: uniqueFolderName(name),
        home: state.category, // 만든 탭. 비어 있어도 여기서는 보인다.
        open: true,
        createdAt: Date.now(),
      });
      toast('폴더를 만들었습니다.');
    } else {
      folder.name = uniqueFolderName(name, folder.id);
      toast('이름을 바꿨습니다.');
    }
    await saveLibrary();
    dlg.close();
    renderList();
  };

  $('#folderdlg-cancel').onclick = () => dlg.close();
  dlg.showModal();
  input.focus();
  input.select();
}

const tabLabel = (id) =>
  id === 'all' ? '전체' : id === 'fav' ? '북마크' : CATEGORIES.find((c) => c.id === id)?.name || '전체';

/** 폴더를 지운다.
 *
 *  안이 비어 있으면 물어볼 것이 없다 — 확인만 받고 지운다.
 *  프리셋이 들어 있으면 **두 갈래를 창에서 고르게 한다**. 폴더를 지우려는 뜻이
 *  "묶음만 풀겠다"인지 "내용까지 버리겠다"인지는 밖에서 알 방법이 없고,
 *  한쪽을 잘못 고르면 되돌릴 수 없다.
 *
 *  세는 것은 **지금 탭에 보이는 것이 아니라 폴더가 실제로 담고 있는 전부**다.
 *  화풍 탭에서 지워도 그 폴더에 든 씬 프리셋까지 함께 걸린다 —
 *  화면에 보이는 수를 적으면 거짓말이 된다.
 */
async function deleteFolder(folder) {
  const inside = state.items.filter((i) => i.folderId === folder.id);

  if (!inside.length) {
    if (!confirm(`빈 폴더 "${folder.name}"을(를) 지웁니다.\n\n계속할까요?`)) return;
    await dropFolder(folder, false);
    return;
  }

  const dlg = $('#folderdel');
  $('#folderdel-title').textContent = `"${folder.name}"을(를) 지웁니다`;
  $('#folderdel-desc').textContent =
    `이 폴더에 프리셋 ${inside.length}개가 들어 있습니다. 안의 프리셋을 어떻게 할까요?`;
  $('#folderdel-keep-sub').textContent =
    `폴더만 없애고 ${inside.length}개를 폴더 밖으로 꺼냅니다. 프리셋은 그대로 남습니다.`;
  $('#folderdel-purge-sub').textContent =
    `폴더와 함께 ${inside.length}개를 모두 지웁니다. 되돌릴 수 없습니다.`;

  $('#folderdel-keep').onclick = async () => {
    dlg.close();
    await dropFolder(folder, false);
  };
  // 되돌릴 수 없는 쪽만 한 번 더 묻는다. 양쪽 다 물으면 확인 자체가 무뎌진다.
  $('#folderdel-purge').onclick = async () => {
    if (!confirm(`프리셋 ${inside.length}개를 폴더와 함께 지웁니다.\n되돌릴 수 없습니다. 계속할까요?`)) return;
    dlg.close();
    await dropFolder(folder, true);
  };
  $('#folderdel-cancel').onclick = () => dlg.close();
  dlg.showModal();
}

/** 폴더 지우기의 실제 수행. purge면 안에 든 프리셋까지 버린다. */
async function dropFolder(folder, purge) {
  const inside = state.items.filter((i) => i.folderId === folder.id);
  if (purge) {
    state.items = state.items.filter((i) => i.folderId !== folder.id);
  } else {
    for (const item of inside) item.folderId = null;
  }
  state.folders = state.folders.filter((f) => f.id !== folder.id);
  await saveLibrary();
  renderCats(); // 프리셋이 줄었으면 분류 탭의 개수도 함께 줄어야 한다
  renderList();
  toast(
    !inside.length
      ? '폴더를 지웠습니다.'
      : purge
        ? `폴더와 프리셋 ${inside.length}개를 지웠습니다.`
        : `폴더를 지우고 ${inside.length}개를 밖으로 옮겼습니다.`
  );
}

/** 프리셋을 폴더로 옮긴다. folderId가 null이면 폴더 밖으로. */
async function moveToFolder(item, folderId) {
  const from = item.folderId || null;
  const to = folderId || null;
  if (from === to) return;

  item.folderId = to;
  // 넣은 폴더가 접혀 있으면 방금 넣은 것이 어디로 갔는지 안 보인다. 펴준다.
  const target = folderById(to);
  if (target) target.open = true;

  await saveLibrary();
  renderList();
  toast(target ? `"${target.name}" 안으로 옮겼습니다.` : '폴더 밖으로 뺐습니다.');
}

/** 끌어다 놓기를 모르는 사람을 위한 두 번째 길. 창 하나로 목적지를 고른다. */
function openMovePicker(item) {
  const dlg = $('#movepick');
  const list = $('#movepick-list');
  const here = item.folderId || null;

  $('#movepick-title').textContent = `"${item.name}" 을(를) 어디로?`;
  list.innerHTML = '';

  const row = (opts) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'charpick-item' + (opts.current ? ' applied' : '');
    b.disabled = !!opts.current;

    const head = document.createElement('span');
    head.className = 'ci-head';
    head.textContent = opts.label;

    const badge = document.createElement('span');
    badge.className = 'ci-badge';
    badge.textContent = opts.current ? '지금 여기' : opts.badge || '';
    head.appendChild(badge);

    const sub = document.createElement('span');
    sub.className = 'ci-sub';
    sub.textContent = opts.sub;

    b.append(head, sub);
    if (!opts.current) {
      b.addEventListener('click', async () => {
        dlg.close();
        await opts.onPick();
      });
    }
    list.appendChild(b);
  };

  row({
    label: '폴더 밖',
    sub: '목록 맨 아래, 폴더에 속하지 않은 자리',
    current: here === null,
    onPick: () => moveToFolder(item, null),
  });

  for (const f of state.folders) {
    const n = state.items.filter((i) => i.folderId === f.id).length;
    row({
      label: f.name,
      badge: `${n}개`,
      sub: `${tabLabel(f.home)} 탭에서 만든 폴더`,
      current: here === f.id,
      onPick: () => moveToFolder(item, f.id),
    });
  }

  row({
    label: '＋ 새 폴더에 넣기',
    sub: '폴더를 만들고 이 프리셋을 그 안에 넣습니다',
    onPick: () => {
      const name = prompt('새 폴더 이름', '새 폴더');
      if (name === null || !name.trim()) return;
      const folder = {
        id: uid(),
        name: uniqueFolderName(name),
        home: state.category,
        open: true,
        createdAt: Date.now(),
      };
      state.folders.push(folder);
      return moveToFolder(item, folder.id);
    },
  });

  $('#movepick-cancel').onclick = () => dlg.close();
  dlg.showModal();
}

/* ---------- 끌어다 놓기 ----------
 *
 * 카드를 집어 폴더 위에 놓으면 들어가고, 맨 위 '폴더 밖으로 빼기' 띠에 놓으면 나온다.
 * 그 띠는 **끄는 동안에만** 나타난다 — 평소에 자리를 차지하면 목록만 좁아진다.
 *
 * dragenter/dragleave는 자식 요소를 지날 때마다 번갈아 터진다. 깊이를 세서 처리한다.
 */

function wireCardDrag(card, item) {
  card.addEventListener('dragstart', (e) => {
    state.dragId = item.id;
    card.classList.add('dragging');
    // 폴더 안에 있던 카드일 때만 '밖으로 빼기' 자리를 띄운다.
    document.body.classList.toggle('dragging-from-folder', !!item.folderId);
    e.dataTransfer.effectAllowed = 'move';
    // 텍스트로도 실어둔다. 없으면 일부 환경에서 끌기 자체가 시작되지 않는다.
    e.dataTransfer.setData('text/plain', item.id);
  });

  card.addEventListener('dragend', () => {
    state.dragId = null;
    card.classList.remove('dragging');
    document.body.classList.remove('dragging-from-folder');
    document.querySelectorAll('.drop-on').forEach((el) => el.classList.remove('drop-on'));
  });
}

/** 끌고 온 카드를 받는 자리를 만든다. accept가 false를 주면 받지 않는다. */
function wireDropZone(el, accept, onDrop) {
  let depth = 0;

  el.addEventListener('dragenter', (e) => {
    if (!accept()) return;
    e.preventDefault();
    depth++;
    el.classList.add('drop-on');
  });

  el.addEventListener('dragover', (e) => {
    if (!accept()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });

  el.addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      el.classList.remove('drop-on');
    }
  });

  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    depth = 0;
    el.classList.remove('drop-on');
    const id = state.dragId || e.dataTransfer.getData('text/plain');
    const item = state.items.find((i) => i.id === id);
    if (item) await onDrop(item);
  });
}

function draggedItem() {
  return state.items.find((i) => i.id === state.dragId) || null;
}

function wireFolderDrop(box, folder) {
  wireDropZone(
    box,
    () => {
      const it = draggedItem();
      return !!it && it.folderId !== folder.id;
    },
    (item) => moveToFolder(item, folder.id)
  );
}

function wireOutDrop(el) {
  wireDropZone(
    el,
    () => {
      const it = draggedItem();
      return !!it && !!it.folderId;
    },
    (item) => moveToFolder(item, null)
  );
}
/* ---------- 렌더 ---------- */

function renderTargets() {
  const row = $('#target-row');
  const chars = state.page.characters || [];
  row.innerHTML = '';

  const mk = (label, selected, onClick) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.setAttribute('aria-selected', String(selected));
    b.addEventListener('click', onClick);
    row.appendChild(b);
  };

  if (!chars.length) {
    const span = document.createElement('span');
    span.className = 'status';
    span.textContent = '캐릭터 프롬프트 없음 — Base / UC 만 사용';
    row.appendChild(span);
  } else {
    chars.forEach((n) => {
      mk(`캐릭터 ${n}`, n === state.charSlot, async () => {
        state.charSlot = n;
        await chrome.storage.local.set({ [SLOT_KEY]: n });
        renderTargets();
        renderList();
      });
    });
  }

  const status = $('#target-status');
  if (state.page.error) {
    status.textContent = state.page.error;
    status.className = 'status warn';
  } else if (!state.page.onNovelAI) {
    status.textContent = 'NovelAI 이미지 생성 페이지를 열어 주세요.';
    status.className = 'status warn';
  } else {
    status.textContent = chars.length
      ? `캐릭터 ${chars.length}명 · 캐릭터 프리셋은 캐릭터 ${state.charSlot}번으로 들어갑니다`
      : '';
    status.className = 'status';
  }
}

function renderCats() {
  const row = $('#cat-row');
  row.innerHTML = '';
  const counts = { all: state.items.length };
  for (const c of CATEGORIES) counts[c.id] = state.items.filter((i) => i.category === c.id).length;

  counts.fav = state.items.filter((i) => i.fav).length;

  const mk = (id, name, kind) => {
    const b = document.createElement('button');
    b.setAttribute('aria-selected', String(state.category === id));
    if (kind === 'cat') b.dataset.cat = id;
    if (kind === 'fav') b.className = 'fav-chip';

    if (kind === 'cat') {
      const dot = document.createElement('span');
      dot.className = 'dot';
      b.appendChild(dot);
    } else if (kind === 'fav') {
      const star = document.createElement('span');
      star.className = 'chip-star';
      star.innerHTML = ICON_STAR_FILL;
      b.appendChild(star);
    }
    b.appendChild(document.createTextNode(name));
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = String(counts[id] || 0);
    b.appendChild(n);

    b.addEventListener('click', () => {
      state.category = id;
      renderCats();
      renderList();
    });
    row.appendChild(b);
  };

  mk('all', '전체', 'plain');
  mk('fav', '북마크', 'fav');
  for (const c of CATEGORIES) mk(c.id, c.name, 'cat');
}

const ICON_EDIT =
  '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/></svg>';
const STAR_PATH = 'M12 3.6l2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z';
const ICON_STAR = `<svg viewBox="0 0 24 24"><path d="${STAR_PATH}"/></svg>`;
const ICON_STAR_FILL = `<svg viewBox="0 0 24 24"><path d="${STAR_PATH}" fill="currentColor"/></svg>`;

/** 지금 탭·검색어에 걸리는 프리셋만 추린다. 폴더는 여기서 보지 않는다. */
function filteredItems() {
  const q = state.query.trim().toLowerCase();
  let items = state.items;
  if (state.category === 'fav') items = items.filter((i) => i.fav);
  else if (state.category !== 'all') items = items.filter((i) => i.category === state.category);

  if (q) {
    items = items.filter((i) => {
      if (String(i.name || '').toLowerCase().includes(q)) return true;
      if (String(i.tags || '').toLowerCase().includes(q)) return true;
      if (isMulti(i)) {
        return slotTexts(normalizeSlots(i.slots)).join(' ').toLowerCase().includes(q);
      }
      return false;
    });
  }
  return items;
}

/** 프리셋 카드 하나. 폴더 안이든 밖이든 같은 카드를 쓴다. */
function makeCard(item) {
  const active = state.page.onNovelAI && isActive(item);

  const card = document.createElement('article');
  card.className = 'card' + (active ? ' active' : '');
  card.dataset.cat = item.category || 'etc';
  card.dataset.id = item.id;
  card.draggable = true;

  const rail = document.createElement('div');
  rail.className = 'rail';
  card.appendChild(rail);

  const main = document.createElement('button');
  main.className = 'card-main';
  main.title = active ? '클릭하면 뺍니다' : '클릭하면 넣습니다';
  // 카드 몸통이 <button>이다. 폼 컨트롤은 끌기 몸짓을 자기가 삼켜 조상의 draggable이
  // 시작되지 않는 경우가 있어, 몸통 자체도 끌 수 있게 해둔다. dragstart는 위로 올라간다.
  main.draggable = true;

  const h3 = document.createElement('h3');
  if (item.emoji) {
    const em = document.createElement('span');
    em.className = 'emoji';
    em.textContent = item.emoji;
    h3.appendChild(em);
  }
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = item.name;
  h3.appendChild(label);

  const tags = document.createElement('p');
  tags.className = 'tags';
  if (isMulti(item)) {
    const s = normalizeSlots(item.slots);
    const parts = [];
    if (s.base.trim()) parts.push('Base ' + s.base.trim());
    if (s.uc.trim()) parts.push('UC ' + s.uc.trim());
    s.chars.forEach((t, i) => {
      if (t.trim()) parts.push(`C${i + 1} ${t.trim()}`);
      const u = (s.charUCs[i] || '').trim();
      if (u) parts.push(`C${i + 1} UC ${u}`);
    });
    tags.textContent = parts.join('  ·  ');
  } else {
    tags.textContent = item.tags;
  }

  const meta = document.createElement('p');
  meta.className = 'meta';
  const cat = CATEGORIES.find((c) => c.id === item.category);
  let where;
  if (isMulti(item)) {
    const s = normalizeSlots(item.slots);
    const keys = [];
    if (s.base.trim()) keys.push('Base');
    if (s.uc.trim()) keys.push('UC');
    s.chars.forEach((t, i) => {
      if (t.trim()) keys.push('C' + (i + 1));
      if ((s.charUCs[i] || '').trim()) keys.push(`C${i + 1} UC`);
    });
    where = keys.length ? keys.join('·') : '빈 프리셋';
  } else {
    where = TARGET_LABEL[item.target] || 'Base';
    if (isCharTarget(item.target)) {
      const at = activeCharIndices(item);
      const slots = at.map((n) => 'C' + n).join(', ');
      // 들어 있는 칸이 있으면 그 번호를 보여준다. 분류 이름과 겹치는 말은 뺀다.
      if (item.target === 'charuc') where = slots ? 'UC ' + slots : '캐릭터 UC';
      else where = slots || '캐릭터';
    }
  }
  meta.textContent = `${cat ? cat.name : '기타'} → ${where}`;

  main.append(h3, tags, meta);
  main.addEventListener('click', () => applyItem(item));
  card.appendChild(main);

  const side = document.createElement('div');
  side.className = 'card-side';

  const star = document.createElement('button');
  star.className = 'star-btn' + (item.fav ? ' on' : '');
  star.innerHTML = item.fav ? ICON_STAR_FILL : ICON_STAR;
  star.title = item.fav ? '북마크 해제' : '북마크에 등록';
  star.setAttribute('aria-pressed', String(!!item.fav));
  star.addEventListener('click', async (e) => {
    e.stopPropagation();
    item.fav = !item.fav;
    await saveLibrary();
    renderCats();
    renderList();
  });
  side.appendChild(star);

  // 끌어다 놓기를 모르는 사람도 옮길 수 있어야 한다. 같은 일을 하는 두 번째 길.
  const home = folderById(item.folderId);
  const move = document.createElement('button');
  move.className = 'move-btn' + (home ? ' on' : '');
  move.innerHTML = ICON_FOLDER_MOVE;
  move.title = home ? `${home.name} 안에 있음 — 눌러서 옮기기` : '폴더로 옮기기';
  move.addEventListener('click', (e) => {
    e.stopPropagation();
    openMovePicker(item);
  });
  side.appendChild(move);

  const edit = document.createElement('button');
  edit.innerHTML = ICON_EDIT;
  edit.title = '편집';
  edit.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditor(item);
  });
  side.appendChild(edit);
  card.appendChild(side);

  wireCardDrag(card, item);
  return card;
}

/** 폴더 한 칸.
 *
 *  카드와 헷갈리면 안 되므로 생김새를 일부러 반대로 잡았다 —
 *  카드는 흰 바탕에 분류색 띠가 서 있고, 폴더는 바탕이 가라앉고 띠가 없다.
 *  펼치면 안쪽 카드들이 왼쪽 안내선 뒤로 한 단 들어간다.
 *
 *  forceOpen: 검색 중에는 걸린 폴더를 펼쳐 보여준다. 저장된 접힘 상태는 건드리지 않는다.
 */
function makeFolderRow(folder, children, forceOpen) {
  const open = forceOpen || !!folder.open;

  const box = document.createElement('section');
  box.className = 'folder' + (open ? ' open' : '');
  box.dataset.folder = folder.id;

  const head = document.createElement('div');
  head.className = 'folder-head';

  const toggle = document.createElement('button');
  toggle.className = 'folder-toggle';
  toggle.setAttribute('aria-expanded', String(open));
  toggle.title = open ? '접기' : '펼치기';
  toggle.innerHTML =
    `<span class="chev">${ICON_CHEVRON}</span>` +
    `<span class="fico">${open ? ICON_FOLDER_OPEN : ICON_FOLDER}</span>` +
    `<span class="fname"></span>` +
    `<span class="fcount"></span>`;
  toggle.querySelector('.fname').textContent = folder.name;
  toggle.querySelector('.fcount').textContent = String(children.length);
  toggle.addEventListener('click', async () => {
    folder.open = !open;
    await saveLibrary();
    renderList();
  });
  head.appendChild(toggle);

  const rename = document.createElement('button');
  rename.className = 'folder-act';
  rename.innerHTML = ICON_EDIT;
  rename.title = '폴더 이름 바꾸기';
  rename.addEventListener('click', (e) => {
    e.stopPropagation();
    openFolderDialog(folder);
  });
  head.appendChild(rename);

  const del = document.createElement('button');
  del.className = 'folder-act danger';
  del.innerHTML = ICON_TRASH;
  del.title = '폴더 삭제 — 안의 프리셋을 어떻게 할지 먼저 고릅니다';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteFolder(folder);
  });
  head.appendChild(del);

  box.appendChild(head);

  const body = document.createElement('div');
  body.className = 'folder-body';
  body.hidden = !open;

  if (children.length) {
    for (const item of children) body.appendChild(makeCard(item));
  } else {
    // 안에 뭔가 있는데 지금 탭·검색어에 안 걸린 것뿐일 수 있다. 그걸 "비었다"고 하면 거짓말이다.
    const held = state.items.filter((i) => i.folderId === folder.id).length;
    const empty = document.createElement('p');
    empty.className = 'folder-empty';
    empty.textContent = held
      ? `${held}개가 들어 있지만 지금 조건에 걸리는 것이 없습니다.`
      : '비어 있습니다 — 카드를 끌어다 놓으세요.';
    body.appendChild(empty);
  }
  box.appendChild(body);

  wireFolderDrop(box, folder);
  return box;
}

function renderList() {
  const list = $('#list');
  const items = filteredItems();
  const folders = visibleFolders(items);
  const searching = !!state.query.trim();

  list.innerHTML = '';

  // 폴더 밖으로 빼는 자리. 카드를 끌기 시작할 때만 나타난다.
  const out = document.createElement('div');
  out.className = 'drop-out';
  out.innerHTML = `<span class="fico">${ICON_FOLDER_OUT}</span>폴더 밖으로 빼기`;
  wireOutDrop(out);
  list.appendChild(out);

  if (!items.length && !folders.length) {
    const div = document.createElement('div');
    div.className = 'list-empty';
    div.innerHTML = state.items.length
      ? '<b>결과 없음</b>다른 검색어나 분류를 선택해 보세요.'
      : '<b>아직 프리셋이 없습니다</b>오른쪽 위 + 로 하나 만들거나,<br>설정에서 예시 프리셋을 채워 보세요.';
    list.appendChild(div);
    $('#count').textContent = '';
    return;
  }

  // 폴더가 먼저, 폴더에 속하지 않은 카드가 그 다음. 파일 탐색기와 같은 순서다.
  const byFolder = new Map();
  const loose = [];
  for (const item of items) {
    const f = folderById(item.folderId);
    if (f) {
      if (!byFolder.has(f.id)) byFolder.set(f.id, []);
      byFolder.get(f.id).push(item);
    } else {
      loose.push(item);
    }
  }

  for (const folder of folders) {
    const children = byFolder.get(folder.id) || [];
    list.appendChild(makeFolderRow(folder, children, searching && children.length > 0));
  }

  for (const item of loose) list.appendChild(makeCard(item));

  $('#count').textContent = `${items.length} / ${state.items.length}`;
}

/* ---------- 동작 ---------- */

/** 캐릭터가 둘 이상이면 어디에 넣을지 물어본다. 취소하면 null. */
function pickCharacter(item) {
  return new Promise((resolve) => {
    const dlg = $('#charpick');
    const list = $('#charpick-list');
    const applied = new Set(activeCharIndices(item));

    $('#charpick-title').textContent = applied.size
      ? '옮기거나 뺄 캐릭터를 고르세요'
      : '어느 캐릭터에 넣을까요?';

    list.innerHTML = '';
    for (const n of state.page.characters || []) {
      const preview = currentTextFor(item.target, n).trim();
      const has = applied.has(n);

      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'charpick-item' + (has ? ' applied' : '');

      const head = document.createElement('span');
      head.className = 'ci-head';
      head.textContent = `캐릭터 ${n}`;

      // 세 가지 상태를 미리 알려준다 — 누르기 전에 무슨 일이 일어날지 보여야 한다.
      const badge = document.createElement('span');
      badge.className = 'ci-badge' + (!has && applied.size ? ' move' : '');
      badge.textContent = has ? '들어 있음 · 빼기' : applied.size ? '여기로 옮기기' : '넣기';
      head.appendChild(badge);

      const sub = document.createElement('span');
      sub.className = 'ci-sub';
      sub.textContent = preview || '(비어 있음)';

      b.append(head, sub);
      b.addEventListener('click', () => {
        dlg.close();
        resolve(n);
      });
      list.appendChild(b);
    }

    $('#charpick-cancel').onclick = () => dlg.close();
    dlg.addEventListener('close', () => resolve(null), { once: true });
    dlg.showModal();
  });
}

async function applyItem(item) {
  if (isMulti(item)) return applyMulti(item);

  if (isCharTarget(item.target)) return applyToCharacter(item);

  const target = { kind: item.target === 'uc' ? 'uc' : 'base' };
  const res = await send({ cmd: 'apply', target, tags: item.tags, mode: 'toggle' });
  if (!res?.ok) {
    toast(res?.error || '적용하지 못했습니다.', true);
    return;
  }
  await refreshPage();
}

/** 캐릭터 프리셋. 고른 칸에 따라 세 갈래로 갈린다.
 *
 *   이미 들어 있는 칸을 고름  → 그 칸에서 뺀다
 *   비어 있는 칸을 고름       → 넣는다
 *   다른 칸에 들어 있는데      → 새 칸에 넣고 **원래 칸은 비운다** (옮기기)
 *   비어 있는 칸을 고름
 *
 * 마지막이 핵심이다. 그냥 toggle로 넣기만 하면 원래 칸에 그대로 남아 복제가 된다.
 */
async function applyToCharacter(item) {
  const chars = state.page.characters || [];
  if (!chars.length) {
    toast('캐릭터 프롬프트가 없습니다. NovelAI에서 먼저 추가해 주세요.', true);
    return;
  }

  const appliedAt = activeCharIndices(item);
  const uc = item.target === 'charuc';

  let index;
  if (chars.length === 1) {
    index = chars[0]; // 하나뿐이면 물어볼 것이 없다
  } else {
    index = await pickCharacter(item);
    if (index == null) return; // 취소
    state.charSlot = index;
    await chrome.storage.local.set({ [SLOT_KEY]: index });
  }

  const at = (n) => ({ kind: 'char', index: n, uc });
  const fail = (res, where) => {
    if (!res?.ok) toast(res?.error || `캐릭터 ${where}에 적용하지 못했습니다.`, true);
    return !!res?.ok;
  };

  if (appliedAt.includes(index)) {
    fail(await send({ cmd: 'apply', target: at(index), tags: item.tags, mode: 'remove' }), index);
  } else {
    const ok = fail(
      await send({ cmd: 'apply', target: at(index), tags: item.tags, mode: 'add' }),
      index
    );
    // 넣기에 성공했을 때만 원래 칸을 비운다. 실패했는데 지우면 태그를 잃는다.
    if (ok) {
      const moved = [];
      for (const old of appliedAt) {
        if (old === index) continue;
        const res = await send({ cmd: 'apply', target: at(old), tags: item.tags, mode: 'remove' });
        if (res?.ok) moved.push(old);
      }
      if (moved.length) toast(`캐릭터 ${moved.join(', ')} → ${index} 로 옮겼습니다.`);
    }
  }

  await refreshPage();
}

/** 칸별 프리셋: 담긴 칸을 한 번에 넣거나 뺀다.
 *  이미 전부 들어 있으면 전부 빼고, 하나라도 빠져 있으면 전부 넣는다. */
async function applyMulti(item) {
  const { jobs, missing } = multiJobs(item);
  if (!jobs.length) {
    toast(
      missing.length
        ? `캐릭터 ${missing.join(', ')}번이 NovelAI에 없습니다.`
        : '이 프리셋에 채워진 칸이 없습니다.',
      true
    );
    return;
  }

  const mode = multiActive(item) ? 'remove' : 'add';

  // 캐릭터 칸은 펼치고 탭을 바꾸는 조작이 끼므로 순차로 보낸다.
  const failed = [];
  for (const job of jobs) {
    const res = await send({ cmd: 'apply', target: job.target, tags: job.tags, mode });
    if (!res?.ok) failed.push(job.key);
  }

  await refreshPage();

  if (failed.length) toast(`${failed.join(', ')} 적용 실패`, true);
  else if (missing.length) toast(`캐릭터 ${missing.join(', ')}번이 없어 건너뛰었습니다.`);
}

/* ---------- 입력란 비우기 ---------- */

/** 지금 페이지에 있는 입력란 목록. 비우기 창과 저장 창이 함께 쓴다. */
function clearableTargets() {
  const out = [
    { key: 'base', label: 'Base Prompt', target: { kind: 'base' }, text: currentTextFor('base') },
    { key: 'uc', label: 'Undesired Content', target: { kind: 'uc' }, text: currentTextFor('uc') },
  ];
  for (const n of state.page.characters || []) {
    out.push({
      key: 'c' + n,
      label: `캐릭터 ${n}`,
      target: { kind: 'char', index: n, uc: false },
      text: currentTextFor('char', n),
    });
    const uc = currentTextFor('charuc', n);
    if (uc.trim()) {
      out.push({
        key: 'c' + n + 'uc',
        label: `캐릭터 ${n} UC`,
        target: { kind: 'char', index: n, uc: true },
        text: uc,
      });
    }
  }
  return out;
}

function openClearPicker() {
  if (!state.page.onNovelAI) {
    toast('NovelAI 이미지 생성 페이지를 열어 주세요.', true);
    return;
  }

  const dlg = $('#clearpick');
  const list = $('#clearpick-list');
  const rows = clearableTargets();

  list.innerHTML = '';
  for (const row of rows) {
    const filled = !!row.text.trim();

    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'charpick-item' + (filled ? ' applied' : '');
    b.disabled = !filled;

    const head = document.createElement('span');
    head.className = 'ci-head';
    head.textContent = row.label;

    const badge = document.createElement('span');
    badge.className = 'ci-badge';
    badge.textContent = filled ? '비우기' : '이미 비어 있음';
    head.appendChild(badge);

    const sub = document.createElement('span');
    sub.className = 'ci-sub';
    sub.textContent = row.text.trim() || '(비어 있음)';

    b.append(head, sub);
    b.addEventListener('click', async () => {
      dlg.close();
      const res = await send({ cmd: 'clear', target: row.target });
      if (!res?.ok) toast(res?.error || '비우지 못했습니다.', true);
      else toast(`${row.label} 을(를) 비웠습니다.`);
      await refreshPage();
    });
    list.appendChild(b);
  }

  $('#clearpick-all').onclick = async () => {
    const filled = rows.filter((r) => r.text.trim());
    if (!filled.length) {
      dlg.close();
      return;
    }
    if (!confirm(`입력란 ${filled.length}곳을 모두 비웁니다.\n되돌릴 수 없습니다. 계속할까요?`)) return;
    dlg.close();

    // 캐릭터 칸은 펼치고 탭을 바꾸는 조작이 끼므로 순차로 보낸다.
    const failed = [];
    for (const row of filled) {
      const res = await send({ cmd: 'clear', target: row.target });
      if (!res?.ok) failed.push(row.label);
    }
    await refreshPage();
    if (failed.length) toast(`${failed.join(', ')} 비우기 실패`, true);
    else toast(`${filled.length}곳을 비웠습니다.`);
  };

  $('#clearpick-cancel').onclick = () => dlg.close();
  dlg.showModal();
}

function captureCurrent() {
  const kinds = [
    { target: 'base', label: 'Base Prompt' },
    { target: 'uc', label: 'Undesired Content' },
    { target: 'char', label: `캐릭터 ${state.charSlot}` },
  ];
  // 내용이 있는 첫 대상을 잡아 새 프리셋 초안으로 연다.
  for (const k of kinds) {
    const text = currentTextFor(k.target);
    if (text && text.trim()) {
      openEditor({
        id: null,
        name: '',
        category: k.target === 'uc' ? 'negative' : k.target === 'char' ? 'character' : 'style',
        target: k.target,
        tags: text.trim(),
      });
      return;
    }
  }
  toast('저장할 내용이 없습니다.', true);
}

/* ---------- 편집 창 ----------
 *
 * 편집 창은 사이드 패널이 아니라 **NovelAI 화면 위에** 뜬다 (editor.js).
 * 사이드 패널은 384px라 칸별 입력이 세로로 한없이 길어졌기 때문이다.
 *
 * 저장은 편집 창이 chrome.storage에 직접 한다. 여기서는 storage.onChanged를 듣고
 * 다시 그리기만 한다 — 사이드 패널이 닫혀 있어도 저장이 살아남아야 하기 때문이다.
 * 분류 목록·페이지의 캐릭터 번호처럼 여기만 아는 것은 열 때 실어 보낸다.
 */

async function openEditor(item) {
  const res = await send({
    cmd: 'editor',
    item: item || null,
    categories: CATEGORIES,
    characters: state.page.characters || [],
    charSlot: state.charSlot,
  });

  if (!res?.ok) {
    toast(res?.error || 'NovelAI 탭에서 편집 창이 열립니다. NovelAI를 열어 주세요.', true);
    return;
  }

  // 창을 열어놓고 못 보는 일이 없도록 그 탭을 앞으로 가져온다.
  const tab = await novelaiTab();
  if (!tab) return;
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    /* 창을 앞으로 못 가져와도 편집 창 자체는 떠 있다 */
  }
}

/* ---------- 내보내기 ----------
 *
 * 두 갈래다.
 *   전체 설정   — 프리셋과 폴더를 통째로
 *   특정 폴더   — 고른 폴더(1~5개)와 그 안의 프리셋만
 *
 * 두 갈래가 **같은 형식**으로 쓴다. 불러오는 쪽이 "이건 부분 파일"이라고 구분할 일이 없어야
 * 한다 — 어차피 폴더 목록과 프리셋 목록을 보고 판단하기 때문이다.
 */

const EXPORT_MAX_FOLDERS = 5;

const today = () => new Date().toISOString().slice(0, 10);

/** 파일 이름에 못 쓰는 글자만 걷어낸다. 한글은 그대로 둔다. */
const safeFileName = (s) =>
  String(s)
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40) || 'folder';

function downloadJSON(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** 파일에 담을 꾸러미. **자동 백업도 이 함수를 쓴다** —
 *  백업 파일만 폴더를 빠뜨리면 복구할 때 분류가 통째로 날아간다. */
function libraryPayload(items = state.items, folders = state.folders, scope = 'all') {
  return {
    version: LIB_VERSION,
    scope,
    exportedAt: new Date().toISOString(),
    folders,
    items,
  };
}

function exportAll() {
  downloadJSON(libraryPayload(), 'nib-presets-' + today() + '.json');
  toast(`프리셋 ${state.items.length}개 · 폴더 ${state.folders.length}개를 내보냈습니다.`);
}

function exportFolders(ids) {
  const folders = state.folders.filter((f) => ids.includes(f.id));
  const items = state.items.filter((i) => i.folderId && ids.includes(i.folderId));
  // 폴더가 하나면 파일 이름에 그 이름을 넣는다. 나중에 무엇을 내보낸 파일인지 알아보라고.
  const slug = folders.length === 1 ? safeFileName(folders[0].name) : 'folders-' + folders.length;
  downloadJSON(libraryPayload(items, folders, 'folders'), 'nib-' + slug + '-' + today() + '.json');
  toast(`폴더 ${folders.length}개 · 프리셋 ${items.length}개를 내보냈습니다.`);
}

/** 내보낼 폴더 고르기. 1개 이상 5개 이하. */
function openExportPicker() {
  if (!state.folders.length) {
    toast('폴더가 없습니다. 전체 설정 내보내기를 쓰세요.', true);
    return;
  }

  const dlg = $('#exportpick');
  const list = $('#exportpick-list');
  const ok = $('#exportpick-ok');
  const countEl = $('#exportpick-count');
  const picked = new Set();

  const draw = () => {
    const full = picked.size >= EXPORT_MAX_FOLDERS;
    list.innerHTML = '';

    for (const f of state.folders) {
      const n = state.items.filter((i) => i.folderId === f.id).length;
      const on = picked.has(f.id);
      // 5개를 채운 뒤의 나머지는 눌러도 소용없다는 것이 보여야 한다.
      const locked = !on && full;

      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'charpick-item' + (on ? ' picked' : '') + (locked ? ' locked' : '');
      b.disabled = locked;

      const head = document.createElement('span');
      head.className = 'ci-head';
      head.textContent = f.name;

      const badge = document.createElement('span');
      badge.className = 'ci-badge';
      badge.textContent = on ? '고름' : n + '개';
      head.appendChild(badge);

      const sub = document.createElement('span');
      sub.className = 'ci-sub';
      sub.textContent = n
        ? `${tabLabel(f.home)} 탭 · 프리셋 ${n}개`
        : `${tabLabel(f.home)} 탭 · 비어 있는 폴더`;

      b.append(head, sub);
      b.addEventListener('click', () => {
        if (picked.has(f.id)) picked.delete(f.id);
        else picked.add(f.id);
        draw();
      });
      list.appendChild(b);
    }

    countEl.textContent = picked.size
      ? `${picked.size} / ${EXPORT_MAX_FOLDERS} 선택`
      : '폴더를 하나 이상 고르세요';
    ok.disabled = picked.size === 0;
  };

  draw();
  $('#exportpick-cancel').onclick = () => dlg.close();
  ok.onclick = () => {
    if (!picked.size) return;
    dlg.close();
    exportFolders([...picked]);
  };
  dlg.showModal();
}

/* ---------- 불러오기 ----------
 *
 * 파일을 고르면 곧바로 밀어 넣지 않는다. 창을 하나 띄워
 *   왼쪽   = 파일 안에 무엇이 들어 있나 (폴더 → 프리셋, 아코디언)
 *   오른쪽 = 그 중 무엇을 어떤 이름으로 가져올까 (폴더마다 따로)
 * 를 확인시킨 뒤에 넣는다.
 *
 * 이름이 겹칠 때의 선택(병합 / 새 이름)도 **이 창 안에서** 끝난다.
 * 창을 새로 띄우면 방금 무엇을 고르던 중이었는지 잃어버린다.
 *
 * 폴더마다 갈래는 넷이다.
 *   keep   원본 이름 그대로 새 폴더를 만든다
 *   rename 새 이름으로 새 폴더를 만든다
 *   merge  이미 있는 같은 이름 폴더 안으로 넣는다 (새 폴더를 만들지 않는다)
 *   skip   가져오지 않는다 (그 안의 프리셋까지 통째로)
 */

/* 지금 열려 있는 불러오기 창의 상태. 파일 이름은 화면(#imp-file)에만 쓰이므로 여기 담지 않는다. */
const IMP = { groups: [] };

const impEffName = (g) => (g.mode === 'rename' ? g.newName : g.origName).trim();

const validHome = (home) =>
  home === 'all' || home === 'fav' || CATEGORIES.some((c) => c.id === home) ? home : 'all';

/* shared-ui.js 의 NibUI.esc 와 **글자까지 같은** 함수다 (컨텍스트가 달라 사본을 둔다).
   이름도 본문도 일부러 똑같이 맞춰 두었다 — 눈으로 두 곳을 견줄 수 있어야 한다.
   없는 값은 빈 문자열로 본다 — String(null) 을 그대로 두면 화면에 "null" 이 찍힌다. */
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 파일 속 프리셋 하나를 라이브러리 모양으로 다듬는다. 못 쓸 것이면 null. */
function normalizeIncoming(raw) {
  const multi = raw?.multi === true;
  if (!raw?.name) return null;
  if (!multi && !raw?.tags) return null;
  const slots = multi ? normalizeSlots(raw.slots) : null;
  if (multi && !slotTexts(slots).some((t) => String(t).trim())) return null;

  return {
    name: String(raw.name),
    tags: multi ? '' : String(raw.tags),
    multi,
    slots,
    fav: raw.fav === true,
    emoji: typeof raw.emoji === 'string' ? raw.emoji.slice(0, 8) : '',
    category: CATEGORIES.some((c) => c.id === raw.category) ? raw.category : 'etc',
    target: TARGET_LABEL[raw.target] ? raw.target : 'base',
    createdAt: raw.createdAt || Date.now(),
  };
}

/** 파일 → 폴더 묶음. 폴더에 속하지 않은 프리셋은 맨 끝에 '폴더 없음'으로 모은다. */
function buildImportGroups(data) {
  const rawFolders = Array.isArray(data?.folders) ? data.folders : [];
  const rawItems = Array.isArray(data?.items) ? data.items : [];

  const groups = [];
  const byId = new Map();

  for (const rf of rawFolders) {
    const name = String(rf?.name || '').trim();
    if (!rf?.id || !name) continue;
    const g = {
      key: 'f:' + rf.id,
      srcId: rf.id,
      origName: name,
      home: validHome(rf.home),
      open: rf.open !== false,
      createdAt: rf.createdAt || Date.now(),
      items: [],
      mode: 'keep',
      newName: name,
      mergeId: null,
    };
    groups.push(g);
    byId.set(rf.id, g);
  }

  // 폴더 밖 프리셋. 파일에 폴더가 아예 없던 옛 백업도 여기로 모인다.
  const loose = {
    key: 'loose',
    srcId: null,
    origName: '폴더 없음',
    home: 'all',
    open: true,
    createdAt: Date.now(),
    items: [],
    mode: 'keep',
    newName: '',
    mergeId: null,
  };

  for (const raw of rawItems) {
    const item = normalizeIncoming(raw);
    if (!item) continue;
    (byId.get(raw?.folderId) || loose).items.push(item);
  }

  if (loose.items.length) groups.push(loose);
  return groups;
}

/** 이 폴더의 이름이 지금 무엇과 부딪히는가. 없으면 null. */
function impConflict(g) {
  if (!g.srcId || g.mode === 'skip' || g.mode === 'merge') return null;

  const name = impEffName(g);
  if (!name) return { type: 'empty' };

  const key = name.toLowerCase();
  const hit = state.folders.find((f) => f.name.trim().toLowerCase() === key);
  if (hit) return { type: 'existing', folder: hit };

  // 파일 안의 두 폴더가 같은 이름이 되는 경우. 막지는 않되 알려는 준다.
  const twin = IMP.groups.find(
    (o) =>
      o !== g &&
      o.srcId &&
      o.mode !== 'skip' &&
      o.mode !== 'merge' &&
      impEffName(o).toLowerCase() === key
  );
  return twin ? { type: 'plan' } : null;
}

/* --- 왼쪽: 원본 아코디언 ---
 * <details>를 쓴다. 접기·펴기와 키보드 조작이 공짜로 따라온다. */

function renderImportSource() {
  const box = $('#imp-src');
  // 다시 그려도 펼쳐둔 폴더는 그대로 두어야 한다 (제외를 누를 때마다 접히면 못 쓴다).
  const wasOpen = new Set(
    [...box.querySelectorAll('details[data-key]')].filter((d) => d.open).map((d) => d.dataset.key)
  );
  const first = box.childElementCount === 0;
  box.innerHTML = '';

  const total = IMP.groups.reduce((n, g) => n + g.items.length, 0);
  $('#imp-src-count').textContent =
    `폴더 ${IMP.groups.filter((g) => g.srcId).length} · 프리셋 ${total}`;

  if (!IMP.groups.length) {
    const p = document.createElement('p');
    p.className = 'imp-empty';
    p.textContent = '이 파일에는 가져올 프리셋이 없습니다.';
    box.appendChild(p);
    return;
  }

  IMP.groups.forEach((g, gi) => {
    const d = document.createElement('details');
    d.className = 'imp-src-group' + (g.mode === 'skip' ? ' dim' : '');
    d.dataset.key = g.key;
    // 처음 그릴 때는 첫 폴더만 펴 둔다. 전부 펴 두면 폴더가 많을 때 한눈에 안 들어온다.
    d.open = first ? gi === 0 : wasOpen.has(g.key);

    const sum = document.createElement('summary');
    sum.innerHTML =
      '<span class="twist">' + ICON_CHEVRON + '</span><span class="fico">' + ICON_FOLDER + '</span>';

    const nm = document.createElement('span');
    nm.className = 'imp-src-name';
    nm.textContent = g.origName;
    nm.title = g.origName;

    const n = document.createElement('span');
    n.className = 'imp-src-n';
    n.textContent = g.items.length + '개';

    sum.append(nm, n);
    d.appendChild(sum);

    const body = document.createElement('div');
    body.className = 'imp-src-body';

    if (!g.items.length) {
      const p = document.createElement('p');
      p.className = 'imp-empty';
      p.style.margin = '4px 0';
      p.textContent = '비어 있는 폴더입니다.';
      body.appendChild(p);
    }

    for (const it of g.items) {
      const row = document.createElement('div');
      row.className = 'imp-src-item';

      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.setProperty('--dot', 'var(--cat-' + it.category + '-hot)');

      const label = document.createElement('span');
      label.className = 'nm';
      label.textContent = (it.emoji ? it.emoji + ' ' : '') + it.name;
      label.title = it.name;

      const cat = document.createElement('span');
      cat.className = 'cat';
      cat.textContent = CATEGORIES.find((c) => c.id === it.category)?.name || '기타';

      row.append(dot, label, cat);
      body.appendChild(row);
    }

    d.appendChild(body);
    box.appendChild(d);
  });
}

/* --- 오른쪽: 가져오기 제어 --- */

function renderImportPlan() {
  const box = $('#imp-plan');
  const keepScroll = box.scrollTop; // 다시 그려도 보던 자리를 잃지 않는다
  box.innerHTML = '';
  for (const g of IMP.groups) box.appendChild(makeImportRow(g));
  box.scrollTop = keepScroll;
  renderImportFooter();
}

/** 방금 그린 이름 입력칸 (포커스를 주려고 찾는다). */
const findRenameInput = (g) =>
  $('#imp-plan').querySelector('.imp-rename[data-key="' + g.key + '"]');

function focusRename(g) {
  const input = findRenameInput(g);
  input?.focus();
  input?.select();
}

function makeImportRow(g) {
  const row = document.createElement('div');
  row.className = 'imp-row';
  row.dataset.mode = g.mode;

  /* 머리줄 — 아이콘 · 이름 · 개수 */
  const head = document.createElement('div');
  head.className = 'imp-row-head';
  head.innerHTML = '<span class="fico">' + ICON_FOLDER + '</span>';

  const nm = document.createElement('span');
  nm.className = 'imp-row-name';
  const shown = g.srcId ? impEffName(g) || '(이름 없음)' : g.origName;
  nm.textContent = shown;
  nm.title = g.srcId && shown !== g.origName ? '원본 이름: ' + g.origName : shown;

  const n = document.createElement('span');
  n.className = 'imp-row-n';
  n.textContent = g.items.length + '개';

  head.append(nm, n);
  row.appendChild(head);

  /* 갈래 고르기 — 클릭 한 번으로 유지 / 새 이름 / 제외 */
  const modes = document.createElement('div');
  modes.className = 'imp-modes';

  const choices = g.srcId
    ? [
        { mode: 'keep', label: '이름 유지' },
        { mode: 'rename', label: '새 이름' },
        { mode: 'skip', label: '제외' },
      ]
    : [
        { mode: 'keep', label: '함께 가져오기' },
        { mode: 'skip', label: '제외' },
      ];

  for (const c of choices) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.mode = c.mode;
    // merge 는 '이름 유지' 자리에 표시한다 — 이름을 그대로 쓰는 갈래이기 때문이다.
    const on = g.mode === c.mode || (c.mode === 'keep' && g.mode === 'merge');
    b.setAttribute('aria-selected', String(on));
    b.textContent = c.mode === 'keep' && g.mode === 'merge' ? '기존에 병합' : c.label;
    b.addEventListener('click', () => {
      g.mode = c.mode;
      g.mergeId = null;
      if (c.mode === 'rename' && !g.newName.trim()) g.newName = g.origName;
      renderImportPlan();
      renderImportSource();
      if (c.mode === 'rename') focusRename(g);
    });
    modes.appendChild(b);
  }
  row.appendChild(modes);

  /* 새 이름 입력 */
  if (g.mode === 'rename') {
    const input = document.createElement('input');
    input.className = 'imp-rename';
    input.dataset.key = g.key;
    input.value = g.newName;
    input.maxLength = 40;
    input.placeholder = '새 폴더 이름';
    input.autocomplete = 'off';
    input.spellcheck = false;
    // 글자를 칠 때마다 줄을 다시 그리면 포커스와 커서를 잃는다.
    // 이름표와 경고 상자만 제자리에서 고쳐 쓴다.
    input.addEventListener('input', () => {
      g.newName = input.value;
      nm.textContent = impEffName(g) || '(이름 없음)';
      fillWarn(row.querySelector('.imp-warn'), g);
      renderImportFooter();
    });
    row.appendChild(input);
  }

  /* 중복 이름 경고 — 창을 옮기지 않고 이 자리에서 고른다 */
  const warn = document.createElement('div');
  warn.className = 'imp-warn';
  warn.hidden = true;
  row.appendChild(warn);
  fillWarn(warn, g);

  return row;
}

/** 경고 상자를 그 자리에서 다시 채운다. 창은 그대로 있고 이 상자만 바뀐다. */
function fillWarn(warn, g) {
  if (!warn) return;
  const c = impConflict(g);
  warn.innerHTML = '';
  warn.hidden = !c;
  if (!c) return;

  const p = document.createElement('p');
  const acts = document.createElement('div');
  acts.className = 'imp-warn-acts';

  const act = (label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mini-btn';
    b.textContent = label;
    b.addEventListener('click', fn);
    acts.appendChild(b);
  };

  if (c.type === 'empty') {
    p.innerHTML = '<b>이름을 비울 수 없습니다.</b> 새 이름을 적거나 원본 이름으로 되돌리세요.';
    act('원본 이름으로', () => {
      g.mode = 'keep';
      g.newName = g.origName;
      renderImportPlan();
    });
  } else if (c.type === 'existing') {
    const n = state.items.filter((i) => i.folderId === c.folder.id).length;
    p.innerHTML =
      '이미 <b>&ldquo;' +
      esc(c.folder.name) +
      '&rdquo;</b> 폴더가 있습니다 (프리셋 ' +
      n +
      '개). 기존 폴더에 합칠까요, 새 이름으로 만들까요?';
    act('기존 폴더에 병합', () => {
      g.mode = 'merge';
      g.mergeId = c.folder.id;
      renderImportPlan();
      renderImportSource();
    });
    act('새 이름으로', () => {
      g.mode = 'rename';
      g.newName = uniqueFolderName(impEffName(g));
      renderImportPlan();
      focusRename(g);
    });
  } else {
    p.innerHTML = '<b>가져오는 폴더끼리 이름이 같습니다.</b> 이대로 두면 뒤쪽에 번호가 붙습니다.';
    act('새 이름으로', () => {
      g.mode = 'rename';
      g.newName = uniqueFolderName(impEffName(g));
      renderImportPlan();
      focusRename(g);
    });
  }

  warn.append(p, acts);
}

/** 요약줄 · 겹침 띠 · 가져오기 버튼. 무엇이 바뀌든 여기 한 곳에서 다시 계산한다. */
function renderImportFooter() {
  const live = IMP.groups.filter((g) => g.mode !== 'skip');
  const items = live.reduce((n, g) => n + g.items.length, 0);
  const newFolders = live.filter((g) => g.srcId && g.mode !== 'merge').length;
  const merged = live.filter((g) => g.mode === 'merge').length;

  // 결정을 미룬 채로는 가져갈 수 없다. '겹치면 알아서 합침'은 조용히 남의 폴더를 건드린다.
  const blocking = IMP.groups.filter((g) => {
    const c = impConflict(g);
    return c && (c.type === 'existing' || c.type === 'empty');
  });

  $('#imp-plan-count').textContent = `${live.length} / ${IMP.groups.length} 선택`;

  const dupes = blocking.filter((g) => impConflict(g)?.type === 'existing');
  const bulk = $('#imp-bulk');
  bulk.hidden = dupes.length < 2; // 하나뿐이면 그 줄에서 바로 고르면 된다
  if (!bulk.hidden) $('#imp-bulk-text').textContent = `이름이 겹치는 폴더 ${dupes.length}개`;

  const ok = $('#imp-ok');
  const summary = $('#imp-summary');

  if (!live.length || !items) {
    ok.disabled = true;
    summary.textContent = live.length ? '고른 폴더가 모두 비어 있습니다.' : '가져올 폴더가 없습니다.';
    return;
  }
  if (blocking.length) {
    ok.disabled = true;
    summary.textContent = `이름을 정해야 할 폴더 ${blocking.length}개`;
    return;
  }

  ok.disabled = false;
  const parts = [`프리셋 ${items}개`];
  if (newFolders) parts.push(`새 폴더 ${newFolders}개`);
  if (merged) parts.push(`병합 ${merged}개`);
  summary.textContent = parts.join(' · ');
}

/** 겹치는 이름을 한 번에 처리한다. 폴더가 여럿일 때 같은 클릭을 반복시키지 않으려는 것. */
function resolveAllDupes(how) {
  for (const g of IMP.groups) {
    const c = impConflict(g);
    if (c?.type !== 'existing') continue;
    if (how === 'merge') {
      g.mode = 'merge';
      g.mergeId = c.folder.id;
    } else {
      g.mode = 'rename';
      g.newName = uniqueFolderName(impEffName(g));
    }
  }
  renderImportPlan();
  renderImportSource();
}

/** 파일을 읽어 창을 연다. 여기서는 아직 저장소를 건드리지 않는다. */
async function startImport(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('JSON 파일을 읽지 못했습니다.', true);
    return;
  }
  if (!data || !Array.isArray(data.items)) {
    toast('Nib 설정 파일이 아닙니다.', true);
    return;
  }

  IMP.groups = buildImportGroups(data);

  const total = IMP.groups.reduce((n, g) => n + g.items.length, 0);
  if (!total) {
    toast('파일에 가져올 프리셋이 없습니다.', true);
    return;
  }

  $('#imp-file').textContent = `${file.name} — 프리셋 ${total}개`;
  $('#imp-src').innerHTML = ''; // 처음 그리기 표시 (첫 폴더만 펼친다)
  renderImportSource();
  renderImportPlan();
  $('#importdlg').showModal();
}

/** 실제로 라이브러리에 넣는다. 창에서 정한 갈래를 그대로 따른다. */
async function runImport() {
  const live = IMP.groups.filter((g) => g.mode !== 'skip');

  // 같은 이름·같은 분류의 프리셋은 새로 만들지 않고 덮어쓴다. 가져올 때마다 사본이 늘면 곤란하다.
  const dedupeKey = (i) => JSON.stringify([i.name, i.category]);
  const byKey = new Map(state.items.map((i) => [dedupeKey(i), i]));

  let added = 0;
  let updated = 0;
  let madeFolders = 0;
  let mergedFolders = 0;

  for (const g of live) {
    let folderId = null;

    if (g.srcId) {
      const into = g.mode === 'merge' ? folderById(g.mergeId) : null;
      if (into) {
        folderId = into.id;
        mergedFolders++;
      } else {
        // uniqueFolderName 은 마지막 안전판이다. 창에서 이미 겹침을 걸렀지만,
        // 파일 안의 두 폴더가 같은 이름인 경우는 여기서 번호가 붙는다.
        const folder = {
          id: uid(),
          name: uniqueFolderName(impEffName(g) || g.origName),
          home: validHome(g.home),
          open: g.open !== false,
          createdAt: g.createdAt || Date.now(),
        };
        state.folders.push(folder);
        folderId = folder.id;
        madeFolders++;
      }
    }

    for (const it of g.items) {
      const item = { ...it, id: uid(), folderId, updatedAt: Date.now() };
      const key = dedupeKey(item);
      const existing = byKey.get(key);
      if (existing) {
        Object.assign(existing, {
          tags: item.tags,
          multi: item.multi,
          slots: item.slots,
          target: item.target,
          fav: item.fav || existing.fav || false,
          emoji: item.emoji || existing.emoji || '',
          // 이미 있는 프리셋을 남의 파일 때문에 다른 폴더로 옮기지는 않는다.
          // 폴더 밖에 있던 것만 가져온 폴더를 따라간다.
          folderId: existing.folderId || item.folderId || null,
          updatedAt: Date.now(),
        });
        updated++;
      } else {
        state.items.push(item);
        byKey.set(key, item);
        added++;
      }
    }
  }

  await saveLibrary();
  renderCats();
  renderList();

  const parts = ['추가 ' + added, '갱신 ' + updated];
  if (madeFolders) parts.push('새 폴더 ' + madeFolders);
  if (mergedFolders) parts.push('병합 ' + mergedFolders);
  toast(parts.join(' · '));
}

/* 폴더 핸들은 IndexedDB에 보관한다 (structured clone 가능). */
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('nib', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, val) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readonly');
    const r = tx.objectStore('kv').get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function connectFolder() {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'nib-backup' });
    await idbSet('backupDir', handle);
    await backupToFolder();
    updateFolderStatus();
    toast('백업 폴더를 연결했습니다.');
  } catch (e) {
    if (e?.name !== 'AbortError') toast('폴더를 연결하지 못했습니다.', true);
  }
}

async function backupToFolder() {
  const handle = await idbGet('backupDir');
  if (!handle) return;
  const perm = await handle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') return; // 재승인은 사용자가 버튼을 눌렀을 때만
  const file = await handle.getFileHandle('nib-presets.json', { create: true });
  const w = await file.createWritable();
  // 내보내기와 **같은 꾸러미**를 쓴다. 예전에는 { version: 1, items } 만 써서
  // 백업 파일에 폴더가 빠져 있었다 — 그 파일로 복구하면 분류가 통째로 사라진다.
  await w.write(JSON.stringify(libraryPayload(), null, 2));
  await w.close();
}

async function updateFolderStatus() {
  const el = $('#m-folder-status');
  const handle = await idbGet('backupDir');
  if (!handle) {
    el.textContent = '연결하면 저장할 때마다 nib-presets.json 이 자동으로 갱신됩니다.';
    return;
  }
  const perm = await handle.queryPermission({ mode: 'readwrite' });
  el.textContent =
    perm === 'granted'
      ? `연결됨: ${handle.name} / nib-presets.json`
      : `${handle.name} — 브라우저를 다시 켜서 권한이 풀렸습니다. 버튼을 눌러 재승인해 주세요.`;
}

/* ---------- 예시 프리셋 ---------- */

const SEED = [
  { emoji: '🎨', name: '수채 파스텔', category: 'style', target: 'base', tags: 'watercolor, pastel colors, soft lighting, delicate linework' },
  { emoji: '🖌️', name: '두꺼운 유화', category: 'style', target: 'base', tags: 'impasto, oil painting, visible brushstrokes, rich texture' },
  { emoji: '🌅', name: '역광 실루엣', category: 'scene', target: 'base', tags: 'backlighting, rim light, silhouette, sunset, lens flare' },
  { emoji: '📐', name: '로우앵글 역동', category: 'scene', target: 'base', tags: 'from below, dynamic angle, foreshortening, motion blur' },
  { emoji: '🌧️', name: '비 오는 골목', category: 'scene', target: 'base', tags: 'rain, wet pavement, narrow alley, neon signs, reflection, night' },
  { emoji: '👧', name: '은발 롱헤어', category: 'character', target: 'char', tags: 'silver hair, long hair, straight hair, blue eyes' },
  { emoji: '🎀', name: '트윈테일 소녀', category: 'character', target: 'char', tags: 'twintails, ribbon, large eyes, small mouth' },
  { emoji: '❌', name: '손 정리 UC', category: 'negative', target: 'uc', tags: 'bad hands, extra fingers, fused fingers, missing fingers' },
  { emoji: '⚠️', name: '품질 UC', category: 'negative', target: 'uc', tags: 'lowres, worst quality, jpeg artifacts, watermark, signature' },
];

async function seedPresets() {
  const have = new Set(state.items.map((i) => i.name));
  let n = 0;
  for (const s of SEED) {
    if (have.has(s.name)) continue;
    state.items.push({ id: uid(), createdAt: Date.now(), updatedAt: Date.now(), ...s });
    n++;
  }
  await saveLibrary();
  renderCats();
  renderList();
  toast(n ? `예시 ${n}개를 넣었습니다.` : '이미 모두 있습니다.');
}

/** 전체 초기화.
 *
 *  자동 백업은 저장할 때마다 같은 파일(nib-presets.json)을 덮어쓴다 —
 *  비운 뒤 한 번만 더 저장되면 백업 쪽도 빈 파일이 된다. 그래서 창 안에
 *  **내보내기 버튼을 같이 둔다.** "먼저 내보내세요"라고 적어만 두면 아무도 안 한다.
 *
 *  갈래가 둘인 이유는 폴더 구조를 다시 짜는 것이 프리셋을 다시 넣는 것만큼 귀찮기 때문이다.
 *  프리셋만 비우고 폴더는 남기는 쪽을 먼저 놓는다.
 */
function openResetDialog() {
  const dlg = $('#resetdlg');
  const nItems = state.items.length;
  const nFolders = state.folders.length;

  if (!nItems && !nFolders) {
    toast('지울 것이 없습니다.');
    return;
  }

  $('#reset-desc').textContent = `지금 프리셋 ${nItems}개, 폴더 ${nFolders}개가 저장되어 있습니다.`;

  // 아무 일도 일어나지 않을 갈래는 아예 감춘다. 눌러도 그대로면 고장으로 보인다.
  const onlyItems = $('#reset-items');
  onlyItems.hidden = !nItems || !nFolders; // 폴더가 없으면 두 갈래가 같은 뜻이다
  $('#reset-items-sub').textContent = `프리셋 ${nItems}개를 지우고 폴더 ${nFolders}개는 빈 채로 남깁니다.`;
  // 프리셋이 하나도 없으면 이 갈래는 사실상 '폴더 지우기'다. 이름도 그렇게 적는다.
  $('#reset-all-head').textContent = nItems ? '프리셋과 폴더를 모두 지우기' : '폴더를 모두 지우기';
  $('#reset-all-sub').textContent = `${resetPhrase(nItems, nFolders)}를 지워 처음 상태로 되돌립니다.`;

  $('#reset-export').onclick = () => exportAll();
  $('#reset-items').onclick = () => runReset(false);
  $('#reset-all').onclick = () => runReset(true);
  $('#reset-cancel').onclick = () => dlg.close();
  dlg.showModal();
}

/** "프리셋 12개와 폴더 3개" — 0인 쪽은 아예 말하지 않는다.
 *  "프리셋 0개와 폴더 4개를 지웠습니다"는 읽는 사람을 멈칫하게 만든다. */
function resetPhrase(nItems, nFolders) {
  const parts = [];
  if (nItems) parts.push(`프리셋 ${nItems}개`);
  if (nFolders) parts.push(`폴더 ${nFolders}개`);
  return parts.join('와 ');
}

async function runReset(alsoFolders) {
  const nItems = state.items.length;
  const nFolders = alsoFolders ? state.folders.length : 0;
  const what = resetPhrase(nItems, nFolders);
  if (!what) return;
  if (!confirm(`${what}를 지웁니다.\n되돌릴 수 없습니다. 계속할까요?`)) return;

  state.items = [];
  if (alsoFolders) state.folders = [];
  await saveLibrary();
  $('#resetdlg').close();
  $('#menu').close();
  renderCats();
  renderList();
  toast(`${what}를 지웠습니다.`);
}

/* ---------- 테마 ----------
 * 'auto'는 data-theme 속성을 지운다. 그러면 CSS의 prefers-color-scheme 블록이 담당한다.
 * 'light' / 'dark'는 속성을 박아 매체 질의를 덮는다.
 * NovelAI 위의 창 셋도 같은 키를 듣는다 (shared-ui.js의 watchTheme).
 */

function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') {
    document.documentElement.setAttribute('data-theme', mode);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  document.querySelectorAll('#theme-seg button').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.theme === (mode || 'auto')));
  });
}

async function initTheme() {
  let mode = 'auto';
  try {
    const got = await chrome.storage.local.get(THEME_KEY);
    if (got[THEME_KEY]) mode = got[THEME_KEY];
  } catch {}
  applyTheme(mode);

  document.querySelectorAll('#theme-seg button').forEach((b) => {
    b.addEventListener('click', async () => {
      const picked = b.dataset.theme;
      applyTheme(picked);
      await chrome.storage.local.set({ [THEME_KEY]: picked });
    });
  });
}

/* ---------- 사용량 칩 ----------
 * 자세한 통계는 NovelAI 위에 뜨는 오버레이 창이 담당한다. 여기는 현재 잔량만 보여준다.
 */

async function renderUsageChip() {
  const chip = $('#btn-usage');
  let ledger = null;
  try {
    const got = await chrome.storage.local.get(LEDGER_KEY);
    ledger = got[LEDGER_KEY];
  } catch {}

  const cur = ledger?.current;
  if (!cur || !Number.isFinite(cur.p)) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  chip.textContent = cur.p + '%';
  const gens = (ledger.gens || []).length;
  chip.title = `Opus 잔량 ${cur.p}% · 생성 기록 ${gens}건 — 눌러서 사용량 창 열기`;
}

/* ---------- 버전 표기 ----------
 * 설정 창 최하단. 값은 manifest.json 하나만 본다 — 버전을 코드에 또 적으면
 * 반드시 한쪽만 고치는 날이 온다. */

function showVersion() {
  const el = $('#m-version');
  if (!el) return;
  try {
    const m = chrome.runtime.getManifest();
    el.textContent = m.name + ' ' + m.version;
  } catch {
    el.textContent = '';
  }
}

/* ---------- 토스트 ---------- */

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 2600);
}

/* ---------- 초기화 ---------- */

async function init() {
  await initTheme();
  await loadLibrary();
  renderCats();
  renderList();

  $('#search').addEventListener('input', (e) => {
    state.query = e.target.value;
    renderList();
  });

  $('#btn-new').addEventListener('click', () => openEditor(null));
  $('#btn-newfolder').addEventListener('click', () => openFolderDialog(null));
  $('#btn-refresh').addEventListener('click', refreshPage);
  $('#btn-capture').addEventListener('click', captureCurrent);
  $('#btn-clear').addEventListener('click', openClearPicker);

  $('#btn-menu').addEventListener('click', async () => {
    updateFolderStatus();
    const got = await chrome.storage.local.get([HIDE_SUGGEST_KEY, FLAT_VIEWER_KEY]);
    $('#m-hide-suggest').checked = got[HIDE_SUGGEST_KEY] === true;
    $('#m-flat-viewer').checked = got[FLAT_VIEWER_KEY] === true;
    showVersion();
    $('#menu').showModal();
  });

  // 콘텐츠 스크립트가 storage.onChanged 로 듣고 있어서 저장만 하면 즉시 반영된다.
  $('#m-hide-suggest').addEventListener('change', async (e) => {
    await chrome.storage.local.set({ [HIDE_SUGGEST_KEY]: e.target.checked });
    toast(e.target.checked ? '제안을 숨깁니다.' : '제안을 다시 표시합니다.');
  });
  // viewer.js도 storage.onChanged 로 듣고 있어서 저장만 하면 즉시 반영된다.
  $('#m-flat-viewer').addEventListener('change', async (e) => {
    await chrome.storage.local.set({ [FLAT_VIEWER_KEY]: e.target.checked });
    toast(e.target.checked ? '이미지 모서리를 각지게 표시합니다.' : '모서리를 NovelAI 기본값으로 되돌립니다.');
  });
  $('#m-close').addEventListener('click', () => $('#menu').close());
  $('#m-export').addEventListener('click', exportAll);
  $('#m-export-folders').addEventListener('click', openExportPicker);
  $('#m-import').addEventListener('click', () => $('#m-file').click());
  // 같은 파일을 다시 골라도 change 가 나도록 값을 비운다.
  $('#m-file').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) startImport(f);
    e.target.value = '';
  });

  // 불러오기 창 — 파일 하나를 두고 이 창 안에서만 오간다.
  $('#imp-cancel').addEventListener('click', () => $('#importdlg').close());
  $('#imp-ok').addEventListener('click', async () => {
    if ($('#imp-ok').disabled) return;
    $('#importdlg').close();
    await runImport();
  });
  $('#imp-bulk-merge').addEventListener('click', () => resolveAllDupes('merge'));
  $('#imp-bulk-rename').addEventListener('click', () => resolveAllDupes('rename'));
  $('#m-folder').addEventListener('click', connectFolder);
  $('#m-seed').addEventListener('click', seedPresets);
  $('#m-reset').addEventListener('click', openResetDialog);

  // 사용량 창은 사이드 패널이 아니라 NovelAI 화면 위에 띄운다. 정보가 많아 좁은 폭에 안 맞는다.
  $('#btn-usage').addEventListener('click', async () => {
    const res = await send({ cmd: 'overlay' });
    if (!res?.ok) toast(res?.error || '창을 열지 못했습니다.', true);
  });

  // 예약 창도 마찬가지다. 여는 순간의 화면 상태를 베이스로 얼리므로 NovelAI 위에 있어야 한다.
  $('#btn-queue').addEventListener('click', async () => {
    const res = await send({ cmd: 'queue' });
    if (!res?.ok) toast(res?.error || '예약 창을 열지 못했습니다.', true);
  });

  // 정리 창도 같다. 위·아래 두 칸이 384px 폭에서는 손톱만 해진다.
  $('#btn-cleaner').addEventListener('click', async () => {
    const res = await send({ cmd: 'cleaner' });
    if (!res?.ok) toast(res?.error || '정리 창을 열지 못했습니다.', true);
  });

  await renderUsageChip();

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    if (changes[LEDGER_KEY]) renderUsageChip();

    // 편집 창은 NovelAI 화면 위에 있고 저장도 거기서 한다. 여기서는 결과만 받아 다시 그린다.
    // 내가 쓴 변경으로도 들어오지만, 저장소에서 다시 읽어 그리는 것이라 해가 없다.
    if (changes[LIB_KEY]) {
      await loadLibrary();
      renderCats();
      renderList();
      // 자동 백업은 사이드 패널만 할 수 있다(폴더 핸들이 여기 있다). 늦게라도 따라 붙인다.
      backupToFolder().catch(() => {});
    }
  });

  await refreshPage();

  // 탭을 옮기거나 페이지가 바뀌면 현황을 다시 읽는다.
  chrome.tabs.onActivated.addListener(refreshPage);
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if (info.status === 'complete') refreshPage();
  });
}

init();
