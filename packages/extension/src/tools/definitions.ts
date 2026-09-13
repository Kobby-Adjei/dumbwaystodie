import * as nodePath from "node:path";

import {
  TOOL_NAMES,
  type ActiveDocumentArgs,
  type ActiveDocumentResult,
  type ContextBudget,
  type DiagnosticsArgs,
  type DiagnosticsResult,
  type ListDirectoryArgs,
  type ListDirectoryResult,
  type ProjectTreeArgs,
  type ProjectTreeResult,
  type ReadFileArgs,
  type ReadFileResult,
  type RunCommandArgs,
  type RunCommandResult,
  type SearchArgs,
  type SearchMatch,
  type SearchResult,
  type TruncationInfo,
} from "@dumbways/protocol";

import type { EditorAdapter } from "../editor/EditorAdapter";
import { inspectPath } from "../security/secretFilter";
import {
  DEFAULT_ENV_ALLOWLIST,
  runCommand,
  type RunCommandOptions,
} from "../shell/CommandRunner";
import { findMatchesInText, matchesAnyGlob } from "../workspace/search";
import type { SearchOptions, WorkspaceAdapter } from "../workspace/WorkspaceAdapter";
import { ToolExecutionError } from "./ToolExecutionError";
import type { ToolDefinition, ToolRegistry } from "./ToolRegistry";
import {
  expectArgs,
  optionalPositiveInteger,
  optionalString,
  requiredString,
} from "./validation";

/**
 * The Phase 4 tool set (spec §15.1-15.6, minus search which is Phase 5).
 *
 * All four are permission class `read`. Nothing here writes, executes, or
 * leaves the workspace. Timeouts follow spec §47.
 */

export interface ToolDependencies {
  editor: EditorAdapter;
  workspace: WorkspaceAdapter;
  getBudget: () => ContextBudget;
  /** Environment variables a command may see (spec §38). */
  getEnvAllowlist?: () => string[];
}

function truncate(
  content: string,
  max: number,
): { content: string; truncated: boolean; truncation?: TruncationInfo } {
  if (content.length <= max) {
    return { content, truncated: false };
  }
  return {
    content: content.slice(0, max),
    truncated: true,
    truncation: {
      truncated: true,
      originalCharacters: content.length,
      includedCharacters: max,
    },
  };
}

function splitLines(content: string): string[] {
  return content.split(/\r\n|\r|\n/);
}

/* ------------------------------------------------------------------ *
 * editor.active_document — the live buffer (spec §15.1)
 * ------------------------------------------------------------------ */

export function createActiveDocumentTool(
  deps: ToolDependencies,
): ToolDefinition<ActiveDocumentArgs, ActiveDocumentResult> {
  return {
    name: TOOL_NAMES.activeDocument,
    description:
      "Read the document the user is currently looking at, including unsaved changes. Returns the live editor buffer, not the file on disk.",
    permission: "read",
    timeoutMs: 5_000,

    validate: () => ({}),

    async execute() {
      const document = deps.editor.getActiveDocumentSnapshot();
      if (!document) {
        throw new ToolExecutionError("NOT_FOUND", "There is no active text editor.");
      }

      const verdict = inspectPath(document.path);
      if (verdict.blocked) {
        throw new ToolExecutionError(
          "PERMISSION_DENIED",
          `Refused: ${document.path} — ${verdict.reason}.`,
        );
      }

      const trimmed = truncate(document.content, deps.getBudget().maxFileCharacters);

      const result: ActiveDocumentResult = {
        path: document.path,
        language: document.language,
        isDirty: document.isDirty,
        documentVersion: document.documentVersion,
        lineCount: document.lineCount,
        source: document.source,
        content: trimmed.content,
        truncated: trimmed.truncated,
      };
      if (trimmed.truncation) {
        result.truncation = trimmed.truncation;
      }
      return result;
    },
  };
}

/* ------------------------------------------------------------------ *
 * workspace.read_file — line-aware, buffer-aware (spec §15.2, §62)
 * ------------------------------------------------------------------ */

