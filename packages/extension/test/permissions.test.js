const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PermissionManager,
  MODE_POLICIES,
  grantKey,
} = require("../out/permissions/PermissionManager.js");

/**
 * The permission gate (spec §16, §17, §78).
 *
 * These are the tests where a bug means something ran that the user never
 * agreed to, so they check the refusals as hard as the approvals.
 */

function harness(options = {}) {
  const asked = [];
  let stored = options.remembered ?? [];

  const manager = new PermissionManager({
    getMode: () => options.mode ?? "strict-coach",
    prompt: {
      ask: async (query) => {
        asked.push(query);
        if (options.onAsk) {
          return options.onAsk(query);
        }
        return options.outcome ?? "deny";
      },
    },
    store: {
      read: () => stored,
      write: async (keys) => {
        stored = keys;
      },
    },
    log: () => {},
    onPromptOpen: options.onPromptOpen,
    onPromptClose: options.onPromptClose,
  });

  return { manager, asked, stored: () => stored };
}

const query = (over = {}) => ({
  callId: "tool_1",
  tool: "shell.run",
  permission: "execute",
  summary: "npm test",
  ...over,
});

/* ------------------------------------------------------------------ *
 * Policy
 * ------------------------------------------------------------------ */

test("read tools are allowed without ever asking", async () => {
  const { manager, asked } = harness();

  const decision = await manager.resolve(
    query({ tool: "workspace.read_file", permission: "read", summary: "src/app.js" }),
  );

  assert.equal(decision, "allow");
  assert.equal(asked.length, 0, "asking to read would train the user to click through prompts");
});

test("strict-coach refuses writes outright, without a prompt", async () => {
  const { manager, asked } = harness({ mode: "strict-coach", outcome: "allow-once" });

  const decision = await manager.resolve(query({ permission: "write", summary: "app.js" }));

  assert.equal(decision, "deny");
  assert.equal(asked.length, 0, "a disabled class must not be promptable");
});

test("the three modes differ only where they should", () => {
  assert.deepEqual(MODE_POLICIES["strict-coach"], {
    read: "allow",
    execute: "ask",
    write: "deny",
    destructive: "deny",
  });
  assert.equal(MODE_POLICIES.guided.write, "ask");
  assert.equal(MODE_POLICIES.guided.destructive, "deny");
  assert.equal(MODE_POLICIES["normal-agent"].destructive, "ask");

  // No mode anywhere allows execute, write or destructive without asking.
  for (const [mode, policy] of Object.entries(MODE_POLICIES)) {
    assert.equal(policy.read, "allow", `${mode} should allow reads`);
    for (const dangerous of ["execute", "write", "destructive"]) {
      assert.notEqual(policy[dangerous], "allow", `${mode} must never auto-allow ${dangerous}`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * The prompt
 * ------------------------------------------------------------------ */

test("execute asks, and shows the exact command", async () => {
  const { manager, asked } = harness({ outcome: "allow-once" });

  const decision = await manager.resolve(query());

  assert.equal(decision, "allow");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].summary, "npm test");
});

test("deny means deny", async () => {
  const { manager } = harness({ outcome: "deny" });
  assert.equal(await manager.resolve(query()), "deny");
});

test("allow once does not remember", async () => {
  const { manager, asked, stored } = harness({ outcome: "allow-once" });

  await manager.resolve(query());
  await manager.resolve(query({ callId: "tool_2" }));

  assert.equal(asked.length, 2, "the second identical request must ask again");
  assert.deepEqual(stored(), []);
});

test("always allow remembers, and only for that exact request", async () => {
  const { manager, asked, stored } = harness({ outcome: "allow-always" });

  assert.equal(await manager.resolve(query()), "allow");
  assert.deepEqual(stored(), ["shell.run::npm test"]);

  // Same command again: no prompt.
  assert.equal(await manager.resolve(query({ callId: "tool_2" })), "allow");
  assert.equal(asked.length, 1);

  // A different command is a different grant — "always allow" is not a blank
  // cheque for the tool.
  assert.equal(await manager.resolve(query({ callId: "tool_3", summary: "rm -rf /" })), "allow");
  assert.equal(asked.length, 2, "a command the user never saw must be asked about");
});

test("a grant key covers the arguments, not just the tool", () => {
  assert.notEqual(
    grantKey(query({ summary: "npm test" })),
    grantKey(query({ summary: "npm publish" })),
  );
});

test("a prompt that throws is a refusal, not an approval", async () => {
  const { manager } = harness({
    onAsk: () => {
      throw new Error("the dialog exploded");
    },
  });

  assert.equal(await manager.resolve(query()), "deny");
});

test("remembered approvals can be forgotten", async () => {
  const { manager, asked, stored } = harness({ outcome: "allow-always" });

  await manager.resolve(query());
  assert.equal(stored().length, 1);

  const forgotten = await manager.forgetAll();
  assert.equal(forgotten, 1);
  assert.deepEqual(stored(), []);

  await manager.resolve(query({ callId: "tool_9" }));
  assert.equal(asked.length, 2, "after forgetting, it must ask again");
});

test("the caller is told when a prompt opens and closes", async () => {
  const events = [];
  const { manager } = harness({
    outcome: "allow-once",
    onPromptOpen: () => events.push("open"),
    onPromptClose: () => events.push("close"),
  });

  await manager.resolve(query());
  assert.deepEqual(events, ["open", "close"]);

  // Reads never prompt, so they never pause anything.
  events.length = 0;
  await manager.resolve(query({ permission: "read" }));
  assert.deepEqual(events, []);
});

test("a prompt that throws still reports closing", async () => {
  const events = [];
  const { manager } = harness({
    onAsk: () => {
      throw new Error("boom");
    },
    onPromptOpen: () => events.push("open"),
    onPromptClose: () => events.push("close"),
  });

  await manager.resolve(query());
  assert.deepEqual(events, ["open", "close"], "a paused timeout must always be resumed");
});
