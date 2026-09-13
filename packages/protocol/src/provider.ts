import type { CoachRequest, CoachResponse, ProviderStatus } from "./messages";
import type { CoachSession } from "./session";
import type { ToolCallRequest, ToolCallResult } from "./tools";

/**
 * Provider abstraction (spec §19).
 *
 * Deliberately transport-free: a provider might be in-process, behind a local
 * relay (Phase 6), or a browser adapter later. None of that belongs here.
 */

export interface Disposable {
  dispose(): void;
}

/**
 * A provider may answer directly, or ask the local bridge for more context
 * first. The tool call is just another inbound message — the loop is
 * request → (tool call → tool result)* → response.
 */
export type ProviderInboundMessage =
  | { type: "coach.response"; response: CoachResponse }
  | { type: "provider.status"; status: ProviderStatus; message?: string }
  | { type: "provider.error"; message: string; requestId?: string }
  | ToolCallRequest;

export interface CoachProvider {
  readonly id: string;
  readonly displayName: string;

  connect(session: CoachSession): Promise<void>;
  sendRequest(request: CoachRequest): Promise<void>;
  /**
   * Optional (spec §46). A provider that cannot cancel simply omits this; the
   * editor still stops waiting and discards any late answer.
   */
  cancelRequest?(requestId: string): Promise<void>;
  sendToolResult(result: ToolCallResult): Promise<void>;
  onMessage(callback: (message: ProviderInboundMessage) => void): Disposable;
  disconnect(): Promise<void>;
}
