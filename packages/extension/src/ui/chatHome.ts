/**
 * Where a provider's coding chats live — the part with no `vscode` in it.
 *
 * A person's ChatGPT is not a tool they picked up for this; it is a place they
 * already keep things, with a history they scroll and a memory that has learned
 * who they are. Filling it with an agent's turns and the shape of a codebase is
 * a real cost, paid somewhere the editor cannot see — so the destination is the
 * user's decision, asked once per provider and remembered.
 *
 * Every option is the provider's own feature. Nothing is scraped and no account
 * is touched: the user says where, and the browser opens that.
 *
 * Kept pure so the two things that must not be sloppy — what gets accepted, and
 * whether the words shown match what will happen — are testable without an
 * editor to run them in.
 */

export interface HomeChoice {
  /** The URL to open, or undefined to use the site's ordinary new chat. */
  url?: string;
  /** What the user chose, for the log and for saying so honestly. */
  kind: "project" | "temporary" | "history";
}

/**
 * A temporary chat, for the providers that have one.
 *
 * Offered as a canned choice rather than assumed: if a provider changes the
 * parameter, the user can still paste a URL. The reason it is worth offering at
 * all is that a temporary chat is the only option that keeps a coding session
 * out of history **and** out of memory.
 */
export const TEMPORARY_CHAT: Record<string, string> = {
  chatgpt: "https://chatgpt.com/?temporary-chat=true",
};

/** A stored choice in the words it was chosen in. */
export function describeHome(choice: HomeChoice): string {
  switch (choice.kind) {
    case "project":
      return "in your project";
    case "temporary":
      return "in a temporary chat";
    default:
      return "in your normal history";
  }
}

/**
 * Checks a pasted destination before it is stored.
 *
 * The browser validates it again — it is the one opening the tab — but a
 * mistake caught here is a sentence the user can act on, rather than a chat
 * that silently opens in the wrong place.
 */
export function validateHome(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "Paste the address of the project.";
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "That is not a web address.";
  }

  if (parsed.protocol !== "https:") {
    // Also what refuses `javascript:` and `data:`, which would make this
    // setting a way to have the add-on open something it should not.
    return "It has to be an https address.";
  }

  return undefined;
}
