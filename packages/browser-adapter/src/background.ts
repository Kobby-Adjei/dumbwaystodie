import {
  createEnvelope,
  createId,
  parseEnvelope,
  parseWireMessage,
  PROTOCOL_VERSION,
  renderChatBlock,
  extractChatBlocks,
  type CoachRequest,
  type WireMessage,
} from "@dumbways/protocol";

import type {
  ContentToWorker,
  PairingRecord,
  PopupToWorker,
  RelayCredentials,
  WorkerStatus,
} from "./shared/messages";
import type { SurfaceState } from "./surfaces/ChatSurfaceAdapter";
import { ADDON_BUILD } from "./shared/messages";
import { describeOrigins, isChatUrl, summarizeSurface } from "./shared/pairing";
import { CHAT_SITES, matchPatternsForKnownSites, siteFor } from "./surfaces/sites";

/**
 * The service worker: the extension's connection to the relay.
 *
 * It holds no site knowledge — it routes between the relay and whichever tab
 * the user paired. All page-specific behaviour lives in the content script's
 * surface adapter, so a site redesign touches one file (spec §0G).
 */

let socket: WebSocket | undefined;
let credentials: RelayCredentials | undefined;
/*
 * Every chat this browser can reach, keyed by surface type.
 *
 * Keyed by site rather than by tab: "the Claude tab" is the useful identity,
 * and a second Claude tab replacing the first is what a user means by opening
 * a new conversation. The editor only ever sees these ids, so tab bookkeeping
 * stays entirely on this side.
 */
const pairings = new Map<string, PairingRecord>();

/** The one a request goes to when it does not name a model. */
let preferred: string | undefined;
let relayState: WorkerStatus["relay"] = "disconnected";
let relayDetail: string | undefined;
let surface: SurfaceState | undefined;
/**
 * One record per request in flight, keyed by request id.
 *
 * These were three module globals — the pending request id, the chat it went
 * to, and the tool batch — which is safe only while exactly one request exists
 * at a time. The panel enforces that, but `/v1/chat/completions` accepts
 * concurrent HTTP callers, so request B could overwrite A's state and A's
 * progress would then be labelled with B's id and B's surface: the relay
 * accepts it as a legitimate partial for B, and A waits until it times out.
 *
 * An `observationId` distinguishes two turns on the *same* tab, so a progress
 * frame from an abandoned observation cannot be mistaken for the current one.
 */
interface Operation {
  requestId: string;
  tabId: number;
  surfaceType: string;
  observationId: string;
  batch?: ToolBatch;
  /** Resolves when the turn is over — including every tool round trip. */
  settled: Promise<void>;
  settle: () => void;
}

const operations = new Map<string, Operation>();

/**
 * The last thing queued for each tab, so work on one chat runs in order.
 *
 * A turn is not one message: a reply asking for two files becomes type, read,
 * type again, read again — all in one composer. Two requests sharing a tab
 * without this would interleave their typing there, and each would read a
 * transcript containing the other's question.
 *
 * Per *tab*, not global: Claude and ChatGPT are different windows and have no
 * reason to wait for each other.
 */
const tabQueues = new Map<number, Promise<unknown>>();

/**
 * A backstop on how long one turn may hold its tab.
 *
 * Every step already has its own timeout, so reaching this means one of them
 * failed to fire. Without it that tab would be wedged for the rest of the
 * browser session with no way back short of unpairing.
 *
 * Ten minutes was far too generous. The editor abandons a request after sixty
 * seconds, so a wedged operation held the tab long after anyone was waiting for
 * it — and every question asked in the meantime queued behind a turn that was
 * already dead, producing "No response after 60s" for reasons that had nothing
 * to do with the chat. Two and a half minutes leaves room for a tool call that
 * waits on a person while keeping a stuck turn from outliving the interest in
 * its answer by much.
 */
const OPERATION_CEILING_MS = 150_000;

function queueForTab<T>(tabId: number, work: () => Promise<T>): Promise<T> {
  const previous = tabQueues.get(tabId) ?? Promise.resolve();
  // Failures do not poison the queue: the next turn on this tab still runs.
  const next = previous.catch(() => undefined).then(work);
  tabQueues.set(tabId, next.catch(() => undefined));
  return next;
}

/** Which operation a given tab is currently observing for. */
function operationForTab(tabId: number): Operation | undefined {
  return [...operations.values()].find((operation) => operation.tabId === tabId);
}

/** Which operation owns a tool call id. */
function operationForCall(callId: string): Operation | undefined {
  return [...operations.values()].find((operation) => operation.batch?.expected.has(callId));
}

const SESSION_ID = "browser";

/*
 * Derived from the site table, which the manifest is also generated from, so
 * these cannot drift apart. A hard-coded copy here is how "supported on paper,
 * silently ignored at runtime" happens.
 */
const CHAT_ORIGINS = matchPatternsForKnownSites();

/* ------------------------------------------------------------------ *
 * Persistence — a pairing should survive the worker being unloaded.
 * ------------------------------------------------------------------ */

async function loadState(): Promise<void> {
  const stored = await chrome.storage.local.get(["credentials", "pairings"]);
  credentials = stored["credentials"] as RelayCredentials | undefined;

  const saved = (stored["pairings"] as PairingRecord[] | undefined) ?? [];
  pairings.clear();

  // Spec §0J: a tab id does not survive a browser restart, so a restored
  // pairing is a claim to verify, never a fact to act on.
  for (const record of saved) {
    const alive = await tabExists(record.tabId);
    pairings.set(record.surfaceType, alive ? record : { ...record, status: "lost" });
  }

  preferred = [...pairings.values()].find((record) => record.status === "ready")?.surfaceType;
  await savePairings();
}

async function savePairings(): Promise<void> {
  await chrome.storage.local.set({ pairings: [...pairings.values()] });
}

/**
 * The chat that should answer, given what a request asked for.
 *
 * A named model that is not paired is refused rather than quietly answered by
 * a different one: getting Gemini's opinion when you asked Claude is worse
 * than being told Claude is not connected.
 *
 * The same rule now covers a request that names nothing. It used to fall back
 * to `ready[0]` whenever the chosen chat was not ready — so choosing Perplexity
 * and having its tab fail to pair meant ChatGPT answered, with nothing anywhere
 * saying so. "Any ready chat" is only a safe reading of silence when the user
 * has never expressed a preference; once they have, silence means *that* one.
 */
function routeTo(model?: string): PairingRecord | undefined {
  const ready = [...pairings.values()].filter((record) => record.status === "ready");

  const wanted = model ?? preferred;

  if (wanted) {
    return ready.find(
      (record) => record.surfaceType === wanted || record.pairingId === wanted,
    );
  }

  return ready[0];
}

/**
 * How long a request waits for the chat it named to become ready.
 *
 * Long enough for a chat page to load on a normal connection, short enough that
 * a genuinely absent chat is reported while the user still remembers asking.
 */
