const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

const { startRelay } = require("../dist/server.js");
const { PROTOCOL_VERSION } = require("@dumbways/protocol");

/**
 * Relay tests (spec §54).
 *
 * These run a real relay on a real ephemeral port with real sockets. The
 * relay's whole job is what happens between processes, so faking the socket
 * would test nothing that matters.
 */

const TOKEN = "test-token-0123456789abcdef";

let relay;

test.before(async () => {
  relay = await startRelay({
    port: 0, // ephemeral: never collide with a relay the user is running
    token: TOKEN,
    writeHandshake: false,
    log: () => {},
    heartbeatIntervalMs: 50,
    heartbeatStaleMs: 200,
    handshakeTimeoutMs: 300,
  });
});

test.after(async () => {
  await relay?.close();
});

/** A test client that speaks the wire protocol. */
function connect() {
  const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/transport`);
  const inbox = [];
  const waiters = [];

  socket.on("message", (data) => {
    const envelope = JSON.parse(data.toString());
    const payload = envelope.payload;
    const waiter = waiters.find((candidate) => candidate.match(payload));
    if (waiter) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(payload);
      return;
    }
    inbox.push(payload);
  });

  return {
    socket,
    open: () => new Promise((resolve) => socket.once("open", resolve)),
    closed: () => new Promise((resolve) => socket.once("close", (code) => resolve(code))),
    send(payload, sessionId = "session_test") {
      socket.send(
        JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          id: `msg_${Math.random().toString(36).slice(2)}`,
          timestamp: new Date().toISOString(),
          sessionId,
          payload,
        }),
      );
    },
    /** Resolves with the next message of `type`, including ones already seen. */
    next(type, timeoutMs = 2000) {
      return this.nextWhere(type, () => true, timeoutMs);
    },

    /**
     * Waits for a message of `type` that also satisfies `predicate`.
     *
     * Needed because the relay broadcasts the registry on every change,
     * including an adapter's own arrival — so "the next registry message" is
     * not necessarily the one describing the change under test.
     */
    nextWhere(type, predicate, timeoutMs = 2000) {
      const seen = inbox.findIndex(
        (payload) => payload.type === type && predicate(payload),
      );
      if (seen >= 0) {
        return Promise.resolve(inbox.splice(seen, 1)[0]);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
        waiters.push({
          match: (payload) => payload.type === type && predicate(payload),
          resolve: (payload) => {
            clearTimeout(timer);
            resolve(payload);
          },
        });
      });
    },
    close: () => socket.close(),
  };
}

async function join(kind, token = TOKEN, protocolVersion = PROTOCOL_VERSION) {
  const client = connect();
  await client.open();
  client.send({
    type: "adapter.hello",
    adapterKind: kind,
    adapterId: `${kind}_test`,
    protocolVersion,
    token,
    capabilities: [],
  });
  return client;
}

/* ------------------------------------------------------------------ *
 * Authentication (spec §23)
 * ------------------------------------------------------------------ */

test("a correct token is welcomed", async () => {
  const editor = await join("editor");
  const welcome = await editor.next("adapter.welcome");

  assert.equal(welcome.sessionTokenAccepted, true);
  assert.equal(welcome.protocolVersion, PROTOCOL_VERSION);
  assert.match(welcome.connectionId, /^conn_/);

  editor.close();
});

test("a wrong token is rejected and the socket is closed", async () => {
  const client = await join("editor", "not-the-token");

  const rejected = await client.next("adapter.rejected");
  assert.equal(rejected.reason, "bad-token");

  const code = await client.closed();
  assert.equal(code, 1008);
});

test("a mismatched protocol version is rejected, not guessed (spec §49)", async () => {
  const client = await join("editor", TOKEN, 99);

  const rejected = await client.next("adapter.rejected");
  assert.equal(rejected.reason, "bad-version");
  assert.match(rejected.message, /99/);

  await client.closed();
});

test("a socket that never says hello is dropped", async () => {
  const client = connect();
  await client.open();
  // Say nothing at all.
  const code = await client.closed();
  assert.equal(code, 1008);
});

test("an unauthenticated socket cannot route anything", async () => {
  const editor = await join("editor");
  await editor.next("adapter.welcome");

  const intruder = connect();
  await intruder.open();
  intruder.send({
    type: "coach.request",
    request: { id: "req_evil", sessionId: "session_test", message: "steal" },
  });

  // It is closed for failing the handshake, and the editor hears nothing.
  await intruder.closed();
  await assert.rejects(editor.next("coach.request", 300));

  editor.close();
});

/* ------------------------------------------------------------------ *
 * Routing (spec §0U)
 * ------------------------------------------------------------------ */

test("a request goes editor → provider, and the response comes back", async () => {
  const editor = await join("editor");
  const provider = await join("provider");
  await editor.next("adapter.welcome");
  await provider.next("adapter.welcome");

  editor.send({
    type: "coach.request",
    request: { id: "req_1", sessionId: "session_test", message: "why?" },
  });

  const forwarded = await provider.next("coach.request");
  assert.equal(forwarded.request.id, "req_1");
  assert.equal(forwarded.request.message, "why?");

  provider.send({
    type: "coach.response",
    response: {
      id: "res_1",
      requestId: "req_1",
      sessionId: "session_test",
      createdAt: new Date().toISOString(),
      content: [{ type: "text", text: "because" }],
      source: { adapterKind: "mock" },
      completion: { state: "complete" },
    },
  });

  const delivered = await editor.next("coach.response");
  assert.equal(delivered.response.requestId, "req_1");
  assert.equal(delivered.response.content[0].text, "because");

  editor.close();
  provider.close();
});

test("tool calls route provider → editor and results route back", async () => {
  const editor = await join("editor");
  const provider = await join("provider");
  await editor.next("adapter.welcome");
  await provider.next("adapter.welcome");

  provider.send({
    type: "tool.call",
    id: "tool_1",
    sessionId: "session_test",
    tool: "editor.active_document",
    arguments: {},
  });

  const call = await editor.next("tool.call");
  assert.equal(call.tool, "editor.active_document");

  editor.send({
    type: "tool.result",
    id: "tool_1",
    sessionId: "session_test",
    ok: true,
    result: { content: "hello" },
    durationMs: 3,
  });

  const result = await provider.next("tool.result");
  assert.equal(result.ok, true);
  assert.equal(result.result.content, "hello");

  editor.close();
  provider.close();
});

test("a request with no provider connected names the broken hop (spec §0W)", async () => {
  const editor = await join("editor");
  await editor.next("adapter.welcome");

  editor.send({
    type: "coach.request",
    request: { id: "req_lonely", sessionId: "session_test", message: "hello?" },
  });

  const error = await editor.next("provider.error");
  assert.match(error.message, /No provider is connected/);
  assert.equal(error.requestId, "req_lonely");

  editor.close();
});

test("opening a surface with no browser returns a correlated failure", async () => {
  const editor = await join("editor");
  await editor.next("adapter.welcome");

  editor.send({
    type: "surface.open",
    requestId: "open_without_browser",
    model: "perplexity",
  });

  const outcome = await editor.next("surface.opened");
  assert.equal(outcome.requestId, "open_without_browser");
  assert.equal(outcome.model, "perplexity");
  assert.equal(outcome.status, "failed");
  assert.match(outcome.detail, /browser add-on is not connected/i);

  editor.close();
});

test("a browser's surface result returns to the editor unchanged", async () => {
  const editor = await join("editor");
  const browser = await join("browser");
  await editor.next("adapter.welcome");
  await browser.next("adapter.welcome");

  editor.send({
    type: "surface.open",
    requestId: "open_deepseek_policy",
    model: "deepseek",
  });

  const open = await browser.next("surface.open");
  assert.equal(open.requestId, "open_deepseek_policy");

  browser.send({
    type: "surface.opened",
    requestId: open.requestId,
    model: open.model,
    status: "blocked",
    detail: "ExtensionsSettings policy",
  });

  const outcome = await editor.next("surface.opened");
  assert.deepEqual(outcome, {
    type: "surface.opened",
    requestId: "open_deepseek_policy",
    model: "deepseek",
    status: "blocked",
    detail: "ExtensionsSettings policy",
  });

  editor.close();
  browser.close();
});

test("an uncorrelated response is dropped, not delivered (spec §46)", async () => {
  const editor = await join("editor");
  const provider = await join("provider");
  await editor.next("adapter.welcome");
  await provider.next("adapter.welcome");

  provider.send({
    type: "coach.response",
    response: {
      id: "res_stray",
      requestId: "req_never_asked",
      sessionId: "session_test",
      createdAt: new Date().toISOString(),
      content: [{ type: "text", text: "unsolicited" }],
      source: { adapterKind: "mock" },
      completion: { state: "complete" },
    },
  });

  await assert.rejects(editor.next("coach.response", 300));

  editor.close();
  provider.close();
});

test("a provider cannot impersonate the editor and issue requests", async () => {
  const editor = await join("editor");
  const provider = await join("provider");
  await editor.next("adapter.welcome");
  await provider.next("adapter.welcome");

  provider.send({
    type: "coach.request",
    request: { id: "req_spoof", sessionId: "session_test", message: "from the wrong side" },
  });

  await assert.rejects(provider.next("coach.request", 300));

  editor.close();
  provider.close();
});

/* ------------------------------------------------------------------ *
 * Connection state (spec §0I, §0R)
 * ------------------------------------------------------------------ */

test("the registry is broadcast as adapters come and go", async () => {
  const editor = await join("editor");
  await editor.next("adapter.welcome");

  const provider = await join("provider");
  await provider.next("adapter.welcome");

  const registry = await editor.nextWhere("adapter.registry", (message) => message.provider);
  assert.equal(registry.editor, true);
  assert.equal(registry.provider, true);

  provider.close();

  const afterLeaving = await editor.nextWhere(
    "adapter.registry",
    (message) => !message.provider,
  );
  assert.equal(afterLeaving.provider, false);

  editor.close();
});

test("a browser is reported as a browser, not just as 'something answered'", async () => {
  // The panel shows the route, not only whether it works. Folding a browser
  // into `provider` left the browser hop with no source at all, so it read
  // "not built yet" while a browser was attached and driving a chat.
  const editor = await join("editor");
  await editor.next("adapter.welcome");

  const browser = await join("browser");
  await browser.next("adapter.welcome");

  const registry = await editor.nextWhere("adapter.registry", (message) => message.browser);
  assert.equal(registry.browser, true);
  assert.equal(registry.provider, true, "a browser can still answer a request");

  browser.close();

  // Wait for the settled state rather than the first message that mentions
  // the browser leaving: a neighbouring test's adapter can still be closing,
  // and asserting on whichever broadcast arrives first is a race.
  const afterLeaving = await editor.nextWhere(
    "adapter.registry",
    (message) => !message.browser && !message.provider,
  );
  assert.equal(afterLeaving.browser, false);
  assert.equal(afterLeaving.provider, false);

  editor.close();
});

test("a browser's pairing reaches the editor", async () => {
  // Pairing lives in the browser and changes while the editor runs, so it
  // cannot be inferred from the socket — it has to travel.
  const editor = await join("editor");
  await editor.next("adapter.welcome");

  const browser = await join("browser");
  await browser.next("adapter.welcome");

  browser.send({
    type: "surface.status",
    paired: true,
    surfaceType: "chatgpt",
    detail: "Paired. This chat can be driven from your editor.",
  });

  const status = await editor.next("surface.status");
  assert.equal(status.paired, true);
  assert.equal(status.surfaceType, "chatgpt");
  assert.match(status.detail, /can be driven/);

  editor.close();
  browser.close();
});

test("a second adapter of the same kind replaces the first", async () => {
  const first = await join("editor");
  await first.next("adapter.welcome");

  const second = await join("editor");
  await second.next("adapter.welcome");

  const code = await first.closed();
  assert.equal(code, 1000, "the older editor is closed cleanly, not left as a ghost");

  second.close();
});

test("ping is answered with pong", async () => {
  const editor = await join("editor");
  await editor.next("adapter.welcome");

  const sentAt = new Date().toISOString();
  editor.send({ type: "ping", sentAt });

  const pong = await editor.next("pong");
  assert.equal(pong.sentAt, sentAt);

  editor.close();
});

test("health reports liveness without leaking the token (spec §0F)", async () => {
  const response = await fetch(`http://127.0.0.1:${relay.port}/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.service, "dumbways-relay");
  assert.equal(body.protocolVersion, PROTOCOL_VERSION);
  assert.equal(JSON.stringify(body).includes(TOKEN), false, "the token must never be served");
});

