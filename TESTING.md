# TESTING

Automated tests prove the layers. The manual script proves the product.

Every phase adds a manual test here.

## Automated

```bash
npm test
```

Runs, per package:

- **protocol** — envelope creation, protocol-version rejection, malformed
  envelopes, ID uniqueness.
- **mock-provider** — the Milestone A acceptance assertions, structured content
  parts, correlation, refusing to answer before `connect()`, tool planning
  (including refusing to plan unadvertised tools).
- **extension** — context engine (live buffer, truncation marking, budget
  drops, diagnostic caps, secret withholding), secret filter, Markdown
  serialization, view model, tool registry (permission, validation, timeout,
  idempotency), workspace security against a real temp workspace, and the full
  controller loop end to end with the real engine and real mock provider.

The controller loop tests are the headless version of the Milestone A and
Phase 4 acceptance tests. They pass without an extension host because the VS
Code seams are interfaces.

## Manual — Milestone A

Setup: press **F5**, then in the Extension Development Host open any project and
click the skull icon in the Activity Bar.

### 1. Connection state is honest

1. Look at the Connection block.
2. Confirm: `Editor` connected, `Provider` ready.
3. Confirm: `Relay`, `Browser`, `Chat surface` all read **not built yet** with a
   hollow dot.

Fails if any unbuilt hop shows a colour, or if all five collapse into one
"Connected".

### 2. Unsaved buffer

1. Open `index.html` (or any file).
2. Type `UNSAVED_TEST`.
3. **Do not save.**
4. Run `Dumb Ways to Die: Show Current Context`.
5. In the output channel, confirm the `## Active buffer` section contains
   `UNSAVED_TEST` and says `Dirty: true`.

Fails if the preview shows the version on disk.

### 3. Selection

1. Select lines 5-10.
2. Confirm the panel's context block reads `selection L5–L10` with a character
   count.
3. Run `Show Current Context` and confirm the `## Selection` block quotes those
   exact lines.

### 4. Diagnostics

1. Introduce a real error (in a TS/JS file, reference an undefined symbol).
2. Wait for the squiggle.
3. Confirm the context block's diagnostic count increases.

### 5. The loop (acceptance test — spec §99)

With an unsaved edit, a selection, and at least one diagnostic in place:

1. Type `what am I misunderstanding here?` in the panel.
2. Click **Send to Coach**.
3. Watch the progress text move through *Capturing editor context… → Sending to
   provider… → Waiting for coach… → Done.*
4. Confirm the coach reply states:
   - the active path;
   - `Unsaved changes: yes`;
   - a live buffer character count, described as read from the buffer not disk;
   - the exact text of the line the cursor is on;
   - the selection range;
   - the diagnostic count.
5. Confirm the selection also appears as a separate code block.

Fails if any value reflects the file on disk instead of the editor.

### 6. Live context tracking

1. Switch to a different file.
2. Confirm the context block updates without pressing anything.
3. Click into the panel's textarea and type.
4. Confirm the context block still shows the *file*, not "no active editor".

### 7. Secret filtering

1. Create a file called `.env.local` with `SECRET=hunter2`.
2. Focus it.
3. Confirm the context block reads **content withheld: environment files can
   hold credentials**.
4. Send a message and confirm the reply contains a withheld note and **not**
   `hunter2`.

### 8. No active editor

1. Close all editors.
2. Confirm the panel reads "No active text editor".
3. Send a message; confirm the reply says `Active editor: none` rather than
   inventing one.

### 9. Busy handling

1. Send a message.
2. Immediately try to send another.
3. Confirm the button is disabled and/or a system line explains the coach is
   still working. Confirm the second message is not silently queued.

### 10. Session reset

1. Click **New** next to the session name.
2. Confirm the conversation clears.

## Manual — Phase 4 (tool calls)

### 11. The agent loop (acceptance test — spec §53)

1. Open a file, type something without saving.
2. Send `show me the active file`.
3. Confirm a collapsed row appears: `▸ ✓ editor.active_document`.
4. Expand it. Confirm it reports a result summary and a duration in ms.
5. Confirm the coach's reply says `I read N characters from <path>` and
   describes it as the **live buffer with unsaved changes**.

Fails if the character count matches the saved file rather than the buffer.

### 12. Several tools in one turn

1. Send `show the file and check the diagnostics`.
2. Confirm **two** tool rows appear, in order: `editor.active_document`, then
   `editor.diagnostics`.
3. Confirm the final reply summarises both.

### 13. Reading another file by name

1. Send `read <some/other/file.js>` naming a real file in the workspace.
2. Confirm a `workspace.read_file` row appears and the reply reports the line
   count and that it came **from disk**.
3. Now open that file, type without saving, and repeat.
4. Confirm the reply now says it came **from the unsaved editor buffer**.

### 14. The boundary holds

1. Send `read ../../../etc/passwd`.
2. Confirm the tool row shows an error, and the reply says
   `refused: OUTSIDE_WORKSPACE`.