const SURFACE_WAIT_MS = 12_000;

/**
 * Chats we are in the middle of opening, and until when.
 *
 * This is the honest answer to "is it worth waiting?". The first version asked
 * whether a tab's *address* looked like the wanted site — deciding from a URL
 * something the page itself reports when probed, which is the same mistake this
 * file has made twice now. What we actually know is whether *we* started
 * opening that chat, and that is a fact, not an inference.
 */
const opening = new Map<string, number>();

interface SurfaceOpenOutcome {
  status: "ready" | "blocked" | "failed";
  detail?: string;
}

/*
 * `surface.open` is idempotent by request id.
 *
 * The relay may reconnect while a page is loading.  Replaying the request must
 * return the same terminal result, not create a second tab beside the first.
 * In-flight promises cover duplicate delivery; the small completed cache
 * covers a replay after the operation has settled.
 */
const surfaceOpenJobs = new Map<string, Promise<SurfaceOpenOutcome>>();
const surfaceOpenResults = new Map<string, SurfaceOpenOutcome>();
const MAX_SURFACE_OPEN_RESULTS = 64;

/**
 * Resolves once the wanted chat is ready, or gives up.
 *
 * Only waits while something is on its way. Waiting twelve seconds to tell
 * someone that a chat they never opened is not connected would be worse than
 * saying so at once.
 */
async function waitForSurface(model?: string): Promise<PairingRecord | undefined> {
  const immediate = routeTo(model);
  if (immediate) {
    return immediate;
  }

  const wanted = model ?? preferred;
  const until = wanted ? opening.get(wanted) : undefined;
  if (!wanted || until === undefined) {
    return undefined;
  }

  const deadline = Math.min(until, Date.now() + SURFACE_WAIT_MS);

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));

    // A tab that finished loading pairs itself; this picks that up.
    await sweepOpenChats();
    const ready = routeTo(model);
    if (ready) {
      return ready;
    }
  }

  return undefined;
}

async function tabExists(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Relay connection
 * ------------------------------------------------------------------ */

/**
 * Reconnection, and the reason this file needs any.
 *
 * A Manifest V3 service worker is killed after ~30s idle and restarted on the
 * next event, taking the WebSocket with it. So the connection is not something
 * established once at startup — it is something continuously re-established,
 * and the add-on has to treat a closed socket as normal rather than as a
 * failure to report and forget.
 */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15_000;
const KEEPALIVE_MS = 20_000;

/** Enough retries to ride out a restart, few enough to notice a move. */
const STALE_AFTER_ATTEMPTS = 6;

let reconnectAttempts = 0;

/**
 * Whether reconnecting is pointless, as opposed to merely failing.
 *
 * These were the same thing, and they are not. A rejected token is final —
 * retrying it cannot help. A refused connection is the *normal* state of a
 * relay that is restarting, which happens every time the editor reloads.
 *
 * Both used to land in `relayState = "error"`, and `scheduleReconnect` refused
 * to run in that state — so one `ERR_CONNECTION_REFUSED` during a restart
 * disabled the backoff entirely, and the only thing that ever brought the
 * bridge back was the thirty-second alarm calling `connect` directly. That is
 * most of what "it keeps disconnecting" actually was: it disconnected once,
 * normally, and then nothing tried again for half a minute.
 */
let fatal = false;

/**
 * Drops stored details so discovery can run again.
 *
 * Discovery deliberately does nothing while credentials exist — otherwise it
 * would poll constantly on a healthy add-on — which means credentials that no
 * longer work have to be actively cleared or they block their own repair.
 */
async function forgetCredentials(why: string): Promise<void> {
  credentials = undefined;
  reconnectAttempts = 0;
  // New details mean the old refusal no longer applies.
  fatal = false;
  await chrome.storage.local.remove("credentials");
  setRelay("disconnected", `${why} Looking for it again…`);
}
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let keepaliveTimer: ReturnType<typeof setInterval> | undefined;

function scheduleReconnect(): void {
  // Only a rejection is final. A refusal is a relay that has not come up yet.
  if (fatal || !credentials || reconnectTimer) {
    return;
  }

  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
  reconnectAttempts += 1;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;

    /*
     * Persistent refusal means the address is wrong, not busy.
     *
     * A relay that moved port, or one that was replaced, will refuse forever
     * — and retrying the same dead address forever is what "it keeps
     * disconnecting" looks like from the outside. After a handful of tries,
     * throw the details away and go looking again.
     */
    if (reconnectAttempts > STALE_AFTER_ATTEMPTS) {
      void forgetCredentials("Could not reach the editor at the stored address.").then(() =>
        discover(),
      );
      return;
    }

    connect();
  }, delay);
}

/**
 * Traffic on a schedule, doing two jobs at once.
 *
 * Chrome resets the worker's idle timer on WebSocket activity, so a ping
 * inside the timeout keeps the worker — and therefore the connection — alive.
 * It also proves the relay is still there, rather than waiting to discover it
 * at the moment the user sends a message.
 */
function startKeepalive(): void {
  stopKeepalive();
  keepaliveTimer = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) {
      send({ type: "ping", sentAt: new Date().toISOString() });
    } else if (credentials) {
      connect();
    } else {
      void discover();
    }
  }, KEEPALIVE_MS);
}

function stopKeepalive(): void {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = undefined;
  }
}

/**
 * Finds the editor without the user carrying anything between two windows.
 *
 * Setup used to be: copy a folder path, load an unpacked add-on, come back,
 * copy a connection line, paste it here. Two clipboards, eight steps, and the
 * step people got wrong every time. Now the editor opens a short window and
 * this asks for the details directly.
 *
 * Only tried while unpaired, so a working add-on never polls.
 */
