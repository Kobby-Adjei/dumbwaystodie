import { TOOL_NAMES, type ToolCallRequest, type ToolCallResult } from "@dumbways/protocol";

/**
 * One-line summaries for the conversation panel (spec §29).
 *
 * Tool traffic collapses to a receipt — `▸ workspace.read_file public/app.js` —
 * because dumping a 40,000 character tool result into the conversation buries
 * the coaching in the plumbing.
 */

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function summarizeArgs(call: ToolCallRequest): string {
  const args = asRecord(call.arguments);

  switch (call.tool) {
    case TOOL_NAMES.activeDocument:
      return "";

    case TOOL_NAMES.readFile: {
      const path = typeof args["path"] === "string" ? args["path"] : "?";
      const start = args["startLine"];
      const end = args["endLine"];
      if (typeof start === "number" || typeof end === "number") {
        return `${path} L${start ?? 1}-${end ?? "end"}`;
      }
      return path;
    }

    case TOOL_NAMES.listDirectory:
      return typeof args["path"] === "string" ? args["path"] : ".";

    case TOOL_NAMES.diagnostics:
      return typeof args["path"] === "string" ? args["path"] : "(active document)";

    case TOOL_NAMES.search: {
      const query = typeof args["query"] === "string" ? `"${args["query"]}"` : "?";
      const globs = Array.isArray(args["globs"]) ? args["globs"].join(", ") : "";
      return globs ? `${query} in ${globs}` : query;
    }

    case TOOL_NAMES.projectTree:
      return typeof args["path"] === "string" ? args["path"] : ".";

    case TOOL_NAMES.runCommand: {
      // This string is what the approval dialog shows and what a remembered
      // grant is keyed on, so it must be the command itself, exactly.
      const command = typeof args["command"] === "string" ? args["command"] : "?";
      const cwd = typeof args["cwd"] === "string" ? args["cwd"] : undefined;
      return cwd ? `${command} (in ${cwd})` : command;
    }

    default: {
      const path = args["path"];
      return typeof path === "string" ? path : "";
    }
  }
}

export function summarizeResult(result: ToolCallResult): string {
  if (!result.ok) {
    return result.error ? `${result.error.code}: ${result.error.message}` : "failed";
  }

  const payload = asRecord(result.result);
  const parts: string[] = [];

  if (typeof payload["content"] === "string") {
    parts.push(`${(payload["content"] as string).length} characters`);
  }
  if (Array.isArray(payload["entries"])) {
    parts.push(`${payload["entries"].length} entries`);
  }
  if (Array.isArray(payload["diagnostics"])) {
    parts.push(`${payload["diagnostics"].length} diagnostics`);
  }
  if (Array.isArray(payload["matches"])) {
    const total = payload["totalMatches"];
    const shown = payload["matches"].length;
    parts.push(
      typeof total === "number" && total > shown
        ? `${shown} of ${total} matches`
        : `${shown} matches`,
    );
    if (typeof payload["filesWithMatches"] === "number") {
      parts.push(`in ${payload["filesWithMatches"]} files`);
    }
    if (typeof payload["engine"] === "string") {
      parts.push(`via ${payload["engine"]}`);
    }
  }
  if (typeof payload["exitCode"] === "number" || payload["timedOut"] === true) {
    parts.push(payload["timedOut"] === true ? "timed out" : `exit ${String(payload["exitCode"])}`);
    if (typeof payload["durationMs"] === "number") {
      parts.push(`${payload["durationMs"]} ms`);
    }
  }
  if (payload["truncated"] === true) {
    parts.push("truncated");
  }
  if (typeof payload["omittedCount"] === "number" && payload["omittedCount"] > 0) {
    parts.push(`${payload["omittedCount"]} omitted`);
  }
  if (payload["source"] === "editor-buffer") {
    parts.push("from unsaved buffer");
  }

  return parts.length > 0 ? parts.join(", ") : "ok";
}
