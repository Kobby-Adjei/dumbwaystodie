const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { NodeWorkspaceAdapter } = require("../out/workspace/NodeWorkspaceAdapter.js");
const { ToolRegistry } = require("../out/tools/ToolRegistry.js");
const {
  createDiagnosticsTool,
  createListDirectoryTool,
  createProjectTreeTool,
  createReadFileTool,
  createSearchTool,
} = require("../out/tools/definitions.js");

const BUDGET = () => ({
  maxCharacters: 120000,
  maxFileCharacters: 40000,
  maxDiagnosticItems: 100,
  maxTreeEntries: 500,
});

const APP_JS = ["one", "two", "three", "four", "five"].join("\n");

let sandbox;
let root;
let adapter;

test.before(async () => {
  sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dumbways-")));
  root = path.join(sandbox, "job-agent");

  await fs.mkdir(path.join(root, "public"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "left-pad"), { recursive: true });
  await fs.mkdir(path.join(sandbox, "outside"), { recursive: true });

  await fs.mkdir(path.join(root, "src"), { recursive: true });

  await fs.writeFile(path.join(root, "public", "index.html"), "<form>\n  <input>\n</form>\n");
  await fs.writeFile(path.join(root, "public", "app.js"), APP_JS);
  await fs.writeFile(path.join(root, "server.pem"), "-----BEGIN PRIVATE KEY-----\n");

  // Search fixtures. Note that the ignored and filtered files also contain the
  // needle — that is what makes those assertions meaningful.
  await fs.writeFile(
    path.join(root, "src", "api.js"),
    "const a = fetch('/api');\n// nothing here\nawait fetch('/jobs');\n",
  );
  await fs.writeFile(path.join(root, "src", "util.ts"), "export const go = () => fetch('/x');\n");
  await fs.writeFile(path.join(root, ".env"), "API_KEY=hunter2\nconst leak = fetch('/secret');\n");
  await fs.writeFile(
    path.join(root, "node_modules", "left-pad", "index.js"),
    "module.exports = fetch('/vendor');",
  );
  await fs.writeFile(path.join(sandbox, "outside", "loot.txt"), "should never be readable");

  // A real binary: PNG magic bytes with an embedded NUL.
  await fs.writeFile(
    path.join(root, "logo.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a, 0x00, 0xff]),
  );

  // Sparse 6 MB file — over the read limit, without writing 6 MB.
  const handle = await fs.open(path.join(root, "huge.txt"), "w");
  await handle.truncate(6 * 1024 * 1024);
  await handle.close();

  // A symlink that escapes the workspace by pointing at a sibling directory.
  await fs.symlink(path.join(sandbox, "outside"), path.join(root, "escape-hatch"), "dir");

  adapter = new NodeWorkspaceAdapter(() => [{ name: "job-agent", path: root }]);
});

test.after(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

async function expectFailure(promise, code) {
  try {
    await promise;
    assert.fail(`expected ${code}`);
  } catch (error) {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
}

/* ------------------------------------------------------------------ *
 * Workspace boundary (spec §39, §54 security tests)
 * ------------------------------------------------------------------ */

test("resolves a normal path inside the workspace", async () => {
  const resolved = await adapter.resolvePath("public/index.html");
  assert.equal(resolved.relativePath, "public/index.html");
  assert.equal(resolved.absolutePath, path.join(root, "public", "index.html"));
});

test("rejects directory traversal", async () => {
  await expectFailure(adapter.resolvePath("../outside/loot.txt"), "OUTSIDE_WORKSPACE");
  await expectFailure(adapter.resolvePath("../../etc/passwd"), "OUTSIDE_WORKSPACE");
  await expectFailure(adapter.resolvePath("public/../../outside/loot.txt"), "OUTSIDE_WORKSPACE");
});

test("rejects absolute paths outside the workspace", async () => {
  await expectFailure(adapter.resolvePath("/etc/passwd"), "OUTSIDE_WORKSPACE");
});

test("rejects symlink escapes", async () => {
  // The string path looks internal. Only realpath reveals that it is not.
  await expectFailure(adapter.resolvePath("escape-hatch/loot.txt"), "OUTSIDE_WORKSPACE");
});

test("rejects null bytes and empty paths", async () => {
  await expectFailure(adapter.resolvePath("public/\0index.html"), "INVALID_ARGUMENT");
  await expectFailure(adapter.resolvePath("   "), "INVALID_ARGUMENT");
});

test("refuses secret files even when the path is valid (spec §40)", async () => {
  await expectFailure(adapter.resolvePath(".env"), "PERMISSION_DENIED");
  await expectFailure(adapter.resolvePath("server.pem"), "PERMISSION_DENIED");
});

test("reports missing files as NOT_FOUND", async () => {
  await expectFailure(adapter.resolvePath("public/nope.txt"), "NOT_FOUND");
});

/* ------------------------------------------------------------------ *
 * Reading (spec §61, §72)
 * ------------------------------------------------------------------ */

test("refuses binary files instead of returning mojibake", async () => {
  const target = await adapter.resolvePath("logo.png");
  const error = await expectFailure(adapter.readDiskFile(target), "UNSUPPORTED");
  assert.match(error.message, /UNSUPPORTED_BINARY_FILE/);
});

test("refuses files over the size limit", async () => {
  const target = await adapter.resolvePath("huge.txt");
  await expectFailure(adapter.readDiskFile(target), "TOO_LARGE");
});

test("listing hides ignored directories and secret files, and counts them", async () => {
  const target = await adapter.resolvePath(".");
  const listing = await adapter.listDirectory(target, 500);
  const names = listing.entries.map((entry) => entry.name);

  assert.ok(names.includes("public"));
  assert.equal(names.includes("node_modules"), false);
  assert.equal(names.includes(".env"), false);
  assert.equal(names.includes("server.pem"), false);
  assert.ok(listing.omittedCount >= 3, `expected omissions, got ${listing.omittedCount}`);
  assert.equal(listing.entries[0].type, "directory", "directories sort first");
});

/* ------------------------------------------------------------------ *
 * Tools over the adapter
 * ------------------------------------------------------------------ */

function toolHarness(editorOverrides = {}) {
  const editor = {
    getActiveDocumentSnapshot: () => editorOverrides.active ?? null,
    getDocumentSnapshotFor: () => editorOverrides.open ?? null,
    getDiagnostics: () => editorOverrides.diagnostics ?? [],
    getDiagnosticsForFile: () => editorOverrides.diagnostics ?? [],
    getDirtyDocuments: () => editorOverrides.dirty ?? [],
    getSelection: () => null,
    getCursor: () => null,
    getWorkspaceContext: () => ({ name: "job-agent", roots: [root] }),
  };

  const deps = { editor, workspace: adapter, getBudget: BUDGET };
  const registry = new ToolRegistry({ resolvePermission: () => "allow" });
  registry.register(createReadFileTool(deps));
  registry.register(createListDirectoryTool(deps));
  registry.register(createDiagnosticsTool(deps));
  registry.register(createSearchTool(deps));
  registry.register(createProjectTreeTool(deps));
  return registry;
}

const call = (tool, args) => ({
  type: "tool.call",
  id: `tool_${Math.random().toString(36).slice(2)}`,
  sessionId: "session_test",
  tool,
  arguments: args,
});

test("read_file returns disk content with line counts", async () => {
  const registry = toolHarness();
  const result = await registry.execute(call("workspace.read_file", { path: "public/app.js" }));

  assert.equal(result.ok, true);
  assert.equal(result.result.content, APP_JS);
  assert.equal(result.result.totalLines, 5);
  assert.equal(result.result.source, "filesystem");
  assert.equal(result.result.isDirty, false);
});

test("read_file honours a line range (spec §62)", async () => {
  const registry = toolHarness();
  const result = await registry.execute(
    call("workspace.read_file", { path: "public/app.js", startLine: 2, endLine: 3 }),
  );

  assert.equal(result.result.content, "two\nthree");
  assert.equal(result.result.startLine, 2);
  assert.equal(result.result.endLine, 3);
  assert.equal(result.result.totalLines, 5);
});

test("read_file prefers the unsaved buffer over disk (spec §3.3)", async () => {
  const registry = toolHarness({
    open: {
      path: "public/app.js",
      absolutePath: path.join(root, "public", "app.js"),
      language: "javascript",
      isDirty: true,
      documentVersion: 9,
      lineCount: 1,
      capturedAt: new Date().toISOString(),
      source: "editor-buffer",
      content: "TYPED_BUT_NOT_SAVED",
    },
  });

  const result = await registry.execute(call("workspace.read_file", { path: "public/app.js" }));

  assert.equal(result.result.content, "TYPED_BUT_NOT_SAVED");
  assert.equal(result.result.source, "editor-buffer");
  assert.equal(result.result.isDirty, true);
  assert.notEqual(result.result.content, APP_JS);
});

test("read_file refuses to leave the workspace or read secrets", async () => {
  const registry = toolHarness();

  const escape = await registry.execute(
    call("workspace.read_file", { path: "../outside/loot.txt" }),
  );
  assert.equal(escape.ok, false);
  assert.equal(escape.error.code, "OUTSIDE_WORKSPACE");

  const secret = await registry.execute(call("workspace.read_file", { path: ".env" }));
  assert.equal(secret.ok, false);
  assert.equal(secret.error.code, "PERMISSION_DENIED");
});

test("read_file rejects bad arguments before touching the disk", async () => {
  const registry = toolHarness();

  const missing = await registry.execute(call("workspace.read_file", {}));
  assert.equal(missing.error.code, "INVALID_ARGUMENT");

  const backwards = await registry.execute(
    call("workspace.read_file", { path: "public/app.js", startLine: 9, endLine: 2 }),
  );
  assert.equal(backwards.error.code, "INVALID_ARGUMENT");

  const notANumber = await registry.execute(
    call("workspace.read_file", { path: "public/app.js", startLine: "two" }),
  );
  assert.equal(notANumber.error.code, "INVALID_ARGUMENT");
});

test("list_directory defaults to the workspace root", async () => {
  const registry = toolHarness();
  const result = await registry.execute(call("workspace.list_directory", {}));

  assert.equal(result.ok, true);
  assert.equal(result.result.path, ".");
  assert.ok(result.result.entries.some((entry) => entry.name === "public"));
});

test("diagnostics can be requested for a specific file", async () => {
  const registry = toolHarness({
    diagnostics: [
      { path: "public/app.js", severity: "error", message: "boom", line: 1, column: 1 },
    ],
  });

  const result = await registry.execute(
    call("editor.diagnostics", { path: "public/app.js" }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.result.path, "public/app.js");
  assert.equal(result.result.diagnostics.length, 1);
});

test("diagnostics without a path and without an active editor fails clearly", async () => {
  const registry = toolHarness();
  const result = await registry.execute(call("editor.diagnostics", {}));

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "NOT_FOUND");
  assert.match(result.error.message, /no active text editor/i);
});

/* ------------------------------------------------------------------ *
 * Phase 5 — search and project tree
 * ------------------------------------------------------------------ */

test("search finds a literal string across the workspace (spec §53 Phase 5)", async () => {
  const registry = toolHarness();
  const result = await registry.execute(call("workspace.search", { query: "fetch(" }));

  assert.equal(result.ok, true);

  const paths = result.result.matches.map((match) => match.path);
  assert.ok(paths.includes("src/api.js"));
  assert.ok(paths.includes("src/util.ts"));
  assert.equal(result.result.totalMatches, 3);
  assert.equal(result.result.filesWithMatches, 2);

  const first = result.result.matches.find((match) => match.path === "src/api.js");
  assert.equal(first.line, 1);
  assert.equal(first.preview, "const a = fetch('/api');");
  assert.equal(first.source, "filesystem");
});

test("search never reads ignored directories or secret files", async () => {
  const registry = toolHarness();
  const result = await registry.execute(call("workspace.search", { query: "fetch(" }));

  const paths = result.result.matches.map((match) => match.path);
  assert.equal(
    paths.some((candidate) => candidate.startsWith("node_modules/")),
    false,
    "node_modules is ignored even though it contains the needle",
  );
  assert.equal(
    paths.some((candidate) => candidate.includes(".env")),
    false,
    ".env is filtered even though it contains the needle",
  );
});

test("search honours globs", async () => {
  const registry = toolHarness();
  const result = await registry.execute(
    call("workspace.search", { query: "fetch(", globs: ["**/*.ts"] }),
  );

  assert.deepEqual(
    result.result.matches.map((match) => match.path),
    ["src/util.ts"],
  );
});

test("search overlays unsaved buffers on top of disk (spec §3.3)", async () => {
  const registry = toolHarness({
    dirty: [
      {
        path: "src/api.js",
        absolutePath: path.join(root, "src", "api.js"),
        language: "javascript",
        isDirty: true,
        documentVersion: 3,
        lineCount: 2,
        capturedAt: new Date().toISOString(),
        source: "editor-buffer",
        content: "// rewritten but not saved\nconst b = fetch('/typed-just-now');",
      },
    ],
  });

  const result = await registry.execute(call("workspace.search", { query: "fetch(" }));
  const apiMatches = result.result.matches.filter((match) => match.path === "src/api.js");

  assert.equal(apiMatches.length, 1, "the disk version must not also appear");
  assert.equal(apiMatches[0].source, "editor-buffer");
  assert.equal(apiMatches[0].line, 2);
  assert.match(apiMatches[0].preview, /typed-just-now/);

  // 1 from the buffer + 1 from util.ts, and the two stale disk hits are gone.
  assert.equal(result.result.totalMatches, 2);
  assert.equal(result.result.matches[0].source, "editor-buffer", "unsaved work sorts first");
});

test("search caps results and says it truncated", async () => {
  const registry = toolHarness();
  const result = await registry.execute(
    call("workspace.search", { query: "fetch(", maxResults: 1 }),
  );

  assert.equal(result.result.matches.length, 1);
  assert.equal(result.result.truncated, true);
  assert.equal(result.result.totalMatches, 3);
});

test("search finds nothing gracefully", async () => {
  const registry = toolHarness();
  const result = await registry.execute(
    call("workspace.search", { query: "definitely-not-in-this-workspace" }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.result.matches, []);
  assert.equal(result.result.totalMatches, 0);
});

test("search rejects a missing or non-literal query", async () => {
  const registry = toolHarness();

  assert.equal((await registry.execute(call("workspace.search", {}))).error.code, "INVALID_ARGUMENT");
  assert.equal(
    (await registry.execute(call("workspace.search", { query: "x", globs: "*.ts" }))).error.code,
    "INVALID_ARGUMENT",
  );
  assert.equal(
    (await registry.execute(call("workspace.search", { query: "x", caseSensitive: "yes" }))).error
      .code,
    "INVALID_ARGUMENT",
  );
});

test("project tree is breadth-first, bounded and ignores the usual suspects", async () => {
  const registry = toolHarness();
  const result = await registry.execute(call("workspace.project_tree", {}));

  assert.equal(result.ok, true);
  const paths = result.result.entries.map((entry) => entry.path);

  assert.ok(paths.includes("public"));
  assert.ok(paths.includes("src/api.js"));
  assert.equal(paths.includes("node_modules"), false);
  assert.equal(paths.includes(".env"), false);
  assert.equal(paths.includes("server.pem"), false);

  // Breadth-first: every top-level entry precedes any nested one.
  const firstNested = paths.findIndex((candidate) => candidate.includes("/"));
  const lastTopLevel = paths.map((c) => !c.includes("/")).lastIndexOf(true);
  assert.ok(firstNested > lastTopLevel, "top-level entries come first");

  assert.ok(result.result.omittedCount >= 2);
});

test("project tree truncates against the budget and says so", async () => {
  const registry = toolHarness();
  const result = await registry.execute(call("workspace.project_tree", { maxEntries: 2 }));

  assert.equal(result.result.entries.length, 2);
  assert.equal(result.result.truncated, true);
});

test("project tree can be scoped to a subdirectory", async () => {
  const registry = toolHarness();
  const result = await registry.execute(call("workspace.project_tree", { path: "src" }));

  assert.equal(result.result.root, "src");
  assert.deepEqual(
    result.result.entries.map((entry) => entry.path).sort(),
    ["src/api.js", "src/util.ts"],
  );
});

test("project tree refuses to escape the workspace", async () => {
  const registry = toolHarness();
  const result = await registry.execute(call("workspace.project_tree", { path: "../outside" }));

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "OUTSIDE_WORKSPACE");
});

/* ------------------------------------------------------------------ *
 * Phase 5 acceptance: the provider requests a search, end to end
 * ------------------------------------------------------------------ */

test('Phase 5 acceptance: "search for fetch(" reaches the disk and comes back (spec §53)', async () => {
  const { MockCoachProvider } = require("@dumbways/mock-provider");
  const { CoachController } = require("../out/coach/CoachController.js");
  const { ContextEngine } = require("../out/context/ContextEngine.js");

  const registry = toolHarness();
  const messages = [];
  let counter = 0;

  const session = { id: "session_test", name: "job-agent", messages: [] };
  const sessions = {
    current: session,
    appendMessage: (role, text, extra = {}) => {
      const message = { id: `msg_${(counter += 1)}`, role, text, ...extra };
      messages.push(message);
      return message;
    },
    /*
     * A finished reply replaces the streamed one instead of being appended
     * beside it, so this double needs the same method the real store has —
     * otherwise the controller throws on the last step of every turn.
     */
    replaceStreamingMessage: (requestId, text, parts) => {
      const existing = messages.find(
        (message) => message.role === "coach" && message.requestId === requestId,
      );
      if (existing) {
        existing.text = text;
        if (parts) existing.parts = parts;
        return existing;
      }
      const message = { id: `msg_${(counter += 1)}`, role: "coach", text, requestId };
      if (parts) message.parts = parts;
      messages.push(message);
      return message;
    },
    updateMessage: (id, mutate) => {
      const message = messages.find((candidate) => candidate.id === id);
      if (message) mutate(message);
    },
    setActiveRequest: () => {},
    newSession: () => session,
  };

  const state = {
    setHop: () => {},
    setRequestState: () => {},
    getAttachments: () => [],
    clearAttachments: () => {},
  };

  const editor = {
    getWorkspaceContext: () => ({ name: "job-agent", roots: [root] }),
    getActiveDocumentSnapshot: () => null,
    getDocumentSnapshotFor: () => null,
    getDiagnostics: () => [],
    getDiagnosticsForFile: () => [],
    getDirtyDocuments: () => [],
    getSelection: () => null,
    getCursor: () => null,
  };

  const provider = new MockCoachProvider({ latencyMs: 1 });
  const controller = new CoachController(
    state,
    sessions,
    new ContextEngine(editor, BUDGET, registry),
    provider,
    registry,
    { appendLine: () => {} },
  );

  await controller.start();
  await controller.send("search for fetch(");
  await new Promise((resolve) => setTimeout(resolve, 80));

  const toolMessage = messages.find((message) => message.role === "tool");
  assert.equal(toolMessage.tool.tool, "workspace.search");
  assert.equal(toolMessage.tool.status, "ok");
  assert.match(toolMessage.tool.argsSummary, /"fetch\("/);

  const coach = messages.find((message) => message.role === "coach");
  assert.match(coach.text, /3 match\(es\) for text "fetch\(" in 2 file\(s\)/);
  assert.match(coach.text, /src\/api\.js:1/);
  assert.doesNotMatch(coach.text, /node_modules/);

  controller.dispose();
});