async function discover(): Promise<boolean> {
  if (credentials) {
    return true;
  }

  for (const port of [DEFAULT_PORT, 43124, 43125]) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/pair`, { cache: "no-store" });
      if (!response.ok) {
        continue;
      }
      const found = (await response.json()) as RelayCredentials & { ok?: boolean };
      if (typeof found?.token !== "string" || typeof found?.port !== "number") {
        continue;
      }
      credentials = { host: found.host ?? "127.0.0.1", port: found.port, token: found.token };
      await chrome.storage.local.set({ credentials });
      connect();
      return true;
    } catch {
      // Nothing listening on that port; try the next.
    }
  }

  return false;
}

const DEFAULT_PORT = 43123;

function connect(): void {
  if (!credentials) {
    setRelay("disconnected", "No relay details yet.");
    return;
  }
  if (socket && socket.readyState <= WebSocket.OPEN) {
    return;
  }

  setRelay("connecting");
  const url = `ws://${credentials.host}:${credentials.port}/transport`;
  const next = new WebSocket(url);
  socket = next;

  next.addEventListener("open", () => {
    next.send(
      JSON.stringify(
        createEnvelope(SESSION_ID, {
          type: "adapter.hello",
          adapterKind: "browser",
          adapterId: createId("browser"),
          protocolVersion: PROTOCOL_VERSION,
          token: credentials?.token ?? "",
          capabilities: ["chat.send_text", "chat.receive_response"],
        }),
      ),
    );
  });

  next.addEventListener("message", (event) => {
    let message: WireMessage | undefined;
    try {
      message = parseWireMessage(parseEnvelope(JSON.parse(String(event.data))).payload);
    } catch {
      return;
    }
    if (message) {
      void handleWire(message);
    }
  });

  next.addEventListener("close", () => {
    if (relayState !== "error") {
      setRelay("disconnected");
    }
    socket = undefined;
    // A dropped socket used to stay dropped until the user opened the popup,
    // which is what "it keeps disconnecting" actually was: it disconnected
    // once, normally, and then nothing ever tried again.
    scheduleReconnect();
  });

  next.addEventListener("error", () => {
    /*
     * Reported as a state to retry from, not an error to stop at. The editor
     * restarting its relay looks exactly like this, and it is over in a second.
     */
    setRelay("connecting", "Waiting for the editor's relay to come back…");
  });
}

async function handleWire(message: WireMessage): Promise<void> {
  switch (message.type) {
    case "adapter.welcome":
      setRelay("connected");
      fatal = false;
      // A successful connection is what clears the backoff; clearing it on
      // "socket opened" would reset it on a relay that accepts and then
      // immediately rejects, and hammer it.
      reconnectAttempts = 0;
      startKeepalive();

      /*
       * Look before reporting.
       *
       * The editor has just learned a browser exists; what it needs next is
       * which chats that browser can reach. Sweeping first means the very
       * first status it sees is the real list, rather than "nothing paired"
       * followed by a correction a page-load later.
       */
      void sweepOpenChats().then(() => reportSurface());
      return;

    case "adapter.rejected":
      /*
       * A rejected token almost always means the relay restarted.
       *
       * Every relay start mints a new token, so credentials stored from a
       * previous run are simply out of date. Treating that as final left the
       * add-on permanently broken: reconnect refused because the state was
       * "error", and discovery refused because credentials existed. Nothing
       * short of clearing browser storage by hand could recover it.
       */
      setRelay("error", message.message);

      /*
       * Decided *before* closing, because closing is what triggers the retry.
       *
       * `close()` fires its handler synchronously, which calls the scheduler —
       * so setting the flag afterwards left a window where a rejection we had
       * already judged final was retried anyway.
       */
      fatal = message.reason !== "bad-token";
      socket?.close();

      if (message.reason === "bad-token") {
        await forgetCredentials("The editor restarted, so its token changed.");
        void discover();
      }
      return;

    case "surface.models": {
      /*
       * Reading a menu needs a paired tab, so this answers rather than staying
       * silent when there is none — an unanswered query leaves the editor's
       * picker spinning with nothing to show and no reason why.
       */
      const record = pairings.get(message.model);
      if (!record || record.status !== "ready") {
        send({
          type: "surface.models.list",
          requestId: message.requestId,
          model: message.model,
          models: [],
          detail: `${message.model} is not connected, so its model menu cannot be read.`,
        });
        return;
      }

      const found = (await askTab(record.tabId, { type: "list-models" })) as ContentToWorker;
      const models = found.type === "models" ? found.models : [];
      const why = found.type === "models" ? found.reason : "The page did not answer.";
      trace("models.listed", { model: message.model, count: models.length });

      send({
        type: "surface.models.list",
        requestId: message.requestId,
        model: message.model,
        models,
        ...(models.length === 0 && why ? { detail: why } : {}),
      });
      return;
    }

    case "surface.open":
      await acknowledgeSurfaceOpen(message);
      return;

    case "coach.request":
      await handleRequest(message.request);
      return;

    case "tool.result":
      // Held until the rest of its batch arrives, then typed as one message.
      collectResult(message.id, {
        ok: message.ok,
        body: message.ok ? message.result : undefined,
        ...(message.error ? { error: message.error } : {}),
      });
      return;

    default:
      return;
  }
}

/* ------------------------------------------------------------------ *
 * The loop
 * ------------------------------------------------------------------ */

async function handleRequest(request: CoachRequest): Promise<void> {
  trace("request.received", {
    id: request.id,
    model: request.model ?? "-",
    preferred: preferred ?? "-",
    ready: [...pairings.values()].filter((r) => r.status === "ready").map((r) => r.surfaceType).join(",") || "none",
  });

  /*
   * Wait a moment for a chat that is on its way.
   *
   * Choosing a chat opens a tab, which takes seconds; typing a question takes
   * less. So the ordinary sequence — pick Perplexity, ask something — arrived
   * here before the tab had finished loading and was refused as "not
   * connected", which is true for another two seconds and useless as advice.
   * A request is worth holding briefly; a refusal is only worth giving once
   * waiting cannot help.
   */
  const target = (await waitForSurface(request.model)) ?? routeTo(request.model);

  if (!target) {
    const wanted = request.model ?? preferred;
    trace("request.no-surface", { wanted: wanted ?? "-", opening: [...opening.keys()].join(",") || "none" });
    reportError(
      wanted
        ? `${wanted} is not connected, so nothing was sent. Its tab may have closed — open it, or pick another chat in the editor.`
        : "No chat is paired. Open your chat tab and pair it.",
      request.id,
    );
    return;
  }

  let settle = (): void => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const operation: Operation = {
    requestId: request.id,
    tabId: target.tabId,
    surfaceType: target.surfaceType,
    observationId: createId("obs"),
    settled,
    settle,
  };

  await queueForTab(target.tabId, async () => {
    operations.set(operation.requestId, operation);
    const ceiling = setTimeout(() => {
      console.warn(`[dwtd] giving up on ${operation.requestId} — it held ${operation.surfaceType} too long`);
      reportError("That turn never finished. Try again.", operation.requestId);
      operation.settle();
    }, OPERATION_CEILING_MS);

    try {
      // The editor renders the payload — context, and the protocol primer on the
      // first message of a session — so this types it verbatim. Reformatting here
      // would put site knowledge in the one place that must not have any.
      await sendToChat(operation, request.rendered ?? request.message);

      /*
       * A reply that asked for tools is not the end of the turn — the results
       * go back into this same chat. Holding the tab until then is what keeps
       * a tool loop from being cut in half by the next request.
       */
      if (!operation.batch) {
        operation.settle();
      }
      await operation.settled;
    } finally {
      clearTimeout(ceiling);
      // A stale record would let a late frame masquerade as a live one.
      operations.delete(operation.requestId);
    }
  });
}

