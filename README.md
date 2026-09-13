# Dumb Ways to Die

A local-first VS Code learning/agent bridge.

The name is ridiculous. The architecture is not.

## What this is

The layer that can answer, from inside VS Code:

- What file is being looked at?
- What is selected?
- What has been changed but not saved?
- What errors does VS Code actually see?

…and hand that to an external model in a structured, versioned protocol.

The model/provider is the replaceable part. **The local context and tool layer is the product.**

## What this is not

- Not a chat sidebar with a textbox. That is the shell, not the system.
- Not a wrapper around a model API. No API key is needed and none is stored.
- Not a credential holder. It never asks for, stores, or transmits a ChatGPT
  password, cookie, session token, or OpenAI key.

## Current implementation phase

**Phases 0-9 and 12 complete.** A working bridge: live editor context, tools, a local relay, approvals, command execution, attachments, cancellation and diagnostics.

```text
VS Code
   ↓
Editor Adapter ─┐   live buffer, selection, cursor, diagnostics
Workspace Adapter┤  filesystem reads, inside the workspace only
   ↓            │
Context Engine  │   budget, truncation marking, secret filtering
   ↓            │
Coach Controller│   request lifecycle, correlation IDs
   ↓            │
Mock Provider   │
   ↓            │
   └── tool call ┘ → tool result → response → sidebar
```

The loop that matters:

```text
user message
    ↓
provider decides it needs more
    ↓
tool call        editor.active_document
    ↓
tool registry    permission → validation → timeout
    ↓
tool result      "842 characters, from the unsaved buffer"
    ↓
provider answers
```

Deliberately **not** built yet, because the spec says build one phase at a
time: the browser adapter and chat-surface pairing, write tools.

**Learning-state UI is deliberately not built.** §0T says the relay is a router,
not the teacher — and that does not stop at the relay. How coaching works is the
provider's business and the user's choice, not something this bridge should have
an opinion about. `LearningState` stays in the protocol as an optional
pass-through field so a provider that wants it needs no protocol change.

The panel reports those hops as *"not built yet"* rather than showing them
green. A bridge whose hops lie about themselves cannot be debugged.

## Architecture

```text
┌──────────────────────────────────────────────┐
│ VS Code extension host                       │
│                                              │
│  CoachViewProvider   (sidebar webview)       │
│         │                                    │
│  CoachController     (lifecycle, correlation)│
│         │                                    │
│  ContextEngine       (what gets sent)        │
│         │                                    │
│  VsCodeEditorAdapter (live editor state)     │
│         │                                    │
│  Provider            (in-process, or relay)  │
└──────────────────┬───────────────────────────┘
                   │  ws://127.0.0.1:43123/transport
                   ▼
        ┌──────────────────────┐
        │ Relay process        │  auth, routing, correlation,
        │ (packages/relay)     │  heartbeat, adapter registry
        └──────────┬───────────┘
                   ▼
        ┌──────────────────────┐
        │ Provider process     │
        └──────────────────────┘
```

Packages:

| Package | Role |
| --- | --- |
| `packages/protocol` | Shared typed protocol. Source of truth for every payload shape. Zero dependencies. |
| `packages/extension` | The VS Code extension: adapters, context engine, tool registry, controller, UI. |
| `packages/relay` | Local WebSocket relay: authentication, routing, correlation, connection state. Contains no coaching logic. |
| `packages/mock-provider` | Provider that proves the loop without any external system. Runs in-process or as its own process. |

### Editor state vs filesystem state

These are separated on purpose (spec §3). A process that reads files from disk
cannot know which file is focused, what is selected, or what has been typed and
not saved. Every piece of file content in the protocol carries a `source`
(`"editor-buffer"` or `"filesystem"`) so nothing downstream has to guess.

Automatic context only ever carries the **live editor buffer**, and
`workspace.read_file` returns the buffer instead of the file whenever the file
is open with unsaved changes — reporting `source: "editor-buffer"` when it
does. Disk content is never silently substituted for a dirty buffer.

## Talking to a real chat

Set `dumbways.provider.mode` to `clipboard`. It works with **any** chat you can
paste into — ChatGPT, Claude, a local model — with no browser extension and no
site-specific code.

