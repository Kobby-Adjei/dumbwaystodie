const test = require("node:test");
const assert = require("node:assert/strict");

const { inspectPath, isLikelySecretPath } = require("../out/security/secretFilter.js");

test("blocks known secret paths (spec §40)", () => {
  const blocked = [
    ".env",
    ".env.local",
    "config/.env.production",
    "certs/server.pem",
    "certs/server.key",
    "../.ssh/id_rsa",
    "home/.ssh/id_ed25519.pub",
    ".aws/credentials",
    "deploy/aws-credentials.json",
    "app/secrets.json",
    ".npmrc",
  ];

  for (const path of blocked) {
    assert.equal(isLikelySecretPath(path), true, `expected "${path}" to be blocked`);
    assert.ok(inspectPath(path).reason, `expected a reason for "${path}"`);
  }
});

test("allows ordinary source files", () => {
  const allowed = [
    "public/index.html",
    "src/app.js",
    "packages/relay/src/server.ts",
    "README.md",
    "environment.md",
    "src/keyboard.ts",
    "monkey.js",
  ];

  for (const path of allowed) {
    assert.equal(isLikelySecretPath(path), false, `expected "${path}" to be allowed`);
  }
});

test("handles windows-style separators", () => {
  assert.equal(isLikelySecretPath("C:\\Users\\kobby\\.ssh\\config"), true);
  assert.equal(isLikelySecretPath("src\\components\\Form.tsx"), false);
});
