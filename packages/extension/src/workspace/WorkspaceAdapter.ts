import type {
  DirectoryEntry,
  ProjectTreeEntry,
  SearchEngine,
  SearchMatch,
  WorkspaceRootRef,
} from "@dumbways/protocol";

/**
 * Filesystem-side context (spec §3.1).
 *
 * Separate from the editor adapter on purpose: this one knows about bytes on
 * disk and nothing about what the user is looking at. Where the two disagree —
 * an open file with unsaved changes — the editor wins, and the tool that reads
 * files says which source it used.
 *
 * Phase 4 implements the read surface only. Search, git and command execution
 * are later phases.
 */

export interface ResolvedPath {
  /** Workspace-relative, normalized, forward slashes. */
  relativePath: string;
  absolutePath: string;
  root: WorkspaceRootRef;
}

export interface DiskFileContent {
  totalLines: number;
  content: string;
}

export interface DirectoryListing {
  entries: DirectoryEntry[];
  truncated: boolean;
  omittedCount: number;
}

export interface SearchOptions {
  query: string;
  /** Served by ripgrep only; refused when it is unavailable. */
  isRegex?: boolean;
  wholeWord?: boolean;
  globs?: string[];
  caseSensitive?: boolean;
  maxResults: number;
  /** Cap per file, so one generated file cannot consume the whole budget. */
  maxMatchesPerFile: number;
  /**
   * Workspace-relative paths to skip entirely. Used for files with unsaved
   * buffers, which the tool layer searches in memory instead — so disk totals
   * and buffer totals never double-count.
   */
  skipPaths?: string[];
  /** Cancels the underlying engine, including killing a ripgrep process. */
  signal?: AbortSignal;
}

export interface SearchOutcome {
  matches: SearchMatch[];
  totalMatches: number;
  filesWithMatches: number;
  truncated: boolean;
  omittedCount: number;
  /** Which engine answered, so the result can say so. */
  engine: SearchEngine;
}

export interface ProjectTreeOutcome {
  entries: ProjectTreeEntry[];
  truncated: boolean;
  omittedCount: number;
}

export interface WorkspaceAdapter {
  getWorkspaceRoots(): WorkspaceRootRef[];

  /**
   * Resolves a provider-supplied path and proves it exists inside a workspace
   * root. Throws ToolExecutionError otherwise — never returns an unchecked
   * path.
   */
  resolvePath(relativePath: string): Promise<ResolvedPath>;

  readDiskFile(target: ResolvedPath): Promise<DiskFileContent>;

  listDirectory(target: ResolvedPath, maxEntries: number): Promise<DirectoryListing>;

  /**
   * Literal text search over files on disk, bounded by ignore rules, globs and
   * result caps. Unsaved editor buffers are the tool layer's job to overlay —
   * this adapter only knows about disk.
   */
  searchFiles(target: ResolvedPath, options: SearchOptions): Promise<SearchOutcome>;

  /**
   * Searches in-memory content with the same engine and flags as searchFiles,
   * so unsaved buffers and disk files are matched identically.
   */
  searchBuffer(
    content: string,
    options: SearchOptions,
  ): Promise<{ line: number; preview: string }[]>;

  /** Bounded, breadth-first file tree (spec §15.4, §64). */
  projectTree(target: ResolvedPath, maxEntries: number): Promise<ProjectTreeOutcome>;
}
