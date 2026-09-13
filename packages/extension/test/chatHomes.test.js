const test = require("node:test");
const assert = require("node:assert/strict");

const { describeHome, validateHome, TEMPORARY_CHAT } = require("../out/ui/chatHome.js");

/**
 * Where coding chats live.
 *
 * The reason this exists at all: a person's ChatGPT is not a tool they picked
 * up for this job, it is a place they already keep things — a history they
 * scroll and a memory that has learned who they are. Opening coding sessions
 * into it by default spends something the editor cannot see, so the choice is
 * theirs, and these pin the parts that must not be sloppy: what gets accepted,
 * and whether the words we show them match what will happen.
 */

test("a project URL has to be a real https address", () => {
  assert.equal(validateHome("https://chatgpt.com/g/g-p-abc/project"), undefined);

  assert.match(validateHome(""), /Paste the address/);
  assert.match(validateHome("   "), /Paste the address/);
  assert.match(validateHome("chatgpt.com/project"), /not a web address/);
  assert.match(validateHome("http://chatgpt.com/project"), /https/);
});

test("a javascript URL is refused rather than stored", () => {
  /*
   * This ends up in `tabs.create`, so a stored `javascript:` URL would be the
   * add-on running someone else's script. The browser checks it again — it is
   * the one opening the tab — but refusing it here is a sentence the user can
   * act on instead of a chat that opens somewhere strange.
   */
  assert.match(validateHome("javascript:alert(1)"), /https/);
  assert.match(validateHome("data:text/html,<b>x"), /https/);
});

test("a temporary chat is offered only where one exists", () => {
  // A canned URL per provider, not a guess applied to all of them: a parameter
  // invented for a site that does not honour it opens an ordinary chat and
  // says it did something else.
  assert.equal(typeof TEMPORARY_CHAT["chatgpt"], "string");
  assert.equal(validateHome(TEMPORARY_CHAT["chatgpt"]), undefined);
  assert.equal(TEMPORARY_CHAT["claude"], undefined);
});

test("each choice is described in the words it was chosen in", () => {
  // The confirmation has to match what will actually happen, or the setting
  // is worse than not having asked.
  assert.match(describeHome({ kind: "project", url: "https://x.example/p" }), /project/);
  assert.match(describeHome({ kind: "temporary", url: "https://x.example/?t" }), /temporary/);
  assert.match(describeHome({ kind: "history" }), /normal history/);
});
