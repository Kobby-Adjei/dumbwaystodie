/**
 * A chat surface, seen through three capabilities that fail separately
 * (spec §0O, and docs/design/chat-surface-bridge.md).
 *
 * The point of splitting them: when a site redesign moves the composer, the
 * *reading* half usually still works. One monolithic "adapter works / adapter
 * broken" flag would throw away a working half and make the failure look total.
 *
 * Every capability reports the rung it achieved, and the panel shows it. There
 * is no silent retry-harder path — a capability that cannot reach `auto` says
 * `assisted` and the user takes over that one step.
 */

export type Rung = "auto" | "assisted" | "unavailable";

export interface CapabilityState {
  rung: Rung;
  /** Why it is not `auto`, in words a user can act on. */
  reason?: string;
}

export interface SurfaceState {
  identify: CapabilityState;
  deliver: CapabilityState;
  observe: CapabilityState;
}

export interface DeliverResult {
  rung: Rung;
  /** True when the message was actually placed and sent. */
  sent: boolean;
  reason?: string;
}

export interface ObservedReply {
  text: string;
  /** How the text was obtained, so the panel can be honest about it. */
  rung: Rung;
}

export interface ChatSurfaceAdapter {
  readonly surfaceType: string;

  /** Does this adapter claim the page currently loaded? */
  matches(url: string): boolean;

  /** What it can do right now, on this DOM, in this moment. */
  probe(): SurfaceState;

  /** Puts text in the composer and sends it. */
  deliver(text: string): Promise<DeliverResult>;

  /**
   * Resolves when the assistant's latest message has stopped changing.
   *
   * Completion is quiescence plus a floor: our own protocol blocks close with
   * a fence, so a complete block short-circuits the wait, but plain prose has
   * no marker and has to settle.
   */
  observe(signal: AbortSignal): Promise<ObservedReply>;
}

/**
 * Resolves the first selector that matches, reporting which one won.
 *
 * Site adapters list several candidates oldest-last. Which one matched is
 * logged, because "it broke" and "it fell through to the third fallback" look
 * identical from the outside until the day the third one goes too.
 */
export function resolveSelector(
  root: ParentNode,
  candidates: string[],
): { element: Element; selector: string; index: number } | undefined {
  for (let index = 0; index < candidates.length; index += 1) {
    const selector = candidates[index];
    if (!selector) {
      continue;
    }
    const element = root.querySelector(selector);
    if (element) {
      return { element, selector, index };
    }
  }
  return undefined;
}

/** Worst rung wins: a chain is only as automatic as its weakest link. */
export function combineRungs(states: CapabilityState[]): Rung {
  if (states.some((state) => state.rung === "unavailable")) {
    return "unavailable";
  }
  return states.some((state) => state.rung === "assisted") ? "assisted" : "auto";
}
