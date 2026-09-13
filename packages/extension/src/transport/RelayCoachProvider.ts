import {
  buildChatPrimer,
  createId,
  type AvailableSurface,
  type ToolDescriptor,
  type CoachProvider,
  type CoachRequest,
  type CoachSession,
  type Disposable,
  type HopState,
  type ProviderInboundMessage,
  type ToolCallResult,
  type WireMessage,
} from "@dumbways/protocol";
import { RelayConnection } from "@dumbways/relay";

import type { RelayLauncher } from "./RelayLauncher";

/**
 * A provider that lives on the other side of the relay (spec §53 Phase 6).
 *
 * It implements exactly the same interface as the in-process mock. The
 * controller, context engine, tool registry and UI cannot tell which one they
 * are talking to — which is the property the whole layering exists to buy.
 *
 * No `vscode` import: this is transport, and transport should be testable
 * against a real relay without an extension host.
 */

export interface RelayCoachProviderOptions {
  launcher: RelayLauncher;
  log: (message: string) => void;
  /** Reports the relay hop so the panel can stop saying "not built yet". */
  onRelayState: (state: HopState, detail?: string) => void;
  /** Whether a provider process is attached on the far side. */
  onProviderPresence: (present: boolean) => void;
  /** Whether a browser add-on is attached, as distinct from any provider. */
  onBrowserPresence?: (present: boolean) => void;
  /** What that browser is paired to, when it says. */
  onSurfaceStatus?: (paired: boolean, surfaceType?: string, detail?: string) => void;
  /** The build the connected add-on is running, so a stale one can be named. */
  onAddonBuild?: (build: string | undefined) => void;
  /** The chats available to answer — the router's model list. */
  onSurfaces?: (surfaces: AvailableSurface[]) => void;
  /**
   * Renders a request into the text a chat actually reads.
   *
   * Required for the same reason the clipboard transport needs it: on the far
   * side of this relay may be a plain chat window with no idea what a
   * `CoachRequest` is. The structured request still travels for anything that
   * can use it, but `message` has to carry the whole story on its own.
   */
  renderRequest?: (request: CoachRequest) => string;
  /** The tools to describe in the primer. */
  listTools?: () => ToolDescriptor[];
}

export interface SurfaceOpenResult {
  status: "ready" | "blocked" | "failed";
  detail?: string;
}

interface PendingSurfaceOpen {
  model: string;
  resolve: (result: SurfaceOpenResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const SURFACE_OPEN_TIMEOUT_MS = 35_000;

/**
 * Reading a menu is opening it and looking, so it is quick — but it happens in
 * a service worker Chrome may have just woken, so it is not instant either.
 */
const MODEL_LIST_TIMEOUT_MS = 15_000;

export class RelayCoachProvider implements CoachProvider {
  readonly id = "relay";
  readonly displayName = "Relay (separate process)";

  private connection: RelayConnection | undefined;
  private readonly listeners = new Set<(message: ProviderInboundMessage) => void>();
  private sessionId = "relay";

  /** Model-list queries waiting on the browser to read a menu. */
  private readonly pendingModelLists = new Map<
    string,
    { resolve: (value: { models: string[]; detail?: string }) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private primerSent = false;
  private readonly pendingSurfaceOpens = new Map<string, PendingSurfaceOpen>();

  constructor(private readonly options: RelayCoachProviderOptions) {}

  async connect(session: CoachSession): Promise<void> {
    // A new session is a new conversation on the far side, which has not been
    // told the rules yet however many times an earlier one was.
    this.primerSent = false;
    this.sessionId = session.id;

    this.options.onRelayState("connecting");
    const endpoint = await this.options.launcher.ensureRunning();
    this.options.log(
      `[relay] ${endpoint.spawned ? "started" : "attached to"} relay on ${endpoint.host}:${endpoint.port}`,
    );

    if (this.connection) {
      this.connection.close();
    }

    this.connection = new RelayConnection({
      host: endpoint.host,
      port: endpoint.port,
      token: endpoint.token,
      adapterKind: "editor",
      adapterId: createId("editor"),
      capabilities: [
        "editor.active_document",
        "editor.diagnostics",
        "workspace.read_file",
        "workspace.search",
      ],
      log: this.options.log,
      onStateChange: (state, detail) => {
        this.options.onRelayState(toHopState(state), detail);
        if (state !== "connected") {
          // The far side is unreachable while we are, so stop claiming it is
          // there (spec §0I).
          this.options.onProviderPresence(false);
        }
      },
      onMessage: (message) => this.handle(message),
    });

    await this.connection.connect();

    // Publish what this editor can do, so an agent attaching later — an MCP
    // client, say — can list tools without waiting for a request to happen.
    const tools = this.options.listTools?.() ?? [];
    if (tools.length > 0) {
      this.connection.send(this.sessionId, { type: "tools.available", tools });
    }
  }

  /**
   * Opens the relay's pairing window so the add-on can fetch its own details.
   *
   * Returns false when there is no relay connection to ask, which is the
   * caller's cue to start one first rather than to show a hopeful message.
   */
  openPairing(durationMs: number): boolean {
    if (!this.connection) {
      return false;
    }
    this.connection.send(this.sessionId, { type: "pair.open", durationMs });
    return true;
  }

  /**
   * Asks the browser to open a chat and start a fresh conversation in it.
   *
   * @param url where the user said this provider's coding chats should live.
   * Omitted means their ordinary history, which is a choice they made rather
   * than a default they were given.
   */
  /**
   * Asks the browser what models the named chat offers.
   *
   * Times out into an empty list rather than hanging: a picker with nothing in
   * it and a reason is usable, a picker that never opens is not.
   */
  async listModels(model: string): Promise<{ models: string[]; detail?: string }> {
    if (!this.connection) {
      return { models: [], detail: "The local relay is not connected." };
    }

    const requestId = createId("surface_models");
    const answer = new Promise<{ models: string[]; detail?: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingModelLists.delete(requestId);
        resolve({ models: [], detail: "The browser did not answer in time." });
      }, MODEL_LIST_TIMEOUT_MS);
      this.pendingModelLists.set(requestId, { resolve, timer });
    });

    this.connection.send(this.sessionId, { type: "surface.models", requestId, model });
    return answer;
  }

