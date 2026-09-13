import type { ToolError, ToolErrorCode } from "@dumbways/protocol";

/**
 * The one error type tools throw. Everything the registry catches that is not
 * one of these becomes INTERNAL with a generic message, so an unexpected
 * stack trace never travels to the provider (spec §48).
 */
export class ToolExecutionError extends Error {
  readonly code: ToolErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ToolErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ToolExecutionError";
    this.code = code;
    this.details = details;
  }

  toToolError(): ToolError {
    const error: ToolError = { code: this.code, message: this.message };
    if (this.details) {
      error.details = this.details;
    }
    return error;
  }
}
