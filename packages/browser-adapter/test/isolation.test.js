const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { build } = require("esbuild");

/**
 * Request isolation in the service worker.
 *
 * The worker used to keep the request in flight, the chat it went to, and the
 * tool batch in three module globals. That is correct only while exactly one
 * request exists at a time — which the panel guarantees and the HTTP endpoint
 * does not. Two callers were enough to make one chat's text arrive labelled as
 * the other's answer, and to leave the first waiting until it timed out.
 *
 * These are the three interleavings that distinguish per-request state from
 * "whatever was last set": a late partial after another request started, a
 * batch that spans a reconnect, and two chats with work in flight at once.
 *
 * The worker is driven through its real surfaces — a fake `chrome` and a fake
 * socket — rather than by reaching into its internals, so what is exercised is
 * what actually ships.
 */

/* ------------------------------------------------------------------ *
 * The fakes
 * ------------------------------------------------------------------ */

const CHATGPT_TAB = 11;
const CLAUDE_TAB = 22;

/** Site names the fake can recognise in a URL when it opens a tab. */
const KNOWN = ["chatgpt", "claude", "gemini", "perplexity", "deepseek", "zai"];

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeSocket.CONNECTING;
    this.sent = [];
    this.listeners = new Map();
    FakeSocket.last = this;
  }

  addEventListener(type, handler) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(handler);
    this.listeners.set(type, existing);
  }

  emit(type, event) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event);
    }
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.emit("open", {});
  }

  close() {
    this.readyState = FakeSocket.CLOSED;
    this.emit("close", {});
  }

  send(data) {
    this.sent.push(JSON.parse(data).payload);
  }

  /** Delivers a message from the relay. */
  deliver(payload) {
    this.emit("message", {
      data: JSON.stringify({
        protocolVersion: 1,
        id: `m-${this.sent.length}-${payload.type}`,
        timestamp: "2026-01-01T00:00:00.000Z",
        sessionId: "browser",
        payload,
      }),
    });
  }

  outgoing(type) {
    return this.sent.filter((message) => message.type === type);
  }
}

/**
 * A tab that behaves like a paired chat: it accepts text, and it finishes a
 * reply only when the test says so.
 */
class FakeTab {
  constructor(tabId, surfaceType) {
    this.tabId = tabId;
    this.surfaceType = surfaceType;
    this.typed = [];
    this.observers = [];
    this.progress = [];
  }

  async handle(message) {
    switch (message.type) {
      case "probe":
        return {
          type: "probed",
          state: {
            identify: { rung: "auto" },
            deliver: { rung: "auto" },
            observe: { rung: "auto" },
          },
          surfaceType: this.surfaceType,
          url: `https://${this.surfaceType}.example/c/1`,
        };

      case "deliver":
        this.typed.push(message.text);
        return { type: "delivered", rung: "insertText", sent: true };

      case "observe": {
        // Held open: the test decides when this reply is complete, which is
        // what makes the interleavings reproducible.
        const pending = {
          requestId: message.requestId,
          observationId: message.observationId,
          resolve: undefined,
        };
        const promise = new Promise((resolve) => {
          pending.resolve = resolve;
        });
        this.observers.push(pending);
        return promise;
      }

      default:
        return { type: "failed", reason: "not supported" };
    }
  }

  /** Emits a progress frame the way the content script does. */
  async emitProgress(text, observer = this.observers[this.observers.length - 1]) {
    this.progress.push(text);
    await global.chrome.__fromContent(this.tabId, {
      type: "reply-progress",
      text,
      requestId: observer.requestId,
      observationId: observer.observationId,
    });
  }

  /** Completes the oldest unfinished observation. */
  finish(text) {
    const observer = this.observers.find((entry) => !entry.done);
    observer.done = true;
    observer.resolve({ type: "observed", text, rung: "container" });
    return observer;
  }
}

