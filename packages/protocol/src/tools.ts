import type {
  DiagnosticSnapshot,
  FileContentSource,
  ProjectTreeEntry,
  TruncationInfo,
} from "./context";
import type { ToolError, ToolErrorCode } from "./errors";
import type { PermissionClass } from "./permissions";

/**
 * Tool protocol (spec §14, §69, §70).
 *
 * This is the heart of the project: the external coach can request local
 * information, and the local bridge decides whether to honour it.
 *
 * Names are namespaced by adapter (spec §68, §70). `editor.*` needs the live
 * editor; `workspace.*` needs the filesystem. Renaming a wire protocol after
 * three processes speak it is exactly the retrofit this project is trying to
 * avoid, so the namespaced names are canonical from the first tool.
 */

export const TOOL_NAMES = {
  activeDocument: "editor.active_document",
  diagnostics: "editor.diagnostics",
  readFile: "workspace.read_file",
  listDirectory: "workspace.list_directory",
  search: "workspace.search",
  projectTree: "workspace.project_tree",
  runCommand: "shell.run",
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

/** Machine-readable tool metadata (spec §70). */
export interface ToolDescriptor {
  name: string;
  description: string;
  permission: PermissionClass;
}

export interface ToolCallRequest {
  type: "tool.call";
  id: string;
  sessionId: string;
  /** Correlates the call to the CoachRequest that triggered it (spec §26). */
  requestId?: string;
  tool: string;
  arguments: unknown;
}

export interface ToolCallResult {
  type: "tool.result";
  id: string;
  sessionId: string;
  ok: boolean;
  result?: unknown;
  error?: ToolError;
  durationMs: number;
}

export function toolFailure(
  call: Pick<ToolCallRequest, "id" | "sessionId">,
  code: ToolErrorCode,
  message: string,
  details?: Record<string, unknown>,
  durationMs = 0,
): ToolCallResult {
  const error: ToolError = { code, message };
  if (details) {
    error.details = details;
  }
  return {
    type: "tool.result",
    id: call.id,
    sessionId: call.sessionId,
    ok: false,
    error,
    durationMs,
  };
}

/* ------------------------------------------------------------------ *
 * Arguments and results
 * ------------------------------------------------------------------ */

export interface ActiveDocumentArgs {
  /** Empty: the active document is whatever the user is looking at. */
}

export interface ActiveDocumentResult {
  path: string;
  language: string;
  isDirty: boolean;
  documentVersion: number;
  lineCount: number;
  source: FileContentSource;
  content: string;
  truncated: boolean;
  truncation?: TruncationInfo;
}

/** Line-aware reads (spec §62): better than shipping whole files. */
export interface ReadFileArgs {
  path: string;
  /** 1-based, inclusive. */
  startLine?: number;
  /** 1-based, inclusive. */
  endLine?: number;
}

export interface ReadFileResult {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  /**
   * "editor-buffer" when the file is open with unsaved changes. The bridge
   * never silently hands back disk content for a dirty buffer (spec §3.3).
   */
  source: FileContentSource;
  isDirty: boolean;
  content: string;
  truncated: boolean;
  truncation?: TruncationInfo;
}

export interface ListDirectoryArgs {
  /** Workspace-relative. Defaults to the workspace root. */
  path?: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "other";
}

export interface ListDirectoryResult {
  path: string;
  entries: DirectoryEntry[];
  truncated: boolean;
  /** Entries hidden by ignore rules or secret filtering, counted not named. */
  omittedCount: number;
}

export interface SearchArgs {
  /** Literal text by default; a regular expression when isRegex is true. */
  query: string;
  /**
   * Regex is served by ripgrep, whose engine is linear-time and cannot
   * catastrophically backtrack, running out-of-process where it can be killed.
   * When ripgrep is unavailable the bridge refuses regex rather than running an
   * untrusted pattern through JavaScript's backtracking engine, which can hang
   * the editor in a way no timeout can interrupt.
   */
  isRegex?: boolean;
  /** e.g. ["**\/*.ts", "*.json"]. Empty means everything not ignored. */
  globs?: string[];
  caseSensitive?: boolean;
  /** Whole-word matching. Requires the ripgrep backend. */
  wholeWord?: boolean;
  maxResults?: number;
}

/** Which engine answered. The coach should know how the answer was produced. */
export type SearchEngine = "ripgrep" | "node";

/** Spec §63. Deliberately compact: the coach can read ranges afterwards. */
export interface SearchMatch {
  path: string;
  /** 1-based. */
  line: number;
  preview: string;
  /** "editor-buffer" when the hit came from unsaved work. */
  source: FileContentSource;
}

export interface SearchResult {
  query: string;
  isRegex: boolean;
  engine: SearchEngine;
  matches: SearchMatch[];
  totalMatches: number;
  /**
   * Files that contained at least one match — not files examined. Ripgrep
   * never reports files it found nothing in, so "examined" is a number only
   * one backend could produce, and a field two engines disagree about is worse
   * than a field that says less.
   */
  filesWithMatches: number;
  truncated: boolean;
  /** Files skipped: binary, oversized, ignored or filtered. */
  omittedCount: number;
}

export interface ProjectTreeArgs {
  /** Workspace-relative subtree. Defaults to the workspace root. */
  path?: string;
  maxEntries?: number;
}

export interface ProjectTreeResult {
  root: string;
  entries: ProjectTreeEntry[];
  truncated: boolean;
  omittedCount: number;
}

/** Spec §37. Powerful and dangerous, so it is permission class "execute". */
export interface RunCommandArgs {
  command: string;
  /** Workspace-relative. Defaults to the workspace root. */
  cwd?: string;
  timeoutMs?: number;
}

export interface RunCommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
}

export interface DiagnosticsArgs {
  /** Workspace-relative. Defaults to the active document. */
  path?: string;
}

export interface DiagnosticsResult {
  path: string;
  diagnostics: DiagnosticSnapshot[];
  omittedCount: number;
}
