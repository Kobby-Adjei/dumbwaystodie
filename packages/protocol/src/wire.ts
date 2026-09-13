import type { AttachmentRef, CoachRequest, CoachResponse, ProviderStatus } from "./messages";
import type { ToolCallRequest, ToolCallResult, ToolDescriptor } from "./tools";

/**
 * The wire protocol (spec §0Q, §22).
 *
 * Everything crossing the socket is an Envelope<WireMessage>. Until Phase 6
 * nothing was serialized at all — these shapes existed but were only ever
 * passed in-process. Now they are the contract, and everything arriving on the
 * socket is untrusted input (spec §75).
 */

/**
 * `mcp` is a coding agent (Claude Code, Codex, and friends) attached through
 * the MCP server. Unlike the others it is not exclusive: several agents can be
 * connected at once, each correlating its own tool calls.
 */
export type AdapterKind = "editor" | "provider" | "browser" | "mcp";

export interface AdapterHello {
  type: "adapter.hello";
  adapterKind: AdapterKind;
  adapterId: string;
  protocolVersion: number;
  /** Proves the sender can read a file only this user can read (spec §23). */
  token: string;
  host?: string;
  capabilities: string[];
}

export interface AdapterWelcome {
  type: "adapter.welcome";
  connectionId: string;
  protocolVersion: number;
  sessionTokenAccepted: true;
  /** Who else is attached right now, so the panel can show real state. */
  peers: AdapterKind[];
}

export interface AdapterRejected {
  type: "adapter.rejected";
  reason: "bad-token" | "bad-version" | "malformed" | "timeout";
  message: string;
}

/** Which adapters are attached. Pushed on every change (spec §0I). */
export interface AdapterRegistry {
  type: "adapter.registry";
  editor: boolean;
  /**
   * True when anything can answer a request — a provider process or a browser.
   * Deliberately conflated: this answers "will a question get a reply", which
   * does not depend on which kind of thing replies.
   */
  provider: boolean;
  /**
   * Whether that answering thing is a browser, specifically.
   *
   * Separate from `provider` because the panel shows the route, not just
   * whether it works, and a browser hop stuck on "not built yet" while a
   * browser is plainly attached is the panel calling itself a liar.
   */
  browser: boolean;
}

/**
 * What the browser can see of the chat it is driving (spec §0J).
 *
 * Pairing lives in the browser and changes while the editor is running — tabs
 * close, pages reload — so the editor cannot infer it from the connection. It
 * has to be told.
 */
export interface SurfaceStatusMessage {
  type: "surface.status";
  /**
   * The build the reporting add-on is actually running.
   *
   * Compared with the build the editor shipped, so a browser add-on that has
   * not been reloaded says so instead of behaving like an older version while
   * looking connected.
   */
  build?: string;
  paired: boolean;
  /** e.g. "chatgpt". The first ready surface, for older readers. */
  surfaceType?: string;
  /** Whether the paired page can actually be driven, in the browser's words. */
  detail?: string;
  /**
   * Every chat this browser can reach, which is the router's model list.
   *
   * One paired tab is one available model. The editor does not track tabs — it
   * only ever sees these ids, so which window a chat lives in stays entirely
   * the browser's business.
   */
  surfaces?: AvailableSurface[];
}

export interface AvailableSurface {
  /** Stable while the pairing lasts; what a request names to choose this one. */
  id: string;
  /** e.g. "chatgpt" — the site, and so the model. */
  surfaceType: string;
  /** For a picker: "ChatGPT", "Claude". */
  label: string;
  status: "ready" | "lost" | "closed" | "blocked";
  /** Why this surface is unavailable, when the browser knows. */
  detail?: string;
}

/**
 * The editor announcing what it can do.
 *
 * `coach.request` already carries `availableTools`, but only a provider ever
 * receives one — an MCP agent attaches and asks `tools/list` before any
 * request exists. So the editor publishes the list on connect and the relay
 * replays it to whoever joins later.
 */
export interface ToolsAvailableMessage {
  type: "tools.available";
  tools: ToolDescriptor[];
}

/**
 * Opens a short window during which the relay will hand its token to a local
 * client that asks for it (spec: setup should not require a human courier).
 *
 * The token exists so that only processes run by this user can attach. Copying
 * it through the clipboard proved that, but it also made setup an eight-step
 * ritual with two different clipboards. A window that only opens on an
 * explicit click, closes in a minute, and is announced in the panel keeps the
 * same guarantee without the ceremony.
 */
