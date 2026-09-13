import { promises as fs } from "node:fs";
import * as nodePath from "node:path";

import type { SearchMatch } from "@dumbways/protocol";

import { inspectPath } from "../../security/secretFilter";
import { ToolExecutionError } from "../../tools/ToolExecutionError";
import { findMatchesInText, matchesAnyGlob } from "../search";
import type {
  BufferMatch,
  SearchBackend,
  SearchBackendOutcome,
  SearchBackendRequest,
} from "./SearchBackend";

const BINARY_SNIFF_BYTES = 8192;

/**
 * The always-available fallback: a plain Node traversal.
 *
 * Literal matching only, and that is not a stylistic choice. Running a
 * provider-supplied regex through JavaScript's backtracking engine can block
 * the extension host indefinitely — `(a+)+$` against thirty characters never
 * returns — and because the block is synchronous, no timeout on the same
 * thread can interrupt it. Rather than pretend otherwise, this backend refuses
 * regex and says which backend can do it.
 */
export class NodeSearchBackend implements SearchBackend {
  readonly engine = "node" as const;
  readonly supportsRegex = false;
  readonly supportsWholeWord = false;

  async search(request: SearchBackendRequest): Promise<SearchBackendOutcome> {
    if (request.isRegex) {
      throw new ToolExecutionError(
        "UNSUPPORTED",
        "Regular-expression search needs the ripgrep backend, which was not found. Retry with a literal query (isRegex: false).",
      );
    }
    if (request.wholeWord) {
      throw new ToolExecutionError(
        "UNSUPPORTED",
        "Whole-word search needs the ripgrep backend, which was not found. Retry without wholeWord.",
      );
    }

    const matches: SearchMatch[] = [];
    const queue = [{ absolute: request.rootAbsolutePath, relative: request.rootRelativePath }];
    // Files with matches, not files examined — ripgrep cannot report the
    // latter, and the two backends must agree (see SearchBackend).
    const filesWithMatches = new Set<string>();
    let omittedCount = 0;
    let totalMatches = 0;
    let truncated = false;

    while (queue.length > 0) {
      request.signal?.throwIfAborted();

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

      for (const dirent of dirents) {
        const relative =
          current.relative === "." ? dirent.name : `${current.relative}/${dirent.name}`;
        const absolute = nodePath.join(current.absolute, dirent.name);

        if (dirent.isDirectory()) {
          if (request.ignoredDirectories.includes(dirent.name) || inspectPath(relative).blocked) {
            omittedCount += 1;
            continue;
          }
          queue.push({ absolute, relative });
          continue;
        }

        if (!dirent.isFile() || inspectPath(relative).blocked) {
          omittedCount += 1;
          continue;
        }
        if (request.skipPaths.includes(relative)) {
          continue;
        }
        if (!matchesAnyGlob(relative, request.globs)) {
          continue;
        }

        const stats = await fs.stat(absolute).catch(() => undefined);
        if (!stats || stats.size > request.maxFileBytes) {
          omittedCount += 1;
          continue;
        }

        const buffer = await fs.readFile(absolute).catch(() => undefined);
        if (!buffer || looksBinary(buffer)) {
          omittedCount += 1;
          continue;
        }

        const fileMatches = findMatchesInText(buffer.toString("utf8"), request.query, {
          caseSensitive: request.caseSensitive,
          maxMatches: request.maxMatchesPerFile,
        });

        for (const match of fileMatches) {
          totalMatches += 1;
          filesWithMatches.add(relative);
          if (matches.length >= request.maxResults) {
            truncated = true;
            continue;
          }
          matches.push({
            path: relative,
            line: match.line,
            preview: match.preview,
            source: "filesystem",
          });
        }
      }
    }

    return {
      matches,
      totalMatches,
      filesWithMatches: filesWithMatches.size,
      truncated,
      omittedCount,
    };
  }

  async searchBuffer(content: string, request: SearchBackendRequest): Promise<BufferMatch[]> {
    if (request.isRegex || request.wholeWord) {
      throw new ToolExecutionError(
        "UNSUPPORTED",
        "Regular-expression and whole-word search need the ripgrep backend, which was not found.",
      );
    }
    return findMatchesInText(content, request.query, {
      caseSensitive: request.caseSensitive,
      maxMatches: request.maxMatchesPerFile,
    });
  }
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