async function sendToChat(operation: Operation, text: string): Promise<void> {
  const delivered = (await askTab(operation.tabId, { type: "deliver", text })) as ContentToWorker;

  if (delivered.type !== "delivered" || !delivered.sent) {
    // Spec §0O: fail clearly rather than adding bypass logic. The editor's
    // clipboard path is the fallback, and the user is told to use it.
    const reason =
      delivered.type === "delivered"
        ? delivered.reason ?? "Could not send it."
        : "Could not reach the chat page.";
    // The reason already says where the message is; repeating "paste it
    // yourself" on top of "it is in the box" was advice that contradicted it.
    reportError(reason, operation.requestId);
    return;
  }

  /*
   * The observation carries its own identity, so a progress frame from a
   * previous turn on this same tab cannot be attributed to this one.
   */
  const observed = (await askTab(operation.tabId, {
    type: "observe",
    requestId: operation.requestId,
    observationId: operation.observationId,
  })) as ContentToWorker;

  if (observed.type !== "observed") {
    reportError(
      "Sent it, but could not read the reply. Copy it and use Bring reply back.",
      operation.requestId,
    );
    return;
  }

  deliverReply(operation, observed.text);
}

/**
 * A batch of tool calls from one reply, and the results as they come back.
 *
 * The point of asking for several things at once is that they cost *one*
 * round trip. Typing each result into the chat as it arrives would spend a
 * round trip per call and make batching pointless — so results are held here
 * until the set is complete, then delivered as a single message.
 */
interface ToolResult {
  ok: boolean;
  body: unknown;
  error?: { code: string; message: string };
}

/**
 * A call, under both of its names.
 *
 * The chat chose `chatId` when it wrote the request; the relay needs a `wireId`
 * it can guarantee unique across the session. The result must come back
 * labelled with the chat's own id — a reply that asked for three files and gets
 * three results under ids it has never seen cannot tell which is which.
 */
interface BatchedCall {
  wireId: string;
  chatId: string;
}

interface ToolBatch {
  expected: Set<string>;
  results: Map<string, ToolResult>;
  order: BatchedCall[];
  /** Fires if a result never arrives, so a batch cannot wait forever. */
  deadline: ReturnType<typeof setTimeout>;
}

/**
 * How long a batch waits before giving up on a missing result.
 *
 * Generous, because `shell.run` waits on a human. But finite: ids were added
 * to `expected` before delivery was known, so a send that failed left the
 * batch waiting for a result that was never coming, with nothing to time it
 * out. The turn simply stopped.
 */
const BATCH_DEADLINE_MS = 200_000;

/** More than this in one reply is a model in a loop, not a plan. */
const MAX_BATCH = 6;

function deliverReply(operation: Operation, text: string): void {
  const { prose, blocks } = extractChatBlocks(text);
  const calls = blocks.filter(
    (block): block is Extract<typeof block, { type: "tool.call" }> => block.type === "tool.call",
  );

  if (calls.length > 0) {
    /*
     * Every call, not just the first.
     *
     * This used to be `blocks.find(...)`: a chat that asked for three things
     * had two silently dropped, then waited for results that were never
     * coming. Silent discard is the worst possible failure here because the
     * chat has no way to notice it happened.
     */
    const accepted = calls.slice(0, MAX_BATCH);

    const batch: ToolBatch = {
      expected: new Set(),
      results: new Map(),
      order: [],
      deadline: setTimeout(() => finishBatch(operation, true), BATCH_DEADLINE_MS),
    };
    operation.batch = batch;

    for (const call of accepted) {
      const wireId = createId("tool");
      batch.expected.add(wireId);
      batch.order.push({ wireId, chatId: call.id });
      send({
        type: "tool.call",
        id: wireId,
        sessionId: SESSION_ID,
        requestId: operation.requestId,
        tool: call.tool,
        arguments: call.args ?? {},
      });
    }

    if (calls.length > accepted.length) {
      relayDetail = `Ignored ${calls.length - accepted.length} extra tool calls in one reply.`;
    }
    return;
  }

  send({
    type: "coach.response",
    response: {
      id: createId("res"),
      requestId: operation.requestId,
      sessionId: SESSION_ID,
      createdAt: new Date().toISOString(),
      content: [{ type: "text", text: prose || text }],
      source: { adapterKind: "browser", surfaceType: operation.surfaceType },
      completion: { state: "complete" },
    },
  });
}

/**
 * Records one result and, once the whole batch is in, types it as one message.
 *
 * A result names its call, and a call belongs to exactly one operation, so the
 * owner is *looked up* rather than assumed to be "the current one". A result
 * for a batch that has already been finished — by its deadline, or by an
 * earlier reconnect — matches nothing and is dropped: typing it would
 * interrupt a conversation that has moved on, and typing it into whichever
 * chat happens to be current would put one chat's answer in another's window.
 */
function collectResult(id: string, result: ToolResult): boolean {
  const operation = operationForCall(id);
  const batch = operation?.batch;

  if (!operation || !batch) {
    console.warn(`[dwtd] dropping a tool result for an unknown call: ${id}`);
    return false;
  }

  batch.results.set(id, result);
  if (batch.results.size < batch.expected.size) {
    return true;
  }

  finishBatch(operation, false);
  return true;
}

/**
 * Sends a finished batch back to the chat that asked for it.
 *
 * `timedOut` distinguishes the two ways a batch ends. On a timeout the missing
 * calls get a synthesised error rather than being silently omitted: a chat
 * that asked for three things and is shown two will assume the third
 * succeeded, which is a worse outcome than being told it failed.
 */
function finishBatch(operation: Operation, timedOut: boolean): void {
  const batch = operation.batch;
  if (!batch) {
    return;
  }

  clearTimeout(batch.deadline);
  operation.batch = undefined;

  const rendered = batch.order.map((call) => {
    const result = batch.results.get(call.wireId);

    if (!result) {
      return renderChatBlock({
        v: 1,
        type: "tool.result",
        id: call.chatId,
        ok: false,
        error: { code: "timeout", message: "The editor did not answer in time." },
      });
    }

    return renderChatBlock({
      v: 1,
      type: "tool.result",
      id: call.chatId,
      ok: result.ok,
      ...(result.ok ? { result: result.body } : {}),
      // Why it failed, so the chat can adapt instead of retrying blindly.
      ...(result.error ? { error: result.error } : {}),
    });
  });

  const preface =
    rendered.length === 1
      ? "Here is what my editor said:"
      : `Here is what my editor said for all ${rendered.length}:`;

  if (timedOut) {
    console.warn(`[dwtd] batch for ${operation.requestId} timed out`);
  }

  /*
   * A fresh observation for the follow-up turn. Reusing the old id would let a
   * straggling progress frame from the previous reply be forwarded as part of
   * this one.
   */
  operation.observationId = createId("obs");

  void sendToChat(operation, `${preface}\n\n${rendered.join("\n\n")}`).finally(() => {
    // Another batch means the chat asked for more; the turn continues.
    if (!operation.batch) {
      operation.settle();
    }
  });
}

