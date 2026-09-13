import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import * as nodePath from "node:path";

import type { SearchMatch } from "@dumbways/protocol";

import { inspectPath } from "../../security/secretFilter";
import { ToolExecutionError } from "../../tools/ToolExecutionError";
import { makePreview } from "../search";
import type {
  BufferMatch,
  SearchBackend,
  SearchBackendOutcome,
  SearchBackendRequest,
} from "./SearchBackend";

/**
 * Ripgrep backend (spec §15.5).
 *
 * Chosen for two reasons, and the second matters more than the speed:
 *
 *  1. It is dramatically faster than walking the tree in Node.
 *  2. Its regex engine is a finite automaton — linear time, no catastrophic
 *     backtracking — and it runs in a child process that can be killed. A
 *     JavaScript regex can neither be bounded nor interrupted: `(a+)+$`
 *     against thirty characters blocks the thread indefinitely, and a timeout
 *     scheduled on that same thread never fires.
 *
 * That is what makes it safe to accept a pattern from an untrusted provider
 * (spec §75).
 */

/** Where VS Code and its forks keep the binary, relative to `env.appRoot`. */
export const RIPGREP_APP_SUBPATHS = [
  "node_modules/@vscode/ripgrep/bin/rg",
  "node_modules.asar.unpacked/@vscode/ripgrep/bin/rg",
];

export function ripgrepCandidatePaths(appRoot: string | undefined): string[] {
  if (!appRoot) {
    return [];
  }
  return RIPGREP_APP_SUBPATHS.map((subPath) => nodePath.join(appRoot, ...subPath.split("/")));
}

/**
 * Returns the first candidate that exists and is executable.
 *
 * Synchronous on purpose: this is one stat at activation, and doing it inline
 * means the adapter is built with the right backend instead of starting on the
 * wrong one and swapping later.
 */
export function resolveRipgrepPath(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next one. A missing binary is normal, not an error.
    }
  }
  return undefined;
}

interface RipgrepMatchLine {
  type: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
  };
}

export class RipgrepSearchBackend implements SearchBackend {
  readonly engine = "ripgrep" as const;
  readonly supportsRegex = true;
  readonly supportsWholeWord = true;

  constructor(private readonly binaryPath: string) {}

  async search(request: SearchBackendRequest): Promise<SearchBackendOutcome> {
    const args = this.buildArgs(request);
    const raw = await this.run(args, request);

    const matches: SearchMatch[] = [];
    const files = new Set<string>();
    const perFile = new Map<string, number>();
    let totalMatches = 0;
    let truncated = false;
    let omittedCount = 0;

    for (const line of raw.split("\n")) {
      if (line.length === 0) {
        continue;
      }

      let parsed: RipgrepMatchLine;
      try {
        parsed = JSON.parse(line) as RipgrepMatchLine;
      } catch {
        continue;
      }
      if (parsed.type !== "match") {
        continue;
      }

      const relativeToRoot = parsed.data?.path?.text;
      const lineNumber = parsed.data?.line_number;
      const text = parsed.data?.lines?.text;
      if (!relativeToRoot || lineNumber === undefined || text === undefined) {
        continue;
      }

      const path = this.toWorkspacePath(request, relativeToRoot);

      // Belt and braces: ripgrep is told to exclude these, and results are
      // checked again. A secret file must not leak because a glob was wrong.
      if (inspectPath(path).blocked || request.skipPaths.includes(path)) {
        omittedCount += 1;
        continue;
      }

      const seen = perFile.get(path) ?? 0;
      if (seen >= request.maxMatchesPerFile) {
        continue;
      }
      perFile.set(path, seen + 1);

      files.add(path);
      totalMatches += 1;

      if (matches.length >= request.maxResults) {
        truncated = true;
        continue;
      }

      matches.push({
        path,
        line: lineNumber,
        preview: makePreview(text.replace(/\r?\n$/, "")),
        source: "filesystem",
      });
    }

    return {
      matches,
      totalMatches,
      filesWithMatches: files.size,
      truncated,
      omittedCount,
    };
  }

