const test = require("node:test");
const assert = require("node:assert/strict");

const http = require("node:http");

const { startRelay, RelayConnection } = require("../dist/index.js");

/**
 * A raw request, because `fetch` will not let a caller set `Host`.
 *
 * Undici treats it as a forbidden header, so the rebinding case — where the
 * client asks for someone else's name at this address — is only reachable
 * through the lower-level client. An attacker's browser has no such scruples.
 */
function rawGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path, method: "GET", headers }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body || "{}") }));
    });
    request.on("error", reject);
    request.end();
  });
}

/**
 * The pairing window.
 *
 * It exists to delete a copy-and-paste step, and it hands out a credential —
 * so the tests that matter are the refusals, and the shape of what it gives.
 *
 * Two properties were wrong here and are now pinned. It handed out the relay's
 * *own* token, which admits any adapter role, so asking for a browser
 * connection got you the editor's powers as well. And it was open whenever no
 * browser was attached — which, for a Manifest V3 worker that Chrome kills
 * every thirty seconds, is nearly always.
 */

const TOKEN = "pairing-token-0123456789abcdef";
let relay;

const join = async (kind) => {
  const connection = new RelayConnection({
    host: "127.0.0.1",
    port: relay.port,
    token: TOKEN,
    adapterKind: kind,
    adapterId: `${kind}_pairing_test`,
    capabilities: [],
    log: () => {},
    onMessage: () => {},
  });
  await connection.connect();
  return connection;
};

const askForToken = () =>
  fetch(`http://127.0.0.1:${relay.port}/pair`).then(async (response) => ({
    status: response.status,
    body: await response.json(),
  }));

test.before(async () => {
  relay = await startRelay({ port: 0, token: TOKEN, writeHandshake: false, log: () => {} });
});

test.after(async () => {
  await relay?.close();
});

test("nothing is served unless the editor opened a window", async () => {
  /*
   * The old rule — open while no browser is attached — sounded like a
   * convenience and was a permanently open door: a service worker Chrome has
   * killed is not attached, and that is the normal state of a working setup.
   */
  const { status, body } = await askForToken();
  assert.equal(status, 403);
  assert.equal(body.token, undefined, "a refusal must not leak the thing it refused");
});

test("the editor can open a window, and then a credential is served", async () => {
  const editor = await join("editor");
  editor.send("relay", { type: "pair.open", durationMs: 5000 });
  await new Promise((resolve) => setTimeout(resolve, 120));

  const { status, body } = await askForToken();
  assert.equal(status, 200);
  assert.equal(body.host, "127.0.0.1");
  assert.equal(body.port, relay.port, "the port it reports is the one it is on");

  assert.equal(typeof body.token, "string");
  assert.notEqual(
    body.token,
    TOKEN,
    "never the relay's own token — that one admits every role",
  );

  editor.close();
});

test("a paired browser's credential cannot attach as the editor", async () => {
  /*
   * This is what the shared token gave away. The editor role can open pairing
   * windows for others, publish the workspace's tool list, and answer as the
   * workspace — none of which a browser tab has any business doing.
   */
  const relay3 = await startRelay({ port: 0, token: TOKEN, writeHandshake: false, log: () => {} });

  const editor = new RelayConnection({
    host: "127.0.0.1",
    port: relay3.port,
    token: TOKEN,
    adapterKind: "editor",
    adapterId: "editor_scope_test",
    capabilities: [],
    log: () => {},
    onMessage: () => {},
  });
  await editor.connect();
  editor.send("relay", { type: "pair.open", durationMs: 5000 });
  await new Promise((resolve) => setTimeout(resolve, 120));

  const granted = (await fetch(`http://127.0.0.1:${relay3.port}/pair`).then((r) => r.json())).token;

  const asBrowser = new RelayConnection({
    host: "127.0.0.1",
    port: relay3.port,
    token: granted,
    adapterKind: "browser",
    adapterId: "browser_scope_test",
    capabilities: [],
    log: () => {},
    onMessage: () => {},
  });
  await asBrowser.connect();
  assert.equal(relay3.hub.snapshot().browser, true, "the role it was minted for works");

  const rejections = [];
  const asEditor = new RelayConnection({
    host: "127.0.0.1",
    port: relay3.port,
    token: granted,
    adapterKind: "editor",
    adapterId: "editor_escalation_test",
    capabilities: [],
    log: () => {},
    onMessage: (message) => {
      if (message.type === "adapter.rejected") rejections.push(message.reason);
    },
  });

  await assert.rejects(
    () => asEditor.connect(),
    undefined,
    "a browser credential must not be usable as the editor",
  );

  asBrowser.close();
  asEditor.close();
  editor.close();
  await relay3.close();
});