/**
 * Reports a step to the relay, which keeps it where a human can read it.
 *
 * A Manifest V3 service worker's console lives behind a devtools window nobody
 * finds, so everything this file does has been invisible from the outside —
 * which is why "Perplexity is not connected" took several rounds to even locate,
 * let alone fix. The relay is already listening; telling it what happened costs
 * one message and turns a guess into a lookup.
 *
 * Steps only: which stage, for which chat, and how it went. Never message text.
 */
function trace(step: string, detail?: Record<string, unknown>): void {
  const parts = Object.entries(detail ?? {}).map(([key, value]) => `${key}=${String(value)}`);
  send({
    type: "provider.status",
    status: "ready",
    message: `trace ${step}${parts.length > 0 ? " " + parts.join(" ") : ""}`,
  });
  console.info(`[dwtd] ${step}`, detail ?? "");
}

/** An error belongs to the request that caused it, never to whatever is current. */
function reportError(message: string, requestId?: string): void {
  send({ type: "provider.error", message, ...(requestId ? { requestId } : {}) });
}

function send(message: WireMessage): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(createEnvelope(SESSION_ID, message)));
  }
}

/**
 * Talks to a tab, putting the current content script there first if needed.
 *
 * A content script is injected when the page loads, so reloading the add-on
 * *orphans* the copy already running in an open tab rather than replacing it —
 * which is why "reload the tab" kept being a required step, and why an
 * orphaned script's dead message channel produced undefined replies.
 *
 * Injecting on demand removes the step: `executeScript` pushes the code that
 * is on disk right now. It is safe to call repeatedly — the script guards its
 * own listener registration — and it is the same permission the manifest
 * already grants for these origins.
 */
async function askTab(tabId: number, message: unknown): Promise<unknown> {
  const first = await ask(tabId, message);
  if ((first as { type?: string })?.type !== "failed") {
    return first;
  }

  const injected = await injectInto(tabId);
  if (!injected.ok) {
    return { type: "failed", reason: injected.reason ?? (first as { reason?: string }).reason };
  }

  // A navigation can finish before the document's isolated world is ready.
  // Give the newly injected listener one turn to register, then make a small
  // bounded retry rather than reporting a healthy tab as unpaired.
  let last = first;
  for (const wait of [0, 80, 180]) {
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    last = await ask(tabId, message);
    if ((last as { type?: string })?.type !== "failed") {
      return last;
    }
  }
  return last;
}

function ask(tabId: number, message: unknown): Promise<unknown> {
  /*
   * Three ways this does not give back a message, all of them normal:
   * the tab has no content script (rejects), the listener returned without
   * responding (resolves undefined), or the page navigated mid-call (either).
   *
   * Every caller reads `.type` off the result, so returning undefined here
   * throws inside a promise nobody is catching — which is exactly the
   * "Cannot read properties of undefined" that surfaced. A failure is a
   * message like any other.
   */
  const failed = (reason: string) => ({ type: "failed", reason });
  return chrome.tabs
    .sendMessage(tabId, message)
    .then((reply: unknown) => reply ?? failed("The paired tab did not answer."))
    .catch((error: unknown) =>
      failed(error instanceof Error && error.message ? error.message : "The paired tab did not answer."),
    );
}

/**
 * Tells the editor what this browser is paired to.
 *
 * Called whenever pairing changes, and once on connect: the editor's panel
 * cannot infer this from the socket being open, and a hop that never updates
 * is worse than one that is absent.
 */
function reportSurface(): void {
  const surfaces = [...pairings.values()].map((record) => ({
    id: record.surfaceType,
    surfaceType: record.surfaceType,
    label: record.label ?? record.surfaceType,
    status: record.status,
    ...(record.detail ? { detail: record.detail } : {}),
  }));

  const ready = surfaces.filter((entry) => entry.status === "ready");

  send({
    type: "surface.status",
    build: ADDON_BUILD,
    paired: ready.length > 0,
    ...(ready[0] ? { surfaceType: ready[0].surfaceType } : {}),
    ...(surface ? { detail: summarizeSurface(surface) } : {}),
    surfaces,
  });
}

/** Opens once and always sends one terminal acknowledgement. */
async function acknowledgeSurfaceOpen(
  message: Extract<WireMessage, { type: "surface.open" }>,
): Promise<void> {
  const requestId =
    typeof message.requestId === "string" && message.requestId.length > 0
      ? message.requestId
      : createId("surface_open");

  let outcome = surfaceOpenResults.get(requestId);
  if (!outcome) {
    let job = surfaceOpenJobs.get(requestId);
    if (!job) {
      job = openSurface(message.model, message.url, message.variant);
      surfaceOpenJobs.set(requestId, job);
    }

    try {
      outcome = await job;
    } finally {
      surfaceOpenJobs.delete(requestId);
    }

    surfaceOpenResults.set(requestId, outcome);
    while (surfaceOpenResults.size > MAX_SURFACE_OPEN_RESULTS) {
      const oldest = surfaceOpenResults.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      surfaceOpenResults.delete(oldest);
    }
  }

  send({
    type: "surface.opened",
    requestId,
    model: message.model,
    status: outcome.status,
    ...(outcome.detail ? { detail: outcome.detail } : {}),
  });
}

/**
 * Makes a chat exist, without the user arranging anything.
 *
 * Picking a model in the editor should be one click. If that chat is already
 * paired the tab is simply focused; otherwise the site is opened in a new tab
 * on its own new-conversation URL and paired as soon as it finishes loading.
 *
 * The tab is opened in the background on purpose: the user asked a question in
 * their editor, so yanking their attention into a browser window would be the
 * opposite of the point.
 */
/**
 * Switches the model inside a chat we have just paired.
 *
 * Folded into the open rather than given its own operation: "open Claude, on
 * Opus" is one intention. A failure here does not fail the open — the chat is
 * connected and usable, it is simply answering as whatever it was already set
 * to, and saying so is more useful than refusing to connect.
 */
async function applyVariant(
  tabId: number,
  label: string,
  variant: string | undefined,
): Promise<string | undefined> {
  if (!variant) {
    return undefined;
  }

  const result = (await askTab(tabId, { type: "set-model", model: variant })) as ContentToWorker;
  if (result.type === "model-set" && result.ok) {
    trace("open.variant-set", { label, variant });
    return undefined;
  }

  const why = result.type === "model-set" ? result.reason : "The page did not answer.";
  trace("open.variant-failed", { label, variant, why: why ?? "-" });
  return `Connected, but could not switch ${label} to "${variant}": ${why ?? "no reason given"}`;
}

