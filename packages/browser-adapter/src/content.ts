import {
  ConfiguredChatSurface,
  conversationRootFor,
  snapshotConversation,
} from "./surfaces/ConfiguredChatSurface";
import type { TextBlock } from "./surfaces/discovery";
import type { ContentToWorker, WorkerToContent } from "./shared/messages";

/**
 * Runs on the chat page. Its only job is to be the hands: type where the user
 * could type, read what the user can see, and report which of those it managed.
 *
 * It never reads other tabs, touches cookies, or looks at anything outside the
 * conversation the user paired (spec §0O).
 */

let observing: AbortController | undefined;

/*
 * `askTab` can inject this file when a tab was already open before the
 * extension was reloaded.  Chrome may therefore have both the document-idle
 * copy and the on-demand copy in the same isolated world.  Two listeners do
 * not make pairing more reliable: the first one to answer wins and an older
 * copy can answer with a stale protocol shape.  Keep one listener per page.
 */
const page = globalThis as typeof globalThis & {
  __dwtdContentListenerInstalled?: boolean;
};
if (page.__dwtdContentListenerInstalled) {
  // The bundled script is still evaluated, but must not register a second
  // runtime listener.  The rest of the module is intentionally inside this
  // branch so a reinjection cannot reset the page's active observation.
} else {
  page.__dwtdContentListenerInstalled = true;

/**
 * The page as it was just before the last message went out.
 *
 * Held here rather than on the surface because a fresh surface is built for
 * every message, and finding the reply by difference needs the *before* — which
 * only exists on the delivering side of that boundary.
 */
let beforeSend: { before: TextBlock[]; text: string; root?: Element } | undefined;

chrome.runtime.onMessage.addListener((raw, _sender, respond) => {
  // The content script shares a page with the site's own code, so a message
  // arriving here is not guaranteed to be one of ours.
  if (typeof raw !== "object" || raw === null || typeof (raw as { type?: unknown }).type !== "string") {
    respond({ type: "failed", reason: "Unknown request." } satisfies ContentToWorker);
    return true;
  }

  const message = raw as WorkerToContent;
  // Any page this script was allowed to run on is a page the user chose.
  // The site table supplies better selectors when it recognises the host and
  // generic ones when it does not; neither case is a refusal.
  const surface = ConfiguredChatSurface.forUrl(location.href);

  void (async () => {
    try {
      switch (message.type) {
        case "probe":
          respond({
            type: "probed",
            state: surface.probe(),
            surfaceType: surface.surfaceType,
            url: location.href,
          } satisfies ContentToWorker);
          return;

        case "deliver": {
          // Taken before anything is typed, so the diff has a baseline even
          // when the reply selectors turn out to match nothing on this page.
          beforeSend = { before: snapshotConversation(), text: message.text };
          const result = await surface.deliver(message.text);

          /*
           * Where the conversation is, learned from where our own turn landed.
           *
           * Found after delivering, because the anchor is the sent message
           * itself — and kept here rather than on the surface, which is rebuilt
           * for every message while the page, and this script, are not.
           */
          if (result.sent) {
            beforeSend.root = conversationRootFor(message.text);
          }
          respond({
            type: "delivered",
            rung: result.rung,
            sent: result.sent,
            ...(result.reason ? { reason: result.reason } : {}),
          } satisfies ContentToWorker);
          return;
        }

        case "observe": {
          observing?.abort();
          observing = new AbortController();
          /*
           * Progress goes straight to the worker rather than riding back on
           * this response, which cannot resolve twice. The worker turns each
           * one into a partial reply so the panel fills in as the chat writes.
           */
          const { requestId, observationId } = message;
          const reply = await surface.observe(
            observing.signal,
            (text) => {
              void chrome.runtime
                .sendMessage({ type: "reply-progress", text, requestId, observationId })
                .catch(() => {
                  // The worker may be asleep between polls; losing a progress
                  // frame is harmless because the next one carries the full text.
                });
            },
            beforeSend,
          );
          respond({ type: "observed", text: reply.text, rung: reply.rung } satisfies ContentToWorker);
          return;
        }

        case "list-models": {
          const found = await surface.listModels();
          respond({
            type: "models",
            models: found.models,
            ...(found.reason ? { reason: found.reason } : {}),
          } satisfies ContentToWorker);
          return;
        }

        case "set-model": {
          const outcome = await surface.setModel(message.model);
          respond({
            type: "model-set",
            ok: outcome.ok,
            ...(outcome.reason ? { reason: outcome.reason } : {}),
          } satisfies ContentToWorker);
          return;
        }

        case "abort":
          observing?.abort();
          respond({ type: "failed", reason: "Stopped." } satisfies ContentToWorker);
          return;

        default:
          respond({ type: "failed", reason: "Unknown request." } satisfies ContentToWorker);
      }
    } catch (error) {
      respond({
        type: "failed",
        reason: error instanceof Error ? error.message : String(error),
      } satisfies ContentToWorker);
    }
  })();

  return true;
});
}
