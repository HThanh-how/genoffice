import { DEFAULT_SCENE_FOR_APP, SCENES, sceneMeta } from './opening-scenes-meta'
import { runGOScene } from './opening-scenes-runner'

export { DEFAULT_SCENE_FOR_APP, SCENES, sceneMeta }
export type { SceneMeta } from './opening-scenes-meta'

/**
 * `GOScene(canvas, sceneId, tier, rgb, lt)` draws a scene on a plain 2D canvas, no libraries, and
 * returns a function that stops it. `tier` is `full` (60 fps, more of everything) or `lite` (30 fps,
 * fewer); `rgb` and `lt` are the app colour and a lighter tone of it, as "r,g,b". It also stops by
 * itself while the page is hidden.
 *
 * There is exactly one implementation of the scenes: `runGOScene` in `opening-scenes-runner.ts`,
 * a self-contained function (everything it uses is declared inside it, apart from browser
 * globals). The studio calls it directly; the opening window, which has no module loader and must
 * not use `eval`, gets the very same source text of it here, so a scene shown in the studio is by
 * construction the scene the window plays.
 */
export const SCENE_LIB = `window.GOScene=${runGOScene.toString()};`

/** What the splash page runs: start the app's scene on its canvas (nothing on the minimal tier). */
export const SCENE_BOOT = `
(function(){
  var b=document.body, c=document.getElementById('sea');
  if(!c||b.dataset.tier==='minimal'||!window.GOScene) return;
  window.GOScene(c,b.dataset.scene,b.dataset.tier,b.dataset.rgb,b.dataset.lt);
})();
`
