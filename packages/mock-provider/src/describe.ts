import {
  TOOL_NAMES,
  type CoachRequest,
  type DiagnosticContextItem,
  type DiagnosticSnapshot,
  type FileContextItem,
  type SelectionContextItem,
  type ToolCallResult,
} from "@dumbways/protocol";

/**
 * The mock's whole job is to prove the context actually arrived (spec §20, §99).
 *
 * So it does not paraphrase. It quotes back the things the acceptance test
 * checks: the active path, evidence that the buffer is the *live* one, the
 * selection range, and the diagnostic count.
 */

export function findActiveBuffer(request: CoachRequest): FileContextItem | undefined {
  return request.contextItems.find(
    (item): item is FileContextItem => item.type === "file" && item.source === "editor-buffer",
  );
}

export function findSelection(request: CoachRequest): SelectionContextItem | undefined {
  return request.contextItems.find(
    (item): item is SelectionContextItem => item.type === "selection",
  );
}

export function findDiagnostics(request: CoachRequest): DiagnosticContextItem | undefined {
  return request.contextItems.find(
    (item): item is DiagnosticContextItem => item.type === "diagnostics",
  );
}

/**
 * The strongest available proof that we are looking at unsaved editor state:
 * quote the exact line the caret sits on, straight out of the transported
 * buffer. If the user typed something and did not save, it shows up here.
 */
export function lineAt(content: string, oneBasedLine: number): string | undefined {
  if (oneBasedLine < 1) {
    return undefined;
  }
  const lines = content.split(/\r\n|\r|\n/);
  return lines[oneBasedLine - 1];
}

export function countBySeverity(diagnostics: DiagnosticSnapshot[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const diagnostic of diagnostics) {
    counts[diagnostic.severity] = (counts[diagnostic.severity] ?? 0) + 1;
  }
  return counts;
}

