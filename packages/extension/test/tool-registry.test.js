const test = require("node:test");
const assert = require("node:assert/strict");

const { ToolRegistry } = require("../out/tools/ToolRegistry.js");
const { ToolExecutionError } = require("../out/tools/ToolExecutionError.js");

function makeCall(tool, args, id = "tool_1") {
  return { type: "tool.call", id, sessionId: "session_test", tool, arguments: args };
}

function echoTool(overrides = {}) {
  return {
    name: "test.echo",
    description: "Echoes its argument.",
    permission: "read",
    timeoutMs: 1000,
    validate: (args) => {
      if (typeof args !== "object" || args === null || typeof args.value !== "string") {
        throw new ToolExecutionError("INVALID_ARGUMENT", '"value" must be a string.');
      }
      return { value: args.value };
    },
    execute: async (args) => ({ echoed: args.value }),
    ...overrides,
  };
}

test("executes a registered tool and reports duration", async () => {
  const registry = new ToolRegistry({ resolvePermission: () => "allow" });
  registry.register(echoTool());

  const result = await registry.execute(makeCall("test.echo", { value: "hi" }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.result, { echoed: "hi" });
  assert.equal(typeof result.durationMs, "number");
  assert.equal(result.id, "tool_1");
});

test("an unknown tool is refused, and says what does exist", async () => {
  const registry = new ToolRegistry({ resolvePermission: () => "allow" });
  registry.register(echoTool());

  const result = await registry.execute(makeCall("workspace.delete_everything", {}));

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNSUPPORTED");
  assert.match(result.error.message, /Available: test\.echo/);
});

test("permission is checked before arguments are even validated (spec §75)", async () => {
  let executed = false;
  const registry = new ToolRegistry({ resolvePermission: () => "deny" });
  registry.register(echoTool({ execute: async () => ((executed = true), {}) }));

  const result = await registry.execute(makeCall("test.echo", { value: "hi" }));

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PERMISSION_DENIED");
  assert.equal(executed, false);
});

test("a resolver that fails to decide is treated as a refusal", async () => {
  // "ask" is a question, not an answer. Anything that is not an explicit
  // "allow" must fail closed.
  const registry = new ToolRegistry({ resolvePermission: () => "ask" });
  registry.register(echoTool({ permission: "execute" }));

  const result = await registry.execute(makeCall("test.echo", { value: "hi" }));

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PERMISSION_DENIED");
  assert.match(result.error.message, /did not approve/);
});

test("the permission decision receives what the user will be shown", async () => {
  const seen = [];
  const registry = new ToolRegistry({
    resolvePermission: (request) => {
      seen.push(request);
      return "allow";
    },
  });
  registry.register(
    echoTool({ name: "shell.run", permission: "execute", validate: () => ({}) }),
  );

  await registry.execute(makeCall("shell.run", { command: "npm test" }, "tool_cmd"));

  assert.equal(seen.length, 1);
  assert.equal(seen[0].tool, "shell.run");
  assert.equal(seen[0].permission, "execute");
  assert.equal(seen[0].summary, "npm test", "the dialog must show the actual command");
  assert.equal(seen[0].callId, "tool_cmd");
});

test("the tool timeout does not start until the human has decided", async () => {
  // A 20ms tool timeout and a 150ms deliberation: if the clock ran during the
  // prompt, this would time out instead of succeeding.
  const registry = new ToolRegistry({
    resolvePermission: async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return "allow";
    },
  });
  registry.register(
    echoTool({
      permission: "execute",
      timeoutMs: 20,
      validate: () => ({}),
      execute: async () => ({ ran: true }),
    }),
  );

  const result = await registry.execute(makeCall("test.echo", {}));

  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result.error)}`);
  assert.deepEqual(result.result, { ran: true });
});

test("invalid arguments never reach execute", async () => {
  let executed = false;
  const registry = new ToolRegistry({ resolvePermission: () => "allow" });
  registry.register(echoTool({ execute: async () => ((executed = true), {}) }));

  const result = await registry.execute(makeCall("test.echo", { value: 42 }));

  assert.equal(result.error.code, "INVALID_ARGUMENT");
  assert.equal(executed, false);
});

test("a tool that hangs is timed out and aborted (spec §47)", async () => {
  const registry = new ToolRegistry({ resolvePermission: () => "allow" });
  let abortedSignal;

  registry.register(
    echoTool({
      timeoutMs: 20,
      validate: () => ({}),
      execute: async (_args, context) => {
        abortedSignal = context.signal;
        return new Promise(() => {});
      },
    }),
  );

  const result = await registry.execute(makeCall("test.echo", {}));

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "TIMEOUT");
  assert.equal(abortedSignal.aborted, true, "the tool is told to stop, not left running");
});

test("an unexpected throw becomes INTERNAL without leaking internals (spec §48)", async () => {
  const registry = new ToolRegistry({ resolvePermission: () => "allow" });
  registry.register(
    echoTool({
      validate: () => ({}),
      execute: async () => {
        throw new Error("ENOENT: /Users/kobby/.ssh/id_rsa not found");
      },
    }),
  );

  const result = await registry.execute(makeCall("test.echo", {}));

  assert.equal(result.error.code, "INTERNAL");
  assert.equal(result.error.message, "The tool failed unexpectedly.");
  assert.doesNotMatch(result.error.message, /id_rsa/);
});

test("a duplicate call id returns the cached result and does not rerun (spec §84)", async () => {
  const registry = new ToolRegistry({ resolvePermission: () => "allow" });
  let runs = 0;

  registry.register(
    echoTool({
      validate: () => ({}),
      execute: async () => ({ runs: (runs += 1) }),
    }),
  );

  const first = await registry.execute(makeCall("test.echo", {}, "tool_same"));
  const second = await registry.execute(makeCall("test.echo", {}, "tool_same"));

  assert.equal(runs, 1);
  assert.deepEqual(second.result, first.result);
});

test("capabilities are derived from what is registered, not hand-written", async () => {
  const registry = new ToolRegistry({ resolvePermission: () => "allow" });
  assert.deepEqual(registry.getCapabilities(), {
    readActiveDocument: false,
    readFile: false,
    searchFiles: false,
    listDirectory: false,
    projectTree: false,
    readDiagnostics: false,
    runCommand: false,
    attachments: false,
  });

  registry.register(echoTool({ name: "editor.active_document" }));
  assert.equal(registry.getCapabilities().readActiveDocument, true);
  assert.equal(registry.getCapabilities().runCommand, false);

  assert.deepEqual(registry.list(), [
    { name: "editor.active_document", description: "Echoes its argument.", permission: "read" },
  ]);
});

test("registering the same tool twice is a programming error", () => {
  const registry = new ToolRegistry({ resolvePermission: () => "allow" });
  registry.register(echoTool());
  assert.throws(() => registry.register(echoTool()), /already registered/);
});