export interface PairOpenMessage {
  type: "pair.open";
  /** How long the window stays open, in milliseconds. */
  durationMs: number;
}

/**
 * Asks the browser to make a chat available.
 *
 * The router is only pleasant if choosing a model is one click, so the browser
 * opens the site and starts a fresh conversation itself rather than requiring
 * the user to have arranged tabs in advance. It is the one participant that
 * can: the editor cannot open a browser tab, and the user should not have to.
 */
export interface SurfaceOpenMessage {
  type: "surface.open";
  /**
   * Identifies this open as an operation, so it can be answered and repeated.
   *
   * Opening a chat was fire-and-forget: the editor asked, and learned nothing
   * about whether it worked. The first the user heard of a failure was a
   * message bouncing minutes later — or, when the browser silently refused to
   * script the page, never. An operation that can fail has to have an outcome.
   */
  requestId?: string;
  /** A surface type from the site table: "claude", "gemini". */
  model: string;
  /**
   * Which model *inside* that chat, when the user has a preference.
   *
   * "claude" names the window; "opus" names what answers in it. Folded into
   * this message rather than given its own, because it is part of the same
   * request — "open Claude, on Opus" is one intention and should have one
   * outcome, not two that can disagree.
   */
  variant?: string;
  /**
   * Where this provider's coding chats should live, when the user has said.
   *
   * A person's ChatGPT is not a tool, it is a place they already keep things —
   * and filling its history with a coding agent's turns, and its memory with
   * the shape of a codebase, is a cost paid somewhere the editor cannot see.
   * So the destination is the user's to choose: a project that keeps these
   * chats together, a temporary chat that keeps them nowhere, or their normal
   * history if that is genuinely what they want.
   *
   * Absent means the site table's default new-chat URL, which is the normal
   * history — so this being optional is not neutral, and the editor asks
   * rather than assuming.
   */
  url?: string;
}

/**
 * The outcome of opening a chat: the answer to `surface.open`.
 *
 * Opening a tab is not success. Only the browser can prove that a content
 * script answered on that page, so only the browser reports `ready` — and the
 * editor does not treat a model as selected until this arrives.
 *
 * Terminal and idempotent. Replaying the same `requestId` produces the same
 * outcome rather than a second tab, because a relay reconnect can deliver a
 * frame twice and "the user asked once" must not become "two Perplexity tabs".
 */
export interface SurfaceOpenedMessage {
  type: "surface.opened";
  /**
   * Required here even though it is optional on the request.
   *
   * An outcome with no identity cannot be matched to the pick that caused it,
   * which is the entire point of having one. A request that arrives without an
   * id gets one minted for it, so there is always something to answer.
   */
  requestId: string;
  model: string;
  /**
   * `blocked` is its own outcome, not a kind of failure.
   *
   * Some browsers refuse to let add-ons script particular sites — a browser
   * shipped by the company whose chat you are trying to drive, for instance.
   * Retrying cannot help, and reporting it as "not connected" sends the user
   * looking for a tab that is sitting right there.
   */
  status: "ready" | "blocked" | "failed";
  detail?: string;
}

/**
 * Asks the browser which models the named chat offers.
 *
 * The list lives in the chat's own menu and changes without notice, so it is
 * read rather than configured. Asking a user to type a model name when the
 * browser can see the menu is making them do the machine's job.
 */
export interface SurfaceModelsMessage {
  type: "surface.models";
  requestId: string;
  model: string;
}

/** The answer: what that chat's menu actually offers, in its own words. */
export interface SurfaceModelsListMessage {
  type: "surface.models.list";
  requestId: string;
  model: string;
  models: string[];
  /** Why the list is empty, when it is. */
  detail?: string;
}

export interface CoachRequestMessage {
  type: "coach.request";
  request: CoachRequest;
}

export interface CoachResponseMessage {
  type: "coach.response";
  response: CoachResponse;
}

export interface ProviderStatusMessage {
  type: "provider.status";
  status: ProviderStatus;
  message?: string;
}

export interface ProviderErrorMessage {
  type: "provider.error";
  message: string;
  requestId?: string;
}

/** Spec §0R: a socket that stopped answering must stop looking connected. */
export interface PingMessage {
  type: "ping";
  sentAt: string;
}

