import { spawn } from "node:child_process";

import type { RunCommandResult } from "@dumbways/protocol";

import { ToolExecutionError } from "../tools/ToolExecutionError";

/**
 * Controlled command execution (spec §37, §38).
 *
 * Three rules, in order of how much they matter:
 *
 *  1. **No shell.** The command is tokenized and spawned directly, so the
 *     string the user approved is exactly the process that runs. There is no
 *     interpretation step between the dialog and the execve.
 *  2. **No blind environment inheritance.** A child gets an allowlisted
 *     environment, not this process's. Editors are launched from shells full
 *     of `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY` and friends, and a command the
 *     user approved for one purpose should not receive all of them.
 *  3. **Nothing runs unbounded.** Timeout, output caps, and a killed process
 *     group rather than an orphaned tree.
 */

/** Spec §37: truncate massive output and mark the truncation. */
const MAX_OUTPUT_CHARACTERS = 40_000;

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/**
 * Variables a build tool legitimately needs. Everything else is dropped.
 *
 * An allowlist rather than a denylist because a denylist has to predict every
 * secret's name, and it only has to be wrong once.
 */
export const DEFAULT_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
  // Windows needs these to run anything at all.
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
];

/** Even inside the allowlist, a name that looks like a credential is dropped. */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL|SESSION|COOKIE|AUTH)/i;

export interface CommandScan {
  tokens: string[];
  /** The shell metacharacter found outside quotes, if any. */
  shellSyntax: string | undefined;
}

const UNQUOTED_METACHARACTERS = new Set(["|", "&", ";", "<", ">", "`", "\n", "\r"]);

/**
 * Splits a command into argv, honouring quotes, and reports shell syntax found
 * *outside* those quotes.
 *
 * The distinction is the whole point. `node -e "a; b"` contains a semicolon,
 * but it is data inside an argument — refusing it would make the tool useless
 * for exactly the commands people run. An unquoted `;` is different: the user
 * meant "then run this too", and without a shell that intent silently becomes
 * a literal argument instead. So quoted metacharacters pass through untouched
 * and unquoted ones are refused with an explanation.
 */
export function scanCommand(command: string): CommandScan {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  let shellSyntax: string | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] as string;

    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else if (character === "\\" && quote === '"' && index + 1 < command.length) {
        index += 1;
        current += command[index];
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }

    if (shellSyntax === undefined) {
      if (UNQUOTED_METACHARACTERS.has(character)) {
        shellSyntax = character;
      } else if (character === "$" && (command[index + 1] === "(" || command[index + 1] === "{")) {
        shellSyntax = `$${command[index + 1]}`;
      }
    }

    if (/\s/.test(character)) {
      if (started || current.length > 0) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }

    current += character;
  }

  if (quote) {
    throw new ToolExecutionError("INVALID_ARGUMENT", `Unbalanced ${quote} quote in the command.`);
  }
  if (started || current.length > 0) {
    tokens.push(current);
  }

  return { tokens, shellSyntax };
}

export function tokenize(command: string): string[] {
  return scanCommand(command).tokens;
}

export function containsShellSyntax(command: string): boolean {
  return scanCommand(command).shellSyntax !== undefined;
}

export function buildEnvironment(
  source: NodeJS.ProcessEnv,
  allowlist: string[],
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of allowlist) {
    const value = source[name];
    if (typeof value === "string" && !SECRET_NAME.test(name)) {
      environment[name] = value;
    }
  }
  return environment;
}

function truncate(text: string): { text: string; truncated: boolean } {
  return text.length <= MAX_OUTPUT_CHARACTERS
    ? { text, truncated: false }
    : {
        text: `${text.slice(0, MAX_OUTPUT_CHARACTERS)}\n…[truncated ${text.length - MAX_OUTPUT_CHARACTERS} characters]`,
        truncated: true,
      };
}

export interface RunCommandOptions {
  command: string;
  /** Absolute, already proven to be inside the workspace by the caller. */
  cwd: string;
  /** Workspace-relative, for the result. */
  displayCwd: string;
  timeoutMs?: number;
  envAllowlist?: string[];
  signal?: AbortSignal;
}

export async function runCommand(options: RunCommandOptions): Promise<RunCommandResult> {
  const scan = scanCommand(options.command);
  if (scan.shellSyntax !== undefined) {
    throw new ToolExecutionError(
      "INVALID_ARGUMENT",
      `Unsupported shell syntax "${scan.shellSyntax}": commands run without a shell, so the ` +
        "approved string is exactly what executes. Pipes, redirection and chaining are not " +
        "available — run the parts separately. (Quoted metacharacters are fine.)",
    );
  }

  const argv = scan.tokens;
  const executable = argv[0];
  if (!executable) {
    throw new ToolExecutionError("INVALID_ARGUMENT", "The command is empty.");
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const started = Date.now();

  return new Promise<RunCommandResult>((resolve, reject) => {
    const child = spawn(executable, argv.slice(1), {
      cwd: options.cwd,
      env: buildEnvironment(process.env, options.envAllowlist ?? DEFAULT_ENV_ALLOWLIST),
      // No shell: what was approved is what runs.
      shell: false,
      // Its own process group, so a timeout can kill the whole tree instead of
      // leaving orphaned grandchildren behind.
      detached: true,
      // No stdin: an interactive prompt would hang until the timeout, and
      // there is nobody to answer it.
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const killTree = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, signal);
        }
      } catch {
        // Already gone, or never started.
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      // A process that ignores SIGTERM does not get to keep running.
      setTimeout(() => killTree("SIGKILL"), 2_000).unref();
    }, timeoutMs);

    const onAbort = (): void => {
      timedOut = true;
      killTree("SIGKILL");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);

      const out = truncate(stdout);
      const err = truncate(stderr);

      resolve({
        command: options.command,
        cwd: options.displayCwd,
        exitCode,
        stdout: out.text,
        stderr: err.text,
        timedOut,
        durationMs: Date.now() - started,
        truncated: out.truncated || err.truncated,
      });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      // Keep reading past the cap so the process is never blocked on a full
      // pipe; the cap applies to what is reported, not to what is consumed.
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const message = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? `Command not found: ${executable}`
        : `Could not run ${executable}: ${error.message}`;
      reject(new ToolExecutionError("EXECUTION_FAILED", message));
    });

    child.on("close", (code) => finish(code));
  });
}
