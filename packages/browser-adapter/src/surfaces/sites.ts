/**
 * Everything this project knows about specific websites, in one table.
 *
 * Spec §0G wants site knowledge isolated. It used to be isolated in a *class*,
 * which meant supporting a second chat meant writing a second copy of the same
 * mechanics. Typing into a box, pressing send, and watching text settle are
 * not ChatGPT behaviours — they are chat behaviours. So the mechanics moved to
 * ConfiguredChatSurface and what remains here is the only genuinely
 * site-specific thing: which elements to aim at.
 *
 * Every list ends with generic fallbacks, so a site that renames its testid
 * degrades to "still works, less precisely" rather than to nothing.
 */

export interface ChatSiteConfig {
  /** Reported to the editor and shown to the user. */
  surfaceType: string;
  /** Human name, for messages. */
  label: string;
  /** Hosts this applies to, exact matches. */
  hosts: string[];
  /**
   * Where a fresh conversation starts.
   *
   * The add-on opens this itself when the user picks a model, so choosing
   * "Claude" in the editor does not mean "go and find a Claude tab" — the
   * browser is ours to drive, and making the user manage tabs for a router
   * they already asked for is work we can simply do.
   */
  newChatUrl: string;
  composer: string[];
  send: string[];
  /** Where the assistant's replies land. */
  message: string[];
  /** Visible only while generating — the one certain "not finished" signal. */
  stop: string[];
}

/**
 * Selectors that are worth trying anywhere.
 *
 * A chat page is a recognisable shape: one editable box, a submit control, and
 * a list of message bubbles. These are ordered least-surprising-first and are
 * appended to every site, so a site config is a set of *preferences*, not a
 * complete specification.
 */
const GENERIC_COMPOSER = [
  'form div[contenteditable="true"]',
  'div[contenteditable="true"][role="textbox"]',
  'div[contenteditable="true"]',
  "form textarea",
  "textarea",
];

const GENERIC_SEND = [
  'button[data-testid="send-button"]',
  'button[aria-label*="send" i]',
  'button[title*="send" i]',
  'form button[type="submit"]',
];

const GENERIC_MESSAGE = [
  '[data-message-author-role="assistant"]',
  '[data-testid*="assistant" i]',
  "[class*='assistant']",
  "[class*='model-response']",
];

const GENERIC_STOP = [
  'button[data-testid="stop-button"]',
  'button[aria-label*="stop" i]',
  'button[title*="stop" i]',
];

function site(config: ChatSiteConfig): ChatSiteConfig {
  return {
    ...config,
    composer: [...config.composer, ...GENERIC_COMPOSER],
    send: [...config.send, ...GENERIC_SEND],
    message: [...config.message, ...GENERIC_MESSAGE],
    stop: [...config.stop, ...GENERIC_STOP],
  };
}