test("malformed frames do not take the relay down", async () => {
  const editor = await join("editor");
  await editor.next("adapter.welcome");

  editor.socket.send("this is not json");
  editor.socket.send(JSON.stringify({ nope: true }));
  editor.socket.send(JSON.stringify({ protocolVersion: 1, id: "m", timestamp: "t", sessionId: "s", payload: { type: "unknown.type" } }));

  // Still alive and routing.
  editor.send({ type: "ping", sentAt: "x" });
  const pong = await editor.next("pong");
  assert.equal(pong.sentAt, "x");

  editor.close();
});

/* ------------------------------------------------------------------ *
 * Media (spec §0M, §9) — Phase 9 acceptance
 * ------------------------------------------------------------------ */

const nodeFs = require("node:fs/promises");
const nodeOs = require("node:os");
const nodePath = require("node:path");

async function registerMedia(editor, bytes, over = {}) {
  const dir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "dumbways-relaymedia-"));
  const file = nodePath.join(dir, "shot.png");
  await nodeFs.writeFile(file, bytes);

  const media = {
    id: "media_abc123456789",
    filename: "shot.png",
    mimeType: "image/png",
    size: bytes.length,
    sha256: "deadbeef",
    source: "screenshot",
    localMediaPath: file,
    ...over,
  };

  editor.send({ type: "media.register", media });
  return { media, dir };
}

