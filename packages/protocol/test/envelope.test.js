const test = require("node:test");
const assert = require("node:assert/strict");

const { createEnvelope, parseEnvelope, PROTOCOL_VERSION, createId } = require("../dist/index.js");

test("createEnvelope stamps the protocol version", () => {
  const envelope = createEnvelope("session_1", { type: "coach.request" });
  assert.equal(envelope.protocolVersion, PROTOCOL_VERSION);
  assert.equal(envelope.sessionId, "session_1");
  assert.deepEqual(envelope.payload, { type: "coach.request" });
  assert.match(envelope.id, /^msg_/);
  assert.ok(!Number.isNaN(Date.parse(envelope.timestamp)));
});

test("parseEnvelope round-trips a valid envelope", () => {
  const envelope = createEnvelope("session_1", { hello: true });
  const parsed = parseEnvelope(JSON.parse(JSON.stringify(envelope)));
  assert.deepEqual(parsed.payload, { hello: true });
});

test("parseEnvelope rejects an unsupported protocol version instead of guessing", () => {
  const envelope = { ...createEnvelope("session_1", {}), protocolVersion: 2 };
  assert.throws(() => parseEnvelope(envelope), (error) => {
    assert.equal(error.code, "UNSUPPORTED_PROTOCOL_VERSION");
    return true;
  });
});

test("parseEnvelope rejects malformed envelopes", () => {
  const cases = [
    null,
    "not an object",
    [],
    { protocolVersion: PROTOCOL_VERSION, id: "", timestamp: "t", sessionId: "s", payload: {} },
    { protocolVersion: PROTOCOL_VERSION, id: "i", timestamp: "t", sessionId: "s" },
  ];

  for (const value of cases) {
    assert.throws(() => parseEnvelope(value), /Envelope|protocol/i);
  }
});

test("ids are unique and prefixed", () => {
  const ids = new Set(Array.from({ length: 500 }, () => createId("req")));
  assert.equal(ids.size, 500);
  for (const id of ids) {
    assert.match(id, /^req_[0-9a-f]{12}$/);
  }
});
