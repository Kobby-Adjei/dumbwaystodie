# 3. Prove the loop with an in-process mock before adding transport

**Status:** accepted (Milestone A)

## Context

The exciting part of this project is the connection to a real coaching surface.
It is also the part with the most unknowns: sockets, browser extensions, tab
pairing, page structure that can change without notice.

Chasing that first produces a system where a failure could be in the context
capture, the correlation logic, the socket, the browser adapter, or the page —
with no way to isolate which.

## Decision

Milestone A ships an in-process `MockCoachProvider` behind the same
`CoachProvider` interface a real provider will implement. It opens no socket and
binds no port.

Its response quotes the transported context back rather than paraphrasing it:
active path, live buffer size, the exact line under the cursor, the selection
range, the diagnostic count. A wrong answer is therefore a visible failure of
transport, not a matter of taste.

## Consequences

- The agent loop is provable headlessly: the controller-loop test drives the
  real engine and the real provider with no extension host.
- When the relay arrives, only the provider implementation changes. The editor
  adapter, context engine, controller and UI stay put — and if they do not, the
  layering was wrong.
- The UI must never assume the provider is intelligent. It renders structured
  content parts and connection state, nothing that presumes a model.
- The panel reports the relay, browser and chat-surface hops as "not built yet".
  Showing them as connected — or hiding them — would trade a small honesty for a
  large future debugging cost.
