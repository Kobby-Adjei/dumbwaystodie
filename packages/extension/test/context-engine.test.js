const test = require("node:test");
const assert = require("node:assert/strict");

const { ContextEngine } = require("../out/context/ContextEngine.js");

const DISK_CONTENT = "<form>\n  <input>\n</form>\n";
const BUFFER_CONTENT = "<form>\n  <input>\n  UNSAVED_TEST\n</form>\n";

/**
 * Fake editor host. The whole point of EditorAdapter being an interface: the
 * context engine can be exercised without an extension host.
 */
function fakeEditor(overrides = {}) {
  const document = {
    path: "public/index.html",
    absolutePath: "/tmp/job-agent/public/index.html",
    language: "html",
    isDirty: true,
    documentVersion: 14,
    lineCount: 4,
    capturedAt: new Date().toISOString(),
    source: "editor-buffer",
    content: BUFFER_CONTENT,
    ...overrides.document,
  };

  return {
    getWorkspaceContext: () => ({ name: "job-agent", roots: ["/tmp/job-agent"] }),
    getActiveDocumentSnapshot: () => (overrides.document === null ? null : document),
    getSelection: () =>
      overrides.selection === undefined
        ? {
            path: document.path,
            language: "html",
            startLine: 2,
            startColumn: 1,
            endLine: 3,
            endColumn: 15,
            content: "  <input>\n  UNSAVED_TEST",
            isDirty: true,
            capturedAt: new Date().toISOString(),
          }
        : overrides.selection,
    getCursor: () => overrides.cursor ?? { line: 3, column: 15 },
    getDiagnostics: () =>
      overrides.diagnostics ?? [
        {
          path: document.path,
          severity: "error",
          message: "Unclosed tag",
          line: 2,
          column: 3,
        },
      ],
  };
}

const budget = (over = {}) => () => ({
  maxCharacters: 120000,
  maxFileCharacters: 40000,
  maxDiagnosticItems: 100,
  maxTreeEntries: 500,
  ...over,
});

test("transports the live unsaved buffer, never disk content", () => {
  const engine = new ContextEngine(fakeEditor(), budget());
  const { request } = engine.buildRequest({ sessionId: "session_1", message: "why?" });

  const file = request.contextItems.find((item) => item.type === "file");
  assert.equal(file.source, "editor-buffer");
  assert.equal(file.content, BUFFER_CONTENT);
  assert.notEqual(file.content, DISK_CONTENT);
  assert.equal(file.isDirty, true);
  assert.equal(file.documentVersion, 14);
});

test("captures editor metadata, selection and diagnostics", () => {
  const engine = new ContextEngine(fakeEditor(), budget());
  const { request } = engine.buildRequest({ sessionId: "session_1", message: "why?" });

  assert.equal(request.editor.activeFile, "public/index.html");
  assert.equal(request.editor.isDirty, true);
  assert.deepEqual(request.editor.cursor, { line: 3, column: 15 });
  assert.deepEqual(request.editor.selection, {
    startLine: 2,
    startColumn: 1,
    endLine: 3,
    endColumn: 15,
  });

  const selection = request.contextItems.find((item) => item.type === "selection");
  assert.match(selection.content, /UNSAVED_TEST/);

  const diagnostics = request.contextItems.find((item) => item.type === "diagnostics");
  assert.equal(diagnostics.diagnostics.length, 1);

  assert.equal(request.attachments.length, 0);
  assert.equal(request.clientCapabilities.runCommand, false);
  assert.equal(request.clientCapabilities.readFile, false);
});

test("marks truncation instead of silently shortening (spec §13)", () => {
  const engine = new ContextEngine(
    fakeEditor({ document: { content: "x".repeat(5000) }, selection: null }),
    budget({ maxFileCharacters: 1000 }),
  );
  const { request, notes } = engine.buildRequest({ sessionId: "session_1", message: "why?" });

  const file = request.contextItems.find((item) => item.type === "file");
  assert.equal(file.content.length, 1000);
  assert.equal(file.truncated, true);
  assert.deepEqual(file.truncation, {
    truncated: true,
    originalCharacters: 5000,
    includedCharacters: 1000,
  });
  assert.ok(notes.some((note) => /truncated/i.test(note)));
  assert.ok(request.contextItems.some((item) => item.type === "note" && /truncated/i.test(item.note)));
});

test("drops whole items when the total budget is blown, and says so", () => {
  const engine = new ContextEngine(
    fakeEditor({ document: { content: "x".repeat(5000) } }),
    budget({ maxCharacters: 200, maxFileCharacters: 5000 }),
  );
  const { request, notes } = engine.buildRequest({ sessionId: "session_1", message: "why?" });

  assert.equal(
    request.contextItems.some((item) => item.type === "file"),
    false,
    "the full buffer should be dropped first",
  );
  assert.ok(
    request.contextItems.some((item) => item.type === "selection"),
    "the selection is what the user pointed at — dropped last",
  );
  assert.ok(notes.some((note) => /Dropped "file"/.test(note)));
});

test("caps diagnostics and reports the remainder", () => {
  const many = Array.from({ length: 150 }, (_, index) => ({
    path: "public/index.html",
    severity: "warning",
    message: `problem ${index}`,
    line: index + 1,
    column: 1,
  }));

  const engine = new ContextEngine(fakeEditor({ diagnostics: many }), budget({ maxDiagnosticItems: 100 }));
  const { request } = engine.buildRequest({ sessionId: "session_1", message: "why?" });

  const diagnostics = request.contextItems.find((item) => item.type === "diagnostics");
  assert.equal(diagnostics.diagnostics.length, 100);
  assert.equal(diagnostics.omittedCount, 50);
});

test("withholds content of secret files but keeps the metadata honest", () => {
  const engine = new ContextEngine(
    fakeEditor({ document: { path: ".env.local", absolutePath: "/tmp/job-agent/.env.local" } }),
    budget(),
  );
  const { request, notes } = engine.buildRequest({ sessionId: "session_1", message: "why?" });

  assert.equal(request.contextItems.some((item) => item.type === "file"), false);
  assert.equal(request.contextItems.some((item) => item.type === "selection"), false);
  assert.equal(request.editor.activeFile, ".env.local");
  assert.ok(notes.some((note) => /withheld/i.test(note)));
});

test("no active editor produces a request that says so", () => {
  const engine = new ContextEngine(fakeEditor({ document: null }), budget());
  const { request, notes } = engine.buildRequest({ sessionId: "session_1", message: "hello" });

  assert.equal(request.editor, undefined);
  assert.ok(notes.some((note) => /No active text editor/i.test(note)));
  assert.equal(request.message, "hello");
});

test("summarize reflects live editor state for the panel", () => {
  const engine = new ContextEngine(fakeEditor(), budget());
  const summary = engine.summarize();

  assert.equal(summary.activeFile, "public/index.html");
  assert.equal(summary.isDirty, true);
  assert.equal(summary.bufferCharacters, BUFFER_CONTENT.length);
  assert.deepEqual(summary.selection, { startLine: 2, endLine: 3, characters: 24 });
  assert.equal(summary.diagnosticCount, 1);
  assert.equal(summary.blockedReason, undefined);
});

test("summarize hides buffer size for secret files", () => {
  const engine = new ContextEngine(fakeEditor({ document: { path: ".env" } }), budget());
  const summary = engine.summarize();

  assert.equal(summary.bufferCharacters, undefined);
  assert.match(summary.blockedReason, /environment files/);
});