async function openSurface(
  model: string,
  home?: string,
  variant?: string,
): Promise<SurfaceOpenOutcome> {
  const site = CHAT_SITES.find((candidate) => candidate.surfaceType === model);
  if (!site) {
    return { status: "failed", detail: `I do not know how to open "${model}".` };
  }

  /*
   * Declared before any of the slow parts, so a question typed in the seconds
   * that follow waits for this rather than being refused.
   */
  opening.set(model, Date.now() + SURFACE_WAIT_MS + 8000);

  const existing = pairings.get(model);
  if (existing?.status === "ready" && (await tabExists(existing.tabId))) {
    preferred = model;
    opening.delete(model);
    reportSurface();
    const note = await applyVariant(existing.tabId, site.label, variant);
    return { status: "ready", ...(note ? { detail: note } : {}) };
  }

  /*
   * A policy block is remembered so the picker can show it, but an explicit
   * pick is also the retry button.  Re-probe the same tab: if the user moved to
   * a browser without that policy or an administrator changed it, recovery is
   * immediate and no duplicate tab is opened.
   */
  if (existing?.status === "blocked" && (await tabExists(existing.tabId))) {
    const retried = await autoPair(existing.tabId, existing.url);
    if (retried.ok) {
      preferred = model;
      opening.delete(model);
      reportSurface();
      return { status: "ready" };
    }
    opening.delete(model);
    return {
      status: retried.blocked ? "blocked" : "failed",
      detail: pairingFailure(site.label, retried.reason),
    };
  }

  /*
   * Adopt the tab that is already open before opening another one.
   *
   * "Open Perplexity" when Perplexity is open in front of you should mean
   * *that* Perplexity. Only a `ready` record counted before, so a chat the
   * add-on had merely not probed yet — a tab open since before the add-on was
   * reloaded, or one whose record went stale when Chrome killed the worker —
   * got a second tab created beside it. Two tabs of one chat is not a neutral
   * outcome: pairing keys on the site, so the new tab silently replaces the old
   * and the conversation the user was looking at stops being the one driven.
   *
   * The sweep does the looking, rather than a URL-to-site guess here. Which
   * chat a tab *is* is something the page reports when probed; deciding it from
   * the address instead would be a second, worse answer to a question already
   * answered properly elsewhere.
   */
  await sweepOpenChats();
  const adopted = pairings.get(model);
  if (adopted?.status === "ready") {
    preferred = model;
    opening.delete(model);
    reportSurface();
    const note = await applyVariant(adopted.tabId, site.label, variant);
    return { status: "ready", ...(note ? { detail: note } : {}) };
  }

  /*
   * The editor's destination wins over the table's default.
   *
   * Validated rather than trusted: it ends up in `tabs.create`, and a
   * `javascript:` or `data:` URL there would be this add-on running someone
   * else's script. It also has to be on the site it claims to be, or "open
   * Claude" could open anything at all.
   */
  const destination = safeHome(home, site.hosts) ?? site.newChatUrl;

  try {
    trace("open.creating-tab", { model, url: destination });
    const tab = await chrome.tabs.create({ url: destination, active: false });
    if (tab.id === undefined) {
      return { status: "failed", detail: `Could not open ${site.label}.` };
    }

    /*
     * Pairing has to wait for the page, and `tabs.onUpdated` already pairs a
     * chat page on load — but only for sites the manifest injects into. This
     * waits for the same signal explicitly so the editor learns the result of
     * its own request rather than eventually noticing.
     */
    const ready = await waitForTabLoad(tab.id, 20_000);
    if (!ready) {
      return { status: "failed", detail: `${site.label} did not finish loading.` };
    }

    const paired = await autoPair(tab.id, destination);
    trace("open.paired", { model, tab: tab.id, ok: paired.ok, why: paired.reason ?? "-" });
    if (!paired.ok) {
      return {
        status: paired.blocked ? "blocked" : "failed",
        detail: pairingFailure(site.label, paired.reason),
      };
    }

    preferred = model;
    reportSurface();
    const note = await applyVariant(tab.id, site.label, variant);
    return { status: "ready", ...(note ? { detail: note } : {}) };
  } catch (error) {
    return {
      status: "failed",
      detail: `Could not open ${site.label}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    /*
     * Cleared however this ended. Left set, it would keep every later request
     * waiting twelve seconds for a chat that is never coming.
     */
    opening.delete(model);
  }
}

function blockedByExtensionPolicy(reason: string | undefined): boolean {
  return /ExtensionsSettings policy/i.test(reason ?? "");
}

function pairingFailure(label: string, reason: string | undefined): string {
  if (blockedByExtensionPolicy(reason)) {
    return (
      `This browser blocks add-ons from controlling ${label}. ` +
      `Dumb Ways to Die cannot override that browser policy. Use the editor's ` +
      `clipboard route in this browser. Full automation requires this browser ` +
      `to allow the extension, typically through a signed store build.`
    );
  }
  return (
    `Opened ${label} but could not pair its tab: ${reason ?? "The page did not answer."} ` +
    `Try picking it again; if it still fails, reload the tab and the add-on.`
  );
}

/**
 * Waits for a tab to finish loading, while keeping this worker alive.
 *
 * The subtlety that makes this function look wrong and be right: Chrome
 * terminates a Manifest V3 service worker after about thirty seconds of
 * inactivity, and **awaiting a timer is not activity**. Extension API calls
 * are. So the original — add a `tabs.onUpdated` listener and await a twenty
 * second timeout — could sit in complete silence for the whole of a slow page
 * load, get the worker killed halfway through, and leave the tab open, unpaired
 * and unreported. The user picks Perplexity, a tab opens, nothing pairs, and
 * every later request says it is not connected.
 *
 * Polling `chrome.tabs.get` reads the same `status` the event carries, and each
 * call resets the idle timer. It costs one API call per second and removes an
 * entire class of "it worked when the page was fast" failure.
 */
async function waitForTabLoad(tabId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let tab: chrome.tabs.Tab | undefined;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      // Closed while we waited: nothing left to load.
      return false;
    }

    if (tab.status === "complete") {
      // "complete" means the document loaded, not that a single-page app has
      // drawn its composer; the probe retries for that.
      await new Promise((resolve) => setTimeout(resolve, 600));
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

/** The `https://host/*` pattern for a URL, which is what permissions use. */
function originPatternOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? `https://${parsed.hostname}/*` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Puts the content script on a page that did not have it.
 *
 * Only ever called for an origin the user has already granted: `executeScript`
 * cannot reach a page this add-on has no permission for, so the permission
 * grant remains the real boundary and this is just the delivery.
 */
async function injectInto(tabId: number): Promise<{ ok: boolean; reason?: string }> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error && error.message
          ? `The add-on could not access this tab: ${error.message}`
          : "The add-on could not access this tab.",
    };
  }
}

