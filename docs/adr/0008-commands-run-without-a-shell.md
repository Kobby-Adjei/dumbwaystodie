# 8. Commands run without a shell, with an allowlisted environment

**Status:** accepted (Phase 8)

## Context

`shell.run` executes whatever the user approved. Two design choices decide how
much damage a mistake here can do.

## Decision 1: no shell

The command is tokenized and spawned directly (`shell: false`). There is no
interpretation step between the approval dialog and the `execve`, so the string
shown in the dialog is exactly the process that runs.

The cost is real: no pipes, no redirection, no `&&`, no globbing, no variable
expansion. Those are **refused with an explanation** rather than silently
mangled — without a shell, `npm test | tee log` would otherwise run `npm` with
the arguments `test`, `|`, `tee`, `log` and fail confusingly.

**Only unquoted metacharacters are refused.** This distinction was found by a
test, and it is the difference between a usable tool and a useless one:
`node -e "setInterval(() => {}, 100)"` contains `>`, and
`node -e "a(); b()"` contains `;`. Those are data inside an argument. Refusing
them would reject most of the commands anyone actually runs, so the scanner
tracks quote state and only objects to metacharacters outside quotes.

## Decision 2: an allowlisted environment

A child gets a constructed environment, not this process's. Editors are
launched from shells carrying `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`,
`NPM_TOKEN` and whatever else the user exports, and a command approved for one
purpose has no business receiving all of them.

An **allowlist**, not a denylist: a denylist has to predict every secret's name
and only has to be wrong once. Names matching `TOKEN|SECRET|PASSWORD|KEY|
CREDENTIAL|SESSION|COOKIE|AUTH` are dropped even when explicitly allowlisted,
so a user widening the list cannot accidentally re-open the hole.

Measured on a real run: **52 variables in the parent including a `GITHUB_TOKEN`,
7 in the child, token absent.**

## Consequences

- Users who want a pipe must run the parts separately, or the project must
  later add an explicit, separately-approved shell mode. The limitation is
  documented rather than discovered.
- Builds that depend on an unusual environment variable will fail until it is
  added to `dumbways.shell.envAllowlist`. That is the correct failure: it is
  visible, fixable, and does not involve handing over every secret by default.
- The child runs in its own **process group**, so a timeout kills the whole
  tree instead of orphaning grandchildren — a `npm test` that spawns workers
  does not leave them behind.
- **stdin is closed.** An interactive prompt would otherwise hang until the
  timeout with nobody able to answer it.
- A non-zero exit code is **not** a tool failure. The tool call succeeded; the
  command failed, and its stderr and exit code are the answer. Conflating the
  two would hide the actual result behind a generic error.
- The tool's registry timeout (40s) is deliberately longer than the command's
  own (30s), so the runner gets to report `timedOut: true` with whatever output
  it captured rather than the registry killing the race and reporting a bare
  `TIMEOUT` with nothing in it.
