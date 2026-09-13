# Changelog

## Unreleased — Four things an adversarial review found

An external review (Codex) was pointed at the bridge with instructions to break
it. Four findings, all real, all fixed here. Each was a case of something being
*claimed* rather than *established* — which is the failure mode this project is
least able to afford, because the whole idea rests on a chat being told the
truth about what it has and what it asked for.

### Fixed

**The ledger claimed the chat had bytes it was never sent.**

A file over the pull threshold is *described* — the first forty lines, and an
instruction to ask for the rest — but it was recorded as though the whole thing
had been delivered. So the next turn would say "unchanged since I sent it
earlier, use that copy", or hand over a diff to apply to text the chat had never
seen. The chat would then answer confidently about content it does not have.

Coverage is now tracked per file (`"full"` or `"preview"`), and only a full copy
can be referred back to or diffed against. An unchanged preview says so and
points at `workspace.read_file`; a changed one is described again.

**Request state in the browser worker was three module globals.**

The request in flight, the chat it went to, and the outstanding tool batch were
each one variable. That is safe while exactly one request exists at a time — the
panel guarantees it, `/v1/chat/completions` does not. With two callers, request
B overwrote A's state, A's streaming text arrived labelled as B's (which the
relay accepts as a legitimate partial), and A waited until it timed out.

Now one record per request: target tab, surface, observation id, batch. Progress
frames carry the request and observation they belong to and are checked against
the sending tab. Tool results are routed by looking up which operation owns the
call, and one for a call nobody is waiting for is dropped rather than typed into
whatever chat is current. Batches have a deadline and synthesise an error for a
missing result, because a chat that asked for three things and is shown two will
assume the third succeeded. Work is serialised per tab, so two requests for one
chat take turns instead of interleaving in the same composer.

Tool results also come back under the id the *chat* chose, not the worker's
internal wire id — three results under ids it has never seen are unmatchable.

**`/pair` handed out the relay's own token, and was almost always open.**

That token admits any adapter role, so a browser add-on asking for a connection
received the editor's powers too: publishing tool lists, opening pairing windows
for others, answering as the workspace. And the endpoint fell back to "open
whenever no browser is attached" — which, for a Manifest V3 worker Chrome kills
every thirty seconds, is the normal state of a working setup.

`/pair` now returns a credential derived for the `browser` role alone, a window
must be opened deliberately by the editor, and the first claim consumes it.
`Host` and `Origin` are validated on `/pair` and on `/v1/chat/completions`:
loopback is not a boundary against a browser, because a site can point its own
DNS name at 127.0.0.1 and become same-origin with the relay. The credential is
derived from the relay token the editor persists, so a relay restart does not
re-open the pairing dance.

**"Verifying" the composer proved it was writable, not that it was the composer.**

Placing text and reading it back is a test a feedback textarea passes. Each
candidate is now corroborated by the page's own reaction — a send control
appearing or becoming usable because there is now something to send — and a box
that accepts text without reacting is emptied before the next is tried. The
comment claiming wrong guesses were undone is now true: cleanup used to run only
when placement *failed*.

Ranking gained the strongest signal available without typing: whether the box
has a send control in its own container. Open shadow roots are searched, so a
composer inside a web component is reachable; cross-origin iframes still are not,
and the README says so rather than implying coverage.

### Also

- **A closed protocol block no longer ends the reply on its own.** A chat asked
  to read three files writes three blocks; taking the first closed fence as the
  ending dropped the other two, silently. A closed block now waits briefly for
  the text to settle, and a reply that ends mid-block is never complete.
- **`shouldAcceptCompletion` is actually used.** The observe loop implemented its
  own stricter rule, in which a visible stop control vetoed *everything*
  including the hard deadline — so a site whose stop selector matches something
  permanent held a request open forever.
- **Reply discovery is wired up.** `newestReply` existed, was tested, and was
  never called: when the reply selectors miss, the answer is now found the same
  way the send button is — the substantial block of text that was not there
  before and is not an echo of what was typed.
- The constants that were bare numbers (preview threshold, diff fraction,
  minimum reply length, minimum composer area) now state what sets them.


## 0.10.0 — The chat bridge, and telling you what leaves

Design: [docs/design/chat-surface-bridge.md](docs/design/chat-surface-bridge.md).

### Added

**A working bridge to any chat, with no browser extension.**

