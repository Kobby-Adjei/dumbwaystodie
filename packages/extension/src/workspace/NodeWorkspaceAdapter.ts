import { promises as fs } from "node:fs";
import * as nodePath from "node:path";

import type {
  DirectoryEntry,
  ProjectTreeEntry,
  SearchMatch,
  WorkspaceRootRef,
} from "@dumbways/protocol";

import { ToolExecutionError } from "../tools/ToolExecutionError";
import { inspectPath } from "../security/secretFilter";
import { NodeSearchBackend } from "./search/NodeSearchBackend";
import type { SearchBackend, SearchBackendRequest } from "./search/SearchBackend";
import type {
  DirectoryListing,
  DiskFileContent,
  ProjectTreeOutcome,
  ResolvedPath,
  SearchOptions,
  SearchOutcome,
  WorkspaceAdapter,
} from "./WorkspaceAdapter";

/** Spec §15.4, overridable through settings. */
export const DEFAULT_IGNORED_DIRECTORIES = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".turbo",
  "coverage",
  ".venv",
  "__pycache__",
];

/** Refuse to load huge files into memory at all (spec §61). */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** A NUL byte in the first block means this is not UTF-8 text (spec §72). */
const BINARY_SNIFF_BYTES = 8192;

export class NodeWorkspaceAdapter implements WorkspaceAdapter {
  constructor(
    private readonly getRoots: () => WorkspaceRootRef[],
    private readonly getIgnoredDirectories: () => string[] = () => DEFAULT_IGNORED_DIRECTORIES,
    /**
     * Ripgrep when the host provides it, Node otherwise. Injected rather than
     * discovered here so this class stays free of any editor API.
     */
    private readonly searchBackend: SearchBackend = new NodeSearchBackend(),
  ) {}

  get searchEngine(): SearchBackend {
    return this.searchBackend;
  }

  getWorkspaceRoots(): WorkspaceRootRef[] {
    return this.getRoots();
  }

  private isIgnoredDirectory(name: string): boolean {
    return this.getIgnoredDirectories().includes(name);
  }

  /**
   * Workspace boundary enforcement (spec §39).
   *
   * The boundary is checked twice, in this order, and both checks matter:
   *
   *  1. lexically, on the resolved path — catches `../../etc/passwd` even when
   *     the target does not exist. Checking only after realpath would skip the
   *     boundary entirely for any escaping path that happens to be missing,
   *     and report it as NOT_FOUND, which is the wrong diagnosis.
   *  2. after realpath — catches a symlink inside the workspace pointing out
   *     of it, which no amount of string comparison can see.
   */
  async resolvePath(relativePath: string): Promise<ResolvedPath> {
    if (typeof relativePath !== "string") {
      throw new ToolExecutionError("INVALID_ARGUMENT", "path must be a string.");
    }

    const requested = relativePath.trim();
    if (requested.length === 0) {
      throw new ToolExecutionError("INVALID_ARGUMENT", "path must not be empty.");
    }
    if (requested.includes("\0")) {
      throw new ToolExecutionError("INVALID_ARGUMENT", "path contains a null byte.");
    }

    const roots = this.getRoots();
    if (roots.length === 0) {
      throw new ToolExecutionError("NOT_FOUND", "No workspace folder is open.");
    }

    let outsideError: ToolExecutionError | undefined;
    let missingError: ToolExecutionError | undefined;

    for (const root of roots) {
      const candidate = nodePath.resolve(root.path, requested);

      // (1) Lexical check, before the filesystem is touched at all.
      if (!isInside(nodePath.resolve(root.path), candidate)) {
        outsideError = new ToolExecutionError(
          "OUTSIDE_WORKSPACE",
          `Path escapes the workspace: ${requested}`,
          { root: root.name },
        );
        continue;
      }

      let realRoot: string;
      try {
        realRoot = await fs.realpath(root.path);
      } catch {
        continue;
      }

      let realCandidate: string;
      try {
        realCandidate = await fs.realpath(candidate);
      } catch {
        // Phase 4 has only read tools, so a path that does not exist is an
        // error rather than a location to be resolved. Write tools will need
        // to relax this deliberately.
        missingError = new ToolExecutionError("NOT_FOUND", `Path not found: ${requested}`);
        continue;
      }

      // (2) Real check, after symlinks have been followed.
      if (!isInside(realRoot, realCandidate)) {
        outsideError = new ToolExecutionError(
          "OUTSIDE_WORKSPACE",
          `Path escapes the workspace: ${requested}`,
          { root: root.name },
        );
        continue;
      }

      const normalized = toPosix(nodePath.relative(realRoot, realCandidate)) || ".";

      // Secret filtering applies to tool reads exactly as it applies to
      // automatic context (spec §40). A coach asking nicely does not change
      // what a private key is.
      const verdict = inspectPath(normalized);
      if (verdict.blocked) {
        throw new ToolExecutionError(
          "PERMISSION_DENIED",
          `Refused: ${normalized} — ${verdict.reason}.`,
          { path: normalized },
        );
      }

      return { relativePath: normalized, absolutePath: realCandidate, root };
    }

    // "Inside a root but absent" is more informative than "outside some other
    // root", so a NOT_FOUND from any root wins over an OUTSIDE_WORKSPACE.
    throw (
      missingError ??
      outsideError ??
      new ToolExecutionError("NOT_FOUND", `Path not found: ${requested}`)
    );
  }

