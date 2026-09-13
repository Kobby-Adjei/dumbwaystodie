const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  RipgrepSearchBackend,
  ripgrepCandidatePaths,
  resolveRipgrepPath,
} = require("../out/workspace/search/RipgrepSearchBackend.js");
const { NodeSearchBackend } = require("../out/workspace/search/NodeSearchBackend.js");

/**
 * These run against a real ripgrep binary — the one a VS Code-family editor
 * ships — rather than a stub. Parsing another program's output is exactly the
 * kind of code that passes review and fails in production, so it is tested
 * against the actual program.
 *
 * Every editor in the VS Code family bundles it at the same path. If none is
 * installed, these skip rather than fail.
 */
function findRipgrep() {
  const appRoots = [
    "/Applications/Antigravity IDE.app/Contents/Resources/app",
    "/Applications/Visual Studio Code.app/Contents/Resources/app",
    "/Applications/Cursor.app/Contents/Resources/app",
    "/usr/share/code/resources/app",
  ];

  for (const appRoot of appRoots) {
    const found = resolveRipgrepPath(ripgrepCandidatePaths(appRoot));
    if (found) {
      return found;
    }
  }
  return undefined;
}

const RG = findRipgrep();
const skip = RG ? false : "no ripgrep binary found on this machine";

let sandbox;
let root;

const baseRequest = (over = {}) => ({
  rootAbsolutePath: root,
  rootRelativePath: ".",
  query: "fetch(",
  isRegex: false,
  caseSensitive: false,
  wholeWord: false,
  skipPaths: [],
  ignoredDirectories: ["node_modules", ".git"],
  maxResults: 100,
  maxMatchesPerFile: 20,
  maxFileBytes: 5 * 1024 * 1024,
  ...over,
});

test.before(async () => {
  sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dumbways-rg-")));
  root = path.join(sandbox, "repo");

  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "dep"), { recursive: true });

  await fs.writeFile(
    path.join(root, "src", "api.js"),
    "const a = fetch('/api');\nconst pre = prefetch(1);\nawait fetch('/jobs');\n",
  );
  await fs.writeFile(path.join(root, "src", "util.ts"), "export const go = () => FETCH('/x');\n");
  await fs.writeFile(path.join(root, ".env"), "SECRET=1\nconst leak = fetch('/secret');\n");
  await fs.writeFile(path.join(root, "node_modules", "dep", "index.js"), "fetch('/vendor')");

  // 8 KB of 'a' — the input that makes a backtracking engine hang forever.
  await fs.writeFile(path.join(root, "src", "evil.txt"), `${"a".repeat(8000)}X\n`);
});