/** A value that at least has a string `type`, which is all dispatch needs. */
function isMessage(value: unknown): value is { type: string } {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function setRelay(state: WorkerStatus["relay"], detail?: string): void {
  relayState = state;
  relayDetail = detail;
}

/* ------------------------------------------------------------------ *
 * Popup
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((raw, sender, respond) => {
  // Anything on the page or another extension can reach this listener, so the
  // shape is checked rather than asserted. An unrecognised message still gets
  // a status back — the switch below simply matches nothing.
  const message = (isMessage(raw) ? raw : { type: "get-status" }) as PopupToWorker;

  void (async () => {
    // Scoped to this one exchange: a note describes what just happened, so it
    // must not survive into the next status the popup asks for.
    let note: string | undefined;

    switch (message.type) {
      case "set-credentials":
        credentials = message.credentials;
        await chrome.storage.local.set({ credentials });
        connect();
        // If chats are already open, there is nothing further to ask for.
        await sweepOpenChats();
        break;

      case "pair-current-tab": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !tab.url) {
          note = "No tab is in focus to pair.";
          break;
        }

        // This add-on is only allowed onto the chat origins in its manifest,
        // so on anything else there is nobody to answer the probe. Say which
        // page would work rather than reporting a generic failure.
        /*
         * An unrecognised site is not a refusal, it is a question.
         *
         * The add-on ships selectors for the chats in the site table and gets
         * access to those by default. Anywhere else, the user grants access
         * themselves in the popup — and then this injects the content script,
         * because a page loaded before permission existed has nobody on it to
         * answer a probe.
         */
        if (!isChatUrl(tab.url, CHAT_ORIGINS)) {
          const origin = originPatternOf(tab.url);
          const granted = origin
            ? await chrome.permissions.contains({ origins: [origin] })
            : false;

          if (!granted) {
            note = `Not a chat this add-on knows. It ships support for ${describeOrigins(
              CHAT_ORIGINS,
            )} — for anything else, press "Use this chat anyway".`;
            break;
          }

          const injected = await injectInto(tab.id);
          if (!injected.ok) {
            note = injected.reason ?? "Could not start on this page. Reload it and try again.";
            break;
          }
        }

        const probed = (await askTab(tab.id, { type: "probe" })) as ContentToWorker;
        if (probed.type !== "probed") {
          // Only a "failed" reply carries a reason; the others cannot occur
          // here, and reading through the union rather than narrowing was a
          // type error waiting for someone to touch this file.
          const why = probed.type === "failed" ? probed.reason : "The page did not answer.";
          if (blockedByExtensionPolicy(why)) {
            const site = siteFor(tab.url);
            note = pairingFailure(site.label, why);
            pairings.set(site.surfaceType, {
              pairingId: createId("pair"),
              tabId: tab.id,
              surfaceType: site.surfaceType,
              label: site.label,
              url: tab.url,
              pairedAt: new Date().toISOString(),
              status: "blocked",
              detail: note,
            });
            await savePairings();
            reportSurface();
          } else {
            note =
              "This tab was open before the add-on was installed. Reload the page, then pair again.";
          }
          break;
        }

        const record = {
          pairingId: createId("pair"),
          tabId: tab.id,
          surfaceType: probed.surfaceType,
          label: siteFor(tab.url).label,
          url: tab.url,
          pairedAt: new Date().toISOString(),
          status: "ready" as const,
        };

        pairings.set(record.surfaceType, record);
        // Newly paired becomes the default: it is the one the user just chose.
        preferred = record.surfaceType;
        await savePairings();

        /*
         * Pairing succeeding is not the same as the bridge working.
         *
         * Pairing only proves the content script answered. Whether it can find
         * the composer and the reply is a separate question, and reporting
         * "ready" while delivery is broken sends the user hunting in the
         * editor for a fault that is on this page.
         */
        surface = probed.state;
        note = summarizeSurface(probed.state);
        reportSurface();
        break;
      }

      case "reply-progress": {
        /*
         * A reply still being written, forwarded so the panel shows it live.
         *
         * Sent as `partial`, which the editor renders in place and does not
         * treat as the end of the turn — so a premature "finished" verdict on
         * this side can no longer lose the text that had already arrived.
         */
        const frame = message as { text?: unknown; requestId?: unknown; observationId?: unknown };
        const partial = frame.text;

        /*
         * A partial is only forwarded if the tab that sent it is the tab this
         * request went to, and the observation is the one still running.
         *
         * Without both checks the frame was attributed to "whatever request is
         * current", which the relay accepts as a legitimate partial: text from
         * one chat would appear under another chat's answer, and a straggler
         * from an abandoned observation would overwrite live text.
         */
        const owner = typeof frame.requestId === "string" ? operations.get(frame.requestId) : undefined;
        const fromTheRightTab = owner !== undefined && sender.tab?.id === owner.tabId;
        const current = owner !== undefined && frame.observationId === owner.observationId;

        if (typeof partial === "string" && partial.trim().length > 0 && owner && fromTheRightTab && current) {
          send({
            type: "coach.response",
            response: {
              id: createId("res"),
              requestId: owner.requestId,
              sessionId: SESSION_ID,
              createdAt: new Date().toISOString(),
              content: [{ type: "text", text: partial }],
              source: { adapterKind: "browser", surfaceType: owner.surfaceType },
              completion: { state: "partial" },
            },
          });
        }
        break;
      }

      case "discover": {
        const found = await discover();
        note = found
          ? "Found your editor and connected."
          : "No editor answered. In the editor, press Connect a browser chat — that opens a five-minute window — then try again.";
        break;
      }

      case "unpair":
        pairings.clear();
        preferred = undefined;
        surface = undefined;
        await chrome.storage.local.remove("pairings");
        note = "Unpaired. No tab is being read.";
        reportSurface();
        break;

      default:
        break;
    }

    respond({
      relay: relayState,
      ...(relayDetail ? { relayDetail } : {}),
      ...(() => {
        const first = [...pairings.values()].find((entry) => entry.status === "ready");
        return first ? { pairing: first } : {};
      })(),
      surfaces: [...pairings.values()],
      ...(surface ? { surface } : {}),
      ...(note ? { note } : {}),
      hasCredentials: credentials !== undefined,
    } satisfies WorkerStatus);
  })();

  return true;
});

/**
 * Pairs a chat tab on sight.
 *
 * Spec §0J wants pairing to be explicit, and it still is in the sense that
 * matters: only a tab the user has open, on a chat origin this extension was
 * granted, is ever considered. Making them click a button to confirm a tab
 * they are already looking at is ceremony, not consent.
 *
 * What stays strict: an existing healthy pairing is never replaced. Silent
 * reassignment is the thing §0J actually forbids.
 */
/**
 * Probes a tab and pairs it, saying whether it worked.
 *
 * It used to return silently when the page did not answer, so an `openSurface`
 * that opened a tab and failed to pair it reported success — and the only thing
 * the user ever saw was a generic "not connected" from the next request. A
 * failure that names nothing is a failure nobody can act on, and this one hid
 * behind three rounds of guessing.
 *
 * The probe is retried, because "the document finished loading" and "the app has
 * rendered something to probe" are different moments on every one of these
 * sites, and the gap between them is seconds on a heavy single-page app.
 */
