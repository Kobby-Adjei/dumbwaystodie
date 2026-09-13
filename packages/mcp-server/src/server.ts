import * as readline from "node:readline";

import {
  createId,
  DEFAULT_RELAY_HOST,
  DEFAULT_RELAY_PORT,
  type ToolDescriptor,
  type WireMessage,
} from "@dumbways/protocol";
import { RelayConnection, readHandshakeFile } from "@dumbways/relay";

import {
  fromMcpToolName,
  JSON_RPC,
  MCP_PROTOCOL_VERSION,
  parseRequest,
  toMcpTool,
  type JsonRpcResponse,
} from "./protocol";

/**
 * The MCP server: a translator with a pipe on one side and a socket on the
 * other.
 *
 *   coding agent  --stdio-->  this  --websocket-->  relay  <--  editor
 *
 * It executes nothing itself. Every tool call is forwarded to the editor,
 * because the tools that matter most — the active document, the diagnostics —
 * only exist in a running editor. A standalone process could read the disk and
 * would silently miss every unsaved change, which is the one thing this whole
 * project exists to avoid.
 *
 * stdout belongs to the protocol. Every diagnostic goes to stderr; a stray
 * console.log here corrupts the stream and the agent sees a parse error.
 */

const log = (message: string): void => {
  process.stderr.write(`[mcp] ${message}\n`);
};

class McpBridge {
  private connection: RelayConnection | undefined;
  private tools: ToolDescriptor[] = [];
  private readonly pending = new Map<string, (message: WireMessage) => void>();
  private readonly sessionId = "mcp";

  async start(): Promise<void> {
    const handshake = await readHandshakeFile(
      Number(process.env["DUMBWAYS_RELAY_PORT"] ?? DEFAULT_RELAY_PORT),
    );

    if (!handshake) {
      /*
       * Fail loudly and stay alive.
       *
       * The agent has already spawned this process; exiting here makes the
       * tools vanish with no explanation. Answering `tools/list` with nothing
       * and every call with a readable error tells the user what to fix.
       */
      log("no relay handshake found — is the editor running with the relay started?");
      return;
    }

    this.connection = new RelayConnection({
      host: handshake.host || DEFAULT_RELAY_HOST,
      port: handshake.port,
      token: handshake.token,
      adapterKind: "mcp",
      adapterId: createId("mcp"),
      capabilities: ["tools.call"],
      log: (message) => log(message),
      onMessage: (message) => this.onRelayMessage(message),
    });

    await this.connection.connect();
    log(`attached to relay on ${handshake.host}:${handshake.port}`);
  }

  private onRelayMessage(message: WireMessage): void {
    if (message.type === "tool.result") {
      // Correlated by call id: the relay routes a result back to whoever
      // asked, so several agents can be attached without crossing wires.
      const resolve = this.pending.get(message.id);
      if (resolve) {
        this.pending.delete(message.id);
        resolve(message);
      }
      return;
    }

    if (message.type === "tools.available") {
      this.tools = message.tools;
      log(`editor published ${message.tools.length} tools`);
    }
  }

  /** The tool list, learned from the editor rather than hard-coded here. */
  listTools(): ToolDescriptor[] {
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<WireMessage> {
    const connection = this.connection;
    if (!connection) {
      throw new Error(
        "Not connected to the editor. Open the workspace in your editor and press Start in the Dumb Ways to Die panel.",
      );
    }

    const id = createId("tool");
    const settled = new Promise<WireMessage>((resolve, reject) => {
      this.pending.set(id, resolve);
      // The editor prompts for `shell.run`, and a human may take a while. This
      // is long enough not to punish deliberation and short enough that a lost
      // message does not hang the agent forever.
      setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error("The editor did not answer in time."));
        }
      }, 180_000).unref?.();
    });

    connection.send(this.sessionId, {
      type: "tool.call",
      id,
      sessionId: this.sessionId,
      tool: name,
      arguments: args,
    });

    return settled;
  }
}

/* ------------------------------------------------------------------ *
 * stdio
 * ------------------------------------------------------------------ */

function write(response: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

async function main(): Promise<void> {
  const bridge = new McpBridge();
  await bridge.start();

  const input = readline.createInterface({ input: process.stdin });

  for await (const line of input) {
    if (line.trim().length === 0) {
      continue;
    }

    const request = parseRequest(line);
    if (!request) {
      write({
        jsonrpc: "2.0",
        id: 0,
        error: { code: JSON_RPC.parseError, message: "Not a JSON-RPC 2.0 request." },
      });
      continue;
    }

    // A notification has no id and takes no reply — `notifications/initialized`
    // is the common one. Answering it is a protocol error.
    if (request.id === undefined) {
      continue;
    }

    try {
      write({ jsonrpc: "2.0", id: request.id, result: await handle(bridge, request.method, request.params ?? {}) });
    } catch (error) {
      write({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: JSON_RPC.internalError,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}

async function handle(
  bridge: McpBridge,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "dumb-ways-to-die", version: "0.1.0" },
      };

    case "tools/list":
      return { tools: bridge.listTools().map(toMcpTool) };

    case "tools/call": {
      const name = params["name"];
      if (typeof name !== "string") {
        throw new Error("tools/call requires a string name.");
      }

      const args = (params["arguments"] ?? {}) as Record<string, unknown>;
      const result = await bridge.callTool(fromMcpToolName(name), args);

      if (result.type !== "tool.result") {
        throw new Error("The editor sent an unexpected reply.");
      }

      /*
       * A refused tool is a *result*, not a transport error.
       *
       * `isError` keeps the agent in its own loop: it reads the reason and
       * adapts. A JSON-RPC error would look like the server broke, and agents
       * respond to that by giving up or retrying the same call.
       */
      if (!result.ok) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: result.error
                ? `${result.error.code}: ${result.error.message}`
                : "The tool failed without saying why.",
            },
          ],
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result.result, null, 2) }],
      };
    }

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

void main().catch((error: unknown) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
