import { parseCredentials, type WorkerStatus } from "./shared/messages";
import { isKnownSite, siteFor } from "./surfaces/sites";

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

function render(status: WorkerStatus): void {
  $("relay-state").textContent = status.relay;
  $("pair-state").textContent = status.pairing
    ? `${status.pairing.surfaceType} (${status.pairing.status})`
    : "not paired";
  // The note is about the thing the user just clicked, so it outranks the
  // standing relay detail whenever there is one.
  $("detail").textContent = status.note ?? status.relayDetail ?? "";
  $("setup").hidden = status.hasCredentials && status.relay === "connected";
}

async function tell(message: unknown): Promise<void> {
  // A sleeping service worker, or one that threw before responding, resolves
  // this as undefined. Rendering that reads properties off nothing.
  const status = (await chrome.runtime.sendMessage(message).catch(() => undefined)) as
    | WorkerStatus
    | undefined;

  if (!status) {
    $("detail").textContent = "The add-on is not responding. Reload it from chrome://extensions.";
    return;
  }

  render(status);
}

async function currentTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * Describes the page in front of the user, so the buttons are not a guess.
 *
 * A chat the add-on ships selectors for is named. Anything else is offered as
 * an opt-in rather than hidden, because the mechanics do not actually depend
 * on recognising the site.
 */
async function describeCurrentSite(): Promise<void> {
  const tab = await currentTab();
  const url = tab?.url ?? "";
  const allow = $("allow-site") as HTMLButtonElement;

  if (!url.startsWith("https://")) {
    $("site").textContent = "Open a chat in a tab to connect it.";
    allow.hidden = true;
    return;
  }

  const host = new URL(url).hostname;

  if (isKnownSite(url)) {
    $("site").textContent = `${siteFor(url).label} — supported out of the box.`;
    allow.hidden = true;
    return;
  }

  const granted = await chrome.permissions.contains({ origins: [`https://${host}/*`] });
  $("site").textContent = granted
    ? `${host} — allowed. Press "Pair this chat".`
    : `${host} is not a chat this add-on knows.`;
  allow.hidden = granted;
  allow.textContent = `Use ${host} anyway`;
}

$("save").addEventListener("click", () => {
  const credentials = parseCredentials(($("credentials") as HTMLTextAreaElement).value);
  if (!credentials) {
    $("detail").textContent = "That does not look like relay details.";
    return;
  }
  void tell({ type: "set-credentials", credentials });
});

/*
 * Chrome only grants optional permissions during a user gesture, and a service
 * worker has none — so the asking has to happen here, in the click handler,
 * and only the pairing is delegated. Moving this into the worker is the
 * obvious tidy-up and it would silently always be denied.
 */
$("allow-site").addEventListener("click", () => {
  void (async () => {
    const tab = await currentTab();
    if (!tab?.url?.startsWith("https://")) {
      return;
    }

    const origin = `https://${new URL(tab.url).hostname}/*`;
    const granted = await chrome.permissions.request({ origins: [origin] });

    if (!granted) {
      $("detail").textContent = "Not allowed, so nothing was read from this page.";
      return;
    }

    await describeCurrentSite();
    await tell({ type: "pair-current-tab" });
  })();
});

/*
 * The automatic path, with a button in front of it.
 *
 * Discovery already runs on its own every few seconds while unpaired, so this
 * changes nothing mechanically — but a window that appears to do nothing is
 * indistinguishable from a broken one, and pressing something is how people
 * check.
 */
$("find").addEventListener("click", () => {
  $("detail").textContent = "Looking for your editor…";
  void tell({ type: "discover" });
});

$("pair").addEventListener("click", () => void tell({ type: "pair-current-tab" }));
$("unpair").addEventListener("click", () => void tell({ type: "unpair" }));

void tell({ type: "get-status" });
void describeCurrentSite();
