const test = require("node:test");
const assert = require("node:assert/strict");

const {
  findMatchesInText,
  globToRegExp,
  makePreview,
  matchesAnyGlob,
  matchesGlob,
} = require("../out/workspace/search.js");

/* ------------------------------------------------------------------ *
 * Literal matching
 * ------------------------------------------------------------------ */

const SOURCE = [
  "const a = fetch('/api');",
  "// TODO: FETCH the rest",
  "function noop() {}",
  "await fetch('/api/jobs');",
].join("\n");

test("finds literal matches with 1-based line numbers", () => {
  const matches = findMatchesInText(SOURCE, "fetch(");

  assert.deepEqual(
    matches.map((match) => match.line),
    [1, 4],
  );
  assert.equal(matches[0].preview, "const a = fetch('/api');");
});

test("is case-insensitive by default and case-sensitive on request", () => {
  assert.equal(findMatchesInText(SOURCE, "FETCH").length, 3);
  assert.equal(findMatchesInText(SOURCE, "FETCH", { caseSensitive: true }).length, 1);
});

test("treats the query as literal text, never as a regex", () => {
  // If this were compiled as a regex it would either throw or match everything.
  assert.equal(findMatchesInText("a.b", ".").length, 1);
  assert.deepEqual(findMatchesInText("harmless", "(.*)+$"), []);
  assert.equal(findMatchesInText("cost is $5.00", "$5.00").length, 1);
});

test("caps matches per file", () => {
  const content = Array.from({ length: 50 }, () => "needle").join("\n");
  assert.equal(findMatchesInText(content, "needle", { maxMatches: 5 }).length, 5);
});

test("an empty query matches nothing rather than everything", () => {
  assert.deepEqual(findMatchesInText(SOURCE, ""), []);
});

test("previews are trimmed and bounded", () => {
  assert.equal(makePreview("      indented code      "), "indented code");
  const long = makePreview("x".repeat(500));
  assert.equal(long.length, 201);
  assert.ok(long.endsWith("…"));
});

/* ------------------------------------------------------------------ *
 * Globs
 * ------------------------------------------------------------------ */

test("* stays inside one path segment, ** crosses them", () => {
  assert.equal(matchesGlob("app.js", "*.js"), true);
  assert.equal(matchesGlob("src/app.js", "src/*.js"), true);
  assert.equal(matchesGlob("src/deep/app.js", "src/*.js"), false);
  assert.equal(matchesGlob("src/deep/app.js", "src/**/*.js"), true);
});

test("**/ also matches zero directories", () => {
  assert.equal(matchesGlob("app.ts", "**/*.ts"), true);
  assert.equal(matchesGlob("a/b/c/app.ts", "**/*.ts"), true);
});

test("a pattern without a slash also matches the basename", () => {
  // A coach writing "*.ts" means "any TypeScript file", not "top level only".
  assert.equal(matchesGlob("packages/protocol/src/index.ts", "*.ts"), true);
  assert.equal(matchesGlob("packages/protocol/src/index.ts", "src/*.ts"), false);
});

test("brace alternation and ? work", () => {
  assert.equal(matchesGlob("src/app.tsx", "**/*.{ts,tsx}"), true);
  assert.equal(matchesGlob("src/app.js", "**/*.{ts,tsx}"), false);
  assert.equal(matchesGlob("a1.ts", "a?.ts"), true);
  assert.equal(matchesGlob("a12.ts", "a?.ts"), false);
});

test("glob special characters in real paths are escaped, not interpreted", () => {
  assert.equal(matchesGlob("src/(legacy)/app.js", "src/(legacy)/app.js"), true);
  assert.equal(matchesGlob("src/xlegacy/app.js", "src/(legacy)/app.js"), false);
  assert.equal(globToRegExp("a+b.js").test("a+b.js"), true);
  assert.equal(globToRegExp("a+b.js").test("aab.js"), false);
});

test("no globs means everything", () => {
  assert.equal(matchesAnyGlob("anything/at/all.md"), true);
  assert.equal(matchesAnyGlob("anything/at/all.md", []), true);
  assert.equal(matchesAnyGlob("anything/at/all.md", ["**/*.ts"]), false);
  assert.equal(matchesAnyGlob("a.ts", ["**/*.js", "**/*.ts"]), true);
});
