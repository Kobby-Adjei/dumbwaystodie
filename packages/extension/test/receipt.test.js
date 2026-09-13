const test = require("node:test");
const assert = require("node:assert/strict");

const { buildReceipt, renderReceipt, describeDestination } = require("../out/context/receipt.js");

/**
 * The consent receipt.
 *
 * Its whole value is that it cannot lie, so these tests check that it is
 * *derived* — change the request and the receipt changes with it. A test that
 * only checked the wording would pass while the receipt described a request
 * nobody sent.
 */

function request(over = {}) {
  return {
    id: "req_1",
    sessionId: "s",
    createdAt: new Date().toISOString(),
    message: "why does this reload?",
    workspace: { name: "job-agent", roots: ["/tmp/job-agent"] },
    editor: {
      activeFile: "public/index.html",
      absolutePath: "/tmp/job-agent/public/index.html",
      language: "html",
      isDirty: true,
      documentVersion: 14,
      lineCount: 40,
      capturedAt: new Date().toISOString(),
    },
    contextItems: [
      {
        type: "file",
        path: "public/index.html",
        source: "editor-buffer",
        language: "html",
        content: "x".repeat(347),
        isDirty: true,
        truncated: false,
      },
      {
        type: "selection",
        path: "public/index.html",
        language: "html",
        startLine: 14,
        startColumn: 1,
        endLine: 22,
        endColumn: 8,
        content: "y".repeat(120),
        isDirty: true,
      },
      {
        type: "diagnostics",
        path: "public/index.html",
        diagnostics: [
          { path: "public/index.html", severity: "error", message: "Unclosed tag", line: 2, column: 3 },
        ],
      },
    ],
    attachments: [],
    clientCapabilities: {},
    availableTools: [
      { name: "workspace.read_file", description: "Read a file.", permission: "read" },
    ],
    ...over,
  };
}

test("the receipt describes exactly what the request contains", () => {
  const receipt = buildReceipt(request(), "clipboard");
  const labels = receipt.included.map((line) => line.label);

  assert.ok(labels.includes("Your message"));
  assert.ok(labels.includes("Which file you are in"));
  assert.ok(labels.includes("The contents of that file"));
  assert.ok(labels.includes("The lines you selected"));
  assert.ok(labels.includes("Errors and warnings"));

  const contents = receipt.included.find((line) => line.label === "The contents of that file");
  assert.match(contents.detail, /347 characters/);
  assert.match(contents.detail, /including anything unsaved/, "the unsaved distinction is the point");

  const selection = receipt.included.find((line) => line.label === "The lines you selected");
  assert.match(selection.detail, /lines 14–22/);

  assert.match(receipt.summary, /public\/index\.html/);
  assert.match(receipt.summary, /L14–22/);
  assert.ok(receipt.characters > 0);
});

test("it changes when the request changes — it is derived, not written", () => {
  const withSelection = buildReceipt(request(), "clipboard");
  const withoutSelection = buildReceipt(
    request({ contextItems: request().contextItems.filter((item) => item.type !== "selection") }),
    "clipboard",
  );

  assert.ok(withSelection.included.some((line) => line.label === "The lines you selected"));
  assert.equal(
    withoutSelection.included.some((line) => line.label === "The lines you selected"),
    false,
    "no selection in the request means no selection claimed in the receipt",
  );
  assert.doesNotMatch(withoutSelection.summary, /L14/);
});

test("a saved file is described differently from an unsaved one", () => {
  const saved = buildReceipt(
    request({
      contextItems: [
        {
          type: "file",
          path: "a.js",
          source: "filesystem",
          content: "z".repeat(10),
          truncated: false,
        },
      ],
    }),
    "clipboard",
  );

  const line = saved.included.find((entry) => entry.label === "The contents of that file");
  assert.match(line.detail, /as saved on disk/);
  assert.doesNotMatch(line.detail, /unsaved/);
});

test("truncation is disclosed", () => {
  const receipt = buildReceipt(
    request({
      contextItems: [
        { type: "file", path: "a.js", source: "editor-buffer", content: "z".repeat(40), truncated: true },
      ],
    }),
    "clipboard",
  );

  assert.match(
    receipt.included.find((line) => line.label === "The contents of that file").detail,
    /truncated — the rest was not sent/,
  );
});

test("attachments are named and sized", () => {
  const receipt = buildReceipt(
    request({
      attachments: [
        {
          id: "media_1",
          filename: "screenshot.png",
          mimeType: "image/png",
          size: 184_233,
          sha256: "a",
          source: "screenshot",
          localMediaPath: "/tmp/x.png",
        },
      ],
    }),
    "clipboard",
  );

  const line = receipt.included.find((entry) => entry.label === "Attachments");
  assert.match(line.detail, /screenshot\.png \(180 KB\)/);
});

test("the context engine's own notes become withheld lines", () => {
  const receipt = buildReceipt(
    request({
      contextItems: [
        { type: "note", note: "Content of .env.local was withheld: environment files can hold credentials." },
      ],
    }),
    "clipboard",
  );

  assert.ok(
    receipt.withheld.some((line) => /\.env\.local was withheld/.test(line)),
    "what the engine left out is reported to the user, not just logged",
  );
});

test("the invariants a user cannot check by looking are always stated", () => {
  const receipt = buildReceipt(request(), "clipboard");
  const text = receipt.withheld.join("\n");

  assert.match(text, /No other file in your project/);
  assert.match(text, /No environment variables/);
  assert.match(text, /Nothing outside this project folder/);
  assert.match(text, /credential pattern/);
});

test("each destination is described honestly", () => {
  assert.match(describeDestination("in-process"), /stays inside this editor window/);
  assert.match(describeDestination("clipboard"), /Your clipboard/);
  assert.match(
    describeDestination("clipboard"),
    /Nothing is sent over the network by this extension/,
  );
  assert.match(describeDestination("relay", 43123), /127\.0\.0\.1:43123/);
  assert.match(describeDestination("relay", 43123), /Loopback only/);
});

test("the rendered report has both halves", () => {
  const text = renderReceipt(buildReceipt(request(), "relay", 43123));

  assert.match(text, /WHAT LEAVES THIS MACHINE/);
  assert.match(text, /INCLUDED/);
  assert.match(text, /NOT INCLUDED/);
  assert.match(text, /127\.0\.0\.1:43123/);
});

test("a message with no file open does not imply one", () => {
  const receipt = buildReceipt(request({ editor: undefined, contextItems: [] }), "clipboard");

  const line = receipt.included.find((entry) => entry.label === "Which file you are in");
  assert.match(line.detail, /none — no file was focused/);
  assert.equal(receipt.summary, "your message only");
});
