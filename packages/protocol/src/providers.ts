/**
 * The chats this bridge can drive, in one place.
 *
 * The panel's picker, the browser's site table and the router all need the
 * same list. Three copies of it is how a picker comes to offer a model nothing
 * can open — so the ids live here, in the package both sides already depend
 * on.
 *
 * `logo` is the mark each provider publishes for exactly this purpose — the
 * favicon their own site serves, fetched from it. Using it to identify which
 * service a tab talks to is the same thing a browser tab does; it is not a
 * claim of endorsement. `colour` and `initial` stay as the fallback for when
 * an image cannot load, so a missing file degrades to a readable tile rather
 * than a hole.
 *
 * Before publishing publicly, check each provider's brand guidelines: some ask
 * for clear space or forbid recolouring, and none of that is enforced here.
 */

export interface ChatProvider {
  /** Matches the browser's surface type, and what a request names. */
  id: string;
  label: string;
  /** Brand hue, for the tile. */
  colour: string;
  /** One or two characters, shown only if the logo fails to load. */
  initial: string;
  /** Filename under media/logos, served by the panel. */
  logo: string;
}

export const CHAT_PROVIDERS: readonly ChatProvider[] = [
  { id: "chatgpt", logo: "chatgpt.svg", label: "ChatGPT", colour: "#10a37f", initial: "G" },
  { id: "claude", logo: "claude.svg", label: "Claude", colour: "#d97757", initial: "C" },
  { id: "gemini", logo: "gemini.svg", label: "Gemini", colour: "#4285f4", initial: "◆" },
  { id: "copilot", logo: "copilot.ico", label: "Copilot", colour: "#0078d4", initial: "Co" },
  { id: "perplexity", logo: "perplexity.ico", label: "Perplexity", colour: "#20808d", initial: "P" },
  { id: "deepseek", logo: "deepseek.svg", label: "DeepSeek", colour: "#4d6bfe", initial: "D" },
  { id: "mistral", logo: "mistral.svg", label: "Le Chat", colour: "#fa520f", initial: "M" },
  { id: "grok", logo: "grok.ico", label: "Grok", colour: "#1d9bf0", initial: "X" },
  { id: "zai", logo: "zai.svg", label: "Z.ai", colour: "#3a5bff", initial: "Z" },
];

export function providerById(id: string): ChatProvider | undefined {
  return CHAT_PROVIDERS.find((provider) => provider.id === id);
}
