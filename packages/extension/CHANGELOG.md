# Changelog

## 0.1.0

First release.

- Ask questions in the sidebar with the file you are looking at as context,
  including unsaved changes.
- A receipt before anything is sent, computed from the actual request: every
  item included, every item withheld, and where it is going.
- Works with the chat you already pay for — ChatGPT, Claude, Gemini, Copilot,
  Perplexity, DeepSeek, Le Chat, Grok — through a browser add-on, or with any
  chat by pasting.
- Seven tools the chat can ask for: read a file, search, list a directory, the
  project tree, the active document, diagnostics, and running a command. Every
  command needs your approval.
- Secret files (`.env`, `*.pem`, `~/.ssh/*`) are refused, and nothing outside
  your open project folder is readable, including via symlinks.
- An MCP server, so Claude Code and Codex can use the same tools.
- An OpenAI-compatible endpoint, so an agent harness can use a chat tab as its
  model.
