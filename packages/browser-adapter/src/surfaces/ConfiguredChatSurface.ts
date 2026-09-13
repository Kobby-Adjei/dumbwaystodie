import {
  resolveSelector,
  type ChatSurfaceAdapter,
  type DeliverResult,
  type ObservedReply,
  type SurfaceState,
} from "./ChatSurfaceAdapter";
import { cleanReply } from "./cleanReply";
import {
  chooseModelOption,
  looksLikeModelMenu,
  rankModelTriggers,
  switchConfirmed,
  type Clickable,
} from "./modelPicker";
import { judgeCompletion, POLL_INTERVAL_MS, shouldAcceptCompletion } from "./quiescence";
import { siteFor, type ChatSiteConfig } from "./sites";
import { chooseSendCandidate, saysSomethingElse, type SendCandidate } from "./sendButton";
import {
  chooseDiscoveredSend,
  MIN_REPLY_CHARACTERS,
  newestReply,
  newlyUsable,
  rankComposers,
  type ControlSnapshot,
  type EditableSnapshot,
  type TextBlock,
} from "./discovery";

/**
 * Drives any chat page, given selectors.
 *
 * This holds the mechanics — placing text a framework will notice, sending,
 * confirming the send actually happened, and waiting for a reply to settle.
 * None of that is specific to a website, which is why supporting a second chat
 * is a row in `sites.ts` rather than a second copy of this file.
 *
 * What this deliberately does NOT do (spec §0O): touch authentication, read
 * other tabs, look at cookies, retry to defeat rate limits, or disguise
 * itself. It types where the user could type and reads what the user can see.
 */
export class ConfiguredChatSurface implements ChatSurfaceAdapter {
  constructor(private readonly config: ChatSiteConfig) {}

  get surfaceType(): string {
    return this.config.surfaceType;
  }

  static forUrl(url: string): ConfiguredChatSurface {
    return new ConfiguredChatSurface(siteFor(url));
  }

  matches(): boolean {
    // Selection happens in `forUrl`; by the time a surface exists it is the
    // right one. Kept to satisfy the interface the content script expects.
    return true;
  }

  /**
   * @param root defaults to the live page; injectable so the reasoning can be
   * tested without a browser. What it decides is worth pinning — a probe that
   * is wrong misreports the whole bridge as broken.
   */
  probe(root: ParentNode = document): SurfaceState {
    const composer = resolveSelector(root, this.config.composer);

    /*
     * The composer alone decides whether this page can be driven.
     *
     * An earlier version also demanded a send button, which made probing an
     * empty page always report "assisted": the button is only rendered once
     * there is text to send, and a probe runs before anything is typed. The
     * absence of a button says nothing, and Enter sends on every chat here.
     */
    return {
      identify: { rung: "auto" },
      deliver: composer
        ? { rung: "auto" }
        : {
            rung: "assisted",
            reason: `Could not find the message box on ${this.config.label}.`,
          },
      /*
       * An empty chat has no replies to find, and that says nothing.
       *
       * This used to report "assisted — could not find replies on this page
       * yet" on every fresh conversation, which told the user their replies
       * would need copying by hand before they had sent a single message. It
       * is the same mistake the send button made: judging a capability by
       * whether its evidence happens to be on screen before anything has
       * happened.
       *
       * If the reply selectors are actually wrong, `observe` says so at the
       * moment it matters, with the message the user can act on.
       */
      observe: { rung: "auto" },
    };
  }