export function createReadFileTool(
  deps: ToolDependencies,
): ToolDefinition<ReadFileArgs, ReadFileResult> {
  return {
    name: TOOL_NAMES.readFile,
    description:
      "Read a UTF-8 text file inside the current workspace. Supports startLine/endLine for a bounded range. Prefers unsaved editor content when the file is open and dirty.",
    permission: "read",
    timeoutMs: 5_000,

    validate(rawArgs) {
      const args = expectArgs(rawArgs);
      const path = requiredString(args, "path");
      const startLine = optionalPositiveInteger(args, "startLine");
      const endLine = optionalPositiveInteger(args, "endLine");

      if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
        throw new ToolExecutionError(
          "INVALID_ARGUMENT",
          `"endLine" (${endLine}) must not be before "startLine" (${startLine}).`,
        );
      }

      const validated: ReadFileArgs = { path };
      if (startLine !== undefined) validated.startLine = startLine;
      if (endLine !== undefined) validated.endLine = endLine;
      return validated;
    },

    async execute(args) {
      const target = await deps.workspace.resolvePath(args.path);

      // Spec §3.3: never silently substitute disk content for a dirty buffer.
      const open = deps.editor.getDocumentSnapshotFor(target.absolutePath);
      const useBuffer = open !== null && open.isDirty;

      const content = useBuffer ? open.content : (await deps.workspace.readDiskFile(target)).content;
      const lines = splitLines(content);
      const totalLines = content.length === 0 ? 0 : lines.length;

      const startLine = Math.min(Math.max(args.startLine ?? 1, 1), Math.max(totalLines, 1));
      const endLine = Math.min(args.endLine ?? totalLines, totalLines);

      const selected =
        totalLines === 0 ? "" : lines.slice(startLine - 1, Math.max(endLine, startLine)).join("\n");

      const trimmed = truncate(selected, deps.getBudget().maxFileCharacters);

      const result: ReadFileResult = {
        path: target.relativePath,
        startLine: totalLines === 0 ? 0 : startLine,
        endLine: totalLines === 0 ? 0 : Math.max(endLine, startLine),
        totalLines,
        source: useBuffer ? "editor-buffer" : "filesystem",
        isDirty: useBuffer,
        content: trimmed.content,
        truncated: trimmed.truncated,
      };
      if (trimmed.truncation) {
        result.truncation = trimmed.truncation;
      }
      return result;
    },
  };
}

/* ------------------------------------------------------------------ *
 * workspace.list_directory (spec §15.3)
 * ------------------------------------------------------------------ */

