# Dumb Ways to Die

Use the chat you already pay for as your coding agent.

Your agent runs out of tokens. Meanwhile ChatGPT, Claude or Gemini is sitting in
a browser tab, paid for, doing nothing. This connects the two: you ask from your
editor, that tab answers, and the answer comes back with your code attached.

No API keys. No second subscription. The tab you are already logged into is the
model.

## How it works

```
VS Code  →  local relay (127.0.0.1)  →  browser add-on  →  your chat tab
   ↑                                                              │
   └──────────────  reply, plus any tools it ran  ───────────────┘
```

The add-on types into the chat the way you would, reads the reply, and hands it
back. When the chat needs to see a file or run a command, it asks, and the
editor does it — behind a permission prompt.

Everything runs on your machine. Nothing goes to a server we own, because there
isn't one.

## Install

```bash
npm install
npm run build
```

1. In VS Code: **Dumb Ways to Die: Set Up Browser Extension**
2. Load the folder it opens at `chrome://extensions` → Load unpacked
3. Open your chat. It pairs itself.

## Use

- Ask in the panel. The paired chat answers.
- **Pick Chat Model** — choose which chat answers
- **Set Model Inside Chat** — choose which model that chat uses, read from its
  own menu
- **Where Coding Chats Live** — keep coding out of your personal history: a
  project, or a temporary chat

## Supported chats

ChatGPT · Claude · Gemini · Perplexity · DeepSeek · Z.ai · Le Chat · Grok ·
Copilot

Site knowledge is a starting guess, not a requirement. The message box, the send
button, the reply and the model menu are each found by watching what *changes*
when something happens — so a redesign does not break the bridge.

## Honest limits

- Driven against a live page: **ChatGPT** and **Perplexity**. The other seven
  work in principle and are untested.
- **Comet blocks it on perplexity.ai.** Perplexity's browser ships a policy
  stopping extensions from scripting Perplexity. Use Chrome, or the clipboard
  route.
- DOM code cannot be unit tested. Those paths are verified by running them, and
  the tests cover the logic around them (446 of them).

## Layout

```
packages/extension        the VS Code side
packages/relay            the loopback relay
packages/browser-adapter  the Chrome add-on
packages/mcp-server       lets other agents use the same bridge
packages/protocol         the shared wire format
```

## Development

```bash
npm run build
npm test
```

`DEVELOPMENT.md` for the workflow, `TESTING.md` for what is and is not covered,
`CHANGELOG.md` for what changed and why.

MIT.
