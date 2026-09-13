#!/usr/bin/env node
/**
 * Starts the whole local stack with one command.
 *
 *     npm run dev:stack
 *
 * Replaces "open two terminals, run the relay in one, wait for it, then run
 * the provider in the other, and remember to kill both". Ordering matters —
 * the provider reads the relay's handshake file, so it cannot start first —
 * and getting that wrong looks like a mysterious failure rather than a race.
 *
 * No dependencies: this is a small supervisor, not a process manager.
 */

const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PORT = process.env.DUMBWAYS_RELAY_PORT ?? "43123";

const RELAY = path.join(ROOT, "packages", "relay", "dist", "server.js");
const PROVIDER = path.join(ROOT, "packages", "mock-provider", "dist", "standalone.js");

const COLOURS = { relay: "[36m", provider: "[35m", reset: "[0m" };
const children = [];
let shuttingDown = false;

function start(label, entry) {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, DUMBWAYS_RELAY_PORT: PORT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push({ label, child });

  const prefix = `${COLOURS[label] ?? ""}[${label}]${COLOURS.reset}`;
  const pipe = (stream, out) => {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        out.write(`${prefix} ${line}\n`);
      }
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on("exit", (code) => {
    if (shuttingDown) {
      return;
    }
    process.stdout.write(`${prefix} exited with code ${String(code)}\n`);
    // One half of the stack is useless alone: take the other down too rather
    // than leaving a half-dead setup that looks alive.
    shutdown(code ?? 1);
  });

  return child;
}

/** The provider reads the relay's handshake file, so wait for it to exist. */
function waitForReady(child, label, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let seen = "";

    const onData = (chunk) => {
      seen += chunk.toString();
      if (seen.includes("READY")) {
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);

    const poll = setInterval(() => {
      if (seen.includes("READY")) {
        clearInterval(poll);
      } else if (child.exitCode !== null) {
        clearInterval(poll);
        reject(new Error(`${label} exited before it was ready`));
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(poll);
        reject(new Error(`${label} did not report READY within ${timeoutMs}ms`));
      }
    }, 100);
  });
}

function shutdown(code = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  process.stdout.write("\n[dev:stack] shutting down\n");
  for (const { child } of children) {
    child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 300).unref();
}

async function main() {
  process.stdout.write(`[dev:stack] starting relay + provider on port ${PORT}\n`);

  const relay = start("relay", RELAY);
  await waitForReady(relay, "relay");

  start("provider", PROVIDER);

  process.stdout.write(
    `\n[dev:stack] ready — set "dumbways.provider.mode" to "relay" in the editor.\n` +
      `[dev:stack] health: http://127.0.0.1:${PORT}/health\n` +
      `[dev:stack] Ctrl-C stops both.\n\n`,
  );
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

main().catch((error) => {
  process.stderr.write(`[dev:stack] ${String(error)}\n`);
  shutdown(1);
});
