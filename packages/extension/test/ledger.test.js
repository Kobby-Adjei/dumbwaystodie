const test = require("node:test");
const assert = require("node:assert/strict");

const { ContextLedger, DEFAULT_LEDGER_OPTIONS } = require("../out/context/ledger.js");
const { diffLines, renderUnifiedDiff, MAX_DIFF_LINES } = require("../out/context/diff.js");

/**
 * Payload management.
 *
 * The whole idea rests on one claim — "the chat already has this" — and that
 * claim is only safe if it is exactly true. So these test the refusals as
 * hard as the savings: a ledger that over-claims makes a chat answer about
 * content it never received, which is worse than sending too much.
 */

const file = (path, content) => ({
  type: "file",
  path,
  source: "editor-buffer",
  content,
  truncated: false,
});

const BODY = ["one", "two", "three", "four", "five"].join("\n");

/* ------------------------------------------------------------------ *
 * The diff itself
 * ------------------------------------------------------------------ */

test("an unchanged file produces no hunks", () => {
  const result = diffLines(BODY, BODY);
  assert.equal(result.changedLines, 0);
  assert.deepEqual(result.hunks, []);
});

test("a one-line edit produces one small hunk", () => {
  const after = BODY.replace("three", "THREE");
  const result = diffLines(BODY, after);

  assert.equal(result.hunks.length, 1);
  assert.equal(result.changedLines, 2, "one removal and one addition");

  const rendered = renderUnifiedDiff("a.txt", result);
  assert.match(rendered, /^--- a\/a\.txt/m);
  assert.match(rendered, /-three/);
  assert.match(rendered, /\+THREE/);
  assert.match(rendered, /@@ -\d+,\d+ \+\d+,\d+ @@/);
});

test("edits far apart become separate hunks, not one spanning everything", () => {
  const before = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n");
  const after = before.replace("line 2", "CHANGED 2").replace("line 55", "CHANGED 55");

  const result = diffLines(before, after);
  assert.equal(result.hunks.length, 2, "a 60-line file with two edits is two hunks");
});

test("line numbers survive an earlier hunk changing the file's length", () => {
  const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n");
  // Delete near the top, edit near the bottom: the second hunk's old and new
  // line numbers must diverge, which is exactly what naive counting gets wrong.
  const after = ["a", "c", "d", "e", "f", "g", "h", "i", "J"].join("\n");

  const result = diffLines(before, after, 1);
  const last = result.hunks[result.hunks.length - 1];
  assert.notEqual(last.oldStart, last.newStart, "the deletion must shift the numbering");
});

test("a file too large to diff cheaply is refused rather than allocated for", () => {
  const huge = Array.from({ length: MAX_DIFF_LINES + 1 }, () => "x").join("\n");
  assert.equal(diffLines(huge, huge + "\ny"), undefined);
});

/* ------------------------------------------------------------------ *
 * The ledger
 * ------------------------------------------------------------------ */

test("the first time a file is seen, it is sent in full", () => {
  const ledger = new ContextLedger();
  ledger.startSession("s1");

  const { items, savedCharacters } = ledger.plan([file("a.js", BODY)]);

  assert.equal(items.length, 1);
  assert.equal(items[0].type, "file");
  assert.equal(items[0].content, BODY);
  assert.equal(savedCharacters, 0, "nothing can be saved on a first send");
});

test("the second time, unchanged, it is referenced instead of resent", () => {
  const ledger = new ContextLedger();
  ledger.startSession("s1");
  ledger.plan([file("a.js", BODY)]);

  const { items, savedCharacters } = ledger.plan([file("a.js", BODY)]);

  assert.equal(items[0].type, "note");
  assert.match(items[0].note, /unchanged since I sent it earlier/);
  assert.match(items[0].note, /a\.js/);
  assert.equal(savedCharacters, BODY.length);
});

