/**
 * Whether the connected browser add-on is the one this editor shipped.
 *
 * Chrome keeps running the copy of a service worker it loaded. Files on disk
 * changing does not change what is executing, so an add-on can be several
 * builds behind while reporting itself perfectly connected — and the symptom is
 * not "stale", it is a request going somewhere it should not, or a fix that
 * appears not to work. That is indistinguishable from a bug until someone
 * thinks to check, which took three rounds once.
 *
 * Pure, so the one thing that matters — never crying stale when it cannot
 * actually tell — is testable.
 */

export interface BuildVerdict {
  stale: boolean;
  /** What to say, when there is something worth saying. */
  message?: string;
}

export function compareAddonBuild(
  shipped: string | undefined,
  running: string | undefined,
): BuildVerdict {
  /*
   * Not knowing what we ship means not being able to judge anything.
   *
   * This is the only genuine unknown: an editor built without the id has
   * nothing to compare against, and guessing would put a permanent warning in
   * front of someone whose setup is fine.
   */
  if (!shipped) {
    return { stale: false };
  }

  if (shipped === running) {
    return { stale: false };
  }

  /*
   * An add-on that reports no build at all is definitively older.
   *
   * Not a guess: every build since the stamp existed carries one, so a running
   * add-on without it was compiled before that — which is exactly the case that
   * went unreported while a stale copy quietly served old routing. Treating it
   * as merely unknown was the wrong call, and it cost three rounds of "still
   * sending to ChatGPT".
   */

  return {
    stale: true,
    message:
      "The browser add-on is running an older build than this editor. " +
      "Open chrome://extensions and press Reload on Dumb Ways to Die — " +
      "Chrome keeps running the copy it loaded, so rebuilding is not enough.",
  };
}
