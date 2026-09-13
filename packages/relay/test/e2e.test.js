const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { RelayConnection, readHandshakeFile, removeHandshakeFile } = require("../dist/index.js");

/**
 * Phase 6 acceptance test (spec §53): "Provider runs as separate process."
 *
 * Nothing here is faked. A real relay process is spawned, a real provider
 * process attaches to it, and this test plays the editor over a real socket.
 * The whole point of the phase is what happens between operating-system
 * processes, so an in-process version of this test would prove nothing.
 */

const RELAY_ENTRY = path.join(__dirname, "..", "dist", "server.js");
const PROVIDER_ENTRY = path.join(__dirname, "..", "..", "mock-provider", "dist", "standalone.js");

// A high fixed port for this test rather than an ephemeral one: the provider
// finds the relay through the handshake file, which is named by port.
const PORT = 44100 + Math.floor(Math.random() * 300);

const children = [];

function spawnProcess(entry, label) {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, DUMBWAYS_RELAY_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  return {
    child,
    label,
    output: () => output,
    waitForReady(timeoutMs = 10000) {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const poll = setInterval(() => {
          if (output.includes("READY")) {
            clearInterval(poll);
            resolve();
          } else if (child.exitCode !== null) {
            clearInterval(poll);
            reject(new Error(`${label} exited early:\n${output}`));
          } else if (Date.now() - started > timeoutMs) {
            clearInterval(poll);
            reject(new Error(`${label} never reported READY:\n${output}`));
          }
        }, 50);
      });
    },
  };
}

let relayProcess;
let providerProcess;
let editor;
const inbox = [];
const waiters = [];

function onMessage(message) {
  const waiter = waiters.find((candidate) => candidate.type === message.type);
  if (waiter) {
    waiters.splice(waiters.indexOf(waiter), 1);
    waiter.resolve(message);
    return;
  }
  inbox.push(message);
}

function next(type, timeoutMs = 8000) {
  const seen = inbox.findIndex((message) => message.type === type);
  if (seen >= 0) {
    return Promise.resolve(inbox.splice(seen, 1)[0]);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
    waiters.push({
      type,
      resolve: (message) => {
        clearTimeout(timer);
        resolve(message);
      },
    });
  });
}

const TOOLS = [
  { name: "editor.active_document", description: "", permission: "read" },
  { name: "workspace.search", description: "", permission: "read" },
];

const CAPABILITIES = {
  readActiveDocument: true,
  readFile: false,
  searchFiles: true,
  listDirectory: false,
  projectTree: false,
  readDiagnostics: false,
  runCommand: false,
  attachments: false,
};

function coachRequest(id, message) {
  return {
    id,
    sessionId: "session_e2e",
    createdAt: new Date().toISOString(),
    message,
    workspace: { name: "e2e", roots: ["/tmp/e2e"] },
    contextItems: [],
    attachments: [],
    clientCapabilities: CAPABILITIES,
    availableTools: TOOLS,
  };
}

test.before(async () => {
  await removeHandshakeFile(PORT);

  relayProcess = spawnProcess(RELAY_ENTRY, "relay");
  await relayProcess.waitForReady();

  providerProcess = spawnProcess(PROVIDER_ENTRY, "mock-provider");
  await providerProcess.waitForReady();

  const handshake = await readHandshakeFile(PORT);
  assert.ok(handshake, "the relay should have written a handshake file");

  editor = new RelayConnection({
    host: handshake.host,
    port: handshake.port,
    token: handshake.token,
    adapterKind: "editor",
    adapterId: "editor_e2e",
    capabilities: ["editor.active_document"],
    autoReconnect: false,
    onMessage,
  });

  await editor.connect();
});

test.after(async () => {
  editor?.close();
  for (const child of children) {
    child.kill("SIGTERM");
  }
  await removeHandshakeFile(PORT);
});

test("the relay wrote a handshake file only this user can read (spec §23)", async () => {
  const fs = require("node:fs/promises");
  const os = require("node:os");
  const file = path.join(os.tmpdir(), `dumbways-relay-${PORT}.json`);
  const stats = await fs.stat(file);

  // 0600: the token is the credential, so the file permissions are the fence.
  assert.equal(stats.mode & 0o777, 0o600);
});

test("health shows both adapters attached from separate processes", async () => {
  const response = await fetch(`http://127.0.0.1:${PORT}/health`);
  const body = await response.json();

  assert.equal(body.ok, true);
  assert.equal(body.adapters.editor, true, "this test process is the editor");
  assert.equal(body.adapters.provider, true, "the provider is a different OS process");
  assert.notEqual(body.pid, process.pid, "the relay is its own process too");
});

test("a question crosses two process boundaries and the answer comes back", async () => {
  editor.send("session_e2e", {
    type: "coach.request",
    request: coachRequest("req_e2e_1", "hello there"),
  });

  const response = await next("coach.response");

  assert.equal(response.response.requestId, "req_e2e_1");
  assert.match(response.response.content[0].text, /MOCK: I received your message/);
  assert.equal(response.response.completion.state, "complete");
});

