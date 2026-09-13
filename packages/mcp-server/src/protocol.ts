/**
 * The MCP wire format, as much of it as a tools-only server needs.
 *
 * MCP is JSON-RPC 2.0 over stdio: the client spawns this process, writes
 * requests to stdin and reads responses from stdout. There is no port and no
 * network — the "connection" is a pair of pipes between two processes.
 *
 * Written by hand rather than pulled from the SDK for the same reason the
 * relay was: this is a contract, and a contract you can read in one file is
 * one you can debug at 2am. It is also the only way to keep the extension's
 * dependency count at zero.
 */

export const MCP_PROTOCOL_VERSION = "2024-11-05";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC's reserved codes, the only ones we ever send. */
export const JSON_RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export function parseRequest(line: string): JsonRpcRequest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const candidate = value as Partial<JsonRpcRequest>;
  if (candidate.jsonrpc !== "2.0" || typeof candidate.method !== "string") {
    return undefined;
  }

  return candidate as JsonRpcRequest;
}

/**
 * Describes a bridge tool to MCP.
 *
 * The bridge's own descriptors carry a name, a description and a permission
 * class but no argument schema, so this advertises a permissive object schema
 * and lets the tool's own `validate` do the real checking. That is not a
 * shortcut — the registry validates every call regardless of what any schema
 * claimed, so a stricter schema here would be a second source of truth.
 */
export function toMcpTool(tool: {
  name: string;
  description: string;
  permission: string;
}): Record<string, unknown> {
  const needsApproval = tool.permission === "execute";

  return {
    name: toMcpToolName(tool.name),
    description: needsApproval
      ? `${tool.description} (The user is asked to approve every run.)`
      : tool.description,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
  };
}

/*
 * MCP tool names are restricted to [A-Za-z0-9_-], so the dot in
 * `workspace.read_file` has to go. A single underscore would not survive the
 * round trip — `workspace.read_file` and `workspace.read.file` would both map
 * to the same thing — so the separator is doubled, which no tool name uses.
 */
export function toMcpToolName(name: string): string {
  return name.replace(/\./g, "__");
}

export function fromMcpToolName(name: string): string {
  return name.replace(/__/g, ".");
}
