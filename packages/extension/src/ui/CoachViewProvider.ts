import * as vscode from "vscode";

import type { ContextEngine } from "../context/ContextEngine";
import type { CoachController } from "../coach/CoachController";
import type { SessionStore } from "../session/SessionStore";
import type { ExtensionState } from "../state/ExtensionState";
import {
  browserAction,
  buildHops,
  isInFlight,
  modelChoice,
  nextStep,
  providerRows,
  pasteStep,
  progressLabel,
  setupAction,
  type CoachViewModel,
} from "./viewModel";

/** Spec §58: the panel must not re-render on every keystroke. */
const RENDER_DEBOUNCE_MS = 120;

export class CoachViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "dumbways.coach";

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private renderTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly state: ExtensionState,
    private readonly sessions: SessionStore,
    private readonly contextEngine: ContextEngine,
    private readonly controller: CoachController,
  ) {
    this.disposables.push(
      this.state.onDidChange(() => this.scheduleRender()),
      this.sessions.onDidChange(() => this.scheduleRender()),

      // Editor context is live: whatever the user is looking at right now is
      // what the panel shows, without them pressing refresh.
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleRender()),
      vscode.window.onDidChangeTextEditorSelection(() => this.scheduleRender()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === vscode.window.activeTextEditor?.document) {
          this.scheduleRender();
        }
      }),
      vscode.workspace.onDidSaveTextDocument(() => this.scheduleRender()),
      vscode.languages.onDidChangeDiagnostics(() => this.scheduleRender()),
    );
  }

  dispose(): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (message: unknown) => void this.handleMessage(message),
      undefined,
      this.disposables,
    );

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.render();
      }
    }, undefined, this.disposables);

    this.render();
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (typeof message !== "object" || message === null || !("type" in message)) {
      return;
    }

    const typed = message as { type: string; text?: string };
    switch (typed.type) {
      case "ready":
        this.render();
        return;
      case "send":
        await vscode.commands.executeCommand("dumbways.sendFromPanel", typed.text ?? "");
        return;
      case "newSession":
        await vscode.commands.executeCommand("dumbways.newSession");
        return;
      case "showContext":
        await vscode.commands.executeCommand("dumbways.showCurrentContext");
        return;
      case "pasteReply":
        await vscode.commands.executeCommand("dumbways.pasteReply");
        return;
      case "copyAgain":
        await vscode.commands.executeCommand("dumbways.copyAgain");
        return;
      case "cancel":
        await vscode.commands.executeCommand("dumbways.cancelRequest");
        return;
      case "attachFile":
        await vscode.commands.executeCommand("dumbways.attachFile");
        return;
      case "removeAttachment":
        if (typeof typed.text === "string") {
          this.state.removeAttachment(typed.text);
        }
        return;
      case "startStack":
        await vscode.commands.executeCommand("dumbways.startStack");
        return;
      case "stopStack":
        await vscode.commands.executeCommand("dumbways.stopStack");
        return;
      case "copyRelayDetails":
        await vscode.commands.executeCommand("dumbways.copyRelayDetails");
        return;
      case "setupBrowser":
        await vscode.commands.executeCommand("dumbways.setupBrowser");
        return;
      case "pickModel":
        // The panel's own modal passes the id, so no QuickPick is needed.
        await vscode.commands.executeCommand("dumbways.pickModel", typed.text);
        return;
      default:
        return;
    }
  }

  private scheduleRender(): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
    }
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.render();
    }, RENDER_DEBOUNCE_MS);
  }

  private render(): void {
    const view = this.view;
    if (!view?.visible) {
      return;
    }

    const session = this.sessions.current;
    const connections = this.state.getConnections();
    const requestState = this.state.getRequestState();

    const model: CoachViewModel = {
      session: { id: session.id, name: session.name },
      connections,
      hops: buildHops(connections),
      requestState,
      progress: progressLabel(requestState),
      busy: isInFlight(requestState) || this.controller.isBusy(),
      context: this.contextEngine.summarize(),
      attachments: this.state.getAttachments(),
      messages: session.messages,
    };

    const paste = pasteStep(this.state.getAwaitingPaste());
    if (paste) {
      model.paste = paste;
    }

    const action = setupAction(connections);
    if (action) {
      model.setup = action;
    }

    model.next = nextStep(connections);
    model.model = modelChoice(this.state.getModel(), this.state.getSurfaces());
    model.providers = providerRows(this.state.getModel(), this.state.getSurfaces());

    const browser = browserAction(connections);
    if (browser) {
      model.browser = browser;
    }

    const lastError = this.state.getLastError();
    if (lastError) {
      model.lastError = lastError;
    }

    void view.webview.postMessage({ type: "render", model });
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "webview.css"),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "webview.js"),
    );
    // Generated from src/ui/prose.ts, so the panel and its tests cannot
    // disagree about what counts as a diagram.
    const proseUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "prose.generated.js"),
    );
    /*
     * Local files reach a webview through a rewritten URI, not a relative path,
     * so the renderer is handed the base rather than trying to construct one.
     */
    const logoBase = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "logos"),
    );

    // Locked-down CSP: no remote anything, scripts only by nonce. Provider
    // output is untrusted (spec §75) and the webview renders it via
    // textContent, never innerHTML.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Dumb Ways to Die</title>
