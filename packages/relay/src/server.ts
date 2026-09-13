import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { WebSocketServer } from "ws";

import {
  harnessPrimer,
  messagesToSend,
  parseFromChat,
  renderForChat,
  toCompletionsResponse,
  toStreamChunks,
  type CompletionsRequest,
  DEFAULT_RELAY_HOST,
  DEFAULT_RELAY_PORT,
  PROTOCOL_VERSION,
  type RelayHandshakeFile,
} from "@dumbways/protocol";

import {
  createToken,
  isFromWebPage,
  isLoopbackHost,
  removeHandshakeFile,
  tokensMatch,
  writeHandshakeFile,
} from "./auth";
import { RelayHub } from "./hub";

/**
 * The local relay (spec §0F, §21).
 *
 * A plain Node process, bound to loopback, that routes messages between the
 * editor and a provider. It owns sessions, correlation, authentication and
 * connection state — and no coaching logic whatsoever (spec §0T).
 */

export interface RelayOptions {
  host?: string;
  port?: number;
  token?: string;
  /** Set false in tests so the handshake file is not written to the machine. */
  writeHandshake?: boolean;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}

export interface RunningRelay {
  host: string;
  port: number;
  token: string;
  hub: RelayHub;
  close(): Promise<void>;
}

/**
 * The last few hundred events, kept in memory and readable on loopback.
 *
 * Diagnosing the browser half of this bridge has meant asking the user to
 * reproduce a failure and describe it, three or four times in a row, because
 * a Manifest V3 service worker's console is not reachable from anywhere except
 * a devtools window the user has to know how to open. Nothing about that is
 * necessary: the add-on is already talking to this process, so this process can
 * remember what it said.
 *
 * In memory only, capped, and never written to disk — it is a debugging aid,
 * not a record, and a relay that quietly accumulated a log file of someone's
 * chat activity would be a worse thing than the problem it solves.
 */
const LOG_CAPACITY = 400;

