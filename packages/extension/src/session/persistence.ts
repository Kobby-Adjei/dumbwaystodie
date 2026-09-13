import type { CoachSession, SessionMessage, WorkspaceRootRef } from "@dumbways/protocol";

/**
 * The two decisions behind restoring a conversation.
 *
 * `SessionStore` itself imports `vscode` and so cannot be loaded outside an
 * extension host — which is exactly why these live here instead. What is worth
 * pinning is not "does it write to storage" but "when does it refuse to", and
 * that is answerable without an editor.
 */

/** Enough to keep the thread, not enough to slow down activation. */
export const MAX_PERSISTED_MESSAGES = 200;

/**
 * Whether a stored session belongs to the workspace now open.
 *
 * A conversation restored into a different project would talk about files that
 * are not there and a ledger would claim the chat had already been sent them.
 * A fresh session is worse than nothing only if you never had the old one; a
 * *wrong* session is worse than either.
 */
export function belongsToWorkspace(
  saved: CoachSession | undefined,
  roots: WorkspaceRootRef[],
): saved is CoachSession {
  if (!saved || !Array.isArray(saved.messages)) {
    return false;
  }

  return fingerprint(saved.workspaceRoots ?? []) === fingerprint(roots);
}

function fingerprint(roots: WorkspaceRootRef[]): string {
  // Sorted, because the order the editor reports folders in is not a promise.
  return roots
    .map((root) => root.path)
    .sort()
    .join("|");
}

/** The tail of a conversation — the recent turns, not the oldest ones. */
export function boundMessages(
  messages: SessionMessage[],
  max = MAX_PERSISTED_MESSAGES,
): SessionMessage[] {
  return messages.length <= max ? messages : messages.slice(-max);
}
