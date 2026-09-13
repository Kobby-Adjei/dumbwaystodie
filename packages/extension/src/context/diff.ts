/**
 * A minimal line diff, for saying what changed instead of saying it all again.
 *
 * Borrowed wholesale from how version control has always framed this: the
 * expensive thing is the content, so send the edit, not the document. Nothing
 * here is clever — an LCS table over lines and a walk back through it — but it
 * is exact, and an approximate diff would be worse than no diff at all.
 *
 * Pure by design: no `vscode`, no I/O, so it can be tested directly.
 */

export interface DiffHunk {
  /** 1-based line number in the old text where this hunk starts. */
  oldStart: number;
  oldLines: number;
  /** 1-based line number in the new text where this hunk starts. */
  newStart: number;
  newLines: number;
  /** Unified-diff lines: " context", "-removed", "+added". */
  lines: string[];
}

export interface DiffResult {
  hunks: DiffHunk[];
  /** Lines added and removed — the honest measure of "how big is this edit". */
  changedLines: number;
}

type Op = { kind: "same" | "add" | "remove"; text: string };

/**
 * Longest common subsequence over lines.
 *
 * The table is O(n·m), which is why `diffLines` refuses oversized inputs
 * rather than quietly allocating a gigabyte: a diff that costs more than
 * resending the file has defeated its own purpose.
 */
function operations(oldLines: string[], newLines: string[]): Op[] {
  const rows = oldLines.length;
  const columns = newLines.length;

  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(columns + 1).fill(0),
  );

  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      const row = table[i] as number[];
      const next = table[i + 1] as number[];
      row[j] =
        oldLines[i] === newLines[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;

  while (i < rows && j < columns) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: "same", text: oldLines[i] as string });
      i += 1;
      j += 1;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      ops.push({ kind: "remove", text: oldLines[i] as string });
      i += 1;
    } else {
      ops.push({ kind: "add", text: newLines[j] as string });
      j += 1;
    }
  }

  while (i < rows) {
    ops.push({ kind: "remove", text: oldLines[i] as string });
    i += 1;
  }
  while (j < columns) {
    ops.push({ kind: "add", text: newLines[j] as string });
    j += 1;
  }

  return ops;
}

/** Above this, the LCS table costs more than it saves. */
export const MAX_DIFF_LINES = 4000;

export function diffLines(
  before: string,
  after: string,
  contextLines = 3,
): DiffResult | undefined {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");

  if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) {
    return undefined;
  }

  const ops = operations(oldLines, newLines);
  const changedLines = ops.filter((op) => op.kind !== "same").length;
  if (changedLines === 0) {
    return { hunks: [], changedLines: 0 };
  }

  // Group changes that are close together, so a file with two edits produces
  // two small hunks rather than one hunk spanning everything between them.
  const changedIndexes = ops
    .map((op, index) => (op.kind === "same" ? -1 : index))
    .filter((index) => index >= 0);

  const groups: Array<[number, number]> = [];
  for (const index of changedIndexes) {
    const last = groups[groups.length - 1];
    if (last && index - last[1] <= contextLines * 2) {
      last[1] = index;
    } else {
      groups.push([index, index]);
    }
  }

  const hunks: DiffHunk[] = [];

  for (const [first, final] of groups) {
    const from = Math.max(0, first - contextLines);
    const to = Math.min(ops.length - 1, final + contextLines);

    // Line numbers are counted by replaying the ops before this hunk, which
    // keeps them honest even when earlier hunks changed the file's length.
    let oldLine = 1;
    let newLine = 1;
    for (let index = 0; index < from; index += 1) {
      const op = ops[index] as Op;
      if (op.kind !== "add") oldLine += 1;
      if (op.kind !== "remove") newLine += 1;
    }

    const lines: string[] = [];
    let oldCount = 0;
    let newCount = 0;

    for (let index = from; index <= to; index += 1) {
      const op = ops[index] as Op;
      if (op.kind === "same") {
        lines.push(` ${op.text}`);
        oldCount += 1;
        newCount += 1;
      } else if (op.kind === "remove") {
        lines.push(`-${op.text}`);
        oldCount += 1;
      } else {
        lines.push(`+${op.text}`);
        newCount += 1;
      }
    }

    hunks.push({
      oldStart: oldLine,
      oldLines: oldCount,
      newStart: newLine,
      newLines: newCount,
      lines,
    });
  }

  return { hunks, changedLines };
}

/** Renders hunks in the format every developer and model already reads. */
export function renderUnifiedDiff(path: string, result: DiffResult): string {
  const body = result.hunks
    .map(
      (hunk) =>
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}`,
    )
    .join("\n");

  return `--- a/${path}\n+++ b/${path}\n${body}`;
}
