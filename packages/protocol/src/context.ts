/**
 * Context model (spec §3, §8, §13, §59).
 *
 * Critical rule: editor state and filesystem state are different things.
 * Every piece of file content carries a `source` so nobody downstream has to
 * guess whether they are looking at disk or at the live, unsaved buffer.
 *
 * Line and column numbers in this protocol are 1-based, because they are shown
 * to a human and quoted back by a coach. The VS Code API is 0-based; the editor
 * adapter is the single place that converts.
 */

export type FileContentSource = "editor-buffer" | "filesystem";

export interface WorkspaceRootRef {
  name: string;
  path: string;
}

export interface WorkspaceContext {
  name: string;
  roots: string[];
}

export interface CursorSnapshot {
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
}

export interface SelectionRange {
  /** 1-based, inclusive. */
  startLine: number;
  startColumn: number;
  /** 1-based, inclusive. */
  endLine: number;
  endColumn: number;
}

export interface SelectionSnapshot extends SelectionRange {
  path: string;
  language: string;
  content: string;
  isDirty: boolean;
  capturedAt: string;
}

/**
 * Truncation must always be visible (spec §13: "Never silently truncate
 * without metadata").
 */
export interface TruncationInfo {
  truncated: true;
  originalCharacters: number;
  includedCharacters: number;
}

export interface DocumentSnapshot {
  /** Workspace-relative where possible; falls back to the URI path. */
  path: string;
  absolutePath: string;
  language: string;
  isDirty: boolean;
  /** VS Code document version. Increments on every edit, saved or not. */
  documentVersion: number;
  lineCount: number;
  capturedAt: string;
  source: FileContentSource;
  content: string;
}

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

export interface DiagnosticSnapshot {
  path: string;
  severity: DiagnosticSeverity;
  message: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  source?: string;
  code?: string | number;
}

/** Metadata only. Content travels as context items (spec §8). */
export interface EditorContext {
  activeFile: string;
  absolutePath: string;
  language: string;
  isDirty: boolean;
  documentVersion: number;
  lineCount: number;
  capturedAt: string;
  cursor?: CursorSnapshot;
  selection?: SelectionRange;
}

export interface SelectionContextItem extends SelectionRange {
  type: "selection";
  path: string;
  language: string;
  content: string;
  isDirty: boolean;
  truncation?: TruncationInfo;
}

export interface FileContextItem {
  type: "file";
  path: string;
  source: FileContentSource;
  language?: string;
  content: string;
  isDirty?: boolean;
  documentVersion?: number;
  truncated: boolean;
  truncation?: TruncationInfo;
}

export interface DiagnosticContextItem {
  type: "diagnostics";
  path: string;
  diagnostics: DiagnosticSnapshot[];
  omittedCount?: number;
}

export interface TerminalContextItem {
  type: "terminal";
  terminalName?: string;
  content: string;
  capturedAt: string;
}

export interface GitContextItem {
  type: "git";
  branch?: string;
  status?: string;
  diff?: string;
}

/**
 * Free-form note. Used to record *why* something is absent — a dropped budget
 * item, a filtered secret file — so the coach is never quietly misled.
 */
export interface NoteContextItem {
  type: "note";
  note: string;
}

export interface ProjectTreeContextItem {
  type: "tree";
  entries: ProjectTreeEntry[];
  truncated: boolean;
}

export interface ProjectTreeEntry {
  path: string;
  type: "file" | "directory";
}

export interface LearningContextItem {
  type: "learning";
  learning: LearningState;
}

export type ContextItem =
  | SelectionContextItem
  | FileContextItem
  | DiagnosticContextItem
  | TerminalContextItem
  | GitContextItem
  | NoteContextItem
  | ProjectTreeContextItem
  | LearningContextItem;

export interface LearningState {
  currentGoal?: string;
  currentFeature?: string;
  currentMicroSkill?: string;
  currentUnderstanding?: string;
  prediction?: string;
  observedResult?: string;
  demonstrated?: string[];
  shaky?: string[];
}

export interface ContextBudget {
  maxCharacters: number;
  maxFileCharacters: number;
  maxDiagnosticItems: number;
  maxTreeEntries: number;
}

/** Spec §13 suggested defaults. */
export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxCharacters: 120_000,
  maxFileCharacters: 40_000,
  maxDiagnosticItems: 100,
  maxTreeEntries: 500,
};

/** Character count of an item, used for budgeting. */
export function contextItemCharacters(item: ContextItem): number {
  switch (item.type) {
    case "selection":
      return item.content.length;
    case "file":
      return item.content.length;
    case "diagnostics":
      return item.diagnostics.reduce((total, d) => total + d.message.length + 40, 0);
    case "terminal":
      return item.content.length;
    case "git":
      return (item.diff?.length ?? 0) + (item.status?.length ?? 0);
    case "note":
      return item.note.length;
    case "tree":
      return item.entries.reduce((total, e) => total + e.path.length + 12, 0);
    case "learning":
      return JSON.stringify(item.learning).length;
  }
}
