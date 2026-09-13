/**
 * Finding a chat's controls without being told where they are.
 *
 * The site table works until a site is redesigned, and it costs a row per
 * provider forever. But a chat page has a *shape*, and two facts make that
 * shape discoverable without naming anything:
 *
 *   1. The send control appears, or becomes enabled, **because** text was
 *      typed. So the difference between the buttons present before and after
 *      typing identifies it — no label, no selector, no site knowledge.
 *   2. The reply is the large block of text that was not there before the
 *      message was sent.
 *
 * Both are differences rather than descriptions, which is why they survive a
 * redesign: a site can rename every class and move every element and the
 * difference is still the same difference.
 *
 * The table is kept as a *prior* — tried first because it is instant and
 * usually right — and this runs when it misses. Discovery results are cached
 * per host, so a site is figured out once rather than every turn.
 *
 * Pure and testable: this is the part that must not be guesswork, and it needs
 * no browser to check.
 */

import { saysSomethingElse } from "./sendButton";

/** What the page can tell us about one candidate control. */
export interface ControlSnapshot {
  /** Stable within one page visit; used to diff two snapshots. */
  key: string;
  /** Accessible name, if any. Often absent on icon-only buttons. */
  label: string;
  disabled: boolean;
  visible: boolean;
  /** Distance from the composer, in pixels. Nearer is more likely. */
  distance: number;
}

/**
 * Which control became available once text was present.
 *
 * Appearing and becoming enabled are treated the same, because sites do both:
 * ChatGPT renders the button only when there is text, while others render it
 * disabled and enable it. Either way it is the one that *changed*.
 */
export function newlyUsable(
  before: readonly ControlSnapshot[],
  after: readonly ControlSnapshot[],
): ControlSnapshot[] {
  const previously = new Map(before.map((control) => [control.key, control]));

  return after.filter((control) => {
    if (!control.visible || control.disabled) {
      return false;
    }
    const was = previously.get(control.key);
    // Absent before, or present but unusable before.
    return !was || !was.visible || was.disabled;
  });
}

/**
 * The most likely send control among those that changed.
 *
 * Ordering, in decreasing confidence:
 *
 *  1. its name says send or submit — the strongest evidence there is;
 *  2. it is nearest the composer — a send button sits beside the box it sends;
 *  3. it is the only one that changed.
 *
 * A negative name is still a veto here, exactly as in the scored path: a menu
 * that happens to appear alongside the send button must never be clicked,
 * because the fallback is Enter and that costs nothing.
 */
const SAYS_SEND = /\b(send|submit)\b/i;

export function chooseDiscoveredSend(
  changed: readonly ControlSnapshot[],
): ControlSnapshot | undefined {
  // One veto list, shared with the scored path — two copies would drift, and
  // this one was already wrong once.
  const allowed = changed.filter((control) => !saysSomethingElse(control.label));
  if (allowed.length === 0) {
    return undefined;
  }

  const named = allowed.filter((control) => SAYS_SEND.test(control.label));
  const pool = named.length > 0 ? named : allowed;

  return [...pool].sort((left, right) => left.distance - right.distance)[0];
}

/* ------------------------------------------------------------------ *
 * The reply
 * ------------------------------------------------------------------ */

export interface TextBlock {
  key: string;
  text: string;
}

/**
 * The reply is the substantial text that appeared after sending.
 *
 * Short additions are ignored: sending a message adds the user's own turn, a
 * timestamp, a "thinking" label, and assorted chrome. Requiring some length
 * separates an answer from furniture without knowing what either looks like.
 *
 * 24 characters is about four words — long enough to exclude every label a
 * chat page puts on screen ("Copy", "Thinking…", "2 minutes ago", "Regenerate")
 * and short enough to admit a genuinely terse answer ("Yes — line 40 is the
 * bug."). The cost of it being wrong is asymmetric and that is what sets the
 * direction: too low and a button caption gets returned as the answer, too high
 * and a one-line answer is missed and then found by the next poll as it grows.
 */
export const MIN_REPLY_CHARACTERS = 24;