function fakeChrome(tabs, created = []) {
  const storage = {
    credentials: { host: "127.0.0.1", port: 43123, token: "t" },
    pairings: [],
  };

  const listeners = { message: [], updated: [], removed: [], alarm: [], lifecycle: [] };

  return {
    __listeners: listeners,
    __tabs: tabs,
    /** Every tab this worker asked the browser to open. */
    __created: created,
    /** Delivers a content-script message, including who sent it. */
    async __fromContent(tabId, message) {
      for (const handler of listeners.message) {
        handler(message, { tab: { id: tabId } }, () => {});
      }
      // The handlers are async internally; let their microtasks run.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    runtime: {
      onMessage: { addListener: (handler) => listeners.message.push(handler) },
      onStartup: { addListener: (handler) => listeners.lifecycle.push(handler) },
      onInstalled: { addListener: (handler) => listeners.lifecycle.push(handler) },
      getURL: (file) => `chrome-extension://fake/${file}`,
      sendMessage: async () => undefined,
    },
    storage: {
      local: {
        get: async (keys) => {
          const wanted = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(wanted.map((key) => [key, storage[key]]));
        },
        set: async (values) => Object.assign(storage, values),
        remove: async (key) => {
          delete storage[key];
        },
      },
    },
    tabs: {
      /*
       * Reports `status`, because the worker polls for it.
       *
       * Waiting on `tabs.onUpdated` alone let Chrome kill the service worker
       * during a slow page load, so the worker now polls `tabs.get` — an
       * extension API call, which is what actually keeps it alive. A fake that
       * never reports "complete" makes every open time out.
       */
      get: async (tabId) => {
        const tab = tabs.get(tabId);
        if (!tab) {
          throw new Error("no such tab");
        }
        return {
          id: tabId,
          url: `https://${tab.surfaceType}.example/c/1`,
          status: tab.status ?? "complete",
        };
      },
      sendMessage: async (tabId, message) => {
        const tab = tabs.get(tabId);
        if (!tab) {
          throw new Error("no such tab");
        }
        return tab.handle(message);
      },
      /*
       * Chrome filters by match pattern; the fake only has to be honest about
       * which tabs exist, which is what the sweep is reading.
       */
      query: async (criteria = {}) => {
        const all = [...tabs.values()].map((tab) => ({
          id: tab.tabId,
          url: `https://${tab.surfaceType}.example/c/1`,
        }));
        return criteria.url ? all : all;
      },
      /*
       * A created tab becomes a real chat, the way it does in a browser: the
       * page loads, announces itself, and answers a probe. Without this the
       * "open a chat that is not open yet" path — the one a user actually hits
       * when picking a model — could not be exercised at all.
       */
      create: async ({ url }) => {
        created.push(url);
        const id = 900 + created.length;
        const surfaceType = KNOWN.find((name) => url.includes(name)) ?? "chat";
        const tab = new FakeTab(id, surfaceType);
        // A new tab is loading before it is complete, as a real one is.
        tab.status = "loading";
        tabs.set(id, tab);

        setTimeout(() => {
          tab.status = "complete";
          for (const handler of listeners.updated) {
            handler(id, { status: "complete" }, { id, url });
          }
        }, 10);

        return { id };
      },
      update: async () => ({}),
      onUpdated: {
        addListener: (handler) => listeners.updated.push(handler),
        // `waitForTabLoad` removes its listener when it resolves; a fake
        // without this throws instead of loading a tab.
        removeListener: (handler) => {
          listeners.updated = listeners.updated.filter((entry) => entry !== handler);
        },
      },
      onRemoved: {
        addListener: (handler) => listeners.removed.push(handler),
        removeListener: (handler) => {
          listeners.removed = listeners.removed.filter((entry) => entry !== handler);
        },
      },
    },
    scripting: { executeScript: async () => [] },
    alarms: {
      create: async () => {},
      onAlarm: { addListener: (handler) => listeners.alarm.push(handler) },
    },
    permissions: { contains: async () => true, request: async () => true },
  };
}

/* ------------------------------------------------------------------ *
 * Loading the worker
 * ------------------------------------------------------------------ */

let bundlePath;

