import type {
  CoachRequest,
  DiagnosticContextItem,
  FileContextItem,
  SelectionContextItem,
} from "@dumbways/protocol";

/**
 * Deterministic Markdown rendering of a request (spec §0L).
 *
 * The request is JSON internally. This is the human-and-text-surface
 * projection of it: used today by "Show Current Context", and later by any
 * provider whose surface only accepts text.
 *
 * Rule from the spec that this exists to enforce: never send just
 * "Why does this reload?" — send the deterministic context payload.
 */
export function requestToMarkdown(request: CoachRequest): string {
  const out: string[] = [];

  out.push("# DUMB WAYS TO DIE — EDITOR CONTEXT", "");
  out.push("## User message", request.message, "");
  out.push("## Workspace", request.workspace.name, "");

  const editor = request.editor;
  if (!editor) {
    out.push("## Active editor", "None. No capturable text editor was focused.", "");
  } else {
    out.push(
      "## Active editor",
      `File: ${editor.activeFile}`,
      `Language: ${editor.language}`,
      `Dirty: ${editor.isDirty}`,
      `Document version: ${editor.documentVersion}`,
      `Lines: ${editor.lineCount}`,
      `Captured at: ${editor.capturedAt}`,
      "",
    );
    if (editor.cursor) {
      out.push("## Cursor", `L${editor.cursor.line}:${editor.cursor.column}`, "");
    }
  }

  const selection = request.contextItems.find(
    (item): item is SelectionContextItem => item.type === "selection",
  );
  if (selection) {
    out.push("## Selection", `Lines ${selection.startLine}-${selection.endLine}`);
    if (selection.truncation) {
      out.push(
        `Truncated: ${selection.truncation.includedCharacters} of ${selection.truncation.originalCharacters} characters.`,
      );
    }
    out.push("", fence(selection.language, selection.content), "");
  }

  const buffer = request.contextItems.find(
    (item): item is FileContextItem => item.type === "file" && item.source === "editor-buffer",
  );
  if (buffer) {
    out.push("## Active buffer");
    out.push(
      buffer.isDirty
        ? "Live editor buffer, including unsaved changes. This is NOT the version on disk."
        : "Live editor buffer. It currently matches disk.",
    );
    if (buffer.truncation) {
      out.push(
        `Truncated: ${buffer.truncation.includedCharacters} of ${buffer.truncation.originalCharacters} characters.`,
      );
    }
    out.push("", fence(buffer.language ?? "", buffer.content), "");
  }

  const diagnostics = request.contextItems.find(
    (item): item is DiagnosticContextItem => item.type === "diagnostics",
  );
  out.push("## Diagnostics");
  if (!diagnostics || diagnostics.diagnostics.length === 0) {
    out.push("None reported for the active file.", "");
  } else {
    for (const diagnostic of diagnostics.diagnostics) {
      const code = diagnostic.code === undefined ? "" : ` [${diagnostic.code}]`;
      const source = diagnostic.source ? ` (${diagnostic.source})` : "";
      out.push(
        `- ${diagnostic.severity} L${diagnostic.line}:${diagnostic.column}${source}${code} ${diagnostic.message}`,
      );
    }
    if (diagnostics.omittedCount) {
      out.push(`- ...${diagnostics.omittedCount} omitted by the context budget`);
    }
    out.push("");
  }

  const learning = request.learning;
  if (learning) {
    out.push("## Learning state");
    if (learning.currentFeature) out.push(`Current feature: ${learning.currentFeature}`);
    if (learning.currentMicroSkill) out.push(`Current micro-skill: ${learning.currentMicroSkill}`);
    if (learning.currentUnderstanding) {
      out.push("Current understanding:", learning.currentUnderstanding);
    }
    out.push("");
  }

  /*
   * Silence where there is nothing to say.
   *
   * "Attachments: None." is not information — nobody wonders whether a
   * message they sent had attachments. Diagnostics are the opposite case and
   * stay: "no errors reported" is a fact about the code, and a chat that does
   * not hear it may assume the opposite.
   */
  if (request.attachments.length > 0) {
    out.push("## Attachments");
    for (const attachment of request.attachments) {
      out.push(`- ${attachment.filename} (${attachment.mimeType}, ${attachment.size} bytes)`);
    }
    out.push("");
  }

  const notes = request.contextItems.filter((item) => item.type === "note");
  if (notes.length > 0) {
    out.push("## Notes from the context engine");
    for (const note of notes) {
      if (note.type === "note") {
        out.push(`- ${note.note}`);
      }
    }
    out.push("");
  }

  out.push(describeTools(request), "");

  return out.join("\n");
}

/**
 * A reminder, not a manual.
 *
 * The primer already describes every tool in full, and it is sent with the
 * first message of a session — so spelling them out again here printed the
 * same paragraph twice in one payload, and again on every turn after. Names
 * are enough to remember what is available; the descriptions are one scroll
 * up, and `Copy Chat Primer` puts them back if a long conversation loses them.
 */
function describeTools(request: CoachRequest): string {
  const tools = request.availableTools ?? [];
  if (tools.length === 0) {
    return "## Tools\nNone. This build cannot fetch additional context on request.";
  }
  return [
    "## Tools",
    `Ask for these rather than guessing, or asking me to paste code: ${tools
      .map((tool) => `\`${tool.name}\``)
      .join(", ")}.`,
  ].join("\n");
}

/**
 * Picks a fence long enough to survive content that itself contains
 * backticks — otherwise a Markdown code block inside an HTML file silently
 * breaks the payload.
 */
function fence(language: string, content: string): string {
  const longestRun = [...content.matchAll(/`+/g)].reduce(
    (max, match) => Math.max(max, match[0].length),
    0,
  );
  const ticks = "`".repeat(Math.max(3, longestRun + 1));
  return `${ticks}${language}\n${content}\n${ticks}`;
}
