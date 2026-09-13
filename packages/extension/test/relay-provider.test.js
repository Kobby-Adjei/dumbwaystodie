const test = require("node:test");
const assert = require("node:assert/strict");

const { startRelay, RelayConnection } = require("@dumbways/relay");
const { RelayCoachProvider } = require("../out/transport/RelayCoachProvider.js");
const { probeRelay } = require("../out/transport/RelayLauncher.js");

/**
 * The editor side of the relay, against a real relay on a real socket.
 *
 * RelayCoachProvider implements the same CoachProvider interface as the
 * in-process mock, so this also checks the claim the layering rests on: the
 * controller above it cannot tell the difference.
 */

const TOKEN = "editor-side-token-0123456789";

let relay;
let provider;
let farSide;

/** Stands in for the launcher: the relay is already up, so never spawn. */
function stubLauncher(port) {
  return {
    ensureRunning: async () => ({
      host: "127.0.0.1",
      port,
      token: TOKEN,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      protocolVersion: 1,
      spawned: false,
    }),
    stop: async () => false,
  };
}

const session = {
  id: "session_relay_test",
  name: "test",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  workspaceRoots: [],
  messages: [],
  permissions: {},
};

test.before(async () => {
  relay = await startRelay({
    port: 0,
    token: TOKEN,
    writeHandshake: false,
    log: () => {},
  });
});

test.after(async () => {
  farSide?.close();
  await provider?.disconnect();
  await relay?.close();
});

test("connects as the editor adapter and reports the relay hop", async () => {
  const hops = [];
  const presence = [];

  provider = new RelayCoachProvider({
    launcher: stubLauncher(relay.port),
    log: () => {},
    // Mirrors ExtensionState.setHop: repeating a state is not a transition.
    // The provider says "connecting" while the launcher works and again when
    // the socket opens — both are true, and the panel only sees one change.
    onRelayState: (state) => {
      if (hops[hops.length - 1] !== state) {
        hops.push(state);
      }
    },
    onProviderPresence: (present) => presence.push(present),
  });

  await provider.connect(session);

  assert.deepEqual(hops, ["connecting", "connected"]);
  assert.equal(relay.hub.snapshot().editor, true);
});

test("a request with nobody on the far side names the broken hop, not a silence", async () => {
  const received = [];
  provider.onMessage((message) => received.push(message));

  await provider.sendRequest({
    id: "req_lonely",
    sessionId: session.id,
    createdAt: new Date().toISOString(),
    message: "anyone there?",
    workspace: { name: "t", roots: [] },
    contextItems: [],
    attachments: [],
    clientCapabilities: {},
    availableTools: [],
  });

  await waitFor(() => received.some((message) => message.type === "provider.error"));

  const error = received.find((message) => message.type === "provider.error");
  assert.match(error.message, /No provider is connected/);
  assert.equal(error.requestId, "req_lonely");
});

test("a provider attaching flips presence, and the loop runs over the wire", async () => {
  const received = [];
  provider.onMessage((message) => received.push(message));

  const presence = [];
  // Re-connect with a presence spy attached from the start.
  await provider.disconnect();
  provider = new RelayCoachProvider({
    launcher: stubLauncher(relay.port),
    log: () => {},
    onRelayState: () => {},
    onProviderPresence: (present) => presence.push(present),
  });
  provider.onMessage((message) => received.push(message));
  await provider.connect(session);

  // The far side: a bare adapter that answers by hand.
  const inbox = [];
  farSide = new RelayConnection({
    host: "127.0.0.1",
    port: relay.port,
    token: TOKEN,
    adapterKind: "provider",
    adapterId: "far_side",
    autoReconnect: false,
    onMessage: (message) => inbox.push(message),
  });
  await farSide.connect();

  await waitFor(() => presence.includes(true));
  assert.ok(presence.includes(true), "the panel is told a provider arrived");

  await provider.sendRequest({
    id: "req_wire",
    sessionId: session.id,
    createdAt: new Date().toISOString(),
    message: "over the wire",
    workspace: { name: "t", roots: [] },
    contextItems: [],
    attachments: [],
    clientCapabilities: {},
    availableTools: [],
  });

  await waitFor(() => inbox.some((message) => message.type === "coach.request"));
  const forwarded = inbox.find((message) => message.type === "coach.request");
  assert.equal(forwarded.request.message, "over the wire");

  // Far side asks for a tool, exactly as a real provider would.
  farSide.send(session.id, {
    type: "tool.call",
    id: "tool_wire",
    sessionId: session.id,
    requestId: "req_wire",
    tool: "editor.active_document",
    arguments: {},
  });

  await waitFor(() => received.some((message) => message.type === "tool.call"));
  const call = received.find((message) => message.type === "tool.call");
  assert.equal(call.tool, "editor.active_document");

  await provider.sendToolResult({
    type: "tool.result",
    id: "tool_wire",
    sessionId: session.id,
    ok: true,
    result: { content: "hi" },
    durationMs: 1,
  });

  await waitFor(() => inbox.some((message) => message.type === "tool.result"));
  const result = inbox.find((message) => message.type === "tool.result");
  assert.equal(result.result.content, "hi");

  farSide.send(session.id, {
    type: "coach.response",
    response: {
      id: "res_wire",
      requestId: "req_wire",
      sessionId: session.id,
      createdAt: new Date().toISOString(),
      content: [{ type: "text", text: "answered from another process" }],
      source: { adapterKind: "mock" },
      completion: { state: "complete" },
    },
  });

  await waitFor(() => received.some((message) => message.type === "coach.response"));
  const response = received.find((message) => message.type === "coach.response");
  assert.equal(response.response.content[0].text, "answered from another process");
});

