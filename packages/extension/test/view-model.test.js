const test = require("node:test");
const assert = require("node:assert/strict");

const { buildHops, isInFlight, progressLabel } = require("../out/ui/viewModel.js");

test("every hop is reported separately (spec §0I)", () => {
  const hops = buildHops({
    editor: "connected",
    provider: "ready",
    relay: "not-implemented",
    browser: "not-implemented",
    chatSurface: "not-implemented",
    providerName: "Mock (in-process)",
  });

  assert.deepEqual(
    hops.map((hop) => hop.label),
    ["Editor", "Provider", "Relay", "Browser", "Chat"],
  );
  assert.deepEqual(
    hops.map((hop) => hop.tone),
    ["ok", "ok", "absent", "absent", "absent"],
  );
});

test("unbuilt hops never read as connected", () => {
  const hops = buildHops({
    editor: "connected",
    provider: "error",
    relay: "not-implemented",
    browser: "not-implemented",
    chatSurface: "not-implemented",
    providerName: "Mock (in-process)",
  });

  const relay = hops.find((hop) => hop.label === "Relay");
  assert.equal(relay.tone, "absent");
  // The detail describes the machine, not the roadmap. It used to read
  // "not built yet — Phase 6" long after the relay shipped.
  assert.match(relay.detail, /127\.0\.0\.1/);
  assert.doesNotMatch(relay.detail, /not built yet|Phase/i);

  assert.equal(hops.find((hop) => hop.label === "Provider").tone, "bad");
});

test("progress narrates the hop the request is on", () => {
  assert.equal(progressLabel("IDLE"), "");
  assert.equal(progressLabel("CAPTURING_CONTEXT"), "Capturing editor context…");
  assert.equal(progressLabel("PROVIDER_PROCESSING"), "Waiting for a reply…");
  assert.equal(progressLabel("DELIVERED"), "Done.");
  assert.equal(progressLabel("TIMED_OUT"), "Timed out.");
});

test("in-flight states keep the composer busy", () => {
  assert.equal(isInFlight("IDLE"), false);
  assert.equal(isInFlight("SENDING"), true);
  assert.equal(isInFlight("PROVIDER_PROCESSING"), true);
  assert.equal(isInFlight("DELIVERED"), false);
  assert.equal(isInFlight("FAILED"), false);
});

/* ------------------------------------------------------------------ *
 * The setup action (spec §0X)
 * ------------------------------------------------------------------ */

const { setupAction } = require("../out/ui/viewModel.js");

const connections = (over = {}) => ({
  editor: "connected",
  provider: "ready",
  relay: "not-implemented",
  browser: "not-implemented",
  chatSurface: "not-implemented",
  providerName: "Mock (in-process)",
  ...over,
});

test("offers to start the stack when the relay is not in use", () => {
  const action = setupAction(connections());
  assert.equal(action.command, "startStack");
  assert.match(action.label, /Start relay \+ provider/);
  assert.match(action.hint, /No terminal needed/);
});

test("offers to start just the provider when the relay is up but nothing answers", () => {
  const action = setupAction(connections({ relay: "connected", provider: "disconnected" }));
  assert.equal(action.command, "startStack");
  assert.match(action.label, /Start provider process/);
  assert.match(action.hint, /nothing is answering/);
});

test("offers to stop once everything is connected", () => {
  const action = setupAction(connections({ relay: "connected", provider: "ready" }));
  assert.equal(action.command, "stopStack");
  assert.match(action.label, /Stop relay \+ provider/);
});

test("the action is derived from hop state, so it cannot disagree with the dots", () => {
  // A relay hop that is erroring is still "in use", so the offer is to fix the
  // far side rather than to start the relay again.
  const action = setupAction(connections({ relay: "error", provider: "disconnected" }));
  assert.match(action.label, /Start provider process/);
});

/* ------------------------------------------------------------------ *
 * The browser action
 *
 * The add-on's popup asks for a connection line and cannot produce one. If
 * the panel ever stops offering it, that paste box becomes a dead end with no
 * way out, so these pin the offer to hop state rather than to a screenshot.
 * ------------------------------------------------------------------ */

const { browserAction } = require("../out/ui/viewModel.js");

test("before the relay is in use, the browser route is the whole setup", () => {
  const action = browserAction(connections());
  assert.equal(action.command, "setupBrowser");
});

test("while the browser is missing, the offer is to look for it again", () => {
  // The add-on fetches its own credentials now, so handing the user a string
  // to carry would be offering work the machine already did.
  for (const relay of ["connected", "connecting", "error", "disconnected"]) {
    const action = browserAction(connections({ relay, browser: "disconnected" }));
    assert.equal(action.command, "setupBrowser", `relay=${relay}`);
    assert.match(
      action.hint,
      /safe to press|again/i,
      "it must read as safe to repeat — people press this when unsure",
    );
  }
});

test("once the browser is connected, nothing is offered", () => {
  // An action that changes nothing is clutter that teaches people to ignore
  // the panel.
  assert.equal(
    browserAction(connections({ relay: "connected", browser: "connected" })),
    undefined,
  );
});

