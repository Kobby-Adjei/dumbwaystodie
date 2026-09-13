import { WebSocketServer, type WebSocket } from "ws";

import {
  createEnvelope,
  createId,
  HANDSHAKE_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  parseAdapterHello,
  parseEnvelope,
  parseWireMessage,
  PROTOCOL_VERSION,
  type AdapterKind,
  type AttachmentRef,
  type WireMessage,
} from "@dumbways/protocol";

import { deriveGrant, tokensMatch } from "./auth";

/**
 * The relay is a router, not the teacher (spec §0T).
 *
 * Everything in this file is routing, authentication, correlation and
 * connection state. If a coaching decision ever appears here, it is in the
 * wrong layer.
 */

export interface HubOptions {
  token: string;
  log: (event: string, detail?: Record<string, unknown>) => void;
  heartbeatIntervalMs?: number;
  heartbeatStaleMs?: number;
  handshakeTimeoutMs?: number;
}

interface Connection {
  id: string;
  socket: WebSocket;
  kind?: AdapterKind;
  adapterId?: string;
  authenticated: boolean;
  lastSeenAt: number;
  handshakeTimer?: NodeJS.Timeout;
}

/** Spec §0U. One editor, one provider, and the requests in flight between. */
interface PendingRequest {
  requestId: string;
  sessionId: string;
  startedAt: number;
}

export class RelayHub {
  private readonly connections = new Map<string, Connection>();
  private readonly pending = new Map<string, PendingRequest>();
  /** id -> media the editor registered. Only these ids ever resolve (spec §9). */
  private readonly media = new Map<string, AttachmentRef>();
  private heartbeat: NodeJS.Timeout | undefined;

  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatStaleMs: number;
  private readonly handshakeTimeoutMs: number;

