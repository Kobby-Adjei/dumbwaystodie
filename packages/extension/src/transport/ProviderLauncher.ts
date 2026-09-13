import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";

/**
 * Starts the provider process on the user's behalf.
 *
 * The counterpart to `RelayLauncher`. Together they turn "open two terminals,
 * run these in the right order, then change a setting and reload" into one
 * button — which is what spec §0X asks for, and the difference between a
 * topology someone tries once and one they actually use.
 *
 * Unlike the relay there is no health endpoint to probe: whether a provider is
 * attached is something the relay already knows and broadcasts, so presence is
 * read from there rather than guessed at here.
 */
export interface ProviderLauncherOptions {
  providerEntry: string;
  port: number;
  log: (message: string) => void;
}

export class ProviderLauncher {
  private child: ChildProcess | undefined;

  constructor(private readonly options: ProviderLauncherOptions) {}

  /** True when this extension started the process and it is still alive. */
  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null;
  }

  start(): void {
    if (this.running) {
      this.options.log("[provider] already started by this window");
      return;
    }

    const child = spawn(process.execPath, [this.options.providerEntry], {
      // See RelayLauncher: execPath is Electron, not node, unless asked.
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        DUMBWAYS_RELAY_PORT: String(this.options.port),
      },
      detached: true,
      stdio: "ignore",
      cwd: path.dirname(this.options.providerEntry),
    });
    child.unref();
    this.child = child;

    child.on("exit", (code) => {
      this.options.log(`[provider] process exited with code ${String(code)}`);
      this.child = undefined;
    });

    this.options.log(`[provider] started process ${String(child.pid)}`);
  }

  stop(): boolean {
    if (!this.child) {
      return false;
    }
    this.child.kill("SIGTERM");
    this.child = undefined;
    return true;
  }
}