  async deliver(text: string): Promise<DeliverResult> {
    /*
     * Priors, then a verified search.
     *
     * The table's selector is tried first. If it misses — a redesign, or a
     * site nobody has written a row for — the page's editables are ranked and
     * tried in order.
     *
     * What "verified" can and cannot mean here is the important part. Placing
     * text and reading it back proves the box is *writable*, and nothing more:
     * a feedback textarea accepts a rendered payload just as willingly as a
     * composer does. So each candidate also has to be corroborated by the
     * page's own reaction — a send control that appeared or became usable
     * because there is now something to send. That is evidence about identity,
     * not about writability, and it is the only kind available without naming
     * the site.
     */
    const attempts: Element[] = [];

    const prior = resolveSelector(document, this.config.composer);
    if (prior) {
      attempts.push(prior.element);
    }

    for (const candidate of discoverComposers()) {
      if (!attempts.includes(candidate)) {
        attempts.push(candidate);
      }
    }

    if (attempts.length === 0) {
      return {
        rung: "assisted",
        sent: false,
        reason: `Could not find the message box on ${this.config.label}. Paste it in yourself.`,
      };
    }

    let composerElement: Element | undefined;
    let before: ControlSnapshot[] = [];

    /*
     * The first box that took the text, kept in case nothing corroborates.
     *
     * Some sites keep their send button present and enabled at all times, so
     * "nothing changed" is not proof of a wrong box. Falling back to the
     * best-ranked box that accepted text is what keeps those working, and it
     * is a weaker claim held deliberately rather than by accident.
     */
    let writable: { element: Element; controls: ControlSnapshot[] } | undefined;

    for (const candidate of attempts) {
      /*
       * Snapshotted per candidate, because the diff has to be taken against
       * the page as it was before *this* attempt typed anything.
       */
      const controls = snapshotControls(candidate);

      if (!(await placeText(candidate, text))) {
        // Nothing was placed, so there is nothing to leave behind — but a
        // partial write is possible, and an emptied box is the safe state.
        clearText(candidate);
        continue;
      }

      writable ??= { element: candidate, controls };

      if (await waitForSendEvidence(candidate, controls, this.config.send)) {
        composerElement = candidate;
        before = controls;
        break;
      }

      /*
       * Writable, but the page did not react — so this may well be the wrong
       * box. Empty it before trying the next one: text left in a feedback form
       * is a visible action taken on the user's behalf in the wrong place.
       */
      clearText(candidate);
    }

    if (!composerElement && writable) {
      // Nothing corroborated. Re-place into the best box that accepted text.
      if (await placeText(writable.element, text)) {
        composerElement = writable.element;
        before = writable.controls;
      }
    }

    if (!composerElement) {
      return {
        rung: "assisted",
        sent: false,
        reason: "Could not type into the message box. Paste it in yourself.",
      };
    }

    const composer = { element: composerElement };

    /*
     * The conversation before sending, so "my message is on screen now" can be
     * told apart from "my message was already on screen" — which it is, in the
     * composer, and in every earlier turn of a repeated question.
     */
    const sentBefore = snapshotConversation();

    /*
     * Sending is a ladder, not a single attempt.
     *
     * Rich editors register input asynchronously, and the send button does not
     * exist — or stays disabled — until they have. So a single "click if
     * present, else press Enter" gives up at the exact moment the page is
     * still catching up. Each rung is retried against a re-queried button,
     * because the element that was missing 100ms ago is often there now.
     */
    for (const attempt of [0, 1, 2]) {
      await delay(attempt === 0 ? 80 : 250);

      /*
       * Priors first, discovery second.
       *
       * The table is instant and usually right, so it is tried first and
       * nothing else runs when it works. Discovery is what stops a redesign
       * from becoming a broken feature — and it is what would have caught the
       * three-dot menu, because a menu that was already there did not change.
       */
      const button =
        findSendButton(composer.element, this.config.send) ??
        discoverSendButton(composer.element, before);

      if (button) {
        button.click();
      } else {
        // Enter is the send key on every chat in the table, so a missing
        // button is not a dead end — it is the ordinary case before typing
        // has registered.
        pressEnter(composer.element);
      }

      /*
       * Confirm rather than assume — with two signals, not one.
       *
       * `sent: true` decides whether the editor waits for a reply, so it must
       * not be a guess about whether a click landed. "The composer emptied" was
       * the only signal, and it is *usually* right: most chats clear the box on
       * send. DeepSeek does not clear it fast enough, so a message that went
       * through perfectly was reported as "would not send" — and because that
       * ends the turn, the answer the chat was already writing was never read.
       * Reporting a success as a failure is the worst way to be wrong here: the
       * user is told to paste something that has already been sent.
       *
       * The second signal is the message itself appearing in the conversation.
       * That is what "sent" actually means, and it is true on every chat
       * regardless of what the composer does afterwards.
       */
      const landed = await waitFor(
        () => readText(composer.element).trim() === "" || conversationShows(sentBefore, text),
        SEND_CONFIRM_MS,
      );

      if (landed) {
        return { rung: "auto", sent: true };
      }
    }

    /*
     * Unconfirmed, which is not the same as "did not send".
     *
     * Both signals can miss — a chat that neither clears its composer nor shows
     * the turn where we can read it — so this says what is actually known. The
     * old wording asserted failure, and the editor's advice on top of it told
     * the user to paste a message that was sitting in the box already.
     */
    return {
      rung: "assisted",
      sent: false,
      reason:
        `Your message is in the ${this.config.label} box. I could not tell whether it sent — ` +
        `check the tab, and press enter there if it is still sitting in the box.`,
    };
  }


  /**
   * @param onProgress called with the reply so far, as it grows.
   *
   * Reporting progress is not only cosmetic. Deciding a reply has finished is
   * a guess, and a wrong guess used to throw away everything after the guess —
   * a sentence cut mid-word. Handing text over as it arrives means the worst a
   * premature verdict can do is stop early, not lose what was already read.
   */
  /**
   * Reads the models this chat offers, by opening its menu and looking.
   *
   * The alternative was asking the user to type a model name, which is absurd:
   * the list is sitting right there on the page, and the browser is the one
   * thing in this system that can see it. Opening a menu, reading it, and
   * closing it again is exactly what a person does before choosing.
   *
   * The menu is always closed again, including when nothing recognisable was
   * found — leaving someone's chat with a dropdown hanging open because we
   * looked at it is not acceptable.
   */
  async listModels(): Promise<{ models: string[]; reason?: string }> {
    const composer = resolveSelector(document, this.config.composer)?.element ?? document.body;

    for (const trigger of rankModelTriggers(snapshotClickables(composer))) {
      const element = findClickable(trigger.key, composer);
      if (!element) {
        continue;
      }

      const before = snapshotClickables(composer);
      pointerClick(element);
      await delay(350);

      const appeared = newClickables(before, snapshotClickables(composer));

      if (looksLikeModelMenu(appeared)) {
        await dismissMenu(element, appeared, composer);
        return { models: modelNames(appeared) };
      }

      await dismissMenu(element, appeared, composer);
    }

    return { models: [], reason: `Could not find a model menu on ${this.config.label}.` };
  }

