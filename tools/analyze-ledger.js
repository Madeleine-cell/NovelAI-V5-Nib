/* Nib — 내보낸 원장(nib-ledger-*.json)을 분석하는 도구. 확장에는 실리지 않는다(manifest에 없음).
 *
 *   node tools/analyze-ledger.js "C:\Users\...\Downloads\nib-ledger-20260923-181649.json"
 *
 * 사용량 창에서 `기록 내보내기`로 받은 파일을 넣으면 다음을 찍는다.
 *   1. 사용량 창이 보여줄 값 — overlay.js 의 analyze()를 그대로 불러 쓴다(사본이 아니다)
 *   2. 하락 구간 목록 — 두 끝이 모두 "생성 직후 퍼센트가 떨어진 순간"인 구간
 *   3. 소모 모델 비교 — 지금 코드의 식이 여전히 맞는지, 다른 식이 더 맞지 않는지
 *   4. 스텝별 직접 측정 — 한 가지 스텝(~1MP)만 들어간 구간으로 잰 장당 소모
 *   5. Anlas 기록 검산 — 잰 합계 대 (서명별 단가 × 장수)
 *   6. 100%에서 첫 하락 — 꽉 찬 상태에서 몇 장째에 99가 됐는지로 잰 장당 소모(Medium 측정에 씀)
 *
 * Medium 효과(nai-diffusion-5-full-medium)는 4·6에서 "14M"처럼 M을 붙여 따로 센다.
 *
 * 읽는 법은 ARCHITECTURE.md "할당량 소모 모델"과 HANDOFF.md "실측 다시 하기". */

const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) {
  console.error('사용법: node tools/analyze-ledger.js <nib-ledger.json>');
  process.exit(1);
}
const L = JSON.parse(fs.readFileSync(file, 'utf8'));

// overlay.js 를 가짜 브라우저 환경에서 불러 NibUsage 를 얻는다.
// isMediumModel 은 shared-ui.js 것의 사본이다(그 파일은 DOM 없이 못 불러온다).
const isMediumModel = (m) => /^nai-diffusion-5-full-medium(-|$)/.test(String(m || ''));
globalThis.NibUI = { esc: (s) => String(s), watchTheme() {}, shellCSS: () => '', isMediumModel };
globalThis.chrome = { storage: { onChanged: { addListener() {} } } };
const overlaySrc = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');
eval(overlaySrc);
const { analyze, unitsPerImage, paidSize } = globalThis.NibUsage;
const STEP_FIXED = Number((/const STEP_FIXED = ([\d.]+)/.exec(overlaySrc) || [])[1]);
const MEDIUM_FACTOR = Number((/const MEDIUM_FACTOR = ([\d.]+)/.exec(overlaySrc) || [])[1]);
const MEDIUM = 'nai-diffusion-5-full-medium';

const UP = 832 * 1216;
const hm = (t) => new Date(t).toLocaleString('sv-SE').slice(5, 16);
/** 서명 + 효과. 생성 기록(g)을 받는다 — Medium은 서명이 같아도 소모·단가가 다를 수 있다. */
const sig = (g) => {
  const [w, h, st] = String(g.sig).split('x').map(Number);
  const md = isMediumModel(g.model);
  return { w, h, st, md, r: (w * h) / UP, u: unitsPerImage(w, h, st, g.model), paid: paidSize(w, h, st) };
};
const stepKey = (p) => p.st + (p.md ? 'M' : '');
const hasSig = (g) => /^\d+x\d+x\d+$/.test(g.sig || '');
const isV5 = (g) => g.model == null || /^nai-diffusion-5(-|$)/.test(g.model);

/* ---------- 1. 사용량 창 ---------- */
console.log(`원장: 생성 ${L.gens.length} · 마크 ${L.marks.length} · 현재 ${L.current?.p}% · 회복 ${L.spp}초/1%\n`);
console.log('1. 사용량 창 값 (overlay.js analyze)');
for (const w of [50, 200, 0]) {
  const a = analyze(L, w);
  if (!a.ok) { console.log(`   ${w || '전체'}: ${a.reason}`); continue; }
  console.log(
    `   ${String(w || '전체').padEnd(4)} 구간 ${a.segments}개 ${a.images}장 · 소모 ${a.consumed.toFixed(3)}±${a.consumedErr.toFixed(3)}%p` +
      ` · 기준 1장당 ${a.avg.toFixed(4)} (±${(a.relative * 100).toFixed(1)}%)` +
      (a.last ? ` · 지금 설정 ${a.last.w}×${a.last.h}·${a.last.steps} = ${a.last.per.toFixed(4)}` : '')
  );
  const E = a.effort, one = (x) => (x ? `${x.w}×${x.h}·${x.steps} ${x.per.toFixed(4)}${x.guess ? '(환산)' : ''}` : '—');
  console.log(
    `        High ${E.highImages}장 · Medium ${E.mediumImages}장 · High 1장 ${one(E.high)} · Medium 1장 ${one(E.medium)}` +
      (E.factor ? ` · Medium 실측 배수 ${E.factor.value.toFixed(3)}±${E.factor.err.toFixed(3)} (${E.factor.images}장, 코드 ${E.factor.code})` : '') +
      (a.fullStart ? ' · 꽉 찬 100% 시작 구간 포함' : '')
  );
}