test("a changed file is sent as a diff against what the chat already has", () => {
  const ledger = new ContextLedger();
  ledger.startSession("s1");

  const before = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n");
  ledger.plan([file("a.js", before)]);

  const after = before.replace("line 100", "line one hundred");
  const { items, savedCharacters } = ledger.plan([file("a.js", after)]);

  assert.equal(items[0].type, "note");
  assert.match(items[0].note, /```diff/);
  assert.match(items[0].note, /-line 100/);
  assert.match(items[0].note, /\+line one hundred/);
  assert.match(items[0].note, /Apply this to the copy you have/);
  assert.ok(savedCharacters > 0, "a one-line edit in a 200-line file must save something");
});

test("a file rewritten beyond recognition is resent whole, not diffed", () => {
  // A diff bigger than the file is not a saving, it is a second copy.
  const ledger = new ContextLedger();
  ledger.startSession("s1");

  const before = Array.from({ length: 100 }, (_, index) => `alpha ${index}`).join("\n");
  ledger.plan([file("a.js", before)]);

  const after = Array.from({ length: 100 }, (_, index) => `omega ${index}`).join("\n");
  const { items } = ledger.plan([file("a.js", after)]);

  assert.equal(items[0].type, "file", "a total rewrite is cheaper to send as itself");
  assert.equal(items[0].content, after);
});

test("the diff is against the latest version, not the first one ever sent", () => {
  // The chat has applied edit one; diffing against the original would tell it
  // to apply changes it already made.
  const ledger = new ContextLedger();
  ledger.startSession("s1");

  const v1 = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n");
  const v2 = v1.replace("line 10", "TEN");
  const v3 = v2.replace("line 20", "TWENTY");

  ledger.plan([file("a.js", v1)]);
  ledger.plan([file("a.js", v2)]);
  const { items } = ledger.plan([file("a.js", v3)]);

  assert.match(items[0].note, /\+TWENTY/);
  assert.doesNotMatch(items[0].note, /\+TEN/, "edit one was already delivered");
});

/* ------------------------------------------------------------------ *
 * Pull instead of push
 * ------------------------------------------------------------------ */

test("a very large new file is described, with instructions to ask for the rest", () => {
  const ledger = new ContextLedger();
  ledger.startSession("s1");

  const huge = Array.from({ length: 900 }, (_, index) => `line ${index} of a long file`).join("\n");
  assert.ok(huge.length > DEFAULT_LEDGER_OPTIONS.pullThreshold);

  const { items, savedCharacters } = ledger.plan([file("big.js", huge)]);

  assert.equal(items[0].type, "note");
  assert.match(items[0].note, /900 lines/);
  assert.match(items[0].note, /too long to paste in full/);
  assert.match(items[0].note, /workspace\.read_file/, "it must say how to get the rest");
  assert.match(items[0].note, /Do not guess/);
  assert.ok(savedCharacters > 0);

  // The preview is a real prefix of the file, not a summary of it.
  assert.match(items[0].note, /line 0 of a long file/);
  assert.doesNotMatch(items[0].note, /line 800 of a long file/);
});

/* ------------------------------------------------------------------ *
 * The claim that must never be wrong
 * ------------------------------------------------------------------ */

test("a new session never claims the chat has seen anything", () => {
  const ledger = new ContextLedger();

  ledger.startSession("s1");
  ledger.plan([file("a.js", BODY)]);

  // A different conversation has been told nothing, whatever the last one saw.
  ledger.startSession("s2");
  const { items } = ledger.plan([file("a.js", BODY)]);

  assert.equal(items[0].type, "file", "a fresh chat must be sent the file");
  assert.equal(items[0].content, BODY);
});

test("re-entering the same session does not wipe what it was told", () => {
  const ledger = new ContextLedger();
  ledger.startSession("s1");
  ledger.plan([file("a.js", BODY)]);

  ledger.startSession("s1");
  const { items } = ledger.plan([file("a.js", BODY)]);
  assert.equal(items[0].type, "note", "same conversation, still has the file");
});

test("two files are tracked independently", () => {
  const ledger = new ContextLedger();
  ledger.startSession("s1");
  ledger.plan([file("a.js", BODY), file("b.js", "different")]);

  const { items } = ledger.plan([file("a.js", BODY), file("b.js", "changed entirely")]);

  assert.equal(items[0].type, "note", "a.js is unchanged");
  assert.equal(items[1].type, "file", "b.js is not");
});

test("everything that is not a file passes through untouched", () => {
  const ledger = new ContextLedger();
  ledger.startSession("s1");

  const selection = { type: "selection", path: "a.js", language: "js", content: "x", isDirty: false, startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 };
  const note = { type: "note", note: "engine said something" };

  const { items } = ledger.plan([selection, note]);
  assert.deepEqual(items, [selection, note]);
});

/* ------------------------------------------------------------------ *
 * Coverage: never claim the chat has bytes it was not sent
 *
 * The bug these pin: a previewed file was recorded with its *full* content, so
 * the next turn could say "use the copy you have" or emit a diff against text
 * the chat never received. The chat would then answer confidently about
 * content it does not have — the exact failure this whole idea rests on
 * avoiding.
 * ------------------------------------------------------------------ */

const big = () =>
  Array.from({ length: 900 }, (_, index) => `line ${index} of a long file`).join("\n");

test("a previewed file is recorded as a preview, not as sent", () => {
  const ledger = new ContextLedger();
  ledger.startSession("s1");
  ledger.plan([file("big.js", big())]);

  assert.equal(ledger.coverageOf("big.js"), "preview");
});

test("an unchanged previewed file is never called a copy the chat holds", () => {
  const ledger = new ContextLedger();
  ledger.startSession("s1");
  const content = big();
  ledger.plan([file("big.js", content)]);

  const { items } = ledger.plan([file("big.js", content)]);

  assert.equal(items[0].type, "note");
  assert.doesNotMatch(items[0].note, /use that copy/i, "the chat has no copy to use");
  assert.match(items[0].note, /did not send the whole file/i);
  assert.match(items[0].note, /workspace\.read_file/, "and it says how to get it");
});

test("a changed previewed file is never diffed against unseen text", () => {
  /*
   * A diff says "apply this to what you have". Applied to a preview it would
   * corrupt the chat's understanding rather than update it.
   */
  const ledger = new ContextLedger();
  ledger.startSession("s1");
  const before = big();
  ledger.plan([file("big.js", before)]);

  const { items } = ledger.plan([file("big.js", before.replace("line 100", "CHANGED"))]);

  assert.equal(items[0].type, "note");
  assert.doesNotMatch(items[0].note, /```diff/, "no diff against a preview");
  assert.match(items[0].note, /too long to paste in full/i, "it is described again");
});

