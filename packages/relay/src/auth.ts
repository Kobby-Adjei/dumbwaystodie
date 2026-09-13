import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { RelayHandshakeFile } from "@dumbways/protocol";
import { PROTOCOL_VERSION } from "@dumbways/protocol";

/**
 * Connection authentication (spec §23).
 *
 * Even on localhost. A port bound to 127.0.0.1 is reachable by every process
 * on the machine and by any web page that can be talked into opening a socket
 * to it — loopback is not a permission boundary. The token is: the relay mints
 * one at startup and writes it to a file only this user can read, so "can read
 * that file" becomes the actual credential.
 */

export function createToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * A credential that can only be used by one adapter role.
 *
 * `/pair` used to hand out the relay's own token, which admits *any* role — so
 * a browser add-on asking for a connection received the editor's powers too.
 * This derives a separate secret per role instead: it proves the holder was
 * given something by this relay, and it names what that something may be.
 *
 * Derived rather than random, deliberately. The extension keeps one relay
 * token across restarts precisely so a restart does not log the add-on out;
 * a randomly minted grant would throw that away and put the user back in front
 * of the pairing button every time the relay bounced. Same master token, same
 * grant — and a *different* master token invalidates every grant with it,
 * which is the one revocation that matters.
 */
export function deriveGrant(masterToken: string, kind: string): string {
  return createHmac("sha256", masterToken).update(`dwtd-grant:${kind}`).digest("hex");
}

/**
 * Machine-scoped, not workspace-scoped: one relay owns one port, and the file
 * must not end up inside a repository where it could be committed.
 */
export function handshakeFilePath(port: number): string {
  return path.join(os.tmpdir(), `dumbways-relay-${port}.json`);
}

export async function writeHandshakeFile(file: RelayHandshakeFile): Promise<string> {
  const target = handshakeFilePath(file.port);
  // 0600 before anything is written: never briefly world-readable.
  await fs.writeFile(target, JSON.stringify(file, null, 2), { mode: 0o600 });
  await fs.chmod(target, 0o600);
  return target;
}

export async function readHandshakeFile(port: number): Promise<RelayHandshakeFile | undefined> {
  try {
    const raw = await fs.readFile(handshakeFilePath(port), "utf8");
    const parsed = JSON.parse(raw) as Partial<RelayHandshakeFile>;

    if (
      typeof parsed.token !== "string" ||
      typeof parsed.port !== "number" ||
      typeof parsed.host !== "string"
    ) {
      return undefined;
    }
    if (parsed.protocolVersion !== PROTOCOL_VERSION) {
      // A relay from a different protocol version is not ours to talk to.
      return undefined;
    }

    return parsed as RelayHandshakeFile;
  } catch {
    return undefined;
  }
}

export async function removeHandshakeFile(port: number): Promise<void> {
  await fs.rm(handshakeFilePath(port), { force: true });
}

/**
 * Constant-time comparison. The attack is far-fetched over loopback, but the
 * correct version costs one function call.
 */
export function tokensMatch(expected: string, received: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ *
 * Who is allowed to talk to a loopback listener
 * ------------------------------------------------------------------ */

/**
 * Whether a request's `Host` header names this relay on this machine.
 *
 * Loopback is not a boundary against the browser. A site can publish a DNS
 * record for its own name pointing at 127.0.0.1 — DNS rebinding — and then its
 * pages are *same-origin* with this listener, so the same-origin policy stops
 * protecting the responses and a page can read whatever it asks for. The
 * request still carries the attacker's hostname in `Host`, which is the one
 * thing rebinding cannot change, so that is what gets checked.
 */
export function isLoopbackHost(header: string | undefined, port: number): boolean {
  if (!header) {
    // HTTP/1.1 requires it. Something handmade is not something to trust.
    return false;
  }

  // Strip the port, allowing for a bracketed IPv6 literal.
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(header.trim());
  if (!match) {
    return false;
  }

  const host = (match[1] ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  const named = match[2] ? Number(match[2]) : undefined;

  if (named !== undefined && named !== port) {
    return false;
  }

  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * Whether a request came from a web page.
 *
 * A browser attaches `Origin` to cross-site requests and to every request a
 * page's script makes; a command-line harness never sends one, and an
 * extension's own worker sends its `chrome-extension://` origin. So a `http(s)`
 * origin here means a page is asking — which for these endpoints is never
 * legitimate, and is exactly the shape a CSRF takes: the page cannot read the
 * answer, but the side effect still happens.
 */
export function isFromWebPage(origin: string | undefined): boolean {
  if (!origin || origin === "null") {
    return false;
  }
  return /^https?:\/\//i.test(origin);
}
