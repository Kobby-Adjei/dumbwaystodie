/**
 * Changing which model a chat is using, without being told where its menu is.
 *
 * Every one of these sites has a model selector and no two of them build it the
 * same way — a `<select>`, a listbox, a popover of divs, a radio group inside a
 * settings sheet. Writing a row per site per redesign is the maintenance cost
 * this project exists to avoid, so the same idea that finds the send button is
 * used again: **identify by difference**.
 *
 * Opening a model menu is the only action on a chat page that makes a list of
 * *model names* appear. So:
 *
 *   1. record the clickable things on the page;
 *   2. click the candidate that looks like a model selector;
 *   3. whatever appeared is the menu — and options that read like model names
 *      confirm it;
 *   4. click the option that matches what was asked for;
 *   5. verify the trigger now says the new name.
 *
 * Step 5 is what makes this safe to do at all. Without a readback this would be
 * clicking hopefully around someone's chat window; with it, a wrong guess is
 * detected and reverted rather than shipped.
 *
 * Pure and testable: the deciding is here, the clicking is in the surface.
 */

/** A clickable thing, as the page describes it. */
export interface Clickable {
  key: string;
  label: string;
  visible: boolean;
  /** Distance from the composer. A model selector sits near where you type. */
  distance: number;
}

/**
 * Names that mean "this is a model selector".
 *
 * Not model names — those change weekly and hard-coding them would be the
 * per-site maintenance in a different costume. These are the words interfaces
 * use *around* a model choice, plus the shapes model names take.
 */
const SAYS_MODEL = /\b(model|gpt|claude|gemini|glm|sonnet|opus|haiku|deepseek|mistral|grok|reason|thinking)\b/i;

/** Version-shaped text: "4.6", "o3", "3.5 Sonnet", "v2". Models look like this. */
const LOOKS_VERSIONED = /(\b[a-z]+[- ]?\d+(\.\d+)*\b|\bo\d\b|\bv\d\b)/i;

/**
 * The controls most likely to open a model menu, best first.
 *
 * Ranked, not chosen: the caller clicks one, checks whether a list of model-ish
 * options appeared, and moves on if it did not.
 */
export function rankModelTriggers(controls: readonly Clickable[]): Clickable[] {
  const plausible = controls.filter(
    (control) => control.visible && (SAYS_MODEL.test(control.label) || LOOKS_VERSIONED.test(control.label)),
  );

  return [...plausible].sort((left, right) => {
    // A control that says "model" outright beats one that merely looks
    // versioned — "4.6" could be anything, "Model: GLM-4.6" could not.
    const named = Number(SAYS_MODEL.test(right.label)) - Number(SAYS_MODEL.test(left.label));
    if (named !== 0) {
      return named;
    }
    return left.distance - right.distance;
  });
}

/**
 * Whether what appeared after clicking actually looks like a model menu.
 *
 * Two or more options that read like model names. One is not a list, and a list
 * of things that do not look like models is some other menu — which must not be
 * clicked, because the alternative to guessing is simply leaving the model
 * alone, and that costs nothing.
 */
export function looksLikeModelMenu(appeared: readonly Clickable[]): boolean {
  const modelish = appeared.filter(
    (option) => SAYS_MODEL.test(option.label) || LOOKS_VERSIONED.test(option.label),
  );
  return modelish.length >= 2;
}

/**
 * The option matching what was asked for, or nothing.
 *
 * Matching is deliberately forgiving about punctuation and case — a user asking
 * for "glm 4.6" should reach "GLM-4.6" — and deliberately strict about
 * ambiguity: if two options match equally well, none is chosen. Silently
 * picking one of two plausible models is worse than not switching, because the
 * answer that comes back looks exactly like the answer you wanted.
 */
export function chooseModelOption(
  wanted: string,
  options: readonly Clickable[],
): Clickable | undefined {
  const target = squash(wanted);
  if (target.length === 0) {
    return undefined;
  }

  const exact = options.filter((option) => squash(option.label) === target);
  if (exact.length === 1) {
    return exact[0];
  }
  if (exact.length > 1) {
    return undefined;
  }

  const contains = options.filter((option) => squash(option.label).includes(target));
  return contains.length === 1 ? contains[0] : undefined;
}

/** Whether the trigger now reports the model we asked for. */
export function switchConfirmed(triggerLabel: string, wanted: string): boolean {
  return squash(triggerLabel).includes(squash(wanted));
}

function squash(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9.]+/g, "");
}