  /**
   * Switches which model this chat is using, by driving its own menu.
   *
   * Three verifications, because this clicks things in someone's chat window:
   * the menu that appeared has to look like a list of models, the option has to
   * match unambiguously, and the trigger has to *say* the new name afterwards.
   * If any of those fails the menu is closed with Escape and nothing changes —
   * leaving the model alone is a perfectly good outcome, and switching to the
   * wrong one is not, because the answer looks the same either way.
   */
  async setModel(wanted: string): Promise<{ ok: boolean; reason?: string }> {
    const composer = resolveSelector(document, this.config.composer)?.element ?? document.body;

    for (const trigger of rankModelTriggers(snapshotClickables(composer))) {
      const element = findClickable(trigger.key, composer);
      if (!element) {
        continue;
      }

      const before = snapshotClickables(composer);
      pointerClick(element);
      await delay(350);

      const appeared = newClickables(before, snapshotClickables(composer));
      if (!looksLikeModelMenu(appeared)) {
        // Not a model menu. Close whatever it was and leave it as it was.
        pressEscape(element);
        await delay(120);
        continue;
      }

      const option = chooseModelOption(wanted, appeared);
      if (!option) {
        pressEscape(element);
        return {
          ok: false,
          reason: `${this.config.label} has a model menu, but nothing in it clearly means "${wanted}".`,
        };
      }

      const chosen = findClickable(option.key, composer);
      if (chosen) {
        pointerClick(chosen);
      }
      await delay(450);

      const now = accessibleName(findClickable(trigger.key, composer) ?? element);
      if (switchConfirmed(now, wanted) || switchConfirmed(accessibleName(element), wanted)) {
        return { ok: true };
      }

      return {
        ok: false,
        reason: `Clicked "${option.label}" in ${this.config.label} but its menu still reads "${now}".`,
      };
    }

    return { ok: false, reason: `Could not find a model menu on ${this.config.label}.` };
  }

  /**
   * @param sent what was just delivered, and the page as it was before.
   *
   * Only used when the reply selectors miss — which is what happens on a site
   * nobody has written a row for, or one that has been redesigned. Then the
   * reply is found the same way the send button is: by difference. The largest
   * block of text that was not there before, and is not an echo of what we
   * typed, is the answer.
   */
  async observe(
    signal: AbortSignal,
    onProgress?: (text: string) => void,
    sent?: { before: readonly TextBlock[]; text: string; root?: Element },
  ): Promise<ObservedReply> {
    const started = Date.now();
    let lastText = "";
    let lastChangeAt = Date.now();
    /*
     * Whether the text came from a selector or from a difference.
     *
     * Not a rung: a discovered reply is still fully automatic, nothing is
     * assisted about it. It matters only because there is no selector to
     * re-read it through at the end.
     */
    let discoveredReply = false;

    // Poll rather than observe mutations: the reply element is replaced
    // wholesale by some renderers, and a poll cannot lose its subscription.
    for (;;) {
      if (signal.aborted) {
        throw new Error("Stopped waiting for the reply.");
      }

      let text = this.readLastReply();

      if (text.trim().length === 0 && sent) {
        /*
         * Scoped to the conversation when we know where it is. Searching the
         * whole page is how a sidebar title gets returned as an answer.
         */
        /*
         * Located each time rather than once after sending.
         *
         * Measured on a live Perplexity page: right after a send the site
         * navigates to a fresh URL and the turn is not in the DOM yet, so
         * looking once returned nothing and reply discovery fell back to the
         * whole document — which is how a sidebar title becomes an answer.
         */
        const scope = sent.root ?? conversationRootFor(sent.text) ?? document;
        const discovered = newestReply(sent.before, snapshotConversation(scope), sent.text);
        if (discovered) {
          text = cleanReply(discovered.text);
          discoveredReply = true;
        }
      }

      if (text !== lastText) {
        lastText = text;
        lastChangeAt = Date.now();
        onProgress?.(text);
      }

      /*
       * Presence in the DOM is not visibility.
       *
       * Chat surfaces commonly keep their stop control mounted and hide or
       * disable it after generation. Treating the first selector match as
       * "still generating" withheld the terminal response indefinitely even
       * though the reply and token counter had visibly stopped.
       */
      const generating = hasVisibleStopControl(document, this.config.stop);
      const verdict = judgeCompletion({
        text: lastText,
        msSinceLastChange: Date.now() - lastChangeAt,
        msSinceStart: Date.now() - started,
      });

      if (shouldAcceptCompletion(verdict, generating)) {
        /*
         * Waiting out the full timeout and finding nothing is not an empty
         * answer — it means the reply selectors did not match this page.
         * Returning "" would hand the editor a blank response as if the
         * chat had said nothing.
         */
        if (verdict.reason === "timeout" && lastText.trim().length === 0) {
          throw new Error(
            `Could not find the reply on ${this.config.label}. Copy it and use Bring reply back.`,
          );
        }

        // One layout, at the end, for the version the user actually sees.
        return { text: this.readLastReply(true) || lastText, rung: "auto" };
      }

      await delay(POLL_INTERVAL_MS);
    }
  }