test("a fully sent file keeps its reference and diff powers", () => {
  // The optimisation still works where it is honest.
  const ledger = new ContextLedger();
  ledger.startSession("s1");
  const small = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n");

  ledger.plan([file("a.js", small)]);
  assert.equal(ledger.coverageOf("a.js"), "full");

  assert.match(ledger.plan([file("a.js", small)]).items[0].note, /use that copy/);
  assert.match(
    ledger.plan([file("a.js", small.replace("line 10", "TEN"))]).items[0].note,
    /```diff/,
  );
});

test("a diff promotes coverage to full, because the copy is now complete", () => {
  const ledger = new ContextLedger();
  ledger.startSession("s1");
  const v1 = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n");
  const v2 = v1.replace("line 10", "TEN");

  ledger.plan([file("a.js", v1)]);
  ledger.plan([file("a.js", v2)]);

  assert.equal(ledger.coverageOf("a.js"), "full");
  assert.match(ledger.plan([file("a.js", v2)]).items[0].note, /use that copy/);
});

test("a file that shrinks below the threshold is sent in full and upgraded", () => {
  // Previewed while large, then trimmed: the chat should now actually get it.
  const ledger = new ContextLedger();
  ledger.startSession("s1");
  ledger.plan([file("big.js", big())]);

  const { items } = ledger.plan([file("big.js", "now tiny\n")]);
  assert.equal(items[0].type, "file");
  assert.equal(ledger.coverageOf("big.js"), "full");
});
