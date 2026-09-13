import { spawn } from "node:child_process";
import * as path from "node:path";

import { DEFAULT_RELAY_HOST, DEFAULT_RELAY_PORT, type RelayHandshakeFile } from "@dumbways/protocol";
import { readHandshakeFile } from "@dumbways/relay";

/**
 * Starts the relay only if it is not already running (spec §0F).
 *
 * The rule that shapes this file: **never launch a duplicate relay for the
 * same port.** Two relays on one port means one of them silently loses the
 * bind, adapters attach to whichever won, and the resulting "sometimes it
 * works" is close to undebuggable. So a health check comes before any spawn,
 * and again after.
 */

export interface RelayLauncherOptions {
  host?: string;
  port?: number;
  /** Resolved path to the relay's server.js. */
  relayEntry: string;
  /**
   * A token that outlives any single relay process.
   *
   * The relay used to mint its own on every start, so restarting it — which a
   * window reload does — invalidated the browser add-on's stored credentials
   * and looked exactly like a broken connection. One stable token per machine
   * makes a restart invisible to everything already paired.
   */
  token?: string;
  /**
   * Identifies the code this extension shipped.
   *
   * A relay is detached so it survives window reloads — which also means an
   * updated extension can find an old relay still running and talk to it
   * quite happily until something behaves oddly. Comparing builds turns that
   * into an automatic restart.
   */
  build?: string;
  log: (message: string) => void;
  startTimeoutMs?: number;
}

export interface RelayEndpoint extends RelayHandshakeFile {
  /** True when this process started it, false when one was already running. */
  spawned: boolean;
}

export async function probeRelay(host: string, port: number, timeoutMs = 700): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { service?: string };
    // Something else could be squatting on the port; only our relay counts.
    return body.service === "dumbways-relay";
  } catch {
    return false;
  }
}

export class RelayLauncher {
  private readonly host: string;
  private readonly port: number;
  private readonly startTimeoutMs: number;

  constructor(private readonly options: RelayLauncherOptions) {
    this.host = options.host ?? DEFAULT_RELAY_HOST;
    this.port = options.port ?? DEFAULT_RELAY_PORT;
    this.startTimeoutMs = options.startTimeoutMs ?? 8_000;
  }

  /** Returns a live endpoint, starting the relay only if nothing answers. */
  async ensureRunning(): Promise<RelayEndpoint> {
    const existing = await this.existingEndpoint();
    if (existing) {
      /*
       * A relay from a different build is replaced, not reused.
       *
       * This is what "Stop relay + provider, then Start" used to be for, and
       * expecting the user to know when that was necessary was not reasonable
       * — the symptom of skipping it is a feature that silently does not work.
       *
       * A relay reporting no build at all counts as different: it predates
       * this check, which makes it the one that most needs replacing.
       */
      const running = await this.runningBuild();
      if (this.options.build && running !== this.options.build) {
        this.options.log(
          `[relay] running build ${running ?? "unknown"} does not match ${this.options.build}; restarting it`,
        );
        await this.stop();
        await delay(300);
      } else {
        this.options.log(`[relay] reusing the relay already running on port ${this.port}`);
        return { ...existing, spawned: false };
      }
    }

    this.options.log(`[relay] no relay on port ${this.port}; starting one`);
    this.spawnRelay();

    const started = await this.waitForRelay();
    if (!started) {
      throw new Error(
        `The relay did not come up on ${this.host}:${this.port} within ${this.startTimeoutMs}ms.`,
      );
    }
    return { ...started, spawned: true };
  }

  /**
   * A handshake file alone proves nothing — it outlives a crashed relay. The
   * health check is what decides.
   */
  private async existingEndpoint(): Promise<RelayHandshakeFile | undefined> {
    const alive = await probeRelay(this.host, this.port);
    if (!alive) {
      return undefined;
    }
    const handshake = await readHandshakeFile(this.port);
    if (!handshake) {
      // Alive but unreadable credentials: a relay started by another user, or
      // a stale file. Refuse rather than guessing at a token.
      throw new Error(
        `Something is serving ${this.host}:${this.port} but its handshake file is missing or unreadable.`,
      );
    }
    return handshake;
  }

  /** The build id the running relay advertises, if it advertises one. */
  private async runningBuild(): Promise<string | undefined> {
    try {
      const response = await fetch(`http://${this.host}:${this.port}/health`, {
        signal: AbortSignal.timeout(700),
      });
      const body = (await response.json()) as { build?: string };
      return typeof body.build === "string" ? body.build : undefined;
    } catch {
      return undefined;
    }
  }

  private spawnRelay(): void {
    const child = spawn(process.execPath, [this.options.relayEntry], {
      // `process.execPath` is the editor's own Electron binary, which only
      // behaves as node when told to. The extension host happens to be
      // launched that way, so this is inherited today — setting it explicitly
      // means we do not depend on that accident.
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        DUMBWAYS_RELAY_PORT: String(this.port),
        ...(this.options.token ? { DUMBWAYS_RELAY_TOKEN: this.options.token } : {}),
        ...(this.options.build ? { DUMBWAYS_BUILD: this.options.build } : {}),
      },
      // Detached and unref'd on purpose: reloading the editor should reattach
      // to the running relay, not restart it. `Stop Relay` is the explicit
      // counterpart to that choice.
      detached: true,
      stdio: "ignore",
      cwd: path.dirname(this.options.relayEntry),
    });
    child.unref();
  }

  private async waitForRelay(): Promise<RelayHandshakeFile | undefined> {
    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      if (await probeRelay(this.host, this.port, 300)) {
        const handshake = await readHandshakeFile(this.port);
        if (handshake) {
          return handshake;
        }
      }
      await delay(150);
    }
    return undefined;
  }

  /** Stops a relay this machine is running, by the pid it advertised. */
  async stop(): Promise<boolean> {
    const handshake = await readHandshakeFile(this.port);
    if (!handshake) {
      return false;
    }
    try {
      process.kill(handshake.pid, "SIGTERM");
      this.options.log(`[relay] stopped relay pid ${handshake.pid}`);
      return true;
    } catch {
      return false;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { DEFAULT_RELAY_PORT };