  /**
   * Searches an unsaved buffer by piping it to ripgrep on stdin — same binary,
   * same flags, so buffer results and disk results are produced by one engine.
   */
  async searchBuffer(content: string, request: SearchBackendRequest): Promise<BufferMatch[]> {
    const args = [
      "--json",
      "--no-config",
      `--max-count=${request.maxMatchesPerFile}`,
      request.caseSensitive ? "--case-sensitive" : "--ignore-case",
    ];
    if (request.wholeWord) {
      args.push("--word-regexp");
    }
    if (!request.isRegex) {
      args.push("--fixed-strings");
    }
    args.push("--regexp", request.query, "-");

    const raw = await this.run(args, request, content);
    const matches: BufferMatch[] = [];

    for (const line of raw.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      let parsed: RipgrepMatchLine;
      try {
        parsed = JSON.parse(line) as RipgrepMatchLine;
      } catch {
        continue;
      }
      if (parsed.type !== "match") {
        continue;
      }
      const lineNumber = parsed.data?.line_number;
      const text = parsed.data?.lines?.text;
      if (lineNumber === undefined || text === undefined) {
        continue;
      }
      matches.push({ line: lineNumber, preview: makePreview(text.replace(/\r?\n$/, "")) });
    }

    return matches;
  }

  private buildArgs(request: SearchBackendRequest): string[] {
    const args = [
      "--json",
      // Never read a user ripgreprc: search behaviour must not depend on a
      // config file this bridge cannot see.
      "--no-config",
      // Our explicit ignore list is the only source of truth, so results match
      // the Node backend exactly (see SearchBackend).
      "--no-ignore",
      "--hidden",
      "--no-follow",
      `--max-filesize=${request.maxFileBytes}`,
      // Ask for slightly more than the cap so "truncated" can be detected.
      `--max-count=${request.maxMatchesPerFile + 1}`,
    ];

    args.push(request.caseSensitive ? "--case-sensitive" : "--ignore-case");
    if (request.wholeWord) {
      args.push("--word-regexp");
    }
    if (!request.isRegex) {
      args.push("--fixed-strings");
    }

    for (const directory of request.ignoredDirectories) {
      args.push("--glob", `!${directory}/**`, "--glob", `!${directory}`);
    }
    for (const glob of request.globs ?? []) {
      args.push("--glob", glob);
    }

    args.push("--regexp", request.query, "--", ".");
    return args;
  }

  private run(
    args: string[],
    request: SearchBackendRequest,
    stdin?: string,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.binaryPath, args, {
        cwd: request.rootAbsolutePath,
        // No shell: the query is passed as an argv entry, never interpolated
        // into a command line.
        shell: false,
      });

      if (stdin !== undefined) {
        child.stdin.on("error", () => {
          // A closed pipe (ripgrep exiting early on --max-count) is not a
          // failure of the search itself.
        });
        child.stdin.end(stdin, "utf8");
      }

      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (action: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        request.signal?.removeEventListener("abort", onAbort);
        action();
      };

      function onAbort(): void {
        child.kill("SIGKILL");
        finish(() =>
          reject(new ToolExecutionError("TIMEOUT", "Search was cancelled before it finished.")),
        );
      }

      request.signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (error) => {
        finish(() =>
          reject(
            new ToolExecutionError("EXECUTION_FAILED", `Could not run search: ${error.message}`),
          ),
        );
      });

      child.on("close", (code) => {
        // 0 = matches, 1 = no matches, 2 = error.
        if (code === 0 || code === 1) {
          finish(() => resolve(stdout));
          return;
        }
        finish(() => reject(toSearchError(stderr)));
      });
    });
  }

  private toWorkspacePath(request: SearchBackendRequest, relativeToRoot: string): string {
    const normalized = relativeToRoot.split(nodePath.sep).join("/").replace(/^\.\//, "");
    return request.rootRelativePath === "."
      ? normalized
      : `${request.rootRelativePath}/${normalized}`;
  }
}

/**
 * A bad pattern is the provider's mistake, not an internal failure, so it comes
 * back as INVALID_ARGUMENT with ripgrep's own explanation.
 */
function toSearchError(stderr: string): ToolExecutionError {
  const message = stderr.trim().split("\n").slice(0, 3).join(" ").slice(0, 400);

  if (/regex parse error|error parsing regex|repetition quantifier|unclosed group/i.test(stderr)) {
    return new ToolExecutionError("INVALID_ARGUMENT", `Invalid search pattern: ${message}`);
  }
  return new ToolExecutionError("EXECUTION_FAILED", `Search failed: ${message || "unknown error"}`);
}