/* ---------- 2. 하락 구간 ---------- */
const drops = [];
for (let i = 1; i < L.marks.length; i++) {
  const m = L.marks[i];
  if (!(m.p < L.marks[i - 1].p)) continue;
  const g = L.gens.filter((x) => x.t <= m.t).at(-1);
  if (g && m.t - g.t <= 120000) drops.push(m); // overlay.js ANCHOR_LAG_MS
}
const spp = L.spp || 6048;
const rows = [];
for (let i = 1; i < drops.length; i++) {
  const S = drops[i - 1], E = drops[i];
  if (L.marks.some((m) => m.t >= S.t && m.t < E.t && m.p >= 100)) continue; // 100% 도달 구간
  const gs = L.gens.filter((x) => x.t > S.t && x.t <= E.t && isV5(x) && hasSig(x));
  const free = gs.map(sig).filter((p) => !p.paid);
  const paid = gs.map(sig).filter((p) => p.paid);
  rows.push({
    lab: `${hm(S.t)}→${hm(E.t).slice(6)}`,
    cons: S.p - E.p + (E.t - S.t) / 1000 / spp,
    free, paid,
    u: free.reduce((s, p) => s + p.u, 0),
    r: free.reduce((s, p) => s + p.r, 0),
    rs: free.reduce((s, p) => s + p.r * p.st, 0),
    prs: paid.reduce((s, p) => s + p.r * p.st, 0),
  });
}
console.log(`\n2. 하락 구간 ${rows.length}개 (100% 도달 구간 제외)`);
for (const r of rows) {
  const h = {};
  r.free.forEach((p) => { const k = `${p.w}x${p.h}x${stepKey(p)}`; h[k] = (h[k] || 0) + 1; });
  console.log(`   ${r.lab.padEnd(21)} 소모 ${r.cons.toFixed(3)} · 무료 ${String(r.free.length).padStart(3)} · 과금 ${String(r.paid.length).padStart(3)} · ${Object.entries(h).map(([k, v]) => k + ':' + v).join(' ')}`);
}

/* ---------- 3. 모델 비교 ---------- */
function ls(cols) {
  const k = cols.length, M = [...Array(k)].map(() => Array(k).fill(0)), v = Array(k).fill(0);
  for (const r of rows) {
    const x = cols.map((c) => c(r));
    for (let i = 0; i < k; i++) { v[i] += x[i] * r.cons; for (let j = 0; j < k; j++) M[i][j] += x[i] * x[j]; }
  }
  const A = M.map((row, i) => [...row, v[i]]);
  for (let i = 0; i < k; i++) {
    let p = i; for (let j = i + 1; j < k; j++) if (Math.abs(A[j][i]) > Math.abs(A[p][i])) p = j;
    [A[i], A[p]] = [A[p], A[i]];
    for (let j = i + 1; j < k; j++) { const q = A[j][i] / A[i][i]; for (let c = i; c <= k; c++) A[j][c] -= q * A[i][c]; }
  }
  const b = Array(k);
  for (let i = k - 1; i >= 0; i--) { let s = A[i][k]; for (let j = i + 1; j < k; j++) s -= A[i][j] * b[j]; b[i] = s / A[i][i]; }
  const res = rows.map((r) => r.cons - cols.reduce((s, c, i) => s + b[i] * c(r), 0));
  return { b, res, rms: Math.sqrt(res.reduce((s, x) => s + x * x, 0) / rows.length) };
}
if (rows.length >= 3) {
  console.log('\n3. 소모 모델 비교 — RMS가 작을수록 잘 맞는다. 측정 한계는 약 0.03~0.04');
  // "지금 코드"는 overlay.js 의 환산을 그대로 쓴다(Medium 배수 포함). 아래 자유 맞춤들은 Medium을 High와 같이 본다.
  const cur = ls([(r) => r.u]);
  console.log(`   지금 코드 (STEP_FIXED ${STEP_FIXED})           기준 1장 ${cur.b[0].toFixed(4)} · RMS ${cur.rms.toFixed(4)}`);
  const aff = ls([(r) => r.r, (r) => r.rs]);
  const F = aff.b[0] / (aff.b[0] + 28 * aff.b[1]);
  console.log(`   자유 맞춤 a·px + b·px·스텝            고정분 ${F.toFixed(3)} · RMS ${aff.rms.toFixed(4)}  ← 고정분이 ${STEP_FIXED}에서 크게 벗어나면 검토`);
  console.log(`   순수 px×스텝 (고정분 없음)             RMS ${ls([(r) => r.rs]).rms.toFixed(4)}`);
  console.log(`   px만 (스텝 무관)                        RMS ${ls([(r) => r.r]).rms.toFixed(4)}`);
  if (rows.some((r) => r.paid.length)) {
    const e = ls([(r) => r.r, (r) => r.rs, (r) => r.prs]);
    console.log(`   과금 생성 계수 / 무료 계수 (A1 검사)   ${(e.b[2] / e.b[1] * 100).toFixed(1)}%  ← 0 근처면 "과금은 할당량 안 씀"이 맞다`);
  }
  console.log(`   지금 코드 잔차: ${cur.res.map((x) => x.toFixed(3)).join(' ')}`);
}

