import * as vscode from "vscode";

import type { ApprovalOutcome, GrantStore, PermissionPrompt, PermissionQuery } from "./PermissionManager";

/**
 * The approval dialog (spec §17).
 *
 * Modal on purpose. A dismissible toast for "may I run a command" is a
 * notification the user learns to swat away, and the one time it matters they
 * will swat that one too. This blocks, states exactly what was asked, and
 * treats dismissal as refusal.
 */
export class VsCodePermissionPrompt implements PermissionPrompt {
  async ask(query: PermissionQuery): Promise<ApprovalOutcome> {
    const allowOnce = "Allow once";
    const allowAlways = `Always allow ${query.summary || query.tool}`;
    const deny = "Deny";

    const choice = await vscode.window.showWarningMessage(
      `Dumb Ways to Die wants to run a ${query.permission} tool.`,
      {
        modal: true,
        detail: [
          `Tool:      ${query.tool}`,
          query.summary ? `Request:   ${query.summary}` : undefined,
          "",
          "Nothing runs unless you allow it. “Always allow” remembers this exact",
          "request in this workspace only, and can be undone with",
          "“Dumb Ways to Die: Forget Approvals”.",
        ]
          .filter((line) => line !== undefined)
          .join("\n"),
      },
      allowOnce,
      // VS Code truncates long modal buttons; keep the remembered option short
      // when the summary is long.
      allowAlways.length > 40 ? "Always allow this exact request" : allowAlways,
      deny,
    );

    if (choice === allowOnce) {
      return "allow-once";
    }
    if (choice === deny || choice === undefined) {
      // Escape, or clicking away, is a refusal — never a silent yes.
      return "deny";
    }
    return "allow-always";
  }
}

/** Remembered grants live in workspace state: a grant here is not a grant there. */
export class WorkspaceGrantStore implements GrantStore {
  private static readonly KEY = "dumbways.approvals";

  constructor(private readonly memento: vscode.Memento) {}

  read(): string[] {
    return this.memento.get<string[]>(WorkspaceGrantStore.KEY, []);
  }

  async write(keys: string[]): Promise<void> {
    await this.memento.update(WorkspaceGrantStore.KEY, keys);
  }
}
