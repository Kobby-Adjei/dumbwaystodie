import type { ClientCapabilities, ConnectionSnapshot, ToolDescriptor } from "@dumbways/protocol";
import type { PermissionClass, PermissionDecision } from "@dumbways/protocol";

/**
 * The diagnostics report (spec §44).
 *
 * The spec is blunt about why this exists: "This will save hours of debugging."
 * A bridge with five hops, two transports, two search backends and a permission
 * gate has a lot of ways to be *almost* working, and "it doesn't answer" is the
 * same symptom for all of them.
 *
 * Pure, so what it says can be tested rather than eyeballed.
 */

export interface DiagnosticsInput {
  extensionVersion: string;
  protocolVersion: number;
  transport: "in-process" | "relay" | "clipboard";
  relayPort: number;
  relayEndpoint?: string;
  connections: ConnectionSnapshot;
  requestState: string;
  lastError?: string;
  sessionId: string;
  sessionMessages: number;
  activeRequestId?: string;
  workspaceRoots: string[];
  tools: ToolDescriptor[];
  capabilities: ClientCapabilities;
  permissionMode: string;
  permissionPolicy: Record<PermissionClass, PermissionDecision>;
  rememberedApprovals: number;
  searchBackend: string;
  ripgrepPath?: string;
  mediaDir: string;
  attachmentsStaged: number;
  envAllowlist: string[];
}

function section(title: string, lines: string[]): string {
  return [`## ${title}`, ...lines, ""].join("\n");
}

export function buildDiagnosticsReport(input: DiagnosticsInput): string {
  const out: string[] = [
    `# DUMB WAYS TO DIE — DIAGNOSTICS`,
    `Generated ${new Date().toISOString()}`,
    "",
  ];

  out.push(
    section("Versions", [
      `Extension:  ${input.extensionVersion}`,
      `Protocol:   ${input.protocolVersion}`,
      `Node:       ${process.version}`,
      `Platform:   ${process.platform} ${process.arch}`,
    ]),
  );

  out.push(
    section("Connections", [
      `Transport:     ${input.transport}`,
      ...(input.transport === "relay"
        ? [
            `Relay port:    ${input.relayPort}`,
            `Relay endpoint:${input.relayEndpoint ? ` ${input.relayEndpoint}` : " (not connected)"}`,
          ]
        : []),
      `Editor:        ${input.connections.editor}`,
      `Provider:      ${input.connections.provider} (${input.connections.providerName})`,
      `Relay:         ${input.connections.relay}`,
      `Browser:       ${input.connections.browser}`,
      `Chat surface:  ${input.connections.chatSurface}`,
    ]),
  );

  out.push(
    section("Request", [
      `State:          ${input.requestState}`,
      `In flight:      ${input.activeRequestId ?? "none"}`,
      `Last error:     ${input.lastError ?? "none"}`,
    ]),
  );

  out.push(
    section("Session", [
      `Id:             ${input.sessionId}`,
      `Messages:       ${input.sessionMessages}`,
      `Workspace:      ${input.workspaceRoots.length > 0 ? input.workspaceRoots.join(", ") : "(no folder open — workspace tools will refuse)"}`,
    ]),
  );

  out.push(
    section(
      "Tools",
      input.tools.length === 0
        ? ["(none registered)"]
        : input.tools.map((tool) => `${tool.permission.padEnd(11)} ${tool.name}`),
    ),
  );

  out.push(
    section(
      "Advertised capabilities",
      Object.entries(input.capabilities).map(
        ([name, enabled]) => `${enabled ? "yes" : "no "}  ${name}`,
      ),
    ),
  );

  out.push(
    section("Permissions", [
      `Mode:           ${input.permissionMode}`,
      ...Object.entries(input.permissionPolicy).map(
        ([permissionClass, decision]) => `  ${permissionClass.padEnd(12)} ${decision}`,
      ),
      `Remembered:     ${input.rememberedApprovals} approval(s)`,
    ]),
  );

  out.push(
    section("Search", [
      `Backend:        ${input.searchBackend}`,
      `Ripgrep:        ${input.ripgrepPath ?? "not found — regex search will be refused"}`,
    ]),
  );

  out.push(
    section("Media", [
      `Directory:      ${input.mediaDir}`,
      `Staged now:     ${input.attachmentsStaged}`,
    ]),
  );

  out.push(
    section("Command environment", [
      `Allowlist:      ${input.envAllowlist.join(", ")}`,
      `(everything else is dropped before a command runs)`,
    ]),
  );

  return out.join("\n");
}
