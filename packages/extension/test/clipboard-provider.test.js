const test = require("node:test");
const assert = require("node:assert/strict");

const { ClipboardCoachProvider } = require("../out/transport/ClipboardCoachProvider.js");

/**
 * The clipboard transport — the surface-agnostic path.
 *
 * This is the rung everything else degrades into, so it is tested as a real
 * product rather than as a fallback: the full loop, including a tool call, has
 * to work with nothing but a person moving text between two windows.
 */

const TOOLS = [
  { name: "workspace.read_file", description: "Read a file.", permission: "read" },
  { name: "shell.run", description: "Run a command.", permission: "execute" },
];

function harness() {
  const clipboard = { text: "" };
  const awaiting = [];
  const inbound = [];

  const provider = new ClipboardCoachProvider({
    clipboard: {
      write: async (text) => {
        clipboard.text = text;
      },
      read: async () => clipboard.text,
    },
    renderRequest: (request) => `# CONTEXT\n\n${request.message}`,
    listTools: () => TOOLS,
    log: () => {},
    onAwaiting: (kind) => awaiting.push(kind),
  });

  provider.onMessage((message) => inbound.push(message));
  return { provider, clipboard, awaiting, inbound };
}

const session = { id: "session_clip", name: "t", messages: [] };

const request = (message, id = "req_1") => ({
  id,
  sessionId: session.id,
  createdAt: new Date().toISOString(),
  message,
  workspace: { name: "t", roots: [] },
  contextItems: [],
  attachments: [],
  clientCapabilities: {},
  availableTools: TOOLS,
});

const reply = (body) => ["```dwtd", JSON.stringify(body), "```"].join("\n");

/* ------------------------------------------------------------------ *
 * The plain loop
 * ------------------------------------------------------------------ */

