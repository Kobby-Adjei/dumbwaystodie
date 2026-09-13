import { CHAT_BLOCK_FENCE } from "@dumbways/protocol";

/**
 * Deciding when a streaming reply has finished.
 *
 * This is the part of a browser bridge that is usually a guess, so it is pure
 * and tested rather than buried in a MutationObserver callback.
 *
 * Two signals, in order of confidence:
 *
 *  1. **A closed protocol block that has stopped growing.** Our own messages
 *     end with a fence, so a complete ```dwtd block means the machine-readable
 *     part has arrived. It does *not* mean the reply is over: a chat asking for
 *     three files writes three blocks, and taking the first one as the ending
 *     would drop the other two — silently, which is the worst way to fail here
 *     because the chat has no way to notice. So a closed block still waits for
 *     the text to settle, just far less patiently than prose does.
 *  2. **Quiescence.** Plain prose has no marker, so the only honest signal is
 *     "it stopped changing". That is a timeout, and it is treated as one: a
 *     guess with a stated confidence, not a fact.
 */

/*
 * How long silence has to last before a reply counts as finished.
 *
 * 900ms was too eager: chats pause mid-answer — between paragraphs, while a
 * code block renders, when the network hiccups — and every such pause was read
 * as "done", cutting the reply off mid-sentence. Waiting longer costs a moment
 * on every turn; guessing early loses text, and the user cannot tell that it
 * happened. Partial replies are delivered while this runs, so the extra wait
 * is not dead time on screen.
 */
export const DEFAULT_IDLE_MS = 2200;
export const DEFAULT_MAX_WAIT_MS = 120_000;

/**
 * How often the reply is read while it is still arriving.
 *
 * Deliberately independent of the idle threshold. The poll used to be
 * `idle / 3`, so lengthening the settle window to avoid truncation also made
 * the visible text update three times more slowly — one number quietly
 * controlling both how patient the verdict is and how live the panel feels.
 */
export const POLL_INTERVAL_MS = 250;

/**
 * How long a closed block waits to see whether another one follows.
 *
 * Short, because a fence is strong evidence and the whole point of noticing it
 * is not waiting the full prose window. Long enough to cover the gap between
 * two blocks in one reply, which is a render, not a network round trip.
 */
export const CLOSED_BLOCK_IDLE_MS = 600;

export type CompletionReason = "closed-block" | "idle" | "timeout";

export interface CompletionVerdict {
  complete: boolean;
  reason: CompletionReason | "still-changing";
  /** False when we are inferring from silence rather than from a marker. */
  certain: boolean;
}

/**
 * Whether an observation may be returned to the editor now.
 *
 * A visible stop control vetoes an idle guess, but it cannot veto facts: a
 * closed protocol block is complete by construction, and the hard deadline is
 * the backstop that keeps a stale site control from holding a request forever.
 */
export function shouldAcceptCompletion(
  verdict: CompletionVerdict,
  generating: boolean,
): boolean {
  if (!verdict.complete) {
    return false;
  }
  return !generating || verdict.reason === "closed-block" || verdict.reason === "timeout";
}

/** A complete fenced block: opening fence, body, matching closing fence. */
const CLOSED_BLOCK = new RegExp(
  `(\`{3,})[ \\t]*${CHAT_BLOCK_FENCE}[ \\t]*\\r?\\n[\\s\\S]*?\\r?\\n[ \\t]*\\1`,
);

export function hasClosedBlock(text: string): boolean {
  return CLOSED_BLOCK.test(text);
}

/** A protocol block that has been opened and not yet closed. */
const OPEN_BLOCK = new RegExp(`\`{3,}[ \t]*${CHAT_BLOCK_FENCE}`, "g");

/**
 * Whether the text ends inside an unfinished protocol block.
 *
 * Counting opens against closes, rather than looking at the tail: a reply that
 * has written one complete block and started a second one ends mid-block even
 * though a closed block is present. Taking that for the ending is how two of
 * three requested tool calls get dropped.
 */
export function endsInsideBlock(text: string): boolean {
  const opened = text.match(OPEN_BLOCK)?.length ?? 0;
  if (opened === 0) {
    return false;
  }

  let closed = 0;
  let rest = text;
  for (;;) {
    const match = CLOSED_BLOCK.exec(rest);
    if (!match) {
      break;
    }
    closed += 1;
    rest = rest.slice(match.index + match[0].length);
  }

  return closed < opened;
}

export interface QuiescenceInput {
  text: string;
  msSinceLastChange: number;
  msSinceStart: number;
  idleMs?: number;
  maxWaitMs?: number;
  closedBlockIdleMs?: number;
}

export function judgeCompletion(input: QuiescenceInput): CompletionVerdict {
  const idleMs = input.idleMs ?? DEFAULT_IDLE_MS;
  const maxWaitMs = input.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

  const closedBlockIdleMs = input.closedBlockIdleMs ?? CLOSED_BLOCK_IDLE_MS;

  /*
   * A block still being written is proof the reply is not over, whatever else
   * the text contains. Checked before the closed-block rule, because a reply
   * with two blocks — one finished, one in progress — has both.
   */
  const midBlock = endsInsideBlock(input.text);

  if (!midBlock && hasClosedBlock(input.text) && input.msSinceLastChange >= closedBlockIdleMs) {
    return { complete: true, reason: "closed-block", certain: true };
  }

  if (input.msSinceStart >= maxWaitMs) {
    return { complete: true, reason: "timeout", certain: false };
  }

  if (midBlock) {
    return { complete: false, reason: "still-changing", certain: false };
  }

  // Empty text that has merely stopped changing is not a finished answer; it
  // is a reply that has not started.
  if (input.text.trim().length === 0) {
    return { complete: false, reason: "still-changing", certain: false };
  }

  if (input.msSinceLastChange >= idleMs) {
    return { complete: true, reason: "idle", certain: false };
  }

  return { complete: false, reason: "still-changing", certain: false };
}