1. `Copy Chat Primer` → paste into a fresh conversation. Once.
2. Ask your question in the panel. The context is copied for you.
3. Paste it into the chat, copy the reply, click **Bring reply back**.

If the coach wants to see more, it emits a `\`\`\`dwtd` block; the tool runs
behind the usual permission gates and the result is copied back for you to
paste. That is the full agent loop over nothing but copy and paste.

**You always know what left.** Every message you send carries a collapsible
receipt — the file, the character count, whether it was unsaved, the selection,
attachments — computed from the actual request, plus what was *not* sent.
`Show What Gets Sent` shows it any time.

## Security model

Local-only, and narrower than it will eventually need to be:

- **Loopback only, authenticated.** In `in-process` mode nothing binds at
  all. In `relay` mode the relay binds **127.0.0.1 only**, never `0.0.0.0`,
  and refuses non-loopback connections even so. A 256-bit token minted at
  startup is written to `$TMPDIR/dumbways-relay-<port>.json` at mode `0600`,
  so *being able to read that file* is the credential — a bound port is not a
  permission boundary, since any process on the machine can reach it. Sockets
  that do not authenticate within 5s are closed.
- **No credentials.** Nothing to enter, nothing stored.
- **Minimal automatic context.** Active file, selection, cursor, dirty state and
  that one file's diagnostics. No repository dumps, no sweep of open tabs, no
  environment variables. Anything more must be *pulled* by the coach through a
  tool call, which is refused unless one of our own requests is in flight.
- **Workspace boundary.** Every tool path is checked twice: lexically, so a
  traversal that points at a non-existent file is still reported as an escape,
  and again after `realpath`, so a symlink inside the workspace cannot point
  out of it. Absolute paths, `..` chains and null bytes are refused.
- **Binary and size limits.** Non-UTF-8 files are refused rather than returned
  as mojibake; files over 5 MB are refused rather than loaded into memory.
- **Commands run without a shell**, so the approved string is exactly the
  process that executes — no pipes, redirection or chaining, which are refused
  with an explanation rather than silently turned into literal arguments.
- **Commands get an allowlisted environment, not yours.** Measured: 52
  variables in the parent including a `GITHUB_TOKEN`, 7 in the child, token
  absent. Names that look like credentials are dropped even if allowlisted.
  Commands are bounded by a timeout, capped output, and a killed process group.
- **Regex runs in ripgrep, never in JavaScript.** An untrusted pattern in JS is
  a catastrophic-backtracking hazard that no timeout can interrupt — measured
  here, `(a+)+$` against **30 characters** never returned, while ripgrep
  handled 8,000 characters in 0.038s. Ripgrep's engine is linear-time by
  construction and runs where it can be killed. Where ripgrep is unavailable,
  regex is refused rather than run unsafely.
- **Secret filtering.** Files matching known credential patterns (`.env*`,
  `*.pem`, `*.key`, `id_rsa`, `.ssh/`, `.aws/`, `credentials`, `secrets`, …)
  have their **content withheld**; the coach is told the content was withheld
  and why, rather than being handed something that looks empty.
- **Marked truncation.** Nothing is silently shortened or dropped. Every trim
  reports original and included character counts.
- **Untrusted webview content.** Provider output reaches the DOM through
  `textContent` only, under a CSP that forbids inline script, remote script,
  and remote resources.

## Build

```bash
npm install
npm run build
npm test
```

Node 20+ required (uses the built-in `node --test` runner; no test framework
dependency).

## Run the relay topology

By default the provider runs inside the extension and needs no setup.

**One button.** Open the panel, click the status line to expand it, and press
**Start relay + provider**. It starts both processes, switches this window to
them, and waits for the far side to attach — no terminal, no settings change,
no reload. The button then becomes **Stop relay + provider**.

**One command**, if you would rather watch the routing:

```bash
npm run dev:stack      # starts relay + provider together, Ctrl-C stops both
```

Or the two halves separately:

```bash
npm run dev:relay
npm run dev:provider
```

```bash
curl -s http://127.0.0.1:43123/health
# {"ok":true,"adapters":{"editor":true,"provider":true},...}
```

