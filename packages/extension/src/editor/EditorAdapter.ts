import type {
  CursorSnapshot,
  DiagnosticSnapshot,
  DocumentSnapshot,
  SelectionSnapshot,
  WorkspaceContext,
} from "@dumbways/protocol";

/**
 * Editor state, as distinct from filesystem state (spec §3).
 *
 * A terminal process can read files on disk. It cannot know which file is
 * focused, what is selected, or what has been typed but not saved. That is the
 * entire reason this adapter exists, and the reason it is an interface: the
 * context engine can then be tested with a fake, and a non-VS Code host
 * (spec §0E) can supply its own implementation without touching the engine.
 *
 * The methods VS Code exposes here are synchronous, so this interface is too.
 * The `EditorHost` abstraction in spec §0E is async because a remote host may
 * need it; that adapter arrives with the second host, not before.
 *
 * Not yet present, on purpose: visible editors and open-tab enumeration. Those
 * arrive when something actually needs them.
 */
export interface EditorAdapter {
  getWorkspaceContext(): WorkspaceContext;

  /** The LIVE buffer, including unsaved edits. Never disk content. */
  getActiveDocumentSnapshot(): DocumentSnapshot | null;

  /** Null when the selection is empty (a bare cursor is not a selection). */
  getSelection(): SelectionSnapshot | null;

  getCursor(): CursorSnapshot | null;

  /** Diagnostics for the active document. */
  getDiagnostics(): DiagnosticSnapshot[];

  /**
   * The open buffer for a specific file, if VS Code has one. Lets a file read
   * prefer unsaved editor content over disk (spec §3.3) instead of quietly
   * answering with a stale version.
   */
  getDocumentSnapshotFor(absolutePath: string): DocumentSnapshot | null;

  /** Diagnostics for a specific file, open or not. */
  getDiagnosticsForFile(absolutePath: string): DiagnosticSnapshot[];

  /**
   * Every open document with unsaved changes. Search overlays these on top of
   * disk results, so a coach searching for something the user just typed can
   * actually find it (spec §3.3).
   */
  getDirtyDocuments(): DocumentSnapshot[];
}
