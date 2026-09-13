import { CHAT_PROVIDERS } from "@dumbways/protocol";
import type {
  AttachmentRef,
  ConnectionSnapshot,
  HopState,
  RequestLifecycleState,
  SessionMessage,
} from "@dumbways/protocol";

import type { ContextSummary } from "../context/ContextEngine";

/** Everything the webview needs. Serialized as JSON, so: no classes, no dates. */
export interface CoachViewModel {
  session: { id: string; name: string };
  connections: ConnectionSnapshot;
  hops: HopView[];
  requestState: RequestLifecycleState;
  progress: string;
  busy: boolean;
  context: ContextSummary;
  attachments: AttachmentRef[];
  paste?: PasteStep;
  messages: SessionMessage[];
  setup?: SetupAction;
  browser?: SetupAction;
  /** One sentence: what to do now. See `nextStep`. */
  next?: NextStep;
  /** Which chat answers, for the composer's picker. */
  model?: ModelChoice;
  /** The picker's rows: every provider, and whether it is connected. */
  providers?: ProviderRow[];
  lastError?: string;
}

/**
 * The one action worth offering from the panel, derived from hop state rather
 * than tracked separately — there is no second copy of the truth to drift.
 */
export interface SetupAction {
  command: "startStack" | "stopStack" | "copyRelayDetails" | "setupBrowser";
  label: string;
  hint: string;
}

/**
 * What to do next, in one sentence.
 *
 * The hops answer "what is the state of each part", which is a debugging
 * question. Nobody opens a panel wanting that — they want to know whether
 * they can type yet, and if not, what to press. Both come from the same
 * snapshot, so this cannot disagree with the dots above it.
 */
export interface NextStep {
  message: string;
  /** Whether this is a wait, a problem, or a green light. */
  tone: "ok" | "waiting" | "action";
}

/**
 * What the composer's model button says.
 *
 * A router hidden in the command palette is a router nobody uses, so the
 * current choice is always on screen next to the thing you press to send.
 */
export interface ModelChoice {
  /** Short enough for a button: "ChatGPT", "Auto". */
  label: string;
  /** True when a chat is actually connected under that name. */
  connected: boolean;
}

export interface ProviderRow {
  id: string;
  label: string;
  initial: string;
  /** Filename under media/logos; the webview resolves it to a webview URI. */
  logo: string;
  connected: boolean;
  blocked: boolean;
  detail?: string;
  chosen: boolean;
}

/**
 * The picker's rows.
 *
 * Every provider is listed, connected or not, because the add-on opens the
 * ones that are not — hiding them would hide the feature. Connection state is
 * shown rather than used to filter.
 */
export function providerRows(
  chosen: string | undefined,
  surfaces: ReadonlyArray<{ id: string; status: string; detail?: string }>,
): ProviderRow[] {
  return CHAT_PROVIDERS.map((provider) => {
    const surface = surfaces.find((candidate) => candidate.id === provider.id);
    return {
      id: provider.id,
      label: provider.label,
      initial: provider.initial,
      logo: provider.logo,
      connected: surface?.status === "ready",
      blocked: surface?.status === "blocked",
      ...(surface?.detail ? { detail: surface.detail } : {}),
      chosen: chosen === provider.id,
    };
  });
}

