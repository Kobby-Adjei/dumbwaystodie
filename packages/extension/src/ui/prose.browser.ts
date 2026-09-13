import { splitProse } from "./prose";

/**
 * Exposes the one tested implementation to the panel.
 *
 * The panel's renderer is hand-written JavaScript in `media/`, so it cannot
 * import from `src/`. The alternative was a second copy of `splitProse` living
 * in the webview — and two copies of a heuristic drift, which here would mean
 * the panel and its tests disagreeing about whether a diagram is a diagram.
 *
 * Bundled to `media/prose.generated.js` by build.mjs and loaded before the
 * renderer.
 */
declare global {
  // eslint-disable-next-line no-var
  var dwtdSplitProse: typeof splitProse | undefined;
}

globalThis.dwtdSplitProse = splitProse;
