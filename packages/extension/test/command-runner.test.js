const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  runCommand,
  tokenize,
  containsShellSyntax,
  buildEnvironment,
  DEFAULT_ENV_ALLOWLIST,
} = require("../out/shell/CommandRunner.js");

/**
 * Command execution (spec §37, §38).
 *
 * These run real processes. A mocked child_process would prove that the code
 * calls spawn, which is not the part that can hurt anyone.
 */

let sandbox;

test.before(async () => {
  sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dumbways-run-")));
  await fs.writeFile(path.join(sandbox, "hello.txt"), "hi\n");
});

test.after(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

const run = (command, over = {}) =>
  runCommand({ command, cwd: sandbox, displayCwd: ".", timeoutMs: 5000, ...over });

/* ------------------------------------------------------------------ *
 * Tokenizing
 * ------------------------------------------------------------------ */

test("splits a command into argv, honouring quotes", () => {
  assert.deepEqual(tokenize("npm test"), ["npm", "test"]);
  assert.deepEqual(tokenize("  npm   run   build  "), ["npm", "run", "build"]);
  assert.deepEqual(tokenize(`echo "hello world"`), ["echo", "hello world"]);
  assert.deepEqual(tokenize(`echo 'single quoted'`), ["echo", "single quoted"]);
  assert.deepEqual(tokenize(`git commit -m "fix: the thing"`), [
    "git",
    "commit",
    "-m",
    "fix: the thing",
  ]);
  // An empty quoted argument is a real argument.
  assert.deepEqual(tokenize(`node -e ""`), ["node", "-e", ""]);
});

test("an unbalanced quote is refused rather than guessed at", () => {
  assert.throws(() => tokenize(`echo "unclosed`), (error) => {
    assert.equal(error.code, "INVALID_ARGUMENT");
    return true;
  });
});

test("unquoted shell syntax is detected", () => {
  for (const command of [
    "npm test | tee log",
    "npm test > out.txt",
    "npm test && rm -rf /",
    "npm test; echo done",
    "echo `whoami`",
    "echo $(whoami)",
    "echo ${HOME}",
  ]) {
    assert.equal(containsShellSyntax(command), true, `expected shell syntax in: ${command}`);
  }

  for (const command of ["npm test", "git commit -m 'fix'", "node --version"]) {
    assert.equal(containsShellSyntax(command), false, `unexpected shell syntax in: ${command}`);
  }
});

test("metacharacters inside quotes are data, not syntax", () => {
  // Refusing these would make the tool useless for the commands people
  // actually run: arrow functions contain >, and JS statements contain ;.
  for (const command of [
    `node -e "setInterval(() => {}, 100)"`,
    `node -e "console.error('x'); process.exit(3)"`,
    `git commit -m "fix: a > b"`,
    `grep "a|b" file.txt`,
  ]) {
    assert.equal(containsShellSyntax(command), false, `should be allowed: ${command}`);
  }
});

test("a command with a pipe is refused with an explanation, not silently mangled", async () => {
  await assert.rejects(run("echo hi | tee out.txt"), (error) => {
    assert.equal(error.code, "INVALID_ARGUMENT");
    assert.match(error.message, /without a shell/);
    return true;
  });

  // And nothing was created as a side effect.
  await assert.rejects(fs.stat(path.join(sandbox, "out.txt")));
});

/* ------------------------------------------------------------------ *
 * The environment (spec §38)
 * ------------------------------------------------------------------ */

test("only allowlisted variables survive", () => {
  const environment = buildEnvironment(
    {
      PATH: "/usr/bin",
      HOME: "/Users/kobby",
      GITHUB_TOKEN: "ghp_supersecret",
      AWS_SECRET_ACCESS_KEY: "aws_secret",
      NPM_CONFIG_REGISTRY: "https://registry.example.com",
    },
    DEFAULT_ENV_ALLOWLIST,
  );

  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.HOME, "/Users/kobby");
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(environment.NPM_CONFIG_REGISTRY, undefined, "not on the list means not passed");
});