3. Send `read .env` (with a `.env` in the workspace).
4. Confirm `refused: PERMISSION_DENIED`, and that no file content appears.

### 15. Directory listing hides what it should

1. Send `list the directory`.
2. Confirm `node_modules`, `.git` and any `.env` are absent from the entries.
3. Confirm the reply's entry count matches what is shown.

### 16a. Search (acceptance test — spec §53 Phase 5)

1. Send `search for fetch(` (use any string that exists in your workspace).
2. Confirm a `workspace.search` row appears, expandable to show
   `N matches, M files searched`.
3. Confirm the reply lists `path:line` hits with previews.
4. Confirm nothing from `node_modules` or `.env` appears.

### 16b. Search sees unsaved work

1. Open a file, type `NEEDLE_TEST_12345`, **do not save**.
2. Send `search for NEEDLE_TEST_12345`.
3. Confirm the match is found and marked `[unsaved]`.

This is the test that distinguishes this bridge from a terminal `grep`. It
fails if the search returns nothing.

### 16d. Regex search

1. Check the **Dumb Ways to Die** output channel for
   `[activate] search backend: ripgrep (...)`. If it says `node traversal`,
   steps 2-3 will correctly refuse instead.
2. Send `search for regex "fetch\(.*\)"`.
3. Confirm matches come back, and that the reply says `for pattern` rather than
   `for text`.
4. Send `grep for whole word "fetch"` in a project that also contains
   `prefetch`. Confirm `prefetch` is **not** matched.
5. Send `search for regex "a(b"` (deliberately malformed). Confirm the tool row
   shows `INVALID_ARGUMENT` and the reply explains the pattern was invalid —
   not an internal error.

### 16e. The editor does not freeze

1. Send `search for regex "(a+)+$"`.
2. Confirm the reply comes back within a second or two and VS Code stays
   responsive throughout.

This is the pattern that hangs a JavaScript regex engine forever. If the editor
freezes, the search is not running in ripgrep.

### 16c. Project tree

1. Send `show me the project structure`.
2. Confirm a `workspace.project_tree` row appears and the reply reports entry
   and directory counts.
3. Confirm `node_modules` and build output are absent.
4. In a large repo, confirm the reply reports the tree as truncated rather than
   pretending it is complete.

### 16. Tool failures are legible

1. Close all editors.
2. Send `show me the active file`.
3. Confirm the tool row shows `✕` with error code `NOT_FOUND`, and the coach
   reports it was refused rather than inventing a file.

## Manual — Phase 7 (permissions)

### 17. A command needs your approval (acceptance test — spec §53)

1. Send `run npm test`.
2. Confirm a **modal dialog** appears naming the tool (`shell.run`) and the
   exact command (`npm test`).
3. Click **Allow once**.
4. Confirm the tool row shows `UNSUPPORTED` and the reply mentions Phase 8 —
   approval worked; execution is next phase. **Nothing was run.**

Fails if anything executes, or if no dialog appears.

### 18. Refusing actually refuses

1. Send `run rm -rf /`.
2. Click **Deny**.
3. Confirm the tool row shows `PERMISSION_DENIED` and the reply says the user
   did not approve it.
4. Repeat and press **Escape** instead of clicking Deny. Confirm the same
   refusal — dismissing is never a silent yes.

### 19. "Always allow" is not a blank cheque

1. Send `run npm test` and choose **Always allow**.
2. Send `run npm test` again. Confirm **no dialog** this time.
3. Now send `run npm publish`. Confirm a dialog **does** appear — the grant
   covered that one command, not the tool.
4. Run `Dumb Ways to Die: Forget Approvals`.
5. Send `run npm test` again and confirm it asks once more.

### 20. Reads never interrupt you

1. Send `show me the active file`, `search for TODO`, `show me the project
   structure`.
2. Confirm **no approval dialog appears at any point**.

A tool that asks permission to read is how users learn to click through
prompts without reading them.

### 21. Thinking time is not punished

1. Send `run npm test`.
2. Leave the dialog open for over a minute, then click **Allow once**.
3. Confirm the request completes rather than having timed out while you read.

## Manual — Phase 8 (command execution)

### 22. A command actually runs (acceptance test — spec §53)

1. Send `run node --version`.
2. Approve it.
3. Confirm the tool row shows `exit 0` and a duration, and the reply quotes the
   version that `node` printed.

Fails if nothing runs, or if output does not come back.

### 23. Failure is reported, not hidden

1. Send `run node --this-flag-does-not-exist` and approve.
2. Confirm the reply shows a **non-zero exit code** and the stderr text.
3. Confirm the tool row is **not** an error — the tool worked; the command
   failed, and that is the answer.

### 24. Your secrets do not travel

1. In a terminal: `export DUMBWAYS_TEST_TOKEN=hunter2`, then launch the editor
   **from that terminal** so it inherits the variable.
2. Send `run node -e "console.log(process.env.DUMBWAYS_TEST_TOKEN ?? 'absent')"`
   and approve.
