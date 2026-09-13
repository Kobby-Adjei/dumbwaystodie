/**
 * Removing the chat's own furniture from a reply.
 *
 * What a chat renders around an answer is not part of the answer: a reasoning
 * panel's "Thinking…" and "Thought Process" headers, a "Skip" control, "Copy"
 * and "Regenerate" buttons, "Show more". Reading the container that holds the
 * answer picks all of it up, because it is text inside that container.
 *
 * This is deliberately *not* a list of sites. Every one of these labels is a
 * one- or two-word line that a chat interface puts near an answer, and the same
 * words appear on every one of them — which makes them recognisable by shape
 * (a short line, alone, saying a UI thing) rather than by which site drew them.
 *
 * Conservative on purpose. Dropping a line of a real answer is far worse than
 * leaving a stray "Skip" in, so a line is only removed when it is short *and*
 * matches a known control word exactly. A sentence that merely contains the
 * word "thinking" is left alone.
 */

/** Words that are UI controls when they are the whole line, and nothing else. */
const FURNITURE = [
  /^thinking\.{0,3}$/i,
  /^thought\s+process$/i,
  /^thoughts?$/i,
  /^reasoning$/i,
  /^skip$/i,
  /^copy$/i,
  /^copied!?$/i,
  /^regenerate$/i,
  /^retry$/i,
  /^edit$/i,
  /^share$/i,
  /^show\s+(more|less|thinking|reasoning)$/i,
  /^hide\s+(thinking|reasoning)$/i,
  /^(good|bad)\s+response$/i,
  /^like$/i,
  /^dislike$/i,
  /^read\s+aloud$/i,
  /^\d+\s*\/\s*\d+$/,
  /^(sources?|citations?)$/i,
];

/** Above this many characters a line is prose, whatever words are in it. */
const MAX_FURNITURE_LENGTH = 24;

export function isFurniture(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_FURNITURE_LENGTH) {
    return false;
  }
  return FURNITURE.some((pattern) => pattern.test(trimmed));
}

/**
 * A reply with the interface stripped out and repetition collapsed.
 *
 * The duplication case is real and not hypothetical: a reasoning panel often
 * renders a summary of the answer above the answer itself, so the same
 * paragraph arrives twice in one container. Keeping the *later* copy is right —
 * that is the finished one, and the earlier is a preview of it.
 */
export function cleanReply(text: string): string {
  const lines = text.split("\n").filter((line) => !isFurniture(line));

  /*
   * Blank lines are trimmed from the ends only, never from the start of a line.
   *
   * A whole-string `.trim()` was the first version and it ate the indentation
   * of the first line — which is exactly the whitespace that makes pasted code
   * and drawn diagrams line up, and which took real work to preserve earlier.
   */
  while (lines.length > 0 && (lines[0] ?? "").trim() === "") {
    lines.shift();
  }
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") {
    lines.pop();
  }

  return collapseRepeat(lines).join("\n");
}

/**
 * Collapses text that is one answer rendered twice.
 *
 * Reasoning panels often show a preview of the answer above the answer, so the
 * same paragraph arrives twice inside one container. The later copy is kept:
 * that is the finished one, and the earlier is a draft of it.
 *
 * Compared line by line rather than by character count, and only when the two
 * halves match exactly. Anything looser starts deleting legitimately repeated
 * lines out of code listings — `return 1;` twice is a program, not an echo.
 */
function collapseRepeat(lines: readonly string[]): string[] {
  const enough = (part: readonly string[]): boolean => part.join("\n").trim().length > 40;

  // Two equal halves, with nothing between them.
  if (lines.length >= 2 && lines.length % 2 === 0) {
    const half = lines.length / 2;
    const front = lines.slice(0, half);
    const back = lines.slice(half);
    if (enough(front) && front.join("\n").trim() === back.join("\n").trim()) {
      return [...back];
    }
  }

  // Two equal halves with one blank line between them, which is how a panel
  // separates its preview from the answer.
  if (lines.length >= 3 && lines.length % 2 === 1) {
    const half = (lines.length - 1) / 2;
    if ((lines[half] ?? "").trim() === "") {
      const front = lines.slice(0, half);
      const back = lines.slice(half + 1);
      if (enough(front) && front.join("\n").trim() === back.join("\n").trim()) {
        return [...back];
      }
    }
  }

  return [...lines];
}