export function newestReply(
  before: readonly TextBlock[],
  after: readonly TextBlock[],
  sent: string,
): TextBlock | undefined {
  const seen = new Map(before.map((block) => [block.key, block.text]));
  const normalised = sent.trim();

  const candidates = after.filter((block) => {
    const previous = seen.get(block.key) ?? "";
    if (block.text.length <= previous.length) {
      return false;
    }
    if (block.text.trim().length < MIN_REPLY_CHARACTERS) {
      return false;
    }
    /*
     * The message we just sent is also new text on the page. Echoing it back
     * as the reply would look like the chat answering itself — and with a
     * rendered payload it is by far the largest block, so it would win.
     */
    return !normalised.startsWith(block.text.trim()) && !block.text.includes(normalised);
  });

  // The last one, because a conversation grows downward.
  return candidates[candidates.length - 1];
}

/* ------------------------------------------------------------------ *
 * The composer
 * ------------------------------------------------------------------ */

/** What the page can tell us about one editable region. */
export interface EditableSnapshot {
  key: string;
  /** Visible area in CSS pixels. A composer is not a 20px search box. */
  area: number;
  /** Distance from the bottom of the viewport. Composers sit low. */
  fromBottom: number;
  /** Inside a <form>, which a chat composer usually is and a search rarely. */
  inForm: boolean;
  /** Accessible name or placeholder, when there is one. */
  label: string;
  visible: boolean;
  readOnly: boolean;
  /**
   * Whether something clickable sits in this box's own container.
   *
   * The strongest structural signal available without typing. A message box
   * comes with a send control; a search field, a rename input and a feedback
   * textarea generally do not, and when they do it is not one that lives in
   * the same little box beside them.
   */
  nearSendControl: boolean;
}

/**
 * Labels that mean this is some *other* text box.
 *
 * Chat pages have more than one: a conversation search, a rename field, a
 * feedback box. Typing a whole rendered payload into the wrong one is the
 * worst outcome available here — worse than not sending — because it is a
 * visible action taken on the user's behalf in the wrong place.
 */
const NOT_A_COMPOSER = [/\bsearch\b/i, /\bfilter\b/i, /\brename\b/i, /\bfeedback\b/i, /\btitle\b/i];

/**
 * Below this, it is a control, not somewhere to write a message.
 *
 * Deliberately generous — 600px² is about 30×20, far smaller than any real
 * composer. The floor is only here to drop the obvious non-candidates: a
 * one-line rename input, a checkbox's hidden label field. Raising it towards
 * what a composer actually measures would start excluding collapsed and
 * single-line composers on narrow windows, and the *ranking* is what picks the
 * winner. A floor that decides the answer is a floor doing the wrong job.
 */
export const MIN_COMPOSER_AREA = 600;

/**
 * The editables most likely to be the message box, best first.
 *
 * Ranked rather than chosen, because the caller can *verify*: placing text
 * reads it back, so a wrong guess is detected and the next candidate tried.
 * That makes this a search order, not a decision — which is the only reason a
 * heuristic is acceptable for something this consequential.
 *
 * The signals, in the order they matter:
 *
 *  1. big enough to be a message box at all;
 *  2. low on the page — every chat puts its composer at the bottom;
 *  3. has a send control of its own beside it;
 *  4. inside a form;
 *  5. larger, as a tiebreak between two plausible boxes.
 *
 * Ordering matters more than it looks. Writability is *not* identity — a
 * feedback textarea accepts text perfectly well — so the caller's readback
 * cannot tell a wrong box from a right one. Everything that narrows the field
 * before then is worth having.
 */
export function rankComposers(candidates: readonly EditableSnapshot[]): EditableSnapshot[] {
  const plausible = candidates.filter(
    (candidate) =>
      candidate.visible &&
      !candidate.readOnly &&
      candidate.area >= MIN_COMPOSER_AREA &&
      !NOT_A_COMPOSER.some((pattern) => pattern.test(candidate.label)),
  );

  return [...plausible].sort((left, right) => {
    /*
     * Lower on the page wins, in bands of 80px so the other signals decide
     * between two boxes at roughly the same height. Floored rather than
     * rounded: rounding puts 30px and 40px in *different* bands, which let a
     * ten-pixel difference outrank being inside a form.
     */
    const band = Math.floor(left.fromBottom / 80) - Math.floor(right.fromBottom / 80);
    if (band !== 0) {
      return band;
    }
    if (left.nearSendControl !== right.nearSendControl) {
      return left.nearSendControl ? -1 : 1;
    }
    if (left.inForm !== right.inForm) {
      return left.inForm ? -1 : 1;
    }
    return right.area - left.area;
  });
}