The panel's Relay hop stops saying "not built yet" and reports real state, and
the Provider hop goes `disconnected` the instant you stop the provider process.

`Dumb Ways to Die: Stop Relay` shuts it down — the relay deliberately outlives
an editor reload so reloading reattaches instead of restarting.

## Launch the Extension Development Host

1. Open this repository in VS Code.
2. Press **F5** (or Run → *Run Dumb Ways to Die*).
3. A second VS Code window opens with the extension loaded.
4. Click the skull icon in the Activity Bar.

`npm run dev:extension` runs the compiler in watch mode if you prefer to reload
the host manually.

## Try the mock provider

In the Extension Development Host:

1. Open any file and type something **without saving**.
2. Select a few lines.
3. Type `what am I looking at?` in the panel and click **Send**.

The reply quotes back the active path, the live buffer size, the exact line your
cursor is on, the selection range, and the diagnostic count — all read from the
unsaved buffer.

Then trigger the agent loop:

```text
show me the file          → editor.active_document
why do I have errors?     → editor.diagnostics
read public/app.js        → workspace.read_file
list the directory        → workspace.list_directory
search for fetch(         → workspace.search (literal)
search for regex "fetch\(.*\)"  → workspace.search (regex)
grep for whole word "fetch"     → workspace.search (word boundaries)
show me the project structure   → workspace.project_tree
show the file and check the diagnostics   → two calls, in order
```

A collapsed `▸ editor.active_document ✓` row appears in the conversation; expand
it for arguments, result summary and duration. Full script in
[TESTING.md](TESTING.md).

## Tools

The model cannot read anything it was not given unless it asks. Six tools
exist, all permission class `read`:

| Tool | What it returns |
| --- | --- |
| `editor.active_document` | The live buffer of the focused file, unsaved changes included. |
| `editor.diagnostics` | What VS Code itself reports for a file. |
| `workspace.read_file` | A file inside the workspace, optionally a line range. Prefers the unsaved buffer when the file is open and dirty. |
| `workspace.list_directory` | Directory entries, minus ignored folders and filtered secrets. |
| `workspace.search` | Text or regex search with optional globs and whole-word matching. Searches unsaved buffers too, and says which source each hit came from. |
| `workspace.project_tree` | Bounded, breadth-first file tree. |
| `shell.run` | Runs an approved command. Permission class `execute` — always asks. |

Names are namespaced by adapter (`editor.*` needs the editor, `workspace.*`
needs the filesystem) so the boundary stays visible on the wire.

Every tool call passes four gates before anything happens:

```text
registered?  →  permission allows it?  →  arguments validate?  →  finished in time?
```

Failures are typed (`OUTSIDE_WORKSPACE`, `PERMISSION_DENIED`, `TOO_LARGE`,
`TIMEOUT`, `UNSUPPORTED`, …), and an unexpected exception becomes a generic
`INTERNAL` so a stack trace never travels to the provider.

## Tool permission model

| Class | strict-coach (default) | guided | normal-agent |
| --- | --- | --- | --- |
| `read` | allow | allow | allow |
| `execute` | **ask** | **ask** | **ask** |
| `write` | deny | **ask** | **ask** |
| `destructive` | deny | deny | **ask** |

No mode auto-allows `execute`, `write` or `destructive` — a test iterates
every mode to keep it that way.

When a tool needs approval you get a modal naming the tool and the **exact
request**, with *Allow once*, *Always allow this request*, and *Deny*.
Dismissing it is a refusal, never a silent yes.

"Always allow" is keyed to the tool **and its arguments**: approving
`npm test` does not approve a different command. Grants are stored per
workspace and cleared with `Dumb Ways to Die: Forget Approvals`.

Capabilities are derived from the registry, never hand-maintained, so the
bridge cannot advertise a tool it does not have. Every request carries the tool
list with descriptions and permission classes, and the mock provider refuses to
plan a call the request did not advertise.

## Where data is stored

Sessions live in memory and die with the window.

**Attachments** are copied into `.coach/media/` at mode `0600`, with an
`index.json` recording id, filename, MIME type, size and SHA-256. Identical
bytes are stored once. `Clean Local Cache` removes anything older than 30 days.
`.coach/` is already in `.gitignore`.

