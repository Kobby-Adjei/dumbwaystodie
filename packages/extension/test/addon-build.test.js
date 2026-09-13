const test = require("node:test");
const assert = require("node:assert/strict");

const { compareAddonBuild } = require("../out/ui/addonBuild.js");

/**
 * Telling a stale add-on from a broken one.
 *
 * Chrome keeps running the copy of a service worker it loaded, so a rebuilt
 * add-on that has not been reloaded reports itself perfectly connected while
 * executing older code. The observable symptom is not "stale" — it is a request
 * going somewhere it should not, or a fix that appears not to work. This is what
 * turns that into one sentence instead of a diagnosis.
 */

test("the same build is not stale", () => {
  assert.equal(compareAddonBuild("0.1.0-123", "0.1.0-123").stale, false);
});

test("a different build is stale, and says what to do about it", () => {
  const verdict = compareAddonBuild("0.1.0-200", "0.1.0-100");
  assert.equal(verdict.stale, true);
  assert.match(verdict.message, /chrome:\/\/extensions/);
  assert.match(verdict.message, /Reload/);
  // Because "just rebuild" is the thing people try, and it does not work.
  assert.match(verdict.message, /rebuilding is not enough/);
});

test("an add-on reporting no build at all is stale, not merely unknown", () => {
  /*
   * Every build since the stamp existed carries one, so an add-on without it
   * was compiled before that. Calling this "unknown" and staying quiet is what
   * let a stale copy keep serving old routing while the repo, the build and
   * every test said the fix was in.
   */
  assert.equal(compareAddonBuild("0.1.0-200", undefined).stale, true);
  assert.equal(compareAddonBuild("0.1.0-200", "unknown").stale, true);
});

test("an editor that ships no id judges nothing", () => {
  // The only real unknown: nothing to compare against, so no warning — a
  // warning that is always there is one nobody reads when it matters.
  assert.equal(compareAddonBuild(undefined, "0.1.0-100").stale, false);
  assert.equal(compareAddonBuild(undefined, undefined).stale, false);
});
