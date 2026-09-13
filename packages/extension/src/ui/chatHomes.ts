import * as vscode from "vscode";

import { describeHome, TEMPORARY_CHAT, validateHome, type HomeChoice } from "./chatHome";

/**
 * Asking the user where coding chats should live, and remembering the answer.
 *
 * The reasoning behind the question lives in `chatHome.ts` with the pure logic;
 * this is the editor half — one quick pick, one input box, one stored value.
 */

export { describeHome, type HomeChoice };

/** Per-account, not per-workspace: this is about their chat, not this repo. */
const KEY = "chatHomes";

export class ChatHomes {
  constructor(private readonly memento: vscode.Memento) {}

  private all(): Record<string, HomeChoice> {
    return this.memento.get<Record<string, HomeChoice>>(KEY) ?? {};
  }

  get(surfaceType: string): HomeChoice | undefined {
    return this.all()[surfaceType];
  }

  async remember(surfaceType: string, choice: HomeChoice): Promise<void> {
    await this.memento.update(KEY, { ...this.all(), [surfaceType]: choice });
  }

  async forget(surfaceType: string): Promise<void> {
    const next = { ...this.all() };
    delete next[surfaceType];
    await this.memento.update(KEY, next);
  }

  /**
   * The stored choice, or one asked for now.
   *
   * Returns undefined only when the user dismissed the question — which is not
   * the same as choosing their history, and is therefore not remembered as if
   * it were.
   */
  async resolve(surfaceType: string, label: string): Promise<HomeChoice | undefined> {
    const existing = this.get(surfaceType);
    if (existing) {
      return existing;
    }

    const temporary = TEMPORARY_CHAT[surfaceType];

    const options: (vscode.QuickPickItem & { choice: HomeChoice["kind"] })[] = [
      {
        choice: "project",
        label: "In a project I'll paste",
        detail: `Coding chats group under that project instead of your ${label} history.`,
      },
      ...(temporary
        ? [
            {
              choice: "temporary" as const,
              label: "In a temporary chat",
              detail: "Nothing is saved to your history, and nothing is added to memory.",
            },
          ]
        : []),
      {
        choice: "history",
        label: `In my normal ${label} history`,
        detail: "Coding sessions appear alongside everything else you use it for.",
      },
    ];

    const picked = await vscode.window.showQuickPick(options, {
      title: `Where should coding chats live in ${label}?`,
      placeHolder: "Asked once — change it later with Where Coding Chats Live",
      ignoreFocusOut: true,
    });

    if (!picked) {
      return undefined;
    }

    if (picked.choice === "history") {
      const choice: HomeChoice = { kind: "history" };
      await this.remember(surfaceType, choice);
      return choice;
    }

    if (picked.choice === "temporary" && temporary) {
      const choice: HomeChoice = { kind: "temporary", url: temporary };
      await this.remember(surfaceType, choice);
      return choice;
    }

    const pasted = await vscode.window.showInputBox({
      title: `Paste the ${label} project URL`,
      prompt: `Open the project in ${label} and copy the address bar.`,
      ignoreFocusOut: true,
      validateInput: (value) => validateHome(value),
    });

    if (!pasted) {
      return undefined;
    }

    const choice: HomeChoice = { kind: "project", url: pasted.trim() };
    await this.remember(surfaceType, choice);
    return choice;
  }
}
