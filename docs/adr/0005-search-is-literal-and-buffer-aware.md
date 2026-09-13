# 5. Search is literal, buffer-aware, and not ripgrep yet

**Status:** accepted (Phase 5)

## Context

Search is the first tool where the coach supplies something more expressive
than a path, and the first that walks the whole workspace rather than one file.

Three decisions had to be made, and each had an obvious-looking answer that was
wrong for this project.

## Decision 1: the query is a literal string, not a regex

A regex would be more powerful and is what a coach might expect. It is also
untrusted input compiled into a backtracking engine — one `(a+)+$` against a
minified bundle and the extension host is gone.

Literal matching removes the entire class. The cost to the coach is small: it
can search for `fetch(` and then read the surrounding lines with
`workspace.read_file`, which is the retrieval pattern the architecture already
encourages (spec §61).

## Decision 2: search overlays unsaved buffers

A terminal `grep` sees the disk. This bridge exists precisely because the disk
is not what the user is looking at (spec §3).

So the tool searches disk *excluding* files with unsaved changes, searches
those buffers in memory, and merges the two — with `source` on every match, and
unsaved hits sorted first. Excluding rather than filtering afterwards keeps the
totals exact instead of approximate.

Consequence: a coach searching for something the user typed thirty seconds ago
and never saved will find it. That is the single clearest demonstration of what
this bridge is for.

## Decision 3: no ripgrep backend yet

Spec §15.5 prefers ripgrep when available. There was no `rg` binary on the
development machine to verify against — the `rg` on `PATH` was a shell function
proxying elsewhere, and Node's `spawn("rg")` returned ENOENT.

Writing spawn-and-JSON-parse code that has never once been run would have been
guesswork dressed as an optimisation, and the fallback would have hidden the
failure. So: Node traversal only, bounded by ignore rules, globs, a per-file
size limit, per-file match caps, a result cap and a timeout.

`WorkspaceAdapter.searchFiles` is the seam. A ripgrep backend implements that
one method and nothing else changes.

## Consequences

- Search is fine on a normal workspace and is not a fast path for a large
  monorepo. The README says so rather than implying otherwise.
- Ignore rules became configuration in this phase because three tools now share
  them, and a hardcoded list that three callers depend on is a setting waiting
  to be discovered the hard way.
- `.gitignore` is still not read. That is a known gap, stated rather than
  quietly approximated by the ignore list.