  /**
   * @param rendered when true, reads `innerText` — which reflects what the
   * user can actually see, but forces a layout to work it out.
   *
   * The polling loop must not do that. `innerText` triggers style and layout
   * on a subtree that is actively growing, so reading it several times a
   * second while a reply streams is hundreds of forced reflows per answer —
   * enough to spin up a fan on its own. `textContent` needs no layout, and for
   * deciding "has this changed" and "is the block closed" it is just as good.
   */
  private readLastReply(rendered = false): string {
    for (const selector of this.config.message) {
      const nodes = document.querySelectorAll(selector);
      const last = nodes[nodes.length - 1];
      if (last) {
        const element = last as HTMLElement;
        const raw = (rendered ? element.innerText : undefined) ?? element.textContent ?? "";
        // The container holds the answer *and* the interface drawn around it.
        return cleanReply(raw);
      }
    }
    return "";
  }
}

/**
 * Sets text on either a textarea or a contenteditable.
 *
 * React ignores a plain `value =` assignment because it tracks the previous
 * value on the DOM node, so the native setter has to be called directly and an
 * input event dispatched. This is the single most fragile line in the project.
 */
async function placeText(element: Element, text: string): Promise<boolean> {
  if (element instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) {
      return false;
    }
    setter.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return element.value.includes(text.slice(0, 40));
  }

  if (!(element instanceof HTMLElement) || !element.isContentEditable) {
    return false;
  }

  element.focus();
  placeCaretIn(element);

  /*
   * Three techniques, each verified, because "it returned true" is not the
   * same as "the text is in there".
   *
   * Rich editors (Quill on Gemini, ProseMirror on Claude, Lexical elsewhere)
   * keep their own document model and ignore direct DOM writes — the text can
   * appear on screen while the editor believes the box is empty, which leaves
   * the send button disabled forever. That is what "in the box but would not
   * send" actually was: not a send failure, a placement failure that reported
   * success.
   */
  const attempts: Array<() => void> = [
    // 1. The browser's own insertion path — goes through the editor's input
    //    handling, so frameworks stay in sync.
    () => {
      document.execCommand("insertText", false, text);
    },

    // 2. A synthetic paste. Every rich editor implements paste carefully
    //    because users rely on it, which makes it the most widely honoured
    //    way in. This is the one that tends to work where typing does not.
    () => {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    },

    // 3. Write the DOM directly and announce it. Last resort: an editor that
    //    ignored the first two will often ignore this too, but a plain
    //    contenteditable with no framework behind it accepts only this.
    () => {
      element.textContent = text;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    },
  ];

  const marker = text.slice(0, 40);

  for (const attempt of attempts) {
    try {
      attempt();
    } catch {
      continue;
    }
    // The editor may apply the change on its own schedule.
    if (await waitFor(() => (element.textContent ?? "").includes(marker), 400)) {
      return true;
    }
  }

  return false;
}

/**
 * The button that sends, scored rather than taken in document order.
 *
 * The search starts at the composer's own form or container and widens only
 * if nothing is found there: a send control lives beside the box it sends,
 * and searching the whole page first is how a sidebar button gets clicked.
 */
function findSendButton(composer: Element, selectors: string[]): HTMLElement | undefined {
  const scopes: Array<ParentNode | null | undefined> = [
    composer.closest("form"),
    composer.parentElement?.closest("div,section"),
    document,
  ];

  for (const scope of scopes) {
    if (!scope) {
      continue;
    }
    const found: HTMLElement[] = [];
    const candidates: SendCandidate[] = [];

    for (const [selectorIndex, selector] of selectors.entries()) {
      for (const node of Array.from(scope.querySelectorAll(selector))) {
        if (!(node instanceof HTMLElement) || found.includes(node)) {
          continue;
        }
        found.push(node);
        candidates.push({
          label: accessibleName(node),
          selectorIndex,
          disabled: isDisabled(node),
          visible: isVisible(node),
        });
      }
    }

    const chosen = chooseSendCandidate(candidates);
    if (chosen !== undefined) {
      return found[chosen];
    }
  }

  return undefined;
}

function accessibleName(element: HTMLElement): string {
  return (
    element.getAttribute("aria-label") ??
    element.getAttribute("title") ??
    element.textContent ??
    ""
  );
}

function isDisabled(element: HTMLElement): boolean {
  return (
    (element instanceof HTMLButtonElement && element.disabled) ||
    element.getAttribute("aria-disabled") === "true" ||
    element.hasAttribute("disabled")
  );
}

export interface VisibilitySnapshot {
  hidden: boolean;
  ariaHidden: boolean;
  display: string;
  visibility: string;
  opacity: number;
  rectCount: number;
}

/** Pure half of DOM visibility, exported so hidden-control regressions stay tested. */
export function isVisiblyRendered(snapshot: VisibilitySnapshot): boolean {
  return (
    !snapshot.hidden &&
    !snapshot.ariaHidden &&
    snapshot.display !== "none" &&
    snapshot.visibility !== "hidden" &&
    snapshot.visibility !== "collapse" &&
    snapshot.opacity > 0 &&
    snapshot.rectCount > 0
  );
}

function isVisible(element: HTMLElement): boolean {
  try {
    const style = getComputedStyle(element);
    return isVisiblyRendered({
      hidden: element.hidden,
      ariaHidden: element.getAttribute("aria-hidden") === "true",
      display: style.display,
      visibility: style.visibility,
      opacity: Number.parseFloat(style.opacity || "1"),
      rectCount: element.getClientRects().length,
    });
  } catch {
    // A detached or otherwise unreadable node cannot be an operable control.
    return false;
  }
}

