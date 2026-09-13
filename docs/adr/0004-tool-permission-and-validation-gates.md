# 4. Every tool call passes four gates

**Status:** accepted (Phase 4)

## Context

The moment a tool exists, the external coach stops being a correspondent and
becomes a caller into this machine. It will ask for files. Eventually it will
ask to run commands.

The failure mode to design against is not a malicious model. It is a plausible
one: a coach that asks for `../../.ssh/id_rsa` because the conversation drifted,
or replays a stale tool call after a reconnect, or passes `startLine: "two"`
because it was guessing at the schema.

"The model asked for it" is not an authorisation (spec §75).

## Decision

Nothing reaches a tool's `execute` without passing, in this order:

1. **Registered?** Unknown names are refused with the list of real ones, so a
   confused provider can correct itself instead of retrying blindly.
2. **Permitted?** The tool's permission class is resolved against the session's
   table. `ask` fails closed until there is a UI to ask with — a pending
   approval that nobody can approve is a denial.
3. **Valid?** A handwritten validator per tool. TypeScript types are gone at
   runtime, and these arguments come from outside.
4. **Inside its timeout?** Every tool carries one, and the abort signal is
   passed to the tool rather than the promise merely being ignored.

Two more properties fall out of the same reasoning:

- **Idempotency by call id** (spec §84). A duplicate packet returns the cached
  result. This is free today because every tool is a read, and it must exist
  before the first tool that is not.
- **Errors are typed and lossy on purpose** (spec §48). Anything that is not a
  deliberate `ToolExecutionError` becomes `INTERNAL` with a generic message,
  because an unexpected stack trace can contain paths worth more than the bug
  report.

## Consequences

- Adding a tool means writing a validator and choosing a timeout. That friction
  is the feature.
- Capabilities are derived from the registry rather than declared by hand, so
  the request cannot advertise a tool that was never registered.
- A tool call is only honoured while one of *our* requests is in flight, for the
  current session, with a matching correlation id. An unsolicited call gets a
  typed refusal — which is also how the provider learns the rule.
- When Phase 7 adds the approval UI, only the permission resolver changes. The
  gate is already in the right place.
