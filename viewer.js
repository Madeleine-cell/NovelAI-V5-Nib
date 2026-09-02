/* Nib — 뷰어 평탄화 (독립 모듈)
 *
 * 하는 일은 하나뿐이다. **모서리 라운딩과 호버 줌을 CSS로 덮어쓴다.**
 * 그 이상은 하지 않는다 — 이유는 아래.
 *
 * 이 파일은 다른 어떤 Nib 파일에도 기대지 않는다(NibUI도, content.js의 라우터도).
 * NovelAI가 뷰어를 갈아엎으면 이 파일만 조용히 아무 일도 안 하게 되고,
 * 프롬프트 삽입 엔진은 멀쩡해야 하기 때문이다. 그래서 manifest 목록의 맨 뒤에 있다.
 *
 * ── V5 출력부에 대해 실측한 것 (2026-08, 번들 chunks/9874-*.js + 라이브 DOM) ─────────
 *
 * 출력부는 <img> 목록이 아니라 **무한 캔버스**다.
 *
 *   .image-gen-canvas
 *     └ div (클래스 없음)          ← 카메라. transform이 JS로 매 프레임 찍힌다
 *         style="transform-origin: 0 0"
 *         transform: matrix(0.911003, 0, 0, 0.911003, 522, 53.11)
 *         └ .image-gen-canvas-tile   (sc-f6314b86-1: position:absolute만. 라운딩 없음)
 *             └ div                  (sc-f0ebfba1-22: 해시가 빌드마다 바뀐다)
 *                 └ img.image-grid-image   ← 여기에 라운딩이 있다
 *
 * **카메라 div의 transform을 덮으면 안 된다.** 애니메이션만 죽는 게 아니라 카메라가
 * 통째로 죽어서 이미지가 화면 밖에 남는다. 그래서 이 파일의 선택자는 전부
 * `image-grid-*` 클래스에만 걸린다 — 카메라 div는 클래스가 없어 절대 걸리지 않는다.
 *
 * 실제로 걸려 있던 규칙 (해시 클래스는 빌드마다 바뀌므로 자식의 안정된 클래스로 잡는다):
 *
 *   .fHbPDq > img { border-radius: 8px; overflow: hidden }
 *   .fHbPDq > img, .fHbPDq > .image-grid-generating {
 *     transition: transform 0.25s cubic-bezier(0.22, 1, 0.36, 1);
 *   }
 *   .eacbov > img, .eacbov > .image-grid-generating,
 *   .eacbov > .image-grid-thumbnail-standin,
 *   .eacbov > .image-grid-variation-backdrop      { transform: scale(0.98) }
 *   .eacbov:hover > img, .eacbov:hover > .image-grid-thumbnail-standin,
 *   .eacbov:hover > .image-grid-variation-backdrop { transform: scale(1) }
 *
 * 즉 호버 줌의 정체는 **0.98 → 1.0**이고, 0.25초 커브가 그 위에 얹혀 있다.
 *
 * ── 왜 스크롤 애니메이션과 패닝·줌은 여기서 안 건드리나 ─────────────────────────────
 *
 * NovelAI가 이미 스위치를 갖고 있다. Settings → Image Generation:
 *
 *   simpleOutputViewer  "Simple Output Viewer"        현재 생성만, 장식 없이
 *   canvasReducedMotion "Reduced Motion"              카메라 트랜지션 제거
 *   canvasLockCamera    "Lock Output Viewer Camera"   패닝·줌 비활성화
 *
 * 번들에서 확인한 게이트다.
 *
 *   function yb(){ return prefersReducedMotion() || settings.canvasReducedMotion }
 *   function yx(){ return settings.canvasLockCamera }
 *   s = settings.simpleOutputViewer || windowSize.width <= MOBILE_BREAKPOINT
 *
 * 공식 경로가 있는데 흉내를 내면 두 벌이 서로 어긋날 뿐이다. 라운딩만 남는다 —
 * 그건 NovelAI에 설정이 없다.
 *
 * `!important`가 인라인 스타일을 이기는 것은 규격이다(작성자 !important >
 * 인라인 non-important). 하지만 여기서는 그 힘이 필요 없다 — 위 규칙들은
 * 전부 스타일시트에서 오고, 인라인으로 오는 것은 카메라 transform뿐인데
 * 그건 애초에 선택자에 안 걸린다.
 */

(() => {
  const FLAT_VIEWER_KEY = 'nib.flatViewer';
  const STYLE_ID = 'nib-flat-viewer';

  /* 라운딩이 걸리는 네 갈래. 전부 난독화되지 않은 이름이라 빌드가 바뀌어도 살아남는다.
   * (부모 래퍼는 sc-f0ebfba1-22 → .fHbPDq 처럼 해시라 쓸 수 없다.) */
  const TARGETS = [
    'img.image-grid-image',
    '.image-grid-generating',
    '.image-grid-thumbnail-standin',
    '.image-grid-variation-backdrop',
  ].join(',\n');

  /* border-radius: 라운딩(8px)을 없앤다.
   * transform · transition: 호버 줌(0.98 → 1)과 그 위의 0.25초 커브를 없앤다.
   *   animation 은 건드리지 않는다 — 생성 중 점 세 개가 멈추면 고장난 것처럼 보인다. */
  const CSS = `
/* Nib — 뷰어 평탄화 */
${TARGETS} {
  border-radius: 0 !important;
  transform: none !important;
  transition: none !important;
}
`;

  const styleEl = () => document.getElementById(STYLE_ID);

  function apply(on) {
    const existing = styleEl();
    if (!on) {
      if (existing) existing.remove();
      return;
    }
    if (existing) {
      existing.textContent = CSS; // 개발 중 CSS를 고쳤을 때를 위해 갱신해 둔다
      return;
    }
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    // head가 없을 수 있는 시점을 대비해 documentElement에 건다. head가 있으면 그쪽이 낫다.
    (document.head || document.documentElement).appendChild(el);
  }

  chrome.storage.local
    .get(FLAT_VIEWER_KEY)
    .then((got) => apply(got[FLAT_VIEWER_KEY] === true))
    .catch(() => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[FLAT_VIEWER_KEY]) return;
    apply(changes[FLAT_VIEWER_KEY].newValue === true);
  });
})();
