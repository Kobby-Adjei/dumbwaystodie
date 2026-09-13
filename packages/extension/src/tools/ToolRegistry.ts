import {
  TOOL_NAMES,
  type ClientCapabilities,
  type PermissionClass,
  type PermissionDecision,
  type ToolCallRequest,
  type ToolCallResult,
  type ToolDescriptor,
  NO_CAPABILITIES,
} from "@dumbways/protocol";

import { summarizeArgs } from "./summarize";
import { ToolExecutionError } from "./ToolExecutionError";

/**
 * Tool registry (spec §69).
 *
 * Every tool is a self-describing object with its own validator, permission
 * class and timeout. No giant switch statement, and no tool that can be
 * invoked without passing the same four gates:
 *
 *   1. is it registered?
 *   2. does its permission class allow it right now?
 *   3. do its arguments validate?
 *   4. did it finish inside its timeout?
 *
 * The provider is untrusted input even when it is an AI (spec §75). "The model
 * asked for it" is not an authorisation.
 */

export interface ToolExecutionContext {
  sessionId: string;
  requestId: string | undefined;
  signal: AbortSignal;
  log: (message: string) => void;
}

export interface ToolDefinition<TArgs, TResult> {
  name: string;
  description: string;
  permission: PermissionClass;
  timeoutMs: number;
  validate(args: unknown): TArgs;
  execute(args: TArgs, context: ToolExecutionContext): Promise<TResult>;
}

export interface PermissionRequest {
  callId: string;
  tool: string;
  permission: PermissionClass;
  /** What the user will be shown, e.g. `npm test`. */
  summary: string;
}

export interface ToolRegistryOptions {
  /**
   * Async because a decision may involve asking a human. The tool's own
   * timeout deliberately starts *after* this resolves — otherwise a 5s tool
   * timeout would expire while the user was still reading the dialog.
   */
  resolvePermission: (
    request: PermissionRequest,
  ) => PermissionDecision | Promise<PermissionDecision>;
  log?: (message: string) => void;
  /** Idempotency cache size (spec §84). */
  resultCacheSize?: number;
}

const CAPABILITY_BY_TOOL: Record<string, keyof ClientCapabilities> = {
  [TOOL_NAMES.activeDocument]: "readActiveDocument",
  [TOOL_NAMES.readFile]: "readFile",
  [TOOL_NAMES.listDirectory]: "listDirectory",
  [TOOL_NAMES.diagnostics]: "readDiagnostics",
  [TOOL_NAMES.search]: "searchFiles",
  [TOOL_NAMES.projectTree]: "projectTree",
  [TOOL_NAMES.runCommand]: "runCommand",
};

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<unknown, unknown>>();
  private readonly recentResults = new Map<string, ToolCallResult>();
  private readonly cacheSize: number;

  constructor(private readonly options: ToolRegistryOptions) {
    this.cacheSize = options.resultCacheSize ?? 50;
  }

  register<TArgs, TResult>(definition: ToolDefinition<TArgs, TResult>): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool "${definition.name}" is already registered.`);
    }
    this.tools.set(definition.name, definition as ToolDefinition<unknown, unknown>);
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      permission: tool.permission,
    }));
  }

  /**
   * Capabilities are derived from what is registered, never hand-maintained,
   * so the bridge cannot advertise a tool it does not have.
   */
  getCapabilities(): ClientCapabilities {
    const capabilities: ClientCapabilities = { ...NO_CAPABILITIES };
    for (const name of this.tools.keys()) {
      const key = CAPABILITY_BY_TOOL[name];
      if (key) {
        capabilities[key] = true;
      }
    }
    return capabilities;
  }

  async execute(call: ToolCallRequest, externalSignal?: AbortSignal): Promise<ToolCallResult> {
    // Spec §84: a duplicate packet must not run the tool twice.
    const cached = this.recentResults.get(call.id);
    if (cached) {
      this.log(`[tool ${call.id}] duplicate call, returning cached result`);
      return cached;
    }

    const started = Date.now();
    const tool = this.tools.get(call.tool);

    if (!tool) {
      return this.finish(
        call,
        this.failure(
          call,
          "UNSUPPORTED",
          `Unknown tool "${call.tool}". Available: ${[...this.tools.keys()].join(", ") || "none"}.`,
          undefined,
          Date.now() - started,
        ),
      );
    }

    const decision = await this.options.resolvePermission({
      callId: call.id,
      tool: tool.name,
      permission: tool.permission,
      summary: summarizeArgs(call),
    });

    if (decision !== "allow") {
      return this.finish(
        call,
        this.failure(
          call,
          "PERMISSION_DENIED",
          `"${tool.name}" was not permitted (${tool.permission}). The user did not approve this request.`,
          { tool: tool.name, permission: tool.permission, decision },
          Date.now() - started,
        ),
      );
    }

    let args: unknown;
    try {
      args = tool.validate(call.arguments);
    } catch (error) {
      return this.finish(call, this.failure(call, ...describe(error), Date.now() - started));
    }

    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;

    // Cancelling the request aborts whatever it is doing — a 30s command or a
    // long search stops, rather than running on with nobody waiting for it.
    const onExternalAbort = (): void => controller.abort();
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      const result = await Promise.race([
        tool.execute(args, {
          sessionId: call.sessionId,
          requestId: call.requestId,
          signal: controller.signal,
          log: (message) => this.log(message),
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(
              new ToolExecutionError(
                "TIMEOUT",
                `"${tool.name}" exceeded its ${tool.timeoutMs}ms timeout.`,
              ),
            );
          }, tool.timeoutMs);
        }),
      ]);

      const durationMs = Date.now() - started;
      this.log(`[tool ${call.id}] ${tool.name} ok in ${durationMs}ms`);

      return this.finish(call, {
        type: "tool.result",
        id: call.id,
        sessionId: call.sessionId,
        ok: true,
        result,
        durationMs,
      });
    } catch (error) {
      const durationMs = Date.now() - started;
      const [code, message, details] = describe(error);
      this.log(`[tool ${call.id}] ${tool.name} failed: ${code} ${message}`);
      return this.finish(call, this.failure(call, code, message, details, durationMs));
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      externalSignal?.removeEventListener("abort", onExternalAbort);
      controller.abort();
    }
  }

  private failure(
    call: ToolCallRequest,
    code: Parameters<typeof buildError>[0],
    message: string,
    details: Record<string, unknown> | undefined,
    durationMs: number,
  ): ToolCallResult {
    return {
      type: "tool.result",
      id: call.id,
      sessionId: call.sessionId,
      ok: false,
      error: buildError(code, message, details),
      durationMs,
    };
  }

  private finish(call: ToolCallRequest, result: ToolCallResult): ToolCallResult {
    this.recentResults.set(call.id, result);
    if (this.recentResults.size > this.cacheSize) {
      const oldest = this.recentResults.keys().next();
      if (!oldest.done) {
        this.recentResults.delete(oldest.value);
      }
    }
    return result;
  }

  private log(message: string): void {
    this.options.log?.(message);
  }
}

function buildError(
  code: ToolExecutionError["code"],
  message: string,
  details?: Record<string, unknown>,
) {
  return details ? { code, message, details } : { code, message };
}

/**
 * Anything that is not a ToolExecutionError is a bug in this extension, not
 * something the provider should see the internals of (spec §48).
 */
function describe(
  error: unknown,
): [ToolExecutionError["code"], string, Record<string, unknown> | undefined] {
  if (error instanceof ToolExecutionError) {
    return [error.code, error.message, error.details];
  }
  return ["INTERNAL", "The tool failed unexpectedly.", undefined];
}