test("the full agent loop runs across processes: request → tool call → result → answer", async () => {
  editor.send("session_e2e", {
    type: "coach.request",
    request: coachRequest("req_e2e_2", "show me the active file"),
  });

  // The provider, in its own process, asks this one for more context.
  const call = await next("tool.call");
  assert.equal(call.tool, "editor.active_document");
  assert.equal(call.requestId, "req_e2e_2");

  editor.send("session_e2e", {
    type: "tool.result",
    id: call.id,
    sessionId: "session_e2e",
    ok: true,
    durationMs: 7,
    result: {
      path: "public/index.html",
      content: "x".repeat(842),
      isDirty: true,
      documentVersion: 14,
      source: "editor-buffer",
    },
  });

  const response = await next("coach.response");
  assert.equal(response.response.requestId, "req_e2e_2");
  assert.match(response.response.content[0].text, /I read 842 characters from public\/index\.html/);
  assert.match(response.response.content[0].text, /live buffer with unsaved changes/);
});

test("a search request round-trips with its arguments intact", async () => {
  editor.send("session_e2e", {
    type: "coach.request",
    request: coachRequest("req_e2e_3", 'search for regex "fetch\\(.*\\)"'),
  });

  const call = await next("tool.call");
  assert.equal(call.tool, "workspace.search");
  assert.equal(call.arguments.query, "fetch\\(.*\\)");
  assert.equal(call.arguments.isRegex, true);

  editor.send("session_e2e", {
    type: "tool.result",
    id: call.id,
    sessionId: "session_e2e",
    ok: true,
    durationMs: 12,
    result: {
      query: "fetch\\(.*\\)",
      isRegex: true,
      engine: "ripgrep",
      matches: [{ path: "src/api.js", line: 1, preview: "fetch('/api')", source: "filesystem" }],
      totalMatches: 1,
      filesWithMatches: 1,
      truncated: false,
      omittedCount: 0,
    },
  });

  const response = await next("coach.response");
  assert.match(response.response.content[0].text, /1 match\(es\) for pattern/);
  assert.match(response.response.content[0].text, /src\/api\.js:1/);
});

test("the provider process survives the editor disconnecting and reconnecting", async () => {
  editor.close();

  const handshake = await readHandshakeFile(PORT);
  const reconnected = new RelayConnection({
    host: handshake.host,
    port: handshake.port,
    token: handshake.token,
    adapterKind: "editor",
    adapterId: "editor_e2e_again",
    autoReconnect: false,
    onMessage,
  });
  await reconnected.connect();
  editor = reconnected;

  editor.send("session_e2e", {
    type: "coach.request",
    request: coachRequest("req_e2e_4", "still there?"),
  });

  const response = await next("coach.response");
  assert.equal(response.response.requestId, "req_e2e_4");
  assert.equal(
    providerProcess.child.exitCode,
    null,
    "the provider process should still be running",
  );
});

test("Phase 9 acceptance: a separate process fetches attachment bytes by id (spec §53)", async () => {
  const fsp = require("node:fs/promises");
  const os = require("node:os");
  const nodePath = require("node:path");

  // A real file with real bytes, as the editor's media registry would store it.
  const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "dumbways-e2e-media-"));
  const file = nodePath.join(dir, "screenshot.png");
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 42, 7, 11]);
  await fsp.writeFile(file, bytes);

  const media = {
    id: "media_e2e_shot01",
    filename: "screenshot.png",
    mimeType: "image/png",
    size: bytes.length,
    sha256: require("node:crypto").createHash("sha256").update(bytes).digest("hex"),
    source: "screenshot",
    localMediaPath: file,
  };

  // The editor registers it, then references it by id only.
  editor.send("session_e2e", { type: "media.register", media });

  const request = coachRequest("req_e2e_media", "what is wrong with this screen?");
  request.attachments = [media];
  editor.send("session_e2e", { type: "coach.request", request });

  const response = await next("coach.response");
  assert.equal(response.response.requestId, "req_e2e_media");

  // The message that crossed the wire carried metadata, not pixels.
  const handshake = await readHandshakeFile(PORT);
  const fetched = await fetch(`http://127.0.0.1:${PORT}/media/${media.id}`, {
    headers: { authorization: `Bearer ${handshake.token}` },
  });

  assert.equal(fetched.status, 200);
  assert.equal(fetched.headers.get("content-type"), "image/png");

  const received = Buffer.from(await fetched.arrayBuffer());
  assert.deepEqual([...received], [...bytes], "the exact bytes come back");
  assert.equal(
    require("node:crypto").createHash("sha256").update(received).digest("hex"),
    media.sha256,
    "the hash the request advertised matches the bytes that were served",
  );

  await fsp.rm(dir, { recursive: true, force: true });
});
