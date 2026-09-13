import type { SurfaceState } from "../surfaces/ChatSurfaceAdapter";

/**
 * Messages between the three halves of the extension: popup, service worker,
 * and the content script living on the chat page.
 *
 * Separate from the wire protocol on purpose. This is internal plumbing; the
 * relay never sees it.
 */

export interface PairingRecord {
  /** For a picker: "ChatGPT", "Claude". Falls back to the surface type. */
  label?: string;
  pairingId: string;
  tabId: number;
  surfaceType: string;
  url: string;
  pairedAt: string;
  status: "ready" | "lost" | "closed" | "blocked";
  /** A terminal reason, notably a browser ExtensionSettings policy. */
  detail?: string;
}

/**
 * The build this add-on was compiled from, stamped in by esbuild.
 *
 * Chrome keeps running the copy of a service worker it loaded, so files on disk
 * changing does not change what is executing. This is how the editor can tell
 * the difference between "connected" and "connected to a build from before the
 * fix" — which is otherwise indistinguishable from the fix not working.
 */
declare const __DWTD_BUILD__: string;
export const ADDON_BUILD: string = typeof __DWTD_BUILD__ === "string" ? __DWTD_BUILD__ : "unknown";

export interface RelayCredentials {
  host: string;
  port: number;
  token: string;
}

export type PopupToWorker =
  | { type: "pair-current-tab" }
  | { type: "unpair" }
  | { type: "set-credentials"; credentials: RelayCredentials }
  | { type: "discover" }
  /**
   * Sent by the content script while a reply is still being written.
   *
   * It names the request and the observation it belongs to. The worker will not
   * forward a frame it cannot attribute — otherwise a straggler from an
   * abandoned turn, or from a different chat, is indistinguishable from live
   * text for whichever request happens to be in flight.
   */
  | { type: "reply-progress"; text: string; requestId: string; observationId: string }
  | { type: "get-status" };

/** Sites the add-on ships selectors for, for the popup to describe. */
export interface SiteSummary {
  label: string;
  host: string;
}

export interface WorkerStatus {
  relay: "disconnected" | "connecting" | "connected" | "error";
  relayDetail?: string;
  pairing?: PairingRecord;
  /** Every chat this browser can reach — the router's model list. */
  surfaces?: PairingRecord[];
  surface?: SurfaceState;
  hasCredentials: boolean;
  /**
   * The result of the last thing the user asked for, in words.
   *
   * Pairing has several ways to not happen — wrong kind of page, a tab that
   * loaded before this add-on did — and a button that silently does nothing is
   * indistinguishable from a broken one.
   */
  note?: string;
}

export type WorkerToContent =
  | { type: "probe" }
  | { type: "deliver"; text: string }
  /** The identity is echoed back on every progress frame this observation emits. */
  | { type: "observe"; requestId: string; observationId: string }
  /** Switch which model the paired chat is using, by driving its own menu. */
  | { type: "set-model"; model: string }
  /** Read the models this chat offers, by opening its menu and looking. */
  | { type: "list-models" }
  | { type: "abort" };

export type ContentToWorker =
  | { type: "model-set"; ok: boolean; reason?: string }
  | { type: "models"; models: string[]; reason?: string }
  | { type: "probed"; state: SurfaceState; surfaceType: string; url: string }
  | { type: "delivered"; rung: string; sent: boolean; reason?: string }
  | { type: "observed"; text: string; rung: string }
  | { type: "failed"; reason: string };

/** Parses the one-line credentials blob the editor copies. */
export function parseCredentials(input: string): RelayCredentials | undefined {
  try {
    const parsed = JSON.parse(input.trim()) as Partial<RelayCredentials>;
    if (
      typeof parsed.host === "string" &&
      typeof parsed.port === "number" &&
      typeof parsed.token === "string" &&
      parsed.token.length >= 16
    ) {
      return { host: parsed.host, port: parsed.port, token: parsed.token };
    }
  } catch {
    // Fall through: an unparseable blob is simply not credentials.
  }
  return undefined;
}
