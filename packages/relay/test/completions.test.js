const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { startRelay, RelayConnection } = require("../dist/index.js");
const {
  parseFromChat,
  renderForChat,
  messagesToSend,
  harnessPrimer,
} = require("@dumbways/protocol");

/**
 * A coding harness using a chat tab as its model.
 *
 * The tab is stood in for by a fake "browser" adapter that answers whatever
 * the test tells it to. What is being checked is the translation: OpenAI in,
 * prose out, structure back.
 */

const TOKEN = "completions-token-0123456789";
let relay;
let tab;
let reply = "";

test.before(async () => {
  relay = await startRelay({ port: 0, token: TOKEN, writeHandshake: false, log: () => {} });

  tab = new RelayConnection({
    host: "127.0.0.1",
    port: relay.port,
    token: TOKEN,
    adapterKind: "browser",
    adapterId: "tab_test",
    capabilities: [],
    log: () => {},
    onMessage: (message) => {
      if (message.type !== "coach.request") return;
      tab.send(message.request.sessionId, {
        type: "coach.response",
        response: {
          id: "res_1",
          requestId: message.request.id,
          sessionId: message.request.sessionId,
          createdAt: new Date().toISOString(),
          content: [{ type: "text", text: reply }],
          source: { adapterKind: "browser", surfaceType: "test" },
          completion: { state: "complete" },
        },
      });
    },
  });
  await tab.connect();
});

test.after(async () => {
  tab?.close();
  await relay?.close();
});

