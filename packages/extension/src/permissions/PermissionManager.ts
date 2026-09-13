import type { LearningMode, PermissionClass, PermissionDecision } from "@dumbways/protocol";

/**
 * The permission gate (spec §16, §17, §78).
 *
 * Until now this was a lookup that failed closed, because "ask" with no way to
 * ask is a denial. This turns it into a real decision with a human in it.
 *
 * No `vscode` import: the policy is pure and testable, and the prompt is an
 * interface. That separation matters because the policy is the part that must
 * be right — a bug here grants something the user did not agree to.
 */

export interface PermissionQuery {
  callId: string;
  tool: string;
  permission: PermissionClass;
  /** Exactly what is being asked, e.g. `npm test` — shown to the user. */
  summary: string;
}

export type ApprovalOutcome = "allow-once" | "allow-always" | "deny";

export interface PermissionPrompt {
  /** Resolves with the user's choice. Dismissal must resolve as "deny". */
  ask(query: PermissionQuery): Promise<ApprovalOutcome>;
}

/** Remembered grants, scoped to a workspace by whoever supplies the store. */
export interface GrantStore {
  read(): string[];
  write(keys: string[]): Promise<void>;
}

/**
 * Spec §78. One user-facing knob rather than two overlapping ones: the
 * learning mode *is* the permission policy, because on this product they
 * describe the same intent.
 */
export const MODE_POLICIES: Record<LearningMode, Record<PermissionClass, PermissionDecision>> = {
  "strict-coach": { read: "allow", execute: "ask", write: "deny", destructive: "deny" },
  guided: { read: "allow", execute: "ask", write: "ask", destructive: "deny" },
  "normal-agent": { read: "allow", execute: "ask", write: "ask", destructive: "ask" },
};

export interface PermissionManagerOptions {
  getMode: () => LearningMode;
  prompt: PermissionPrompt;
  store: GrantStore;
  log?: (message: string) => void;
  /** Called around a prompt so callers can suspend their own timeouts. */
  onPromptOpen?: () => void;
  onPromptClose?: () => void;
}

/**
 * A remembered grant is keyed by tool *and* arguments.
 *
 * "Always allow shell.run" would be a blank cheque — the user approved
 * `npm test`, not "any command forever". The summary is part of the key so the
 * grant covers only what was actually shown to them.
 */
export function grantKey(query: PermissionQuery): string {
  return `${query.tool}::${query.summary}`;
}

export class PermissionManager {
  constructor(private readonly options: PermissionManagerOptions) {}

  policy(): Record<PermissionClass, PermissionDecision> {
    return MODE_POLICIES[this.options.getMode()] ?? MODE_POLICIES["strict-coach"];
  }

  remembered(): string[] {
    return this.options.store.read();
  }

  async forgetAll(): Promise<number> {
    const count = this.options.store.read().length;
    await this.options.store.write([]);
    this.options.log?.("[permissions] cleared all remembered approvals");
    return count;
  }

  async resolve(query: PermissionQuery): Promise<PermissionDecision> {
    const decision = this.policy()[query.permission];

    if (decision === "allow") {
      return "allow";
    }
    if (decision === "deny") {
      this.options.log?.(
        `[permissions] ${query.tool} denied by policy (${query.permission} is disabled in ${this.options.getMode()} mode)`,
      );
      return "deny";
    }

    const key = grantKey(query);
    if (this.options.store.read().includes(key)) {
      this.options.log?.(`[permissions] ${query.tool} allowed by a remembered approval`);
      return "allow";
    }

    this.options.onPromptOpen?.();
    let outcome: ApprovalOutcome;
    try {
      outcome = await this.options.prompt.ask(query);
    } catch (error) {
      // A prompt that fails is not an approval.
      this.options.log?.(`[permissions] prompt failed, denying: ${String(error)}`);
      return "deny";
    } finally {
      this.options.onPromptClose?.();
    }

    if (outcome === "allow-always") {
      const keys = [...new Set([...this.options.store.read(), key])];
      await this.options.store.write(keys);
      this.options.log?.(`[permissions] remembering approval for ${key}`);
      return "allow";
    }

    this.options.log?.(`[permissions] ${query.tool} ${outcome === "allow-once" ? "allowed once" : "denied"}`);
    return outcome === "allow-once" ? "allow" : "deny";
  }
}
