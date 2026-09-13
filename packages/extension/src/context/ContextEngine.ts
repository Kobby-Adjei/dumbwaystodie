import {
  contextItemCharacters,
  createRequestId,
  DEFAULT_CONTEXT_BUDGET,
  NO_CAPABILITIES,
  type ClientCapabilities,
  type CoachRequest,
  type ToolDescriptor,
  type ContextBudget,
  type AttachmentRef,
  type ContextItem,
  type DiagnosticContextItem,
  type EditorContext,
  type FileContextItem,
  type LearningState,
  type SelectionContextItem,
  type TruncationInfo,
} from "@dumbways/protocol";

import type { EditorAdapter } from "../editor/EditorAdapter";
import { inspectPath } from "../security/secretFilter";

/**
 * The context engine decides what gets sent *by default* (spec §12).
 *
 * It is deliberately conservative: active file, selection, cursor, dirty
 * state, diagnostics for that one file. No repository dumps, no sweep of open
 * tabs. Everything else is meant to be pulled on demand by the coach through
 * tools — which is the actual architecture (spec §76).
 *
 * This module never imports `vscode`. It takes an EditorAdapter, which makes
 * it testable with a fake and reusable from a different editor host.
 */

/** Cheap summary for the always-visible panel section. */
export interface ContextSummary {
  workspaceName: string;
  activeFile?: string;
  language?: string;
  isDirty: boolean;
  documentVersion?: number;
  bufferCharacters?: number;
  selection?: { startLine: number; endLine: number; characters: number };
  cursor?: { line: number; column: number };
  diagnosticCount: number;
  blockedReason?: string;
}

export interface BuildRequestInput {
  sessionId: string;
  message: string;
  learning?: LearningState;
  /** Metadata only — the bytes are fetched separately (spec §0M). */
  attachments?: AttachmentRef[];
}

export interface BuildRequestResult {
  request: CoachRequest;
  /** Everything the engine decided to trim, drop or block, for the UI. */
  notes: string[];
}

function truncate(content: string, max: number): { content: string; truncation?: TruncationInfo } {
  if (content.length <= max) {
    return { content };
  }
  // Head truncation, not a window around the cursor: it keeps 1-based line
  // numbers valid for every line that survives, so a coach quoting "L18" is
  // quoting the same line the user sees.
  return {
    content: content.slice(0, max),
    truncation: {
      truncated: true,
      originalCharacters: content.length,
      includedCharacters: max,
    },
  };
}

/**
 * What the bridge will honour if the coach asks for more. Supplied by the tool
 * registry so the advertised capabilities cannot drift from what is registered.
 */
export interface ToolDirectory {
  getCapabilities(): ClientCapabilities;
  list(): ToolDescriptor[];
}

const NO_TOOLS: ToolDirectory = {
  getCapabilities: () => NO_CAPABILITIES,
  list: () => [],
};

export class ContextEngine {
  constructor(
    private readonly editor: EditorAdapter,
    private readonly getBudget: () => ContextBudget = () => DEFAULT_CONTEXT_BUDGET,
    private readonly tools: ToolDirectory = NO_TOOLS,
  ) {}

  summarize(): ContextSummary {
    const workspace = this.editor.getWorkspaceContext();
    const document = this.editor.getActiveDocumentSnapshot();

    if (!document) {
      return { workspaceName: workspace.name, isDirty: false, diagnosticCount: 0 };
    }

    const verdict = inspectPath(document.path);
    const selection = this.editor.getSelection();
    const cursor = this.editor.getCursor();
    const diagnostics = this.editor.getDiagnostics();

    const summary: ContextSummary = {
      workspaceName: workspace.name,
      activeFile: document.path,
      language: document.language,
      isDirty: document.isDirty,
      documentVersion: document.documentVersion,
      diagnosticCount: diagnostics.length,
    };

    if (verdict.blocked) {
      summary.blockedReason = verdict.reason ?? "matched a secret-file pattern";
      return summary;
    }

    summary.bufferCharacters = document.content.length;
    if (cursor) {
      summary.cursor = { line: cursor.line, column: cursor.column };
    }
    if (selection) {
      summary.selection = {
        startLine: selection.startLine,
        endLine: selection.endLine,
        characters: selection.content.length,
      };
    }
    return summary;
  }

