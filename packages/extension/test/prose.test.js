const test = require("node:test");
const assert = require("node:assert/strict");

const { splitProse } = require("../out/ui/prose.js");

/**
 * Diagrams have to survive the trip.
 *
 * The bug: a chat drew an arrow under a number, the panel rendered it in a
 * proportional font, and the arrow pointed at the wrong value. A correct
 * explanation was displayed as an incorrect one.
 */

test("ordinary prose is one text segment", () => {
  const segments = splitProse("Binary search halves the range.\nThat is the whole idea.");
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, "text");
});

test("an arrow claims the line it points at and the line that labels it", () => {
  const segments = splitProse(
    ["Now only consider:", "", "[23, 31, 40, 51]", "     ↑", "     31", "", "So we continue."].join(
      "\n",
    ),
  );

  const art = segments.filter((segment) => segment.kind === "art");
  assert.equal(art.length, 1);

  // All three lines must be monospaced together: setting only the arrow line
  // leaves it just as misaligned as before.
  assert.match(art[0].text, /\[23, 31, 40, 51\]/);
  assert.match(art[0].text, /↑/);
  assert.match(art[0].text, /31$/);

  assert.equal(segments[0].kind, "text");
  assert.equal(segments[segments.length - 1].kind, "text");
  assert.match(segments[segments.length - 1].text, /So we continue/);
});

test("the arrow's column is preserved exactly", () => {
  const segments = splitProse("[23, 31]\n     ↑");
  const art = segments.find((segment) => segment.kind === "art");
  assert.match(art.text, /\n {5}↑/, "leading spaces are the entire point");
});

test("box drawing counts as a diagram", () => {
  const segments = splitProse("Tree:\n├─ src\n└─ test");
  assert.ok(segments.some((segment) => segment.kind === "art"));
});

test("a caret alone is an arrow; a caret in maths is not", () => {
  assert.ok(splitProse("value\n  ^").some((segment) => segment.kind === "art"));

  // "n^2" must not drag a paragraph into monospace.
  const prose = splitProse("It runs in O(n^2) time, which is slow.");
  assert.equal(prose.length, 1);
  assert.equal(prose[0].kind, "text");
});

test("double spaces in a sentence are not a diagram", () => {
  // An earlier heuristic treated any run of spaces as alignment, which
  // monospaced ordinary typing.
  const segments = splitProse("This ends here.  And this begins.");
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, "text");
});

test("two separate diagrams stay separate", () => {
  const segments = splitProse(
    ["[1, 2]", "  ↑", "", "then later", "", "[3, 4]", "  ↑"].join("\n"),
  );
  assert.equal(segments.filter((segment) => segment.kind === "art").length, 2);
});

test("empty input produces nothing rather than an empty block", () => {
  assert.deepEqual(splitProse(""), []);
  assert.deepEqual(splitProse("\n\n"), []);
});
