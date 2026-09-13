# 2. A shared protocol package is the source of truth

**Status:** accepted (Milestone A)

## Context

This system will eventually span four processes: an extension host, a local
relay, a browser adapter, and whatever chat surface sits behind it. Every one of
them will be tempted to define its own idea of "a request".

When that happens, a field added on one side goes unnoticed on the other, and
the bug surfaces two hops away from its cause.

## Decision

`packages/protocol` owns every payload shape. It has no dependencies — not
`vscode`, not a socket library, nothing. Other packages import types from it and
never redeclare them.

Consequences of that constraint, applied now rather than later:

- Every message carries an `Envelope` with `protocolVersion: 1`, even though
  Milestone A is in-process and serializes nothing.
- `parseEnvelope` rejects an unknown version with a named error instead of
  attempting a best-effort read.
- Responses are `ResponseContentPart[]`, not a string, even though the first
  provider could have returned a string.
- `ClientCapabilities` is transmitted per request and is honest: in Milestone A
  every tool capability is `false`.

## Consequences

- Some of the protocol is currently unused — permission classes, learning state,
  attachment refs. That is accepted: the shapes are cheap now and expensive to
  retrofit once three processes disagree about them.
- Anything that *is* used gets validated at runtime, because TypeScript types
  vanish at runtime and everything arriving on a future socket is untrusted.
- The build order (`protocol` → `mock-provider` → `extension`) is pinned in the
  root `package.json` workspace list.
