# 6. Ripgrep is what makes accepting a regex safe

**Status:** accepted (supersedes the "no regex" decision in [ADR-0005](0005-search-is-literal-and-buffer-aware.md))

## Context

ADR-0005 refused regular expressions in `workspace.search` and skipped the
ripgrep backend that spec §15.5 asks for. Both decisions were defended on their
own terms. Together they were wrong, and the reason is worth recording.

**The correctness cost was underrated.** A literal-only search silently
under-finds. A coach asking for `fetch(` misses `fetch (`; asking for `fetch`
cannot say "as a whole word, not inside `prefetch`". It does not get an error —
it gets a confident empty result and reasons on top of it. Silent wrong answers
are worse than refusals.

**The safety concern was real but the mitigation was wrong.** Measured on this
machine, JavaScript's engine against `(a+)+$`:

| input | engine | result |
| --- | --- | --- |
| 30 characters | JavaScript | never returned; had to be killed |
| 8,000 characters | ripgrep | 0.038s |

Thirty characters. And because the block is synchronous, the tool's own 15s
timeout could never have fired — the timer cannot run while the regex owns the
thread. So "add a timeout" would have been a fix that did nothing.

Scope containment does not help here either: the workspace boundary controls
*which files* can be read, not whether the process survives reading them. Two
different risks that happened to sit next to each other.

## Decision

Use ripgrep, and accept regular expressions.

Ripgrep answers both problems with one mechanism:

- its engine is a finite automaton — linear time, no catastrophic backtracking,
  by construction rather than by validation;
- it runs in a child process, so a runaway search can actually be killed;
- it is faster than walking the tree in Node.

Supporting decisions:

- **Both backends are driven by our explicit ignore list**, with `--no-config`,
  `--no-ignore` and `--hidden`. Ripgrep's own defaults (respect `.gitignore`,
  skip dotfiles, read `~/.ripgreprc`) would make the same query return different
  answers depending on which backend ran and what config the machine had.
- **Unsaved buffers go through the same engine** via stdin. If disk matching
  used ripgrep and buffers used a JavaScript regex, a regex query would match
  different things depending on whether a file happened to be open — and the
  unsafe engine would be back in the process.
- **Results are filtered through the secret filter again**, after ripgrep has
  already been told to exclude those paths. A wrong glob must not become a leak.
- **The query is passed as an argv entry with `shell: false`**, never
  interpolated into a command line.
- **The Node fallback refuses regex** rather than pretending. It cannot run one
  safely, and it says which backend can.

## Consequences

- `SearchResult` carries `engine`, so the coach knows how its answer was
  produced and the two paths can be told apart in a bug report.
- Tests run against a real ripgrep binary — the one the editor ships — because
  parsing another program's output is exactly the code that passes review and
  fails in production. They skip, rather than fail, where no binary exists.
- One field had to change meaning. `filesSearched` could not be honoured by
  ripgrep, which never reports files it found nothing in, so the two backends
  disagreed. It is now `filesWithMatches`, which both can report exactly. A
  field two engines disagree about is worse than a field that says less.