  async readDiskFile(target: ResolvedPath): Promise<DiskFileContent> {
    const stats = await fs.stat(target.absolutePath).catch(() => {
      throw new ToolExecutionError("NOT_FOUND", `File not found: ${target.relativePath}`);
    });

    if (stats.isDirectory()) {
      throw new ToolExecutionError(
        "INVALID_ARGUMENT",
        `${target.relativePath} is a directory. Use ${"workspace.list_directory"}.`,
      );
    }
    if (!stats.isFile()) {
      throw new ToolExecutionError("UNSUPPORTED", `${target.relativePath} is not a regular file.`);
    }
    if (stats.size > MAX_FILE_BYTES) {
      throw new ToolExecutionError(
        "TOO_LARGE",
        `${target.relativePath} is ${stats.size} bytes, over the ${MAX_FILE_BYTES} byte limit.`,
        { size: stats.size, limit: MAX_FILE_BYTES },
      );
    }

    const buffer = await fs.readFile(target.absolutePath);
    if (looksBinary(buffer)) {
      throw new ToolExecutionError(
        "UNSUPPORTED",
        `UNSUPPORTED_BINARY_FILE: ${target.relativePath} is not UTF-8 text.`,
      );
    }

    const content = buffer.toString("utf8");
    return { content, totalLines: countLines(content) };
  }

  async listDirectory(target: ResolvedPath, maxEntries: number): Promise<DirectoryListing> {
    const dirents = await fs.readdir(target.absolutePath, { withFileTypes: true }).catch(() => {
      throw new ToolExecutionError("NOT_FOUND", `Directory not found: ${target.relativePath}`);
    });

    const entries: DirectoryEntry[] = [];
    let omittedCount = 0;

    for (const dirent of dirents) {
      if (dirent.isDirectory() && this.isIgnoredDirectory(dirent.name)) {
        omittedCount += 1;
        continue;
      }

      const childRelative =
        target.relativePath === "." ? dirent.name : `${target.relativePath}/${dirent.name}`;

      if (inspectPath(childRelative).blocked) {
        omittedCount += 1;
        continue;
      }

      entries.push({
        name: dirent.name,
        path: childRelative,
        type: dirent.isDirectory() ? "directory" : dirent.isFile() ? "file" : "other",
      });
    }

    entries.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    const truncated = entries.length > maxEntries;
    return {
      entries: truncated ? entries.slice(0, maxEntries) : entries,
      truncated,
      omittedCount,
    };
  }

  /**
   * Breadth-first, so a cap truncates the deep corners rather than everything
   * after the first alphabetical directory. The shallow structure is the part
   * that tells you what a project is.
   */
  async projectTree(target: ResolvedPath, maxEntries: number): Promise<ProjectTreeOutcome> {
    const entries: ProjectTreeEntry[] = [];
    const queue: { absolute: string; relative: string }[] = [
      { absolute: target.absolutePath, relative: target.relativePath },
    ];
    let omittedCount = 0;
    let truncated = false;

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        break;
      }

      const dirents = await fs
        .readdir(current.absolute, { withFileTypes: true })
        .catch(() => undefined);
      if (!dirents) {
        omittedCount += 1;
        continue;
      }

      const sorted = [...dirents].sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) {
          return a.isDirectory() ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      for (const dirent of sorted) {
        const relative =
          current.relative === "." ? dirent.name : `${current.relative}/${dirent.name}`;

        if (dirent.isDirectory() && this.isIgnoredDirectory(dirent.name)) {
          omittedCount += 1;
          continue;
        }
        if (inspectPath(relative).blocked) {
          omittedCount += 1;
          continue;
        }
        if (!dirent.isDirectory() && !dirent.isFile()) {
          omittedCount += 1;
          continue;
        }

        if (entries.length >= maxEntries) {
          truncated = true;
          omittedCount += 1;
          continue;
        }

        entries.push({ path: relative, type: dirent.isDirectory() ? "directory" : "file" });

        if (dirent.isDirectory()) {
          queue.push({ absolute: nodePath.join(current.absolute, dirent.name), relative });
        }
      }
    }

    return { entries, truncated, omittedCount };
  }

  /**
   * Delegates to whichever backend the host supplied. Both are driven by the
   * same ignore list and the same caps, so a literal query returns the same
   * answer either way — only the speed and the regex support differ.
   */
  async searchFiles(target: ResolvedPath, options: SearchOptions): Promise<SearchOutcome> {
    const request: SearchBackendRequest = {
      ...this.toBackendRequest(options),
      rootAbsolutePath: target.absolutePath,
      rootRelativePath: target.relativePath,
    };

    const outcome = await this.searchBackend.search(request);
    return { ...outcome, engine: this.searchBackend.engine };
  }

  async searchBuffer(
    content: string,
    options: SearchOptions,
  ): Promise<{ line: number; preview: string }[]> {
    return this.searchBackend.searchBuffer(content, this.toBackendRequest(options));
  }

  private toBackendRequest(options: SearchOptions): SearchBackendRequest {
    const request: SearchBackendRequest = {
      rootAbsolutePath: this.getRoots()[0]?.path ?? process.cwd(),
      rootRelativePath: ".",
      query: options.query,
      isRegex: options.isRegex ?? false,
      caseSensitive: options.caseSensitive ?? false,
      wholeWord: options.wholeWord ?? false,
      skipPaths: options.skipPaths ?? [],
      ignoredDirectories: this.getIgnoredDirectories(),
      maxResults: options.maxResults,
      maxMatchesPerFile: options.maxMatchesPerFile,
      maxFileBytes: MAX_FILE_BYTES,
    };
    if (options.globs) {
      request.globs = options.globs;
    }
    if (options.signal) {
      request.signal = options.signal;
    }
    return request;
  }
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + nodePath.sep);
}

function toPosix(value: string): string {
  return value.split(nodePath.sep).join("/");
}

function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  return content.split(/\r\n|\r|\n/).length;
}