export interface PongMessage {
  type: "pong";
  sentAt: string;
}

/**
 * Media registration (spec §0M).
 *
 * The editor tells the relay that an id maps to a local file; the relay then
 * serves those bytes over `GET /media/:id` to an authenticated adapter. Only
 * registered ids resolve — the endpoint never takes a path (spec §9).
 */
export interface MediaRegisterMessage {
  type: "media.register";
  media: AttachmentRef;
}

export interface MediaUnregisterMessage {
  type: "media.unregister";
  id: string;
}

export type WireMessage =
  | AdapterHello
  | MediaRegisterMessage
  | MediaUnregisterMessage
  | AdapterWelcome
  | AdapterRejected
  | AdapterRegistry
  | SurfaceStatusMessage
  | ToolsAvailableMessage
  | PairOpenMessage
  | SurfaceOpenMessage
  | SurfaceOpenedMessage
  | SurfaceModelsMessage
  | SurfaceModelsListMessage
  | CoachRequestMessage
  | CoachResponseMessage
  | ToolCallRequest
  | ToolCallResult
  | ProviderStatusMessage
  | ProviderErrorMessage
  | PingMessage
  | PongMessage;

export const DEFAULT_RELAY_HOST = "127.0.0.1";
export const DEFAULT_RELAY_PORT = 43123;

/** Spec §0R. Configurable, but these are the defaults everything assumes. */
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_STALE_MS = 45_000;

/** A socket that never authenticates must not sit open forever. */
export const HANDSHAKE_TIMEOUT_MS = 5_000;

/** Handshake file the relay writes and clients read (spec §23). */
export interface RelayHandshakeFile {
  host: string;
  port: number;
  token: string;
  pid: number;
  startedAt: string;
  protocolVersion: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrows an unknown payload to a WireMessage by its discriminant only.
 *
 * Deliberately shallow: it proves there is a known `type` so the receiver can
 * dispatch. Each handler is responsible for validating the fields it actually
 * reads — the same rule the tool registry follows.
 */
export function parseWireMessage(value: unknown): WireMessage | undefined {
  if (!isRecord(value) || typeof value["type"] !== "string") {
    return undefined;
  }

  const known = new Set([
    "adapter.hello",
    "adapter.welcome",
    "adapter.rejected",
    "adapter.registry",
    "surface.status",
    "tools.available",
    "pair.open",
    "surface.open",
    "surface.opened",
    "surface.models",
    "surface.models.list",
    "surface.opened",
    "surface.models",
    "surface.models.list",
    "media.register",
    "media.unregister",
    "coach.request",
    "coach.response",
    "tool.call",
    "tool.result",
    "provider.status",
    "provider.error",
    "ping",
    "pong",
  ]);

  return known.has(value["type"] as string) ? (value as unknown as WireMessage) : undefined;
}

/** Validates the fields the relay reads before it trusts a hello. */
export function parseAdapterHello(
  value: unknown,
): { ok: true; hello: AdapterHello } | { ok: false; reason: AdapterRejected["reason"]; message: string } {
  if (!isRecord(value) || value["type"] !== "adapter.hello") {
    return { ok: false, reason: "malformed", message: "Expected adapter.hello." };
  }

  const kind = value["adapterKind"];
  if (kind !== "editor" && kind !== "provider" && kind !== "browser" && kind !== "mcp") {
    return { ok: false, reason: "malformed", message: "Unknown adapterKind." };
  }

  if (typeof value["adapterId"] !== "string" || value["adapterId"].length === 0) {
    return { ok: false, reason: "malformed", message: "adapterId must be a non-empty string." };
  }

  if (typeof value["token"] !== "string" || value["token"].length === 0) {
    return { ok: false, reason: "bad-token", message: "Missing token." };
  }

  const capabilities = value["capabilities"];
  const hello: AdapterHello = {
    type: "adapter.hello",
    adapterKind: kind,
    adapterId: value["adapterId"],
    protocolVersion: typeof value["protocolVersion"] === "number" ? value["protocolVersion"] : -1,
    token: value["token"],
    capabilities:
      Array.isArray(capabilities) && capabilities.every((entry) => typeof entry === "string")
        ? (capabilities as string[])
        : [],
  };
  if (typeof value["host"] === "string") {
    hello.host = value["host"];
  }

  return { ok: true, hello };
}