function pluralize(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function describeRequest(request: CoachRequest): string {
  const lines: string[] = [];

  lines.push("MOCK: I received your message.");
  lines.push("");
  lines.push(`You said: "${request.message}"`);
  lines.push("");

  lines.push(`Workspace: ${request.workspace.name}`);

  const editor = request.editor;
  if (!editor) {
    lines.push("Active editor: none — no text editor was focused when you sent this.");
  } else {
    lines.push(`Active file: ${editor.activeFile} (${editor.language})`);
    lines.push(
      `Unsaved changes: ${editor.isDirty ? "yes" : "no"} (document version ${editor.documentVersion}, ${pluralize(editor.lineCount, "line")})`,
    );

    const buffer = findActiveBuffer(request);
    if (buffer) {
      const suffix = buffer.truncation
        ? ` (truncated from ${buffer.truncation.originalCharacters} characters)`
        : "";
      lines.push(
        `Live buffer: ${buffer.content.length} characters read from the editor buffer, not from disk${suffix}`,
      );

      if (editor.cursor) {
        const cursorLine = lineAt(buffer.content, editor.cursor.line);
        if (cursorLine !== undefined) {
          lines.push(
            `Cursor is on L${editor.cursor.line}:${editor.cursor.column}, which currently reads:`,
          );
          lines.push(`    ${cursorLine.trim() === "" ? "(blank line)" : cursorLine.trim()}`);
        }
      }
    } else {
      lines.push("Live buffer: not included in this request.");
    }

    const selection = findSelection(request);
    if (selection) {
      lines.push(
        `Selection: L${selection.startLine}-L${selection.endLine} (${selection.content.length} characters)`,
      );
    } else {
      lines.push("Selection: none.");
    }
  }

  const diagnosticsItem = findDiagnostics(request);
  const diagnostics = diagnosticsItem?.diagnostics ?? [];
  if (diagnostics.length === 0) {
    lines.push("Diagnostics: 0 on the active file.");
  } else {
    const counts = countBySeverity(diagnostics);
    const summary = Object.entries(counts)
      .map(([severity, count]) => pluralize(count, severity))
      .join(", ");
    lines.push(`Diagnostics: ${pluralize(diagnostics.length, "item")} on the active file (${summary})`);
    for (const diagnostic of diagnostics.slice(0, 3)) {
      lines.push(`    ${diagnostic.severity} L${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`);
    }
    if (diagnostics.length > 3) {
      lines.push(`    ...and ${diagnostics.length - 3} more`);
    }
    if (diagnosticsItem?.omittedCount) {
      lines.push(`    (${diagnosticsItem.omittedCount} omitted by the context budget)`);
    }
  }

  const notes = request.contextItems.filter((item) => item.type === "note");
  for (const note of notes) {
    if (note.type === "note") {
      lines.push(`Note: ${note.note}`);
    }
  }

  const learning = request.learning;
  if (learning?.currentMicroSkill || learning?.currentFeature) {
    lines.push("");
    lines.push(
      `Learning state: feature "${learning.currentFeature ?? "unset"}", micro-skill "${learning.currentMicroSkill ?? "unset"}"`,
    );
  }

  lines.push("");
  const toolCount = request.availableTools?.length ?? 0;
  lines.push(
    toolCount === 0
      ? "I am the in-process mock. This bridge advertises no tools, so I cannot ask for more context."
      : `I am the in-process mock. This bridge offers ${toolCount} tools; ask me to "show the file", "check diagnostics", or "list the directory" and I will use them.`,
  );

  return lines.join("\n");
}

/**
 * Turns a tool result into the sentence a coach would say about it.
 *
 * Quoting real numbers back — characters read, source, line counts — is what
 * makes a broken tool loop visible instead of plausible.
 */
/** Enough to be useful in a reply; the full text stays in the tool row. */
function firstLines(text: string, limit = 6): string {
  const lines = text.split("\n");
  const shown = lines.slice(0, limit).join("\n            ");
  return lines.length > limit
    ? `${shown}\n            ...and ${lines.length - limit} more lines`
    : shown;
}

export function describeToolOutcome(tool: string, result: ToolCallResult): string {
  if (!result.ok) {
    const error = result.error;
    return `${tool} → refused: ${error ? `${error.code} ${error.message}` : "unknown error"}`;
  }

  const payload = (result.result ?? {}) as Record<string, unknown>;
  const path = typeof payload["path"] === "string" ? payload["path"] : "(unknown path)";

  switch (tool) {
    case TOOL_NAMES.activeDocument: {
      const content = String(payload["content"] ?? "");
      const dirty = payload["isDirty"] === true;
      return (
        `${tool} → I read ${content.length} characters from ${path} ` +
        `(${dirty ? "live buffer with unsaved changes" : "saved buffer"}, ` +
        `document version ${String(payload["documentVersion"])}).`
      );
    }

    case TOOL_NAMES.readFile: {
      const content = String(payload["content"] ?? "");
      const source = payload["source"] === "editor-buffer" ? "unsaved editor buffer" : "disk";
      return (
        `${tool} → I read ${content.length} characters from ${path} ` +
        `(lines ${String(payload["startLine"])}-${String(payload["endLine"])} of ` +
        `${String(payload["totalLines"])}, from ${source}).`
      );
    }

    case TOOL_NAMES.listDirectory: {
      const entries = Array.isArray(payload["entries"]) ? payload["entries"] : [];
      const names = entries
        .slice(0, 8)
        .map((entry) => {
          const record = entry as Record<string, unknown>;
          return record["type"] === "directory" ? `${String(record["name"])}/` : String(record["name"]);
        })
        .join(", ");
      const more = entries.length > 8 ? `, and ${entries.length - 8} more` : "";
      return `${tool} → ${path} contains ${entries.length} entries: ${names}${more}.`;
    }

    case TOOL_NAMES.search: {
      const matches = Array.isArray(payload["matches"]) ? payload["matches"] : [];
      const query = String(payload["query"] ?? "");
      const kind = payload["isRegex"] === true ? "pattern" : "text";
      const engine = String(payload["engine"] ?? "unknown");
      if (matches.length === 0) {
        return `${tool} → no matches for ${kind} "${query}" (searched with ${engine}).`;
      }
      const shown = matches
        .slice(0, 3)
        .map((entry) => {
          const record = entry as Record<string, unknown>;
          const from = record["source"] === "editor-buffer" ? " [unsaved]" : "";
          return `${String(record["path"])}:${String(record["line"])}${from} ${String(record["preview"])}`;
        })
        .join("\n    ");
      const more =
        Number(payload["totalMatches"] ?? matches.length) > matches.length
          ? ` (${String(payload["totalMatches"])} total)`
          : "";
      return (
        `${tool} → ${matches.length} match(es) for ${kind} "${query}" in ` +
        `${String(payload["filesWithMatches"])} file(s)${more}:\n    ${shown}`
      );
    }

    case TOOL_NAMES.projectTree: {
      const entries = Array.isArray(payload["entries"]) ? payload["entries"] : [];
      const directories = entries.filter(
        (entry) => (entry as Record<string, unknown>)["type"] === "directory",
      ).length;
      const truncated = payload["truncated"] === true ? ", truncated" : "";
      return (
        `${tool} → ${entries.length} entries under ${path} ` +
        `(${directories} directories, ${entries.length - directories} files${truncated}).`
      );
    }

    case TOOL_NAMES.runCommand: {
      const timedOut = payload["timedOut"] === true;
      const stdout = String(payload["stdout"] ?? "").trim();
      const stderr = String(payload["stderr"] ?? "").trim();
      const command = String(payload["command"] ?? "");
      const duration = String(payload["durationMs"] ?? "?");

      const lines = [
        timedOut
          ? `${tool} → "${command}" timed out after ${duration}ms`
          : `${tool} → "${command}" finished with exit ${String(payload["exitCode"])} in ${duration}ms`,
      ];

      if (stdout) {
        lines.push(`    stdout: ${firstLines(stdout)}`);
      }
      if (stderr) {
        lines.push(`    stderr: ${firstLines(stderr)}`);
      }
      if (!stdout && !stderr) {
        lines.push("    (no output)");
      }
      return lines.join("\n");
    }

    case TOOL_NAMES.diagnostics: {
      const diagnostics = (
        Array.isArray(payload["diagnostics"]) ? payload["diagnostics"] : []
      ) as DiagnosticSnapshot[];
      if (diagnostics.length === 0) {
        return `${tool} → VS Code reports no problems in ${path}.`;
      }
      const first = diagnostics
        .slice(0, 2)
        .map((d) => `${d.severity} L${d.line}:${d.column} ${d.message}`)
        .join("; ");
      return `${tool} → ${diagnostics.length} problem(s) in ${path}: ${first}.`;
    }

    default:
      return `${tool} → ok.`;
  }
}
