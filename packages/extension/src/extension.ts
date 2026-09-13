import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { MockCoachProvider } from "@dumbways/mock-provider";
import {
  CHAT_PROVIDERS,
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_RELAY_PORT,
  PROTOCOL_VERSION,
  type CoachRequest,
  type CoachSession,
  type ContextBudget,
  type LearningMode,
  type WorkspaceRootRef,
} from "@dumbways/protocol";

import { ClipboardCoachProvider } from "./transport/ClipboardCoachProvider";
import { ProviderLauncher } from "./transport/ProviderLauncher";
import { RelayCoachProvider } from "./transport/RelayCoachProvider";
import { RelayLauncher } from "./transport/RelayLauncher";

import { CoachController } from "./coach/CoachController";
import { configScope, workspaceToolsAvailable } from "./config/scope";
import { buildDiagnosticsReport } from "./diagnostics/report";
import { ContextEngine } from "./context/ContextEngine";
import { buildReceipt, renderReceipt } from "./context/receipt";
import { requestToMarkdown } from "./context/serialize";
import { ContextLedger } from "./context/ledger";
import { VsCodeEditorAdapter } from "./editor/VsCodeEditorAdapter";
import { compareAddonBuild } from "./ui/addonBuild";
import { ChatHomes, describeHome } from "./ui/chatHomes";
import { SessionStore } from "./session/SessionStore";
import { ExtensionState } from "./state/ExtensionState";
import {
  DEFAULT_MAX_MEDIA_BYTES,
  MediaRegistry,
  supportedExtensions,
} from "./media/MediaRegistry";
import { PermissionManager } from "./permissions/PermissionManager";
import {
  VsCodePermissionPrompt,
  WorkspaceGrantStore,
} from "./permissions/VsCodePermissionPrompt";
import { DEFAULT_ENV_ALLOWLIST } from "./shell/CommandRunner";
import { registerDefaultTools } from "./tools/definitions";
import { ToolRegistry } from "./tools/ToolRegistry";
import { CoachViewProvider } from "./ui/CoachViewProvider";
import {
  DEFAULT_IGNORED_DIRECTORIES,
  NodeWorkspaceAdapter,
} from "./workspace/NodeWorkspaceAdapter";
import { NodeSearchBackend } from "./workspace/search/NodeSearchBackend";
import {
  ripgrepCandidatePaths,
  RipgrepSearchBackend,
  resolveRipgrepPath,
} from "./workspace/search/RipgrepSearchBackend";

/**
 * Extension bootstrap (spec §0D).
 *
 * activate() wires modules together and nothing else. Every piece of logic
 * lives in its own module so it can be tested, replaced, or moved behind the
 * relay later without touching this file.
 *
 * Milestone A scope (spec §99): sidebar, live editor context, in-process mock
 * provider, response in the panel. No relay, no sockets, no media, no tools,
 * no browser, no writes.
 */

