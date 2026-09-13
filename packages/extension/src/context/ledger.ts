import { createHash } from "node:crypto";

import type { ContextItem } from "@dumbways/protocol";

import { diffLines, renderUnifiedDiff } from "./diff";

/**
 * What this conversation has already been told.
 *
 * The payload problem is not that the context is large — it is that the same
 * context is sent again every turn. A chat is a *stateful* conversation: the
 * file it was shown three messages ago is still there, in its window, being
 * paid for on every subsequent turn. Sending it again buys nothing.
 *
 * Three ideas, none of them new anywhere except here:
 *
 *  - **A ledger** of what has been sent, keyed by content hash. HTTP has
 *    ETags, git has object ids; the principle is "name the bytes, and you can
 *    say 'the ones you already have'".
 *  - **Deltas.** When a file has changed, send the edit rather than the
 *    document — version control's founding observation.
 *  - **Pull over push.** When even the delta is large, send a description and
 *    let the chat ask for what it actually needs. The tool registry already
 *    exists for exactly this; nothing had been wired up to prefer it.
 *
 * Pure: no `vscode`, no I/O. The ledger is a fact about a conversation, so it
 * lives and dies with the session it belongs to.
 */

export interface LedgerOptions {
  /**
   * Above this many characters, a file body is described instead of included
   * and the chat is told to ask for the parts it wants.
   */
  pullThreshold: number;
  /** Above this, a diff is not worth it and the file is resent whole. */
  maxDiffFraction: number;
}

/*
 * Both numbers are judgment, so here is the judgment.
 *
 * 12,000 characters is roughly 300 lines — the point where pasting a file stops
 * being "here is the thing we are discussing" and starts being a wall the
 * useful part is buried in. It is set by what a *reader* can use, not by a
 * token budget, because the chat still has to answer about it.
 *
 * 0.5 is the point where a diff stops being a saving. At half the file's size a
 * diff is no longer an edit, it is a second copy written in a harder-to-read
 * format — and the chat has to reconstruct the result itself, which is exactly
 * the kind of work it should not be spending the turn on.
 */
export const DEFAULT_LEDGER_OPTIONS: LedgerOptions = {
  pullThreshold: 12_000,
  maxDiffFraction: 0.5,
};

/**
 * How much of a file the chat actually received.
 *
 * The distinction is the whole safety property. A preview is *described*, not
 * delivered — so "unchanged since I sent it" and a diff against it are both
 * lies, and lies of the worst available kind: the chat answers confidently
 * about content it does not have.
 */
export type Coverage = "full" | "preview";

interface SentFile {
  hash: string;
  content: string;
  lineCount: number;
  /** Which turn it was sent on, so the chat can be pointed back at it. */
  turn: number;
  coverage: Coverage;
}