/** Any visible, enabled stop control is strong evidence that output is live. */
function hasVisibleStopControl(root: ParentNode, selectors: readonly string[]): boolean {
  for (const selector of selectors) {
    if (!selector) {
      continue;
    }
    for (const node of Array.from(root.querySelectorAll(selector))) {
      if (node instanceof HTMLElement && isVisible(node) && !isDisabled(node)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Every plausible control near the composer, as the diff sees them.
 *
 * Deliberately broad — this is not trying to identify anything, only to record
 * the state so a later snapshot can be compared against it. Narrowing here
 * would risk excluding the very control that is about to appear.
 */
/**
 * What counts as a clickable control when driving a menu.
 *
 * `menuitemradio` is in here because a real page put it there: Perplexity's
 * model list is built from `role="menuitemradio"`, and a query that stopped at
 * `menuitem` found the trigger, opened nothing, and reported no menu. Measured
 * rather than guessed, which is the only way this list gets to be right.
 */
const MENU_CONTROLS =
  'button,[role="button"],[role="combobox"],[role="menuitem"],[role="menuitemradio"],' +
  '[role="menuitemcheckbox"],[role="option"],[role="radio"],[role="treeitem"],select';

/**
 * Clicks the way a person does, not the way a script does.
 *
 * `element.click()` dispatches a lone `click` event. Menus overwhelmingly open
 * on `pointerdown` or `mousedown`, so a bare `.click()` on a model selector
 * does nothing at all — verified on a live page, where the trigger was found
 * correctly and the menu never appeared. The full sequence is what a real
 * pointer produces, and it is no more forceful: it is the same gesture the user
 * could make themselves.
 */
function pointerClick(element: HTMLElement): void {
  const box = element.getBoundingClientRect();
  const at = {
    clientX: box.left + box.width / 2,
    clientY: box.top + box.height / 2,
    bubbles: true,
    cancelable: true,
    view: window,
    button: 0,
  };

  element.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerId: 1, isPrimary: true }));
  element.dispatchEvent(new MouseEvent("mousedown", at));
  element.dispatchEvent(new PointerEvent("pointerup", { ...at, pointerId: 1, isPrimary: true }));
  element.dispatchEvent(new MouseEvent("mouseup", at));
  element.dispatchEvent(new MouseEvent("click", at));
}

/**
 * The names in a menu, without the sales copy underneath them.
 *
 * A real option read whole comes back as "BestSelects the best available
 * model" — the name and its description concatenated, because `textContent`
 * does not know they are on separate lines. The first line is the name, which
 * is what a person would call it and what they will type or recognise.
 */
function modelNames(options: readonly Clickable[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const option of options) {
    const name = modelName(option.label);
    if (name.length === 0 || name.length > 48 || seen.has(name.toLowerCase())) {
      continue;
    }
    seen.add(name.toLowerCase());
    names.push(name);
  }

  return names;
}

/**
 * One option's name, separated from the sales copy welded to it.
 *
 * Read from a real menu, options come back as `BestSelects the best available
 * model` — the name and its description with no separator, because they are
 * different elements and `textContent` does not care. But `Claude Opus 5Max`
 * and `Kimi K3Thinking` have the same shape, and there the trailing word is
 * part of what the thing is called.
 *
 * What separates them is length: a description is a sentence, a badge is a
 * word. So the split happens at the camel-case seam only when what follows
 * looks like prose, which keeps `Opus 5Max` whole and turns `BestSelects the
 * best available model` back into `Best`.
 */
function modelName(label: string): string {
  const firstLine = label.split("\n")[0]?.trim() ?? "";
  const seam = /([a-z0-9])([A-Z])/.exec(firstLine);

  if (seam && seam.index >= 0) {
    const cut = seam.index + 1;
    const rest = firstLine.slice(cut).trim();
    if (rest.length > 12 || rest.includes(" ")) {
      return firstLine.slice(0, cut).trim();
    }
  }

  return firstLine;
}

/** Everything clickable on the page, as the model picker describes it. */
function snapshotClickables(anchor: Element): Clickable[] {
  const box = anchor.getBoundingClientRect();

  return Array.from(document.querySelectorAll(MENU_CONTROLS))
    .filter((node): node is HTMLElement => node instanceof HTMLElement)
    .map((node) => {
      const own = node.getBoundingClientRect();
      return {
        key: controlKey(node),
        // `innerText` keeps the line break between an option's name and its
        // description; `textContent` runs them together into one word.
        label: accessibleName(node) || (node.innerText ?? node.textContent ?? "").trim().slice(0, 120),
        visible: isVisible(node),
        distance: Math.hypot(own.left - box.left, own.top - box.top),
      };
    });
}

/** What appeared because we clicked — the same difference the send button uses. */
function newClickables(
  before: readonly Clickable[],
  after: readonly Clickable[],
): Clickable[] {
  const seen = new Set(before.filter((entry) => entry.visible).map((entry) => entry.key));
  return after.filter((entry) => entry.visible && !seen.has(entry.key));
}

function findClickable(key: string, _anchor: Element): HTMLElement | undefined {
  return Array.from(document.querySelectorAll(MENU_CONTROLS))
    .filter((node): node is HTMLElement => node instanceof HTMLElement)
    .find((node) => controlKey(node) === key);
}

/**
 * Puts a menu we opened back the way we found it, as far as it can.
 *
 * Three dismissals are tried, in order of how little they disturb: re-selecting
 * the option the site already marks as current (which cannot change anything),
 * then Escape.
 *
 * Measured honestly: on Perplexity **none of them close it**. Escape aimed at
 * the trigger, the focused element, the body and the document all leave the
 * list on screen, and so does re-selecting the current model — even though
 * selecting a *different* model works, so the clicks are landing. The likely
 * reason is that the dismissal path checks `isTrusted`, and a content script
 * cannot produce a trusted event; only the user's own pointer can.
 *
 * So this is a best effort with a known limit, not a guarantee. The cost when
 * it fails is a dropdown left open in a background tab, which the user closes
 * by clicking anywhere in it. That is worth saying out loud rather than
 * pretending the cleanup is reliable.
 */
async function dismissMenu(
  trigger: HTMLElement,
  options: readonly Clickable[],
  composer: Element,
): Promise<void> {
  for (const option of options) {
    const element = findClickable(option.key, composer);
    const marked =
      element?.getAttribute("aria-checked") === "true" ||
      element?.getAttribute("aria-selected") === "true";

    if (element && marked) {
      pointerClick(element);
      await delay(250);
      return;
    }
  }

  pressEscape(trigger);
  await delay(150);
}

/**
 * Closes a menu we opened.
 *
 * Sent to the document as well as the element, because popup libraries listen
 * where the focus is and the focus moves *into* the menu when it opens — so
 * Escape aimed at the trigger arrives somewhere nobody is listening. Measured:
 * the first version left Perplexity's model menu hanging open on the page,
 * which is a change to someone's window made on their behalf and not asked for.
 */
function pressEscape(element: Element): void {
  const init = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true };

  for (const target of [document.activeElement ?? element, element, document.body, document]) {
    try {
      (target as EventTarget).dispatchEvent(new KeyboardEvent("keydown", init));
      (target as EventTarget).dispatchEvent(new KeyboardEvent("keyup", init));
    } catch {
      // A detached node is not worth failing over; the next target is fine.
    }
  }
}