async function autoPair(
  tabId: number,
  url: string,
  /**
   * How hard to try. A tab we just opened deserves the full ladder; a tab found
   * by sweeping does not — being patient with every open tab would make one
   * sweep take as long as the number of chats the user happens to have open.
   */
  attempts: readonly number[] = [0, 400, 800, 1200, 2000],
): Promise<{ ok: boolean; blocked?: boolean; reason?: string }> {
  const site = siteFor(url);
  const existing = pairings.get(site.surfaceType);
  if (existing?.status === "ready" && (await tabExists(existing.tabId))) {
    return { ok: true };
  }

  // Background sweeps should not hammer a site the browser has already said
  // it forbids.  A full explicit pick uses the longer retry ladder and is the
  // deliberate recovery path after policy or browser changes.
  if (
    existing?.status === "blocked" &&
    existing.tabId === tabId &&
    attempts.length === 1
  ) {
    return { ok: false, blocked: true, reason: existing.detail };
  }

  let last: ContentToWorker | undefined;

  for (const wait of attempts) {
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }

    if (!(await tabExists(tabId))) {
      return { ok: false, reason: "The tab was closed before it could be paired." };
    }

    const probed = (await askTab(tabId, { type: "probe" })) as ContentToWorker;
    last = probed;

    if (probed.type !== "probed") {
      continue;
    }

    pairings.set(probed.surfaceType, {
      pairingId: createId("pair"),
      tabId,
      surfaceType: probed.surfaceType,
      label: siteFor(url).label,
      url,
      pairedAt: new Date().toISOString(),
      status: "ready",
    });
    preferred = preferred ?? probed.surfaceType;
    surface = probed.state;
    await savePairings();
    reportSurface();
    return { ok: true };
  }

  const said = last && "reason" in last ? last.reason : undefined;
  const blocked = blockedByExtensionPolicy(said);

  if (blocked) {
    const detail = pairingFailure(site.label, said);
    pairings.set(site.surfaceType, {
      pairingId: existing?.pairingId ?? createId("pair"),
      tabId,
      surfaceType: site.surfaceType,
      label: site.label,
      url,
      pairedAt: existing?.pairedAt ?? new Date().toISOString(),
      status: "blocked",
      detail,
    });
    await savePairings();
    reportSurface();
  }

  return {
    ok: false,
    ...(blocked ? { blocked: true } : {}),
    reason: said ?? "The page never answered.",
  };
}

/**
 * A user-supplied destination, or nothing.
 *
 * Two checks, both about not becoming a way to open arbitrary things: https
 * only, and on one of this site's own hosts. A project URL and a
 * temporary-chat URL both pass; a pasted mistake does not.
 */
function safeHome(home: string | undefined, hosts: readonly string[]): string | undefined {
  if (!home) {
    return undefined;
  }

  try {
    const parsed = new URL(home);
    if (parsed.protocol !== "https:") {
      return undefined;
    }
    return hosts.includes(parsed.hostname) ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Finds every chat already open and pairs it.
 *
 * The add-on used to learn about a tab only when one *loaded* — so a browser
 * that already had ChatGPT and Z.ai open when the worker woke up knew about
 * neither, and the user was asked to go and pair a chat that was sitting right
 * there. Since Chrome kills this worker every thirty seconds, "already open" is
 * the normal case, not the edge one.
 *
 * This is the whole of the browser's advantage over the editor: it can see its
 * own tabs. Not using that meant asking the user for something we could look up.
 *
 * Sweeps *all* of them rather than stopping at the first. The router's point is
 * choosing between chats, and a list of one is not a choice.
 */
async function sweepOpenChats(): Promise<number> {
  const readyBefore = new Set(
    [...pairings.values()].filter((record) => record.status === "ready").map((r) => r.surfaceType),
  );

  for (const tab of await chrome.tabs.query({ url: CHAT_ORIGINS })) {
    if (!tab.id || !tab.url) {
      continue;
    }

    // One probe each: a page that needs coaxing is a page the user has not
    // asked for yet, and the open path is where patience belongs.
    await autoPair(tab.id, tab.url, [0]);
  }

  // Counted from what is ready now versus before, rather than by deciding which
  // chat each tab was from its address — which the page itself answers.
  const found = [...pairings.values()].filter(
    (record) => record.status === "ready" && !readyBefore.has(record.surfaceType),
  ).length;

  if (found > 0) {
    console.info(`[dwtd] found ${found} chat${found === 1 ? "" : "s"} already open`);
  }

  return found;
}

/** A chat page finishing loading is enough to pair it. */
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === "complete" && tab.url) {
    void autoPair(tabId, tab.url);
  }
});

/**
 * Spec §0J: the paired tab closing means LOST, never silent reassignment.
 *
 * The comment above used to sit directly on top of a silent reassignment: when
 * the closed tab was the preferred one, `preferred` was moved to whichever chat
 * happened to still be ready. So closing the Claude tab quietly made ChatGPT
 * the chosen chat, and the next question went there and was answered — which is
 * exactly the "I chose Perplexity and ChatGPT answered" report, and the worst
 * available failure here, because an answer from the wrong chat still reads as
 * an answer.
 *
 * The choice is the user's and it survives its tab. What the closed tab costs
 * is the *ability* to answer, and that is reported as a refusal rather than
 * papered over with a substitute.
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [key, record] of pairings) {
    if (record.tabId === tabId) {
      // Only this chat is gone. Marking the whole set lost would drop three
      // working conversations because one tab was closed.
      pairings.set(key, { ...record, status: "closed" });
      void savePairings();
      reportSurface();
    }
  }
});

/*
 * The backstop for a worker Chrome has already killed.
 *
 * Timers die with the worker, so the in-worker keepalive cannot resurrect
 * anything — only an event can, and an alarm is an event. This is what makes
 * the add-on reconnect on its own instead of waiting for the user to notice
 * and open the popup.
 */
const KEEPALIVE_ALARM = "dumbways-keepalive";

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    void loadState().then(() => {
      connect();
      startKeepalive();
    });
  }
});

/**
 * A fast look for the editor, only while there is nothing to connect to.
 *
 * Thirty seconds is a long time to stare at a window wondering whether it
 * worked. This checks every two seconds for a minute after startup and then
 * stops — the keepalive keeps looking slowly after that.
 */
function startDiscovery(): void {
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (credentials || attempts > 30) {
      clearInterval(timer);
      return;
    }
    void discover();
  }, 2000);
}

function startup(): void {
  // 0.5 minutes is the shortest period Chrome honours for a packed extension.
  void chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  void loadState().then(() => {
    connect();
    startKeepalive();
    startDiscovery();
  });
}

chrome.runtime.onStartup.addListener(startup);
chrome.runtime.onInstalled.addListener(startup);
startup();
