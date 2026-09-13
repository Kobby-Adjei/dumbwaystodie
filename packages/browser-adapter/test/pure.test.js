const test = require("node:test");
const assert = require("node:assert/strict");
const { build } = require("esbuild");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

/**
 * The testable half of a browser extension.
 *
 * DOM driving cannot be verified without a browser, so the logic that decides
 * *when* things are done and *what* counts as valid is kept pure and tested
 * here. What remains unverified is stated in the README rather than implied to
 * be covered.
 */

let mod;
let clean;
let picker;

test.before(async () => {
  // Bundle to CJS so the browser-targeted sources can be required directly.
  const out = path.join(os.tmpdir(), `dwtd-pure-${Date.now()}.cjs`);
  await build({
    entryPoints: [path.join(__dirname, "..", "src", "surfaces", "quiescence.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile: out,
    logLevel: "silent",
  });
  const shared = path.join(os.tmpdir(), `dwtd-shared-${Date.now()}.cjs`);
  await build({
    entryPoints: [path.join(__dirname, "..", "src", "shared", "messages.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile: shared,
    logLevel: "silent",
  });
  const surface = path.join(os.tmpdir(), `dwtd-surface-${Date.now()}.cjs`);
  await build({
    entryPoints: [path.join(__dirname, "..", "src", "surfaces", "ChatSurfaceAdapter.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile: surface,
    logLevel: "silent",
  });

  const pairing = path.join(os.tmpdir(), `dwtd-pairing-${Date.now()}.cjs`);
  await build({
    entryPoints: [path.join(__dirname, "..", "src", "shared", "pairing.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile: pairing,
    logLevel: "silent",
  });

  const cleanOut = path.join(os.tmpdir(), `dwtd-clean-${Date.now()}.cjs`);
  await build({
    entryPoints: [path.join(__dirname, "..", "src", "surfaces", "cleanReply.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile: cleanOut,
    logLevel: "silent",
  });
  clean = require(cleanOut);

  const pickerOut = path.join(os.tmpdir(), `dwtd-picker-${Date.now()}.cjs`);
  await build({
    entryPoints: [path.join(__dirname, "..", "src", "surfaces", "modelPicker.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile: pickerOut,
    logLevel: "silent",
  });
  picker = require(pickerOut);

  const chatgpt = path.join(os.tmpdir(), `dwtd-surfaces-${Date.now()}.cjs`);
  await build({
    entryPoints: [path.join(__dirname, "..", "src", "surfaces", "ConfiguredChatSurface.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile: chatgpt,
    logLevel: "silent",
  });

  const sendBtn = path.join(os.tmpdir(), `dwtd-send-${Date.now()}.cjs`);
  await build({
    entryPoints: [path.join(__dirname, "..", "src", "surfaces", "sendButton.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile: sendBtn,
    logLevel: "silent",
  });

  const discovery = path.join(os.tmpdir(), `dwtd-discovery-${Date.now()}.cjs`);
  await build({
    entryPoints: [path.join(__dirname, "..", "src", "surfaces", "discovery.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile: discovery,
    logLevel: "silent",
  });

  const sites = path.join(os.tmpdir(), `dwtd-sites-${Date.now()}.cjs`);
  await build({
    entryPoints: [path.join(__dirname, "..", "src", "surfaces", "sites.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile: sites,
    logLevel: "silent",
  });

  mod = {
    ...require(out),
    ...require(shared),
    ...require(surface),
    ...require(pairing),
    ...require(chatgpt),
    ...require(sites),
    ...require(sendBtn),
    ...require(discovery),
  };
  for (const file of [out, shared, surface, pairing, chatgpt, sites, sendBtn, discovery]) {
    fs.rmSync(file, { force: true });
  }
});

/* ------------------------------------------------------------------ *
 * Probing a chat page
 *
 * `probe` takes a root so its reasoning can be checked without a browser.
 * These use a stand-in that answers querySelector from a list of selectors it
 * claims to have — enough to pin the decisions, not a claim to emulate a DOM.
 * ------------------------------------------------------------------ */

const chatgptSurface = () => mod.ConfiguredChatSurface.forUrl("https://chatgpt.com/c/1");

function fakeRoot(present) {
  const has = (selector) => present.includes(selector);
  return {
    querySelector: (selector) => (has(selector) ? { selector } : null),
    querySelectorAll: (selector) => (has(selector) ? [{ selector }] : []),
  };
}

const COMPOSER = "#prompt-textarea";
const REPLY = '[data-message-author-role="assistant"]';

test("an empty composer with no send button is still fully deliverable", () => {
  // The bug this pins: ChatGPT only renders the send button once there is
  // text, and a probe runs before anything is typed. Requiring the button
  // made every healthy page report "some steps left to you".
  const state = chatgptSurface().probe(fakeRoot([COMPOSER, REPLY]));

  assert.equal(state.deliver.rung, "auto");
  assert.equal(state.deliver.reason, undefined);
  assert.equal(state.observe.rung, "auto");
});

test("no composer is the one thing that makes delivery assisted", () => {
  const state = chatgptSurface().probe(fakeRoot([REPLY]));

  assert.equal(state.deliver.rung, "assisted");
  assert.match(state.deliver.reason, /message box/);
});

test("a fresh chat is not told its replies need copying by hand", () => {
  // An empty conversation has no replies to find, and that says nothing about
  // whether they can be read later. Reporting "assisted" here told users the
  // bridge was half-broken before they had sent a single message.
  const state = chatgptSurface().probe(fakeRoot([COMPOSER]));

  assert.equal(state.deliver.rung, "auto");
  assert.equal(state.observe.rung, "auto");
  assert.equal(state.observe.reason, undefined, "no claim without evidence");
});

/* ------------------------------------------------------------------ *
 * The site table — one row per chat, shared mechanics
 * ------------------------------------------------------------------ */

test("a known host gets its own selectors", () => {
  assert.equal(mod.siteFor("https://chatgpt.com/c/1").surfaceType, "chatgpt");
  assert.equal(mod.siteFor("https://claude.ai/chat/1").surfaceType, "claude");
  assert.equal(mod.siteFor("https://gemini.google.com/app").surfaceType, "gemini");
  assert.equal(mod.isKnownSite("https://chatgpt.com/c/1"), true);
});

test("a lookalike host gets no site's selectors", () => {
  assert.equal(mod.isKnownSite("https://chatgpt.com.evil.test/"), false);
  assert.equal(mod.isKnownSite("not a url"), false);
});

test("an unknown host still gets a usable surface, not a refusal", () => {
  // The mechanics do not depend on recognising the site, and a page the
  // add-on was granted is a page the user chose. Refusing here would be a
  // limit invented by this file rather than one the browser imposes.
  const config = mod.siteFor("https://chat.example.com/x");

  assert.equal(config.surfaceType, "chat");
  assert.ok(config.composer.length > 0, "generic selectors are still offered");

  const state = mod.ConfiguredChatSurface.forUrl("https://chat.example.com/x").probe(
    fakeRoot(['div[contenteditable="true"]']),
  );
  assert.equal(state.deliver.rung, "auto");
});

test("every site inherits the generic fallbacks after its own selectors", () => {
  for (const site of mod.CHAT_SITES) {
    assert.ok(
      site.composer.includes("textarea"),
      `${site.surfaceType} should fall back to a plain textarea`,
    );
    assert.ok(site.send.some((selector) => /submit/.test(selector)));
    assert.ok(site.hosts.length > 0, `${site.surfaceType} must claim at least one host`);
  }
});

const manifest = () =>
  JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "manifest.json"), "utf8"));

test("the content script runs on exactly the sites the table names", () => {
  // Two copies of this list is how "supported on paper, ignored at runtime"
  // happens, so the manifest is generated from the table and checked here.
  assert.deepEqual(manifest().content_scripts[0].matches, mod.matchPatternsForKnownSites());
});

test("the add-on may reach the relay on loopback", () => {
  /*
   * The bug this pins: `/pair` sends no CORS headers on purpose, so a web page
   * cannot read the token. That only leaves the add-on a way in if loopback is
   * in `host_permissions` — extension fetches to permitted origins bypass
   * CORS, and everything else is an ordinary cross-origin request that Chrome
   * rejects. Without this line, discovery could never work, and the symptom
   * was the least informative one possible: "No editor answered."
   */
  const hosts = manifest().host_permissions;
  assert.ok(hosts.includes("http://127.0.0.1/*"), "127.0.0.1 must be permitted");
  assert.ok(hosts.includes("http://localhost/*"), "localhost is the same relay by another name");
});

test("every chat site is also permitted, not just script-injected", () => {
  const hosts = manifest().host_permissions;
  for (const pattern of mod.matchPatternsForKnownSites()) {
    assert.ok(hosts.includes(pattern), `${pattern} must be in host_permissions`);
  }
});

/* ------------------------------------------------------------------ *
 * Pairing — why the button did or did not do anything
 * ------------------------------------------------------------------ */

const ORIGINS = ["https://chatgpt.com/*", "https://chat.openai.com/*"];

test("only the origins the add-on was granted count as chat pages", () => {
  assert.equal(mod.isChatUrl("https://chatgpt.com/c/abc", ORIGINS), true);
  assert.equal(mod.isChatUrl("https://chatgpt.com/", ORIGINS), true);
  assert.equal(mod.isChatUrl("https://chat.openai.com/c/1", ORIGINS), true);

  assert.equal(mod.isChatUrl("https://claude.ai/chat/1", ORIGINS), false);
  assert.equal(mod.isChatUrl("https://example.com/", ORIGINS), false);
});

test("a lookalike host does not pass as the real one", () => {
  // The check is a prefix test, so the separator matters: without it,
  // "chatgpt.com.evil.test" would be accepted as chatgpt.com.
  assert.equal(mod.isChatUrl("https://chatgpt.com.evil.test/c/1", ORIGINS), false);
  assert.equal(mod.isChatUrl("https://notchatgpt.com/", ORIGINS), false);
  assert.equal(mod.isChatUrl("http://chatgpt.com/c/1", ORIGINS), false, "http is not https");
});

test("the refusal names the page that would work", () => {
  assert.equal(mod.describeOrigins(ORIGINS), "chatgpt.com or chat.openai.com");
});

const surfaceState = (over = {}) => ({
  identify: { rung: "auto" },
  deliver: { rung: "auto" },
  observe: { rung: "auto" },
  ...over,
});

test("a fully working page says so plainly", () => {
  assert.match(mod.summarizeSurface(surfaceState()), /can be driven from your editor/);
});

test("pairing does not claim the bridge works when delivery is broken", () => {
  // The failure this prevents: "paired" is reported, sending silently does
  // nothing, and the user goes looking in the editor for a fault on the page.
  const text = mod.summarizeSurface(
    surfaceState({ deliver: { rung: "unavailable", reason: "no composer found" } }),
  );

  assert.match(text, /cannot be placed/);
  assert.match(text, /no composer found/, "the surface's own reason reaches the user");
  assert.doesNotMatch(text, /can be driven/);
});

test("a readable page that cannot be read back says which half is manual", () => {
  const text = mod.summarizeSurface(
    surfaceState({ observe: { rung: "assisted", reason: "replies render off-screen" } }),
  );
  assert.match(text, /copying by hand/);
  assert.match(text, /off-screen/);
});

/* ------------------------------------------------------------------ *
 * Completion detection — the usual guess, made explicit
 * ------------------------------------------------------------------ */

test("a closed protocol block ends the wait quickly, and certainly", () => {
  const text = 'Let me look.\n\n```dwtd\n{"v":1,"type":"tool.call","id":"a","tool":"t"}\n```';

  const still = mod.judgeCompletion({ text, msSinceLastChange: 0, msSinceStart: 10 });
  assert.equal(still.complete, false, "a second block may still be coming");

  const settled = mod.judgeCompletion({
    text,
    msSinceLastChange: mod.CLOSED_BLOCK_IDLE_MS + 1,
    msSinceStart: 900,
  });
  assert.equal(settled.complete, true);
  assert.equal(settled.reason, "closed-block");
  assert.equal(settled.certain, true, "a fence is a fact, not an inference");

  assert.ok(
    mod.CLOSED_BLOCK_IDLE_MS < mod.DEFAULT_IDLE_MS,
    "and it is still much faster than waiting out prose",
  );
});

test("one finished block does not end a reply that is writing another", () => {
  /*
   * The failure this pins. A chat asked to read three files writes three
   * blocks. Treating the first closed fence as the ending returned after one,
   * so the other two calls were never seen — and the chat, having asked for
   * three things and been answered about one, has no way to notice.
   */
  const oneDoneOneStarting = [
    '```dwtd',
    '{"v":1,"type":"tool.call","id":"a","tool":"workspace.read_file"}',
    '```',
    '',
    '```dwtd',
    '{"v":1,"type":"tool.call","id":"b"',
  ].join("\n");

  const verdict = mod.judgeCompletion({
    text: oneDoneOneStarting,
    msSinceLastChange: 5000,
    msSinceStart: 8000,
  });

  assert.equal(verdict.complete, false, "the second block is still open");
  assert.equal(mod.endsInsideBlock(oneDoneOneStarting), true);
});

test("two finished blocks are an ending, once they stop growing", () => {
  const both = [
    '```dwtd',
    '{"v":1,"type":"tool.call","id":"a","tool":"t"}',
    '```',
    '',
    '```dwtd',
    '{"v":1,"type":"tool.call","id":"b","tool":"t"}',
    '```',
  ].join("\n");

  assert.equal(mod.endsInsideBlock(both), false);
  const verdict = mod.judgeCompletion({
    text: both,
    msSinceLastChange: mod.CLOSED_BLOCK_IDLE_MS + 1,
    msSinceStart: 2000,
  });
  assert.equal(verdict.complete, true);
  assert.equal(verdict.reason, "closed-block");
});

test("a reply mid-block is not ended by the prose window either", () => {
  // Silence inside an unfinished block means a stalled render, not an answer.
  const verdict = mod.judgeCompletion({
    text: '```dwtd\n{"v":1,"type":"tool.call"',
    msSinceLastChange: mod.DEFAULT_IDLE_MS + 5000,
    msSinceStart: 10_000,
  });
  assert.equal(verdict.complete, false);
});

test("an unclosed block is not treated as finished", () => {
  const text = '```dwtd\n{"v":1,"type":"tool.call"';
  const verdict = mod.judgeCompletion({ text, msSinceLastChange: 50, msSinceStart: 100 });
  assert.equal(verdict.complete, false, "still streaming the block");
});

test("prose completes on silence, and says it is only inferring", () => {
  const going = mod.judgeCompletion({ text: "Because the form", msSinceLastChange: 200, msSinceStart: 900 });
  assert.equal(going.complete, false);

  const settled = mod.judgeCompletion({
    text: "Because the form submits.",
    msSinceLastChange: mod.DEFAULT_IDLE_MS + 100,
    msSinceStart: 6000,
  });
  assert.equal(settled.complete, true);
  assert.equal(settled.reason, "idle");
  assert.equal(settled.certain, false, "silence is a guess and must not claim otherwise");
});

test("a pause mid-answer is not the end of the answer", () => {
  /*
   * The bug this pins: the settle window was 900ms, and chats pause longer
   * than that between paragraphs and while code blocks render. Every such
   * pause was read as "finished", cutting replies off mid-sentence — and the
   * user had no way to know text was missing.
   */
  const pausing = mod.judgeCompletion({
    text: "Binary search halves the range. Now",
    msSinceLastChange: 1200,
    msSinceStart: 4000,
  });

  assert.equal(pausing.complete, false, "1.2s of silence is a pause, not an ending");
  assert.ok(mod.DEFAULT_IDLE_MS >= 2000, "the window has to be longer than a rendering pause");
});

test("silence with no text at all is not an answer", () => {
  const verdict = mod.judgeCompletion({ text: "   ", msSinceLastChange: 5000, msSinceStart: 6000 });
  assert.equal(verdict.complete, false, "a reply that never started is not a reply that finished");
});

test("it gives up rather than waiting forever", () => {
  const verdict = mod.judgeCompletion({
    text: "still going",
    msSinceLastChange: 10,
    msSinceStart: 200_000,
  });
  assert.equal(verdict.complete, true);
  assert.equal(verdict.reason, "timeout");
  assert.equal(verdict.certain, false);
});

test("a stop control vetoes only an idle guess, never a certain or timed-out ending", () => {
  const idle = mod.judgeCompletion({
    text: "The answer is quiet now.",
    msSinceLastChange: mod.DEFAULT_IDLE_MS + 1,
    msSinceStart: 5000,
  });
  assert.equal(mod.shouldAcceptCompletion(idle, true), false);
  assert.equal(mod.shouldAcceptCompletion(idle, false), true);

  const closed = mod.judgeCompletion({
    text: '```dwtd\n{"v":1,"type":"tool.call","id":"a","tool":"t"}\n```',
    msSinceLastChange: mod.CLOSED_BLOCK_IDLE_MS + 1,
    msSinceStart: 900,
  });
  assert.equal(mod.shouldAcceptCompletion(closed, true), true);

  const timedOut = mod.judgeCompletion({
    text: "A stale stop control cannot own the request forever.",
    msSinceLastChange: 0,
    msSinceStart: mod.DEFAULT_MAX_WAIT_MS + 1,
  });
  assert.equal(mod.shouldAcceptCompletion(timedOut, true), true);
});

test("hidden or non-rendered controls are not visibly operable", () => {
  const visible = {
    hidden: false,
    ariaHidden: false,
    display: "block",
    visibility: "visible",
    opacity: 1,
    rectCount: 1,
  };

  assert.equal(mod.isVisiblyRendered(visible), true);
  for (const hidden of [
    { ...visible, hidden: true },
    { ...visible, ariaHidden: true },
    { ...visible, display: "none" },
    { ...visible, visibility: "hidden" },
    { ...visible, opacity: 0 },
    { ...visible, rectCount: 0 },
  ]) {
    assert.equal(mod.isVisiblyRendered(hidden), false);
  }
});

/* ------------------------------------------------------------------ *
 * Capability rungs
 * ------------------------------------------------------------------ */

test("a chain is only as automatic as its weakest link", () => {
  assert.equal(mod.combineRungs([{ rung: "auto" }, { rung: "auto" }]), "auto");
  assert.equal(mod.combineRungs([{ rung: "auto" }, { rung: "assisted" }]), "assisted");
  assert.equal(mod.combineRungs([{ rung: "assisted" }, { rung: "unavailable" }]), "unavailable");
});

/* ------------------------------------------------------------------ *
 * Credentials
 * ------------------------------------------------------------------ */

test("only well-formed relay details are accepted", () => {
  const good = mod.parseCredentials('{"host":"127.0.0.1","port":43123,"token":"0123456789abcdef0123"}');
  assert.equal(good.port, 43123);
  assert.equal(good.host, "127.0.0.1");

  for (const bad of [
    "",
    "not json",
    "{}",
    '{"host":"127.0.0.1","port":"43123","token":"0123456789abcdef"}',
    '{"host":"127.0.0.1","port":43123,"token":"short"}',
    '{"port":43123,"token":"0123456789abcdef0123"}',
  ]) {
    assert.equal(mod.parseCredentials(bad), undefined, `should refuse: ${bad}`);
  }
});


/* ------------------------------------------------------------------ *
 * Which button sends
 *
 * The bug these exist for: inside a <form>, Material-style buttons default to
 * type="submit", so `form button[type="submit"]` matched the overflow menu
 * and the add-on clicked the three dots instead of the arrow.
 * ------------------------------------------------------------------ */

const candidate = (over = {}) => ({
  label: "",
  selectorIndex: 0,
  disabled: false,
  visible: true,
  ...over,
});

test("a menu button is never clicked, however well it matched", () => {
  // A veto, not a penalty: the fallback is Enter, which costs nothing, while
  // opening a menu interrupts the user.
  for (const label of ["More options", "Menu", "Attach file", "Upload image", "Microphone", "Stop"]) {
    assert.equal(
      mod.scoreSendCandidate(candidate({ label })),
      undefined,
      `"${label}" must be refused`,
    );
  }
});

test("a button that says send beats an unlabelled one that matched first", () => {
  const chosen = mod.chooseSendCandidate([
    candidate({ label: "More options", selectorIndex: 0 }),
    candidate({ label: "", selectorIndex: 1 }),
    candidate({ label: "Send message", selectorIndex: 3 }),
  ]);

  assert.equal(chosen, 2, "the label decides, not the document order");
});

test("an unlabelled arrow is still usable when nothing says send", () => {
  // Plenty of send controls are a bare icon; refusing those breaks real chats.
  const chosen = mod.chooseSendCandidate([candidate({ label: "" })]);
  assert.equal(chosen, 0);
});

test("hidden and disabled buttons are not candidates", () => {
  assert.equal(mod.scoreSendCandidate(candidate({ label: "Send", visible: false })), undefined);
  assert.equal(mod.scoreSendCandidate(candidate({ label: "Send", disabled: true })), undefined);
  assert.equal(mod.chooseSendCandidate([candidate({ label: "Send", disabled: true })]), undefined);
});

test("with nothing but menu buttons, it chooses none rather than the wrong one", () => {
  const chosen = mod.chooseSendCandidate([
    candidate({ label: "More options" }),
    candidate({ label: "Attach" }),
  ]);
  assert.equal(chosen, undefined, "no button is better than the wrong button");
});

test("ties break towards the last, where the send control sits in a toolbar", () => {
  const chosen = mod.chooseSendCandidate([
    candidate({ label: "", selectorIndex: 2 }),
    candidate({ label: "", selectorIndex: 2 }),
  ]);
  assert.equal(chosen, 1);
});

test("a site's own selector outranks a generic fallback, all else equal", () => {
  const chosen = mod.chooseSendCandidate([
    candidate({ label: "", selectorIndex: 0 }),
    candidate({ label: "", selectorIndex: 5 }),
  ]);
  assert.equal(chosen, 0, "the site table knew what it was looking for");
});

/* ------------------------------------------------------------------ *
 * The router
 *
 * Choosing a model has to cost one click, which means the add-on opens the
 * site itself — so every site must know where a fresh conversation starts.
 * ------------------------------------------------------------------ */

test("every site knows where a new conversation starts", () => {
  for (const site of mod.CHAT_SITES) {
    assert.match(
      site.newChatUrl,
      /^https:\/\//,
      `${site.surfaceType} needs a new-chat URL for the router to open`,
    );
    // The URL has to be one the add-on is actually permitted to reach, or
    // opening it would produce a tab it cannot then pair.
    const host = new URL(site.newChatUrl).hostname;
    assert.ok(
      site.hosts.includes(host),
      `${site.surfaceType} opens ${host}, which is not in its own host list`,
    );
  }
});

test("an unknown site has nothing to open, and says so with an empty URL", () => {
  // The user is already on the page; there is no canonical new-chat URL to
  // invent, and guessing one would navigate them somewhere they did not ask
  // to go.
  assert.equal(mod.siteFor("https://chat.example.com/x").newChatUrl, "");
});

test("every model the picker offers is a real surface type", () => {
  const types = new Set(mod.CHAT_SITES.map((site) => site.surfaceType));
  for (const id of ["chatgpt", "claude", "gemini", "copilot", "perplexity", "deepseek", "mistral", "grok"]) {
    assert.ok(types.has(id), `the picker offers "${id}" but no site provides it`);
  }
});


/* ------------------------------------------------------------------ *
 * Discovery
 *
 * The alternative to a selector per site per redesign. Measured on a real
 * logged-in ChatGPT: before typing there were zero send candidates, after
 * typing there were two. That difference identifies the control without any
 * site knowledge, which is why it survives a redesign.
 * ------------------------------------------------------------------ */

const control = (over = {}) => ({
  key: "k",
  label: "",
  disabled: false,
  visible: true,
  distance: 100,
  ...over,
});

test("a control that appeared after typing is the candidate", () => {
  const changed = mod.newlyUsable([], [control({ key: "send", label: "Send prompt" })]);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].key, "send");
});

test("becoming enabled counts as appearing", () => {
  // Some sites render the button disabled rather than omitting it; either way
  // it is the thing that changed when text arrived.
  const changed = mod.newlyUsable(
    [control({ key: "send", disabled: true })],
    [control({ key: "send", disabled: false })],
  );
  assert.equal(changed.length, 1);
});

test("a button that was already usable is not the send control", () => {
  // The attach and menu buttons are there the whole time.
  const changed = mod.newlyUsable(
    [control({ key: "attach" }), control({ key: "menu" })],
    [control({ key: "attach" }), control({ key: "menu" })],
  );
  assert.deepEqual(changed, []);
});

test("among changed controls, a send-ish name wins over proximity", () => {
  const chosen = mod.chooseDiscoveredSend([
    control({ key: "near", label: "", distance: 5 }),
    control({ key: "named", label: "Send message", distance: 400 }),
  ]);
  assert.equal(chosen.key, "named");
});

test("with no names, the one nearest the composer wins", () => {
  const chosen = mod.chooseDiscoveredSend([
    control({ key: "far", distance: 500 }),
    control({ key: "near", distance: 20 }),
  ]);
  assert.equal(chosen.key, "near");
});

test("a menu that appeared alongside is still vetoed", () => {
  /*
   * This is the Gemini failure in its discovery form: something else can
   * appear at the same moment, and clicking it opens a menu in the user's
   * face. The fallback is Enter, which costs nothing.
   */
  const chosen = mod.chooseDiscoveredSend([control({ key: "menu", label: "More options" })]);
  assert.equal(chosen, undefined);
});

test("nothing usable means nothing chosen, not a guess", () => {
  assert.equal(mod.chooseDiscoveredSend([]), undefined);
});

/* ---------------- the reply ---------------- */

const block = (key, text) => ({ key, text });

test("the reply is the substantial text that was not there before", () => {
  const found = mod.newestReply(
    [block("a", "You: hello")],
    [block("a", "You: hello"), block("b", "Binary search halves the range each time.")],
    "hello",
  );
  assert.equal(found.key, "b");
});

test("the message we just sent is never mistaken for the reply", () => {
  /*
   * The sent payload is also new text on the page — and with the rendered
   * context attached it is by far the largest block, so a naive "biggest new
   * text" rule would return our own question as the answer.
   */
  const sent = "why does clicking Search reload the page? " + "x".repeat(200);
  const found = mod.newestReply([], [block("mine", sent)], sent);
  assert.equal(found, undefined);
});

test("furniture is ignored", () => {
  // Timestamps, "thinking", copy buttons: new, but not answers.
  const found = mod.newestReply([], [block("t", "just now"), block("s", "Thinking…")], "hi");
  assert.equal(found, undefined);
});

test("a block that grew is the streaming reply", () => {
  const found = mod.newestReply(
    [block("r", "Binary search")],
    [block("r", "Binary search halves the range each time until one is left.")],
    "explain binary search",
  );
  assert.equal(found.key, "r");
});

test("the last candidate wins, because conversations grow downward", () => {
  const found = mod.newestReply(
    [],
    [
      block("older", "An earlier answer that is long enough to count."),
      block("newer", "The most recent answer, also long enough to count."),
    ],
    "hi",
  );
  assert.equal(found.key, "newer");
});

/* ------------------------------------------------------------------ *
 * The veto list, against labels a real page actually produced
 *
 * These exact strings came off a live logged-in ChatGPT while proving the
 * discovery path. Four of them passed the veto: one trailing `\b` after a
 * single alternation meant `dictat` needed a word boundary after it, so
 * "dictation" never matched. Same for attach/attachment, upload/uploading,
 * photo/photos, file/files.
 * ------------------------------------------------------------------ */

test("controls that are plainly not send are vetoed, inflections included", () => {
  for (const label of [
    "Start dictation",
    "Attachment",
    "Uploading",
    "Add photos & files",
    "More options",
    "Attach files",
    "Voice mode",
    "Close",
  ]) {
    assert.equal(mod.saysSomethingElse(label), true, `"${label}" must be refused`);
  }
});

test("send labels survive the veto", () => {
  for (const label of ["Send prompt", "Send message", "Submit", "Send"]) {
    assert.equal(mod.saysSomethingElse(label), false, `"${label}" must be allowed`);
  }
});

test("a provider's own name is not mistaken for a microphone", () => {
  // `mic` as a prefix would veto "Microsoft Copilot", whose button is a real
  // target on that site.
  assert.equal(mod.saysSomethingElse("Microsoft Copilot"), false);
  assert.equal(mod.saysSomethingElse("Microphone"), true);
  assert.equal(mod.saysSomethingElse("Mic"), true);
});

test("discovery and scoring share one veto list", () => {
  // Two copies of a heuristic drift, and this one was already wrong once.
  const dictation = { key: "d", label: "Start dictation", disabled: false, visible: true, distance: 5 };
  assert.equal(mod.chooseDiscoveredSend([dictation]), undefined);
  assert.equal(
    mod.scoreSendCandidate({ label: "Start dictation", selectorIndex: 0, disabled: false, visible: true }),
    undefined,
  );
});

test("an unlabelled send still loses to nothing, and wins on nearness", () => {
  /*
   * Measured distances from the live page: send 8px from the composer,
   * dictation 38px, the effort picker 120px. With the veto working, only send
   * and the effort picker remain, and nearness settles it.
   */
  const chosen = mod.chooseDiscoveredSend([
    { key: "effort", label: "High", disabled: false, visible: true, distance: 120 },
    { key: "send", label: "", disabled: false, visible: true, distance: 8 },
  ]);
  assert.equal(chosen.key, "send");
});

/* ------------------------------------------------------------------ *
 * Finding the composer without a selector
 *
 * Ranked, not chosen: placement reads the text back, so the caller tries
 * candidates in order and a wrong guess is detected rather than shipped. That
 * is the only reason a heuristic is acceptable for something this
 * consequential — typing a rendered payload into a search box would be a
 * visible wrong action taken on the user's behalf.
 * ------------------------------------------------------------------ */

const editable = (over = {}) => ({
  key: "e",
  area: 4000,
  fromBottom: 20,
  inForm: true,
  label: "",
  visible: true,
  readOnly: false,
  nearSendControl: true,
  ...over,
});

test("the box at the bottom of the page wins", () => {
  // Every chat puts its composer low; a box near the top is something else.
  const ranked = mod.rankComposers([
    editable({ key: "top", fromBottom: 700 }),
    editable({ key: "bottom", fromBottom: 20 }),
  ]);
  assert.equal(ranked[0].key, "bottom");
});

test("a search box is refused even when it is large and low", () => {
  /*
   * The worst available outcome: a whole rendered payload typed into a
   * conversation search. Refused by name rather than hoped away.
   */
  const ranked = mod.rankComposers([
    editable({ key: "search", label: "Search chats", fromBottom: 5, area: 9000 }),
  ]);
  assert.deepEqual(ranked, []);
});

test("small controls are not message boxes", () => {
  assert.deepEqual(mod.rankComposers([editable({ area: 120 })]), []);
});

test("hidden and read-only boxes are never offered", () => {
  assert.deepEqual(mod.rankComposers([editable({ visible: false })]), []);
  assert.deepEqual(mod.rankComposers([editable({ readOnly: true })]), []);
});

test("a box with a send control beside it outranks one without", () => {
  /*
   * The signal that survives a redesign and needs no typing: a message box
   * comes with something to send it. A feedback textarea does not.
   */
  const ranked = mod.rankComposers([
    editable({ key: "lonely", nearSendControl: false, fromBottom: 30 }),
    editable({ key: "paired", nearSendControl: true, fromBottom: 40 }),
  ]);
  assert.equal(ranked[0].key, "paired");
});

test("having a send control outranks being in a form", () => {
  // Sites wrap all sorts of things in forms; only one box has a send button.
  const ranked = mod.rankComposers([
    editable({ key: "form-only", inForm: true, nearSendControl: false }),
    editable({ key: "send-only", inForm: false, nearSendControl: true }),
  ]);
  assert.equal(ranked[0].key, "send-only");
});

test("at the same height, the one inside a form wins", () => {
  const ranked = mod.rankComposers([
    editable({ key: "loose", inForm: false, fromBottom: 30, nearSendControl: true }),
    editable({ key: "form", inForm: true, fromBottom: 40, nearSendControl: true }),
  ]);
  assert.equal(ranked[0].key, "form", "a few pixels must not outrank a form");
});

test("size only breaks a tie", () => {
  const ranked = mod.rankComposers([
    editable({ key: "small", area: 1000 }),
    editable({ key: "big", area: 8000 }),
  ]);
  assert.equal(ranked[0].key, "big");
});

test("everything plausible is returned, not just the winner", () => {
  // The caller needs the rest to fall back to when placement fails.
  const ranked = mod.rankComposers([
    editable({ key: "a", fromBottom: 10 }),
    editable({ key: "b", fromBottom: 300 }),
    editable({ key: "c", fromBottom: 600 }),
  ]);
  assert.deepEqual(ranked.map((entry) => entry.key), ["a", "b", "c"]);
});

/* ------------------------------------------------------------------ *
 * The chat's furniture is not the chat's answer
 *
 * Reading the container that holds a reply also reads what the site drew around
 * it — a reasoning panel's "Thinking…" header, a "Skip" control, "Copy". Z.ai
 * returned all of that as though the model had said it.
 * ------------------------------------------------------------------ */

test("interface labels alone on a line are dropped", () => {
  for (const label of ["Thinking...", "Thinking", "Thought Process", "Skip", "Copy", "Regenerate", "Show more", "2 / 2"]) {
    assert.equal(clean.isFurniture(label), true, `${label} is a control, not an answer`);
  }
});

test("a sentence is never mistaken for a control", () => {
  /*
   * The asymmetry that sets the rule: leaving a stray "Skip" in a reply is
   * untidy, deleting a line of a real answer is data loss. So a line has to be
   * short *and* match exactly.
   */
  assert.equal(clean.isFurniture("Thinking about it, the bug is on line 40."), false);
  assert.equal(clean.isFurniture("Copy the file to /tmp first."), false);
  assert.equal(clean.isFurniture("skip the first element of the array"), false);
});

test("a reply keeps its shape once the furniture is gone", () => {
  const raw = ["Thought Process", "Skip", "", "Use a two pointer walk:", "", "  left = 0", "  right = n - 1", "", "Copy"].join("\n");
  const cleaned = clean.cleanReply(raw);

  assert.match(cleaned, /two pointer walk/);
  assert.match(cleaned, /left = 0/, "indentation survives — arrows and code depend on it");
  assert.doesNotMatch(cleaned, /Thought Process/);
  assert.doesNotMatch(cleaned, /Skip/);
  assert.doesNotMatch(cleaned, /Copy/);
});

test("an answer rendered twice is collapsed to one copy", () => {
  // A reasoning panel that previews the answer above the answer.
  const once = "Binary search halves the range each step, so it costs log n comparisons overall.";
  assert.equal(clean.cleanReply(once + "\n" + once), once);
});

test("a genuinely repeated line inside an answer is left alone", () => {
  // `return 1;` twice is a program, not an echo — and the leading indentation
  // has to survive, because that is what makes pasted code line up.
  const listing = ["  return 1;", "  return 1;", "and that is the bug"].join("\n");
  assert.equal(clean.cleanReply(listing), listing);
});

test("a preview separated by a blank line is also collapsed", () => {
  const answer = "Binary search halves the range each step, so it costs log n comparisons.";
  assert.equal(clean.cleanReply([answer, "", answer].join("\n")), answer);
});

test("a reply that is only 'thinking' is not an answer at all", () => {
  /*
   * The failure the user reported, precisely: while Z.ai was reasoning, the
   * container held "Thinking… Skip" and nothing else. That text stops changing
   * — thinking is not streaming prose — so the idle guess fired, returned it as
   * the reply, and stopped observing. The real answer was never read.
   *
   * Stripping the furniture leaves nothing, and nothing is never complete, so
   * the observer keeps waiting instead of settling on the interface.
   */
  const cleaned = clean.cleanReply("Thinking...\nSkip");
  assert.equal(cleaned, "");

  const verdict = mod.judgeCompletion({
    text: cleaned,
    msSinceLastChange: mod.DEFAULT_IDLE_MS + 5000,
    msSinceStart: 20_000,
  });
  assert.equal(verdict.complete, false, "silence over an empty answer is not an answer");
});

test("thinking followed by a real answer keeps the answer", () => {
  const cleaned = clean.cleanReply(
    ["Thought Process", "Skip", "", "No worries! I am here to help with your project."].join("\n"),
  );
  assert.equal(cleaned, "No worries! I am here to help with your project.");

  const verdict = mod.judgeCompletion({
    text: cleaned,
    msSinceLastChange: mod.DEFAULT_IDLE_MS + 1,
    msSinceStart: 9000,
  });
  assert.equal(verdict.complete, true, "and once it settles, that is the reply");
});

/* ------------------------------------------------------------------ *
 * Changing the model inside the chat
 *
 * The same idea as the send button: a model menu is identified by the fact that
 * clicking something made a list of model names appear. No site knows it is
 * being read, and no row has to be maintained when it is redesigned.
 * ------------------------------------------------------------------ */

const clickable = (label, over = {}) => ({
  key: label,
  label,
  visible: true,
  distance: 100,
  ...over,
});

test("a control that says 'model' outranks one that merely looks versioned", () => {
  const ranked = picker.rankModelTriggers([
    clickable("4.6", { distance: 10 }),
    clickable("Model: GLM-4.6", { distance: 400 }),
  ]);
  assert.equal(ranked[0].label, "Model: GLM-4.6", '"4.6" could be anything');
});

test("controls with nothing model-like about them are never clicked", () => {
  // The alternative to guessing is leaving the model alone, which costs nothing.
  assert.deepEqual(picker.rankModelTriggers([clickable("Attach"), clickable("Send")]), []);
});

test("a menu is only a model menu when several options look like models", () => {
  assert.equal(picker.looksLikeModelMenu([clickable("GLM-4.6"), clickable("GLM-4.5-Air")]), true);
  assert.equal(picker.looksLikeModelMenu([clickable("GLM-4.6")]), false, "one option is not a list");
  assert.equal(
    picker.looksLikeModelMenu([clickable("Rename"), clickable("Delete"), clickable("Archive")]),
    false,
    "that is a conversation menu, and clicking it would be destructive",
  );
});

test("a request matches a model across punctuation and case", () => {
  const options = [clickable("GLM-4.6"), clickable("GLM-4.5-Air"), clickable("GLM-4.6-Thinking")];
  assert.equal(picker.chooseModelOption("glm 4.6", options).label, "GLM-4.6");
  assert.equal(picker.chooseModelOption("GLM-4.5-Air", options).label, "GLM-4.5-Air");
});

test("an ambiguous request switches nothing", () => {
  /*
   * Two plausible matches and we pick one: the reply comes back looking exactly
   * like the reply you asked for, from a model you did not choose. Refusing is
   * the only honest option.
   */
  const options = [clickable("Sonnet 4.5"), clickable("Sonnet 4.5 (new)")];
  assert.equal(picker.chooseModelOption("sonnet", options), undefined);
});

test("a switch is only done when the trigger says so", () => {
  assert.equal(picker.switchConfirmed("Model: GLM-4.6", "glm 4.6"), true);
  assert.equal(picker.switchConfirmed("Model: GLM-4.5-Air", "glm 4.6"), false);
});