test("a window serves one claimant, not everyone who asks during it", async () => {
  // Otherwise a repeated GET is a way to collect credentials.
  const relay8 = await startRelay({ port: 0, token: TOKEN, writeHandshake: false, log: () => {} });

  const editor = new RelayConnection({
    host: "127.0.0.1",
    port: relay8.port,
    token: TOKEN,
    adapterKind: "editor",
    adapterId: "editor_single_claim",
    capabilities: [],
    log: () => {},
    onMessage: () => {},
  });
  await editor.connect();
  editor.send("relay", { type: "pair.open", durationMs: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 120));

  const first = await fetch(`http://127.0.0.1:${relay8.port}/pair`).then((r) => r.json());
  const second = await fetch(`http://127.0.0.1:${relay8.port}/pair`);

  assert.equal(typeof first.token, "string");
  assert.equal(second.status, 403, "the window closed when it was claimed");

  editor.close();
  await relay8.close();
});

test("a browser stays paired across a relay restart", async () => {
  /*
   * The reason the grant is derived from the relay token rather than minted at
   * random. The extension keeps one token across restarts so the add-on is not
   * logged out every time the relay bounces; a random grant would have undone
   * that and put the pairing button back in front of the user daily.
   */
  const stable = "restart-stable-token-abcdef0123456789";

  const first = await startRelay({ port: 0, token: stable, writeHandshake: false, log: () => {} });
  const editor = new RelayConnection({
    host: "127.0.0.1",
    port: first.port,
    token: stable,
    adapterKind: "editor",
    adapterId: "editor_restart_test",
    capabilities: [],
    log: () => {},
    onMessage: () => {},
  });
  await editor.connect();
  editor.send("relay", { type: "pair.open", durationMs: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 120));

  const granted = (await fetch(`http://127.0.0.1:${first.port}/pair`).then((r) => r.json())).token;
  editor.close();
  await first.close();

  // A new relay process, same token the extension keeps.
  const second = await startRelay({ port: 0, token: stable, writeHandshake: false, log: () => {} });
  const browser = new RelayConnection({
    host: "127.0.0.1",
    port: second.port,
    token: granted,
    adapterKind: "browser",
    adapterId: "browser_restart_test",
    capabilities: [],
    log: () => {},
    onMessage: () => {},
  });
  await browser.connect();

  assert.equal(second.hub.snapshot().browser, true, "no re-pairing needed");

  browser.close();
  await second.close();
});