test.after(async () => {
  if (sandbox) {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("resolves the ripgrep bundled with a VS Code-family editor", { skip }, () => {
  assert.ok(RG.endsWith("rg"));
  assert.deepEqual(ripgrepCandidatePaths(undefined), []);
  assert.equal(resolveRipgrepPath(["/nope/rg", "/also/nope"]), undefined);
});

test("literal search matches the Node backend exactly", { skip }, async () => {
  const request = baseRequest();
  const viaRipgrep = await new RipgrepSearchBackend(RG).search(request);
  const viaNode = await new NodeSearchBackend().search(request);

  const normalize = (outcome) =>
    outcome.matches
      .map((match) => `${match.path}:${match.line}:${match.preview}`)
      .sort();

  assert.deepEqual(normalize(viaRipgrep), normalize(viaNode));
  assert.equal(viaRipgrep.totalMatches, viaNode.totalMatches);
  assert.equal(viaRipgrep.filesWithMatches, viaNode.filesWithMatches);
});

test("literal search does not treat the query as a pattern", { skip }, async () => {
  const outcome = await new RipgrepSearchBackend(RG).search(baseRequest({ query: "fetch(" }));
  const paths = outcome.matches.map((match) => match.path);

  assert.ok(paths.includes("src/api.js"));
  assert.equal(
    paths.some((candidate) => candidate.startsWith("node_modules")),
    false,
    "ignored directories are excluded even though ripgrep was told --no-ignore",
  );
  assert.equal(
    paths.some((candidate) => candidate.includes(".env")),
    false,
    "secret files are filtered from ripgrep output",
  );
});

test("regex search works and is scoped by word boundaries", { skip }, async () => {
  const backend = new RipgrepSearchBackend(RG);

  const loose = await backend.search(baseRequest({ query: "fetch", isRegex: true }));
  const words = await backend.search(
    baseRequest({ query: "fetch", isRegex: true, wholeWord: true }),
  );

  // "prefetch(1)" matches a bare substring but not a whole word.
  assert.ok(loose.totalMatches > words.totalMatches);
  assert.equal(
    words.matches.some((match) => match.preview.includes("prefetch")),
    false,
  );
});

test("case sensitivity is honoured", { skip }, async () => {
  const backend = new RipgrepSearchBackend(RG);

  const insensitive = await backend.search(baseRequest({ query: "FETCH(" }));
  const sensitive = await backend.search(baseRequest({ query: "FETCH(", caseSensitive: true }));

  assert.ok(insensitive.totalMatches > sensitive.totalMatches);
  assert.equal(sensitive.matches.length, 1);
  assert.equal(sensitive.matches[0].path, "src/util.ts");
});

test("a catastrophic pattern returns promptly instead of hanging", { skip }, async () => {
  // The same pattern and input that makes a JavaScript regex never return.
  const started = Date.now();
  const outcome = await new RipgrepSearchBackend(RG).search(
    baseRequest({ query: "(a+)+$", isRegex: true }),
  );
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 5000, `expected a fast answer, took ${elapsed}ms`);
  assert.ok(Array.isArray(outcome.matches));
});

test("an invalid pattern is the provider's mistake, not an internal error", { skip }, async () => {
  try {
    await new RipgrepSearchBackend(RG).search(baseRequest({ query: "a(b", isRegex: true }));
    assert.fail("expected an error");
  } catch (error) {
    assert.equal(error.code, "INVALID_ARGUMENT");
    assert.match(error.message, /Invalid search pattern/);
  }
});

test("globs narrow the search", { skip }, async () => {
  const outcome = await new RipgrepSearchBackend(RG).search(
    baseRequest({ query: "fetch", isRegex: false, globs: ["*.ts"] }),
  );

  assert.deepEqual(
    outcome.matches.map((match) => match.path),
    ["src/util.ts"],
  );
});

test("unsaved buffers are searched by the same engine, via stdin", { skip }, async () => {
  const backend = new RipgrepSearchBackend(RG);
  const content = "line one\nconst x = fetch('/typed-just-now');\nline three";

  const literal = await backend.searchBuffer(content, baseRequest({ query: "fetch(" }));
  assert.equal(literal.length, 1);
  assert.equal(literal[0].line, 2);
  assert.match(literal[0].preview, /typed-just-now/);

  const regex = await backend.searchBuffer(
    content,
    baseRequest({ query: "fetch\\('/[a-z-]+'\\)", isRegex: true }),
  );
  assert.equal(regex.length, 1, "regex works on buffers, not just on disk");
});

test("an aborted search kills the process", { skip }, async () => {
  const controller = new AbortController();
  const promise = new RipgrepSearchBackend(RG).search(
    baseRequest({ query: "a", signal: controller.signal }),
  );
  controller.abort();

  await assert.rejects(promise, (error) => {
    assert.equal(error.code, "TIMEOUT");
    return true;
  });
});

/* ------------------------------------------------------------------ *
 * The fallback refuses what it cannot do safely
 * ------------------------------------------------------------------ */

test("the Node backend refuses regex rather than risking a hang", async () => {
  const backend = new NodeSearchBackend();

  await assert.rejects(backend.search(baseRequest({ query: "a+", isRegex: true })), (error) => {
    assert.equal(error.code, "UNSUPPORTED");
    assert.match(error.message, /ripgrep backend/);
    return true;
  });

  await assert.rejects(
    backend.search(baseRequest({ query: "fetch", wholeWord: true })),
    (error) => {
      assert.equal(error.code, "UNSUPPORTED");
      return true;
    },
  );
});