export function modelChoice(
  chosen: string | undefined,
  surfaces: ReadonlyArray<{ id: string; label: string; status: string }>,
): ModelChoice {
  if (chosen) {
    const match = surfaces.find((surface) => surface.id === chosen);
    return {
      label: match?.label ?? titleCase(chosen),
      connected: match?.status === "ready",
    };
  }

  const ready = surfaces.filter((surface) => surface.status === "ready");

  /*
   * With nothing chosen the button says what will actually happen rather than
   * "Auto": one connected chat means that chat answers, and naming it is more
   * use than naming the policy.
   */
  if (ready.length === 1 && ready[0]) {
    return { label: ready[0].label, connected: true };
  }
  if (ready.length > 1) {
    return { label: `${ready.length} chats`, connected: true };
  }
  return { label: "Pick a chat", connected: false };
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function nextStep(connections: ConnectionSnapshot): NextStep {
  // In-process and clipboard modes need no setup at all, so saying nothing
  // would be wrong — say it is ready.
  if (connections.relay === "not-implemented") {
    return { message: `Ready. Ask about the file you are looking at.`, tone: "ok" };
  }

  if (connections.relay !== "connected") {
    return { message: "Starting the local relay…", tone: "waiting" };
  }

  if (connections.browser !== "connected") {
    return {
      message: "Waiting for the browser add-on. Install it, then open a chat tab.",
      tone: "action",
    };
  }

  if (connections.chatSurface !== "ready") {
    return {
      message: "Add-on connected. Open a chat tab — ChatGPT, Claude, Gemini — and it pairs itself.",
      tone: "action",
    };
  }

  return { message: "Ready. Ask about the file you are looking at.", tone: "ok" };
}

export function setupAction(connections: ConnectionSnapshot): SetupAction | undefined {
  if (connections.relay === "not-implemented") {
    return {
      command: "startStack",
      label: "Start relay + provider",
      hint: "Runs both processes and switches this window to them. No terminal needed.",
    };
  }
  if (connections.provider !== "ready") {
    return {
      command: "startStack",
      label: "Start provider process",
      hint: "The relay is configured but nothing is answering on the far side.",
    };
  }
  return {
    command: "stopStack",
    label: "Stop relay + provider",
    hint: "Stops both processes and returns to the in-process provider.",
  };
}

/**
 * The browser route, offered only while it would change something.
 *
 * This used to offer "copy the connection line" because the add-on had no way
 * to get one by itself. It does now — the editor opens a pairing window and
 * the add-on asks — so the useful offer is to open that window again, not to
 * hand the user a string to carry.
 */
export function browserAction(connections: ConnectionSnapshot): SetupAction | undefined {
  if (connections.relay === "not-implemented") {
    return {
      command: "setupBrowser",
      label: "Connect a browser chat",
      hint: "Starts everything and walks through installing the add-on once.",
    };
  }

  if (connections.browser !== "connected") {
    return {
      command: "setupBrowser",
      label: "Look for my browser again",
      hint: "Reopens the pairing window for five minutes. Safe to press any time.",
    };
  }

  // Connected. There is nothing useful left to offer, so offer nothing.
  return undefined;
}

/**
 * What the clipboard transport needs from the user right now.
 *
 * Derived rather than tracked separately, so it cannot disagree with the
 * transport's actual state.
 */
export interface PasteStep {
  title: string;
  detail: string;
  action: string;
}

export function pasteStep(awaiting: string | undefined): PasteStep | undefined {
  switch (awaiting) {
    case "primer":
      return {
        title: "Primer copied",
        detail: "Paste it into a fresh chat and send. Reply here once the coach says ready.",
        action: "Bring the reply back",
      };
    case "request":
      return {
        title: "Message copied",
        detail: "Paste it into your chat and send, then copy the reply.",
        action: "Bring the reply back",
      };
    case "tool-result":
      return {
        title: "Result copied",
        detail: "Paste it back into the chat so the coach can continue.",
        action: "Bring the reply back",
      };
    default:
      return undefined;
  }
}

export interface HopView {
  label: string;
  state: HopState;
  /** "ok" | "pending" | "bad" | "absent" — drives the dot colour only. */
  tone: "ok" | "pending" | "bad" | "absent";
  detail: string;
}

/**
 * Spec §0V: the panel narrates the hop it is on, so a stall is diagnosable
 * without opening the log.
 */
export function progressLabel(state: RequestLifecycleState): string {
  switch (state) {
    case "IDLE":
      return "";
    case "CAPTURING_CONTEXT":
      return "Capturing editor context…";
    case "REQUEST_READY":
      return "Context ready.";
    case "SENDING":
      return "Sending to provider…";
    case "SENT":
      return "Sent.";
    case "PROVIDER_PROCESSING":
      return "Waiting for a reply…";
    case "TOOL_REQUESTED":
      return "Asked for more context…";
    case "TOOL_RUNNING":
      return "Running tool…";
    case "TOOL_RESULT_SENT":
      return "Tool result sent…";
    case "RESPONSE_RECEIVED":
      return "Reply coming in…";
    case "DELIVERED":
      return "Done.";
    case "FAILED":
      return "Failed.";
    case "CANCELLED":
      return "Cancelled.";
    case "TIMED_OUT":
      return "Timed out.";
    case "PERMISSION_DENIED":
      return "Permission denied.";
    case "PROVIDER_DISCONNECTED":
      return "Provider disconnected.";
  }
}

const IN_FLIGHT: readonly RequestLifecycleState[] = [
  "CAPTURING_CONTEXT",
  "REQUEST_READY",
  "SENDING",
  "SENT",
  "PROVIDER_PROCESSING",
  "TOOL_REQUESTED",
  "TOOL_RUNNING",
  "TOOL_RESULT_SENT",
  "RESPONSE_RECEIVED",
];

export function isInFlight(state: RequestLifecycleState): boolean {
  return IN_FLIGHT.includes(state);
}

function tone(state: HopState): HopView["tone"] {
  switch (state) {
    case "connected":
    case "ready":
      return "ok";
    case "connecting":
    case "busy":
      return "pending";
    case "disconnected":
    case "lost":
    case "error":
      return "bad";
    case "not-implemented":
      return "absent";
  }
}

/**
 * Spec §0I: five independent hops, never collapsed into one "Connected".
 * The two that do not exist yet say so instead of showing a colour.
 */
export function buildHops(connections: ConnectionSnapshot): HopView[] {
  return [
    {
      label: "Editor",
      state: connections.editor,
      tone: tone(connections.editor),
      detail: "VS Code extension host",
    },
    {
      label: "Provider",
      state: connections.provider,
      tone: tone(connections.provider),
      detail: connections.providerName,
    },
    {
      label: "Relay",
      state: connections.relay,
      tone: tone(connections.relay),
      // These three said "not built yet — Phase 6" long after they were built.
      // A panel that describes the plan instead of the machine is a panel
      // nobody can trust when something actually breaks.
      detail: "local router on 127.0.0.1",
    },
    {
      label: "Browser",
      state: connections.browser,
      tone: tone(connections.browser),
      detail: "the Chrome add-on",
    },
    {
      label: "Chat",
      state: connections.chatSurface,
      tone: tone(connections.chatSurface),
      detail: "the tab it is driving",
    },
  ];
}
