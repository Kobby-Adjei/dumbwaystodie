const test = require("node:test");
const assert = require("node:assert/strict");

const {
  belongsToWorkspace,
  boundMessages,
  MAX_PERSISTED_MESSAGES,
} = require("../out/session/persistence.js");

/**
 * Restoring a conversation across a reload.
 *
 * Reloading the window is something people do constantly, and losing the whole
 * thread each time made the panel feel disposable. It also reset the context
 * ledger, so a reload silently re-sent every file the chat already had.
 *
 * The risk runs the other way too: a session restored into the wrong project
 * would discuss files that are not there.
 */

const session = (over = {}) => ({
  id: "session_1",
  name: "test",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  workspaceRoots: [{ name: "job-agent", path: "/tmp/job-agent" }],
  messages: [],
  permissions: {},
  ...over,
});

const roots = [{ name: "job-agent", path: "/tmp/job-agent" }];

test("a session from this workspace is restored", () => {
  assert.equal(belongsToWorkspace(session(), roots), true);
});

test("a session from a different project is refused", () => {
  // A wrong session is worse than no session: it describes files that are not
  // there, and the ledger would claim the chat had already been sent them.
  assert.equal(
    belongsToWorkspace(session(), [{ name: "other", path: "/tmp/other" }]),
    false,
  );
});

test("folder order is not a promise the editor makes", () => {
  const multi = session({
    workspaceRoots: [
      { name: "b", path: "/tmp/b" },
      { name: "a", path: "/tmp/a" },
    ],
  });

  assert.equal(
    belongsToWorkspace(multi, [
      { name: "a", path: "/tmp/a" },
      { name: "b", path: "/tmp/b" },
    ]),
    true,
  );
});

test("a subset of the folders is not the same workspace", () => {
  const multi = session({
    workspaceRoots: [
      { name: "a", path: "/tmp/a" },
      { name: "b", path: "/tmp/b" },
    ],
  });
  assert.equal(belongsToWorkspace(multi, [{ name: "a", path: "/tmp/a" }]), false);
});

test("nothing stored, or something corrupt, is simply not restored", () => {
  assert.equal(belongsToWorkspace(undefined, roots), false);
  assert.equal(belongsToWorkspace({ id: "x" }, roots), false, "no messages array");
  assert.equal(belongsToWorkspace(session({ messages: "not an array" }), roots), false);
});

test("a workspace with no folders open matches a session that had none", () => {
  assert.equal(belongsToWorkspace(session({ workspaceRoots: [] }), []), true);
});

test("history is bounded to the recent turns", () => {
  const many = Array.from({ length: MAX_PERSISTED_MESSAGES + 40 }, (_, index) => ({
    id: `m${index}`,
    role: "user",
    text: `message ${index}`,
  }));

  const kept = boundMessages(many);
  assert.equal(kept.length, MAX_PERSISTED_MESSAGES);
  assert.equal(kept[kept.length - 1].text, `message ${many.length - 1}`, "the tail is kept");
  assert.equal(kept[0].text, "message 40", "the oldest are dropped");
});

test("a short conversation is returned untouched", () => {
  const few = [{ id: "a", role: "user", text: "hi" }];
  assert.equal(boundMessages(few), few, "no copy when there is nothing to trim");
});
