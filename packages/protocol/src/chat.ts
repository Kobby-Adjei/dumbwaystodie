import type { ToolDescriptor } from "./tools";

/**
 * The chat-surface protocol (spec §0G, §0L, §0O).
 *
 * The design inverts how a browser bridge is usually built. The common
 * approach makes the *transport* smart — CSS selectors, mutation observers
 * guessing when streaming stopped — and the payload dumb. Every one of those
 * breaks on a site redesign, and breaks silently.
 *
 * Here the payload is self-identifying and the transport is allowed to be
 * stupid: the coach wraps machine-readable parts in a fenced block tagged
 * `dwtd`, and extraction becomes "find the fenced block" rather than "parse
 * rendered prose into meaning".
 *
 * What that buys, in order of importance:
 *
 *  - **One parser, every transport.** Reading the DOM, reading the clipboard,
 *    and a human pasting by hand all produce the same string, so they all use
 *    this code. The fallback path is not a separate implementation that rots.
 *  - **Self-verification.** A block either parses as JSON or it does not.
 *    There is no half-read that looks like an answer.
 *  - **A stable seam.** When a site changes, the selector that finds "the last
 *    message" may break; the format of what is inside it does not.
 *
 * Everything arriving here comes from a web page and is untrusted (spec §75).
 * This module only *parses*; whether a parsed tool call is honoured is the
 * permission gate's decision, unchanged.
 */

export const CHAT_BLOCK_FENCE = "dwtd";
export const CHAT_PROTOCOL_VERSION = 1;

/** Refuse absurd input rather than trying to parse it (spec §75). */
export const MAX_BLOCK_CHARACTERS = 64 * 1024;
export const MAX_BLOCKS_PER_MESSAGE = 8;

export interface ChatToolCallBlock {
  v: 1;
  type: "tool.call";
  /** Correlates the call; the coach echoes it so results can be matched. */
  id: string;
  tool: string;
  args?: unknown;
}