`.coach/` (sessions, media, logs, cache) is reserved and pre-ignored in
`.gitignore`, but nothing writes to it yet. Writing files into the user's
repository before there is something worth persisting would be scope creep.

Diagnostics and the context preview go to the **Dumb Ways to Die** output
channel.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `dumbways.context.maxCharacters` | 120000 | Approximate ceiling for one request's context. |
| `dumbways.context.maxFileCharacters` | 40000 | Ceiling for a single file or buffer. |
| `dumbways.permissions.mode` | `strict-coach` | How much the model may do without asking. Read tools are always allowed. |
| `dumbways.shell.envAllowlist` | PATH, HOME, … | Environment variables an approved command may see. Everything else is dropped. |
| `dumbways.media.maxSizeMb` | 20 | Largest attachment accepted. |
| `dumbways.provider.mode` | `in-process` | `clipboard` talks to any chat you can paste into; `relay` talks to a separate process. |
| `dumbways.relay.port` | 43123 | Port for the local relay, bound to 127.0.0.1 only. |
| `dumbways.workspace.ignoreDirectories` | `node_modules`, `.git`, `dist`, `build`, `out`, `target`, `.next`, `.turbo`, `coverage`, `.venv`, `__pycache__` | Directory names skipped by search, tree and listing, at any depth. |

## Commands

- `Dumb Ways to Die: Open Coach`
- `Dumb Ways to Die: New Session`
- `Dumb Ways to Die: Send Message`
- `Dumb Ways to Die: Show Current Context`
- `Dumb Ways to Die: Stop Relay`
- `Dumb Ways to Die: Forget Approvals`
- `Dumb Ways to Die: Attach File`
- `Dumb Ways to Die: Clean Local Cache`
- `Dumb Ways to Die: Cancel Current Request` (`Escape` while busy)
- `Dumb Ways to Die: Show Diagnostics`
- `Dumb Ways to Die: Copy Chat Primer`
- `Dumb Ways to Die: Bring Reply Back`
- `Dumb Ways to Die: Show What Gets Sent`

## Known limitations

1. **The extension is not packageable yet.** It runs from the workspace, where
   `@dumbways/protocol` and `@dumbways/mock-provider` resolve through npm
   workspace symlinks. `vsce package` would need a bundler (esbuild) first.
2. **Secret filtering is filename-based only.** It cannot catch a key pasted
   into `index.html`. Content redaction is a later phase.
3. **Only `file:` and `untitled:` documents are captured.** Git diff views,
   output channels and other virtual documents are skipped — the panel falls
   back to the last real editor rather than reporting the virtual one.
4. **Buffer truncation keeps the head of the file**, so line numbers stay valid
   for everything included. A window around the cursor would be more relevant
   but would silently shift line numbers.
5. **Regex needs ripgrep.** The editor ships it, so this is the normal case —
   but if the binary cannot be found, search falls back to a Node traversal
   that handles literal queries only and refuses regex and whole-word with a
   typed `UNSUPPORTED` error. The active backend is logged at startup and
   reported on every result as `engine`.
6. **`.gitignore` is not read**, on purpose. Ripgrep would honour it by default;
   it is disabled with `--no-ignore` so both backends return identical results
   for the same query. Only the configured directory names are skipped.
7. **Search ignores untitled buffers.** They have no path inside a workspace
   root, so they are excluded rather than given a fake location.
8. **`workspace.read_file` matches open buffers by resolved absolute path**,
   case-insensitively off Linux. An exotic mount could defeat that matching and
   fall back to disk content — it would report `source: "filesystem"`, so the
   answer stays honest.
9. **No persistence, no attachments, no terminal, no git context, no command
   execution, no write tools.** Each is a named later phase.
10. **The mock provider cannot reason.** It matches keywords, calls tools, and
    quotes the results back. That is the entire point: it proves the loop, not
    intelligence.

## Documents

- [DEVELOPMENT.md](DEVELOPMENT.md) — setup, scripts, debugging
- [TESTING.md](TESTING.md) — manual test script per phase
- [CHANGELOG.md](CHANGELOG.md)
- [docs/adr/](docs/adr/) — architectural decision records
