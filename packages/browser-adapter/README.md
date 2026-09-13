# Browser adapter

A Chromium extension that pairs **one** chat tab you choose and drives it.

It is an optimisation, not a foundation. Everything it does, `clipboard` mode
in the editor already does with two keypresses per turn — this removes those
two keypresses. When it breaks, it degrades into exactly that path.

## Install (unpacked)

```bash
npm run build          # from the repo root
```

1. Chrome/Edge → `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → select `packages/browser-adapter/dist`

## Connect

1. In the editor: **Connect a browser chat**. That starts the relay if needed
   and opens a pairing window.
2. Open your chat. It pairs itself when the page finishes loading.

Nothing is copied and nothing is pasted. The add-on finds the relay on
loopback and asks `/pair` for connection details while the window is open.

What it gets back is **not** the relay's own token. That one admits any adapter
role — editor included — so handing it to a browser would give a tab the
workspace's powers: publishing tool lists, opening pairing windows for others,
answering requests as the editor. `/pair` returns a credential derived for the
`browser` role and nothing else, and the window is consumed by the first claim,
so asking twice is not a way to collect credentials.

Three things guard the endpoint:

- **The window.** Only the editor can open one. It used to fall back to "open
  whenever no browser is attached", which sounded like a convenience and was a
  permanently open door — a service worker Chrome has killed is not attached,
  and that is the normal state of a working setup.
- **`Host`.** A site can publish a DNS record for its own name pointing at
  127.0.0.1, at which point its pages are same-origin with the relay and the
  missing CORS headers stop protecting anything. The name the client asked for
  is the one thing rebinding cannot change.
- **`Origin`.** A browser attaches one; a command-line harness does not. An
  `http(s)` origin means a page is asking, which is never legitimate here.

The credential survives a relay restart, because it is derived from the relay
token the editor keeps rather than minted at random. Change that token and
every credential issued under it stops working — which is the revocation that
matters.

## What it does and does not touch

Permissions are `storage` and `activeTab`, with host access limited to the chat
origins. Not `<all_urls>`, not `history`, not `cookies`, not `downloads`.

It types where you could type and reads what you can see, in the one tab you
paired. It does not read other tabs, touch authentication, retry to defeat rate
limits, or disguise itself (spec §0O). If it cannot do something, it says so
and hands the step back to you.

## When the site changes

Every capability degrades on its own:

| | works | broken |
| --- | --- | --- |
| **deliver** | fills the box and sends | tells you to paste it yourself |
| **observe** | reads the reply | tells you to copy it yourself |

Selectors live in `src/surfaces/sites.ts` and nowhere else. That file is
expected to rot, and it is a *prior* rather than a requirement: when a selector
misses, `discovery.ts` finds the controls by difference instead.

- **The composer** is found by shape — big enough, low on the page, with a send
  control in its own container — and then corroborated. Placing text and
  reading it back proves the box is *writable*, which a feedback textarea also
  is; what proves identity is the page reacting, with a send control appearing
  or becoming usable because there is now something to send.
- **The send control** is identified by the *difference* between the buttons
  present before and after typing. A menu that was already there did not
  change, so it is never clicked.
- **The reply** is the substantial block of text that was not there before and
  is not an echo of what was typed.

Open shadow roots are searched, so a composer inside a web component is
reachable. **Cross-origin iframes are not** — the content script runs in the
top frame, so a chat rendered inside an embedded frame will report that it
cannot find the message box rather than silently doing nothing.

## What is tested, and what is not

`npm test` covers two things.

**The pure logic:** completion detection, control and composer ranking, the
send-button veto list, credential parsing.

**The service worker, driven end to end** (`test/isolation.test.js`) against a
fake `chrome` and a fake socket — the real `background.ts`, not a copy. What it
pins is request isolation, which used to rest on three module globals holding
"the current request", "the chat it went to" and "the tool batch". That is safe
only while exactly one request exists at a time, which the panel guarantees and
`/v1/chat/completions` does not:

- a partial arriving after its request finished is not relabelled as the next
  one, and one from the wrong tab is dropped;
- a tool batch spans a relay reconnect and still returns to the chat that asked;
- ChatGPT's tool loop and a Claude request run at once without either landing in
  the other's composer;
- two requests for the same chat take turns rather than interleaving in one
  composer.

**Not covered:** every line that touches the DOM — finding the composer, typing
into it, clicking send, reading the reply. Those need a real browser on a real
page, and no amount of unit testing substitutes. `placeText` in particular calls
React's native value setter, which is the single most fragile line in this
project.

Of the nine sites in the table, only **ChatGPT** has actually been driven, and
that includes the no-priors path: composer found by shape, send found by
difference, with the table's selectors deliberately broken. The other eight are
untested against a live page.

Treat the first run as the actual test.