3. Confirm the output is `absent`.

### 25. Nothing runs forever

1. Send `run node -e "setInterval(() => {}, 1000)"` and approve.
2. Confirm it stops after ~30s and reports **timed out** rather than hanging.
3. Confirm no orphaned `node` process is left behind.

### 26. Shell syntax is refused clearly

1. Send `run npm test | tee log.txt` and approve.
2. Confirm `INVALID_ARGUMENT` explaining commands run without a shell — not a
   confusing failure from `npm` receiving `|` as an argument.

## Manual — Phase 9 (attachments)

### 27. Attach a file (acceptance test — spec §53)

1. Take a screenshot (⌘⇧4 — it lands on your Desktop).
2. In the panel, click **Attach** and pick it.
3. Confirm a chip appears with the filename and size. Hover it for the MIME
   type and hash.
4. Send a message. Confirm the chip disappears — attachments belong to the
   message they were staged for.
5. Check the output channel for the attachment id and size on that request.

### 28. The same image twice is stored once

1. Attach the same screenshot again, then attach a **copy** of it under a
   different name.
2. Confirm `.coach/media/` contains **one** stored file, not two.
3. Confirm the chip shows the same id both times.

### 29. Refusals are explained

1. Try attaching a `.zip` or `.exe`. Confirm an error naming the supported
   types — not a silent omission.
2. Try attaching something over 20 MB. Confirm it is refused as too large.

### 30. The provider can fetch the bytes (relay mode only)

1. Start the stack, set `dumbways.provider.mode` to `relay`.
2. Attach an image and send a message.
3. Confirm the relay health endpoint shows `registeredMedia` incremented:
   `curl -s http://127.0.0.1:43123/health`
4. Fetch it yourself with the token from
   `$TMPDIR/dumbways-relay-43123.json`:
   `curl -H "Authorization: Bearer <token>" http://127.0.0.1:43123/media/<id> --output /tmp/got.png`
5. Confirm the file opens and matches what you attached.
6. Confirm the same URL **without** the header returns `401`.

## Manual — cancellation and diagnostics

### 31. Cancel actually stops things (spec §46)

1. Send `run node -e "setInterval(() => {}, 1000)"` and approve it.
2. While it runs, press **Escape** (or click **Cancel**).
3. Confirm the panel returns to idle immediately and says the answer will be
   ignored.
4. Confirm no orphaned `node` process is left: `pgrep -fl setInterval`

Fails if the process keeps running — cancelling must abort the tool, not just
stop listening.

### 32. A late answer stays ignored

1. Send a message, cancel it straight away.
2. Wait a few seconds.
3. Confirm no reply appears afterwards for the cancelled request.

### 33. Diagnostics tells you what is actually wrong

1. Run `Dumb Ways to Die: Show Diagnostics`.
2. Confirm the report lists all five hops, the transport, registered tools with
   permission classes, the permission policy, and the search backend.
3. Close the folder (open a window with no folder) and run it again. Confirm it
   says **no folder open — workspace tools will refuse**, which is the exact
   condition that makes `workspace.*` tools fail.

## Manual — the chat bridge and the receipt

### 34. Talk to a real chat (acceptance)

1. Set `dumbways.provider.mode` to `clipboard`, reload.
2. Run `Copy Chat Primer`, paste it into a fresh ChatGPT/Claude conversation,
   send. Confirm the coach replies `ready`.
3. Open a file, type something without saving, ask a question in the panel.
4. Confirm the panel says **Message copied** with what to do next.
5. Paste into the chat, send, copy the reply, click **Bring reply back**.
6. Confirm the answer appears in the panel and quotes your unsaved text.

### 35. The tool loop over copy and paste

1. Ask something that needs a file the coach cannot see, e.g.
   `what does src/app.js do?`
2. Confirm the coach replies with a ```dwtd block, and that clicking
   **Bring reply back** produces a tool row rather than an answer.
3. Confirm the panel now says **Result copied**, and the clipboard holds a
   labelled result block.
4. Paste that into the chat. Confirm the coach answers using the real contents.

### 36. Refusals travel back

1. Ask the coach to read `.env`.
2. Confirm the tool row shows `PERMISSION_DENIED` and the clipboard holds a
   block saying it was refused and why — so the coach can adapt instead of
   asking again.

### 37. The receipt tells the truth (transparency)

1. On your **first** send in clipboard mode, confirm a modal appears listing
   what will be sent and what will not.
2. Choose **Show me everything first**. Confirm the full report opens and
   nothing was sent.
3. Send for real. Confirm no modal on the second send — asked once, not
   forever.
4. Expand the `sent: …` line under your message. Confirm it matches reality:
   the filename, character count, `unsaved`, the selection range.
5. **Change something and check the receipt changes.** Deselect your selection
   and send again — the receipt must no longer claim a selection.
6. Open a `.env` file, send a message, and confirm the receipt lists it under
   **Not included** with the reason.