let disposeBridge: (() => void) | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("Dumb Ways to Die");
  log.appendLine(`[activate] Dumb Ways to Die — Milestone A (protocol v1)`);

  const state = new ExtensionState();
  const editorAdapter = new VsCodeEditorAdapter();

  // The editor ships ripgrep; use it when it is really there. It is faster
  // and, more importantly, its regex engine cannot catastrophically backtrack
  // and runs where it can be killed — which is what makes accepting a pattern
  // from the coach safe at all (see docs/adr/0006).
  const ripgrepPath = resolveRipgrepPath(ripgrepCandidatePaths(vscode.env.appRoot));
  const searchBackend = ripgrepPath
    ? new RipgrepSearchBackend(ripgrepPath)
    : new NodeSearchBackend();

  log.appendLine(
    ripgrepPath
      ? `[activate] search backend: ripgrep (${ripgrepPath})`
      : "[activate] search backend: node traversal — ripgrep not found, regex search will be refused",
  );

  const workspaceAdapter = new NodeWorkspaceAdapter(
    readWorkspaceRoots,
    readIgnoredDirectories,
    searchBackend,
  );

  // The permission gate now has a human in it (spec §17). `controllerRef` is
  // late-bound because the controller is built from the registry: while a
  // modal is open the request timeout is suspended, so a user who takes a
  // minute to decide does not get a timed-out request as a reward.
  let controllerRef: CoachController | undefined;

  const permissions = new PermissionManager({
    getMode: readLearningMode,
    prompt: new VsCodePermissionPrompt(),
    store: new WorkspaceGrantStore(context.workspaceState),
    log: (message) => log.appendLine(message),
    onPromptOpen: () => controllerRef?.pauseTimeout(),
    onPromptClose: () => controllerRef?.resumeTimeout(),
  });

  const toolRegistry = new ToolRegistry({
    resolvePermission: (request) => permissions.resolve(request),
    log: (message) => log.appendLine(message),
  });
  registerDefaultTools(toolRegistry, {
    editor: editorAdapter,
    workspace: workspaceAdapter,
    getBudget: readBudget,
    getEnvAllowlist: readEnvAllowlist,
  });

  const media = new MediaRegistry({
    mediaDir: resolveMediaDir(),
    maxBytes: readMaxMediaBytes(),
    log: (message) => log.appendLine(message),
  });

  /*
   * Keep the add-on Chrome is pointing at up to date.
   *
   * Only refreshed once it exists — this must not create the folder for
   * someone who never set up the browser. When it does exist, a rebuilt
   * extension lands there on the next window reload, so updating the add-on
   * is a Chrome reload rather than a re-install.
   */
  if (fsSync.existsSync(stableBrowserDist())) {
    void publishBrowserDist(log);
  }

  const contextEngine = new ContextEngine(editorAdapter, readBudget, toolRegistry);
  /*
   * Workspace storage, not the repo.
   *
   * A conversation belongs to this machine and this project, not to the code
   * — writing it into `.coach/` would put it in front of `git status` and
   * eventually into someone's pull request.
   */
  const sessions = new SessionStore(readWorkspaceRoots, {
    read: () => context.workspaceState.get<CoachSession>("session"),
    write: (session) => void context.workspaceState.update("session", session),
  });

  // Transport is a setting, not a guess. Auto-detecting "use the relay if a
  // provider happens to be attached" would make the same action behave
  // differently on two machines for reasons the user cannot see.
  const useRelay = readProviderMode() === "relay";
  const relayPort = readRelayPort();
  /*
   * One token for this machine, minted once.
   *
   * Kept in globalState rather than regenerated, so restarting the relay does
   * not log the browser add-on out. This is the same secret the handshake file
   * holds, and it is only ever readable by this extension and by processes
   * this user runs.
   */
  /*
   * Global, not workspace: where coding chats live is a fact about the user's
   * account, and answering the same question again in every repository is the
   * kind of friction that makes a setting feel like an interrogation.
   */
  const chatHomes = new ChatHomes(context.globalState);

  /*
   * The add-on build this extension ships, read from the copy it would install.
   * Written by the add-on's own build, so both sides name the same thing.
   */
  const shippedAddonBuild = readShippedAddonBuild();
  let lastStaleBuild: string | undefined;

  const relayToken = ((): string => {
    const existing = context.globalState.get<string>("relayToken");
    if (existing && existing.length >= 32) {
      return existing;
    }
    const minted = crypto.randomBytes(32).toString("hex");
    void context.globalState.update("relayToken", minted);
    return minted;
  })();

  const launcher = new RelayLauncher({
    port: relayPort,
    relayEntry: resolveRelayEntry(),
    token: relayToken,
    // Derived from the relay bundle itself, not the extension version: the
    // version stays put for a hundred rebuilds during development, and a
    // stale-code check that only fires on a version bump would never fire.
    build: buildIdOf(resolveRelayEntry(), context.extension.packageJSON.version as string),
    log: (message) => log.appendLine(message),
  });

  const providerLauncher = new ProviderLauncher({
    providerEntry: resolveProviderEntry(),
    port: relayPort,
    log: (message) => log.appendLine(message),
  });

  /*
   * One ledger, shared by every transport.
   *
   * What a chat has already been shown is a fact about the conversation, not
   * about how the bytes travelled to it — so this sits above the transports
   * and neither of them knows it exists. They ask for a rendered request and
   * get one that leaves out what the far side already has.
   */
  const ledger = new ContextLedger();

  const planContext = (request: CoachRequest): CoachRequest => {
    ledger.startSession(request.sessionId);
    const planned = ledger.plan(request.contextItems);

    if (planned.savedCharacters > 0) {
      log.appendLine(
        `[context] ${planned.savedCharacters} characters withheld: the chat already has them`,
      );
    }

    return { ...request, contextItems: planned.items };
  };

  const buildRelayProvider = (): RelayCoachProvider =>
    new RelayCoachProvider({
        launcher,
        log: (message) => log.appendLine(message),
        // The same rendering the clipboard route uses. A chat on the far side
        // of the relay needs the context just as much as one on the far side
        // of a paste.
        renderRequest: requestToMarkdown,
        listTools: () => toolRegistry.list(),
        onRelayState: (hop, detail) => {
          state.setHop("relay", hop);
          if (detail) {
            log.appendLine(`[relay] ${hop}: ${detail}`);
          }
        },
      onProviderPresence: (present) =>
        state.setHop("provider", present ? "ready" : "disconnected"),

      /*
       * The browser and chat hops used to have no source at all: they were
       * initialised to "not-implemented" and never touched, so the panel said
       * "not built yet" while a browser was demonstrably attached and driving
       * a chat. A hop with no reporter is a claim nobody checks.
       */
      onBrowserPresence: (present) => {
        state.setHop("browser", present ? "connected" : "disconnected");
        if (!present) {
          // No browser means nothing can be paired, whatever it last said.
          state.setHop("chatSurface", "disconnected");
        }
      },

      onSurfaces: (surfaces) => state.setSurfaces(surfaces),

      onSurfaceStatus: (paired, surfaceType, detail) => {
        state.setHop("chatSurface", paired ? "ready" : "disconnected");
        if (detail) {
          log.appendLine(`[browser] ${surfaceType ?? "chat"}: ${detail}`);
        }
      },
      /*
       * A connected add-on running yesterday's code looks exactly like a
       * connected add-on. Said once per build rather than on every status, so
       * it is a warning and not a nag.
       */
      onAddonBuild: (running) => {
        const verdict = compareAddonBuild(shippedAddonBuild, running);
        if (verdict.stale && lastStaleBuild !== running) {
          lastStaleBuild = running;
          log.appendLine(`[browser] stale add-on: running ${running}, shipped ${shippedAddonBuild}`);
          void vscode.window.showWarningMessage(verdict.message ?? "The browser add-on is stale.");
        }
      },
    });

  // The clipboard transport works with any chat surface, so it needs no
  // browser extension and no site-specific code (see docs/design/chat-surface-bridge.md).
  const clipboardProvider = new ClipboardCoachProvider({
    clipboard: {
      write: (text) => Promise.resolve(vscode.env.clipboard.writeText(text)),
      read: () => Promise.resolve(vscode.env.clipboard.readText()),
    },
    renderRequest: requestToMarkdown,
    listTools: () => toolRegistry.list(),
    log: (message) => log.appendLine(message),
    onAwaiting: (kind) => state.setAwaitingPaste(kind),
  });

  const mode = readProviderMode();
  const provider =
    mode === "relay"
      ? buildRelayProvider()
      : mode === "clipboard"
        ? clipboardProvider
        : new MockCoachProvider();

  if (mode === "clipboard") {
    state.setProviderName("Clipboard (any chat)");
  }

  if (useRelay) {
    // Stop claiming this hop does not exist the moment it does.
    state.setHop("relay", "disconnected");
    state.setProviderName("Relay (separate process)");
  }

  const controller = new CoachController(
    state,
    sessions,
    contextEngine,
    provider,
    toolRegistry,
    log,
    () => ({ kind: readProviderMode(), relayPort }),
    planContext,
    () => state.getModel(),
  );

  /**
   * Keeps the same conversation and tools, but uses the route every browser
   * permits: the system clipboard.
   *
   * Comet deliberately blocks external extensions from scripting some of its
   * surfaces. That is a browser boundary, not a selector failure. Falling back
   * here keeps the selected chat usable without pretending the add-on paired
   * or asking the user to leave their browser.
   */
  const useClipboardRoute = async (message?: string): Promise<void> => {
    await vscode.workspace
      .getConfiguration("dumbways")
      .update("provider.mode", "clipboard", settingsTarget());
    state.setProviderName("Clipboard (any chat)");
    state.setHop("relay", "not-implemented");
    await controller.swapProvider(clipboardProvider);
    void vscode.window.showInformationMessage(
      message ??
        "Ready. Type a question and press Send — the first message explains itself to the chat.",
    );
  };

  /**
   * Consent before the first send to a destination that is not this window
   * (spec: the user must know the extent of what is collected).
   *
   * Asked once per destination per workspace, not every turn — a prompt people
   * see constantly is a prompt they stop reading. The receipt stays available
   * on every message and through `Show What Gets Sent`.
   */
  const consentKey = (kind: string): string => `dumbways.consent.${kind}`;

  const ensureConsent = async (): Promise<boolean> => {
    const kind = readProviderMode();
    if (kind === "in-process" || context.workspaceState.get<boolean>(consentKey(kind))) {
      return true;
    }

    const { request } = contextEngine.buildRequest({
      sessionId: sessions.current.id,
      message: "(preview)",
      attachments: state.getAttachments(),
    });
    const receipt = buildReceipt(request, kind, relayPort);

    const proceed = "Send it";
    const review = "Show me everything first";
    const choice = await vscode.window.showInformationMessage(
      "Dumb Ways to Die is about to send your editor context.",
      {
        modal: true,
        detail: [
          `Where it goes: ${receipt.destination}`,
          "",
          "This turn would include:",
          ...receipt.included.map((line) => `  • ${line.label}: ${line.detail}`),
          "",
          "It never includes:",
          ...receipt.withheld.slice(-4).map((line) => `  • ${line}`),
        ].join("\n"),
      },
      proceed,
      review,
    );

    if (choice === review) {
      log.appendLine("");
      log.appendLine(renderReceipt(receipt));
      log.show(true);
      return false;
    }
    if (choice !== proceed) {
      return false;
    }

    await context.workspaceState.update(consentKey(kind), true);
    return true;
  };

  controllerRef = controller;

  // The Escape keybinding is gated on this context key. Without it the
  // binding is declared and never fires, which is worse than not having one.
  let busyContext = false;
  context.subscriptions.push(
    state.onDidChange(() => {
      const busy = controller.isBusy();
      if (busy !== busyContext) {
        busyContext = busy;
        void vscode.commands.executeCommand("setContext", "dumbways.busy", busy);
      }
    }),
  );

  log.appendLine(`[activate] transport: ${useRelay ? `relay on port ${relayPort}` : "in-process"}`);
  log.appendLine(
    `[activate] permission mode: ${readLearningMode()} — ${JSON.stringify(permissions.policy())}`,
  );

  log.appendLine(
    `[activate] registered tools: ${toolRegistry.list().map((tool) => tool.name).join(", ")}`,
  );

  const view = new CoachViewProvider(context.extensionUri, state, sessions, contextEngine, controller);
  // Only the latest model-pick command may change selection. A slow page from
  // an earlier pick can finish after a later one and must not steal the route.
  let latestModelPick = 0;

  context.subscriptions.push(
    log,
    state,
    editorAdapter,
    sessions,
    controller,
    view,
    vscode.window.registerWebviewViewProvider(CoachViewProvider.viewType, view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dumbways.openCoach", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.dumbways");
    }),

    vscode.commands.registerCommand("dumbways.newSession", async () => {
      const session = await controller.resetSession();
      log.appendLine(`[session] new session ${session.id}`);
      vscode.window.setStatusBarMessage("Dumb Ways to Die: new session started", 2000);
    }),

    vscode.commands.registerCommand("dumbways.sendMessage", async () => {
      const message = await vscode.window.showInputBox({
        title: "Dumb Ways to Die",
        prompt: "What is confusing you?",
        placeHolder: "What am I looking at?",
      });
      if (message && (await ensureConsent())) {
        await vscode.commands.executeCommand("workbench.view.extension.dumbways");
        await controller.send(message);
      }
    }),

    // The explicit counterpart to auto-start: the relay is deliberately left
    // running across editor reloads, so there has to be a way to stop it.
    vscode.commands.registerCommand("dumbways.stopRelay", async () => {
      const stopped = await launcher.stop();
      void vscode.window.showInformationMessage(
        stopped
          ? "Dumb Ways to Die: relay stopped."
          : `Dumb Ways to Die: no relay was running on port ${relayPort}.`,
      );
    }),

    // Spec §0X: one action instead of "run these two commands, change a
    // setting, then reload". Everything it does is also reachable by hand.
    vscode.commands.registerCommand("dumbways.startStack", async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Dumb Ways to Die" },
        async (progress) => {
          try {
            progress.report({ message: "Starting the local relay…" });
            await vscode.workspace
              .getConfiguration("dumbways")
              .update("provider.mode", "relay", settingsTarget());

            // Swapping rather than reloading keeps the conversation alive.
            state.setProviderName("Relay (separate process)");
            await controller.swapProvider(buildRelayProvider());

            progress.report({ message: "Starting the provider process…" });
            providerLauncher.start();

            // The relay works fine without a folder; four of the seven tools
            // do not. Say so now rather than letting it be discovered one
            // refused tool at a time.
            if (!workspaceToolsAvailable(hasWorkspaceFolder())) {
              log.appendLine("[stack] no folder open — workspace tools will refuse");
              void vscode.window.showWarningMessage(
                "Dumb Ways to Die: no folder is open, so reading files, searching and the project tree will be refused. Open a folder to enable them.",
                "Open Folder…",
              ).then((choice) => {
                if (choice) {
                  void vscode.commands.executeCommand("workbench.action.files.openFolder");
                }
              });
            }

            // Presence arrives from the relay's registry, not from a guess.
            const attached = await waitForProvider(state, 8000);
            void vscode.window.showInformationMessage(
              attached
                ? "Dumb Ways to Die: relay and provider are running."
                : "Dumb Ways to Die: the relay is up, but no provider attached. Check the output channel.",
            );
          } catch (error) {
            log.appendLine(`[stack] failed: ${String(error)}`);
            void vscode.window.showErrorMessage(
              `Dumb Ways to Die: could not start the stack — ${String(error)}`,
            );
          }
        },
      );
    }),

    vscode.commands.registerCommand("dumbways.stopStack", async () => {
      const stoppedProvider = providerLauncher.stop();
      const stoppedRelay = await launcher.stop();
      await vscode.workspace
        .getConfiguration("dumbways")
        .update("provider.mode", "in-process", settingsTarget());
      state.setProviderName("Mock (in-process)");
      state.setHop("relay", "not-implemented");
      await controller.swapProvider(new MockCoachProvider());
      void vscode.window.showInformationMessage(
        `Dumb Ways to Die: stopped ${[stoppedRelay && "relay", stoppedProvider && "provider"]
          .filter(Boolean)
          .join(" and ") || "nothing"}; back to the in-process provider.`,
      );
    }),

    // Spec §46: a user must be able to stop a request. Bound to Escape in the
    // panel as well as the palette.
    vscode.commands.registerCommand("dumbways.cancelRequest", async () => {
      if (!controller.isBusy()) {
        vscode.window.setStatusBarMessage("Dumb Ways to Die: nothing to cancel", 2000);
        return;
      }
      await controller.cancel();
    }),

    vscode.commands.registerCommand("dumbways.showDiagnostics", () => {
      log.appendLine("");
      log.appendLine(
        buildDiagnosticsReport({
          extensionVersion: context.extension.packageJSON.version as string,
          protocolVersion: PROTOCOL_VERSION,
          transport: readProviderMode(),
          relayPort,
          connections: state.getConnections(),
          requestState: state.getRequestState(),
          ...(state.getLastError() ? { lastError: state.getLastError() as string } : {}),
          sessionId: sessions.current.id,
          sessionMessages: sessions.current.messages.length,
          ...(sessions.current.activeRequestId
            ? { activeRequestId: sessions.current.activeRequestId }
            : {}),
          workspaceRoots: readWorkspaceRoots().map((root) => root.path),
          tools: toolRegistry.list(),
          capabilities: toolRegistry.getCapabilities(),
          permissionMode: readLearningMode(),
          permissionPolicy: permissions.policy(),
          rememberedApprovals: permissions.remembered().length,
          searchBackend: ripgrepPath ? "ripgrep" : "node traversal",
          ...(ripgrepPath ? { ripgrepPath } : {}),
          mediaDir: resolveMediaDir(),
          attachmentsStaged: state.getAttachments().length,
          envAllowlist: readEnvAllowlist(),
        }),
      );
      log.show(true);
    }),

    // The panel routes through here so the consent gate cannot be bypassed by
    // sending from the webview instead of the palette.
    vscode.commands.registerCommand("dumbways.sendFromPanel", async (text: string) => {
      if (await ensureConsent()) {
        await controller.send(text);
      }
    }),

    vscode.commands.registerCommand("dumbways.showWhatGetsSent", () => {
      const { request } = contextEngine.buildRequest({
        sessionId: sessions.current.id,
        message: "(preview — nothing was sent)",
        attachments: state.getAttachments(),
      });
      log.appendLine("");
      log.appendLine(renderReceipt(buildReceipt(request, readProviderMode(), relayPort)));
      log.show(true);
    }),

    /**
     * Hands the relay's credentials to the browser extension.
     *
     * The browser cannot read the handshake file — that is the point of the
     * file — so the token crosses through the user, once, deliberately. An
     * unauthenticated endpoint that gave it away would undo the whole reason
     * the token exists.
     */
    vscode.commands.registerCommand("dumbways.copyRelayDetails", async () => {
      try {
        const endpoint = await launcher.ensureRunning();
        await vscode.env.clipboard.writeText(
          JSON.stringify({ host: endpoint.host, port: endpoint.port, token: endpoint.token }),
        );
        void vscode.window.showInformationMessage(
          "Copied. Paste this into the browser add-on and press Connect.",
        );
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Dumb Ways to Die: could not start the relay — ${String(error)}`,
        );
      }
    }),

    /**
     * One command for the whole browser setup (spec §0X).
     *
     * It does every step that software is allowed to do: starts the relay,
     * copies the credentials, and opens the folder to install from. The
     * browser's own "Load unpacked" is a security boundary no outside app can
     * cross, so rather than pretending, it says which three clicks are left.
     */
    vscode.commands.registerCommand("dumbways.useClipboard", async () => {
      await useClipboardRoute();
    }),

    vscode.commands.registerCommand("dumbways.setupBrowser", async () => {
      if (!fsSync.existsSync(path.join(resolveBrowserDist(), "manifest.json"))) {
        void vscode.window.showErrorMessage(
          `Dumb Ways to Die: the browser extension is not built. Expected it at ${resolveBrowserDist()}.`,
        );
        return;
      }

      // A path the browser can keep: this one survives every future update.
      const distPath = await publishBrowserDist(log);

      // Switching first: the browser is useless if the editor is still talking
      // to the in-process mock, and this used to hang off a dialog the user
      // could dismiss.
      try {
        await launcher.ensureRunning();
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Dumb Ways to Die: could not start the relay — ${String(error)}`,
        );
        return;
      }

      await vscode.workspace
        .getConfiguration("dumbways")
        .update("provider.mode", "relay", settingsTarget());
      state.setProviderName("Relay (separate process)");
      const relayProvider = buildRelayProvider();
      await controller.swapProvider(relayProvider);

      /*
       * Retire the test double.
       *
       * `Start relay + provider` leaves a mock process attached, and a user who
       * then paired a real chat still got "MOCK: I received your message" —
       * two things were answering and the wrong one won. The relay now prefers
       * a browser, but leaving the mock running is still a second responder
       * nobody asked for.
       */
      if (providerLauncher.stop()) {
        log.appendLine("[provider] stopped the mock process: a real chat is answering now");
      }

      /*
       * One window, opened here, closed in five minutes.
       *
       * The add-on asks the relay for its own connection details while this is
       * open, so nothing is copied and nothing is pasted. Setup used to be two
       * clipboards and eight steps, and the paste was the step people got
       * wrong.
       */
      const PAIRING_MS = 5 * 60_000;
      relayProvider.openPairing(PAIRING_MS);

      const alreadyInstalled = context.globalState.get<boolean>("browserInstalled") === true;

      if (!alreadyInstalled) {
        await vscode.env.clipboard.writeText(distPath);
        await vscode.env.openExternal(vscode.Uri.file(distPath));

        const done = await vscode.window.showInformationMessage(
          "Install the browser add-on",
          {
            modal: true,
            detail: [
              "The folder is open and its path is on your clipboard.",
              "",
              "In Comet, Chrome, or Edge:",
              "   1. Go to chrome://extensions",
              "   2. Turn on Developer mode",
              "   3. Click Load unpacked",
              "   4. Press Cmd+Shift+G, paste, and press Open",
              "",
              "Browsers do not let an outside app install an add-on, so these",
              "are the only steps no program can do for you. You will not need",
              "to do them again.",
            ].join("\n"),
          },
          "Installed it",
        );

        if (done) {
          await context.globalState.update("browserInstalled", true);
        }
      }

      void vscode.window.showInformationMessage(
        "Looking for your browser… open a chat tab and it will connect itself.",
      );
    }),

    /**
     * Picks which chat answers, and opens it if it is not there.
     *
     * The router is only worth having if choosing a model costs one click, so
     * this does not ask the user to go and arrange browser tabs — the add-on
     * opens the site on a fresh conversation and pairs it.
     */
    vscode.commands.registerCommand("dumbways.pickModel", async (model?: string) => {
      const pickSequence = ++latestModelPick;
      /*
       * One list, in the protocol, which the panel's picker also renders from.
       * A second copy here is how a provider ends up offered in one place and
       * missing from the other — which had already happened to Z.ai.
       */
      const known = CHAT_PROVIDERS;

      const paired = new Set(
        state
          .getSurfaces()
          .filter((surface) => surface.status === "ready")
          .map((surface) => surface.id),
      );

      const chosen =
        model ??
        (
          await vscode.window.showQuickPick(
            known.map((entry) => ({
              label: entry.label,
              description: paired.has(entry.id) ? "connected" : "will open a tab",
              id: entry.id,
            })),
            { title: "Which chat should answer?", placeHolder: "Pick a model" },
          )
        )?.id;

      if (!chosen) {
        return;
      }

      const provider = controller.currentProvider();
      if (provider instanceof RelayCoachProvider) {
        /*
         * Where it opens is asked once per provider, before the tab exists.
         *
         * Their ChatGPT is a place they already keep things — a history they
         * scroll, a memory that has learned about them. Opening coding
         * sessions into it by default is a cost paid where the editor cannot
         * see it, so the destination is theirs to pick.
         */
        const label = known.find((entry) => entry.id === chosen)?.label ?? chosen;
        const home = await chatHomes.resolve(chosen, label);

        /*
         * Dismissing the question leaves the previous chat selected.
         *
         * Setting the model first and then returning here — which is what this
         * did — selected a chat that was never opened, so every message
         * afterwards failed with "not connected" and the only clue was a
         * dialog the user had closed. A choice that was not completed must not
         * change what is selected.
         */
        if (!home) {
          log.appendLine(`[router] ${chosen} not opened: no destination chosen`);
          void vscode.window.showInformationMessage(
            `${label} was not opened, so the chat you had stays selected.`,
          );
          return;
        }

        /*
         * "Claude, on Opus" is one intention, so it travels as one operation.
         * The variant is remembered per provider, the way the destination is —
         * nobody wants to retype which model they prefer every time.
         */
        const variant = context.globalState.get<Record<string, string>>("chatVariants")?.[chosen];
        const result = await provider.openSurface(chosen, home.url, variant);

        if (pickSequence !== latestModelPick) {
          log.appendLine(`[router] ignored late pairing result for ${chosen}`);
          return;
        }

        if (result.status === "blocked") {
          log.appendLine(
            `[router] ${chosen} pairing ${result.status}: ${result.detail ?? "no detail"}`,
          );
          const fallback = "Use clipboard here";
          const action = await vscode.window.showWarningMessage(
            `${label} is open, but this browser will not let the unpacked add-on control it. ` +
              `The clipboard route keeps you in this browser and preserves the tool loop.`,
            fallback,
          );
          if (action === fallback) {
            await useClipboardRoute(
              `Clipboard route ready for ${label}. Send your question here, paste the copied ` +
                `prompt into ${label}, then copy its reply and press Bring reply back.`,
            );
          }
          return;
        }

        if (result.status !== "ready") {
          log.appendLine(
            `[router] ${chosen} pairing ${result.status}: ${result.detail ?? "no detail"}`,
          );
          void vscode.window.showWarningMessage(
            `${label} was not selected. ${result.detail ?? "Its browser tab could not be paired."}`,
          );
          return;
        }

        // This is the sole selection authority: a terminal browser
        // acknowledgement for the most recent user pick.
        state.setModel(chosen);
        log.appendLine(`[router] asked the browser for ${chosen} (${home.kind})`);
      } else {
        state.setModel(chosen);
        void vscode.window.showInformationMessage(
          "Choosing a chat needs the browser route. Press Connect a browser chat.",
        );
      }
    }),

    vscode.commands.registerCommand("dumbways.chatModel", async () => {
      /*
       * Which model *inside* the chat — "claude" names the window, "opus" names
       * what answers in it.
       *
       * Typed rather than listed, because the list only exists inside the
       * chat's own menu and changes without notice. The browser matches what
       * you type against the real options and refuses when two of them fit
       * equally well, so a wrong guess never quietly becomes a wrong model.
       */
      const stored = context.globalState.get<Record<string, string>>("chatVariants") ?? {};

      const provider = await vscode.window.showQuickPick(
        CHAT_PROVIDERS.map((entry) => ({
          label: entry.label,
          description: stored[entry.id] ? `on ${stored[entry.id]}` : "whatever it opens with",
          id: entry.id,
        })),
        { title: "Set the model inside which chat?", placeHolder: "Pick a provider" },
      );

      if (!provider) {
        return;
      }

      /*
       * The list comes from the chat's own menu, not from a table here.
       *
       * Asking someone to type a model name while the browser is sitting on the
       * page with the menu open to read is making a person do the machine's
       * job — and it fails on exactly the models nobody remembers the spelling
       * of. Typing stays as the fallback for a chat whose menu we cannot find.
       */
      const active = controller.currentProvider();

      if (!(active instanceof RelayCoachProvider)) {
        void vscode.window.showInformationMessage(
          "Choosing a model needs the browser route. Press Connect a browser chat.",
        );
        return;
      }

      const home = chatHomes.get(provider.id);

      /*
       * Open the chat before reading its menu.
       *
       * The menu only exists on the page, so a chat that is not open has no
       * list to read — and refusing at that point produced an empty picker and
       * a fallback text box, which is indistinguishable from "this feature does
       * not work". Picking a model for a chat is a perfectly clear instruction
       * to go and open that chat.
       */
      const opened = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Opening ${provider.label}…`,
        },
        () => active.openSurface(provider.id, home?.url),
      );

      if (opened.status !== "ready") {
        void vscode.window.showWarningMessage(
          opened.detail ?? `Could not open ${provider.label}, so its models cannot be listed.`,
        );
        return;
      }

      const found = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Reading ${provider.label}'s model menu…`,
        },
        () => active.listModels(provider.id),
      );

      let typed: string | undefined;

      if (found.models.length > 0) {
        const current = stored[provider.id];
        const picked = await vscode.window.showQuickPick(
          [
            ...found.models.map((name) => ({
              label: name,
              description: current && name.toLowerCase() === current.toLowerCase() ? "current" : "",
            })),
            { label: "$(circle-slash) Whatever it opens with", description: "clear the preference" },
          ],
          { title: `Which model should ${provider.label} use?`, placeHolder: "Read from its own menu" },
        );

        if (!picked) {
          return;
        }
        typed = picked.label.startsWith("$(circle-slash)") ? "" : picked.label;
      } else {
        // No menu found — say why, and let them name it themselves.
        typed = await vscode.window.showInputBox({
          title: `Which model should ${provider.label} use?`,
          prompt: `${found.detail ?? "Could not read its menu."} Type the name as it appears there.`,
          value: stored[provider.id] ?? "",
          ignoreFocusOut: true,
        });
      }

      if (typed === undefined) {
        return;
      }

      const next = { ...stored };
      if (typed.trim().length === 0) {
        delete next[provider.id];
      } else {
        next[provider.id] = typed.trim();
      }
      await context.globalState.update("chatVariants", next);

      if (typed.trim().length === 0) {
        void vscode.window.showInformationMessage(
          `${provider.label} will use whatever model it opens with.`,
        );
        return;
      }

      /*
       * Applied now, not merely remembered.
       *
       * Storing a preference and waiting for the user to re-pick the chat makes
       * "set the model" a two-step instruction, and the second step is the one
       * people forget — leaving them looking at a chat that is still on the old
       * model, wondering whether the setting did anything.
       *
       * If that chat is not open, the preference is kept and applied the moment
       * it is, which is the only sensible thing left to do.
       */
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Switching ${provider.label} to ${typed.trim()}…` },
        () => active.openSurface(provider.id, home?.url, typed.trim()),
      );

      if (result.status === "ready" && !result.detail) {
        void vscode.window.showInformationMessage(`${provider.label} is now on "${typed.trim()}".`);
        return;
      }

      // A chat that connected but would not switch is still usable, and saying
      // which of the two happened is the whole difference between the messages.
      void vscode.window.showWarningMessage(
        result.detail ?? `Could not switch ${provider.label} to "${typed.trim()}".`,
      );
    }),

    vscode.commands.registerCommand("dumbways.chatHome", async () => {
      /*
       * Changing the answer, which matters as much as asking it.
       *
       * A setting asked once and then unreachable is a setting the user has to
       * live with a mistake in. Forgetting the stored choice makes the next
       * open ask again, which is the same question in the same words.
       */
      const picked = await vscode.window.showQuickPick(
        CHAT_PROVIDERS.map((entry) => {
          const current = chatHomes.get(entry.id);
          return {
            label: entry.label,
            description: current ? describeHome(current) : "not set — will ask",
            id: entry.id,
          };
        }),
        { title: "Where should coding chats live?", placeHolder: "Pick a provider" },
      );

      if (!picked) {
        return;
      }

      await chatHomes.forget(picked.id);
      const chosen = await chatHomes.resolve(picked.id, picked.label);
      if (chosen) {
        void vscode.window.showInformationMessage(
          `${picked.label}: coding chats will open ${describeHome(chosen)}.`,
        );
      }
    }),

    vscode.commands.registerCommand("dumbways.copyPrimer", async () => {
      await clipboardProvider.copyPrimer();
      void vscode.window.showInformationMessage(
        "Copied. Paste this into your chat if it has lost track of the rules.",
      );
    }),

    // The user brings the reply back. Reading the clipboard rather than
    // offering a textarea means the chat's own "copy" button is the whole
    // interaction on their side.
    vscode.commands.registerCommand("dumbways.pasteReply", async () => {
      const text = await vscode.env.clipboard.readText();
      const { blocks, problems } = await clipboardProvider.receiveReply(text);

      if (problems.length > 0 && blocks === 0) {
        void vscode.window.showWarningMessage(
          `Dumb Ways to Die: ${problems[0]?.reason ?? "could not read that reply"}.`,
        );
      }
    }),

    vscode.commands.registerCommand("dumbways.copyAgain", async () => {
      // Whatever was last put on the clipboard is regenerated rather than
      // remembered, so it always matches the current state.
      const awaiting = state.getAwaitingPaste();
      if (awaiting === "primer") {
        await clipboardProvider.copyPrimer();
      } else {
        void vscode.window.showInformationMessage(
          "Dumb Ways to Die: send the message again to re-copy it.",
        );
      }
    }),

    vscode.commands.registerCommand("dumbways.attachFile", async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: "Attach",
        filters: { Supported: supportedExtensions().map((extension) => extension.slice(1)) },
      });
      if (!picked || picked.length === 0) {
        return;
      }

      for (const uri of picked) {
        try {
          state.addAttachment(await media.register(uri.fsPath, "filesystem"));
        } catch (error) {
          // A refused attachment is told to the user plainly: an unsupported
          // type or an oversized file is their decision to make, not a silent
          // omission from the next request.
          const message = error instanceof Error ? error.message : String(error);
          log.appendLine(`[media] refused ${uri.fsPath}: ${message}`);
          void vscode.window.showErrorMessage(`Dumb Ways to Die: ${message}`);
        }
      }
    }),

    vscode.commands.registerCommand("dumbways.cleanCache", async () => {
      const removed = await media.cleanup(30);
      void vscode.window.showInformationMessage(
        removed === 0
          ? "Dumb Ways to Die: no media older than 30 days."
          : `Dumb Ways to Die: removed ${removed} media file(s) older than 30 days.`,
      );
    }),

    vscode.commands.registerCommand("dumbways.forgetApprovals", async () => {
      const count = await permissions.forgetAll();
      void vscode.window.showInformationMessage(
        count === 0
          ? "Dumb Ways to Die: there were no remembered approvals."
          : `Dumb Ways to Die: forgot ${count} remembered approval${count === 1 ? "" : "s"}.`,
      );
    }),

    vscode.commands.registerCommand("dumbways.showCurrentContext", () => {
      // Rendered into the output channel rather than a new editor tab: opening
      // a document would change the active editor, i.e. change the very thing
      // being previewed.
      const { request } = contextEngine.buildRequest({
        sessionId: sessions.current.id,
        message: "(preview — this context was not sent anywhere)",
      });
      log.appendLine("");
      log.appendLine(`===== CONTEXT PREVIEW ${new Date().toISOString()} =====`);
      log.appendLine(requestToMarkdown(request));
      log.show(true);
    }),
  );

  // Connection lifecycle last, so the UI already exists to show its states.
  void controller.start();

  /*
   * First run: open the panel, not a second surface.
   *
   * This used to open the walkthrough, which appears as its own editor tab
   * beside your code and repeats what the panel already says — two places
   * describing one setup, and the one you have to act in is the one that was
   * not on screen. Revealing the panel puts the instructions and the buttons
   * that satisfy them in the same view.
   */
  if (!context.globalState.get<boolean>("dumbways.introShown")) {
    void context.globalState.update("dumbways.introShown", true);
    void vscode.commands.executeCommand("dumbways.coach.focus");
  }

  disposeBridge = () => {
    // The relay is deliberately left running; the provider process this window
    // started is not, because nothing else would ever clean it up.
    providerLauncher.stop();
    controller.dispose();
    view.dispose();
    editorAdapter.dispose();
    sessions.dispose();
    state.dispose();
  };
}

export function deactivate(): void {
  // context.subscriptions already covers these; doing it explicitly keeps the
  // teardown path obvious for when sockets and child processes exist.
  disposeBridge?.();
  disposeBridge = undefined;
}

function readBudget(): ContextBudget {
  const config = vscode.workspace.getConfiguration("dumbways");
  return {
    maxCharacters: config.get<number>("context.maxCharacters", DEFAULT_CONTEXT_BUDGET.maxCharacters),
    maxFileCharacters: config.get<number>(
      "context.maxFileCharacters",
      DEFAULT_CONTEXT_BUDGET.maxFileCharacters,
    ),
    maxDiagnosticItems: DEFAULT_CONTEXT_BUDGET.maxDiagnosticItems,
    maxTreeEntries: DEFAULT_CONTEXT_BUDGET.maxTreeEntries,
  };
}

function readLearningMode(): LearningMode {
  const mode = vscode.workspace.getConfiguration("dumbways").get<string>("permissions.mode");
  return mode === "guided" || mode === "normal-agent" ? mode : "strict-coach";
}

/**
 * Writing to Workspace settings throws in a window with no folder open, which
 * is how "Start relay + provider" failed with an error about settings rather
 * than anything to do with the relay.
 */
function settingsTarget(): vscode.ConfigurationTarget {
  return configScope(hasWorkspaceFolder()) === "workspace"
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

function hasWorkspaceFolder(): boolean {
  return (vscode.workspace.workspaceFolders ?? []).length > 0;
}

function readProviderMode(): "in-process" | "relay" | "clipboard" {
  const mode = vscode.workspace.getConfiguration("dumbways").get<string>("provider.mode");
  return mode === "relay" || mode === "clipboard" ? mode : "in-process";
}

function readRelayPort(): number {
  const port = vscode.workspace.getConfiguration("dumbways").get<number>("relay.port");
  return typeof port === "number" && port > 0 ? port : DEFAULT_RELAY_PORT;
}

/**
 * The relay ships beside the extension in this repo. Resolution is attempted
 * through Node first so a packaged layout keeps working, with the workspace
 * layout as the fallback.
 */
/** Waits for the relay to report a provider on the far side. */
function waitForProvider(state: ExtensionState, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (state.getConnections().provider === "ready") {
        clearInterval(poll);
        resolve(true);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(poll);
        resolve(false);
      }
    }, 150);
  });
}

/** The built browser extension, shipped beside this one. */
/**
 * A short id that changes whenever the file does.
 *
 * The relay's own modification time is the cheapest honest answer to "is the
 * running relay the code I just built" — no build step has to cooperate, and
 * it cannot go stale by being forgotten.
 */
function buildIdOf(entry: string, fallback: string): string {
  try {
    return `${fallback}-${Math.floor(fsSync.statSync(entry).mtimeMs)}`;
  } catch {
    return fallback;
  }
}

/** The build id written beside the add-on bundle, when there is one. */
function readShippedAddonBuild(): string | undefined {
  try {
    return fsSync.readFileSync(path.join(resolveBrowserDist(), "build.txt"), "utf8").trim();
  } catch {
    // A packaged build without the file is not an error, just unknowable.
    return undefined;
  }
}

function resolveBrowserDist(): string {
  return firstExisting([
    // Packaged: shipped inside this extension.
    path.join(__dirname, "browser-extension"),
    // Development: the sibling workspace package.
    path.join(__dirname, "..", "..", "browser-adapter", "dist"),
  ]);
}

/**
 * A home for the add-on that does not move when this extension updates.
 *
 * Chrome remembers an unpacked add-on by absolute path, and the extension's
 * own directory is named after its version — `…/local.dumbways-to-die-0.1.0/`.
 * So the first version bump would point Chrome at a directory that no longer
 * exists, and the only cure is removing and re-adding the add-on by hand.
 *
 * Copying it somewhere stable costs a few kilobytes and means the path the
 * user gave Chrome is correct forever. It doubles as the update mechanism:
 * refreshing these files is all a new build needs, and Chrome picks them up
 * on its own reload.
 */
function stableBrowserDist(): string {
  return path.join(os.homedir(), ".dumbways", "browser-extension");
}

async function publishBrowserDist(log: vscode.OutputChannel): Promise<string> {
  const source = resolveBrowserDist();
  const target = stableBrowserDist();

  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rm(target, { recursive: true, force: true });
    await fs.cp(source, target, { recursive: true });

    /*
     * Say what landed, and check it actually did.
     *
     * This copy is the only one Chrome ever loads, and a silent failure here
     * looks exactly like a fix that does not work: the repo has the new code,
     * every build succeeds, and the browser keeps running something older. It
     * hid for three rounds once. One line of log and one comparison is the
     * whole cost of never spending that again.
     */
    const landed = await fs
      .readFile(path.join(target, "build.txt"), "utf8")
      .then((text) => text.trim())
      .catch(() => undefined);
    const expected = readShippedAddonBuild();

    if (expected && landed !== expected) {
      log.appendLine(
        `[browser] published to ${target} but it reports ${landed ?? "no build"}, ` +
          `expected ${expected} — Chrome will keep running the old add-on`,
      );
    } else {
      log.appendLine(`[browser] add-on published to ${target} (${landed ?? "unstamped"})`);
    }

    return target;
  } catch (error) {
    // Falling back to the versioned path still works today; it just breaks on
    // the next version bump. Better than refusing to set up at all.
    log.appendLine(`[browser] could not publish to ${target}: ${String(error)}`);
    return source;
  }
}

/**
 * The same file has two homes: bundled beside this one in an installed copy,
 * or in a sibling workspace package when running from source. Checking rather
 * than assuming means F5 and a real install both work.
 */
function firstExisting(candidates: string[]): string {
  return candidates.find((candidate) => fsSync.existsSync(candidate)) ?? candidates[0] ?? "";
}

function resolveProviderEntry(): string {
  return firstExisting([
    path.join(__dirname, "mock-provider.js"),
    path.join(__dirname, "..", "..", "mock-provider", "dist", "standalone.js"),
  ]);
}

function resolveRelayEntry(): string {
  return firstExisting([
    path.join(__dirname, "relay-server.js"),
    path.join(__dirname, "..", "..", "relay", "dist", "server.js"),
  ]);
}

/** Spec §42: project-local state lives in `.coach/`, never in the user home. */
function resolveMediaDir(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root ? path.join(root, ".coach", "media") : path.join(os.tmpdir(), "dumbways-media");
}

function readMaxMediaBytes(): number {
  const megabytes = vscode.workspace.getConfiguration("dumbways").get<number>("media.maxSizeMb");
  return typeof megabytes === "number" && megabytes > 0
    ? megabytes * 1024 * 1024
    : DEFAULT_MAX_MEDIA_BYTES;
}

function readEnvAllowlist(): string[] {
  const configured = vscode.workspace
    .getConfiguration("dumbways")
    .get<string[]>("shell.envAllowlist");

  return Array.isArray(configured) && configured.length > 0
    ? configured.filter((entry) => typeof entry === "string")
    : DEFAULT_ENV_ALLOWLIST;
}

function readIgnoredDirectories(): string[] {
  const configured = vscode.workspace
    .getConfiguration("dumbways")
    .get<string[]>("workspace.ignoreDirectories");

  return Array.isArray(configured) && configured.length > 0
    ? configured.filter((entry) => typeof entry === "string")
    : DEFAULT_IGNORED_DIRECTORIES;
}

function readWorkspaceRoots(): WorkspaceRootRef[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
    name: folder.name,
    path: folder.uri.fsPath,
  }));
}