export const CHAT_SITES: ChatSiteConfig[] = [
  site({
    surfaceType: "chatgpt",
    newChatUrl: "https://chatgpt.com/",
    label: "ChatGPT",
    hosts: ["chatgpt.com", "chat.openai.com"],
    composer: ["#prompt-textarea", 'div[contenteditable="true"][data-virtualkeyboard="true"]'],
    send: ['button[data-testid="send-button"]'],
    message: [
      '[data-message-author-role="assistant"]',
      "article[data-testid^='conversation-turn'] .markdown",
      ".agent-turn",
    ],
    stop: ['button[data-testid="stop-button"]'],
  }),
  site({
    surfaceType: "claude",
    newChatUrl: "https://claude.ai/new",
    label: "Claude",
    hosts: ["claude.ai"],
    composer: ['div[contenteditable="true"].ProseMirror', "fieldset div[contenteditable='true']"],
    send: ['button[aria-label="Send message"]', 'button[aria-label*="Send" i]'],
    message: ["[data-testid='assistant-message']", ".font-claude-message", ".font-claude-response"],
    stop: ['button[aria-label*="Stop" i]'],
  }),
  site({
    surfaceType: "gemini",
    newChatUrl: "https://gemini.google.com/app",
    label: "Gemini",
    hosts: ["gemini.google.com"],
    composer: ["rich-textarea div[contenteditable='true']", ".ql-editor"],
    send: ["button.send-button", 'button[aria-label*="Send" i]'],
    message: ["message-content", "model-response"],
    stop: ["button.stop-button", 'button[aria-label*="Stop" i]'],
  }),
  site({
    surfaceType: "copilot",
    newChatUrl: "https://copilot.microsoft.com/",
    label: "Microsoft Copilot",
    hosts: ["copilot.microsoft.com"],
    composer: ["#userInput", 'textarea[data-testid="composer-input"]'],
    send: ['button[data-testid="submit-button"]', 'button[title*="Submit" i]'],
    message: ["[data-content='ai-message']", "div[class*='aiMessage']"],
    stop: ['button[title*="Stop" i]'],
  }),
  site({
    surfaceType: "perplexity",
    newChatUrl: "https://www.perplexity.ai/",
    label: "Perplexity",
    hosts: ["www.perplexity.ai", "perplexity.ai"],
    composer: ["textarea[placeholder]", 'div[contenteditable="true"]'],
    send: ['button[aria-label="Submit"]'],
    message: [".prose", "[class*='answer']"],
    stop: ['button[aria-label*="Stop" i]'],
  }),
  site({
    surfaceType: "deepseek",
    newChatUrl: "https://chat.deepseek.com/",
    label: "DeepSeek",
    hosts: ["chat.deepseek.com"],
    composer: ["#chat-input", "textarea"],
    send: ['div[role="button"][aria-disabled="false"]'],
    message: ["[class*='ds-markdown']"],
    stop: [],
  }),
  site({
    surfaceType: "mistral",
    newChatUrl: "https://chat.mistral.ai/chat",
    label: "Le Chat",
    hosts: ["chat.mistral.ai"],
    composer: ['div[contenteditable="true"]', "textarea"],
    send: ['button[type="submit"]'],
    message: ["[class*='prose']"],
    stop: [],
  }),
  site({
    surfaceType: "zai",
    newChatUrl: "https://chat.z.ai/",
    label: "Z.ai",
    hosts: ["chat.z.ai"],
    /*
     * Z.ai runs an Open WebUI-style front end, so the generic selectors carry
     * most of the weight here — a contenteditable composer and a submit
     * button. Listed anyway, because being in the table is what makes the
     * picker able to open it.
     */
    composer: ["#chat-input", 'div[contenteditable="true"]'],
    send: ['button[type="submit"]', 'button[aria-label*="Send" i]'],
    message: ["[class*='prose']", "[class*='markdown']"],
    stop: ['button[aria-label*="Stop" i]'],
  }),
  site({
    surfaceType: "grok",
    newChatUrl: "https://grok.com/",
    label: "Grok",
    hosts: ["grok.com"],
    composer: ["textarea", 'div[contenteditable="true"]'],
    send: ['button[type="submit"]'],
    message: ["[class*='message-bubble']", "[class*='response']"],
    stop: [],
  }),
];

/**
 * The config for a URL, or a generic one for anywhere else.
 *
 * Returning a usable config for unknown hosts is deliberate: the mechanics do
 * not depend on recognising the site, and a page this add-on has been granted
 * access to is a page the user chose. Unknown sites get the generic selectors
 * and honest reporting about how well they worked.
 */
export function siteFor(url: string): ChatSiteConfig {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return genericSite("this page");
  }

  const known = CHAT_SITES.find((candidate) => candidate.hosts.includes(host));
  return known ?? genericSite(host);
}

export function isKnownSite(url: string): boolean {
  try {
    return CHAT_SITES.some((candidate) => candidate.hosts.includes(new URL(url).hostname));
  } catch {
    return false;
  }
}

function genericSite(label: string): ChatSiteConfig {
  return {
    surfaceType: "chat",
    label,
    hosts: [],
    // Nothing to open for a site we do not know; the user is already on it.
    newChatUrl: "",
    composer: GENERIC_COMPOSER,
    send: GENERIC_SEND,
    message: GENERIC_MESSAGE,
    stop: GENERIC_STOP,
  };
}

/** Match patterns for the manifest and for permission requests. */
export function matchPatternsForKnownSites(): string[] {
  return CHAT_SITES.flatMap((candidate) => candidate.hosts.map((host) => `https://${host}/*`));
}
