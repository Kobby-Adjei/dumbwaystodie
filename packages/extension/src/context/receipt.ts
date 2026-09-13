import type { CoachRequest } from "@dumbways/protocol";

/**
 * What is about to leave this machine, in plain terms.
 *
 * The design rule that makes this trustworthy: **it is computed from the
 * request that is actually being sent**, never from a hand-written
 * description. A hardcoded "we send your open file and selection" is a promise
 * that drifts the first time the context engine changes; this cannot drift,
 * because it is reading the same object the transport is about to hand over.
 *
 * It states what is withheld as carefully as what is included. "We don't send
 * your other files" is the part a user cannot verify by looking, so it is the
 * part worth saying out loud.
 */

export interface ReceiptLine {
  label: string;
  detail: string;
}

export interface OutgoingReceipt {
  /** One line for the panel. */
  summary: string;
  destination: string;
  included: ReceiptLine[];
  withheld: string[];
  /** Size of the whole payload, so "how much" is never a guess. */
  characters: number;
}

export type Destination = "in-process" | "clipboard" | "relay";

export function describeDestination(destination: Destination, relayPort?: number): string {
  switch (destination) {
    case "in-process":
      return "Nowhere. It stays inside this editor window.";
    case "clipboard":
      return "Your clipboard, so you can paste it into a chat you choose. Nothing is sent over the network by this extension.";
    case "relay":
      return `The local relay on 127.0.0.1:${relayPort ?? 43123}, then the provider process attached to it. Loopback only.`;
  }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function buildReceipt(
  request: CoachRequest,
  destination: Destination,
  relayPort?: number,
): OutgoingReceipt {
  const included: ReceiptLine[] = [];
  const withheld: string[] = [];
  const summaryParts: string[] = [];

  included.push({ label: "Your message", detail: `"${request.message}"` });

  if (request.editor) {
    const editor = request.editor;
    included.push({
      label: "Which file you are in",
      detail: `${editor.activeFile} (${editor.language})${editor.isDirty ? ", with unsaved changes" : ""}`,
    });
    summaryParts.push(editor.activeFile);
  } else {
    included.push({ label: "Which file you are in", detail: "none — no file was focused" });
  }

  for (const item of request.contextItems) {
    switch (item.type) {
      case "file": {
        const source =
          item.source === "editor-buffer"
            ? "as it looks in your editor right now, including anything unsaved"
            : "as saved on disk";
        included.push({
          label: "The contents of that file",
          detail: `${item.content.length.toLocaleString()} characters, ${source}${
            item.truncated ? " (truncated — the rest was not sent)" : ""
          }`,
        });
        summaryParts.push(`${item.content.length.toLocaleString()} chars`);
        break;
      }

      case "selection": {
        included.push({
          label: "The lines you selected",
          detail: `lines ${item.startLine}–${item.endLine}, ${plural(item.content.length, "character")}`,
        });
        summaryParts.push(`L${item.startLine}–${item.endLine}`);
        break;
      }

      case "diagnostics": {
        included.push({
          label: "Errors and warnings",
          detail: `${plural(item.diagnostics.length, "problem")} your editor reports for that one file — the messages, line numbers, and their source`,
        });
        summaryParts.push(plural(item.diagnostics.length, "problem"));
        break;
      }

      case "note":
        // Notes are the context engine's own record of what it left out.
        withheld.push(item.note);
        break;

      default:
        break;
    }
  }

  if (request.attachments.length > 0) {
    included.push({
      label: "Attachments",
      detail: request.attachments
        .map((attachment) => `${attachment.filename} (${Math.round(attachment.size / 1024)} KB)`)
        .join(", "),
    });
    summaryParts.push(plural(request.attachments.length, "attachment"));
  }

  if (request.availableTools.length > 0) {
    included.push({
      label: "What the coach may ask for next",
      detail: `a list of ${plural(request.availableTools.length, "tool")} it can request — not the contents, just the names and what they do`,
    });
  }

  // The invariants a user cannot verify by looking, so they are stated.
  withheld.push(
    "No other file in your project — only the one above.",
    "No environment variables, and no shell history.",
    "Nothing outside this project folder, ever.",
    "No file matching a credential pattern (.env, keys, credentials) — those are refused before they are read.",
  );

  return {
    summary: summaryParts.length > 0 ? summaryParts.join(" · ") : "your message only",
    destination: describeDestination(destination, relayPort),
    included,
    withheld,
    characters: JSON.stringify(request).length,
  };
}

/** The full text, for the consent dialog and the "what gets sent" command. */
export function renderReceipt(receipt: OutgoingReceipt): string {
  const lines: string[] = [
    "WHAT LEAVES THIS MACHINE",
    "",
    `Where it goes: ${receipt.destination}`,
    `Total size:    ${receipt.characters.toLocaleString()} characters`,
    "",
    "INCLUDED",
  ];

  for (const line of receipt.included) {
    lines.push(`  • ${line.label}: ${line.detail}`);
  }

  lines.push("", "NOT INCLUDED");
  for (const line of receipt.withheld) {
    lines.push(`  • ${line}`);
  }

  return lines.join("\n");
}
