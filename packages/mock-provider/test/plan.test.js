const test = require("node:test");
const assert = require("node:assert/strict");

const {
  planToolCalls,
  buildToolLoopResponse,
  describeToolOutcome,
  extractSearchQuery,
} = require("../dist/index.js");

const ALL_TOOLS = [
  { name: "editor.active_document", description: "", permission: "read" },
  { name: "workspace.read_file", description: "", permission: "read" },
  { name: "workspace.list_directory", description: "", permission: "read" },
  { name: "editor.diagnostics", description: "", permission: "read" },
  { name: "workspace.search", description: "", permission: "read" },
  { name: "workspace.project_tree", description: "", permission: "read" },
];

const ALL_CAPABILITIES = {
  readActiveDocument: true,
  readFile: true,
  searchFiles: true,
  listDirectory: true,
  projectTree: true,
  readDiagnostics: true,
  runCommand: false,
  attachments: false,
};

function request(message, overrides = {}) {
  return {
    id: "req_1",
    sessionId: "session_1",
    createdAt: new Date().toISOString(),
    message,
    workspace: { name: "job-agent", roots: ["/tmp/job-agent"] },
    contextItems: [],
    attachments: [],
    clientCapabilities: ALL_CAPABILITIES,
    availableTools: ALL_TOOLS,
    ...overrides,
  };
}

test("asking to see the file plans a live-buffer read", () => {
  assert.deepEqual(planToolCalls(request("show me the file")), [
    { tool: "editor.active_document", arguments: {} },
  ]);
  assert.deepEqual(planToolCalls(request("what am I looking at?")), [
    { tool: "editor.active_document", arguments: {} },
  ]);
});

test("naming a file plans a path read instead", () => {
  assert.deepEqual(planToolCalls(request("read public/app.js for me")), [
    { tool: "workspace.read_file", arguments: { path: "public/app.js" } },
  ]);
});

test("mentioning errors plans a diagnostics read", () => {
  assert.deepEqual(planToolCalls(request("why do I have errors?")), [
    { tool: "editor.diagnostics", arguments: {} },
  ]);
});

test("one message can plan several calls, in order", () => {
  const planned = planToolCalls(request("show the file and check the diagnostics"));
  assert.deepEqual(
    planned.map((call) => call.tool),
    ["editor.active_document", "editor.diagnostics"],
  );
});

test("never plans a tool the bridge does not advertise", () => {
  const noTools = request("show me the file and the errors", {
    availableTools: [],
    clientCapabilities: { ...ALL_CAPABILITIES },
  });
  assert.deepEqual(planToolCalls(noTools), []);

  const noCapability = request("show me the file", {
    clientCapabilities: { ...ALL_CAPABILITIES, readActiveDocument: false },
  });
  assert.deepEqual(planToolCalls(noCapability), []);
});

test("small talk plans nothing", () => {
  assert.deepEqual(planToolCalls(request("hello, how are you?")), []);
});

/* ------------------------------------------------------------------ *
 * Phase 5 — search and tree planning
 * ------------------------------------------------------------------ */

test("search for a term plans a workspace search (spec §53 Phase 5)", () => {
  assert.deepEqual(planToolCalls(request("search for fetch(")), [
    { tool: "workspace.search", arguments: { query: "fetch(" } },
  ]);
});

test("extracts quoted, bare and punctuated search terms", () => {
  assert.equal(extractSearchQuery('search for "fetch("'), "fetch(");
  assert.equal(extractSearchQuery("grep for addEventListener"), "addEventListener");
  assert.equal(extractSearchQuery("search for useState."), "useState");
  assert.equal(extractSearchQuery("find 'querySelector'"), "querySelector");
  assert.equal(extractSearchQuery("search for fetch('/api')"), "fetch('/api')");
});

test("does not mistake ordinary sentences for search requests", () => {
  // These would otherwise send the bridge hunting for "the" or "at".
  assert.equal(extractSearchQuery("find the bug in my code"), undefined);
  assert.equal(extractSearchQuery("look at the file"), undefined);
  assert.equal(extractSearchQuery("what am I looking at?"), undefined);
  assert.deepEqual(planToolCalls(request("what am I looking at?")), [
    { tool: "editor.active_document", arguments: {} },
  ]);
});