/* ---------- 4. 스텝별 직접 측정 ---------- */
/* 한 칸 측정은 경계에서 다른 설정이 한두 장 섞이기 쉽다(칸이 떨어진 순간 한 번 더 누른 것 등).
 * 한 설정이 장수의 80% 이상이면 쓴다 — 나머지는 코드 예측(기준 1장당 × 기준 장)만큼 빼고 나눈다.
 * 섞인 장이 많을수록 코드 식에 기대는 몫이 커지므로 80%로 막는다. */
const a0 = analyze(L, 0);
const DOMINANT = 0.8;
const by = {};
for (const r of rows) {
  if (!r.free.length || !r.free.every((p) => p.r > 0.99)) continue;
  const cnt = {};
  r.free.forEach((p) => (cnt[stepKey(p)] = (cnt[stepKey(p)] || 0) + 1));
  const [key, n] = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
  if (n / r.free.length < DOMINANT) continue;
  if (n < r.free.length && !a0.ok) continue; // 뺄 값을 낼 평균이 없다
  const others = r.free.filter((p) => stepKey(p) !== key);
  const cons = r.cons - (others.length ? a0.avg * others.reduce((t, p) => t + p.u, 0) : 0);
  (by[key] = by[key] || []).push({ cons, n, mixed: others.length });
}
const predFor = (key) =>
  a0.ok ? a0.avg * unitsPerImage(832, 1216, parseInt(key, 10), key.endsWith('M') ? MEDIUM : undefined) : NaN;
if (Object.keys(by).length) {
  console.log(`\n4. 스텝별 직접 측정 (~1MP · 한 스텝이 ${DOMINANT * 100}% 이상인 구간, M = Medium 효과)`);
  for (const s of Object.keys(by).sort((x, y) => parseInt(x, 10) - parseInt(y, 10))) {
    const R = by[s], C = R.reduce((t, r) => t + r.cons, 0), N = R.reduce((t, r) => t + r.n, 0);
    const mixed = R.reduce((t, r) => t + r.mixed, 0);
    const pred = predFor(s);
    const ratio = C / N / pred;
    console.log(
      `   ${s.padStart(3)}스텝: 구간 ${R.length}개 ${N}장 → 실측 ${(C / N).toFixed(4)} · 코드 예측 ${pred.toFixed(4)} (${((ratio - 1) * 100).toFixed(1)}%)` +
        (mixed ? ` · 섞인 ${mixed}장은 예측만큼 뺌` : '') +
        (s.endsWith('M') ? `  ← MEDIUM_FACTOR ${MEDIUM_FACTOR} → ${(MEDIUM_FACTOR * ratio).toFixed(2)} 이면 맞음` : '')
    );
  }
}