- **Block protocol** (`packages/protocol/src/chat.ts`). The coach wraps
  machine-readable parts in a fenced `dwtd` block, so extraction is "find the
  fence" rather than "parse rendered prose". One parser serves DOM reading,
  clipboard reading, and a human pasting by hand — the fallback path is the
  same code, not a second implementation that rots.
- **`ClipboardCoachProvider`** — set `dumbways.provider.mode` to `clipboard`
  and the full loop works with ChatGPT, Claude, a local model, anything you can
  paste into. Including tool calls: the coach asks, the tool runs behind the
  usual gates, and the result goes back on your clipboard labelled for a human.
- **`Copy Chat Primer`** — the once-per-conversation paste that teaches the
  protocol. Generated from the live registry, so it cannot advertise a tool
  that is not registered. Contains **no pedagogy**: how to coach is yours to
  write.

**Consent receipt — what leaves, in plain terms.**

- Computed **from the request that is actually being sent**, never from a
  hand-written description. A hardcoded "we send your open file" is a promise
  that drifts; this cannot, because it reads the same object the transport
  hands over.
- A collapsible receipt under every message you send, and
  `Show What Gets Sent` any time.
- A modal before the **first** send to each destination — once per destination
  per workspace, not every turn, because a prompt people see constantly is a
  prompt they stop reading.
- It states what is **withheld** as carefully as what is included: no other
  file, no environment variables, nothing outside the project folder, no
  credential-pattern files. Those are the parts a user cannot verify by
  looking, so they are the parts said out loud. Anything the context engine
  withheld for real (a filtered `.env`, a truncated buffer) appears there too.

### Notes

- The panel send path routes through a command so the consent gate cannot be
  bypassed by sending from the webview instead of the palette.
- The clipboard provider mints its **own** tool-call ids. Coaches reuse
  `call_1` every turn, and passing those through would collide with the tool
  registry's idempotency cache and return a stale result for a new request.
- One tool call per turn: a burst would leave the user pasting results in an
  order nobody defined.
- An unreadable block never swallows the answer — the prose is delivered with
  the problem disclosed.

### Tests

232 total (was 210): 18 for the block parser as an untrusted-input boundary,
10 for the receipt (checking it is *derived*, not worded), and the full
clipboard loop including a tool call and a refusal.

## 0.9.0 — Cancellation and diagnostics

### Added

- **Cancellation** (spec §46). `CANCELLED` existed in the lifecycle enum with
  nothing able to trigger it — a stuck request could only be waited out. Now:
  a Cancel button while busy, `Escape` in the panel, and a palette command.
  It does three things, and only the first is obvious:
  1. stops waiting, forwarding to the provider if it supports cancelling;
  2. **aborts the running tool** — a 30s command or a long search actually
     stops rather than finishing for an audience that has left;
  3. forgets the request id, so a late answer is dropped by the existing
     correlation check instead of arriving after you moved on.
