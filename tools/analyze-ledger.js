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
globalThis.NibUI = { esc: (s) => String(s), watchTheme() {}, shellCSS: () => '' };
globalThis.chrome = { storage: { onChanged: { addListener() {} } } };
const overlaySrc = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');
eval(overlaySrc);
const { analyze, unitsPerImage, paidSize } = globalThis.NibUsage;
const STEP_FIXED = Number((/const STEP_FIXED = ([\d.]+)/.exec(overlaySrc) || [])[1]);

const UP = 832 * 1216;
const hm = (t) => new Date(t).toLocaleString('sv-SE').slice(5, 16);
const sig = (s) => {
  const [w, h, st] = String(s).split('x').map(Number);
  return { w, h, st, r: (w * h) / UP, paid: paidSize(w, h, st) };
};
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
  const free = gs.filter((x) => !sig(x.sig).paid).map((x) => sig(x.sig));
  const paid = gs.filter((x) => sig(x.sig).paid).map((x) => sig(x.sig));
  rows.push({
    lab: `${hm(S.t)}→${hm(E.t).slice(6)}`,
    cons: S.p - E.p + (E.t - S.t) / 1000 / spp,
    free, paid,
    r: free.reduce((s, p) => s + p.r, 0),
    rs: free.reduce((s, p) => s + p.r * p.st, 0),
    prs: paid.reduce((s, p) => s + p.r * p.st, 0),
  });
}
console.log(`\n2. 하락 구간 ${rows.length}개 (100% 도달 구간 제외)`);
for (const r of rows) {
  const h = {};
  r.free.forEach((p) => { const k = `${p.w}x${p.h}x${p.st}`; h[k] = (h[k] || 0) + 1; });
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
  const cur = ls([(r) => STEP_FIXED * r.r + (1 - STEP_FIXED) * r.rs / 28]);
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
const by = {};
for (const r of rows) {
  if (!r.free.length) continue;
  const st = new Set(r.free.map((p) => p.st));
  if (st.size === 1 && r.free.every((p) => p.r > 0.99)) (by[[...st][0]] = by[[...st][0]] || []).push(r);
}
const a0 = analyze(L, 0);
if (Object.keys(by).length) {
  console.log('\n4. 스텝별 직접 측정 (한 스텝·~1MP만 든 구간)');
  for (const s of Object.keys(by).sort((x, y) => x - y)) {
    const R = by[s], C = R.reduce((t, r) => t + r.cons, 0), N = R.reduce((t, r) => t + r.free.length, 0);
    const pred = a0.ok ? a0.avg * unitsPerImage(832, 1216, +s) : NaN;
    console.log(`   ${String(s).padStart(2)}스텝: 구간 ${R.length}개 ${N}장 → 실측 ${(C / N).toFixed(4)} · 코드 예측 ${pred.toFixed(4)} (${((C / N / pred - 1) * 100).toFixed(1)}%)`);
  }
}

/* ---------- 5. Anlas 검산 ---------- */
const price = {};
for (const g of L.gens) if (g.cost > 0 && g.n === 1) (price[g.sig] = price[g.sig] || {})[g.cost] = (price[g.sig][g.cost] || 0) + 1;
const unit = (s) => { const e = Object.entries(price[s] || {}).sort((a, b) => b[1] - a[1])[0]; return e ? +e[0] : null; };
let exp = 0, rec = 0, unk = 0, nul = 0;
for (const g of L.gens) {
  const e = g.free === true ? 0 : unit(g.sig);
  if (e == null) { unk++; continue; }
  exp += e;
  if (Number.isFinite(g.cost) && g.cost >= 0) rec += g.cost; else nul++;
}
console.log(`\n5. Anlas 검산: 잰 합 ${rec} · 예상(단가×장수) ${exp} · 차이 ${((rec / exp - 1) * 100).toFixed(1)}% · 모름 ${nul}건 · 단가 모름 ${unk}건`);
console.log('   (2026-09-23 이전 기록은 옛 page.js 버그로 "무료인데 45"가 섞여 +쪽으로 부풀어 있다. 새 기록은 −3% 안팎이 정상)');