test.before(async () => {
  // Realpath, because on macOS os.tmpdir() is a symlink and `require` caches
  // under the resolved name — so deleting the un-resolved key does nothing and
  // every test after the first would share one already-started worker.
  bundlePath = path.join(fs.realpathSync(os.tmpdir()), `dwtd-worker-${process.pid}.cjs`);
  await build({
    entryPoints: [path.join(__dirname, "..", "src", "background.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile: bundlePath,
    logLevel: "silent",
  });
});

/**
 * Starts a worker with two chats reachable and an open, welcomed relay socket.
 *
 * @param load whether the chat pages announce themselves by finishing loading.
 * Turned off to test the other route in — the sweep, which finds tabs that were
 * already open before the worker woke up.
 */
async function startWorker({ load = true } = {}) {
  const tabs = new Map([
    [CHATGPT_TAB, new FakeTab(CHATGPT_TAB, "chatgpt")],
    [CLAUDE_TAB, new FakeTab(CLAUDE_TAB, "claude")],
  ]);

  global.chrome = fakeChrome(tabs);
  global.WebSocket = FakeSocket;

  /*
   * The worker keeps itself alive on purpose — a discovery interval, a
   * keepalive, a reconnect backoff — and those handles would keep node running
   * after the test finished. They are captured for the worker's whole lifetime
   * rather than just across the import, because the keepalive is started from a
   * promise chain that settles later.
   */
  const timers = [];
  const real = { setInterval: global.setInterval, setTimeout: global.setTimeout };
  global.setInterval = (...args) => {
    const handle = real.setInterval(...args);
    timers.push(["interval", handle]);
    return handle;
  };
  global.setTimeout = (...args) => {
    const handle = real.setTimeout(...args);
    timers.push(["timeout", handle]);
    return handle;
  };

  delete require.cache[bundlePath];
  require(bundlePath);

  await settle();
  FakeSocket.last.open();
  await settle();

  /*
   * The relay's half of the handshake. Without it the worker is connected but
   * not welcomed, and the sweep that runs on welcome never happens — which is
   * the difference between "a socket is open" and "the bridge is up".
   */
  FakeSocket.last.deliver({
    type: "adapter.welcome",
    connectionId: "conn_test",
    protocolVersion: 1,
    sessionTokenAccepted: true,
    peers: ["editor"],
  });
  await settle(16);

  if (load) {
    // The other route in: a chat page finishing loading after the worker woke.
    for (const tab of tabs.values()) {
      for (const handler of global.chrome.__listeners.updated) {
        handler(tab.tabId, { status: "complete" }, {
          id: tab.tabId,
          url: `https://${tab.surfaceType}.example/c/1`,
        });
      }
    }
    await settle();
  }

  return {
    tabs,
    chatgpt: tabs.get(CHATGPT_TAB),
    claude: tabs.get(CLAUDE_TAB),
    socket: FakeSocket.last,
    stop: () => {
      global.setInterval = real.setInterval;
      global.setTimeout = real.setTimeout;
      for (const [kind, handle] of timers) {
        if (kind === "interval") {
          clearInterval(handle);
        } else {
          clearTimeout(handle);
        }
      }
    },
  };
}

/** Real elapsed time, for the paths with genuine delays in them. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Lets the worker's promise chains run to a standstill. */
async function settle(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function request(id, message, model) {
  return {
    type: "coach.request",
    request: {
      id,
      sessionId: "s1",
      createdAt: "2026-01-01T00:00:00.000Z",
      message,
      ...(model ? { model } : {}),
      context: [],
    },
  };
}

const partials = (socket, requestId) =>
  socket
    .outgoing("coach.response")
    .filter((message) => message.response.requestId === requestId)
    .filter((message) => message.response.completion?.state === "partial");

const finals = (socket, requestId) =>
  socket
    .outgoing("coach.response")
    .filter((message) => message.response.requestId === requestId)
    .filter((message) => message.response.completion?.state !== "partial");

/* ------------------------------------------------------------------ *
 * 1. A partial arriving after its request finished
 * ------------------------------------------------------------------ */

test("a straggling partial is never relabelled as the next request", async () => {
  const worker = await startWorker();

  worker.socket.deliver(request("A", "first question", "chatgpt"));
  await settle();

  const observerA = worker.chatgpt.observers[0];
  worker.chatgpt.finish("answer to A");
  await settle();

  assert.equal(finals(worker.socket, "A").length, 1, "A got its answer");

  // B starts on the same tab. Now A's abandoned observation emits one more
  // frame — the case that used to be forwarded under B's id.
  worker.socket.deliver(request("B", "second question", "chatgpt"));
  await settle();

  await worker.chatgpt.emitProgress("late text from A", observerA);
  await settle();

  assert.deepEqual(
    partials(worker.socket, "B"),
    [],
    "A's text must not appear as B's reply",
  );
  assert.deepEqual(
    partials(worker.socket, "A").map((message) => message.response.content[0].text),
    [],
    "and it is not resurrected for A either — that turn is over",
  );

  worker.chatgpt.finish("answer to B");
  await settle();
  worker.stop();
});

test("a partial is forwarded for the request that is actually running", async () => {
  // The guard has to let the real thing through, or streaming is just broken.
  const worker = await startWorker();

  worker.socket.deliver(request("A", "question", "chatgpt"));
  await settle();

  await worker.chatgpt.emitProgress("half an answ");
  await settle();

  const seen = partials(worker.socket, "A").map((message) => message.response.content[0].text);
  assert.deepEqual(seen, ["half an answ"]);
  assert.equal(
    partials(worker.socket, "A")[0].response.source.surfaceType,
    "chatgpt",
    "and it is attributed to the chat it came from",
  );

  worker.chatgpt.finish("a whole answer");
  await settle();
  worker.stop();
});

test("a partial from a tab that is not the request's target is dropped", async () => {
  /*
   * The tab check is separate from the request check: a content script in
   * another tab can send this message, and `sender` is the only thing that
   * cannot be forged from the page.
   */
  const worker = await startWorker();

  worker.socket.deliver(request("A", "question", "chatgpt"));
  await settle();

  const observer = worker.chatgpt.observers[0];
  await global.chrome.__fromContent(CLAUDE_TAB, {
    type: "reply-progress",
    text: "text from the wrong tab",
    requestId: observer.requestId,
    observationId: observer.observationId,
  });
  await settle();

  assert.deepEqual(partials(worker.socket, "A"), []);

  worker.chatgpt.finish("answer");
  await settle();
  worker.stop();
});

/* ------------------------------------------------------------------ *
 * 2. A tool batch spanning a reconnect
 * ------------------------------------------------------------------ */

const toolReply = (calls) =>
  calls
    .map((call) =>
      ["```dwtd", JSON.stringify({ v: 1, type: "tool.call", id: call.id, tool: call.tool, arguments: {} }, null, 2), "```"].join("\n"),
    )
    .join("\n\n");

test("a batch survives the relay reconnecting mid-flight", async () => {
  const worker = await startWorker();

  worker.socket.deliver(request("A", "read two files", "chatgpt"));
  await settle();

  worker.chatgpt.finish(toolReply([{ id: "c1", tool: "workspace.read_file" }, { id: "c2", tool: "workspace.search" }]));
  await settle();

  const calls = worker.socket.outgoing("tool.call");
  assert.equal(calls.length, 2, "both calls went out");
  assert.deepEqual(
    calls.map((call) => call.requestId),
    ["A", "A"],
    "each names the request it belongs to",
  );

  // First result, then the socket drops and comes back — a new socket object,
  // as a real reconnect gives.
  worker.socket.deliver({ type: "tool.result", id: calls[0].id, sessionId: "browser", ok: true, result: "one", durationMs: 1 });
  await settle();

  worker.socket.close();
  await settle();

  // The keepalive alarm is what actually revives a worker Chrome has killed;
  // waiting out the backoff timer would test the clock instead.
  for (const handler of global.chrome.__listeners.alarm) {
    handler({ name: "dumbways-keepalive" });
  }
  await settle();

  const reconnected = FakeSocket.last;
  assert.notEqual(reconnected, worker.socket, "a reconnect is a new socket");
  reconnected.open();
  await settle();

  reconnected.deliver({ type: "tool.result", id: calls[1].id, sessionId: "browser", ok: true, result: "two", durationMs: 1 });
  await settle();

  const typed = worker.chatgpt.typed[worker.chatgpt.typed.length - 1];
  assert.match(typed, /"id": "c1"/, "the first result was still held");
  assert.match(typed, /"id": "c2"/, "and both are labelled with the ids the chat chose");
  assert.match(typed, /one/);
  assert.match(typed, /two/);
  assert.equal(worker.claude.typed.length, 0, "and nothing went to the other chat");

  worker.chatgpt.finish("thanks, here is the answer");
  await settle();
  worker.stop();
});

test("a result for a call nobody is waiting for is dropped, not typed somewhere", async () => {
  const worker = await startWorker();

  worker.socket.deliver(request("A", "question", "chatgpt"));
  await settle();
  worker.chatgpt.finish("a plain answer, no tools");
  await settle();

  const typedBefore = worker.chatgpt.typed.length;
  worker.socket.deliver({ type: "tool.result", id: "ghost", sessionId: "browser", ok: true, result: "x", durationMs: 1 });
  await settle();

  assert.equal(worker.chatgpt.typed.length, typedBefore, "nothing was typed");
  assert.equal(worker.claude.typed.length, 0);
  worker.stop();
});

test("a result comes back under the id the chat asked with", async () => {
  // The chat wrote "c1"; a wire id it has never seen is unmatchable.
  const worker = await startWorker();

  worker.socket.deliver(request("A", "read a file", "chatgpt"));
  await settle();
  worker.chatgpt.finish(toolReply([{ id: "c1", tool: "workspace.read_file" }]));
  await settle();

  const [call] = worker.socket.outgoing("tool.call");
  assert.notEqual(call.id, "c1", "the wire id is the worker's own, and unique");

  worker.socket.deliver({ type: "tool.result", id: call.id, sessionId: "browser", ok: true, result: "body", durationMs: 1 });
  await settle();

  const typed = worker.chatgpt.typed[worker.chatgpt.typed.length - 1];
  assert.match(typed, /"id": "c1"/);
  assert.doesNotMatch(typed, new RegExp(call.id));

  worker.chatgpt.finish("thanks");
  await settle();
  worker.stop();
});

test("a failed tool result carries its reason into the chat", async () => {
  // `ok: false` on its own tells the chat nothing it can act on.
  const worker = await startWorker();

  worker.socket.deliver(request("A", "read a file", "chatgpt"));
  await settle();
  worker.chatgpt.finish(toolReply([{ id: "c1", tool: "workspace.read_file" }]));
  await settle();

  const [call] = worker.socket.outgoing("tool.call");
  worker.socket.deliver({
    type: "tool.result",
    id: call.id,
    sessionId: "browser",
    ok: false,
    error: { code: "NOT_FOUND", message: "No such file." },
    durationMs: 1,
  });
  await settle();

  const typed = worker.chatgpt.typed[worker.chatgpt.typed.length - 1];
  assert.match(typed, /NOT_FOUND/);
  assert.match(typed, /No such file/);

  worker.chatgpt.finish("understood");
  await settle();
  worker.stop();
});

/* ------------------------------------------------------------------ *
 * 3. Two chats with work in flight at once
 * ------------------------------------------------------------------ */

test("one chat's tool loop does not divert another chat's request", async () => {
  const worker = await startWorker();

  worker.socket.deliver(request("A", "ask chatgpt", "chatgpt"));
  await settle();
  worker.chatgpt.finish(toolReply([{ id: "c1", tool: "workspace.read_file" }]));
  await settle();

  const [call] = worker.socket.outgoing("tool.call");
  assert.equal(call.requestId, "A");

  // While ChatGPT waits for its result, a second request goes to Claude.
  worker.socket.deliver(request("B", "ask claude", "claude"));
  await settle();

  assert.deepEqual(worker.claude.typed, ["ask claude"], "Claude got its own question");

  // Now ChatGPT's result arrives. It must go back to ChatGPT.
  worker.socket.deliver({ type: "tool.result", id: call.id, sessionId: "browser", ok: true, result: "file body", durationMs: 1 });
  await settle();

  assert.equal(worker.claude.typed.length, 1, "the result did not land in Claude's composer");
  assert.match(
    worker.chatgpt.typed[worker.chatgpt.typed.length - 1],
    /file body/,
    "it went back to the chat that asked",
  );

  // Both finish, each labelled with its own request and surface.
  worker.chatgpt.finish("chatgpt's answer");
  worker.claude.finish("claude's answer");
  await settle();

  const answerA = finals(worker.socket, "A").pop();
  const answerB = finals(worker.socket, "B").pop();
  assert.equal(answerA.response.source.surfaceType, "chatgpt");
  assert.equal(answerB.response.source.surfaceType, "claude");
  assert.match(answerA.response.content[0].text, /chatgpt's answer/);
  assert.match(answerB.response.content[0].text, /claude's answer/);
  worker.stop();
});

test("two requests for the same chat take turns instead of interleaving", async () => {
  /*
   * One composer, two questions. Typing the second before the first reply is
   * read would put both questions in one message and leave the first request
   * reading an answer to the pair.
   */
  const worker = await startWorker();

  worker.socket.deliver(request("A", "first", "chatgpt"));
  await settle();
  worker.socket.deliver(request("B", "second", "chatgpt"));
  await settle();

  assert.deepEqual(worker.chatgpt.typed, ["first"], "B waits its turn");

  worker.chatgpt.finish("answer to first");
  await settle();

  assert.deepEqual(worker.chatgpt.typed, ["first", "second"], "then B goes");
  worker.chatgpt.finish("answer to second");
  await settle();

  assert.match(finals(worker.socket, "A").pop().response.content[0].text, /answer to first/);
  assert.match(finals(worker.socket, "B").pop().response.content[0].text, /answer to second/);
  worker.stop();
});

test("an error names the request that caused it, and only that one", async () => {
  const worker = await startWorker();

  worker.socket.deliver(request("A", "ask gemini", "gemini"));
  await settle();

  const errors = worker.socket.outgoing("provider.error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].requestId, "A", "so the editor can fail that request rather than all of them");
  assert.match(errors[0].message, /gemini/);
  worker.stop();
});

/* ------------------------------------------------------------------ *
 * Browser awareness
 *
 * The one thing a browser can do that an editor cannot: see its own tabs. The
 * add-on used to learn about a chat only when one *loaded*, so a browser that
 * already had two chats open when the worker woke knew about neither — and
 * since Chrome kills this worker every thirty seconds, "already open" is the
 * normal case. The user was being asked for something we could look up.
 * ------------------------------------------------------------------ */

test("chats already open are found on connect, without anything loading", async () => {
  const worker = await startWorker({ load: false });

  try {
    const status = worker.socket.outgoing("surface.status").pop();
    assert.ok(status, "the editor is told what this browser can reach");

    const ready = status.surfaces
      .filter((entry) => entry.status === "ready")
      .map((entry) => entry.id);

    assert.deepEqual(
      ready.sort(),
      ["chatgpt", "claude"],
      "both open chats, found by looking rather than by waiting",
    );
  } finally {
    worker.stop();
  }
});

test("every open chat is paired, not just the first one found", async () => {
  /*
   * The sweep used to `break` after one. A router whose whole point is choosing
   * between chats had a list of one, and the second chat looked unavailable
   * until its page happened to reload.
   */
  const worker = await startWorker();

  const status = worker.socket.outgoing("surface.status").pop();
  const ready = status.surfaces.filter((entry) => entry.status === "ready");
  assert.equal(ready.length, 2, "a choice needs more than one option in it");

  // And each is reachable by name, which is what the router does with them.
  worker.socket.deliver(request("A", "hello claude", "claude"));
  await settle();
  assert.deepEqual(worker.claude.typed, ["hello claude"]);
  assert.deepEqual(worker.chatgpt.typed, []);

  worker.claude.finish("hello back");
  await settle();
  worker.stop();
});

/* ------------------------------------------------------------------ *
 * Asking for a chat that is not there
 * ------------------------------------------------------------------ */

test("a request for an unpaired chat is refused, never answered by another one", async () => {
  /*
   * Reported from real use: Perplexity was chosen and ChatGPT answered.
   *
   * Getting one chat's opinion when you asked for another is worse than being
   * told it is not connected — you cannot tell from the answer that it came
   * from the wrong place, so you act on it.
   */
  const worker = await startWorker();

  worker.socket.deliver(request("A", "who are you", "perplexity"));
  await settle();

  assert.deepEqual(worker.chatgpt.typed, [], "ChatGPT must not answer for Perplexity");
  assert.deepEqual(worker.claude.typed, []);

  const errors = worker.socket.outgoing("provider.error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].requestId, "A");
  assert.match(errors[0].message, /perplexity/i);
  worker.stop();
});

test("choosing a chat does not make the next unnamed request go elsewhere", async () => {
  // `preferred` is set when a chat is chosen, so an unnamed request afterwards
  // has to follow the choice rather than falling back to whatever paired first.
  const worker = await startWorker();

  worker.socket.deliver({ type: "surface.open", model: "claude" });
  await settle();

  worker.socket.deliver(request("A", "no model named"));
  await settle();

  assert.deepEqual(worker.claude.typed, ["no model named"], "the chosen chat answers");
  assert.deepEqual(worker.chatgpt.typed, []);

  worker.claude.finish("done");
  await settle();
  worker.stop();
});

test("once a chat is chosen, its tab going away refuses rather than substitutes", async () => {
  /*
   * The reported bug, in the only shape that can actually produce it: an
   * unnamed request used to fall back to `ready[0]` whenever the chosen chat
   * was not ready. So choosing Perplexity and having its tab fail to pair sent
   * the question to ChatGPT — and the answer looked like an answer.
   */
  const worker = await startWorker();

  worker.socket.deliver({ type: "surface.open", model: "claude" });
  await settle();

  // Claude's tab closes, which is exactly what a user does by accident.
  for (const handler of global.chrome.__listeners.removed) {
    handler(CLAUDE_TAB);
  }
  await settle();

  worker.socket.deliver(request("A", "still meant for claude"));
  await settle();

  assert.deepEqual(worker.chatgpt.typed, [], "ChatGPT is not a stand-in for Claude");

  const errors = worker.socket.outgoing("provider.error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /claude/i);
  assert.match(errors[0].message, /nothing was sent/i, "and it says the send did not happen");
  worker.stop();
});

test("with no preference ever expressed, any ready chat may answer", async () => {
  // The single-chat setup, which must stay frictionless: nobody chose, so
  // there is nothing to contradict.
  const worker = await startWorker();

  worker.socket.deliver(request("A", "anyone"));
  await settle();

  const answered = worker.chatgpt.typed.length + worker.claude.typed.length;
  assert.equal(answered, 1, "exactly one chat takes it");

  const errors = worker.socket.outgoing("provider.error");
  assert.deepEqual(errors, [], "and it is not refused");
  worker.stop();
});

test("opening a chat that is already open adopts that tab, not a second one", async () => {
  /*
   * "Open Perplexity" while Perplexity is open in front of you should mean
   * *that* Perplexity. Only a `ready` record used to count, so a tab the add-on
   * had not probed yet — open since before the add-on was reloaded, or stale
   * because Chrome killed the worker — got a second tab opened beside it. And
   * two tabs of one chat is not harmless: pairing keys on the site, so the new
   * tab silently replaces the old and the conversation the user is looking at
   * stops being the one being driven.
   */
  const worker = await startWorker({ load: false });

  // Forget what the sweep learned, which is the state a stale record leaves.
  for (const handler of global.chrome.__listeners.removed) {
    handler(CLAUDE_TAB);
  }
  await settle();

  worker.socket.deliver({ type: "surface.open", model: "claude" });
  await settle(16);

  assert.deepEqual(global.chrome.__created, [], "no new tab was opened");

  worker.socket.deliver(request("A", "adopted", "claude"));
  await settle();
  assert.deepEqual(worker.claude.typed, ["adopted"], "and the open tab answers");

  worker.claude.finish("done");
  await settle();
  worker.stop();
});

test("opening a chat that is not open does create a tab", async () => {
  // The adoption path must not swallow the case it was added beside.
  const worker = await startWorker({ load: false });

  worker.socket.deliver({ type: "surface.open", requestId: "open_gemini", model: "gemini" });
  await settle(16);

  assert.equal(global.chrome.__created.length, 1, "gemini was not open, so open it");
  assert.match(global.chrome.__created[0], /gemini/);
  worker.stop();
});

test("replaying one open request never creates a second tab", async () => {
  /*
   * A reconnect may replay a frame while the first page is still loading. The
   * request id is the operation identity: both deliveries receive the same
   * terminal fact, while only one tab is allowed to be created.
   */
  const worker = await startWorker({ load: false });

  worker.socket.deliver({
    type: "surface.open",
    requestId: "open_perplexity_once",
    model: "perplexity",
  });
  worker.socket.deliver({
    type: "surface.open",
    requestId: "open_perplexity_once",
    model: "perplexity",
  });

  // Long enough for the open to finish: the worker polls tab status rather
  // than sleeping on an event, then waits out a settle before probing.
  await sleep(2500);
  await settle(24);

  assert.equal(global.chrome.__created.length, 1, "the operation is idempotent");
  const outcomes = worker.socket
    .outgoing("surface.opened")
    .filter((message) => message.requestId === "open_perplexity_once");
  assert.equal(outcomes.length, 2, "each delivery is acknowledged");
  assert.ok(outcomes.every((message) => message.status === "ready"));
  worker.stop();
});

test("a request refuses immediately when the chat has no tab at all", async () => {
  /*
   * The wait exists for a tab that is loading. Applying it to a chat nobody
   * opened would make every genuine "not connected" take twelve seconds to
   * say, which is worse than saying it at once.
   */
  const worker = await startWorker();
  const started = Date.now();

  worker.socket.deliver(request("A", "hello", "gemini"));
  await settle(20);

  const errors = worker.socket.outgoing("provider.error");
  assert.equal(errors.length, 1, "refused");
  assert.ok(Date.now() - started < 3000, "and refused promptly");
  worker.stop();
});

test("a question asked while a chat is still opening waits for it", async () => {
  /*
   * The real sequence that failed: pick Perplexity, which opens a tab, then
   * type a question — because typing takes less time than a page load. The
   * request arrived first and was refused as "not connected", which was true
   * for another two seconds and useless as advice.
   */
  const worker = await startWorker();

  // Perplexity is not open at all, which is why picking it opens a tab.
  worker.socket.deliver({ type: "surface.open", model: "perplexity" });

  // And the question is asked immediately, before that tab can have loaded.
  worker.socket.deliver(request("A", "for perplexity", "perplexity"));

  // Wall clock, not microtasks: the open path waits on a real page load.
  await sleep(2500);
  await settle(24);

  const opened = worker.tabs.get(901);
  assert.ok(opened, "a perplexity tab was opened");
  assert.deepEqual(opened.typed, ["for perplexity"], "it waited, then delivered");
  assert.deepEqual(worker.socket.outgoing("provider.error"), []);

  opened.finish("an answer");
  await settle();
  worker.stop();
});

test("a tab that never answers is reported, not passed off as connected", async () => {
  /*
   * The hole this closes. Pairing returned silently when a page did not answer,
   * so opening a chat could fail while reporting nothing — and the only thing
   * the user ever saw was a generic "not connected" from the next request. Three
   * rounds of guessing came out of that single missing sentence.
   */
  const worker = await startWorker();

  // A tab that opens and then refuses to answer a probe, as a page still
  // bootstrapping does.
  const silent = { handle: async () => ({ type: "failed", reason: "no content script" }) };
  const realCreate = global.chrome.tabs.create;
  global.chrome.tabs.create = async ({ url }) => {
    const id = 950;
    worker.tabs.set(id, { ...silent, tabId: id, surfaceType: "gemini", typed: [] });
    setTimeout(() => {
      for (const handler of global.chrome.__listeners.updated) {
        handler(id, { status: "complete" }, { id, url });
      }
    }, 10);
    return { id };
  };

  worker.socket.deliver({
    type: "surface.open",
    requestId: "open_silent",
    model: "gemini",
  });
  await sleep(9000);
  await settle(24);

  global.chrome.tabs.create = realCreate;

  const outcomes = worker.socket.outgoing("surface.opened");
  assert.equal(outcomes.length, 1, "the open operation always terminates");
  assert.equal(outcomes[0].requestId, "open_silent", "the result belongs to this pick");
  assert.equal(outcomes[0].status, "failed");
  assert.match(outcomes[0].detail, /could not pair/i);
  assert.match(outcomes[0].detail, /Gemini/i, "and names the chat it was trying to open");
  worker.stop();
});

test("a browser policy is remembered as blocked, never selected as ready", async () => {
  const worker = await startWorker();

  const policy = {
    handle: async () => ({
      type: "failed",
      reason: "This page cannot be scripted due to an ExtensionsSettings policy.",
    }),
  };
  const realCreate = global.chrome.tabs.create;
  global.chrome.tabs.create = async ({ url }) => {
    const id = 951;
    worker.tabs.set(id, { ...policy, tabId: id, surfaceType: "deepseek", typed: [] });
    setTimeout(() => {
      for (const handler of global.chrome.__listeners.updated) {
        handler(id, { status: "complete" }, { id, url });
      }
    }, 10);
    return { id };
  };

  worker.socket.deliver({
    type: "surface.open",
    requestId: "open_policy",
    model: "deepseek",
  });
  await sleep(9000);
  await settle(24);

  global.chrome.tabs.create = realCreate;

  const outcome = worker.socket
    .outgoing("surface.opened")
    .find((message) => message.requestId === "open_policy");
  assert.equal(outcome.status, "blocked");
  assert.match(outcome.detail, /browser blocks add-ons/i);
  assert.match(outcome.detail, /clipboard route/i, "it names a route that works in this browser");
  assert.match(outcome.detail, /signed store build/i, "and names what full automation needs");

  const status = worker.socket.outgoing("surface.status").pop();
  const deepseek = status.surfaces.find((entry) => entry.id === "deepseek");
  assert.equal(deepseek.status, "blocked", "the router remembers the terminal reason");
  assert.equal(
    status.surfaces.some((entry) => entry.id === "deepseek" && entry.status === "ready"),
    false,
    "blocked is never papered over as connected",
  );
  worker.stop();
});

/* ------------------------------------------------------------------ *
 * Coming back after the editor restarts
 * ------------------------------------------------------------------ */

test("a refused connection keeps retrying; only a rejection gives up", async () => {
  /*
   * The editor restarting its relay refuses connections for a second or two,
   * which is normal. That refusal used to be recorded as the same state as a
   * rejected token — and the backoff refused to run in that state, so one
   * ERR_CONNECTION_REFUSED disabled reconnection until the thirty-second alarm
   * happened to call connect directly. Most of "it keeps disconnecting" was
   * that: it disconnected once, normally, and nothing tried again.
   */
  const worker = await startWorker();
  const before = FakeSocket.last;

  // The relay goes away mid-restart: an error, then a close.
  before.emit("error", {});
  before.close();
  await settle();

  // A new socket must have been scheduled. The backoff is a second, so this
  // waits in real time rather than pretending.
  await sleep(1600);
  await settle(16);

  assert.notEqual(FakeSocket.last, before, "it tried again on its own");

  FakeSocket.last.open();
  FakeSocket.last.deliver({
    type: "adapter.welcome",
    connectionId: "conn_again",
    protocolVersion: 1,
    sessionTokenAccepted: true,
    peers: ["editor"],
  });
  await settle(16);

  // And it is usable again without anything being re-paired by hand.
  const status = FakeSocket.last.outgoing("surface.status").pop();
  assert.ok(status, "and reports itself once back");
  worker.stop();
});

test("a rejected token stops the retries", async () => {
  const worker = await startWorker();
  const before = FakeSocket.last;

  before.deliver({
    type: "adapter.rejected",
    reason: "bad-version",
    message: "This relay speaks a different protocol.",
  });
  await settle();
  before.close();
  await settle();

  await sleep(1600);
  await settle(16);

  assert.equal(FakeSocket.last, before, "retrying a refusal that cannot succeed is just noise");
  worker.stop();
});
