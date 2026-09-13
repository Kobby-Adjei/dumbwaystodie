import type { LearningState, WorkspaceRootRef } from "./context";
import type { ToolErrorCode } from "./errors";
import type { ResponseContentPart } from "./messages";
import type { SessionPermissions } from "./permissions";

/** Spec §29: the panel renders these roles distinctly. */
export type SessionMessageRole = "user" | "coach" | "system" | "error" | "tool";

/**
 * One tool call as the conversation sees it (spec §29). Collapsed by default
 * in the panel: the coach's reasoning is the content, tool traffic is the
 * receipt.
 */
export interface ToolActivity {
  callId: string;
  tool: string;
  argsSummary: string;
  status: "running" | "ok" | "error";
  durationMs?: number;
  resultSummary?: string;
  errorCode?: ToolErrorCode;
}

/** What left the machine for one turn (computed, never hand-written). */
export interface MessageReceipt {
  summary: string;
  destination: string;
  included: { label: string; detail: string }[];
  withheld: string[];
  characters: number;
}

export interface SessionMessage {
  id: string;
  role: SessionMessageRole;
  createdAt: string;
  text: string;
  /** Structured parts when the source produced them (spec §0N). */
  parts?: ResponseContentPart[];
  requestId?: string;
  /** Present when role is "tool". */
  tool?: ToolActivity;
  /** Present on a user message: exactly what that turn sent. */
  receipt?: MessageReceipt;
}

/** Spec §6. One editor/coach conversation. */
export interface CoachSession {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  workspaceRoots: WorkspaceRootRef[];
  learning?: LearningState;
  activeRequestId?: string;
  messages: SessionMessage[];
  permissions: SessionPermissions;
}