  async openSurface(model: string, url?: string, variant?: string): Promise<SurfaceOpenResult> {
    if (!this.connection) {
      return { status: "failed", detail: "The local relay is not connected." };
    }

    const requestId = createId("surface_open");
    const result = new Promise<SurfaceOpenResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSurfaceOpens.delete(requestId);
        resolve({
          status: "failed",
          detail:
            "The browser did not finish pairing this chat. Reload the add-on and try again.",
        });
      }, SURFACE_OPEN_TIMEOUT_MS);

      this.pendingSurfaceOpens.set(requestId, { model, resolve, timer });
    });

    try {
      this.connection.send(this.sessionId, {
        type: "surface.open",
        requestId,
        model,
        ...(url ? { url } : {}),
        ...(variant ? { variant } : {}),
      });
    } catch (error) {
      /*
       * A connection object can outlive its socket: for example, a newer
       * editor replaces this one while a picker is still open. Sending then
       * throws synchronously. Turn that into the same terminal result as every
       * other pairing failure and clear the timer we registered above.
       */
      this.finishSurfaceOpen(requestId, {
        status: "failed",
        detail: `The local relay is not connected: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
    return result;
  }

  async sendRequest(request: CoachRequest): Promise<void> {
    const connection = this.requireConnection();

    // Register before the request goes out, so the id is resolvable by the
    // time the provider reads about it (spec §0M).
    for (const media of request.attachments) {
      connection.send(request.sessionId, { type: "media.register", media });
    }

    /*
     * The message is rendered here, not in the browser.
     *
     * Previously the raw `request.message` went over the wire and the browser
     * typed exactly that into the chat — so the chat received "why does this
     * reload?" with no file, no selection, no errors, and no explanation of
     * the protocol. It answered the only way it could: by asking the user to
     * paste their code in. Everything the editor had gathered stopped here.
     *
     * The structured request still travels intact, and `message` still holds
     * the user's own words — the rendered version rides alongside in
     * `rendered`, so a transport that understands nothing can deliver
     * something useful without lying to everything that does.
     */
    connection.send(request.sessionId, {
      type: "coach.request",
      request: { ...request, rendered: this.renderFor(request) },
    });
  }

  private renderFor(request: CoachRequest): string {
    const render = this.options.renderRequest;
    if (!render) {
      return request.message;
    }

    const body = render(request);
    const tools = this.options.listTools?.() ?? [];

    // The primer goes with the first message rather than as a separate one:
    // a chat that is told the rules and asked a question together cannot
    // answer the question before it has read the rules.
    if (this.primerSent || tools.length === 0) {
      return body;
    }
    this.primerSent = true;
    return `${buildChatPrimer(tools)}\n\n---\n\n${body}`;
  }

  async sendToolResult(result: ToolCallResult): Promise<void> {
    this.requireConnection().send(result.sessionId, result);
  }

  onMessage(callback: (message: ProviderInboundMessage) => void): Disposable {
    this.listeners.add(callback);
    return { dispose: () => this.listeners.delete(callback) };
  }

  async disconnect(): Promise<void> {
    this.finishAllSurfaceOpens({
      status: "failed",
      detail: "The relay disconnected before the chat was paired.",
    });
    this.connection?.close();
    this.connection = undefined;
    this.listeners.clear();
    this.options.onRelayState("disconnected");
    this.options.onProviderPresence(false);
  }

  private requireConnection(): RelayConnection {
    if (!this.connection) {
      throw new Error("Not connected to the relay.");
    }
    return this.connection;
  }

  /**
   * Wire messages and provider messages are the same shapes by design
   * (spec §22), so this is routing rather than translation.
   */
  private handle(message: WireMessage): void {
    switch (message.type) {
      case "adapter.registry":
        this.options.onProviderPresence(message.provider);
        // Older relays do not send `browser`; treat a missing field as "no",
        // never as "unknown", so the hop cannot sit on a stale claim.
        this.options.onBrowserPresence?.(message.browser === true);
        if (!message.provider) {
          this.options.log("[relay] no provider process is attached");
        }
        return;

      case "surface.status":
        this.options.onSurfaceStatus?.(message.paired, message.surfaceType, message.detail);
        this.options.onSurfaces?.(message.surfaces ?? []);
        this.options.onAddonBuild?.(message.build);
        // Status is replayed after a reconnect.  It is therefore also the
        // recovery acknowledgement when `surface.opened` was sent while the
        // socket was down.
        for (const surface of message.surfaces ?? []) {
          if (surface.status === "ready" || surface.status === "blocked") {
            this.finishSurfaceOpen(surface.id, {
              status: surface.status,
              ...(surface.detail ? { detail: surface.detail } : {}),
            });
          }
        }
        return;

      case "surface.models.list": {
        const waiting = this.pendingModelLists.get(message.requestId);
        if (waiting) {
          this.pendingModelLists.delete(message.requestId);
          clearTimeout(waiting.timer);
          waiting.resolve({
            models: message.models,
            ...(message.detail ? { detail: message.detail } : {}),
          });
        }
        return;
      }

      case "surface.opened":
        this.finishSurfaceOpen(message.requestId, {
          status: message.status,
          ...(message.detail ? { detail: message.detail } : {}),
        });
        return;

      case "coach.response":
      case "tool.call":
      case "provider.status":
      case "provider.error":
        this.emit(message as ProviderInboundMessage);
        return;

      default:
        return;
    }
  }

  private emit(message: ProviderInboundMessage): void {
    for (const listener of this.listeners) {
      listener(message);
    }
  }

  /** Accepts either an operation id or a model id (status replay path). */
  private finishSurfaceOpen(idOrModel: string, result: SurfaceOpenResult): void {
    const direct = this.pendingSurfaceOpens.get(idOrModel);
    const entries = direct
      ? ([[idOrModel, direct]] as Array<[string, PendingSurfaceOpen]>)
      : [...this.pendingSurfaceOpens.entries()].filter(([, pending]) => pending.model === idOrModel);

    for (const [requestId, pending] of entries) {
      clearTimeout(pending.timer);
      this.pendingSurfaceOpens.delete(requestId);
      pending.resolve(result);
    }
  }

  private finishAllSurfaceOpens(result: SurfaceOpenResult): void {
    for (const [requestId, pending] of this.pendingSurfaceOpens) {
      clearTimeout(pending.timer);
      this.pendingSurfaceOpens.delete(requestId);
      pending.resolve(result);
    }
  }
}

function toHopState(state: string): HopState {
  switch (state) {
    case "connected":
      return "connected";
    case "connecting":
    case "reconnecting":
      return "connecting";
    case "error":
      return "error";
    default:
      return "disconnected";
  }
}