test("a registered attachment can be fetched with the token (spec §53 Phase 9)", async () => {
  const editor = await join("editor");
  await editor.next("adapter.welcome");

  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const { media } = await registerMedia(editor, bytes);

  // Give the relay a moment to record the registration.
  await new Promise((resolve) => setTimeout(resolve, 100));

  const response = await fetch(`http://127.0.0.1:${relay.port}/media/${media.id}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("cache-control"), "no-store");

  const received = Buffer.from(await response.arrayBuffer());
  assert.deepEqual([...received], [...bytes], "the exact bytes must come back");

  editor.close();
});

test("media requires the token", async () => {
  const editor = await join("editor");
  await editor.next("adapter.welcome");
  const { media } = await registerMedia(editor, Buffer.from([1, 2, 3]), {
    id: "media_needsauth01",
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  const anonymous = await fetch(`http://127.0.0.1:${relay.port}/media/${media.id}`);
  assert.equal(anonymous.status, 401);

  const wrongToken = await fetch(`http://127.0.0.1:${relay.port}/media/${media.id}`, {
    headers: { authorization: "Bearer not-the-token" },
  });
  assert.equal(wrongToken.status, 401);

  editor.close();
});

test("an unknown id is 404, and an unauthenticated caller cannot tell the difference", async () => {
  const known = await fetch(`http://127.0.0.1:${relay.port}/media/media_does_not_exist`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(known.status, 404);

  // Without the token, a real id and a fake id look identical: 401 either way.
  const anonymous = await fetch(`http://127.0.0.1:${relay.port}/media/media_does_not_exist`);
  assert.equal(anonymous.status, 401);
});

test("the endpoint takes ids, never paths (spec §9)", async () => {
  const editor = await join("editor");
  await editor.next("adapter.welcome");

  // Nothing path-shaped resolves, because ids are the only key there is.
  for (const attempt of [
    "../../../etc/passwd",
    "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    "/etc/passwd",
  ]) {
    const response = await fetch(
      `http://127.0.0.1:${relay.port}/media/${encodeURIComponent(attempt)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    assert.equal(response.status, 404, `expected 404 for ${attempt}`);
  }

  editor.close();
});

test("a provider cannot register media", async () => {
  const editor = await join("editor");
  const provider = await join("provider");
  await editor.next("adapter.welcome");
  await provider.next("adapter.welcome");

  provider.send({
    type: "media.register",
    media: {
      id: "media_fromprovider",
      filename: "evil.png",
      mimeType: "image/png",
      size: 3,
      sha256: "x",
      source: "screenshot",
      localMediaPath: "/etc/passwd",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  const response = await fetch(`http://127.0.0.1:${relay.port}/media/media_fromprovider`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.status, 404, "only the editor owns local files");

  editor.close();
  provider.close();
});

test("a registration whose file has been deleted reports 410, not a stack trace", async () => {
  const editor = await join("editor");
  await editor.next("adapter.welcome");

  const { media, dir } = await registerMedia(editor, Buffer.from([1, 2, 3]), {
    id: "media_deletedfile",
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await nodeFs.rm(dir, { recursive: true, force: true });

  const response = await fetch(`http://127.0.0.1:${relay.port}/media/${media.id}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.status, 410);

  editor.close();
});