</head>
<body>
  <!--
    The skull is defined once and referenced with <use>, so it inherits
    currentColor and adapts to the theme. Loading it as an <img> would freeze
    it black and make it disappear on dark backgrounds.
  -->
  <svg class="sprite" aria-hidden="true" focusable="false">
    <symbol id="skull" viewBox="0 0 24 24" fill-rule="evenodd" clip-rule="evenodd">
      <path d="M12 2.5c-5 0-8.6 3.6-8.6 8.2 0 2.6 1.3 4.5 2.9 5.7v2.3c0 1 .8 1.8 1.8 1.8h1.3v-2h1.5v2h2.2v-2h1.5v2h1.3c1 0 1.8-.8 1.8-1.8v-2.3c1.6-1.2 2.9-3.1 2.9-5.7 0-4.6-3.6-8.2-8.6-8.2Z M8.7 12.9a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6Z M15.3 12.9a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6Z" />
    </symbol>
  </svg>

  <!--
    App layout, not document flow: status and context stay put, the
    conversation takes the remaining height, the composer is pinned. The old
    version let the composer scroll away and capped the conversation at an
    arbitrary 420px.
  -->
  <header class="status">
    <button id="status-toggle" class="status-line" type="button" aria-expanded="false"
            aria-controls="status-detail" title="Connection detail">
      <svg class="brand-mark" aria-hidden="true"><use href="#skull" /></svg>
      <span id="status-dot" class="dot"></span>
      <span id="status-text" class="status-text">Starting…</span>
      <span id="status-chevron" class="chevron" aria-hidden="true">›</span>
    </button>

    <div id="status-detail" class="status-detail" hidden>
      <ul id="hops" class="hops"></ul>
      <button id="setup-action" class="setup-action" type="button" hidden></button>
      <div id="setup-hint" class="setup-hint muted" hidden></div>
      <button id="browser-action" class="setup-action secondary" type="button" hidden></button>
      <div id="browser-hint" class="setup-hint muted" hidden></div>

      <div class="detail-actions">
        <span id="session-name" class="muted"></span>
        <span class="spacer"></span>
        <button id="show-context" class="link-button" type="button">Preview context</button>
        <button id="new-session" class="link-button" type="button">New session</button>
      </div>
    </div>
  </header>

  <section id="context" class="context" aria-label="Current editor context"></section>

  <main id="conversation" class="conversation" aria-live="polite"></main>

  <!--
    The picker, inside the panel.
    A VS Code QuickPick opens over the editor, away from the thing it changes,
    and looks like every other command. Choosing which chat answers is part of
    this panel's job, so it happens here.
  -->
  <div id="picker" class="picker" hidden role="dialog" aria-modal="true"
       aria-label="Choose which chat answers">
    <div class="picker-sheet">
      <div class="picker-head">
        <div class="picker-heading">
          <span class="picker-title">Pick a chat</span>
          <span class="picker-subtitle muted">Choose where your next message goes.</span>
        </div>
        <button id="picker-close" class="icon-button" type="button" aria-label="Close">×</button>
      </div>
      <div id="picker-grid" class="picker-grid"></div>
    </div>
  </div>

  <footer class="composer">
    <div id="progress" class="progress" hidden>
      <span id="thinking" class="thinking" aria-hidden="true" hidden><i></i><i></i><i></i></span>
      <span id="progress-text"></span>
    </div>
    <div id="paste-step" class="paste-step" hidden>
      <div class="paste-title" id="paste-title"></div>
      <div class="paste-detail" id="paste-detail"></div>
      <div class="paste-actions">
        <button id="paste-reply" type="button"></button>
        <button id="copy-again" class="link-button" type="button">Copy again</button>
      </div>
    </div>

    <div id="attachments" class="attachments"></div>
    <textarea id="message" rows="1" placeholder="Ask about what you're looking at…"></textarea>
    <!--
      Four controls competing in one row read as clutter, and three of them
      were never the thing you wanted. "Attach" becomes an icon, the keyboard
      hint is dropped — the shortcut is on the Send button's tooltip, where
      someone looking for it will find it — and Cancel only exists while there
      is something to cancel.
    -->
    <div class="composer-actions">
      <button id="attach" class="icon-button" type="button" title="Attach a file"
              aria-label="Attach a file">+</button>
      <button id="model" class="model-button" type="button"
              title="Choose which chat answers"></button>
      <span class="spacer"></span>
      <button id="cancel" class="link-button" type="button" hidden>Stop</button>
      <button id="send" type="button" title="Send — ⌘⏎">Send</button>
    </div>
  </footer>

  <script nonce="${nonce}">window.dwtdLogoBase = "${logoBase.toString()}";</script>
  <script nonce="${nonce}" src="${proseUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}