/**
 * The smallest region that plausibly holds this box and its buttons.
 *
 * One definition, used by every helper that needs a scope narrower than the
 * page — three copies of this expression is how a diff taken in one scope ends
 * up compared against a snapshot taken in another.
 */
function containerOf(element: Element): ParentNode {
  return element.closest("form") ?? element.parentElement?.closest("div,section") ?? document;
}

function snapshotControls(composer: Element): ControlSnapshot[] {
  const scope = containerOf(composer);

  const anchor = composer.getBoundingClientRect();

  return Array.from(scope.querySelectorAll('button,[role="button"]'))
    .filter((node): node is HTMLElement => node instanceof HTMLElement)
    .map((node) => {
      const box = node.getBoundingClientRect();
      return {
        key: controlKey(node),
        label: accessibleName(node),
        disabled: isDisabled(node),
        visible: isVisible(node),
        distance: Math.hypot(box.left - anchor.right, box.top - anchor.top),
      };
    });
}

/**
 * A key stable enough to diff two snapshots of the same page.
 *
 * Position is included because icon-only buttons are otherwise
 * indistinguishable from one another — and a button that moved is, for this
 * purpose, a different button.
 */
function controlKey(node: HTMLElement): string {
  const box = node.getBoundingClientRect();
  return [
    node.tagName,
    node.getAttribute("data-testid") ?? "",
    node.getAttribute("aria-label") ?? "",
    Math.round(box.left),
    Math.round(box.top),
  ].join("|");
}

/**
 * How long to wait for a send to be visible.
 *
 * 900ms was tuned against chats that clear the composer immediately. It is a
 * *confirmation* window, not a send timeout — being impatient here does not
 * make anything faster, it just makes a successful send look like a failure.
 */
const SEND_CONFIRM_MS = 2000;

/**
 * The region a message landed in — the conversation, found by our own turn.
 *
 * Reply discovery used to scan the whole document, so anything that changed
 * could win: Z.ai returned "📊 GuruEd EdTech Business Plan", a title from the
 * conversation list in the sidebar, while the actual answer sat on screen. A
 * page has plenty of text that grows and none of it is the reply.
 *
 * The anchor is the message we just sent. Wherever that turn was rendered *is*
 * the conversation, by definition — no selector, no site knowledge, and it
 * cannot point at a sidebar because our message is not in one. A few levels up
 * from it is the container holding both turns.
 */
export function conversationRootFor(text: string): Element | undefined {
  const needle = distinctiveSlice(text);
  if (!needle) {
    return undefined;
  }

  // The deepest element still holding the whole slice is our turn's own block.
  // Normalised for the same reason the confirmation is: the page holds the
  // rendered message, not the markdown that was typed.
  const candidates = Array.from(document.querySelectorAll("div,p,li,section,article"))
    .filter((element) => normalise(element.textContent ?? "").includes(needle))
    .filter((element) => !isEditable(element));

  const turn = candidates[candidates.length - 1];
  if (!turn) {
    return undefined;
  }

  /*
   * Up far enough to include the reply, not so far as to include the page.
   *
   * A reply is a sibling of our turn, or a sibling of its wrapper — four levels
   * covers the nesting real chats use. Stopping at the first ancestor that also
   * contains substantially more text would be cleverer and would also happily
   * select `body` on a page with a chatty sidebar.
   */
  let root: Element = turn;
  for (let step = 0; step < 4; step += 1) {
    const parent: Element | null = root.parentElement;
    if (!parent || parent === document.body) {
      break;
    }
    root = parent;
  }

  return root;
}

