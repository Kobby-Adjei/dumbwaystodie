// @ts-check
/**
 * Panel renderer.
 *
 * Two rules hold this file together:
 *
 *  1. Everything the provider sends is untrusted (spec §75), so text reaches
 *     the DOM through textContent only. There is no innerHTML here, and the
 *     CSP forbids inline script, remote script and remote images.
 *
 *  2. Rendering is incremental, keyed by message id. Rebuilding the
 *     conversation on every state change collapsed any tool row the user had
 *     expanded and threw away their scroll position — invisible in a
 *     screenshot, obvious in the hand.
 */
(function () {
  const vscode = acquireVsCodeApi();

  /*
   * Loaded from prose.generated.js, which is built from the tested source.
   * The fallback keeps the panel working rather than throwing if that script
   * is ever missing — one unstyled diagram beats a blank conversation.
   */
  const splitProse =
    globalThis.dwtdSplitProse ?? ((text) => [{ kind: "text", text }]);

  const el = {
    statusToggle: /** @type {HTMLButtonElement} */ (document.getElementById("status-toggle")),
    statusDetail: /** @type {HTMLElement} */ (document.getElementById("status-detail")),
    statusDot: /** @type {HTMLElement} */ (document.getElementById("status-dot")),
    statusText: /** @type {HTMLElement} */ (document.getElementById("status-text")),
    hops: /** @type {HTMLElement} */ (document.getElementById("hops")),
    sessionName: /** @type {HTMLElement} */ (document.getElementById("session-name")),
    newSession: /** @type {HTMLButtonElement} */ (document.getElementById("new-session")),
    showContext: /** @type {HTMLButtonElement} */ (document.getElementById("show-context")),
    setupAction: /** @type {HTMLButtonElement} */ (document.getElementById("setup-action")),
    setupHint: /** @type {HTMLElement} */ (document.getElementById("setup-hint")),
    browserAction: /** @type {HTMLButtonElement} */ (document.getElementById("browser-action")),
    browserHint: /** @type {HTMLElement} */ (document.getElementById("browser-hint")),
    context: /** @type {HTMLElement} */ (document.getElementById("context")),
    conversation: /** @type {HTMLElement} */ (document.getElementById("conversation")),
    progress: /** @type {HTMLElement} */ (document.getElementById("progress")),
    thinking: /** @type {HTMLElement} */ (document.getElementById("thinking")),
    progressText: /** @type {HTMLElement} */ (document.getElementById("progress-text")),
    message: /** @type {HTMLTextAreaElement} */ (document.getElementById("message")),
    send: /** @type {HTMLButtonElement} */ (document.getElementById("send")),
    attach: /** @type {HTMLButtonElement} */ (document.getElementById("attach")),
    model: /** @type {HTMLButtonElement} */ (document.getElementById("model")),
    cancel: /** @type {HTMLButtonElement} */ (document.getElementById("cancel")),
    pasteStep: /** @type {HTMLElement} */ (document.getElementById("paste-step")),
    pasteTitle: /** @type {HTMLElement} */ (document.getElementById("paste-title")),
    pasteDetail: /** @type {HTMLElement} */ (document.getElementById("paste-detail")),
    pasteReply: /** @type {HTMLButtonElement} */ (document.getElementById("paste-reply")),
    copyAgain: /** @type {HTMLButtonElement} */ (document.getElementById("copy-again")),
    attachments: /** @type {HTMLElement} */ (document.getElementById("attachments")),
    picker: /** @type {HTMLElement} */ (document.getElementById("picker")),
    pickerGrid: /** @type {HTMLElement} */ (document.getElementById("picker-grid")),
    pickerClose: /** @type {HTMLButtonElement} */ (document.getElementById("picker-close")),
  };

  /** messageId -> { node, signature } so unchanged messages are never touched. */
  const rendered = new Map();

  /** The user opened the detail panel; do not fight them on re-render. */
  let detailPinned = false;

  /** What to do next, shown in the status line. See renderNextStep. */
  let nextStepText = "";

  /** "ok" | "waiting" | "action" — whether the user has something left to do. */
  let nextStepTone = "ok";

  const SUGGESTIONS = [
    "what am I looking at?",
    "show me the active file",
    "search for TODO",
    "show me the project structure",
  ];

  /* ------------------------------------------------------------------ *
   * Composer
   * ------------------------------------------------------------------ */

  const saved = vscode.getState();
  if (saved && typeof saved.draft === "string") {
    el.message.value = saved.draft;
  }
  autoGrow();

  function autoGrow() {
    el.message.style.height = "auto";
    el.message.style.height = `${Math.min(el.message.scrollHeight, 132)}px`;
  }

  el.message.addEventListener("input", () => {
    autoGrow();
    vscode.setState({ draft: el.message.value });
  });

  el.message.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      send();
    }
  });

  el.send.addEventListener("click", send);
  el.attach.addEventListener("click", () => vscode.postMessage({ type: "attachFile" }));
  el.model.addEventListener("click", () => setPickerOpen(true));
  el.pickerClose.addEventListener("click", () => setPickerOpen(false));

  // Clicking the backdrop dismisses; clicking the sheet must not.
  el.picker.addEventListener("click", (event) => {
    if (event.target === el.picker) {
      setPickerOpen(false);
    }
  });

  function setPickerOpen(open) {
    el.picker.hidden = !open;
    if (open) {
      const first = el.pickerGrid.querySelector("button");
      if (first instanceof HTMLElement) {
        first.focus();
      }
    } else {
      el.model.focus();
    }
  }
  el.cancel.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
  el.pasteReply.addEventListener("click", () => vscode.postMessage({ type: "pasteReply" }));
  el.copyAgain.addEventListener("click", () => vscode.postMessage({ type: "copyAgain" }));

  // Escape cancels, but only while something is actually running — otherwise it
  // is the key people press to dismiss things and it would do nothing visible.
  document.addEventListener("keydown", (event) => {
    // The picker is on top, so it takes Escape first — otherwise dismissing a
    // dialog would also cancel whatever was running behind it.
    if (event.key === "Escape" && !el.picker.hidden) {
      event.preventDefault();
      setPickerOpen(false);
      return;
    }
    if (event.key === "Escape" && !el.cancel.hidden) {
      event.preventDefault();
      vscode.postMessage({ type: "cancel" });
    }
  });
  el.newSession.addEventListener("click", () => vscode.postMessage({ type: "newSession" }));
  el.showContext.addEventListener("click", () => vscode.postMessage({ type: "showContext" }));

  el.setupAction.addEventListener("click", () => {
    const command = el.setupAction.dataset.command;
    if (command) {
      // Disabled until the next render reports the new state, so the button
      // cannot be double-fired while two processes are starting.
      el.setupAction.disabled = true;
      el.setupAction.textContent = "Working…";
      vscode.postMessage({ type: command });
    }
  });

  el.browserAction.addEventListener("click", () => {
    const command = el.browserAction.dataset.command;
    if (!command) {
      return;
    }
    vscode.postMessage({ type: command });

    // Copying does not change any connection state, so no render is coming to
    // undo a "Working…" label. Confirm in place and put the button back.
    if (command === "copyRelayDetails") {
      const label = el.browserAction.textContent;
      el.browserAction.textContent = "Copied — now paste it into the add-on";
      setTimeout(() => {
        el.browserAction.textContent = label;
      }, 2400);
    }
  });

  el.statusToggle.addEventListener("click", () => {
    detailPinned = el.statusDetail.hidden;
    setDetailOpen(detailPinned);
  });

  function setDetailOpen(open) {
    el.statusDetail.hidden = !open;
    el.statusToggle.setAttribute("aria-expanded", String(open));
  }

  function send(text) {
    const value = (typeof text === "string" ? text : el.message.value).trim();
    if (value.length === 0) {
      return;
    }
    vscode.postMessage({ type: "send", text: value });
    el.message.value = "";
    autoGrow();
    vscode.setState({ draft: "" });
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message && message.type === "render") {
      render(message.model);
    }
  });

  /* ------------------------------------------------------------------ *
   * DOM helpers
   * ------------------------------------------------------------------ */

  function clear(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  /**
   * Adds a reply's text, keeping any diagram's columns intact.
   *
   * The split is computed in the extension (see ui/prose.ts) where it can be
   * tested; this only has to place the pieces. Prose stays in the proportional
   * UI font because it reads better; a run of lines that points at a column
   * goes into a monospaced block, because in a proportional font a space is
   * narrower than a digit and the arrow ends up under the wrong number.
   */
  function appendProse(entry, text) {
    const segments = splitProse(text);

    if (segments.length === 0) {
      entry.appendChild(element("div", "message-text", text));
      return;
    }

    for (const segment of segments) {
      entry.appendChild(
        segment.kind === "art"
          ? element("pre", "message-art", segment.text)
          : element("div", "message-text", segment.text),
      );
    }
  }

  /**
   * References the one <symbol> in the document rather than re-inlining the
   * path, so every mark inherits currentColor and stays theme-correct.
   */
  function mark(className) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", className);
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#skull");
    svg.appendChild(use);
    return svg;
  }

  /* ------------------------------------------------------------------ *
   * Render
   * ------------------------------------------------------------------ */

  function render(model) {
    // Before renderStatus: the status line shows the next step, so it has to
    // be known by the time that line is painted.
    renderNextStep(model.next);
    renderModel(model.model);
    renderPicker(model.providers);
    renderStatus(model);
    renderContext(model.context);
    renderPasteStep(model.paste);
    renderAttachments(model.attachments);
    renderConversation(model.messages);

    const label = model.lastError ? `${model.progress} ${model.lastError}` : model.progress;
    el.progress.hidden = label.length === 0;
    el.progressText.textContent = label;

    /*
     * A visible status is not necessarily active work. Previously the dots
     * kept bouncing beside terminal labels such as "Done" and "Failed",
     * which made a finished request look stuck. Motion follows the same
     * `busy` truth as Send and Stop; the label may remain briefly without it.
     */
    el.thinking.hidden = !model.busy;
    /*
     * `hidden` controls layout; this class controls animation ownership.
     *
     * Keeping `animation: ... infinite` on the children and merely hiding their
     * parent still leaves an animation attached to every dot. Chromium normally
     * stops painting a display:none subtree, but DevTools and accessibility
     * snapshots still report an endlessly animated indicator after completion.
     * A terminal request should own no activity animation at all.
     */
    el.thinking.classList.toggle("is-active", model.busy);
    el.progress.setAttribute("aria-busy", String(model.busy));

    // Only the button locks. Disabling the textarea would steal focus
    // mid-sentence and stop you drafting the next question while you wait.
    el.send.disabled = model.busy;
    el.cancel.hidden = !model.busy;
  }

  /**
   * One line normally; the full hop list on demand (spec §0I is satisfied by
   * the state being *reachable and surfaced when it matters*, not by five rows
   * of permanent furniture). A broken hop opens the detail by itself.
   */
  function renderStatus(model) {
    const hops = model.hops || [];
    const broken = hops.find((hop) => hop.tone === "bad");
    const pending = hops.find((hop) => hop.tone === "pending");

    let tone = "ok";
    let text = "Ready";

    if (broken) {
      tone = "bad";
      text = `${broken.label}: ${labelFor(broken)}`;
    } else if (pending) {
      tone = "pending";
      text = `${pending.label}: ${labelFor(pending)}`;
    }
    // "3 of 5 hops live" was my architecture leaking into your status bar.
    // When nothing is wrong, the only honest short word is "Ready".

    el.statusDot.className = `dot dot-${tone}`;

    /*
     * One row, not two.
     *
     * The next-step line and the hop summary were separate bars stacked above
     * the conversation, and between them and the context row the chat had
     * almost no height left. They also said overlapping things — "Ready" and
     * "Ready. Ask about the file you are looking at." So the next step *is*
     * the status text now, and the hop breakdown stays behind the chevron
     * where it belongs.
     */
    el.statusText.textContent = nextStepText || text;

    /*
     * Open when there is something to do, not only when something is broken.
     *
     * The buttons that finish setup live in this detail panel, and it starts
     * collapsed — so a new user saw "Open a chat tab" with no visible way to
     * act on it. An incomplete setup is exactly when the space is worth
     * spending; once it is working the panel collapses and stays out of the
     * way. `detailPinned` still wins, so opening it by hand is never undone.
     */
    const needsSetup = nextStepTone === "action";
    setDetailOpen(detailPinned || Boolean(broken) || needsSetup);

    clear(el.hops);
    for (const hop of hops) {
      const row = element("li", "hop");
      row.appendChild(element("span", `dot dot-${hop.tone}`));
      row.appendChild(element("span", "hop-label", hop.label));
      row.appendChild(element("span", "hop-state", labelFor(hop)));
      row.title = hop.detail;
      el.hops.appendChild(row);
    }

    el.sessionName.textContent = model.session.name;
    renderSetupAction(model.setup);
    renderBrowserAction(model.browser);
  }

  /**
   * The one line that answers "can I type yet?".
   *
   * Sits above the hop dots because that is the question people actually
   * arrive with; the dots are for when the answer is no and they want to know
   * which part is at fault.
   */
  /** The composer's model button: always visible, always current. */
  function renderModel(choice) {
    if (!choice) {
      el.model.hidden = true;
      return;
    }
    el.model.hidden = false;
    el.model.textContent = `${choice.label} ▾`;
    el.model.dataset.connected = String(choice.connected);
  }

  /**
   * The picker rows.
   *
   * Rebuilt on each render, which is cheap for eight rows and means a chat
   * that just connected updates while the sheet is open. Provider artwork is
   * bundled locally so the picker remains fast, deterministic and CSP-safe.
   */
  function renderPicker(providers) {
    if (!providers) {
      return;
    }

    clear(el.pickerGrid);

    for (const provider of providers) {
      const row = element("button", "picker-row");
      row.type = "button";
      row.dataset.chosen = String(provider.chosen);
      row.dataset.blocked = String(provider.blocked);

      row.setAttribute("aria-pressed", String(provider.chosen));
      row.setAttribute(
        "aria-label",
        provider.blocked ? `${provider.label}, blocked by this browser` : provider.label,
      );
      if (provider.detail) {
        row.title = provider.detail;
      }

      /* A neutral canvas preserves each official mark's own colour and clear
       * space. The initial remains as an accessible visual fallback. */
      const tile = element("span", "picker-tile", provider.initial);

      if (provider.logo && globalThis.dwtdLogoBase) {
        const logo = document.createElement("img");
        logo.className = "picker-logo";
        logo.dataset.provider = provider.id;
        logo.src = `${globalThis.dwtdLogoBase}/${provider.logo}`;
        logo.alt = "";
        logo.addEventListener("error", () => logo.remove());
        tile.appendChild(logo);
      }

      const name = element("span", "picker-name", provider.label);
      const action = element(
        "span",
        "picker-action",
        provider.chosen ? "✓" : provider.blocked ? "×" : "›",
      );
      action.setAttribute("aria-hidden", "true");

      row.append(tile, name, action);
      row.addEventListener("click", () => {
        vscode.postMessage({ type: "pickModel", text: provider.id });
        setPickerOpen(false);
      });

      el.pickerGrid.appendChild(row);
    }
  }

  function renderNextStep(next) {
    nextStepText = next?.message ?? "";
    nextStepTone = next?.tone ?? "ok";
  }

  /** One contextual action, or none when there is nothing useful to offer. */
  function renderSetupAction(setup) {
    if (!setup) {
      el.setupAction.hidden = true;
      el.setupHint.hidden = true;
      return;
    }
    el.setupAction.hidden = false;
    el.setupAction.disabled = false;
    el.setupAction.textContent = setup.label;
    el.setupAction.dataset.command = setup.command;
    el.setupHint.hidden = false;
    el.setupHint.textContent = setup.hint;
  }

  /** The browser route, offered alongside rather than instead of the above. */
  function renderBrowserAction(browser) {
    if (!browser) {
      el.browserAction.hidden = true;
      el.browserHint.hidden = true;
      return;
    }
    el.browserAction.hidden = false;
    el.browserAction.disabled = false;
    el.browserAction.textContent = browser.label;
    el.browserAction.dataset.command = browser.command;
    el.browserHint.hidden = false;
    el.browserHint.textContent = browser.hint;
  }

  function labelFor(hop) {
    return hop.state === "not-implemented" ? "not built yet" : hop.state;
  }

  /**
   * The filename leads; facts are subordinate. Unsaved state gets the only
   * accent because it is the one fact that changes what gets sent.
   */
  function renderContext(context) {
    clear(el.context);

    if (!context || !context.activeFile) {
      el.context.appendChild(
        element("div", "context-empty", "No file open — nothing to look at yet."),
      );
      return;
    }

    const fileRow = element("div", "context-file");
    const name = element("span", "context-name", context.activeFile);
    name.title = context.activeFile;
    fileRow.appendChild(name);
    fileRow.appendChild(element("span", "context-language", context.language || "plaintext"));
    el.context.appendChild(fileRow);

    const facts = element("div", "context-facts");
    const add = (text, className) => facts.appendChild(element("span", className, text));

    if (context.isDirty) {
      add("● unsaved", "fact-dirty");
    } else {
      add("saved");
    }

    if (context.blockedReason) {
      add(`· content withheld: ${context.blockedReason}`, "fact-dirty");
    } else if (typeof context.bufferCharacters === "number") {
      add(`· ${context.bufferCharacters.toLocaleString()} chars`);
    }

    if (context.selection) {
      add(`· L${context.selection.startLine}–${context.selection.endLine}`);
    }

    if (context.diagnosticCount > 0) {
      add(
        `· ${context.diagnosticCount} problem${context.diagnosticCount === 1 ? "" : "s"}`,
        "fact-problem",
      );
    }

    el.context.appendChild(facts);
  }

  /**
   * The clipboard transport is a conversation with the user, not a spinner:
   * it says what was copied and what to do with it.
   */
  function renderPasteStep(step) {
    if (!step) {
      el.pasteStep.hidden = true;
      return;
    }
    el.pasteStep.hidden = false;
    el.pasteTitle.textContent = step.title;
    el.pasteDetail.textContent = step.detail;
    el.pasteReply.textContent = step.action;
  }

  /** Staged attachments: metadata only, with the size the coach will see. */
  function renderAttachments(attachments) {
    clear(el.attachments);
    if (!attachments || attachments.length === 0) {
      el.attachments.hidden = true;
      return;
    }
    el.attachments.hidden = false;

    for (const attachment of attachments) {
      const chip = element("span", "attachment");
      chip.appendChild(element("span", "attachment-name", attachment.filename));
      chip.appendChild(element("span", "attachment-size", formatBytes(attachment.size)));

      const remove = element("button", "attachment-remove", "\u00d7");
      remove.type = "button";
      remove.title = "Remove " + attachment.filename;
      remove.addEventListener("click", () =>
        vscode.postMessage({ type: "removeAttachment", text: attachment.id }),
      );
      chip.appendChild(remove);

      chip.title = attachment.mimeType + " \u00b7 sha256 " + attachment.sha256.slice(0, 12);
      el.attachments.appendChild(chip);
    }
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function renderConversation(messages) {
    if (!messages || messages.length === 0) {
      rendered.clear();
      clear(el.conversation);
      el.conversation.appendChild(renderEmptyState());
      return;
    }

    // A brand-new session replaces everything; otherwise patch in place.
    const ids = new Set(messages.map((message) => message.id));
    for (const [id, entry] of rendered) {
      if (!ids.has(id)) {
        entry.node.remove();
        rendered.delete(id);
      }
    }
    if (rendered.size === 0) {
      clear(el.conversation);
    }

    const stick = isNearBottom();

    for (const message of messages) {
      const signature = signatureOf(message);
      const existing = rendered.get(message.id);

      if (!existing) {
        const node = renderMessage(message);
        el.conversation.appendChild(node);
        rendered.set(message.id, { node, signature });
        continue;
      }

      if (existing.signature !== signature) {
        // Only tool rows change after creation (running -> ok/error). Patching
        // in place preserves whether the user had expanded it.
        patchMessage(existing.node, message);
        existing.signature = signature;
      }
    }

    if (stick) {
      el.conversation.scrollTop = el.conversation.scrollHeight;
    }
  }

  /** Within a screen-ish of the bottom counts as "following along". */
  function isNearBottom() {
    const distance =
      el.conversation.scrollHeight - el.conversation.scrollTop - el.conversation.clientHeight;
    return distance < 60;
  }

  function signatureOf(message) {
    if (message.role === "tool" && message.tool) {
      const tool = message.tool;
      return [
        tool.status,
        tool.durationMs ?? "",
        tool.resultSummary ?? "",
        tool.errorCode ?? "",
      ].join("|");
    }
    return message.text;
  }

  function renderEmptyState() {
    const wrapper = element("div", "empty");
    wrapper.appendChild(mark("empty-mark"));
    wrapper.appendChild(element("div", "empty-title", "What's confusing you?"));

    const list = element("div", "suggestions");
    for (const suggestion of SUGGESTIONS) {
      const button = element("button", "suggestion", suggestion);
      button.type = "button";
      button.addEventListener("click", () => {
        el.message.value = suggestion;
        autoGrow();
        el.message.focus();
      });
      list.appendChild(button);
    }

    wrapper.appendChild(list);
    return wrapper;
  }

  function renderMessage(message) {
    if (message.role === "tool" && message.tool) {
      return renderToolActivity(message.tool);
    }

    const entry = element("div", `message message-${message.role}`);
    fillMessage(entry, message);
    return entry;
  }

  function patchMessage(node, message) {
    if (message.role === "tool" && message.tool) {
      const wasOpen = node.open;
      clear(node);
      fillToolActivity(node, message.tool);
      node.open = wasOpen;
      return;
    }

    clear(node);
    fillMessage(node, message);
  }

  /**
   * No "USER"/"COACH" captions. The card says you spoke; the mark says the
   * other side did. A label naming the thing on the other end would be a claim
   * this bridge cannot honestly make — it does not know what is answering.
   */
  /** What that turn actually sent, verifiable rather than promised. */
  function appendReceipt(entry, receipt) {
    const details = element("details", "receipt");
    const summary = document.createElement("summary");
    summary.appendChild(element("span", "receipt-summary", "sent: " + receipt.summary));
    details.appendChild(summary);

    const body = element("div", "receipt-body");
    body.appendChild(element("div", "receipt-line", "Where: " + receipt.destination));
    body.appendChild(
      element("div", "receipt-line", "Size: " + receipt.characters.toLocaleString() + " characters"),
    );

    body.appendChild(element("div", "receipt-heading", "Included"));
    for (const line of receipt.included) {
      body.appendChild(element("div", "receipt-line", line.label + ": " + line.detail));
    }

    body.appendChild(element("div", "receipt-heading", "Not included"));
    for (const line of receipt.withheld) {
      body.appendChild(element("div", "receipt-line", line));
    }

    details.appendChild(body);
    entry.appendChild(details);
  }

  function fillMessage(entry, message) {
    if (message.role === "coach") {
      entry.setAttribute("aria-label", "reply");
      entry.appendChild(mark("reply-mark"));
      const body = element("div", "message-body");
      appendBody(body, message);
      entry.appendChild(body);
      return;
    }

    if (message.role === "user") {
      entry.setAttribute("aria-label", "you");
    }
    if (message.role === "error") {
      entry.appendChild(element("div", "message-label", "error"));
    }

    appendBody(entry, message);

    if (message.role === "user" && message.receipt) {
      appendReceipt(entry, message.receipt);
    }
  }

  function appendBody(entry, message) {
    if (message.parts && message.parts.length > 0) {
      for (const part of message.parts) {
        if (part.type === "text") {
          appendProse(entry, part.text);
        } else if (part.type === "code") {
          const pre = element("pre", "code");
          pre.appendChild(element("code", undefined, part.code));
          entry.appendChild(pre);
        } else if (part.type === "attachment") {
          entry.appendChild(element("div", "muted", `attachment: ${part.attachment.filename}`));
        }
      }
      return;
    }
    appendProse(entry, message.text);
  }

  /** Tool traffic collapses by default (spec §29): a receipt, not conversation. */
  function renderToolActivity(tool) {
    const wrapper = element("details", "message message-tool");
    fillToolActivity(wrapper, tool);
    return wrapper;
  }

  function fillToolActivity(wrapper, tool) {
    wrapper.className = `message message-tool tool-${tool.status}`;

    const summary = document.createElement("summary");
    summary.appendChild(element("span", "tool-status", statusGlyph(tool.status)));
    summary.appendChild(element("span", "tool-name", tool.tool));
    if (tool.argsSummary) {
      summary.appendChild(element("span", "tool-args", tool.argsSummary));
    }
    wrapper.appendChild(summary);

    const detail = element("div", "tool-detail");
    if (tool.argsSummary) {
      detail.appendChild(element("div", undefined, `Arguments: ${tool.argsSummary}`));
    }
    if (tool.resultSummary) {
      detail.appendChild(element("div", undefined, `Result: ${tool.resultSummary}`));
    }
    if (typeof tool.durationMs === "number") {
      detail.appendChild(element("div", undefined, `Took ${tool.durationMs} ms`));
    }
    if (tool.errorCode) {
      detail.appendChild(element("div", undefined, `Error: ${tool.errorCode}`));
    }
    wrapper.appendChild(detail);
  }

  function statusGlyph(status) {
    if (status === "running") {
      return "◌";
    }
    return status === "ok" ? "✓" : "✕";
  }

  vscode.postMessage({ type: "ready" });
})();
