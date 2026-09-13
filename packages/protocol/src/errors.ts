/**
 * Typed errors (spec §48).
 *
 * Errors returned across the bridge must be useful for debugging but must
 * never leak secrets, absolute paths outside the workspace, or tokens.
 */

export type ToolErrorCode =
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "OUTSIDE_WORKSPACE"
  | "TIMEOUT"
  | "INVALID_ARGUMENT"
  | "TOO_LARGE"
  | "EXECUTION_FAILED"
  | "UNSUPPORTED"
  | "INTERNAL";

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type ProtocolErrorCode =
  | "UNSUPPORTED_PROTOCOL_VERSION"
  | "MALFORMED_ENVELOPE"
  | "UNKNOWN_SESSION"
  | "NOT_AUTHENTICATED";

export interface ProtocolError {
  code: ProtocolErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class ProtocolViolation extends Error {
  readonly code: ProtocolErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ProtocolErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ProtocolViolation";
    this.code = code;
    this.details = details;
  }
}
