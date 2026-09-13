# Chat-surface bridge — system design

**Status:** design agreed, keystone implemented (`packages/protocol/src/chat.ts`)

How editor context reaches a chat conversation the user already has open, and
how the answer comes back — without lying to the user about what is happening.

## The principle this replaces

The earlier position was "the spec forbids it." That was too blunt. What
spec §0O actually forbids is: bypassing authentication, defeating rate limits,
anti-detection, reading unrelated tabs, harvesting cookies. Reading a page the
user explicitly paired, in a tab they are looking at, signed in as themselves,
is none of those. §50's "no scraping into the **core project**" is an
architecture instruction — quarantine site-specific logic — not a ban.

The replacement principle is **transparency over prohibition**: the user is
told, continuously and in plain terms, what leaves their machine, what is being
read, and which mechanism is doing it. A capability they understand beats a
capability they are denied.

## The inversion

The usual browser bridge makes the *transport* smart — CSS selectors, mutation
observers guessing when streaming stopped — and the payload dumb. Every one of
those breaks on a redesign, and breaks silently.

**Invert it: make the payload self-identifying so the transport can be stupid.**

The coach wraps machine-readable parts in a fenced block:

````
```dwtd
{"v":1,"type":"tool.call","id":"call_1","tool":"workspace.read_file","args":{"path":"src/app.js"}}
```
````

Extraction becomes "find the fenced block" instead of "parse rendered prose
into meaning". What that buys:

| | with sentinel blocks | without |
| --- | --- | --- |
| Selector needed | "text of the last message" | structure-dependent, per-site |
| Completion detection | the closing fence | guess when mutations settle |
| Clipboard fallback | same parser | a second implementation that rots |
| Human paste fallback | same parser | not possible |
| Wrong read | fails to parse, reported | plausible-looking garbage |

One parser serves DOM reading, clipboard reading, and a human pasting by hand.
The fallback path is not a promise — it is the same code.

## Three capabilities, degrading separately

Not one adapter that works or doesn't. Three capabilities, each with its own
ladder, each reported to the user:

| capability | auto | assisted | manual |
| --- | --- | --- | --- |
| **identify** | match the paired tab | user confirms the tab | user says which |
| **deliver** | fill composer, send | payload on clipboard, user pastes | user copies from panel |
| **observe** | read last message | user clicks *Capture* | user pastes the reply |

When `deliver:auto` breaks, it drops to `assisted` **and the panel says so**.
It never silently retries harder. That is §0O's "fail clearly" and the
transparency principle satisfied by one mechanism.

## Decisions taken

1. **Adaptive automation.** Try auto; degrade to assisted on failure, visibly.
2. **Surface-agnostic first.** The clipboard transport and block protocol work
   with any chat — ChatGPT, Claude, a local model, anything you can paste into.
   Site-specific adapters are an optimisation layered on top, not the
   foundation. This means the fallback is real code from day one.
3. **Primer-based.** The user pastes a short primer once per conversation.
   Generated from the live tool registry, so it can never advertise a tool that
   is not registered — the same rule `ClientCapabilities` follows.

### The primer contains no pedagogy

It describes the protocol and nothing else: no "teach one concept at a time",
no tone, no withholding rules. How coaching works is the user's decision and
the provider's job — §0T's "router, not the teacher", applied past the relay.
A user wanting a particular style writes it themselves, in their own words, in
the same conversation. A test asserts the primer stays free of coaching
language.

## What the user could lose

Three risks, ranked honestly:

1. **Account risk.** Automating a consumer web UI may violate its terms. Nobody
   can promise otherwise, which is exactly why the automation level is the
   user's choice and why assisted mode is a first-class path rather than a
   consolation prize.
2. **Prompt injection reaching the filesystem.** Once the coach is a web page,
   its output drives tool calls on a real machine. **The defence already
   exists**: §75's untrusted-provider stance, `execute` always prompting,
   filename-based secret filtering, workspace boundary checks, no-shell
   execution, allowlisted command environments. That earlier work is precisely
   what makes accepting a *less trustworthy* provider safe at all. The chat
   parser adds its own limits: JSON only, never eval, capped block size and
   count, unknown types ignored.
3. **Over-collection.** A content script on a chat origin can see every
   conversation there. Scope to the paired tab; never read others.

## On screenshots

Two different ideas often confused:

- **Screenshotting the chat reply** to read it — strictly worse than reading
  the DOM or clipboard: lossy, slow, destroys code fidelity. Rejected.
- **Screenshotting the user's running app** as context — genuinely valuable and
  genuinely automatable, but that is §66's browser dev adapter (CDP: console,
  network, DOM, screenshot), a separate mechanism against a page the user
  controls. That is where "the user does nothing" actually pays off.

## Build order

1. **Block protocol + primer** — pure, surface-independent. *Done:
   `packages/protocol/src/chat.ts`, 18 tests.*
2. **Clipboard surface adapter** — a `CoachProvider` that renders the request
   to Markdown (§0L), puts it on the clipboard, and accepts a pasted reply.
   Works with every chat surface, no browser extension, no site-specific code.
3. **Consent receipt** — before the first send and on demand: exactly what
   leaves, in plain terms. File, character count, selection, attachments.
4. **Browser extension** — pairing (§0J), then `deliver:auto` and
   `observe:auto` for one surface, degrading into step 2's path.
   *Built: `packages/browser-adapter`. The pure logic is tested; every line
   that touches the DOM is unverified until it is run against a real page.*

Step 2 is a complete, useful product on its own. That is the test of whether
the sequencing is right.