/** Whether an element is somewhere the user types, rather than a transcript. */
function isEditable(element: Element): boolean {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    return true;
  }
  return element instanceof HTMLElement && element.isContentEditable;
}

/**
 * Whether the text we typed has appeared in the conversation.
 *
 * Compared against a pre-send snapshot rather than searched for in the page,
 * because the text is also sitting in the composer — and on a repeated question
 * it is sitting in an earlier turn as well. What matters is that it is *newly*
 * somewhere it was not.
 *
 * Matched on a slice rather than the whole message: a chat may collapse
 * whitespace, wrap long lines, or render a long payload behind a "show more",
 * and a strict comparison would fail on all three while the message sat there
 * plainly sent.
 */
function conversationShows(before: readonly TextBlock[], text: string): boolean {
  const needle = distinctiveSlice(text);
  if (!needle) {
    return false;
  }

  const holds = (block: TextBlock): boolean => normalise(block.text).includes(needle);
  const previously = new Set(before.filter(holds).map((block) => block.key));

  return snapshotConversation().some((block) => holds(block) && !previously.has(block.key));
}

/**
 * Text reduced to what survives being rendered.
 *
 * The message goes in as markdown and comes out as HTML, so the characters that
 * *made* it markdown are gone from the page: `## Workspace` is typed, and
 * `Workspace` is what appears. Matching the raw text against the rendered text
 * therefore fails on the very first line — which is exactly why DeepSeek's send
 * could not be confirmed even though the message was plainly sitting there.
 *
 * Whitespace goes the same way: a chat re-wraps long lines and collapses runs
 * of spaces, and none of that means the message did not arrive.
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A piece of the message long enough to be unmistakable.
 *
 * Taken from the start of the first substantial line: the tail of a rendered
 * payload is protocol boilerplate that looks the same on every turn, so a slice
 * from there would match a previous message and report a send that never
 * happened.
 */
function distinctiveSlice(text: string): string | undefined {
  /*
   * Normalised first, then measured. A line of pure syntax — `## Workspace`,
   * a fence, a row of dashes — is long enough to look distinctive and vanishes
   * completely when rendered, so length has to be counted in the characters
   * that will still be there afterwards.
   */
  for (const raw of text.split("\n")) {
    const line = normalise(raw);
    if (line.length >= 16) {
      return line.slice(0, 60);
    }
  }

  return undefined;
}

/**
 * Waits for the page to acknowledge that there is now something to send.
 *
 * A composer's send control appears, or stops being disabled, because text was
 * typed. Nothing else on a page does that in response to *this* box getting
 * text, which is what makes it evidence of identity rather than of writability.
 *
 * Polled rather than checked once: rich editors register input asynchronously,
 * so the button that is still absent 20ms after typing is usually there by
 * 300ms. Bounded tightly — this runs per candidate, and a slow search is a
 * user watching nothing happen.
 */
async function waitForSendEvidence(
  candidate: Element,
  before: readonly ControlSnapshot[],
  knownSend: string[],
): Promise<boolean> {
  for (const wait of [40, 120, 200]) {
    await delay(wait);

    if (discoverSendButton(candidate, before)) {
      return true;
    }

    /*
     * The table's own send button, when it lives with this box.
     *
     * On a site the table knows, a send control inside the candidate's own
     * container is the same evidence by a shorter route — and it still says
     * something about *this* box rather than about the page in general.
     */
    const scope = containerOf(candidate);
    if (scope !== document && resolveSelector(scope, knownSend) !== undefined) {
      return true;
    }
  }

  return false;
}

/** The control that became usable once there was text to send. */
function discoverSendButton(
  composer: Element,
  before: readonly ControlSnapshot[],
): HTMLElement | undefined {
  const after = snapshotControls(composer);
  const chosen = chooseDiscoveredSend(newlyUsable(before, after));
  if (!chosen) {
    return undefined;
  }

  // Re-find the element by the key it was recorded under.
  const scope = containerOf(composer);

  return Array.from(scope.querySelectorAll('button,[role="button"]'))
    .filter((node): node is HTMLElement => node instanceof HTMLElement)
    .find((node) => controlKey(node) === chosen.key);
}

/**
 * Every editable on the page, ranked by how much it looks like a composer.
 *
 * Returns elements rather than a single choice, because the caller verifies by
 * writing and reading back — so this only has to put the right one early, not
 * get it right first time.
 */
function discoverComposers(): Element[] {
  const nodes = queryDeep(
    document,
    'textarea,[contenteditable="true"],[role="textbox"]',
  ).filter((node): node is HTMLElement => node instanceof HTMLElement);

  const snapshots = nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return {
      node,
      snapshot: {
        key: controlKey(node),
        area: Math.max(0, box.width) * Math.max(0, box.height),
        fromBottom: Math.max(0, window.innerHeight - box.bottom),
        inForm: node.closest("form") !== null,
      nearSendControl: hasOwnButton(node),
        label:
          node.getAttribute("aria-label") ??
          node.getAttribute("placeholder") ??
          node.getAttribute("data-placeholder") ??
          "",
        visible: isVisible(node),
        readOnly:
          node.hasAttribute("readonly") || node.getAttribute("aria-readonly") === "true",
      } satisfies EditableSnapshot,
    };
  });

  const byKey = new Map(snapshots.map((entry) => [entry.snapshot.key, entry.node]));

  return rankComposers(snapshots.map((entry) => entry.snapshot))
    .map((snapshot) => byKey.get(snapshot.key))
    .filter((node): node is HTMLElement => node !== undefined);
}