test("presence drops when the far side leaves", async () => {
  const presence = [];
  const watcher = new RelayCoachProvider({
    launcher: stubLauncher(relay.port),
    log: () => {},
    onRelayState: () => {},
    onProviderPresence: (present) => presence.push(present),
  });
  await watcher.connect(session);

  await waitFor(() => presence.includes(true));
  farSide.close();
  farSide = undefined;

  await waitFor(() => presence[presence.length - 1] === false);
  assert.equal(presence[presence.length - 1], false);

  await watcher.disconnect();
});

test("opening a chat fails promptly when no browser is connected", async () => {
  const sender = new RelayCoachProvider({
    launcher: stubLauncher(relay.port),
    log: () => {},
    onRelayState: () => {},
    onProviderPresence: () => {},
  });
  await sender.connect({ ...session, id: "session_surface_without_browser" });

  try {
    const result = await sender.openSurface("perplexity");
    assert.equal(result.status, "failed");
    assert.match(result.detail, /browser add-on is not connected/i);
  } finally {
    await sender.disconnect();
  }
});

test("a replaced editor connection fails a pick instead of leaking its timer", async () => {
  const sender = new RelayCoachProvider({
    launcher: stubLauncher(relay.port),
    log: () => {},
    onRelayState: () => {},
    onProviderPresence: () => {},
  });
  await sender.connect({ ...session, id: "session_replaced_editor" });

  const replacement = new RelayConnection({
    host: "127.0.0.1",
    port: relay.port,
    token: TOKEN,
    adapterKind: "editor",
    adapterId: "replacement_editor",
    autoReconnect: false,
    onMessage: () => {},
  });
  await replacement.connect();
  await waitFor(() => relay.hub.snapshot().editor === true);
  await new Promise((resolve) => setTimeout(resolve, 25));

  try {
    const result = await sender.openSurface("perplexity");
    assert.equal(result.status, "failed");
    assert.match(result.detail, /local relay is not connected/i);
  } finally {
    replacement.close();
    await sender.disconnect();
  }
});

test("a browser pairing result is correlated back to the exact open request", async () => {
  const sender = new RelayCoachProvider({
    launcher: stubLauncher(relay.port),
    log: () => {},
    onRelayState: () => {},
    onProviderPresence: () => {},
  });
  await sender.connect({ ...session, id: "session_surface_open" });

  const inbox = [];
  const browser = new RelayConnection({
    host: "127.0.0.1",
    port: relay.port,
    token: TOKEN,
    adapterKind: "browser",
    adapterId: "browser_surface_open_test",
    autoReconnect: false,
    onMessage: (message) => inbox.push(message),
  });
  await browser.connect();

  try {
    const pending = sender.openSurface("deepseek");
    await waitFor(() => inbox.some((message) => message.type === "surface.open"));

    const open = inbox.find((message) => message.type === "surface.open");
    assert.equal(open.model, "deepseek");
    assert.match(open.requestId, /^surface_open_/);

    browser.send(session.id, {
      type: "surface.opened",
      requestId: open.requestId,
      model: open.model,
      status: "blocked",
      detail: "The browser policy blocks this site.",
    });

    const result = await pending;
    assert.equal(result.status, "blocked");
    assert.match(result.detail, /policy blocks/i);
  } finally {
    browser.close();
    await sender.disconnect();
  }
});

test("surface status recovers a pairing whose terminal acknowledgement was lost", async () => {
  const sender = new RelayCoachProvider({
    launcher: stubLauncher(relay.port),
    log: () => {},
    onRelayState: () => {},
    onProviderPresence: () => {},
  });
  await sender.connect({ ...session, id: "session_surface_replay" });

  const inbox = [];
  const browser = new RelayConnection({
    host: "127.0.0.1",
    port: relay.port,
    token: TOKEN,
    adapterKind: "browser",
    adapterId: "browser_surface_replay_test",
    autoReconnect: false,
    onMessage: (message) => inbox.push(message),
  });
  await browser.connect();

  try {
    const pending = sender.openSurface("gemini");
    await waitFor(() => inbox.some((message) => message.type === "surface.open"));

    // The browser state is replayable after a reconnect, unlike a one-shot
    // acknowledgement. It is a second path to the same terminal fact.
    browser.send(session.id, {
      type: "surface.status",
      paired: true,
      surfaceType: "gemini",
      surfaces: [{ id: "gemini", status: "ready" }],
    });

    const result = await pending;
    assert.equal(result.status, "ready");
  } finally {
    browser.close();
    await sender.disconnect();
  }
});