test("there is always a way forward while the browser is not connected", () => {
  for (const relay of ["not-implemented", "connected", "connecting", "error", "disconnected"]) {
    assert.ok(
      browserAction(connections({ relay, browser: "disconnected" })),
      `no browser action for relay=${relay}`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * The next step
 *
 * The hops answer "what is the state of each part". This answers the question
 * people actually arrive with: can I type yet, and if not, what do I press?
 * ------------------------------------------------------------------ */

const { nextStep } = require("../out/ui/viewModel.js");

test("modes that need no setup say so instead of staying silent", () => {
  const step = nextStep(connections({ relay: "not-implemented" }));
  assert.equal(step.tone, "ok");
  assert.match(step.message, /Ready/);
});

test("each missing piece names the piece, in the order it is needed", () => {
  assert.match(nextStep(connections({ relay: "connecting" })).message, /relay/i);

  assert.match(
    nextStep(connections({ relay: "connected", browser: "disconnected" })).message,
    /add-on/i,
  );

  assert.match(
    nextStep(connections({ relay: "connected", browser: "connected", chatSurface: "disconnected" }))
      .message,
    /chat tab/i,
  );
});

test("a working stack says ready, not a list of green dots", () => {
  const step = nextStep(
    connections({ relay: "connected", browser: "connected", chatSurface: "ready" }),
  );
  assert.equal(step.tone, "ok");
  assert.match(step.message, /Ready/);
});

test("the tone separates waiting from something the user must do", () => {
  assert.equal(nextStep(connections({ relay: "connecting" })).tone, "waiting");
  assert.equal(
    nextStep(connections({ relay: "connected", browser: "disconnected" })).tone,
    "action",
  );
});

/* ------------------------------------------------------------------ *
 * Diagnostics (spec §44)
 * ------------------------------------------------------------------ */

const { buildDiagnosticsReport } = require("../out/diagnostics/report.js");

test("the diagnostics report names every hop and gate", () => {
  const report = buildDiagnosticsReport({
    extensionVersion: "0.1.0",
    protocolVersion: 1,
    transport: "relay",
    relayPort: 43123,
    connections: connections({ relay: "connected", provider: "ready" }),
    requestState: "IDLE",
    sessionId: "session_x",
    sessionMessages: 4,
    workspaceRoots: ["/Users/kobby/dev/job-agent"],
    tools: [{ name: "shell.run", description: "", permission: "execute" }],
    capabilities: { runCommand: true, readFile: false },
    permissionMode: "strict-coach",
    permissionPolicy: { read: "allow", execute: "ask", write: "deny", destructive: "deny" },
    rememberedApprovals: 2,
    searchBackend: "ripgrep",
    ripgrepPath: "/Applications/x/rg",
    mediaDir: "/tmp/.coach/media",
    attachmentsStaged: 1,
    envAllowlist: ["PATH", "HOME"],
  });

  // Every hop, because "it doesn't answer" is the same symptom for all of them.
  for (const hop of ["Editor:", "Provider:", "Relay:", "Browser:", "Chat surface:"]) {
    assert.match(report, new RegExp(hop));
  }

  assert.match(report, /Transport:\s+relay/);
  assert.match(report, /execute\s+shell\.run/);
  assert.match(report, /Mode:\s+strict-coach/);
  assert.match(report, /Remembered:\s+2 approval/);
  assert.match(report, /Backend:\s+ripgrep/);
  assert.match(report, /PATH, HOME/);
});

test("the report says plainly when there is no workspace", () => {
  const report = buildDiagnosticsReport({
    extensionVersion: "0.1.0",
    protocolVersion: 1,
    transport: "in-process",
    relayPort: 43123,
    connections: connections(),
    requestState: "IDLE",
    sessionId: "s",
    sessionMessages: 0,
    workspaceRoots: [],
    tools: [],
    capabilities: {},
    permissionMode: "strict-coach",
    permissionPolicy: { read: "allow", execute: "ask", write: "deny", destructive: "deny" },
    rememberedApprovals: 0,
    searchBackend: "node traversal",
    mediaDir: "/tmp",
    attachmentsStaged: 0,
    envAllowlist: [],
  });

  // The exact condition that made workspace tools fail silently in real use.
  assert.match(report, /no folder open — workspace tools will refuse/);
  assert.match(report, /not found — regex search will be refused/);
});

/* ------------------------------------------------------------------ *
 * Where settings are written
 * ------------------------------------------------------------------ */

const { configScope, workspaceToolsAvailable } = require("../out/config/scope.js");

test("settings go to the workspace when there is one, and globally when there is not", () => {
  // Writing to Workspace settings in a folderless window throws, which is how
  // "Start relay + provider" failed with an error about settings rather than
  // anything to do with the relay.
  assert.equal(configScope(true), "workspace");
  assert.equal(configScope(false), "global");
});

test("workspace tools need a folder", () => {
  assert.equal(workspaceToolsAvailable(true), true);
  assert.equal(workspaceToolsAvailable(false), false);
});

/* ------------------------------------------------------------------ *
 * The model button
 *
 * A router hidden in the command palette is a router nobody uses, so the
 * current choice is always on the composer. These pin what it says, because a
 * label that lies about which chat will answer is worse than no label.
 * ------------------------------------------------------------------ */

const { modelChoice } = require("../out/ui/viewModel.js");

const surface = (id, label, status = "ready") => ({ id, label, status });

test("with nothing chosen and one chat connected, it names that chat", () => {
  // Naming the chat is more use than naming the policy: "ChatGPT" tells you
  // what will happen, "Auto" only tells you a rule exists.
  const choice = modelChoice(undefined, [surface("chatgpt", "ChatGPT")]);
  assert.equal(choice.label, "ChatGPT");
  assert.equal(choice.connected, true);
});

test("with several connected it says how many, not which", () => {
  const choice = modelChoice(undefined, [
    surface("chatgpt", "ChatGPT"),
    surface("claude", "Claude"),
  ]);
  assert.equal(choice.label, "2 chats");
  assert.equal(choice.connected, true);
});

test("with nothing connected it asks to be pressed", () => {
  const choice = modelChoice(undefined, []);
  assert.equal(choice.label, "Pick a chat");
  assert.equal(choice.connected, false);
});

test("a chosen chat is named even before it connects", () => {
  // The user asked for Claude and a tab is opening; showing anything else
  // would look like the choice was ignored.
  const choice = modelChoice("claude", []);
  assert.equal(choice.label, "Claude");
  assert.equal(choice.connected, false, "and it must not claim to be ready");
});

test("a chosen chat that is connected says so", () => {
  const choice = modelChoice("claude", [surface("claude", "Claude")]);
  assert.equal(choice.connected, true);
});

test("a chat that has been lost stops reading as connected", () => {
  const choice = modelChoice("claude", [surface("claude", "Claude", "closed")]);
  assert.equal(choice.label, "Claude");
  assert.equal(choice.connected, false);
});

/* ------------------------------------------------------------------ *
 * The picker's rows
 * ------------------------------------------------------------------ */

const { providerRows } = require("../out/ui/viewModel.js");

test("every provider is listed, connected or not", () => {
  // Hiding the unconnected ones would hide the feature: the add-on opens them.
  const rows = providerRows(undefined, []);
  assert.ok(rows.length >= 8);
  assert.ok(rows.every((row) => row.connected === false));
  assert.ok(rows.some((row) => row.id === "claude" && row.label === "Claude"));
});

test("connection state is shown, not used to filter", () => {
  const rows = providerRows(undefined, [{ id: "gemini", status: "ready" }]);
  assert.equal(rows.find((row) => row.id === "gemini").connected, true);
  assert.equal(rows.find((row) => row.id === "claude").connected, false);
  assert.equal(rows.length, providerRows(undefined, []).length, "nothing is dropped");
});

test("a lost chat does not read as connected", () => {
  const rows = providerRows(undefined, [{ id: "gemini", status: "closed" }]);
  assert.equal(rows.find((row) => row.id === "gemini").connected, false);
});

test("a policy-blocked chat stays visible and explains why it cannot be selected", () => {
  const rows = providerRows(undefined, [
    {
      id: "deepseek",
      status: "blocked",
      detail: "This browser blocks add-ons from controlling DeepSeek.",
    },
  ]);
  const deepseek = rows.find((row) => row.id === "deepseek");

  assert.equal(deepseek.connected, false);
  assert.equal(deepseek.blocked, true);
  assert.match(deepseek.detail, /browser blocks add-ons/i);
});

test("the chosen row is marked so the sheet can show it", () => {
  const rows = providerRows("claude", []);
  assert.equal(rows.filter((row) => row.chosen).length, 1);
  assert.equal(rows.find((row) => row.chosen).id, "claude");
});

test("every row carries a logo and an initial to fall back to", () => {
  // A logo that fails to load must leave a readable tile rather than a hole,
  // so the letter is not optional even now that logos ship.
  for (const row of providerRows(undefined, [])) {
    assert.match(row.logo, /\.(svg|png|ico)$/, `${row.id} needs a logo file`);
    assert.ok(row.initial.length >= 1 && row.initial.length <= 2, `${row.id} initial too long`);
  }
});

test("the providers that need crisp small marks use scalable assets", () => {
  const rows = providerRows(undefined, []);
  for (const id of ["claude", "gemini", "deepseek", "mistral", "zai"]) {
    assert.match(rows.find((row) => row.id === id).logo, /\.svg$/, `${id} should use SVG`);
  }
});

test("every logo the catalogue names is actually shipped", () => {
  // The catalogue is the only place a filename is written, so a typo here is
  // a broken image nobody notices until a screenshot.
  const dir = require("node:path").join(__dirname, "..", "media", "logos");
  const present = new Set(require("node:fs").readdirSync(dir));

  for (const row of providerRows(undefined, [])) {
    assert.ok(present.has(row.logo), `media/logos/${row.logo} is missing`);
  }
});
