const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

const { startRelay, RelayConnection } = require("@dumbways/relay");

/**
 * A coding agent talking to the editor, through everything.
 *
 * This drives the real server as a real subprocess over real pipes, with a
 * real relay and a stand-in editor answering tool calls. The claim being
 * tested is the one that matters: a tool call made by an agent reaches the
 * editor, and the answer comes back to the agent that asked.
 */

const TOKEN = "mcp-test-token-0123456789";
let relay;
let editor;
let server;

const TOOLS = [
  { name: "workspace.read_file", description: "Read a file.", permission: "read" },
  { name: "shell.run", description: "Run a command.", permission: "execute" },
];

test.before(async () => {
  relay = await startRelay({ port: 0, token: TOKEN, writeHandshake: true, log: () => {} });

  editor = new RelayConnection({
    host: "127.0.0.1",
    port: relay.port,
    token: TOKEN,
    adapterKind: "editor",
    adapterId: "editor_mcp_test",
    capabilities: [],
    log: () => {},
    onMessage: (message) => {
      if (message.type !== "tool.call") return;
      const ok = message.tool === "workspace.read_file";
      editor.send(message.sessionId, {
        type: "tool.result",
        id: message.id,
        sessionId: message.sessionId,
        ok,
        ...(ok
          ? { result: { path: message.arguments.path, content: "hello from the editor" } }
          : { error: { code: "PERMISSION_DENIED", message: "The user declined." } }),
        durationMs: 1,
      });
    },
  });
  await editor.connect();
  editor.send("relay", { type: "tools.available", tools: TOOLS });

  server = spawn(process.execPath, [path.join(__dirname, "..", "dist", "server.js")], {
    env: { ...process.env, DUMBWAYS_RELAY_PORT: String(relay.port) },
    stdio: ["pipe", "pipe", "pipe"],
  });

  await new Promise((resolve) => setTimeout(resolve, 800));
});

test.after(async () => {
  server?.kill();
  editor?.close();
  await relay?.close();
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${method}`)), 5000);
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString();
      for (const line of buffer.split("\n")) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === id) {
          clearTimeout(timer);
          server.stdout.off("data", onData);
          resolve(message);
          return;
        }
      }
    };
    server.stdout.on("data", onData);
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
  });
}

test("it introduces itself as an MCP server", async () => {
  const reply = await rpc("initialize");
  assert.equal(reply.result.serverInfo.name, "dumb-ways-to-die");
  assert.ok(reply.result.capabilities.tools);
});

test("it lists the tools the editor published, not a hard-coded copy", async () => {
  const reply = await rpc("tools/list");
  const names = reply.result.tools.map((tool) => tool.name);

  // Dots are illegal in MCP tool names, so they travel as a doubled
  // underscore — which must survive a name that already contains one.
  assert.deepEqual(names, ["workspace__read_file", "shell__run"]);

  const shell = reply.result.tools.find((tool) => tool.name === "shell__run");
  assert.match(shell.description, /approve every run/, "approval is disclosed up front");
});

test("a tool call reaches the editor and the answer comes back", async () => {
  const reply = await rpc("tools/call", {
    name: "workspace__read_file",
    arguments: { path: "public/index.html" },
  });

  assert.equal(reply.error, undefined, "a working call is not a JSON-RPC error");
  const payload = JSON.parse(reply.result.content[0].text);
  assert.equal(payload.content, "hello from the editor");
  assert.equal(payload.path, "public/index.html", "arguments survive the round trip");
});

test("a refusal is a result the agent can read, not a broken server", async () => {
  const reply = await rpc("tools/call", { name: "shell__run", arguments: { command: "rm -rf /" } });

  // isError keeps the agent in its own loop: it reads the reason and adapts.
  // A JSON-RPC error looks like a crash, and agents respond by giving up.
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /PERMISSION_DENIED/);
  assert.match(reply.result.content[0].text, /declined/);
});

test("an unknown method fails without taking the server down", async () => {
  const bad = await rpc("tools/nonsense");
  assert.ok(bad.error, "unknown methods are errors");

  const alive = await rpc("tools/list");
  assert.ok(alive.result.tools.length > 0, "and the server keeps serving");
});
