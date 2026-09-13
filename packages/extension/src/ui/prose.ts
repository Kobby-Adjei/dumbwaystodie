/**
 * Splitting a reply into prose and diagrams.
 *
 * A chat explaining binary search draws things like:
 *
 *     [23, 31, 40, 51]
 *          ↑
 *          31
 *
 * That only means anything if the arrow sits under the number. Prose is
 * rendered in the editor's proportional UI font, where a space is narrower
 * than a digit — so the columns drift and the diagram ends up pointing at the
 * wrong value. The whitespace was never lost; the character widths were.
 *
 * So runs of lines that depend on alignment are found here and rendered
 * monospaced, and everything else stays proportional, which is easier to read.
 *
 * Pure and tested: getting this wrong makes a correct explanation look wrong.
 */

export type ProseSegment = { kind: "text" | "art"; text: string };

/**
 * Characters whose whole purpose is to point at a column.
 *
 * Deliberately narrow. An earlier draft also treated "two or more spaces in a
 * row" as a diagram, which caught ordinary sentences that happened to be typed
 * with a double space and rendered them in monospace for no reason.
 */
const ALIGNMENT = /[↑↓←→⬆⬇▲▼│┃─━┌┐└┘├┤┬┴┼╭╮╰╯╱╲]/;

/** `^` used as an arrow: only when it is doing the pointing, not in `a^2`. */
const CARET_ARROW = /^\s*\^+\s*$/;

function isAlignmentLine(line: string): boolean {
  return ALIGNMENT.test(line) || CARET_ARROW.test(line);
}

export function splitProse(text: string): ProseSegment[] {
  const lines = text.split("\n");

  /*
   * An arrow line is useless on its own — it points at the line above it, and
   * often labels itself on the line below. So a marked line claims its
   * immediate non-blank neighbours, and the whole run is set monospaced
   * together. Monospacing only the arrow would leave it just as misaligned.
   */
  const art = new Array<boolean>(lines.length).fill(false);

  lines.forEach((line, index) => {
    if (!isAlignmentLine(line)) {
      return;
    }
    art[index] = true;
    for (const neighbour of [index - 1, index + 1]) {
      if (lines[neighbour] !== undefined && lines[neighbour]?.trim() !== "") {
        art[neighbour] = true;
      }
    }
  });

  const segments: ProseSegment[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const kind: ProseSegment["kind"] = art[index] ? "art" : "text";
    const last = segments[segments.length - 1];

    if (last && last.kind === kind) {
      last.text += `\n${lines[index] ?? ""}`;
    } else {
      segments.push({ kind, text: lines[index] ?? "" });
    }
  }

  // Blank runs between segments carry no meaning of their own.
  return segments
    .map((segment) => ({ ...segment, text: segment.text.replace(/^\n+|\n+$/g, "") }))
    .filter((segment) => segment.text.length > 0);
}
