import * as vscode from "vscode";

import type {
  CursorSnapshot,
  DiagnosticSeverity,
  DiagnosticSnapshot,
  DocumentSnapshot,
  SelectionSnapshot,
  WorkspaceContext,
} from "@dumbways/protocol";

import type { EditorAdapter } from "./EditorAdapter";

/**
 * The only file in the extension that converts VS Code's model into protocol
 * types. Two conversions matter and are done exactly once, here:
 *
 *  - VS Code positions are 0-based; the protocol is 1-based (spec §context).
 *  - `document.getText()` is the live buffer. It already includes unsaved
 *    edits, so dirty state never needs a disk read to reconcile (spec §3.3).
 */
export class VsCodeEditorAdapter implements EditorAdapter, vscode.Disposable {
  private lastActive: vscode.TextEditor | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.lastActive = vscode.window.activeTextEditor;
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        // Moving focus into our sidebar webview can clear activeTextEditor.
        // Remembering the last real text editor keeps "what am I looking at?"
        // answerable while the user is typing in the panel.
        if (editor && isCapturable(editor)) {
          this.lastActive = editor;
        }
      }),
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  getWorkspaceContext(): WorkspaceContext {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return {
      name: vscode.workspace.name ?? folders[0]?.name ?? "(no workspace)",
      roots: folders.map((folder) => folder.uri.fsPath),
    };
  }

  getActiveDocumentSnapshot(): DocumentSnapshot | null {
    const editor = this.resolveEditor();
    if (!editor) {
      return null;
    }

    const document = editor.document;
    return {
      path: this.displayPath(document.uri),
      absolutePath: document.uri.scheme === "file" ? document.uri.fsPath : document.uri.toString(),
      language: document.languageId,
      isDirty: document.isDirty,
      documentVersion: document.version,
      lineCount: document.lineCount,
      capturedAt: new Date().toISOString(),
      source: "editor-buffer",
      content: document.getText(),
    };
  }

  getSelection(): SelectionSnapshot | null {
    const editor = this.resolveEditor();
    if (!editor || editor.selection.isEmpty) {
      return null;
    }

    const { document, selection } = editor;
    return {
      path: this.displayPath(document.uri),
      language: document.languageId,
      startLine: selection.start.line + 1,
      startColumn: selection.start.character + 1,
      endLine: selection.end.line + 1,
      endColumn: selection.end.character + 1,
      content: document.getText(selection),
      isDirty: document.isDirty,
      capturedAt: new Date().toISOString(),
    };
  }

  getCursor(): CursorSnapshot | null {
    const editor = this.resolveEditor();
    if (!editor) {
      return null;
    }
    const position = editor.selection.active;
    return { line: position.line + 1, column: position.character + 1 };
  }

  getDiagnostics(): DiagnosticSnapshot[] {
    const editor = this.resolveEditor();
    if (!editor) {
      return [];
    }
    return this.diagnosticsForUri(editor.document.uri);
  }

  getDiagnosticsForFile(absolutePath: string): DiagnosticSnapshot[] {
    return this.diagnosticsForUri(vscode.Uri.file(absolutePath));
  }

  getDocumentSnapshotFor(absolutePath: string): DocumentSnapshot | null {
    const document = vscode.workspace.textDocuments.find(
      (candidate) =>
        candidate.uri.scheme === "file" &&
        !candidate.isClosed &&
        pathsEqual(candidate.uri.fsPath, absolutePath),
    );
    if (!document) {
      return null;
    }

    return {
      path: this.displayPath(document.uri),
      absolutePath: document.uri.fsPath,
      language: document.languageId,
      isDirty: document.isDirty,
      documentVersion: document.version,
      lineCount: document.lineCount,
      capturedAt: new Date().toISOString(),
      source: "editor-buffer",
      content: document.getText(),
    };
  }

  getDirtyDocuments(): DocumentSnapshot[] {
    return vscode.workspace.textDocuments
      .filter((document) => document.isDirty && !document.isClosed && isCapturableUri(document.uri))
      .map((document) => ({
        path: this.displayPath(document.uri),
        absolutePath:
          document.uri.scheme === "file" ? document.uri.fsPath : document.uri.toString(),
        language: document.languageId,
        isDirty: true,
        documentVersion: document.version,
        lineCount: document.lineCount,
        capturedAt: new Date().toISOString(),
        source: "editor-buffer" as const,
        content: document.getText(),
      }));
  }

  private diagnosticsForUri(uri: vscode.Uri): DiagnosticSnapshot[] {
    const path = this.displayPath(uri);

    return vscode.languages.getDiagnostics(uri).map((diagnostic) => {
      const snapshot: DiagnosticSnapshot = {
        path,
        severity: toSeverity(diagnostic.severity),
        message: diagnostic.message,
        line: diagnostic.range.start.line + 1,
        column: diagnostic.range.start.character + 1,
      };
      if (diagnostic.source) {
        snapshot.source = diagnostic.source;
      }
      const code = diagnostic.code;
      if (typeof code === "string" || typeof code === "number") {
        snapshot.code = code;
      } else if (code && typeof code === "object" && "value" in code) {
        snapshot.code = code.value;
      }
      return snapshot;
    });
  }

  /**
   * Milestone A captures real files and untitled buffers only. Read-only
   * virtual documents (git diffs, output channels, extension previews) are
   * skipped rather than being reported as the file the user is editing — and
   * focusing one falls back to the last real editor instead of blanking the
   * panel.
   */
  private resolveEditor(): vscode.TextEditor | undefined {
    const active = vscode.window.activeTextEditor;
    if (active && isCapturable(active)) {
      return active;
    }

    // A remembered editor whose document was closed is stale context.
    if (this.lastActive?.document.isClosed) {
      this.lastActive = undefined;
    }

    return this.lastActive;
  }

  private displayPath(uri: vscode.Uri): string {
    if (uri.scheme === "untitled") {
      return uri.path;
    }
    return vscode.workspace.asRelativePath(uri, false);
  }
}

function isCapturableUri(uri: vscode.Uri): boolean {
  return uri.scheme === "file" || uri.scheme === "untitled";
}

function isCapturable(editor: vscode.TextEditor): boolean {
  return isCapturableUri(editor.document.uri);
}

/**
 * macOS and Windows filesystems are usually case-insensitive, so a provider
 * asking for `SRC/App.ts` should still match the open `src/app.ts` buffer.
 * Both paths are already realpath-resolved by the workspace adapter.
 */
function pathsEqual(a: string, b: string): boolean {
  return process.platform === "linux" ? a === b : a.toLowerCase() === b.toLowerCase();
}

function toSeverity(severity: vscode.DiagnosticSeverity): DiagnosticSeverity {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    case vscode.DiagnosticSeverity.Hint:
      return "hint";
    default:
      return "info";
  }
}