export function createListDirectoryTool(
  deps: ToolDependencies,
): ToolDefinition<ListDirectoryArgs, ListDirectoryResult> {
  return {
    name: TOOL_NAMES.listDirectory,
    description:
      "List the entries of a directory inside the current workspace. Ignores node_modules, .git, build output, and filtered secret files.",
    permission: "read",
    timeoutMs: 5_000,

    validate(rawArgs) {
      const args = expectArgs(rawArgs);
      const path = optionalString(args, "path");
      return path === undefined ? {} : { path };
    },

    async execute(args) {
      const target = await deps.workspace.resolvePath(args.path ?? ".");
      const listing = await deps.workspace.listDirectory(target, deps.getBudget().maxTreeEntries);

      return {
        path: target.relativePath,
        entries: listing.entries,
        truncated: listing.truncated,
        omittedCount: listing.omittedCount,
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * editor.diagnostics (spec §15.6, §35)
 * ------------------------------------------------------------------ */

export function createDiagnosticsTool(
  deps: ToolDependencies,
): ToolDefinition<DiagnosticsArgs, DiagnosticsResult> {
  return {
    name: TOOL_NAMES.diagnostics,
    description:
      "Read the problems VS Code itself reports for a file. Defaults to the active document. Better than asking the user to paste compiler errors.",
    permission: "read",
    timeoutMs: 5_000,

    validate(rawArgs) {
      const args = expectArgs(rawArgs);
      const path = optionalString(args, "path");
      return path === undefined ? {} : { path };
    },

    async execute(args) {
      const budget = deps.getBudget();

      let path: string;
      let diagnostics;

      if (args.path === undefined) {
        const active = deps.editor.getActiveDocumentSnapshot();
        if (!active) {
          throw new ToolExecutionError(
            "NOT_FOUND",
            "There is no active text editor. Pass a path to read diagnostics for a specific file.",
          );
        }
        path = active.path;
        diagnostics = deps.editor.getDiagnostics();
      } else {
        const target = await deps.workspace.resolvePath(args.path);
        path = target.relativePath;
        diagnostics = deps.editor.getDiagnosticsForFile(target.absolutePath);
      }

      const included = diagnostics.slice(0, budget.maxDiagnosticItems);
      return {
        path,
        diagnostics: included,
        omittedCount: diagnostics.length - included.length,
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * workspace.search (spec §15.5, §63)
 * ------------------------------------------------------------------ */

const DEFAULT_SEARCH_RESULTS = 100;
const MAX_SEARCH_RESULTS = 500;
const MAX_MATCHES_PER_FILE = 20;

export function createSearchTool(deps: ToolDependencies): ToolDefinition<SearchArgs, SearchResult> {
  return {
    name: TOOL_NAMES.search,
    description:
      "Find text in workspace files. Literal by default; set isRegex for a regular expression, wholeWord to match whole words. Optional globs narrow the search. Unsaved editor buffers are searched too, and every match says which source it came from.",
    permission: "read",
    timeoutMs: 15_000,

    validate(rawArgs) {
      const args = expectArgs(rawArgs);
      const query = requiredString(args, "query");

      const validated: SearchArgs = { query };

      for (const flag of ["isRegex", "caseSensitive", "wholeWord"] as const) {
        const value = args[flag];
        if (value !== undefined && value !== null) {
          if (typeof value !== "boolean") {
            throw new ToolExecutionError("INVALID_ARGUMENT", `"${flag}" must be a boolean.`);
          }
          validated[flag] = value;
        }
      }

      const globs = args["globs"];
      if (globs !== undefined && globs !== null) {
        if (!Array.isArray(globs) || globs.some((glob) => typeof glob !== "string")) {
          throw new ToolExecutionError("INVALID_ARGUMENT", '"globs" must be an array of strings.');
        }
        validated.globs = globs as string[];
      }

      const maxResults = optionalPositiveInteger(args, "maxResults");
      if (maxResults !== undefined) {
        validated.maxResults = Math.min(maxResults, MAX_SEARCH_RESULTS);
      }

      return validated;
    },

    async execute(args, context) {
      const target = await deps.workspace.resolvePath(".");
      const maxResults = args.maxResults ?? DEFAULT_SEARCH_RESULTS;
      const caseSensitive = args.caseSensitive ?? false;
      const isRegex = args.isRegex ?? false;

      // Unsaved buffers are searched in memory and excluded from the disk walk,
      // so the same file is never counted twice and the result reflects what is
      // actually on screen (spec §3.3).
      const dirty = deps.editor
        .getDirtyDocuments()
        .filter(
          (document) =>
            isInsideWorkspace(document.absolutePath, deps.workspace.getWorkspaceRoots()) &&
            !inspectPath(document.path).blocked,
        );

      const searchOptions: SearchOptions = {
        query: args.query,
        isRegex,
        caseSensitive,
        wholeWord: args.wholeWord ?? false,
        maxResults,
        maxMatchesPerFile: MAX_MATCHES_PER_FILE,
        skipPaths: dirty.map((document) => document.path),
        signal: context.signal,
      };
      if (args.globs) {
        searchOptions.globs = args.globs;
      }

      const outcome = await deps.workspace.searchFiles(target, searchOptions);

      const bufferMatches: SearchMatch[] = [];
      let bufferTotal = 0;
      let bufferFiles = 0;

      for (const document of dirty) {
        if (!matchesAnyGlob(document.path, args.globs)) {
          continue;
        }
        // Same engine as the disk walk, so a regex means the same thing in
        // both places.
        const found = await deps.workspace.searchBuffer(document.content, searchOptions);
        bufferTotal += found.length;
        if (found.length > 0) {
          bufferFiles += 1;
        }
        for (const match of found) {
          bufferMatches.push({
            path: document.path,
            line: match.line,
            preview: match.preview,
            source: "editor-buffer",
          });
        }
      }

      // Unsaved work first: it is the most likely thing the question is about.
      const combined = [...bufferMatches, ...outcome.matches];

      return {
        query: args.query,
        isRegex,
        engine: outcome.engine,
        matches: combined.slice(0, maxResults),
        totalMatches: outcome.totalMatches + bufferTotal,
        filesWithMatches: outcome.filesWithMatches + bufferFiles,
        truncated: outcome.truncated || combined.length > maxResults,
        omittedCount: outcome.omittedCount,
      };
    },
  };
}

function isInsideWorkspace(absolutePath: string, roots: { path: string }[]): boolean {
  return roots.some(
    (root) => absolutePath === root.path || absolutePath.startsWith(root.path + nodePath.sep),
  );
}

/* ------------------------------------------------------------------ *
 * workspace.project_tree (spec §15.4, §64)
 * ------------------------------------------------------------------ */

export function createProjectTreeTool(
  deps: ToolDependencies,
): ToolDefinition<ProjectTreeArgs, ProjectTreeResult> {
  return {
    name: TOOL_NAMES.projectTree,
    description:
      "List the file tree of the workspace, breadth-first and bounded. Ignores build output, dependencies and filtered secret files.",
    permission: "read",
    timeoutMs: 15_000,

    validate(rawArgs) {
      const args = expectArgs(rawArgs);
      const path = optionalString(args, "path");
      const maxEntries = optionalPositiveInteger(args, "maxEntries");

      const validated: ProjectTreeArgs = {};
      if (path !== undefined) validated.path = path;
      if (maxEntries !== undefined) validated.maxEntries = maxEntries;
      return validated;
    },

    async execute(args) {
      const budgetMax = deps.getBudget().maxTreeEntries;
      const maxEntries = Math.min(args.maxEntries ?? budgetMax, budgetMax);
      const target = await deps.workspace.resolvePath(args.path ?? ".");
      const outcome = await deps.workspace.projectTree(target, maxEntries);

      return {
        root: target.relativePath,
        entries: outcome.entries,
        truncated: outcome.truncated,
        omittedCount: outcome.omittedCount,
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * shell.run (spec §37) — gated in Phase 7, executed in Phase 8
 * ------------------------------------------------------------------ */

export function createRunCommandTool(
  deps: ToolDependencies,
): ToolDefinition<RunCommandArgs, RunCommandResult> {
  return {
    name: TOOL_NAMES.runCommand,
    description:
      "Run a shell command in the workspace. Requires explicit user approval every time unless they choose to remember this exact command.",
    permission: "execute",
    // Deliberately longer than the command's own 30s timeout: the runner must
    // get to report `timedOut: true` with whatever output it captured, rather
    // than the registry killing the race first and reporting a bare TIMEOUT.
    timeoutMs: 40_000,

    validate(rawArgs) {
      const args = expectArgs(rawArgs);
      const command = requiredString(args, "command");

      // Validation happens before the approval prompt, so the user is never
      // asked to approve something malformed.
      if (command.includes("\0")) {
        throw new ToolExecutionError("INVALID_ARGUMENT", "command contains a null byte.");
      }

      const validated: RunCommandArgs = { command };

      const cwd = optionalString(args, "cwd");
      if (cwd !== undefined) {
        validated.cwd = cwd;
      }

      const timeoutMs = optionalPositiveInteger(args, "timeoutMs");
      if (timeoutMs !== undefined) {
        validated.timeoutMs = Math.min(timeoutMs, 120_000);
      }

      return validated;
    },

    async execute(args, context) {
      // The cwd is bounded by the same rules as every other path: a command
      // cannot be talked into running outside the workspace.
      const target = await deps.workspace.resolvePath(args.cwd ?? ".");

      const options: RunCommandOptions = {
        command: args.command,
        cwd: target.absolutePath,
        displayCwd: target.relativePath,
        envAllowlist: deps.getEnvAllowlist?.() ?? DEFAULT_ENV_ALLOWLIST,
        signal: context.signal,
      };
      if (args.timeoutMs !== undefined) {
        options.timeoutMs = args.timeoutMs;
      }

      return runCommand(options);
    },
  };
}

/** Wires the current tool set into a registry. */
export function registerDefaultTools(registry: ToolRegistry, deps: ToolDependencies): void {
  registry.register(createActiveDocumentTool(deps));
  registry.register(createReadFileTool(deps));
  registry.register(createListDirectoryTool(deps));
  registry.register(createDiagnosticsTool(deps));
  registry.register(createSearchTool(deps));
  registry.register(createProjectTreeTool(deps));
  registry.register(createRunCommandTool(deps));
}