  buildRequest(input: BuildRequestInput): BuildRequestResult {
    const budget = this.getBudget();
    const workspace = this.editor.getWorkspaceContext();
    const document = this.editor.getActiveDocumentSnapshot();
    const notes: string[] = [];
    const items: ContextItem[] = [];

    let editorContext: EditorContext | undefined;

    if (document) {
      const cursor = this.editor.getCursor();
      const selection = this.editor.getSelection();

      editorContext = {
        activeFile: document.path,
        absolutePath: document.absolutePath,
        language: document.language,
        isDirty: document.isDirty,
        documentVersion: document.documentVersion,
        lineCount: document.lineCount,
        capturedAt: document.capturedAt,
      };
      if (cursor) {
        editorContext.cursor = cursor;
      }
      if (selection) {
        editorContext.selection = {
          startLine: selection.startLine,
          startColumn: selection.startColumn,
          endLine: selection.endLine,
          endColumn: selection.endColumn,
        };
      }

      const verdict = inspectPath(document.path);
      if (verdict.blocked) {
        // Metadata still travels; content does not. The coach is told why,
        // rather than being handed a file that looks empty (spec §40).
        notes.push(`Content of ${document.path} was withheld: ${verdict.reason}.`);
      } else {
        if (selection) {
          const trimmed = truncate(selection.content, budget.maxFileCharacters);
          const item: SelectionContextItem = {
            type: "selection",
            path: selection.path,
            language: selection.language,
            startLine: selection.startLine,
            startColumn: selection.startColumn,
            endLine: selection.endLine,
            endColumn: selection.endColumn,
            content: trimmed.content,
            isDirty: selection.isDirty,
          };
          if (trimmed.truncation) {
            item.truncation = trimmed.truncation;
            notes.push(
              `Selection truncated to ${trimmed.truncation.includedCharacters} of ${trimmed.truncation.originalCharacters} characters.`,
            );
          }
          items.push(item);
        }

        const trimmedBuffer = truncate(document.content, budget.maxFileCharacters);
        const bufferItem: FileContextItem = {
          type: "file",
          path: document.path,
          source: document.source,
          language: document.language,
          content: trimmedBuffer.content,
          isDirty: document.isDirty,
          documentVersion: document.documentVersion,
          truncated: trimmedBuffer.truncation !== undefined,
        };
        if (trimmedBuffer.truncation) {
          bufferItem.truncation = trimmedBuffer.truncation;
          notes.push(
            `Active buffer truncated to ${trimmedBuffer.truncation.includedCharacters} of ${trimmedBuffer.truncation.originalCharacters} characters.`,
          );
        }
        items.push(bufferItem);
      }

      const diagnostics = this.editor.getDiagnostics();
      if (diagnostics.length > 0) {
        const included = diagnostics.slice(0, budget.maxDiagnosticItems);
        const diagnosticsItem: DiagnosticContextItem = {
          type: "diagnostics",
          path: document.path,
          diagnostics: included,
        };
        if (diagnostics.length > included.length) {
          diagnosticsItem.omittedCount = diagnostics.length - included.length;
          notes.push(`${diagnosticsItem.omittedCount} diagnostics omitted by the context budget.`);
        }
        items.push(diagnosticsItem);
      }
    } else {
      notes.push("No active text editor when the message was sent.");
    }

    const kept = this.applyTotalBudget(items, budget, notes);

    for (const note of notes) {
      kept.push({ type: "note", note });
    }

    const request: CoachRequest = {
      id: createRequestId(),
      sessionId: input.sessionId,
      createdAt: new Date().toISOString(),
      message: input.message,
      workspace,
      contextItems: kept,
      attachments: input.attachments ?? [],
      clientCapabilities: this.tools.getCapabilities(),
      availableTools: this.tools.list(),
    };
    if (editorContext) {
      request.editor = editorContext;
    }
    if (input.learning) {
      request.learning = input.learning;
    }

    return { request, notes };
  }

  /**
   * Total-size budget (spec §13). Drops whole items rather than shaving
   * characters off each one, so nothing arrives subtly incomplete. Least
   * valuable goes first: the full buffer, then diagnostics. The selection is
   * what the user was pointing at, so it is dropped last.
   */
  private applyTotalBudget(
    items: ContextItem[],
    budget: ContextBudget,
    notes: string[],
  ): ContextItem[] {
    const dropOrder: ContextItem["type"][] = ["file", "diagnostics", "selection"];
    const kept = [...items];

    const total = (): number => kept.reduce((sum, item) => sum + contextItemCharacters(item), 0);

    for (const type of dropOrder) {
      if (total() <= budget.maxCharacters) {
        break;
      }
      const index = kept.findIndex((item) => item.type === type);
      if (index >= 0) {
        kept.splice(index, 1);
        notes.push(`Dropped "${type}" context: request exceeded ${budget.maxCharacters} characters.`);
      }
    }

    return kept;
  }
}
