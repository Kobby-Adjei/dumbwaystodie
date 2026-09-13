import {
  DEFAULT_RELAY_PORT,
  STRICT_COACH_PERMISSIONS,
  createId,
  type CoachSession,
  type WireMessage,
} from "@dumbways/protocol";
import { RelayConnection, readHandshakeFile } from "@dumbways/relay";

import { MockCoachProvider } from "./index";

/**
 * The mock provider as a separate process (spec §53 Phase 6).
 *
 * This is the whole point of the phase: the provider stops being an object
 * inside the extension and becomes something on the other end of a socket. If
 * the architecture is right, the provider class itself needs no changes — only
 * its transport does. It did not need any.
 */

async function main(): Promise<void> {
  const port = Number(process.env["DUMBWAYS_RELAY_PORT"] ?? DEFAULT_RELAY_PORT);
  const handshake = await readHandshakeFile(port);

  if (!handshake) {
    process.stderr.write(
      `[mock-provider] No relay found on port ${port}. Start it with "npm run dev:relay" first.\n`,
    );
    process.exit(1);
  }

  const provider = new MockCoachProvider({ latencyMs: 250 });

  // The provider's session is a shell: it exists because connect() takes one.
  // Real session state lives in the editor, which is the only side that knows
  // what the user is doing.
  const session: CoachSession = {
    id: createId("session"),
    name: "relay",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workspaceRoots: [],
    messages: [],
    permissions: STRICT_COACH_PERMISSIONS,
  };

  const connection = new RelayConnection({
    host: handshake.host,
    port: handshake.port,
    token: handshake.token,
    adapterKind: "provider",
    adapterId: createId("provider"),
    capabilities: ["coach.respond", "tool.call"],
    log: (message) => process.stdout.write(`${message}\n`),
    onStateChange: (state, detail) => {
      process.stdout.write(`[mock-provider] relay ${state}${detail ? `: ${detail}` : ""}\n`);
    },
    onMessage: (message: WireMessage) => {
      switch (message.type) {
        case "coach.request":
          process.stdout.write(`[mock-provider] request ${message.request.id}\n`);
          void provider.sendRequest(message.request);
          return;
        case "tool.result":
          process.stdout.write(
            `[mock-provider] tool result ${message.id} ok=${String(message.ok)}\n`,
          );
          void provider.sendToolResult(message);
          return;
        default:
          return;
      }
    },
  });

  // Everything the provider emits is already a wire message — the in-process
  // and over-the-wire shapes were the same from the start (spec §22).
  provider.onMessage((outbound) => {
    const sessionId =
      outbound.type === "coach.response"
        ? outbound.response.sessionId
        : outbound.type === "tool.call"
          ? outbound.sessionId
          : session.id;

    try {
      connection.send(sessionId, outbound as WireMessage);
    } catch (error) {
      process.stderr.write(`[mock-provider] could not send: ${String(error)}\n`);
    }
  });

  await connection.connect();
  await provider.connect(session);

  process.stdout.write(
    `[mock-provider] attached to relay at ws://${handshake.host}:${handshake.port}/transport\n`,
  );
  process.stdout.write("[mock-provider] READY\n");

  const shutdown = (): void => {
    connection.close();
    void provider.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`[mock-provider] failed to start: ${String(error)}\n`);
    process.exit(1);
  });
}