test("a request is copied, and the pasted reply becomes the answer", async () => {
  const { provider, clipboard, awaiting, inbound } = harness();
  await provider.connect(session);

  await provider.sendRequest(request("why does this reload?"));

  assert.match(clipboard.text, /# CONTEXT/);
  assert.match(clipboard.text, /why does this reload\?/);
  assert.equal(awaiting.at(-1), "request", "the panel is told what to ask the user for");

  clipboard.text = "Because the form submits. What do you think preventDefault does?";
  await provider.receiveReply(clipboard.text);

  const response = inbound.find((message) => message.type === "coach.response");
  assert.ok(response);
  assert.equal(response.response.requestId, "req_1", "the answer correlates to the request");
  assert.match(response.response.content[0].text, /Because the form submits/);
  assert.equal(response.response.source.surfaceType, "clipboard");
  assert.equal(awaiting.at(-1), undefined, "nothing more is wanted from the user");
});

test("an empty clipboard is reported rather than sent as an answer", async () => {
  const { provider, inbound } = harness();
  await provider.connect(session);
  await provider.sendRequest(request("hello"));

  const { problems } = await provider.receiveReply("   \n  ");

  assert.match(problems[0].reason, /clipboard was empty/);
  assert.equal(inbound.some((message) => message.type === "coach.response"), false);
});

/* ------------------------------------------------------------------ *
 * The tool loop, over nothing but copy and paste
 * ------------------------------------------------------------------ */

test("a tool call in the reply continues the loop", async () => {
  const { provider, clipboard, inbound, awaiting } = harness();
  await provider.connect(session);
  await provider.sendRequest(request("what is wrong?"));

  await provider.receiveReply(
    [
      "Let me look at the file first.",
      "",
      reply({ v: 1, type: "tool.call", id: "call_1", tool: "workspace.read_file", args: { path: "src/app.js" } }),
    ].join("\n"),
  );

  const call = inbound.find((message) => message.type === "tool.call");
  assert.ok(call, "the coach's request became a real tool call");
  assert.equal(call.tool, "workspace.read_file");
  assert.deepEqual(call.arguments, { path: "src/app.js" });
  assert.equal(call.requestId, "req_1", "still correlated to the original question");
  assert.equal(
    inbound.some((message) => message.type === "coach.response"),
    false,
    "a tool call is not an answer",
  );

  // The result goes back on the clipboard, labelled for a human.
  await provider.sendToolResult({
    type: "tool.result",
    id: call.id,
    sessionId: session.id,
    ok: true,
    result: { path: "src/app.js", content: "const a = 1;" },
    durationMs: 4,
  });

  assert.match(clipboard.text, /Result for `call_1`/, "echoes the id the coach chose");
  assert.match(clipboard.text, /```dwtd/);
  assert.match(clipboard.text, /const a = 1;/);
  assert.equal(awaiting.at(-1), "tool-result");

  // The coach reads it and answers for real.
  await provider.receiveReply("Now I see it — the handler never calls preventDefault.");

  const response = inbound.find((message) => message.type === "coach.response");
  assert.match(response.response.content[0].text, /never calls preventDefault/);
});

test("our tool-call ids are our own, so a repeated coach id cannot collide", async () => {
  const { provider, inbound } = harness();
  await provider.connect(session);

  await provider.sendRequest(request("first", "req_1"));
  await provider.receiveReply(reply({ v: 1, type: "tool.call", id: "call_1", tool: "editor.diagnostics" }));

  await provider.sendRequest(request("second", "req_2"));
  await provider.receiveReply(reply({ v: 1, type: "tool.call", id: "call_1", tool: "editor.diagnostics" }));

  const calls = inbound.filter((message) => message.type === "tool.call");
  assert.equal(calls.length, 2);
  assert.notEqual(
    calls[0].id,
    calls[1].id,
    "coaches reuse call_1 every turn; identical ids would hit the registry's idempotency cache and return a stale result",
  );
});

test("a refused tool result is sent back so the coach can adapt", async () => {
  const { provider, clipboard, inbound } = harness();
  await provider.connect(session);
  await provider.sendRequest(request("read my secrets"));
  await provider.receiveReply(
    reply({ v: 1, type: "tool.call", id: "call_x", tool: "workspace.read_file", args: { path: ".env" } }),
  );

  const call = inbound.find((message) => message.type === "tool.call");
  await provider.sendToolResult({
    type: "tool.result",
    id: call.id,
    sessionId: session.id,
    ok: false,
    error: { code: "PERMISSION_DENIED", message: "Refused: .env — environment files can hold credentials." },
    durationMs: 1,
  });

  assert.match(clipboard.text, /was refused \(PERMISSION_DENIED\)/);
  assert.match(clipboard.text, /environment files can hold credentials/);
  assert.match(clipboard.text, /"ok": false/);
});

test("several calls in one reply run one at a time", async () => {
  const { provider, inbound } = harness();
  await provider.connect(session);
  await provider.sendRequest(request("do everything"));

  await provider.receiveReply(
    [
      reply({ v: 1, type: "tool.call", id: "a", tool: "editor.diagnostics" }),
      reply({ v: 1, type: "tool.call", id: "b", tool: "workspace.read_file", args: { path: "x.js" } }),
    ].join("\n\n"),
  );

  const calls = inbound.filter((message) => message.type === "tool.call");
  assert.equal(calls.length, 1, "a burst would leave the user pasting results in an undefined order");
  assert.equal(calls[0].tool, "editor.diagnostics");
});

test("an unreadable block does not swallow the answer", async () => {
  const { provider, inbound } = harness();
  await provider.connect(session);
  await provider.sendRequest(request("hello"));

  await provider.receiveReply(
    ["Here is my answer.", "", "```dwtd", "{ broken", "```"].join("\n"),
  );

  const response = inbound.find((message) => message.type === "coach.response");
  assert.ok(response, "the prose is still delivered");
  assert.match(response.response.content[0].text, /Here is my answer/);
  assert.match(response.response.content[0].text, /could not be read/, "and the problem is disclosed");
});

/* ------------------------------------------------------------------ *
 * The primer
 * ------------------------------------------------------------------ */

test("the primer is copied and reflects the live tool list", async () => {
  const { provider, clipboard, awaiting } = harness();
  await provider.connect(session);

  await provider.copyPrimer();

  assert.match(clipboard.text, /bridge protocol/);
  assert.match(clipboard.text, /workspace\.read_file/);
  assert.match(clipboard.text, /shell\.run.*needs my approval/);
  assert.equal(awaiting.at(-1), "primer");
});

test("cancelling clears what the user was being asked to do", async () => {
  const { provider, awaiting } = harness();
  await provider.connect(session);
  await provider.sendRequest(request("hello"));
  assert.equal(awaiting.at(-1), "request");

  await provider.cancelRequest("req_1");
  assert.equal(awaiting.at(-1), undefined);
});

/* ------------------------------------------------------------------ *
 * No setup step
 * ------------------------------------------------------------------ */

test("the first message carries the rules, so there is nothing to set up", async () => {
  const { provider, clipboard } = harness();
  await provider.connect(session);

  await provider.sendRequest(request("why does this reload?"));

  // One paste starts the conversation: rules and question together.
  assert.match(clipboard.text, /bridge protocol/, "the first message explains itself");
  assert.match(clipboard.text, /workspace\.read_file/, "including what it may ask for");
  assert.match(clipboard.text, /why does this reload\?/, "and the actual question");
});

test("later messages do not repeat the rules", async () => {
  const { provider, clipboard } = harness();
  await provider.connect(session);

  await provider.sendRequest(request("first"));
  await provider.receiveReply("Sure.");
  await provider.sendRequest(request("second", "req_2"));

  assert.doesNotMatch(clipboard.text, /bridge protocol/, "repeating it every turn would be noise");
  assert.match(clipboard.text, /second/);
});

test("a new conversation gets the rules again", async () => {
  const { provider, clipboard } = harness();
  await provider.connect(session);
  await provider.sendRequest(request("first"));

  // Reconnecting means a fresh chat, which has never seen the protocol.
  await provider.connect({ ...session, id: "session_new" });
  await provider.sendRequest(request("in a brand new chat", "req_9"));

  assert.match(clipboard.text, /bridge protocol/);
});
