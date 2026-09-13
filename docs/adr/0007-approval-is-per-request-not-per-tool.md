# 7. Approval is per request, not per tool

**Status:** accepted (Phase 7)

## Context

[ADR-0004](0004-tool-permission-and-validation-gates.md) built the gate and
made `ask` fail closed, because a pending approval nobody can approve is a
denial. Phase 7 puts a human behind it.

The design question is not *whether* to ask. It is what a "yes" actually
covers, and the easy answer is wrong.

## Decision

**A remembered grant is keyed by tool *and* arguments.**

"Always allow `shell.run`" is a blank cheque: the user approved `npm test` and
would be granting `curl … | sh` in the same click. The grant key is
`shell.run::npm test`, so approving one command asks again for the next. The
key is built from the same summary string the dialog displayed, which means the
user cannot be granted something they were not shown.

**The dialog is modal.** A dismissible toast for "may I run a command" is a
notification people learn to swat away, and the one time it matters they swat
that one too.

**Dismissal is refusal.** Escape, clicking away, or a prompt that throws all
resolve to deny. There is no path where silence becomes consent.

**Grants are workspace-scoped**, stored in `workspaceState`. Approving
`npm test` in one project must not approve it in another, where the
`package.json` is someone else's.

**The request timeout is suspended while a prompt is open.** Otherwise
deliberating for longer than the timeout would time the request out and then
discard the very answer the user just approved — punishing the careful user and
training them to click fast.

**The tool's own timeout starts after the decision, not before.** A five-second
`read` timeout must not expire while a dialog waits on a human.

**One knob, not two.** Spec §17 describes permission modes and §78 describes
learning modes; on this product they express the same intent, so
`dumbways.permissions.mode` is the learning mode and the class policy is
derived from it. Two overlapping controls would let a user set a "strict" mode
that is not strict.

## Consequences

- No mode, anywhere, auto-allows `execute`, `write` or `destructive`. That is
  asserted by a test that iterates every mode rather than trusting the table to
  be read correctly.
- `shell.run` exists in Phase 7 but has no body: it validates, asks, and then
  reports `UNSUPPORTED` naming Phase 8. That makes the gate provable in the
  real product instead of only in tests, and makes the phase boundary visible
  rather than hidden.
- Reads never prompt. Asking about something harmless is how users learn to
  approve without reading, which spends the credibility the dangerous prompt
  depends on.
- `Forget Approvals` exists because "always" with no undo is not a decision the
  user can safely make.
