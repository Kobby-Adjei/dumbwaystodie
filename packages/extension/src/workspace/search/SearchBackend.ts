import type { SearchEngine, SearchMatch } from "@dumbways/protocol";

/**
 * A search engine the workspace adapter can delegate to.
 *
 * Two exist: ripgrep (preferred — linear-time regex, out-of-process, fast) and
 * a Node traversal (always available, literal only). Both must produce
 * identical results for the same literal query, or the same question would
 * quietly get different answers depending on which machine ran it.
 *
 * That is why both are driven by the same explicit ignore list rather than
 * ripgrep's own defaults: ripgrep would otherwise honour `.gitignore` and skip
 * hidden files, and the fallback would not.
 */
export interface SearchBackendRequest {
  rootAbsolutePath: string;
  /** Workspace-relative path of the root, "." for the workspace root. */
  rootRelativePath: string;

  query: string;
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;

  globs?: string[];
  /** Files handled elsewhere (open unsaved buffers), excluded from the walk. */
  skipPaths: string[];

  ignoredDirectories: string[];
  maxResults: number;
  maxMatchesPerFile: number;
  maxFileBytes: number;

  signal?: AbortSignal;
}

export interface SearchBackendOutcome {
  matches: SearchMatch[];
  totalMatches: number;
  /** Distinct files that produced at least one match. */
  filesWithMatches: number;
  truncated: boolean;
  omittedCount: number;
}

export interface SearchBackend {
  readonly engine: SearchEngine;
  readonly supportsRegex: boolean;
  readonly supportsWholeWord: boolean;

  search(request: SearchBackendRequest): Promise<SearchBackendOutcome>;

  /**
   * Searches in-memory content — an unsaved editor buffer — with exactly the
   * same engine and flags as the disk walk.
   *
   * This has to go through the backend rather than a local regex: if disk
   * matching used ripgrep while buffers used a JavaScript regex, a regex query
   * would silently match different things depending on whether the file
   * happened to be open, and the unsafe engine would be back in the process.
   */
  searchBuffer(content: string, request: SearchBackendRequest): Promise<BufferMatch[]>;
}

export interface BufferMatch {
  /** 1-based. */
  line: number;
  preview: string;
}