- **`Show Diagnostics`** (spec §44, which says plainly: *"This will save hours
  of debugging"*). One report covering versions, all five hops, transport,
  request state, session, registered tools with their permission classes,
  advertised capabilities, permission policy and remembered grants, search
  backend and ripgrep path, media directory, and the command environment
  allowlist. It calls out the two conditions that fail quietly in real use:
  **no folder open** (workspace tools refuse) and **no ripgrep** (regex refused).
- Keybindings: `Cmd+Shift+D` opens the panel, `Escape` cancels while busy.

### Fixed

- The `Escape` keybinding was gated on a `dumbways.busy` context key that was
  never set, so it was declared and could never fire — worse than not having
  one. The context key now tracks the controller.

### Not built, by decision

**Learning-state UI** (spec §30, §53 Phase 10) and **coach.md / PLAN.md /
LEARNING_LOG.md handling** (Phase 11).

§0T says the relay is a router, not the teacher; that argument does not stop at
the relay. §2 calls the provider "the least important architectural layer" and
§100 lists what actually matters — what file, what selection, what is unsaved,
what errors — all context and tool questions, none of them pedagogy. A
Goal/Prediction/Observed form would be the bridge having an opinion about how
coaching works, and it is the first thing that breaks when the provider has its
own. If the coach is a chat surface, it already holds what you are learning.

`LearningState` and `CoachingMetadata` remain in the protocol as **optional
pass-through fields**: they cost nothing empty, and a provider or future client
that wants them will not need a protocol change. The bridge does not populate,
prompt for, or enforce them.

## 0.8.0 — Phase 9: attachments

Media travels as a reference, never inside the message.

### Added

- **`MediaRegistry`** — copies an attachment into `.coach/media/` at mode
  `0600`, hashes it, and **deduplicates by SHA-256** (spec §85): attaching the
  same screenshot twice reuses one object instead of filling the directory with
  copies. Registrations survive a restart, and an index entry whose file has
  been deleted is dropped rather than served.
- **Type and size gates** (spec §10): a fixed list of supported types, refused
  with the supported list in the message; oversized files refused rather than
  truncated. `dumbways.media.maxSizeMb` (default 20).
- **`GET /media/:id` on the relay** (spec §0M) — Bearer-token authenticated,
  resolving **only ids the editor registered**. There is deliberately no path
  in the URL: an endpoint that takes a path is a file server for the whole
  disk, which spec §9 forbids.
- **Panel attachments**: an *Attach* button, chips showing filename, size and
  hash, and per-chip removal. Attachments belong to the message they were
  staged for and clear once it is sent.
- Commands: `Attach File`, `Clean Local Cache` (spec §86, 30-day retention).

### Security

- Only the **editor** may register media. A provider announcing a path would be
  announcing a file it has no business knowing about — tested.
- An unauthenticated caller gets `401` whether or not the id exists, so the
  endpoint cannot be used to probe for ids.
- A registration whose file has since been deleted returns `410`, not a stack
  trace.

### Not implemented, deliberately

**Clipboard image capture** (spec §11.1). VS Code exposes no clipboard image
API, and spec §11.1 says plainly: *"Do not pretend image clipboard support
exists if it does not."* Use *Attach File* — screenshots on macOS land on the
Desktop by default.

### Fixed

- The media retention test compared against "now minus zero days", a
  sub-millisecond coin flip that passed alone and failed in a full run. It now
  backdates the record instead of racing the clock.

### Tests

204 total (was 186). Includes the Phase 9 acceptance path end to end: an
attachment registered by id, referenced in a request that crosses two process
boundaries, and its **exact bytes** fetched back from the relay with a hash
that matches what the request advertised.

## 0.7.0 — Phase 8: command execution

`shell.run` has a body. See
[ADR-0008](docs/adr/0008-commands-run-without-a-shell.md).

### Added

- **`CommandRunner`** — spawns the approved command directly, with no shell,
  so the string in the approval dialog is exactly the process that runs.
- **Allowlisted environment** (spec §38). Measured on a real run: 52 variables
  in the parent including a `GITHUB_TOKEN`, **7 in the child, token absent**.
  Names matching `TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL|SESSION|COOKIE|AUTH` are
  dropped even if explicitly allowlisted.
- **Bounded execution**: 30s default timeout, output capped at 40,000
  characters per stream with the truncation marked, the child in its own
  process group so a timeout kills the whole tree, and stdin closed so an
  interactive prompt cannot hang forever.
- Setting `dumbways.shell.envAllowlist`.

### Notes

- A non-zero exit code is **not** a tool failure. The tool call succeeded and
  the command failed; stderr and the exit code are the answer.
- Pipes, redirection and chaining are refused with an explanation rather than
  silently mangled into literal arguments.
- Output produced before a timeout is still returned.

### Fixed

- The shell-syntax check rejected metacharacters **inside quotes**, which would
  have refused most real commands — `node -e "setInterval(() => {}, 100)"`
  contains `>`, and `node -e "a(); b()"` contains `;`. The scanner now tracks
  quote state and objects only to unquoted syntax. Caught by tests.

### Tests

186 total (was 169), including real processes: exit codes, stderr capture,
timeout with a killed process tree, output truncation, missing executables,
abort, and a child that genuinely cannot see the parent's secrets.

## 0.6.0 — Phase 7: permissions

The gate that failed closed now has a human behind it. See
[ADR-0007](docs/adr/0007-approval-is-per-request-not-per-tool.md).

### Added

- **`PermissionManager`** — pure policy, no `vscode` import, because a bug
  here grants something the user never agreed to. Maps the learning mode to a
  per-class decision table (spec §78) and resolves `ask` by prompting.
- **Modal approval dialog** showing the tool and the exact request. Dismissal,
  Escape, and a prompt that throws all resolve to **deny** — there is no path
  where silence becomes consent.
- **Remembered approvals keyed by tool *and* arguments.** Approving
  `npm test` does not approve `curl ... | sh`. Stored in `workspaceState`, so
  a grant in one project is not a grant in another.
- **`shell.run`** (spec §37) registered as permission class `execute`: it
  validates, asks, and then reports `UNSUPPORTED` naming Phase 8. The gate is
  provable in the real product; the body arrives next phase.
- Settings: `dumbways.permissions.mode` (`strict-coach` default, `guided`,
  `normal-agent`). Command: `Forget Approvals`.

### Changed

- `ToolRegistry.resolvePermission` is async, and the tool's timeout now starts
  **after** the decision — a 5s tool timeout must not expire while a dialog
  waits on a human.
- `CoachController.pauseTimeout()/resumeTimeout()`: the request clock stops
  while a prompt is open, so deliberating longer than the timeout no longer
  times out the request and discards the answer just approved.

### Tests

165 total (was 148). Includes: reads never prompt; no mode auto-allows
`execute`/`write`/`destructive` (asserted across every mode); allow-once does
not remember; always-allow covers only that exact command; a throwing prompt
denies *and* still resumes the paused timeout; and the acceptance path —
provider requests a command, the user is asked about the real command string,
and refusing stops it.

## 0.5.0 — Phase 6: the local relay

The provider stops being an object inside the extension and becomes a process
on the other end of a socket. The `MockCoachProvider` class needed **no
changes** to make that move — only its transport did, which is the whole claim
the architecture has been making since Milestone A.

### Added

**`packages/relay`** — a local Node process bound to `127.0.0.1`, never
`0.0.0.0`:

- WebSocket hub at `/transport`, unauthenticated health at `/health`.
- **Authentication** (spec §23): a 256-bit token minted at startup and written
  to `$TMPDIR/dumbways-relay-<port>.json` at mode `0600`, so "can read that
  file" is the credential. Compared with `timingSafeEqual`. Never logged, never
  served by `/health`.
- **Handshake** (spec §0Q): `adapter.hello` → `adapter.welcome`, with protocol
  version checked and rejected rather than guessed. A socket that never
  authenticates is closed after 5s.
- **Routing** (spec §0U): requests go editor → provider, responses and tool
  calls come back, tool results go forward. The relay refuses a request from
  anything but the editor, and drops responses that correlate to nothing.
- **Loopback enforcement**: connections from non-loopback addresses are closed
  even though the listener is already bound to `127.0.0.1`.
- **Heartbeat and registry** (spec §0I, §0R): ping every 15s, terminate after
  45s of silence, and broadcast which adapters are attached on every change.
- `RelayConnection` — one client implementation shared by every process that
  speaks the protocol, with exponential backoff and a capped retry count
  (spec §24). Two implementations of a handshake drift; one cannot.

**`packages/mock-provider`** — a `standalone` entry that attaches to the relay
as a provider adapter and runs the same `MockCoachProvider` unchanged.

**Scripts** — `npm run dev:relay`, `npm run dev:provider`.

### Tests

148 total (was 122). The 21 relay tests use real sockets, and six of them spawn
a real relay process **and** a real provider process, then play the editor over
the wire — proving Phase 6's acceptance criterion ("provider runs as separate
process") rather than asserting it. Covered: token rejection, version
mismatch, handshake timeout, unauthenticated routing attempts, provider
impersonating the editor, uncorrelated responses, adapter replacement,
malformed frames, `0600` file permissions, and the full agent loop across two
process boundaries.

**Extension side**

- `RelayCoachProvider` — implements the same `CoachProvider` interface as the
  in-process mock, over the relay. The controller, context engine, tool
  registry and panel cannot tell which one they are talking to.
- `RelayLauncher` — health-checks before spawning so a duplicate relay can
  never be started for a port (spec §0F), and refuses to guess at credentials
  if something else is serving that port. The relay is spawned detached and
  deliberately outlives an editor reload, with `Stop Relay` as the explicit
  counterpart.
- The Relay hop in the panel stops saying "not built yet" and reports real
  states; the Provider hop follows the relay's registry, so it goes
  `disconnected` the moment the provider process exits.
- Settings: `dumbways.provider.mode` (`in-process` by default, `relay` to opt
  in) and `dumbways.relay.port`.

Transport is a setting rather than auto-detection. "Use the relay if a provider
happens to be attached" would make the same action behave differently on two
machines for reasons the user cannot see.

## 0.4.0 — Ripgrep backend and regex search

Revisits two Phase 5 decisions that were wrong together: refusing regex, and
skipping ripgrep. Doing the second properly makes the first unnecessary.
See [ADR-0006](docs/adr/0006-ripgrep-makes-regex-safe.md).

### Added

- **`RipgrepSearchBackend`** — spawns the ripgrep the editor already ships
  (`appRoot/node_modules/@vscode/ripgrep/bin/rg`, also present in VS Code
  forks such as Antigravity), parses its JSON output, and kills the process on
  abort. Selected at activation; the choice is logged.
- **Regex and whole-word search.** `workspace.search` accepts `isRegex` and
  `wholeWord`. Safe because ripgrep's engine is linear-time by construction and
  runs out-of-process — measured here, `(a+)+$` against 30 characters never
  returns in JavaScript, while ripgrep handles 8,000 characters in 0.038s.
- **`SearchBackend` abstraction** with two implementations, driven by the same
  ignore list and caps so both return identical results for a literal query.
- **Unsaved buffers go through the same engine**, piped to ripgrep on stdin, so
  a regex means the same thing whether or not a file happens to be open.
- **`engine` on every search result**, so the coach knows how its answer was
  produced.

### Changed

- `SearchResult.filesSearched` → **`filesWithMatches`**. Ripgrep never reports
  files it found nothing in, so "files examined" was a number only one backend
  could produce — and the two disagreed. Caught by the backend-equivalence test.
- The Node backend now refuses regex and whole-word with `UNSUPPORTED` rather
  than silently doing something different.

### Fixed

- Search-term extraction mistook the *modifier* for the term
  (`search for regex "x"` searched for `regex`), and mistook quotes *inside* a
  term for delimiters (`search for fetch('/api')` searched for `/api`). A quote
  now only delimits when it opens the term.

### Security

- `--no-config` so a machine-local `~/.ripgreprc` cannot change what the bridge
  searches; `--no-follow` so symlinks cannot lead out of the workspace.
- The query is passed as an argv entry with `shell: false` — never
  interpolated into a command line.
- Ripgrep output is re-checked against the secret filter, so a wrong glob
  cannot become a leak.

### Tests

122 total (was 109), including 11 that run against a real ripgrep binary: the
two backends are asserted to return identical results for the same literal
query, and the catastrophic pattern is asserted to return promptly.

## 0.3.0 — Phase 5: workspace search

The coach can now find things it was never shown.

### Added

**Tools**
- `workspace.search` — literal text search with optional globs, bounded by
  ignore rules, per-file match caps, a result cap and a 15 s timeout. Unsaved
  editor buffers are searched in memory and overlaid on the disk results, and
  every match reports whether it came from `filesystem` or `editor-buffer`.
- `workspace.project_tree` — breadth-first, bounded file tree, so a truncated
  tree loses the deep corners rather than everything after the first directory.

**Search internals**
- `globToRegExp` supporting `**`, `*`, `?` and `{a,b}` — no dependency. A
  pattern without a `/` also matches the basename, so `*.ts` means what a coach
  obviously intends by it.
- Literal-only matching. Provider-supplied regexes are not accepted: an
  untrusted pattern is a backtracking hazard.

**Configuration**
- `dumbways.workspace.ignoreDirectories` — ignore rules are now configurable
  and shared by search, tree and directory listing.

**Mock provider**
- Plans `workspace.search` from `search for X` / `grep for X` / quoted terms,
  and `workspace.project_tree` from structure questions.
- Reports matches with path, line, preview and an `[unsaved]` marker.

### Fixed

- The planner treated "find the bug" and "look at the file" as search requests,
  which would have sent the bridge hunting for the words "the" and "at". Bare
  search terms now require an unambiguous verb (`search`, `grep`); other verbs
  need a quoted term.
- Asking "what files are in this project?" planned both a project tree and a
  directory listing. The tree is a superset, so the listing is now skipped.

### Tests

109 total (was 79), including glob semantics, literal-not-regex matching, the
unsaved-buffer overlay, and an end-to-end `search for fetch(` driven through
the real controller against a real temporary workspace.

## 0.2.0 — Phase 4: tool calls

The first real agent loop. The coach can now ask the local bridge for context
it was not given, and the bridge decides whether to answer.

### Added

**Tool protocol**
- `tool.call` / `tool.result` message types, correlated to the request that
  triggered them.
- `ToolDescriptor` list and derived `ClientCapabilities` on every request, so a
  provider is told exactly what it may ask for.
- Namespaced tool names (`editor.*`, `workspace.*`) from the first tool.

**Tool registry**
- Self-describing tools with their own validator, permission class and timeout.
  Four gates per call: registered, permitted, valid arguments, inside timeout.
- Permission gate reading the session's permission table, failing closed —
  `ask` is a denial until the Phase 7 approval UI exists.
- Idempotency cache: a duplicate call id returns the cached result instead of
  running the tool twice.
- Unexpected exceptions become `INTERNAL` with a generic message, so internals
  never travel to the provider.

**Tools**
- `editor.active_document` — live buffer, unsaved changes included.
- `workspace.read_file` — line-aware, prefers the unsaved buffer over disk and
  says which it used.
- `workspace.list_directory` — ignore rules and secret filtering, with omitted
  counts.
- `editor.diagnostics` — for the active document or a named file.

**Workspace adapter**
- Filesystem reads confined to workspace roots. Boundary checked lexically and
  again after `realpath`, so both traversal and symlink escapes are refused.
- Binary files refused as `UNSUPPORTED_BINARY_FILE`; files over 5 MB refused as
  `TOO_LARGE` without being read.

**Controller and UI**
- Tool calls honoured only while one of our own requests is in flight, for the
  current session, with matching correlation. Otherwise: a typed refusal.
- Tool activity in the conversation, collapsed by default, showing arguments,
  result summary, duration and error code.
- Request timeout re-armed on tool activity, so a working tool is not mistaken
  for a stalled request.

**Mock provider**
- Now a keyword-driven tool agent (spec §52): plans calls from the message,
  refuses to plan any tool the request did not advertise, chains multiple calls
  in order, and quotes real numbers back.

### Fixed

- Workspace boundary enforcement was skipped for paths that did not exist,
  reporting `NOT_FOUND` instead of `OUTSIDE_WORKSPACE`. The lexical check now
  runs before the filesystem is touched. Caught by the Phase 4 security tests.

### Tests

79 total (was 38), including path traversal, symlink escape, binary and
oversize refusal against a real temporary workspace.

## 0.1.0 — Milestone A

The first agent bridge: a question typed in VS Code reaches a provider carrying
live editor state, and the correlated answer comes back to the panel.

### Added

**Repository (Phase 0)**
- npm workspaces monorepo: `protocol`, `mock-provider`, `extension`.
- Shared typed protocol with `protocolVersion: 1`, envelope validation that
  rejects unknown versions rather than guessing, and correlation IDs.

**Extension (Phases 1-3)**
- Activity Bar container and `Coach` sidebar webview.
- Per-hop connection state: editor, provider, relay, browser, chat surface.
  Unbuilt hops report "not built yet" instead of a colour.
- Live editor context: active file, language, dirty state, document version,
  selection range, cursor, and that file's diagnostics — updated as the user
  moves around, debounced.
- Context engine: conservative default context, character budgeting, marked
  truncation, whole-item drops with a stated reason, diagnostic caps.
- Filename-based secret filtering: content of `.env*`, `*.pem`, `*.key`,
  `id_rsa`, `.ssh/`, `.aws/`, `credentials`, `secrets` and friends is withheld,
  with the reason reported.
- Request lifecycle with progress narration, a 60s timeout, and rejection of
  uncorrelated or late responses.
- Deterministic Markdown serialization of a request (spec §0L), surfaced by
  `Show Current Context`.
- Commands: Open Coach, New Session, Send Message, Show Current Context.
- Settings: `dumbways.context.maxCharacters`, `dumbways.context.maxFileCharacters`.

**Mock provider**
- In-process provider that quotes the transported context back — active path,
  live buffer size, the line under the cursor, selection range, diagnostic
  count — and returns the selection as a structured `code` content part.

**Tests**
- 38 tests across the three packages, including a headless end-to-end run of
  the full controller loop.

### Deliberately not included

WebSocket transport, local relay, browser adapter, chat-surface pairing, media
and attachments, the tool protocol and tool registry, shell execution,
permission prompts, git and terminal context, write tools, persistence to
`.coach/`.

Each is a named later phase in the spec.