test("a credential from a relay with a different token does not work", async () => {
  // Which is the revocation that matters: change the relay token, and every
  // credential issued under the old one stops.
  const old = await startRelay({ port: 0, token: "old-token-0123456789abcdef", writeHandshake: false, log: () => {} });
  const editor = new RelayConnection({
    host: "127.0.0.1",
    port: old.port,
    token: "old-token-0123456789abcdef",
    adapterKind: "editor",
    adapterId: "editor_rotate_test",
    capabilities: [],
    log: () => {},
    onMessage: () => {},
  });
  await editor.connect();
  editor.send("relay", { type: "pair.open", durationMs: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const stale = (await fetch(`http://127.0.0.1:${old.port}/pair`).then((r) => r.json())).token;
  editor.close();
  await old.close();

  const rotated = await startRelay({ port: 0, token: "new-token-fedcba9876543210", writeHandshake: false, log: () => {} });
  const browser = new RelayConnection({
    host: "127.0.0.1",
    port: rotated.port,
    token: stale,
    adapterKind: "browser",
    adapterId: "browser_rotate_test",
    capabilities: [],
    log: () => {},
    onMessage: () => {},
  });

  await assert.rejects(() => browser.connect());

  browser.close();
  await rotated.close();
});

test("a request addressed to something other than localhost is refused", async () => {
  /*
   * DNS rebinding: a site publishes a record for its own name pointing at
   * 127.0.0.1, and its pages are then same-origin with this listener, so the
   * missing CORS headers stop protecting the response. The `Host` header is
   * the one thing rebinding cannot forge.
   */
  const relay9 = await startRelay({ port: 0, token: TOKEN, writeHandshake: false, log: () => {} });

  const editor = new RelayConnection({
    host: "127.0.0.1",
    port: relay9.port,
    token: TOKEN,
    adapterKind: "editor",
    adapterId: "editor_host_test",
    capabilities: [],
    log: () => {},
    onMessage: () => {},
  });
  await editor.connect();
  editor.send("relay", { type: "pair.open", durationMs: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 120));

  const rebound = await rawGet(relay9.port, "/pair", { host: "evil.example.com" });
  assert.equal(rebound.status, 403);
  assert.equal(rebound.body.token, undefined);

  // And the window is still there for the real client, since nothing claimed it.
  const honest = await fetch(`http://127.0.0.1:${relay9.port}/pair`);
  assert.equal(honest.status, 200);

  editor.close();
  await relay9.close();
});

test("a request that carries a web page's origin is refused", async () => {
  const relay10 = await startRelay({ port: 0, token: TOKEN, writeHandshake: false, log: () => {} });

  const editor = new RelayConnection({
    host: "127.0.0.1",
    port: relay10.port,
    token: TOKEN,
    adapterKind: "editor",
    adapterId: "editor_origin_test",
    capabilities: [],
    log: () => {},
    onMessage: () => {},
  });
  await editor.connect();
  editor.send("relay", { type: "pair.open", durationMs: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 120));

  const fromPage = await fetch(`http://127.0.0.1:${relay10.port}/pair`, {
    headers: { origin: "https://evil.example.com" },
  });
  assert.equal(fromPage.status, 403);

  // An extension worker sends its own origin, and that is the real client.
  const fromAddOn = await fetch(`http://127.0.0.1:${relay10.port}/pair`, {
    headers: { origin: "chrome-extension://abcdefghijklmnop" },
  });
  assert.equal(fromAddOn.status, 200);

  editor.close();
  await relay10.close();
});

test("nothing but the editor can open the window", async () => {
  // A browser or an agent asking to open pairing is asking to be handed the
  // credential it is supposed to be proving it already has.
  const relay2 = await startRelay({ port: 0, token: TOKEN, writeHandshake: false, log: () => {} });

  const browser = new RelayConnection({
    host: "127.0.0.1",
    port: relay2.port,
    token: TOKEN,
    adapterKind: "browser",
    adapterId: "browser_pairing_test",
    capabilities: [],
    log: () => {},
    onMessage: () => {},
  });
  await browser.connect();
  browser.send("relay", { type: "pair.open", durationMs: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 120));

  const response = await fetch(`http://127.0.0.1:${relay2.port}/pair`);
  assert.equal(response.status, 403, "the browser must not be able to open its own door");

  browser.close();
  await relay2.close();
});

/* ------------------------------------------------------------------ *
 * A token that outlives the process
 * ------------------------------------------------------------------ */

test("a supplied token is used instead of a fresh one", async () => {
  // The relay minting its own token meant every restart logged the browser
  // add-on out, which is most of what "it keeps disconnecting" was.
  const stable = "stable-token-that-survives-restarts-0123";

  const first = await startRelay({ port: 0, token: stable, writeHandshake: false, log: () => {} });
  const second = await startRelay({ port: 0, token: stable, writeHandshake: false, log: () => {} });

  const connection = new RelayConnection({
    host: "127.0.0.1",
    port: second.port,
    token: stable,
    adapterKind: "browser",
    adapterId: "browser_token_test",
    capabilities: [],
    log: () => {},
    onMessage: () => {},
  });
  await connection.connect();
  assert.equal(second.hub.snapshot().browser, true, "credentials from before still work");

  connection.close();
  await first.close();
  await second.close();
});

test("health reports the build, so a stale relay can be spotted", async () => {
  const response = await fetch(`http://127.0.0.1:${relay.port}/health`);
  const body = await response.json();

  // The extension compares this with its own build and restarts a mismatch,
  // which is what the manual "Stop then Start" step used to be for.
  assert.equal(typeof body.build, "string");
  assert.equal(body.token, undefined, "health stays unauthenticated, so it leaks nothing");
});

/* ------------------------------------------------------------------ *
 * Who answers
 * ------------------------------------------------------------------ */

test("a real chat outranks the mock, not the other way round", async () => {
  /*
   * The failure this pins: `Start relay + provider` leaves a mock process
   * attached. A user who then paired a browser tab and asked a question got
   * "MOCK: I received your message", because the double won the routing and
   * nothing said so.
   */
  const relay5 = await startRelay({ port: 0, token: TOKEN, writeHandshake: false, log: () => {} });

  const seen = { mock: 0, browser: 0 };
  const attach = (kind, counter) =>
    new RelayConnection({
      host: "127.0.0.1",
      port: relay5.port,
      token: TOKEN,
      adapterKind: kind,
      adapterId: `${kind}_routing_test`,
      capabilities: [],
      log: () => {},
      onMessage: (message) => {
        if (message.type === "coach.request") counter();
      },
    });

  // The mock attaches first, exactly as it does in real use.
  const mock = attach("provider", () => (seen.mock += 1));
  await mock.connect();
  const browser = attach("browser", () => (seen.browser += 1));
  await browser.connect();

  await relay5.hub.ask("s", "who answers?", 3000).catch(() => {});

  assert.equal(seen.browser, 1, "the paired chat gets the question");
  assert.equal(seen.mock, 0, "the double does not");

  mock.close();
  browser.close();
  await relay5.close();
});

/* ------------------------------------------------------------------ *
 * Streaming
 * ------------------------------------------------------------------ */

test("partials keep flowing, and only a finished reply closes the turn", async () => {
  /*
   * The bug this pins, exactly: the correlation entry was deleted on the
   * *first* response of any kind. So partial one arrived, and every partial
   * after it — including the final complete reply — failed the correlation
   * check and was dropped as "does not correlate". The panel showed a few
   * words and then stopped, which is indistinguishable from truncation.
   */
  const relay6 = await startRelay({ port: 0, token: TOKEN, writeHandshake: false, log: () => {} });

  const seen = [];
  const editor = new RelayConnection({
    host: "127.0.0.1",
    port: relay6.port,
    token: TOKEN,
    adapterKind: "editor",
    adapterId: "editor_stream_test",
    capabilities: [],
    log: () => {},
    onMessage: (message) => {
      if (message.type === "coach.response") {
        seen.push({
          text: message.response.content[0].text,
          state: message.response.completion.state,
        });
      }
    },
  });
  await editor.connect();

  const chat = new RelayConnection({
    host: "127.0.0.1",
    port: relay6.port,
    token: TOKEN,
    adapterKind: "browser",
    adapterId: "browser_stream_test",
    capabilities: [],
    log: () => {},
    onMessage: () => {},
  });
  await chat.connect();

  const requestId = "req_stream";
  editor.send("s", {
    type: "coach.request",
    request: {
      id: requestId,
      sessionId: "s",
      createdAt: new Date().toISOString(),
      message: "explain binary search",
      workspace: { name: "t", roots: [] },
      contextItems: [],
      attachments: [],
      clientCapabilities: {},
      availableTools: [],
    },
  });

  const reply = (text, state) =>
    chat.send("s", {
      type: "coach.response",
      response: {
        id: `res_${text.length}`,
        requestId,
        sessionId: "s",
        createdAt: new Date().toISOString(),
        content: [{ type: "text", text }],
        source: { adapterKind: "browser", surfaceType: "test" },
        completion: { state },
      },
    });

  await new Promise((resolve) => setTimeout(resolve, 120));
  reply("Binary", "partial");
  await new Promise((resolve) => setTimeout(resolve, 60));
  reply("Binary search halves", "partial");
  await new Promise((resolve) => setTimeout(resolve, 60));
  reply("Binary search halves the range.", "complete");
  await new Promise((resolve) => setTimeout(resolve, 200));

  const states = seen.map((entry) => entry.state);
  assert.deepEqual(states, ["partial", "partial", "complete"], "every update must arrive");
  assert.equal(seen[seen.length - 1].text, "Binary search halves the range.");

  // And the turn is closed once, at the end.
  assert.equal(relay6.hub.snapshot().pending, 0, "a finished reply clears the correlation");

  editor.close();
  chat.close();
  await relay6.close();
});

test("a partial does not resolve an HTTP caller with a fragment", async () => {
  // The harness endpoint has to hand back one finished answer; resolving on
  // the first partial would return half a sentence and end the request.
  const relay7 = await startRelay({ port: 0, token: TOKEN, writeHandshake: false, log: () => {} });

  const chat = new RelayConnection({
    host: "127.0.0.1",
    port: relay7.port,
    token: TOKEN,
    adapterKind: "browser",
    adapterId: "browser_http_stream",
    capabilities: [],
    log: () => {},
    onMessage: (message) => {
      if (message.type !== "coach.request") return;
      const send = (text, state) =>
        chat.send(message.request.sessionId, {
          type: "coach.response",
          response: {
            id: `res_${state}`,
            requestId: message.request.id,
            sessionId: message.request.sessionId,
            createdAt: new Date().toISOString(),
            content: [{ type: "text", text }],
            source: { adapterKind: "browser", surfaceType: "test" },
            completion: { state },
          },
        });
      send("half", "partial");
      setTimeout(() => send("the whole answer", "complete"), 80);
    },
  });
  await chat.connect();

  const answer = await relay7.hub.ask("s", "question", 4000);
  assert.equal(answer, "the whole answer", "fragments must not end the request");

  chat.close();
  await relay7.close();
});

test("health says whether a browser is attached, not just a provider", async () => {
  /*
   * `provider` is true when either a mock process or a browser is connected, so
   * on its own it cannot answer "is my chat connected?" — which is the only
   * question anyone asks this endpoint while something is wrong.
   */
  const relay11 = await startRelay({ port: 0, token: TOKEN, writeHandshake: false, log: () => {} });

  const before = await (await fetch(`http://127.0.0.1:${relay11.port}/health`)).json();
  assert.equal(before.adapters.browser, false);

  const browser = new RelayConnection({
    host: "127.0.0.1",
    port: relay11.port,
    token: TOKEN,
    adapterKind: "browser",
    adapterId: "browser_health_test",
    capabilities: [],
    log: () => {},
    onMessage: () => {},
  });
  await browser.connect();

  const after = await (await fetch(`http://127.0.0.1:${relay11.port}/health`)).json();
  assert.equal(after.adapters.browser, true);
  assert.equal(after.adapters.provider, true, "and it still counts as a provider");

  browser.close();
  await relay11.close();
});
