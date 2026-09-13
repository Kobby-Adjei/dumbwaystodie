import type { SurfaceState } from "../surfaces/ChatSurfaceAdapter";

/**
 * The decisions behind pairing, kept away from the `chrome` APIs.
 *
 * The service worker cannot be imported outside a browser, so anything in it
 * is effectively untested. These two answer the questions a user actually
 * asks when the button appears to do nothing — "why not?" and "did it really
 * work?" — which is exactly the logic that should not be guesswork.
 */

/**
 * Whether a URL falls under one of the manifest's match patterns.
 *
 * Deliberately narrow: these patterns are ours, all of the form
 * `https://host/*`, so this compares scheme and host and stops there rather
 * than pretending to implement Chrome's matching rules.
 */
export function matchesOrigin(url: string, pattern: string): boolean {
  const origin = pattern.replace(/\/\*$/, "");
  return url.startsWith(`${origin}/`) || url === origin;
}

export function isChatUrl(url: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesOrigin(url, pattern));
}

export function describeOrigins(patterns: readonly string[]): string {
  return patterns
    .map((pattern) => pattern.replace(/^https:\/\//, "").replace(/\/\*$/, ""))
    .join(" or ");
}

/**
 * Turns a probe into one sentence about whether this page can be driven.
 *
 * Pairing succeeding is not the same as the bridge working: pairing only
 * proves the content script answered. Reporting a bare "ready" while delivery
 * is broken sends the user hunting in the editor for a fault on this page, so
 * `deliver` leads and anything short of `auto` is stated rather than softened.
 */
export function summarizeSurface(state: SurfaceState): string {
  if (state.deliver.rung === "auto" && state.observe.rung === "auto") {
    return "Paired. This chat can be driven from your editor.";
  }
  if (state.deliver.rung === "unavailable") {
    return `Paired, but messages cannot be placed on this page${
      state.deliver.reason ? `: ${state.deliver.reason}` : "."
    }`;
  }
  if (state.observe.rung !== "auto") {
    return `Paired, but replies may need copying by hand${
      state.observe.reason ? `: ${state.observe.reason}` : "."
    }`;
  }
  return `Paired, with some steps left to you${
    state.deliver.reason ? `: ${state.deliver.reason}` : "."
  }`;
}
