# Dumb Ways to Die

A bridge between your editor and whatever AI chat you already use.

You ask a question in the sidebar. The extension gathers the context that
matters — the file you are in, what you selected, the errors showing, and
nothing else — and hands it to your chat. When the chat asks to read another
file, search the project, or run a command, the extension does it and sends
the answer back.

## What it does not do

It has no opinion about how you learn, and no model of its own. Whatever the
chat on the other end does is between you and that chat.

## Getting started

Open the **Dumb Ways to Die** view in the sidebar and press **Start**. That
one button starts everything the bridge needs. Nothing to configure.

Three ways to connect a chat, in order of how little work they ask of you:

- **Browser add-on** — the extension writes a Chrome add-on to disk and shows
  you where. Load it once; after that your chat is connected automatically.
  It ships selectors for ChatGPT, Claude, Gemini, Copilot, Perplexity,
  DeepSeek, Le Chat and Grok, and can be pointed at any other chat you grant
  it access to from the popup.
- **Clipboard** — the extension copies the request; you paste it into any
  chat, then paste the reply back.
- **Built-in test provider** — answers without a network, for checking that
  the loop works.

## What leaves your machine

Before anything is sent, you get a receipt: every item included, every item
withheld, and where it is going. The receipt is computed from the actual
request, so it cannot describe something other than what was sent.

Files that look like secrets (`.env`, `*.pem`, `~/.ssh/*`, and friends) are
refused, and nothing outside your open project folder is readable — including
via symlinks.

Commands run only after you approve them, without a shell, in their own
process group, with a scrubbed environment. `Escape` kills a running command.