export async function startRelay(options: RelayOptions = {}): Promise<RunningRelay> {
  const host = options.host ?? DEFAULT_RELAY_HOST;
  const port = options.port ?? DEFAULT_RELAY_PORT;
  const token = options.token ?? createToken();
  const writeHandshake = options.writeHandshake ?? true;
  const startedAt = new Date().toISOString();

  const recent: Array<{ at: string; event: string; detail?: Record<string, unknown> }> = [];
  const underlying = options.log ?? defaultLog;
  const log: NonNullable<RelayOptions["log"]> = (event, detail) => {
    recent.push({ at: new Date().toISOString(), event, ...(detail ? { detail } : {}) });
    if (recent.length > LOG_CAPACITY) {
      recent.splice(0, recent.length - LOG_CAPACITY);
    }
    underlying(event, detail);
  };

  const hub = new RelayHub({ token, log });

  const http = createServer((request, response) => {
    const address = http.address();
    const boundPort = typeof address === "object" && address ? address.port : port;
    void handleHttp(request, response, hub, startedAt, token, boundPort, log, recent);
  });
  const wss = new WebSocketServer({ server: http, path: "/transport" });
  hub.attach(wss);

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    // Never 0.0.0.0 (spec §21): this listener is for this machine only.
    http.listen(port, host, () => {
      http.removeListener("error", reject);
      resolve();
    });
  });

  const actualPort = (http.address() as { port: number } | null)?.port ?? port;

  if (writeHandshake) {
    const handshake: RelayHandshakeFile = {
      host,
      port: actualPort,
      token,
      pid: process.pid,
      startedAt,
      protocolVersion: PROTOCOL_VERSION,
    };
    const written = await writeHandshakeFile(handshake);
    log("relay.handshake-written", { path: written });
  }

  log("relay.listening", { url: `ws://${host}:${actualPort}/transport` });

  let closed = false;
  return {
    host,
    port: actualPort,
    token,
    hub,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      hub.close();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      if (writeHandshake) {
        await removeHandshakeFile(actualPort);
      }
    },
  };
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function handleHttp(
  request: IncomingMessage,
  response: ServerResponse,
  hub: RelayHub,
  startedAt: string,
  token: string,
  relayPort: number,
  log: (event: string, detail?: Record<string, unknown>) => void,
  recent: ReadonlyArray<{ at: string; event: string; detail?: Record<string, unknown> }>,
): Promise<void> {
  const url = request.url ?? "";

  if (url.startsWith("/media/")) {
    await serveMedia(request, response, hub, token, decodeURIComponent(url.slice("/media/".length)));
    return;
  }

  if (url === "/pair") {
    /*
     * Hands a *browser* credential to a local client, during a window the user
     * opened from the editor.
     *
     * Three things this is not:
     *
     *  - Not the relay's own token. That one admits any adapter role, so
     *    handing it to the add-on gave a browser the editor's powers. What
     *    comes back here can only ever attach as a browser.
     *  - Not repeatable. The window is consumed by the first claim, so a
     *    caller cannot collect credentials by asking twice.
     *  - Not reachable from a web page. There are deliberately no CORS
     *    headers, so a page cannot read the response — but DNS rebinding makes
     *    a page same-origin with loopback, at which point CORS stops
     *    protecting anything. The `Host` check is what actually holds, since
     *    rebinding cannot change the name the client asked for.
     */
    if (!isLoopbackHost(request.headers.host, relayPort)) {
      respondJson(response, 403, {
        ok: false,
        message: "This endpoint only answers requests addressed to localhost.",
      });
      log("pair.wrong-host", { host: request.headers.host });
      return;
    }

    if (isFromWebPage(request.headers.origin)) {
      respondJson(response, 403, { ok: false, message: "Web pages cannot pair." });
      log("pair.web-origin", { origin: request.headers.origin });
      return;
    }

    const granted = hub.claimBrowserPairing();
    if (!granted) {
      respondJson(response, 403, {
        ok: false,
        message: "Pairing is closed. Press Connect a browser chat in the editor.",
      });
      return;
    }

    respondJson(response, 200, { ok: true, host: "127.0.0.1", port: relayPort, token: granted });
    return;
  }

  if (url === "/v1/chat/completions" && request.method === "POST") {
    /*
     * The same two checks, for a different reason.
     *
     * Nothing here can be *read* by a page, but a POST has an effect: text
     * gets typed into whichever chat the user paired. A `text/plain` body is a
     * "simple request", so a page can send one with no preflight to stop it —
     * which is a plain CSRF against the user's own chat window. A harness
     * sends `application/json` and no `Origin`; a page cannot do both.
     */
    if (!isLoopbackHost(request.headers.host, relayPort)) {
      respondJson(response, 403, { error: { message: "Addressed to the wrong host." } });
      log("completions.wrong-host", { host: request.headers.host });
      return;
    }

    if (isFromWebPage(request.headers.origin)) {
      respondJson(response, 403, { error: { message: "Web pages cannot use this endpoint." } });
      log("completions.web-origin", { origin: request.headers.origin });
      return;
    }

    const contentType = (request.headers["content-type"] ?? "").split(";")[0]?.trim();
    if (contentType !== "application/json") {
      // A preflight is required for this content type, and there is nothing
      // here to answer one with, so a page cannot reach this at all.
      respondJson(response, 415, {
        error: { message: "Content-Type must be application/json." },
      });
      return;
    }

    await serveCompletions(request, response, hub);
    return;
  }

  if (url === "/v1/models") {
    // Harnesses call this to check a base URL is real before using it.
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        object: "list",
        data: [{ id: "dumbways-chat", object: "model", owned_by: "dumbways" }],
      }),
    );
    return;
  }

  if (url.startsWith("/log")) {
    /*
     * What just happened, for whoever is trying to work out why it did not.
     *
     * Same two guards as everything else here: addressed to loopback, and not
     * from a web page. It carries message *types* and adapter kinds, never
     * message contents — knowing that a request was routed is what diagnoses a
     * bridge; knowing what was in it is somebody's conversation.
     */
    if (!isLoopbackHost(request.headers.host, relayPort) || isFromWebPage(request.headers.origin)) {
      respondJson(response, 403, { ok: false });
      return;
    }

    const limit = Number(new URL(url, "http://127.0.0.1").searchParams.get("n") ?? 80);
    const slice = recent.slice(-Math.max(1, Math.min(LOG_CAPACITY, limit)));
    respondJson(response, 200, { ok: true, events: slice });
    return;
  }

  if (request.url === "/health") {
    const snapshot = hub.snapshot();
    response.writeHead(200, { "content-type": "application/json" });
    // Deliberately does not include the token: /health is unauthenticated so
    // a client can discover whether a relay is already running (spec §0F).
    response.end(
      JSON.stringify({
        ok: true,
        service: "dumbways-relay",
        protocolVersion: PROTOCOL_VERSION,
        startedAt,
        pid: process.pid,
        // The build this relay is running. The extension compares it with its
        // own and restarts a stale relay rather than leaving the user to
        // discover the mismatch through inexplicable behaviour.
        build: process.env["DUMBWAYS_BUILD"] ?? "unknown",
        /*
         * The browser is reported separately from `provider`, which is true
         * when *either* a mock process or a browser is attached. Collapsing the
         * two made this endpoint useless for the question people actually ask
         * of it — "is my chat connected?" — and I hit that myself diagnosing a
         * misroute: /health said `provider: true` while the browser hop was the
         * thing in doubt.
         */
        adapters: {
          editor: snapshot.editor,
          provider: snapshot.provider,
          browser: snapshot.browser,
        },
        pendingRequests: snapshot.pending,
        registeredMedia: snapshot.media,
      }),
    );
    return;
  }

  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
}

/**
 * `POST /v1/chat/completions` — a chat tab wearing an OpenAI costume.
 *
 * A coding harness points its base URL here and cannot tell the difference.
 * The intelligence is whatever tab the user paired; this only translates.
 *
 * Deliberately unauthenticated, like /health: the listener is loopback-only,
 * and a harness config that also needs a rotating token is a harness config
 * nobody will finish setting up. Nothing here reads the workspace — every
 * tool the harness runs, it runs itself.
 */
