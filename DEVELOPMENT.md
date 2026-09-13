# DEVELOPMENT

## Requirements

- Node 20+ (tests use the built-in `node --test` runner)
- npm 10+ (workspaces)
- VS Code 1.85+

No global tooling. No Docker, no databases, no bundler yet.

## Layout

```text
dumbways-to-die/
├── packages/protocol/        shared types + envelope validation
├── packages/mock-provider/   in-process provider
├── packages/extension/       the VS Code extension
└── docs/adr/                 decision records
```

Workspaces are listed in build order in the root `package.json`
(`protocol` → `mock-provider` → `extension`), because `npm run --workspaces`
runs them in the order given and the later packages consume the earlier ones'
`dist/`.

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | Installs and links workspaces. |
| `npm run build` | Compiles every package with `tsc`. |
| `npm test` | Builds, then runs every package's tests. |
| `npm run dev:extension` | Builds deps, then watches the extension. |
| `npm run clean` | Removes all `dist/` output. |

`npm test` has a `pretest` hook that builds first — the tests run against
compiled JS in `dist/`, not against the TypeScript sources.

## Debugging the extension

1. Open the repository root in VS Code.
2. **F5** → *Run Dumb Ways to Die*. This runs `dumbways: build` first and opens
   an Extension Development Host.
3. Set breakpoints in `packages/extension/src/**` — source maps are emitted.
4. Reload the host (`Cmd+R` in that window) after a rebuild.

For a tight loop, use *Run Dumb Ways to Die (watch)*, which starts `tsc --watch`
and leaves it running.

### Debugging the webview

The panel is a webview. To inspect it: Command Palette →
*Developer: Open Webview Developer Tools* in the Extension Development Host.

The CSP forbids inline script, so any debugging code must live in
`packages/extension/media/webview.js`.

## Logs

Output channel: **Dumb Ways to Die**.

It records activation, provider connection, per-request context capture
(item count, active file, dirty flag), response correlation, and dropped
uncorrelated responses. `Show Current Context` renders the full Markdown
context payload there too.

Structured JSONL logging into `.coach/logs/` is a later phase.

## Testing approach

Tests run on compiled JS with `node --test`. The rule that makes this possible:
**modules that hold logic never import `vscode`.**

- `ContextEngine` takes an `EditorAdapter` interface.
- `CoachController` uses `vscode` for types only, so TypeScript elides the
  import entirely and it can be driven by fakes.
- `VsCodeEditorAdapter` and `CoachViewProvider` are the only files that truly
  need the extension host, and they are deliberately thin.

If a new module needs a runtime `vscode` import to do its job, that is a signal
the logic belongs one layer down.

## Adding a tool

1. Write the argument and result types in `packages/protocol/src/tools.ts`, and
   add the name to `TOOL_NAMES`.
2. Write a factory in `packages/extension/src/tools/definitions.ts` returning a
   `ToolDefinition`: name, description, permission class, timeout, `validate`,
   `execute`.
3. Register it in `registerDefaultTools`.
4. If it maps to a `ClientCapabilities` flag, add it to `CAPABILITY_BY_TOOL` in
   `ToolRegistry.ts` — otherwise the bridge will not advertise it.
5. Test it through the registry, not directly: that is the only path that
   exercises the permission, validation and timeout gates.

The validator is not optional and not a formality. Arguments arrive from
outside the bridge, and TypeScript types do not exist at runtime.

## Adding to the protocol

1. Change `packages/protocol/src`.
2. `npm run build` — every consumer type-checks against it.
3. Bump `PROTOCOL_VERSION` only for a breaking change, and make
   `parseEnvelope` reject the old version explicitly. Never guess a version.

## Phase discipline

The spec is a map, not a licence to build everything at once. Before starting
work: identify the current phase in `README.md`, implement the smallest next
milestone, prove its acceptance test, update `README.md`, `CHANGELOG.md` and
`TESTING.md`, then stop.