test("a credential-looking name is dropped even if someone allowlists it", () => {
  const environment = buildEnvironment(
    { MY_API_TOKEN: "secret", SESSION_COOKIE: "abc", PATH: "/usr/bin" },
    ["MY_API_TOKEN", "SESSION_COOKIE", "PATH"],
  );

  assert.equal(environment.MY_API_TOKEN, undefined);
  assert.equal(environment.SESSION_COOKIE, undefined);
  assert.equal(environment.PATH, "/usr/bin");
});

test("the child really does not receive the parent's secrets", async () => {
  process.env.DUMBWAYS_FAKE_TOKEN = "leaked-if-you-can-read-me";
  try {
    const result = await run(`node -e "console.log(process.env.DUMBWAYS_FAKE_TOKEN ?? 'absent')"`);
    assert.equal(result.stdout.trim(), "absent");
    assert.doesNotMatch(result.stdout, /leaked-if-you-can-read-me/);
  } finally {
    delete process.env.DUMBWAYS_FAKE_TOKEN;
  }
});

/* ------------------------------------------------------------------ *
 * Running (spec §37)
 * ------------------------------------------------------------------ */

test("captures stdout, exit code and duration", async () => {
  const result = await run(`node -e "console.log('from the child')"`);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "from the child");
  assert.equal(result.stderr, "");
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
  assert.equal(typeof result.durationMs, "number");
  assert.equal(result.cwd, ".");
});

test("captures stderr and a non-zero exit code without treating it as a crash", async () => {
  const result = await run(`node -e "console.error('it went wrong'); process.exit(3)"`);

  assert.equal(result.exitCode, 3);
  assert.match(result.stderr, /it went wrong/);
  // A failing command ran successfully: the tool call is ok, the command is not.
  assert.equal(result.timedOut, false);
});

test("runs in the given working directory", async () => {
  const result = await run(`node -e "console.log(require('fs').readdirSync('.').join(','))"`);
  assert.match(result.stdout, /hello\.txt/);
});

test("a missing executable is a clear error, not a crash", async () => {
  await assert.rejects(run("definitely-not-a-real-binary-xyz"), (error) => {
    assert.equal(error.code, "EXECUTION_FAILED");
    assert.match(error.message, /Command not found/);
    return true;
  });
});

test("a hanging command is killed and reported as timed out", async () => {
  const started = Date.now();
  const result = await run(`node -e "setInterval(() => {}, 1000)"`, { timeoutMs: 700 });

  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 5000, "it must not wait for the process to finish on its own");
  assert.notEqual(result.exitCode, 0);
});

test("output produced before a timeout is still returned", async () => {
  const result = await run(
    `node -e "console.log('printed first'); setInterval(() => {}, 1000)"`,
    { timeoutMs: 700 },
  );

  assert.equal(result.timedOut, true);
  assert.match(result.stdout, /printed first/);
});

test("huge output is truncated and marked", async () => {
  const result = await run(`node -e "console.log('x'.repeat(60000))"`);

  assert.equal(result.truncated, true);
  assert.match(result.stdout, /\[truncated \d+ characters\]/);
  assert.ok(result.stdout.length < 45_000, `expected a capped stdout, got ${result.stdout.length}`);
});

test("aborting kills the process", async () => {
  const controller = new AbortController();
  const promise = run(`node -e "setInterval(() => {}, 1000)"`, {
    timeoutMs: 20_000,
    signal: controller.signal,
  });

  setTimeout(() => controller.abort(), 200);
  const result = await promise;

  assert.equal(result.timedOut, true);
});

test("the command is echoed back exactly as approved", async () => {
  const command = `node -e "console.log('ok')"`;
  const result = await run(command);
  assert.equal(result.command, command, "the result must quote what the user approved");
});