/**
 * The page's text, in the smallest blocks that hold a whole chunk of it.
 *
 * "Smallest that holds a chunk" is what makes this useful: a container whose
 * text is nearly all inside one child is that child's wrapper, not a block of
 * its own, and counting both would make every reply arrive twice.
 *
 * Keyed by position in the tree rather than by screen coordinates. A reply
 * arriving scrolls the conversation, so coordinates change for elements that
 * did not — and everything then looks new, which defeats the whole diff.
 */
export function snapshotConversation(root: ParentNode = document): TextBlock[] {
  const blocks: TextBlock[] = [];

  for (const element of Array.from(root.querySelectorAll("p,div,li,section,article,pre"))) {
    const text = (element.textContent ?? "").trim();
    if (text.length < MIN_REPLY_CHARACTERS) {
      continue;
    }

    // A wrapper around a single block is not a block.
    const dominated = Array.from(element.children).some(
      (child) => (child.textContent ?? "").trim().length >= text.length * 0.9,
    );
    if (dominated) {
      continue;
    }

    blocks.push({ key: treePath(element), text });
  }

  return blocks;
}

/** A node's position in the tree, as a path. Stable while the page grows. */
function treePath(element: Element): string {
  const steps: string[] = [];
  let node: Element | null = element;

  while (node && node !== document.body && steps.length < 12) {
    const parent: Element | null = node.parentElement;
    const index = parent ? Array.prototype.indexOf.call(parent.children, node) : 0;
    steps.push(`${node.tagName}:${index}`);
    node = parent;
  }

  return steps.reverse().join("/");
}

/**
 * Every match, including inside open shadow roots.
 *
 * `querySelectorAll` stops at a shadow boundary, so a composer inside a web
 * component is invisible to it — the page looks like it has no message box at
 * all and discovery falls back to nothing. Open roots are readable by any
 * script on the page, so this reaches what a user can see and no further:
 * a closed root stays closed, which is the site's decision to make.
 */
function queryDeep(root: ParentNode, selector: string, depth = 0): Element[] {
  // Deep enough for real component trees, shallow enough that a pathological
  // page cannot turn one search into a hang.
  if (depth > 8) {
    return [];
  }

  const found = Array.from(root.querySelectorAll(selector));

  for (const element of Array.from(root.querySelectorAll("*"))) {
    const shadow = (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (shadow) {
      found.push(...queryDeep(shadow, selector, depth + 1));
    }
  }

  return found;
}

/**
 * Whether this box has a usable button in its own container.
 *
 * Measured before anything is typed, so it costs nothing and cannot be
 * confused by the page reacting. A search field's container holds the field; a
 * composer's holds the field and the thing that sends it.
 */
function hasOwnButton(node: Element): boolean {
  const scope = containerOf(node);
  if (scope === document) {
    // No container of its own means no evidence either way, and treating the
    // whole page as "nearby" would make this true for everything.
    return false;
  }

  return Array.from(scope.querySelectorAll('button,[role="button"]'))
    .filter((candidate): candidate is HTMLElement => candidate instanceof HTMLElement)
    .some((candidate) => isVisible(candidate) && !saysSomethingElse(accessibleName(candidate)));
}

/** Empties a box we wrote into by mistake, so nothing is left behind. */
function clearText(element: Element): void {
  try {
    if (element instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(element, "");
      element.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (element instanceof HTMLElement && element.isContentEditable) {
      element.textContent = "";
      element.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
  } catch {
    // A box that refuses to be cleared is not worth failing the send over.
  }
}

/** Reads back what is actually in the composer, whichever kind it is. */
function readText(element: Element): string {
  if (element instanceof HTMLTextAreaElement) {
    return element.value;
  }
  return element.textContent ?? "";
}

/**
 * Sends the composer's contents with the key a user would press.
 *
 * All three events are dispatched because handlers differ in which they listen
 * for, and `keydown` is cancelable so a page that handles it can also suppress
 * the rest — which is exactly what a real keypress would do.
 */
function pressEnter(element: Element): void {
  const options = {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
    composed: true,
  };

  if (element instanceof HTMLElement) {
    element.focus();
  }

  const keydown = new KeyboardEvent("keydown", options);
  if (element.dispatchEvent(keydown)) {
    element.dispatchEvent(new KeyboardEvent("keypress", options));
  }
  element.dispatchEvent(new KeyboardEvent("keyup", options));
}

/**
 * Puts the caret inside the element, at the end of whatever is there.
 *
 * `focus()` alone does not guarantee a selection range inside a
 * contenteditable, and `execCommand("insertText")` silently does nothing
 * without one — which made the best insertion technique fail on an empty
 * composer and fall through to cruder ones the editor ignores.
 */
function placeCaretIn(element: HTMLElement): void {
  try {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  } catch {
    // A detached or hidden element cannot hold a caret; the later techniques
    // do not need one.
  }
}

/** Polls a condition to a deadline. Returns whether it came true in time. */
async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(50);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
