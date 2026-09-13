/**
 * Choosing which button actually sends.
 *
 * Taking the first selector match is wrong, and wrong in a way that does real
 * damage: inside a `<form>`, Material-style buttons default to
 * `type="submit"`, so `form button[type="submit"]` matches the overflow menu,
 * the attach control, the microphone — whichever appears first in the DOM.
 * Clicking those does not send a message; it opens a menu in the user's face.
 *
 * So candidates are scored rather than ranked by document order, and the
 * scoring is pure so it can be tested without a browser.
 */

/** Labels that mean "this sends", strongest first. */
const POSITIVE = [/\bsend\b/i, /\bsubmit\b/i];

/**
 * Labels that mean "this definitely does something else".
 *
 * A negative match is a veto, not a penalty. Clicking the wrong control is
 * worse than not clicking at all — the fallback is Enter, which costs nothing,
 * whereas opening a menu or a file picker interrupts the user.
 *
 * Each pattern carries its own boundaries, and the ones that name an *intent*
 * deliberately match a prefix. An earlier version put a single `\b` after one
 * big alternation, which meant `dictat` required a word boundary after it and
 * so never matched "dictation". Measured on a live ChatGPT, that let four real
 * controls through the veto: "Start dictation", "Attachment", "Uploading" and
 * "Add photos & files".
 */
export const NOT_SEND: readonly RegExp[] = [
  /\bmore\b/i,
  /\boptions?\b/i,
  /\bmenu\b/i,
  // Prefixes: attachment, uploading, files, images, photos.
  /\battach/i,
  /\bupload/i,
  /\bfiles?\b/i,
  /\bimages?\b/i,
  /\bphotos?\b/i,
  /\bcamera\b/i,
  // "mic" alone, or the full word — but never "Microsoft".
  /\bmic\b/i,
  /\bmicrophone/i,
  /\bvoice\b/i,
  /\bdictat/i,
  /\bsettings?\b/i,
  /\bstop\b/i,
  /\bcancel\b/i,
  /\bclose\b/i,
  /\bsearch\b/i,
  /\bmodel\b/i,
];

export function saysSomethingElse(label: string): boolean {
  return NOT_SEND.some((pattern) => pattern.test(label));
}

export interface SendCandidate {
  /** Accessible name: aria-label, title, or visible text. */
  label: string;
  /** How specific the selector that found it was — 0 is most specific. */
  selectorIndex: number;
  disabled: boolean;
  visible: boolean;
}

/**
 * @returns a score, or `undefined` when this candidate must not be clicked.
 *
 * Higher is better.
 */
export function scoreSendCandidate(candidate: SendCandidate): number | undefined {
  if (!candidate.visible || candidate.disabled) {
    return undefined;
  }

  const label = candidate.label.trim();

  if (saysSomethingElse(label)) {
    return undefined;
  }

  let score = 0;

  for (const [index, pattern] of POSITIVE.entries()) {
    if (pattern.test(label)) {
      score += 100 - index * 10;
      break;
    }
  }

  // A site's own selectors come before the generic fallbacks, so an earlier
  // match is a better-informed one.
  score += Math.max(0, 20 - candidate.selectorIndex * 2);

  /*
   * An unlabelled button is not rejected, but it is not preferred either.
   *
   * Plenty of send controls are a bare arrow icon with no accessible name —
   * refusing those would break real chats. But it must lose to anything that
   * actually says "send", which the positive bonus guarantees.
   */
  return score;
}

/**
 * Picks the best candidate, or none.
 *
 * Ties break towards the *last* candidate: in a composer toolbar the send
 * control sits at the end of the row, after the attachment and voice buttons.
 */
export function chooseSendCandidate(candidates: SendCandidate[]): number | undefined {
  let bestIndex: number | undefined;
  let bestScore = -Infinity;

  for (const [index, candidate] of candidates.entries()) {
    const score = scoreSendCandidate(candidate);
    if (score === undefined) {
      continue;
    }
    if (score >= bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return bestIndex;
}
