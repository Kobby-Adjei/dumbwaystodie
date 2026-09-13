import WebSocket from "ws";

import {
  createEnvelope,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  parseEnvelope,
  parseWireMessage,
  PROTOCOL_VERSION,
  type AdapterKind,
  type ConnectionState,
  type WireMessage,
} from "@dumbways/protocol";

/**
 * The client half of the relay protocol, shared by the editor extension and
 * any provider process.
 *
 * Written once because two implementations of a handshake drift, and a drifted
 * handshake fails at the worst possible moment — when the two sides are
 * different processes and neither log tells the whole story.
 */

export interface RelayConnectionOptions {
  host: string;
  port: number;
  token: string;
  adapterKind: AdapterKind;
  adapterId: string;
  capabilities?: string[];
  host_?: string;
  onMessage: (message: WireMessage) => void;
  onStateChange?: (state: ConnectionState, detail?: string) => void;
  log?: (message: string) => void;
  /** Spec §24: reconnect with backoff, but never in a tight loop. */
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
}

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

export class RelayConnection {
  private socket: WebSocket | undefined;
  private state: ConnectionState = "disconnected";
  private attempts = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private lastSeenAt = 0;
  private closedByUs = false;
  private welcomed: (() => void) | undefined;

  constructor(private readonly options: RelayConnectionOptions) {}

  get currentState(): ConnectionState {
    return this.state;
  }

  /** Resolves once the relay has welcomed this adapter, or rejects. */
  async connect(): Promise<void> {
    this.closedByUs = false;
    return new Promise<void>((resolve, reject) => {
      this.welcomed = resolve;
      this.open(reject);
    });
  }

  send(sessionId: string, message: WireMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected to the relay.");
    }
    this.socket.send(JSON.stringify(createEnvelope(sessionId, message)));
  }

  close(): void {
    this.closedByUs = true;
    this.clearTimers();
    this.socket?.close(1000, "client closing");
    this.socket = undefined;
    this.setState("disconnected");
  }

  private open(onFatal?: (error: Error) => void): void {
    this.setState(this.attempts === 0 ? "connecting" : "reconnecting");

    const url = `ws://${this.options.host}:${this.options.port}/transport`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.on("open", () => {
      this.lastSeenAt = Date.now();
      socket.send(
        JSON.stringify(
          createEnvelope("relay", {
            type: "adapter.hello",
            adapterKind: this.options.adapterKind,
            adapterId: this.options.adapterId,
            protocolVersion: PROTOCOL_VERSION,
            token: this.options.token,
            capabilities: this.options.capabilities ?? [],
          }),
        ),
      );
    });

    socket.on("message", (data) => {
      this.lastSeenAt = Date.now();

      let payload: unknown;
      try {
        payload = parseEnvelope(JSON.parse(data.toString())).payload;
      } catch (error) {
        this.options.log?.(`[relay] dropped a malformed frame: ${String(error)}`);
        return;
      }

      const message = parseWireMessage(payload);
      if (!message) {
        return;
      }

      if (message.type === "adapter.welcome") {
        this.attempts = 0;
        this.setState("connected");
        this.startHeartbeat();
        this.welcomed?.();
        this.welcomed = undefined;
        return;
      }

      if (message.type === "adapter.rejected") {
        // A refusal is final: retrying with the same bad token or version
        // would be a loop, not a recovery.
        this.closedByUs = true;
        this.setState("error", message.message);
        onFatal?.(new Error(message.message));
        this.socket?.close();
        return;
      }

      this.options.onMessage(message);
    });

    socket.on("ping", () => {
      this.lastSeenAt = Date.now();
    });

    socket.on("error", (error) => {
      this.options.log?.(`[relay] socket error: ${error.message}`);
    });

    socket.on("close", () => {
      this.clearTimers();
      if (this.closedByUs) {
        return;
      }
      this.setState("disconnected");
      this.scheduleReconnect(onFatal);
    });
  }

  private scheduleReconnect(onFatal?: (error: Error) => void): void {
    if (this.options.autoReconnect === false) {
      return;
    }

    const cap = this.options.maxReconnectAttempts ?? 10;
    if (this.attempts >= cap) {
      this.setState("error", `Gave up reconnecting after ${cap} attempts.`);
      onFatal?.(new Error("Could not reach the relay."));
      return;
    }

    // Exponential backoff (spec §24): never a tight retry loop.
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** this.attempts, MAX_BACKOFF_MS);
    this.attempts += 1;
    this.options.log?.(`[relay] reconnecting in ${delay}ms (attempt ${this.attempts})`);

    this.reconnectTimer = setTimeout(() => this.open(onFatal), delay);
    this.reconnectTimer.unref?.();
  }

  /**
   * The relay pings us; `ws` answers automatically. This watches for the
   * silence that means the relay went away without closing the socket — the
   * case that otherwise leaves a green dot next to a dead connection.
   */
  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastSeenAt > HEARTBEAT_STALE_MS) {
        this.options.log?.("[relay] no traffic within the stale window; reconnecting");
        this.socket?.terminate();
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private setState(state: ConnectionState, detail?: string): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.options.onStateChange?.(state, detail);
  }
}