export interface ChatToolResultBlock {
  v: 1;
  type: "tool.result";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export type ChatBlock = ChatToolCallBlock | ChatToolResultBlock;

export interface ChatBlockProblem {
  /** 1-based index of the fenced block within the message. */
  index: number;
  reason: string;
}

export interface ChatExtraction {
  /** The message with all dwtd blocks removed — what a human should read. */
  prose: string;
  blocks: ChatBlock[];
  /** Blocks that looked like ours but were not usable, and why. */
  problems: ChatBlockProblem[];
}

/**
 * Matches a fenced block tagged `dwtd`, tolerating 3+ backticks and trailing
 * whitespace on the info line. Deliberately permissive about what surrounds
 * it: the coach is talking to a human as well as to us.
 */
const BLOCK_PATTERN = /^([ \t]*)(`{3,})[ \t]*dwtd[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*\2[ \t]*$/gm;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pulls machine-readable blocks out of a chat message.
 *
 * Never throws. A malformed block is reported as a problem and the rest of the
 * message is still usable — a coach that mangles one block should not cost the
 * user the whole answer.
 */
export function extractChatBlocks(message: string): ChatExtraction {
  const blocks: ChatBlock[] = [];
  const problems: ChatBlockProblem[] = [];
  let prose = message;
  let index = 0;

  for (const match of message.matchAll(BLOCK_PATTERN)) {
    index += 1;
    const raw = match[3] ?? "";

    if (index > MAX_BLOCKS_PER_MESSAGE) {
      problems.push({ index, reason: `more than ${MAX_BLOCKS_PER_MESSAGE} blocks in one message` });
      continue;
    }
    if (raw.length > MAX_BLOCK_CHARACTERS) {
      problems.push({ index, reason: `block is larger than ${MAX_BLOCK_CHARACTERS} characters` });
      continue;
    }

    prose = prose.replace(match[0], "");

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      problems.push({ index, reason: "not valid JSON" });
      continue;
    }

    const block = validateBlock(parsed);
    if ("reason" in block) {
      problems.push({ index, reason: block.reason });
      continue;
    }
    blocks.push(block.block);
  }

  return { prose: prose.replace(/\n{3,}/g, "\n\n").trim(), blocks, problems };
}

function validateBlock(value: unknown): { block: ChatBlock } | { reason: string } {
  if (!isRecord(value)) {
    return { reason: "block is not an object" };
  }
  if (value["v"] !== CHAT_PROTOCOL_VERSION) {
    // Spec §49: reject a version we do not speak rather than guessing at it.
    return { reason: `unsupported block version ${String(value["v"])}` };
  }

  const type = value["type"];
  const id = value["id"];
  if (typeof id !== "string" || id.length === 0) {
    return { reason: '"id" must be a non-empty string' };
  }

  if (type === "tool.call") {
    if (typeof value["tool"] !== "string" || value["tool"].length === 0) {
      return { reason: '"tool" must be a non-empty string' };
    }
    const block: ChatToolCallBlock = { v: 1, type: "tool.call", id, tool: value["tool"] };
    if ("args" in value) {
      block.args = value["args"];
    }
    return { block };
  }

  if (type === "tool.result") {
    if (typeof value["ok"] !== "boolean") {
      return { reason: '"ok" must be a boolean' };
    }
    const block: ChatToolResultBlock = { v: 1, type: "tool.result", id, ok: value["ok"] };
    if ("result" in value) {
      block.result = value["result"];
    }
    return { block };
  }

  return { reason: `unknown block type ${JSON.stringify(type)}` };
}

/** Renders a block for pasting into a chat. */
export function renderChatBlock(block: ChatBlock): string {
  return ["```" + CHAT_BLOCK_FENCE, JSON.stringify(block, null, 2), "```"].join("\n");
}

/**
 * The primer a user pastes once to turn a normal conversation into a coaching
 * session.
 *
 * Deliberately **protocol only**. It says nothing about how to teach, what
 * tone to take, or when to withhold an answer — that is the user's business
 * and the provider's, not the bridge's. Anyone wanting a particular coaching
 * style writes it themselves, in their own words, in the same conversation.
 *
 * The tool list is passed in from the registry rather than hardcoded, so the
 * primer can never advertise a tool that is not actually registered — the same
 * rule the request's capabilities follow.
 */
export function buildChatPrimer(tools: ToolDescriptor[]): string {
  const lines: string[] = [
    "# Dumb Ways to Die — bridge protocol",
    "",
    "I am pasting messages from my editor. Each one includes what I am looking",
    "at: the active file, my selection, unsaved changes, and any errors.",
    "",
    "Answer normally, in prose. Nothing special is needed for a plain answer.",
  ];

  // No tools means no way to ask for anything, so the request mechanism is
  // omitted entirely rather than described and then refused. The example below
  // is built from a real registered tool for the same reason.
  const example = tools[0];
  if (example) {
    lines.push(
      "",
      "## If you need to see more",
      "",
      "You can ask my editor for information. Put the request in a fenced block",
      "tagged `dwtd`, on its own, and stop there — I will run it and paste the",
      "result back before you continue.",
      "",
      "```" + CHAT_BLOCK_FENCE,
      JSON.stringify({ v: 1, type: "tool.call", id: "call_1", tool: example.name }, null, 2),
      "```",
      "",
      "Rules for these blocks:",
      "",
      '- one JSON object, `"v": 1`, and an `"id"` you choose;',
      '- put any arguments in `"args"` — the list below says what each takes;',
      "- ask for everything you already know you need, one block each — they run",
      "  together and come back in a single message, so three blocks cost one",
      "  round trip instead of three;",
      "- only ask for things you can name now: if what you need depends on what",
      "  a result says, wait and ask in the next message;",
      "- prose outside the block is fine and will be shown to me;",
      "- if a request is refused, you will get a block back saying why. Read the",
      "  reason and adapt rather than repeating the same request.",
      "",
      "## What you can ask for",
      "",
    );

    for (const tool of tools) {
      const gate = tool.permission === "read" ? "" : " (needs my approval each time)";
      lines.push(`- \`${tool.name}\`${gate} — ${tool.description}`);
    }

    lines.push(
      "",
      "Anything not on that list will be refused. Requests that leave my project",
      "folder, or touch credential files, are refused before I ever see them.",
    );
  } else {
    lines.push(
      "",
      "This bridge has no tools enabled, so I cannot fetch anything further for",
      "you — work from what each message contains.",
    );
  }

  lines.push("", "Reply with just `ready` if this makes sense.");

  return lines.join("\n");
}
