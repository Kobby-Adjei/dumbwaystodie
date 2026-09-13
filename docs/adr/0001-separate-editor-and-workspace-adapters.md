# 1. Separate editor state from filesystem state

**Status:** accepted (Milestone A)

## Context

A terminal process can read every file in the project and still be unable to
answer the only questions that matter for coaching: which file is focused, what
is selected, where the cursor is, and what has been typed but not saved.

The tempting shortcut is one "file reader" that returns disk content and treats
the editor as an optimisation. That shortcut produces a coach that confidently
explains a version of the file the user is not looking at.

## Decision

Two independent context sources, never merged:

- **Editor adapter** — VS Code APIs. Live buffer, selection, cursor,
  diagnostics, dirty state.
- **Workspace adapter** — Node/filesystem. Listing, reading, searching, git,
  commands. *Not built in Milestone A.*

Every piece of file content in the protocol carries a `source` field
(`"editor-buffer"` or `"filesystem"`). Disk content is never substituted for a
dirty buffer.

## Consequences

- `FileContextItem` and `DocumentSnapshot` are slightly heavier than a plain
  string, forever.
- A coach can tell whether it is reasoning about saved or unsaved code, and the
  panel can warn the user which one is travelling.
- When the workspace adapter arrives, it slots in beside the editor adapter
  rather than replacing it, and the tool namespace already anticipates the
  split (`editor.*` vs `workspace.*`).