async function serveCompletions(
  request: IncomingMessage,
  response: ServerResponse,
  hub: RelayHub,
): Promise<void> {
  const body = await readBody(request, 4 * 1024 * 1024);

  let parsed: CompletionsRequest;
  try {
    parsed = JSON.parse(body) as CompletionsRequest;
  } catch {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Body is not JSON." } }));
    return;
  }

  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  if (messages.length === 0) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "messages is required." } }));
    return;
  }

  /*
   * One tab conversation per harness run, keyed by the transcript's opening.
   *
   * The harness resends its whole transcript every call while the tab keeps
   * everything on screen, so only the new tail is typed. The key has to be
   * stable across a run and different between runs — the first user message
   * is both.
   */
  const sessionKey = sessionKeyFor(messages);
  const sent = sentCounts.get(sessionKey) ?? 0;
  const delta = messagesToSend(messages, sent);

  const primer = sent === 0 ? `${harnessPrimer(parsed.tools)}\n\n---\n\n` : "";
  const text = `${primer}${renderForChat(delta)}`;

  try {
    const reply = await hub.ask(sessionKey, text, 180_000);
    sentCounts.set(sessionKey, messages.length);

    const model = parsed.model ?? "dumbways-chat";
    const parsedReply = parseFromChat(reply);

    if (parsed.stream) {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for (const chunk of toStreamChunks(parsedReply, model)) {
        response.write(chunk);
      }
      response.end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(toCompletionsResponse(parsedReply, model)));
  } catch (error) {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: { message: error instanceof Error ? error.message : String(error) },
      }),
    );
  }
}

/** How many messages each tab conversation has already been shown. */
const sentCounts = new Map<string, number>();

function sessionKeyFor(messages: CompletionsRequest["messages"]): string {
  const first = messages.find((message) => message.role === "user");
  const seed = `${first?.content ?? ""}`.slice(0, 200);
  return `harness_${hashString(seed)}`;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Body too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/**
 * `GET /media/:id` (spec §0M, §9).
 *
 * Authenticated, and it resolves **only ids the editor registered**. There is
 * deliberately no path in the URL: a media endpoint that accepts a path is a
 * file server for the whole disk, which is precisely what spec §9 forbids.
 */
async function serveMedia(
  request: IncomingMessage,
  response: ServerResponse,
  hub: RelayHub,
  token: string,
  id: string,
): Promise<void> {
  const provided = readBearerToken(request);
  if (!provided || !tokensMatch(token, provided)) {
    // 401 with no detail: an unauthenticated caller learns nothing about
    // whether the id exists.
    response.writeHead(401, { "content-type": "text/plain" });
    response.end("unauthorized");
    return;
  }

  const media = hub.lookupMedia(id);
  if (!media) {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("unknown media id");
    return;
  }

  try {
    const bytes = await readFile(media.localMediaPath);
    response.writeHead(200, {
      "content-type": media.mimeType,
      "content-length": String(bytes.byteLength),
      // The bytes are user data; nothing should keep a copy.
      "cache-control": "no-store",
      "content-disposition": `inline; filename="${media.filename.replace(/["\\]/g, "")}"`,
      "x-content-type-options": "nosniff",
    });
    response.end(bytes);
  } catch {
    // Registered but gone from disk: the registration outlived the file.
    response.writeHead(410, { "content-type": "text/plain" });
    response.end("media no longer available");
  }
}

function readBearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim();
  }
  return undefined;
}

function defaultLog(event: string, detail?: Record<string, unknown>): void {
  // Structured, one line per event (spec §43). The token is never an argument
  // to this function, so it can never be logged by accident.
  const entry = { timestamp: new Date().toISOString(), event, ...detail };
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

/** `node dist/server.js` — the entry point named in spec §0F. */
async function main(): Promise<void> {
  const port = Number(process.env["DUMBWAYS_RELAY_PORT"] ?? DEFAULT_RELAY_PORT);

  /*
   * A token supplied by whoever started us, when there is one.
   *
   * Minting a fresh token on every start meant every relay restart silently
   * invalidated the browser add-on's stored credentials — and a window reload
   * restarts the relay. That is the single biggest source of "it keeps
   * disconnecting": nothing was wrong except that the password had changed.
   */
  const suppliedToken = process.env["DUMBWAYS_RELAY_TOKEN"];
  const relay = await startRelay({ port, ...(suppliedToken ? { token: suppliedToken } : {}) });

  process.stdout.write(`[DUMBWAYS] relay listening ws://${relay.host}:${relay.port}/transport\n`);
  process.stdout.write(`[DUMBWAYS] health http://${relay.host}:${relay.port}/health\n`);
  process.stdout.write(`[DUMBWAYS] READY\n`);

  const shutdown = async (): Promise<void> => {
    await relay.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

// Only run when executed directly, so importing this module in a test does not
// bind a port.
if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`[DUMBWAYS] relay failed to start: ${String(error)}\n`);
    process.exit(1);
  });
}
