import { ToolExecutionError } from "./ToolExecutionError";

/**
 * Runtime argument validation (spec §71).
 *
 * TypeScript types vanish at runtime, and tool arguments come from outside the
 * bridge. Every field a tool reads passes through here first — a handwritten
 * validator rather than a schema dependency, because there are four tools.
 */

export function expectArgs(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) {
    return {};
  }
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new ToolExecutionError("INVALID_ARGUMENT", "arguments must be an object.");
  }
  return args as Record<string, unknown>;
}

export function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolExecutionError(
      "INVALID_ARGUMENT",
      `"${key}" is required and must be a non-empty string.`,
    );
  }
  return value;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ToolExecutionError("INVALID_ARGUMENT", `"${key}" must be a string.`);
  }
  return value;
}

export function optionalPositiveInteger(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ToolExecutionError(
      "INVALID_ARGUMENT",
      `"${key}" must be a positive integer (1-based line number).`,
    );
  }
  return value;
}
