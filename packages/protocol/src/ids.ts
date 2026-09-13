/**
 * Correlation IDs (spec §26).
 *
 * Every request, response and (later) tool call must be traceable:
 *
 *   sessionId
 *     └── requestId
 *          ├── toolCallId
 *          └── responseId
 *
 * Prefixes are cosmetic but make logs readable at a glance.
 *
 * Uses the Web Crypto API on `globalThis` rather than `node:crypto`. The
 * protocol is the one package every side shares — editor, relay, provider and
 * browser extension — so a Node-only import here quietly made the shared
 * contract un-shareable. The browser build is what surfaced it.
 */
export function createId(prefix: string): string {
  return `${prefix}_${randomHex12()}`;
}

function randomHex12(): string {
  const webCrypto = globalThis.crypto;

  if (typeof webCrypto?.randomUUID === "function") {
    return webCrypto.randomUUID().replace(/-/g, "").slice(0, 12);
  }

  if (typeof webCrypto?.getRandomValues === "function") {
    const bytes = webCrypto.getRandomValues(new Uint8Array(6));
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  // No crypto at all is not an environment this project supports; failing
  // loudly beats silently minting guessable ids.
  throw new Error("No Web Crypto available: cannot generate correlation ids.");
}

export const createSessionId = (): string => createId("session");
export const createRequestId = (): string => createId("req");
export const createResponseId = (): string => createId("res");
export const createMessageId = (): string => createId("msg");
