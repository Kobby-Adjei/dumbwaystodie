const test = require("node:test");
const assert = require("node:assert/strict");

const { buildMockResponse, MockCoachProvider } = require("../dist/index.js");

const BUFFER = ["<form>", "  <input name=\"company\">", "  UNSAVED_TEST", "</form>"].join("\n");

function makeRequest(overrides = {}) {
  return {
    id: "req_test",
    sessionId: "session_test",
    createdAt: new Date().toISOString(),
    message: "What am I looking at?",
    workspace: { name: "job-agent", roots: ["/tmp/job-agent"] },
    editor: {
      activeFile: "public/index.html",
      absolutePath: "/tmp/job-agent/public/index.html",
      language: "html",
      isDirty: true,
      documentVersion: 14,
      lineCount: 4,
      capturedAt: new Date().toISOString(),
      cursor: { line: 3, column: 5 },
      selection: { startLine: 1, startColumn: 1, endLine: 4, endColumn: 8 },
    },
    contextItems: [
      {
        type: "selection",
        path: "public/index.html",
        language: "html",
        startLine: 1,
        startColumn: 1,
        endLine: 4,
        endColumn: 8,
        content: BUFFER,
        isDirty: true,
      },
      {
        type: "file",
        path: "public/index.html",
        source: "editor-buffer",
        language: "html",
        content: BUFFER,
        isDirty: true,
        documentVersion: 14,
        truncated: false,
      },
      {
        type: "diagnostics",
        path: "public/index.html",
        diagnostics: [
          {
            path: "public/index.html",
            severity: "error",
            message: "Unclosed tag",
            line: 2,
            column: 3,
          },
        ],
      },
    ],
    attachments: [],
    clientCapabilities: {
      readActiveDocument: false,
      readFile: false,
      searchFiles: false,
      listDirectory: false,
      readDiagnostics: false,
      runCommand: false,
      attachments: false,
    },
    ...overrides,
  };
}

test("mock response proves the acceptance criteria (spec §99)", () => {
  const response = buildMockResponse(makeRequest());
  const text = response.content.find((part) => part.type === "text").text;

  // 1. active path
  assert.match(text, /public\/index\.html/);
  // 2. the buffer is the live, unsaved one — quoted straight back
  assert.match(text, /Unsaved changes: yes/);
  assert.match(text, /read from the editor buffer, not from disk/);
  assert.match(text, /UNSAVED_TEST/);
  // 3. selection range
  assert.match(text, /Selection: L1-L4/);
  // 4. diagnostic count
  assert.match(text, /Diagnostics: 1 item/);

  assert.equal(response.requestId, "req_test");
  assert.equal(response.completion.state, "complete");
  assert.equal(response.source.adapterKind, "mock");
});

test("selection is echoed as a structured code part, not folded into text", () => {
  const response = buildMockResponse(makeRequest());
  const code = response.content.find((part) => part.type === "code");
  assert.ok(code, "expected a code content part");
  assert.equal(code.language, "html");
  assert.equal(code.code, BUFFER);
});

test("a request with no active editor does not pretend otherwise", () => {
  const request = makeRequest({ editor: undefined, contextItems: [] });
  const text = buildMockResponse(request).content[0].text;
  assert.match(text, /Active editor: none/);
  assert.match(text, /Diagnostics: 0/);
});

test("truncated buffers are reported as truncated", () => {
  const request = makeRequest();
  const file = request.contextItems.find((item) => item.type === "file");
  file.truncated = true;
  file.truncation = { truncated: true, originalCharacters: 90000, includedCharacters: 40000 };

  const text = buildMockResponse(request).content[0].text;
  assert.match(text, /truncated from 90000 characters/);
});

test("provider delivers a correlated response through its message channel", async () => {
  const provider = new MockCoachProvider({ latencyMs: 1 });
  const received = [];
  provider.onMessage((message) => received.push(message));

  await provider.connect({ id: "session_test", name: "test", messages: [] });
  await provider.sendRequest(makeRequest());

  await new Promise((resolve) => setTimeout(resolve, 30));
  await provider.disconnect();

  const response = received.find((message) => message.type === "coach.response");
  assert.ok(response, "expected a coach.response");
  assert.equal(response.response.requestId, "req_test");

  const statuses = received.filter((m) => m.type === "provider.status").map((m) => m.status);
  assert.deepEqual(statuses, ["ready", "busy", "ready"]);
});

test("a request sent before connect() reports an error rather than a fake answer", async () => {
  const provider = new MockCoachProvider({ latencyMs: 1 });
  const received = [];
  provider.onMessage((message) => received.push(message));

  await provider.sendRequest(makeRequest());

  assert.equal(received.length, 1);
  assert.equal(received[0].type, "provider.error");
  assert.equal(received[0].requestId, "req_test");
});