  constructor(private readonly options: HubOptions) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.heartbeatStaleMs = options.heartbeatStaleMs ?? HEARTBEAT_STALE_MS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  }

  attach(server: WebSocketServer): void {
    server.on("connection", (socket, request) => {
      // Loopback only. The listener is already bound to 127.0.0.1; this refuses
      // anything that somehow arrives from elsewhere rather than trusting the
      // bind alone.
      const remote = request.socket.remoteAddress ?? "";
      if (!isLoopback(remote)) {
        this.options.log("connection.rejected", { reason: "non-loopback", remote });
        socket.close(1008, "loopback only");
        return;
      }
      this.accept(socket);
    });

    this.heartbeat = setInterval(() => this.sweep(), this.heartbeatIntervalMs);
    this.heartbeat.unref?.();
  }

  close(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    for (const connection of this.connections.values()) {
      if (connection.handshakeTimer) {
        clearTimeout(connection.handshakeTimer);
      }
      connection.socket.close(1001, "relay shutting down");
    }
    this.connections.clear();
    this.pending.clear();
  }

  /** For /health and tests. */
  snapshot(): {
    editor: boolean;
    provider: boolean;
    browser: boolean;
    connections: number;
    pending: number;
    media: number;
  } {
    return {
      editor: this.hasKind("editor"),
      provider: this.hasKind("provider") || this.hasKind("browser"),
      browser: this.hasKind("browser"),
      connections: this.connections.size,
      pending: this.pending.size,
      media: this.media.size,
    };
  }

  /**
   * Asks whatever is answering — a browser tab, a provider — one question and
   * waits for the reply.
   *
   * This is what lets an agent harness use a chat tab as its model: the HTTP
   * side hands text in and gets text back, with no idea a browser is involved.
   */
  ask(sessionId: string, message: string, timeoutMs: number): Promise<string> {
    const target = this.providerConnection();
    if (!target) {
      return Promise.reject(new Error("No chat is connected. Pair a tab in the browser add-on."));
    }

    const requestId = createId("req");

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.answers.delete(requestId);
        reject(new Error("The chat did not answer in time."));
      }, timeoutMs);
      timer.unref?.();

      this.answers.set(requestId, (text, error) => {
        clearTimeout(timer);
        this.answers.delete(requestId);
        if (error) {
          reject(new Error(error));
        } else {
          resolve(text);
        }
      });

      this.forward(target, sessionId, {
        type: "coach.request",
        request: {
          id: requestId,
          sessionId,
          createdAt: new Date().toISOString(),
          message,
          workspace: { name: "harness", roots: [] },
          contextItems: [],
          attachments: [],
          clientCapabilities: {
            readActiveDocument: false,
            readFile: false,
            searchFiles: false,
            listDirectory: false,
            projectTree: false,
            readDiagnostics: false,
            runCommand: false,
            attachments: false,
          },
          availableTools: [],
        },
      });
    });
  }

  /**
   * Whether the relay will issue a browser credential right now.
   *
   * This used to fall back to "open whenever no browser is attached", which
   * read as a reasonable convenience and was in fact a permanently open door:
   * a Manifest V3 service worker is killed after about thirty seconds idle, so
   * "no browser attached" is the *usual* state of a working setup, and the
   * endpoint was therefore always willing to hand out a credential.
   *
   * A window is now only ever opened deliberately, by the editor.
   */
  isPairingOpen(): boolean {
    return Date.now() < this.pairingOpenUntil;
  }

  /**
   * Consumes the pairing window and returns a browser credential, or nothing.
   *
   * Single-claim, and closed in the same step that mints the credential — so
   * two askers racing during one window cannot both be served. A repeated GET
   * of `/pair` is not a way to collect credentials; it is one window, one
   * browser.
   */
  claimBrowserPairing(): string | undefined {
    if (!this.isPairingOpen()) {
      return undefined;
    }

    this.pairingOpenUntil = 0;
    this.options.log("pair.claimed");
    return this.mintGrant("browser");
  }

  /** Resolves a media id to its registration, or undefined. Never a path. */
  lookupMedia(id: string): AttachmentRef | undefined {
    return this.media.get(id);
  }

  private accept(socket: WebSocket): void {
    const connection: Connection = {
      id: createId("conn"),
      socket,
      authenticated: false,
      lastSeenAt: Date.now(),
    };

    // An unauthenticated socket must not sit open indefinitely.
    connection.handshakeTimer = setTimeout(() => {
      if (!connection.authenticated) {
        this.reject(connection, "timeout", "No adapter.hello within the handshake window.");
      }
    }, this.handshakeTimeoutMs);

    this.connections.set(connection.id, connection);

    socket.on("message", (data) => this.onMessage(connection, data.toString()));
    socket.on("pong", () => {
      connection.lastSeenAt = Date.now();
    });
    socket.on("close", () => this.drop(connection, "closed"));
    socket.on("error", () => this.drop(connection, "socket-error"));
  }

  private onMessage(connection: Connection, raw: string): void {
    connection.lastSeenAt = Date.now();

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      this.options.log("message.malformed", { connectionId: connection.id });
      return;
    }

    let payload: unknown;
    try {
      payload = parseEnvelope(parsedJson).payload;
    } catch (error) {
      this.options.log("envelope.rejected", {
        connectionId: connection.id,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!connection.authenticated) {
        this.reject(connection, "bad-version", "Envelope rejected.");
      }
      return;
    }

    const message = parseWireMessage(payload);
    if (!message) {
      this.options.log("message.unknown-type", { connectionId: connection.id });
      return;
    }

    if (!connection.authenticated) {
      this.authenticate(connection, payload);
      return;
    }

    this.route(connection, message);
  }

  private authenticate(connection: Connection, payload: unknown): void {
    const parsed = parseAdapterHello(payload);
    if (!parsed.ok) {
      this.reject(connection, parsed.reason, parsed.message);
      return;
    }

    const hello = parsed.hello;

    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      // Spec §49: reject clearly, never guess.
      this.reject(
        connection,
        "bad-version",
        `Unsupported protocol version ${hello.protocolVersion}; this relay speaks ${PROTOCOL_VERSION}.`,
      );
      return;
    }

    if (!this.mayConnectAs(hello.token, hello.adapterKind)) {
      this.reject(connection, "bad-token", "Token rejected.");
      return;
    }

    // One adapter of each kind. A second editor would silently split the
    // conversation in two, which is worse than refusing it.
    // Several coding agents may be attached at once, so an MCP client never
    // displaces another. Every other kind stays exclusive: two editors would
    // mean tool calls landing in an ambiguous workspace.
    const existing = hello.adapterKind === "mcp" ? undefined : this.findByKind(hello.adapterKind);
    if (existing) {
      this.options.log("adapter.replaced", { kind: hello.adapterKind });
      existing.socket.close(1000, "replaced by a newer adapter");
      this.connections.delete(existing.id);
    }

    connection.authenticated = true;
    connection.kind = hello.adapterKind;
    connection.adapterId = hello.adapterId;
    if (connection.handshakeTimer) {
      clearTimeout(connection.handshakeTimer);
      connection.handshakeTimer = undefined;
    }

    this.options.log("adapter.welcome", {
      kind: hello.adapterKind,
      adapterId: hello.adapterId,
      capabilities: hello.capabilities.length,
    });

    this.send(connection, "relay", {
      type: "adapter.welcome",
      connectionId: connection.id,
      protocolVersion: PROTOCOL_VERSION,
      sessionTokenAccepted: true,
      peers: [...this.connections.values()]
        .filter((candidate) => candidate.authenticated && candidate.kind)
        .map((candidate) => candidate.kind as AdapterKind),
    });

    // An adapter that joins after the editor still needs to know what exists.
    if (connection.kind !== "editor" && this.toolsAvailable) {
      this.forward(connection, "relay", this.toolsAvailable);
    }

    this.broadcastRegistry();
  }

  /**
   * Routing (spec §0U). The relay never inspects the meaning of a payload —
   * only who it came from and therefore where it goes.
   */
  private route(connection: Connection, message: WireMessage): void {
    switch (message.type) {
      case "ping":
        this.send(connection, "relay", { type: "pong", sentAt: message.sentAt });
        return;

      case "pong":
        return;

      case "coach.request": {
        if (connection.kind !== "editor") {
          this.options.log("route.refused", { reason: "only the editor may send requests" });
          return;
        }
        const target = this.providerConnection();
        if (!target) {
          // Spec §0W: name the broken hop rather than dropping it silently.
          this.send(connection, message.request.sessionId, {
            type: "provider.error",
            message:
              "No provider is connected to the relay. Start the provider process and try again.",
            requestId: message.request.id,
          });
          return;
        }
        this.pending.set(message.request.id, {
          requestId: message.request.id,
          sessionId: message.request.sessionId,
          startedAt: Date.now(),
        });
        this.options.log("route.request", { requestId: message.request.id });
        this.forward(target, message.request.sessionId, message);
        return;
      }

      case "coach.response": {
        // An HTTP caller may be waiting on this one — a harness using a chat
        // tab as its model. Those requests never entered `pending`, because
        // no editor asked for them.
        /*
         * A partial reply is not the end of the turn.
         *
         * This is what stopped streaming from working. The correlation entry
         * used to be deleted on the *first* response of any kind, so partial
         * one was forwarded, and every partial after it — including the final
         * complete reply — failed the correlation check and was dropped as
         * "does not correlate". The panel showed the first few words and then
         * nothing, which looked exactly like truncation.
         */
        const partial = message.response.completion.state === "partial";

        const waiter = this.answers.get(message.response.requestId);
        if (waiter) {
          // An HTTP caller has to be handed one finished answer, so fragments
          // are skipped rather than resolving the request early.
          if (partial) {
            return;
          }
          waiter(
            message.response.content
              .map((part) => (part.type === "text" ? part.text : ""))
              .join("")
              .trim(),
          );
          return;
        }

        const target = this.editorConnection();
        if (!this.pending.has(message.response.requestId)) {
          // Spec §46: a late or unknown response is dropped, not delivered.
          this.options.log("route.dropped", {
            reason: "response does not correlate",
            requestId: message.response.requestId,
          });
          return;
        }

        // Only a terminal reply closes the correlation.
        if (!partial) {
          this.pending.delete(message.response.requestId);
        }

        if (target) {
          this.forward(target, message.response.sessionId, message);
        }
        return;
      }

      case "tool.call": {
        const target = this.editorConnection();
        if (!target) {
          this.send(connection, message.sessionId, {
            type: "tool.result",
            id: message.id,
            sessionId: message.sessionId,
            ok: false,
            error: { code: "INTERNAL", message: "The editor is not connected to the relay." },
            durationMs: 0,
          });
          return;
        }
        /*
         * Remember who asked.
         *
         * With one provider, "send the result to the provider" was right by
         * construction. With several agents attached at once it is a coin
         * flip, so results are routed by the call id that produced them.
         */
        this.toolCallers.set(message.id, connection.id);
        this.forward(target, message.sessionId, message);
        return;
      }

      case "tool.result": {
        const callerId = this.toolCallers.get(message.id);
        this.toolCallers.delete(message.id);

        const target = callerId
          ? this.connections.get(callerId)
          : this.providerConnection();

        if (target && target.socket.readyState === target.socket.OPEN) {
          this.forward(target, message.sessionId, message);
        }
        return;
      }

      case "media.register": {
        // Only the editor owns local files; a provider announcing media would
        // be announcing a path it should not have.
        if (connection.kind !== "editor") {
          this.options.log("media.refused", { reason: "only the editor may register media" });
          return;
        }
        this.media.set(message.media.id, message.media);
        this.options.log("media.registered", {
          id: message.media.id,
          bytes: message.media.size,
        });
        return;
      }

      case "media.unregister": {
        if (connection.kind !== "editor") {
          return;
        }
        this.media.delete(message.id);
        return;
      }

      case "pair.open": {
        // Only the editor may open it: everything else on this socket is a
        // client of the editor, and a client that could open the window could
        // hand the token to anything.
        if (connection.kind !== "editor") {
          return;
        }
        const duration = Math.min(Math.max(message.durationMs, 1000), 300_000);
        this.pairingOpenUntil = Date.now() + duration;
        this.options.log("pair.window-open", { durationMs: duration });
        return;
      }

      case "surface.open": {
        // Editor to browser only: nothing else has any business opening tabs.
        if (connection.kind !== "editor") {
          return;
        }
        const browser = this.findByKind("browser");
        if (browser) {
          this.forward(browser, "relay", message);
        } else if (typeof message.requestId === "string") {
          // A fire-and-forget open used to disappear here, after the editor had
          // already selected the model.  This is a precondition rejection: no
          // browser operation was started, so there is no browser completion
          // that could race with it.
          this.send(connection, "relay", {
            type: "surface.opened",
            requestId: message.requestId,
            model: message.model,
            status: "failed",
            detail: "The browser add-on is not connected.",
          });
        }
        return;
      }

      case "surface.models": {
        if (connection.kind !== "editor") {
          return;
        }
        const browser = this.findByKind("browser");
        if (browser) {
          this.forward(browser, "relay", message);
        } else {
          this.send(connection, "relay", {
            type: "surface.models.list",
            requestId: message.requestId,
            model: message.model,
            models: [],
            detail: "No browser is connected.",
          });
        }
        return;
      }

      case "surface.models.list": {
        if (connection.kind !== "browser") {
          return;
        }
        const editor = this.findByKind("editor");
        if (editor) {
          this.forward(editor, "relay", message);
        }
        return;
      }

      case "surface.opened": {
        if (connection.kind !== "browser") {
          return;
        }
        const target = this.editorConnection();
        if (target) {
          this.forward(target, "relay", message);
        }
        return;
      }

      case "tools.available": {
        if (connection.kind !== "editor") {
          return;
        }
        this.toolsAvailable = message;
        for (const peer of this.connections.values()) {
          if (peer.authenticated && peer.kind !== "editor") {
            this.forward(peer, "relay", message);
          }
        }
        return;
      }

      case "provider.error": {
        const waiter = message.requestId ? this.answers.get(message.requestId) : undefined;
        if (waiter) {
          waiter("", message.message);
          return;
        }
        const editorTarget = this.editorConnection();
        if (editorTarget) {
          this.forward(editorTarget, "relay", message);
        }
        return;
      }

      case "provider.status":
      // The editor is the only thing that displays a chat's pairing, so this
      // travels the same path as any other status: browser to editor, relayed
      // without interpretation.
      case "surface.status": {
        const target = this.editorConnection();
        if (target) {
          this.forward(target, "relay", message);
        }
        return;
      }

      default:
        return;
    }
  }

  private forward(target: Connection, sessionId: string, message: WireMessage): void {
    this.send(target, sessionId, message);
  }

  private send(connection: Connection, sessionId: string, message: WireMessage): void {
    if (connection.socket.readyState !== connection.socket.OPEN) {
      return;
    }
    connection.socket.send(JSON.stringify(createEnvelope(sessionId, message)));
  }

  private reject(connection: Connection, reason: string, message: string): void {
    this.options.log("adapter.rejected", { connectionId: connection.id, reason });
    try {
      connection.socket.send(
        JSON.stringify(
          createEnvelope("relay", {
            type: "adapter.rejected",
            reason: reason as "bad-token",
            message,
          }),
        ),
      );
    } catch {
      // The socket may already be gone; the close below is what matters.
    }
    connection.socket.close(1008, reason);
    this.drop(connection, reason);
  }

  private drop(connection: Connection, reason: string): void {
    if (connection.handshakeTimer) {
      clearTimeout(connection.handshakeTimer);
      connection.handshakeTimer = undefined;
    }
    if (!this.connections.delete(connection.id)) {
      return;
    }
    if (connection.kind) {
      this.options.log("adapter.gone", { kind: connection.kind, reason });
      this.broadcastRegistry();
    }
  }

  /** Spec §0R: a socket that stopped answering must stop looking connected. */
  private sweep(): void {
    const now = Date.now();
    for (const connection of [...this.connections.values()]) {
      if (now - connection.lastSeenAt > this.heartbeatStaleMs) {
        this.options.log("adapter.stale", {
          kind: connection.kind ?? "unauthenticated",
          silentMs: now - connection.lastSeenAt,
        });
        connection.socket.terminate();
        this.drop(connection, "stale");
        continue;
      }
      if (connection.socket.readyState === connection.socket.OPEN) {
        connection.socket.ping();
      }
    }
  }

  /**
   * When the pairing window closes. Zero means closed.
   *
   * Only the editor can open it, and only for as long as it asks for. A
   * process that is already attached as the editor has the token anyway, so
   * this grants nothing it could not already do.
   */
  private pairingOpenUntil = 0;

  /**
   * Mints the credential for one adapter role.
   *
   * Derived from the master token, so it is stable for as long as that token is
   * — an add-on paired yesterday still works after the relay restarts, which is
   * the difference between a bridge and a thing you re-pair every morning.
   *
   * The cost of stability is granularity: every browser that pairs against the
   * same relay token holds the same credential, so one cannot be revoked
   * without revoking all of them. Changing the relay token does that.
   */
  mintGrant(kind: AdapterKind): string {
    this.options.log("grant.issued", { kind });
    return deriveGrant(this.options.token, kind);
  }

  /**
   * Whether a token may attach as the kind it claims.
   *
   * The master token still admits every role — it comes from a file only this
   * user can read, and the editor genuinely needs all of them. A derived token
   * admits exactly the one it was derived for, so a leaked browser credential
   * cannot come back as the editor and start answering as the workspace.
   */
  private mayConnectAs(token: string, kind: AdapterKind): boolean {
    if (tokensMatch(this.options.token, token)) {
      return true;
    }

    if (tokensMatch(deriveGrant(this.options.token, kind), token)) {
      return true;
    }

    for (const other of ["editor", "provider", "browser", "mcp"] as AdapterKind[]) {
      if (other !== kind && tokensMatch(deriveGrant(this.options.token, other), token)) {
        this.options.log("grant.wrong-role", { granted: other, claimed: kind });
        return false;
      }
    }

    return false;
  }

  /** Request id -> whoever is waiting on an HTTP response for it. */
  private readonly answers = new Map<string, (text: string, error?: string) => void>();

  /** Tool call id -> the connection that asked, so results go home. */
  private readonly toolCallers = new Map<string, string>();

  /**
   * The editor's last published tool list, replayed to adapters that join
   * afterwards. Without this an agent that connects between requests sees no
   * tools and concludes the bridge is empty.
   */
  private toolsAvailable: WireMessage | undefined;

  private broadcastRegistry(): void {
    const registry = this.snapshot();
    for (const connection of this.connections.values()) {
      if (connection.authenticated) {
        this.send(connection, "relay", {
          type: "adapter.registry",
          editor: registry.editor,
          provider: registry.provider,
          browser: registry.browser,
        });
      }
    }
  }

  private findByKind(kind: AdapterKind): Connection | undefined {
    return [...this.connections.values()].find(
      (connection) => connection.authenticated && connection.kind === kind,
    );
  }

  private hasKind(kind: AdapterKind): boolean {
    return this.findByKind(kind) !== undefined;
  }

  private editorConnection(): Connection | undefined {
    return this.findByKind("editor");
  }

  /**
   * Who answers a request. A real chat outranks the test double.
   *
   * This used to prefer `provider`, which is the in-process-style mock process
   * that `Start relay + provider` launches. So a user who set up a browser,
   * paired a tab, and asked a question got "MOCK: I received your message" —
   * because a test double was still attached and won the routing. The mock is
   * a fallback for when nothing real is connected, never a competitor to it.
   */
  private providerConnection(): Connection | undefined {
    return this.findByKind("browser") ?? this.findByKind("provider");
  }
}

function isLoopback(address: string): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address.startsWith("127.")
  );
}