export interface PlanResult {
  items: ContextItem[];
  /** What the ledger did, for the log and for tests. */
  savedCharacters: number;
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export class ContextLedger {
  private readonly files = new Map<string, SentFile>();
  private turn = 0;
  private sessionId: string | undefined;

  constructor(private readonly options: LedgerOptions = DEFAULT_LEDGER_OPTIONS) {}

  /**
   * A new session is a new conversation, which has been told nothing.
   *
   * Carrying a ledger across sessions would claim the chat has seen a file it
   * has never seen — the one failure mode of this whole idea, since the chat
   * would then answer about content it does not have.
   */
  startSession(sessionId: string): void {
    if (this.sessionId !== sessionId) {
      this.sessionId = sessionId;
      this.files.clear();
      this.turn = 0;
    }
  }

  plan(items: ContextItem[]): PlanResult {
    this.turn += 1;
    const planned: ContextItem[] = [];
    let savedCharacters = 0;

    for (const item of items) {
      if (item.type !== "file") {
        planned.push(item);
        continue;
      }

      const previous = this.files.get(item.path);
      const current = hash(item.content);

      /*
       * Only a file the chat actually received can be referred back to.
       *
       * A previously previewed file is *known about*, not held — so it gets
       * neither an "unchanged, use your copy" reference nor a diff. Both would
       * point at bytes that were never delivered.
       */
      const held = previous?.coverage === "full" ? previous : undefined;

      // 1. Already sent in full, byte for byte. Say so and move on.
      if (held && held.hash === current) {
        savedCharacters += item.content.length;
        planned.push({
          type: "note",
          note: `${item.path} is unchanged since I sent it earlier in this conversation — use that copy.`,
        });
        continue;
      }

      /*
       * Unchanged, but only ever previewed. Saying "use your copy" would be
       * false, so this repeats what is true: it has not changed, and the whole
       * thing is one tool call away.
       */
      if (previous && previous.hash === current && previous.coverage === "preview") {
        savedCharacters += item.content.length - PREVIEW_LINES * 80;
        planned.push({
          type: "note",
          note:
            `${item.path} is unchanged since I described it earlier. I did not send ` +
            `the whole file — ask for any part with \`workspace.read_file\` and ` +
            `\`startLine\`/\`endLine\`.`,
        });
        continue;
      }

      // 2. Sent in full before and edited since. Send the edit.
      if (held) {
        const diff = diffLines(held.content, item.content);
        const rendered = diff && diff.hunks.length > 0 ? renderUnifiedDiff(item.path, diff) : undefined;

        if (rendered && rendered.length < item.content.length * this.options.maxDiffFraction) {
          savedCharacters += item.content.length - rendered.length;
          // A diff brings the chat's copy up to date, so it now holds it fully.
          this.remember(item.path, item.content, "full");
          planned.push({
            type: "note",
            note:
              `${item.path} changed since I sent it earlier. Apply this to the copy you have ` +
              `rather than asking for the whole file again:\n\n\`\`\`diff\n${rendered}\n\`\`\``,
          });
          continue;
        }
      }

      // 3. Never sent, or changed too much to be worth a diff. Big files are
      //    described rather than pasted — the chat can ask for what it needs.
      if (item.content.length > this.options.pullThreshold) {
        savedCharacters += item.content.length - PREVIEW_LINES * 80;
        // Recorded as a preview, which is all that was actually sent.
        this.remember(item.path, item.content, "preview");
        planned.push({
          type: "note",
          note: describeInsteadOfSending(item.path, item.content),
        });
        continue;
      }

      this.remember(item.path, item.content, "full");
      planned.push(item);
    }

    return { items: planned, savedCharacters };
  }

  private remember(path: string, content: string, coverage: Coverage): void {
    this.files.set(path, {
      hash: hash(content),
      content,
      lineCount: content.split("\n").length,
      turn: this.turn,
      coverage,
    });
  }

  /** For tests and diagnostics: what the chat actually holds for a path. */
  coverageOf(path: string): Coverage | undefined {
    return this.files.get(path)?.coverage;
  }
}

const PREVIEW_LINES = 40;

/**
 * A file too big to paste, described precisely enough to ask about.
 *
 * The opening lines are usually the imports and the shape of the thing, which
 * is what a reader needs to know *what to ask for*. Everything else is one
 * `workspace.read_file` away, and saying so explicitly is what makes the chat
 * do it rather than guess.
 */
function describeInsteadOfSending(path: string, content: string): string {
  const lines = content.split("\n");
  const preview = lines.slice(0, PREVIEW_LINES).join("\n");

  return [
    `${path} is ${lines.length} lines (${content.length} characters) — too long to paste in full.`,
    "",
    `Here are the first ${Math.min(PREVIEW_LINES, lines.length)} lines:`,
    "",
    "```",
    preview,
    "```",
    "",
    `Ask for any part of it with \`workspace.read_file\` and \`startLine\`/\`endLine\`, ` +
      `or search it with \`workspace.search\`. Do not guess at what the rest contains.`,
  ].join("\n");
}