/* ---------- 5. Anlas 검산 ---------- */
// 단가는 서명 + 효과로 묶는다 — Medium은 스텝 항이 약 0.94배라 같은 서명이어도 값이 다르다(background.js 와 같은 규칙).
const priceKey = (g) => g.sig + (isMediumModel(g.model) ? 'M' : '');
const price = {};
for (const g of L.gens) if (g.cost > 0 && g.n === 1) (price[priceKey(g)] = price[priceKey(g)] || {})[g.cost] = (price[priceKey(g)][g.cost] || 0) + 1;
const unit = (k) => { const e = Object.entries(price[k] || {}).sort((a, b) => b[1] - a[1])[0]; return e ? +e[0] : null; };
let exp = 0, rec = 0, unk = 0, nul = 0;
for (const g of L.gens) {
  const e = g.free === true ? 0 : unit(priceKey(g));
  if (e == null) { unk++; continue; }
  exp += e;
  if (Number.isFinite(g.cost) && g.cost >= 0) rec += g.cost; else nul++;
}
console.log(`\n5. Anlas 검산: 잰 합 ${rec} · 예상(단가×장수) ${exp} · 차이 ${((rec / exp - 1) * 100).toFixed(1)}% · 모름 ${nul}건 · 단가 모름 ${unk}건`);
console.log('   (2026-09-23 이전 기록은 옛 page.js 버그로 "무료인데 45"가 섞여 +쪽으로 부풀어 있다. 새 기록은 −3% 안팎이 정상)');

/* ---------- 6. 100%에서 첫 하락 ----------
 * 화면 퍼센트는 반올림이라 꽉 찬 100.0에서 0.5%p를 써야 99가 된다. 그러니 "몇 장째에 99가 됐나"가
 * 곧 장당 소모의 범위다 — (0.5 + 회복) / k 이상, (0.5 + 회복) / (k−1) 미만.
 * 단, 100으로 바뀐 순간의 실제 값은 99.5 이상일 뿐이므로 **0.5%p를 회복할 만큼(spp/2초) 더 머문 뒤에**
 * 시작한 생성만 쓴다. 그 전이면 "가득 찼다는 보장 없음"으로 적고 계산하지 않는다.
 * 브라우저를 꺼두면 100 마크가 다시 연 순간에야 찍히므로, 그 앞 마크(Q)에서 **가장 낮게 잡아도**
 * 100까지 찰 만큼 시간이 지났으면 그것도 가득 찬 것으로 본다. 가장 낮게 = Q.p − 0.5에서
 * Q~P 사이 생성이 쓸 수 있는 최대치(평균의 2배로 넉넉히)를 뺀 값. */
const UNIT_MAX = a0.ok ? 2 * a0.avg : 0.15;
const firsts = [];
for (let i = 1; i < L.marks.length; i++) {
  const P = L.marks[i - 1], D = L.marks[i], Q = L.marks[i - 2];
  if (P.p !== 100 || D.p !== 99) continue;
  const gs = L.gens.filter((x) => x.t > P.t && x.t <= D.t && isV5(x) && hasSig(x));
  if (!gs.length || D.t - gs.at(-1).t > 120000) continue; // 생성 직후 하락이 아니다
  const lowestAtQ = Q
    ? Q.p - 0.5 - UNIT_MAX * L.gens.filter((x) => x.t > Q.t && x.t <= P.t && isV5(x) && hasSig(x)).reduce((s, x) => s + sig(x).u, 0)
    : -Infinity;
  const full =
    gs[0].t - P.t >= (spp / 2) * 1000 || (!!Q && lowestAtQ + (gs[0].t - Q.t) / 1000 / spp >= 100);
  const used = 0.5 + (D.t - gs[0].t) / 1000 / spp;
  const ps = gs.map(sig);
  const kinds = [...new Set(ps.map((p) => `${p.w}x${p.h}x${stepKey(p)}`))];
  firsts.push({ P, D, k: gs.length, full, used, u: ps.reduce((s, p) => s + p.u, 0), kinds });
}
if (firsts.length) {
  console.log('\n6. 100%에서 첫 하락 (k장째에 99) — 장당 소모 범위');
  for (const f of firsts) {
    const lo = f.used / f.k, hi = f.k > 1 ? f.used / (f.k - 1) : Infinity;
    // 가득 찬 게 아니면 실제 시작값이 100보다 낮다 — 아래 한계는 무의미하고 위 한계만 남는다.
    if (!f.full) { console.log(`   ${hm(f.D.t)}  ${f.k}장 (${f.kinds.join(' ')}) → 장당 ≤ ${hi.toFixed(4)}  ※ 100% 도달 직후라 가득 찼다는 보장 없음`); continue; }
    const line = `   ${hm(f.D.t)}  ${f.k}장 (${f.kinds.join(' ')}) → 장당 ${lo.toFixed(4)} ~ ${hi.toFixed(4)}`;
    const per = a0.ok ? f.u / f.k : NaN; // 장당 기준 장(코드 환산)
    console.log(line + (a0.ok ? ` · 코드 예측 ${(a0.avg * per).toFixed(4)} (기준 장 ${per.toFixed(3)} × ${a0.avg.toFixed(4)})` : ''));
  }
}