const post = async (body) => {
  const res = await fetch(`http://127.0.0.1:${relay.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};

/* ---------------- translation, pure ---------------- */

test("the tab is told it is a model in a harness, not a helpful assistant", () => {
  const primer = harnessPrimer([
    { type: "function", function: { name: "read_file", description: "Read a file." } },
  ]);
  assert.match(primer, /agent harness/);
  assert.match(primer, /A program is calling you, not a person/);
  assert.match(primer, /`read_file`/);
});

test("tool arguments come back as a JSON string, which is what harnesses parse", () => {
  const { toolCalls, content } = parseFromChat(
    'I will look.\n\n```tool\n{"name":"read_file","arguments":{"path":"a.js"}}\n```',
  );

  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.name, "read_file");
  // An object here would throw inside the harness's own JSON.parse.
  assert.equal(typeof toolCalls[0].function.arguments, "string");
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { path: "a.js" });
  assert.equal(content, "I will look.");
});

test("prose with no block is a finished answer, not a broken one", () => {
  const { toolCalls, content } = parseFromChat("The bug is a missing preventDefault.");
  assert.deepEqual(toolCalls, []);
  assert.match(content, /preventDefault/);
});

test("unparseable JSON stays prose rather than crashing the run", () => {
  const { toolCalls, content } = parseFromChat("```tool\n{ not json\n```");
  assert.deepEqual(toolCalls, []);
  assert.ok(content.length > 0);
});

test("only the messages a tab has not seen are sent", () => {
  const all = [{ role: "user" }, { role: "assistant" }, { role: "tool" }];
  assert.equal(messagesToSend(all, 2).length, 1);
  assert.equal(messagesToSend(all, 0).length, 3);
  // A shorter transcript than we have sent means a different conversation.
  assert.equal(messagesToSend(all, 9).length, 3);
});

test("tool results are labelled so the tab can tell them from instructions", () => {
  const text = renderForChat([
    { role: "tool", name: "read_file", content: '{"content":"x"}' },
  ]);
  assert.match(text, /Result of `read_file`/);
});

/* ---------------- the endpoint, end to end ---------------- */

test("a harness gets an OpenAI-shaped answer from a chat tab", async () => {
  reply = "The form reloads because there is no preventDefault.";

  const { status, json } = await post({
    model: "whatever",
    messages: [{ role: "user", content: "why does my form reload?" }],
  });

  assert.equal(status, 200);
  assert.equal(json.object, "chat.completion");
  assert.equal(json.choices[0].finish_reason, "stop");
  assert.match(json.choices[0].message.content, /preventDefault/);
});

test("a tool call survives the round trip into the harness's shape", async () => {
  reply = 'Let me read it.\n\n```tool\n{"name":"read_file","arguments":{"path":"index.html"}}\n```';

  const { json } = await post({
    messages: [{ role: "user", content: "read index.html and explain" }],
    tools: [{ type: "function", function: { name: "read_file", description: "Read." } }],
  });

  assert.equal(json.choices[0].finish_reason, "tool_calls");
  const call = json.choices[0].message.tool_calls[0];
  assert.equal(call.type, "function");
  assert.equal(call.function.name, "read_file");
  assert.deepEqual(JSON.parse(call.function.arguments), { path: "index.html" });
});

test("/v1/models answers, so a harness can verify the base URL", async () => {
  const res = await fetch(`http://127.0.0.1:${relay.port}/v1/models`);
  const json = await res.json();
  assert.equal(json.object, "list");
  assert.ok(json.data.length > 0);
});

test("no messages is a 400, not a hang", async () => {
  const { status } = await post({ messages: [] });
  assert.equal(status, 400);
});

/* ---------------- streaming ---------------- */

test("a streaming client gets SSE frames it can parse", async () => {
  reply = "The bug is a missing preventDefault.";

  const res = await fetch(`http://127.0.0.1:${relay.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "why?" }] }),
  });

  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const body = await res.text();

  const frames = body
    .split("\n\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6));

  assert.equal(frames[frames.length - 1], "[DONE]", "a stream must terminate the way clients expect");

  const parsed = frames.slice(0, -1).map((frame) => JSON.parse(frame));
  assert.equal(parsed[0].choices[0].delta.role, "assistant", "the first frame opens the message");
  assert.equal(parsed[parsed.length - 1].choices[0].finish_reason, "stop");

  const text = parsed.map((frame) => frame.choices[0].delta.content ?? "").join("");
  assert.equal(text, reply, "the pieces must reassemble into exactly what was said");
});

test("tool calls stream as tool_calls deltas, not as text", async () => {
  reply = 'Reading it.\n\n```tool\n{"name":"read_file","arguments":{"path":"a.js"}}\n```';

  const res = await fetch(`http://127.0.0.1:${relay.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "read a.js" }] }),
  });

  const frames = (await res.text())
    .split("\n\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)));

  const call = frames.find((frame) => frame.choices[0].delta.tool_calls)?.choices[0].delta
    .tool_calls[0];

  assert.ok(call, "the tool call must arrive as a delta a harness recognises");
  assert.equal(call.index, 0, "harnesses accumulate tool calls by index");
  assert.equal(call.function.name, "read_file");
  assert.equal(frames[frames.length - 1].choices[0].finish_reason, "tool_calls");
});

test("words are never split across frames", async () => {
  reply = "preventDefault stops the reload";

  const res = await fetch(`http://127.0.0.1:${relay.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "x" }] }),
  });

  const pieces = (await res.text())
    .split("\n\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)).choices[0].delta.content)
    .filter(Boolean);

  // A client rendering progressively should never show half a word.
  for (const piece of pieces) {
    assert.doesNotMatch(piece, /^\S+$/u.test(piece) ? /^$/ : /^\s*$/, "no empty content frames");
  }
  assert.equal(pieces.join(""), reply);
});

/* ------------------------------------------------------------------ *
 * Who may drive the harness endpoint
 *
 * Nothing here can be *read* by a web page — there are no CORS headers — but a
 * POST has an effect: text gets typed into whichever chat the user paired. A
 * `text/plain` body is a "simple request" that needs no preflight, so without
 * these checks any page the user had open could put words in their chat.
 * ------------------------------------------------------------------ */

test("a plain-text body is refused, so a page cannot send one without a preflight", async () => {
  const res = await fetch(`http://127.0.0.1:${relay.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });

  assert.equal(res.status, 415);
});

test("a request carrying a web page's origin is refused", async () => {
  const res = await fetch(`http://127.0.0.1:${relay.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example.com" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });

  assert.equal(res.status, 403);
});

test("a request addressed to another name is refused", async () => {
  // The rebinding case, which is the one that defeats same-origin policy.
  const answered = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: relay.port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "content-type": "application/json", host: "evil.example.com" },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));
  });

  assert.equal(answered, 403);
});
