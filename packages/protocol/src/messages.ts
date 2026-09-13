import type {
  ContextItem,
  EditorContext,
  LearningState,
  WorkspaceContext,
} from "./context";
import type { CoachingMetadata } from "./permissions";
import type { ToolDescriptor } from "./tools";

export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/**
 * Envelope (spec §22, §49).
 *
 * Every message across every transport carries the version. Milestone A is
 * in-process, so nothing is serialized yet — but the shape is fixed now so the
 * relay in Phase 6 does not force a rewrite of the editor side.
 */
export interface Envelope<T> {
  protocolVersion: ProtocolVersion;
  id: string;
  timestamp: string;
  sessionId: string;
  payload: T;
}

/**
 * What the local bridge can actually do *right now*.
 *
 * Derived from the tool registry rather than hand-maintained, so it cannot
 * drift into advertising a tool that was never registered. A provider must
 * never assume more than this states.
 */
export interface ClientCapabilities {
  readActiveDocument: boolean;
  readFile: boolean;
  searchFiles: boolean;
  listDirectory: boolean;
  projectTree: boolean;
  readDiagnostics: boolean;
  runCommand: boolean;
  attachments: boolean;
}

/** A bridge that can be told things but cannot be asked anything. */
export const NO_CAPABILITIES: ClientCapabilities = {
  readActiveDocument: false,
  readFile: false,
  searchFiles: false,
  listDirectory: false,
  projectTree: false,
  readDiagnostics: false,
  runCommand: false,
  attachments: false,
};

export interface AttachmentRef {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  source: "clipboard" | "screenshot" | "filesystem" | "editor" | "import";
  localMediaPath: string;
}

export interface CoachRequest {
  id: string;
  sessionId: string;
  createdAt: string;
  message: string;
  workspace: WorkspaceContext;
  editor?: EditorContext;
  /**
   * The whole request as text, for transports that can only deliver text.
   *
   * A browser can only type into a box, so it needs the context, the primer
   * and the question as one string. That string used to be written over
   * `message` — which quietly broke every consumer that reasonably read
   * `message` as "what the user asked", including the mock provider, whose
   * search-term extraction started matching words out of the primer.
   *
   * `message` stays the user's own words. This is the delivery format.
   */
  rendered?: string;
  /**
   * Which chat should answer this, when more than one is paired.
   *
   * Names a surface — "claude", "gemini" — or a surface id. Absent means "any
   * ready one", which is what a single-chat setup always wants and what
   * everything did before the router existed.
   */
  model?: string;
  contextItems: ContextItem[];
  attachments: AttachmentRef[];
  learning?: LearningState;
  coaching?: CoachingMetadata;
  clientCapabilities: ClientCapabilities;
  /**
   * The tools this bridge will actually honour, with their permission class
   * (spec §70). A provider adapter can hand these straight to a model.
   */
  availableTools: ToolDescriptor[];
}

export type ResponseContentPart =
  | { type: "text"; text: string }
  | { type: "code"; language?: string; code: string }
  | { type: "attachment"; attachment: AttachmentRef };

export interface CoachResponse {
  id: string;
  requestId: string;
  sessionId: string;
  createdAt: string;
  content: ResponseContentPart[];
  source: {
    adapterKind: "browser" | "mock" | "other";
    surfaceType?: string;
  };
  completion: {
    /**
     * `partial` means more of this reply is still coming.
     *
     * Without it a transport could only hand over a finished answer, so the
     * panel sat blank while a chat wrote for twenty seconds — and if the
     * transport guessed "finished" early, the tail was simply lost. A partial
     * reply is delivered, shown, and later replaced by the fuller one under
     * the same request id.
     */
    state: "partial" | "complete" | "cancelled" | "failed";
    reason?: string;
  };
}

/**
 * Request lifecycle (spec §25). Milestone A reaches DELIVERED without ever
 * entering the TOOL_* states, because no tools exist yet.
 */
export type RequestLifecycleState =
  | "IDLE"
  | "CAPTURING_CONTEXT"
  | "REQUEST_READY"
  | "SENDING"
  | "SENT"
  | "PROVIDER_PROCESSING"
  | "TOOL_REQUESTED"
  | "TOOL_RUNNING"
  | "TOOL_RESULT_SENT"
  | "RESPONSE_RECEIVED"
  | "DELIVERED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT"
  | "PERMISSION_DENIED"
  | "PROVIDER_DISCONNECTED";

export const TERMINAL_REQUEST_STATES: readonly RequestLifecycleState[] = [
  "DELIVERED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "PERMISSION_DENIED",
  "PROVIDER_DISCONNECTED",
];

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export type ProviderStatus =
  | "connecting"
  | "ready"
  | "busy"
  | "waiting-for-tool"
  | "disconnected"
  | "error";

/**
 * Per-hop connection state (spec §0I).
 *
 * "not-implemented" is a deliberate, honest state: the relay and browser hops
 * do not exist before Phase 6. The UI says so rather than showing a green dot
 * for something that was never built.
 */
export type HopState =
  | "not-implemented"
  | "disconnected"
  | "connecting"
  | "connected"
  | "ready"
  | "busy"
  | "lost"
  | "error";

export interface ConnectionSnapshot {
  editor: HopState;
  provider: HopState;
  relay: HopState;
  browser: HopState;
  chatSurface: HopState;
  providerName: string;
  detail?: string;
}