/* ------------------------------------------------------------------ *
 * What the far side actually receives
 *
 * The failure these exist for: the raw user message went over the wire and
 * the browser typed exactly that into a chat. The chat got "why does this
 * reload?" with no file, no errors and no protocol, and replied by asking the
 * user to paste their code — with everything the editor had gathered still
 * sitting in the editor.
 * ------------------------------------------------------------------ */

test("the rendered payload carries the context and the primer", async () => {
  const relayed = [];
  const listener = new RelayConnection({
    host: "127.0.0.1",
    port: relay.port,
    token: TOKEN,
    adapterKind: "provider",
    adapterId: "provider_render_test",
    capabilities: [],
    log: () => {},
    onMessage: (message) => {
      if (message.type === "coach.request") {
        relayed.push(message.request);
      }
    },
  });
  await listener.connect();

  const sender = new RelayCoachProvider({
    launcher: stubLauncher(relay.port),
    log: () => {},
    onRelayState: () => {},
    onProviderPresence: () => {},
    renderRequest: (request) => `RENDERED<${request.message}>`,
    listTools: () => [
      { name: "workspace.search", description: "Search the project.", permission: "read" },
    ],
  });
  await sender.connect({ ...session, id: "session_render_test" });

  const base = {
    sessionId: "session_render_test",
    createdAt: new Date().toISOString(),
    workspace: { name: "t", roots: [] },
    contextItems: [],
    attachments: [],
    clientCapabilities: {},
    availableTools: [],
  };

  await sender.sendRequest({ ...base, id: "req_first", message: "what is html" });
  await waitFor(() => relayed.length >= 1);

  // `rendered` is the delivery format; `message` stays the user's own words,
  // because everything downstream reasonably reads it that way.
  assert.equal(relayed[0].message, "what is html", "the question must survive intact");

  const first = relayed[0].rendered;
  assert.match(first, /RENDERED<what is html>/, "the rendered context must travel");
  assert.match(first, /dwtd/, "the first message teaches the protocol");
  assert.match(first, /workspace\.search/, "and lists the tools that exist");

  // Repeating the primer every turn would waste the chat's context window on
  // rules it has already read.
  await sender.sendRequest({ ...base, id: "req_second", message: "and css" });
  await waitFor(() => relayed.length >= 2);

  assert.equal(relayed[1].message, "and css");
  const second = relayed[1].rendered;
  assert.match(second, /RENDERED<and css>/);
  assert.doesNotMatch(second, /dwtd/, "the primer is sent once per session");

  listener.close();
  await sender.disconnect();
});

test("a new session re-teaches the rules, because it is a new conversation", async () => {
  const relayed = [];
  const listener = new RelayConnection({
    host: "127.0.0.1",
    port: relay.port,
    token: TOKEN,
    adapterKind: "provider",
    adapterId: "provider_session_test",
    capabilities: [],
    log: () => {},
    onMessage: (message) => {
      if (message.type === "coach.request") {
        relayed.push(message.request.rendered);
      }
    },
  });
  await listener.connect();

  const sender = new RelayCoachProvider({
    launcher: stubLauncher(relay.port),
    log: () => {},
    onRelayState: () => {},
    onProviderPresence: () => {},
    renderRequest: (request) => request.message,
    listTools: () => [{ name: "workspace.search", description: "S.", permission: "read" }],
  });

  const ask = async (sessionId, id, message) => {
    await sender.sendRequest({
      id,
      sessionId,
      createdAt: new Date().toISOString(),
      message,
      workspace: { name: "t", roots: [] },
      contextItems: [],
      attachments: [],
      clientCapabilities: {},
      availableTools: [],
    });
  };

  await sender.connect({ ...session, id: "session_a" });
  await ask("session_a", "req_a1", "first");
  await ask("session_a", "req_a2", "second");
  await waitFor(() => relayed.length >= 2);

  assert.match(relayed[0], /dwtd/);
  assert.doesNotMatch(relayed[1], /dwtd/);

  // Starting a fresh session means a chat that has never read the rules.
  await sender.connect({ ...session, id: "session_b" });
  await ask("session_b", "req_b1", "third");
  await waitFor(() => relayed.length >= 3);

  assert.match(relayed[2], /dwtd/, "a new conversation is taught again");

  listener.close();
  await sender.disconnect();
});

test("probeRelay only trusts our own service", async () => {
  assert.equal(await probeRelay("127.0.0.1", relay.port), true);
  // Nothing is listening here, so it must not claim a relay exists.
  assert.equal(await probeRelay("127.0.0.1", 1), false);
});

function waitFor(predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (predicate()) {
        clearInterval(poll);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(poll);
        reject(new Error("timed out waiting for condition"));
      }
    }, 25);
  });
}