test("asking about structure plans a project tree", () => {
  assert.deepEqual(planToolCalls(request("show me the project structure")), [
    { tool: "workspace.project_tree", arguments: {} },
  ]);
  assert.deepEqual(planToolCalls(request("what files are in this project?")), [
    { tool: "workspace.project_tree", arguments: {} },
  ]);
});

test("an explicit regex cue plans a regex search", () => {
  assert.deepEqual(planToolCalls(request('search for regex "fetch\\(.*\\)"')), [
    { tool: "workspace.search", arguments: { query: "fetch\\(.*\\)", isRegex: true } },
  ]);
  assert.deepEqual(planToolCalls(request('grep for whole word "fetch"')), [
    { tool: "workspace.search", arguments: { query: "fetch", wholeWord: true } },
  ]);
  // Without the cue it stays literal, which is the safer default.
  assert.deepEqual(planToolCalls(request("search for fetch(")), [
    { tool: "workspace.search", arguments: { query: "fetch(" } },
  ]);
});

test("search is not planned when the bridge cannot search", () => {
  const noSearch = request("search for fetch(", {
    clientCapabilities: { ...ALL_CAPABILITIES, searchFiles: false },
  });
  assert.deepEqual(planToolCalls(noSearch), []);
});

test("search results are reported with paths, lines and source", () => {
  const text = describeToolOutcome("workspace.search", {
    type: "tool.result",
    id: "tool_1",
    sessionId: "session_1",
    ok: true,
    durationMs: 12,
    result: {
      query: "fetch(",
      filesWithMatches: 2,
      engine: "ripgrep",
      isRegex: false,
      totalMatches: 2,
      matches: [
        { path: "src/api.js", line: 1, preview: "const a = fetch('/api');", source: "filesystem" },
        { path: "src/live.js", line: 4, preview: "fetch('/new');", source: "editor-buffer" },
      ],
    },
  });

  assert.match(text, /2 match\(es\) for text "fetch\(" in 2 file\(s\)/);
  assert.match(text, /src\/api\.js:1/);
  assert.match(text, /src\/live\.js:4 \[unsaved\]/);
});

test("an empty search says so rather than implying failure", () => {
  const text = describeToolOutcome("workspace.search", {
    type: "tool.result",
    id: "tool_1",
    sessionId: "session_1",
    ok: true,
    durationMs: 4,
    result: { query: "nope", filesWithMatches: 0, engine: "ripgrep", isRegex: false, totalMatches: 0, matches: [] },
  });

  assert.match(text, /no matches for text "nope" \(searched with ripgrep\)/);
});

test("the final response quotes real numbers from the tool results", () => {
  const response = buildToolLoopResponse(request("show me the file"), [
    {
      tool: "editor.active_document",
      result: {
        type: "tool.result",
        id: "tool_1",
        sessionId: "session_1",
        ok: true,
        durationMs: 3,
        result: {
          path: "public/index.html",
          content: "x".repeat(842),
          isDirty: true,
          documentVersion: 14,
        },
      },
    },
  ]);

  const text = response.content[0].text;
  assert.match(text, /I read 842 characters from public\/index\.html/);
  assert.match(text, /live buffer with unsaved changes/);
  assert.match(text, /1 tool call\(s\)/);
  assert.equal(response.requestId, "req_1");
});

test("a refused tool is reported as refused, not glossed over", () => {
  const text = describeToolOutcome("workspace.read_file", {
    type: "tool.result",
    id: "tool_1",
    sessionId: "session_1",
    ok: false,
    durationMs: 1,
    error: { code: "OUTSIDE_WORKSPACE", message: "Path escapes the workspace: ../../etc/passwd" },
  });

  assert.match(text, /refused: OUTSIDE_WORKSPACE/);
  assert.match(text, /escapes the workspace/);
});
