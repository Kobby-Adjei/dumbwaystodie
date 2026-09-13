const test = require("node:test");
const assert = require("node:assert/strict");

const { requestToMarkdown } = require("../out/context/serialize.js");

function baseRequest(overrides = {}) {
  return {
    id: "req_1",
    sessionId: "session_1",
    createdAt: new Date().toISOString(),
    message: "Why does clicking Search reload the page?",
    workspace: { name: "job-agent", roots: ["/tmp/job-agent"] },
    editor: {
      activeFile: "public/index.html",
      absolutePath: "/tmp/job-agent/public/index.html",
      language: "html",
      isDirty: true,
      documentVersion: 14,
      lineCount: 3,
      capturedAt: new Date().toISOString(),
      cursor: { line: 2, column: 4 },
      selection: { startLine: 1, startColumn: 1, endLine: 3, endColumn: 8 },
    },
    contextItems: [
      {
        type: "file",
        path: "public/index.html",
        source: "editor-buffer",
        language: "html",
        content: "<form>\n  UNSAVED_TEST\n</form>",
        isDirty: true,
        documentVersion: 14,
        truncated: false,
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

test("renders the deterministic context payload (spec §0L)", () => {
  const markdown = requestToMarkdown(baseRequest());

  assert.match(markdown, /^# DUMB WAYS TO DIE — EDITOR CONTEXT/);
  assert.match(markdown, /## User message\nWhy does clicking Search reload the page\?/);
  assert.match(markdown, /## Workspace\njob-agent/);
  assert.match(markdown, /File: public\/index\.html/);
  assert.match(markdown, /Dirty: true/);
  assert.match(markdown, /## Active buffer/);
  assert.match(markdown, /including unsaved changes/);
  assert.match(markdown, /UNSAVED_TEST/);
  assert.match(markdown, /## Diagnostics\nNone reported/);
  // Silence where there is nothing to say: nobody wonders whether the message
  // they just sent had attachments, but "no errors" is a fact worth stating.
  assert.doesNotMatch(markdown, /## Attachments/);
  assert.match(markdown, /## Diagnostics\nNone reported/);
});

test("advertises capabilities honestly when there are none", () => {
  const markdown = requestToMarkdown(baseRequest());
  assert.match(markdown, /This build cannot fetch additional context on request\./);
});

test("the tool list is names only — the primer already carries the descriptions", () => {
  const markdown = requestToMarkdown(
    baseRequest({
      availableTools: [
        {
          name: "workspace.search",
          permission: "read",
          description: "Find text in workspace files, literal by default, globs optional.",
        },
      ],
    }),
  );

  assert.match(markdown, /`workspace\.search`/, "the name is the reminder");
  assert.doesNotMatch(
    markdown,
    /literal by default/,
    "printing every description again doubled the payload on every turn",
  );
});

test("code fences survive content that contains backticks", () => {
  const request = baseRequest();
  request.contextItems[0].content = "```js\nconst a = 1;\n```";

  const markdown = requestToMarkdown(request);
  assert.match(markdown, /````html\n```js/);
  assert.match(markdown, /```\n````/);
});

test("reports truncation and context-engine notes", () => {
  const request = baseRequest();
  request.contextItems[0].truncated = true;
  request.contextItems[0].truncation = {
    truncated: true,
    originalCharacters: 90000,
    includedCharacters: 40000,
  };
  request.contextItems.push({ type: "note", note: "Dropped \"diagnostics\" context." });

  const markdown = requestToMarkdown(request);
  assert.match(markdown, /Truncated: 40000 of 90000 characters\./);
  assert.match(markdown, /## Notes from the context engine/);
  assert.match(markdown, /Dropped "diagnostics" context\./);
});

test("does not invent an active editor", () => {
  const markdown = requestToMarkdown(baseRequest({ editor: undefined, contextItems: [] }));
  assert.match(markdown, /## Active editor\nNone\./);
});
