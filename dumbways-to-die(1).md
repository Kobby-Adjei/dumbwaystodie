# DUMB WAYS TO DIE

## Project codename

**Dumb Ways to Die**

This is a local-first VS Code learning/agent bridge.

The name is intentionally ridiculous. The architecture should not be.

The goal is to build a system that gives an external coding coach or agent rich, live context from VS Code and lets that coach request more context or actions through a controlled tool protocol.


# 0A. READ THIS FIRST — THE ACTUAL RUNTIME SCENARIO

Claude: before writing code, understand the product the user is asking for.

This is NOT an abstract agent framework.

The intended real-world setup is:

```text
ONE USER'S COMPUTER

┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  EDITOR                                                      │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ VS Code                                                │  │
│  │ OR another supported editor host such as Antigravity   │  │
│  │                                                        │  │
│  │ Dumb Ways to Die appears INSIDE THE EDITOR.            │  │
│  │                                                        │  │
│  │ User types to the coach here.                          │  │
│  │ Current editor state is captured here.                 │  │
│  │ Coach responses appear here.                           │  │
│  └────────────────────────────────────────────────────────┘  │
│                         │                                    │
│                         │ local IPC / WebSocket              │
│                         ▼                                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ LOCAL BRIDGE / RELAY                                   │  │
│  │                                                        │  │
│  │ Runs only on this computer.                            │  │
│  │ Owns sessions, message routing, media registry,        │  │
│  │ correlation IDs, authentication, and adapter routing.  │  │
│  └────────────────────────────────────────────────────────┘  │
│                         │                                    │
│                         │ local authenticated transport      │
│                         ▼                                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ BROWSER ADAPTER                                        │  │
│  │                                                        │  │
│  │ A browser-side adapter is connected to a normal        │  │
│  │ browser window where ChatGPT is already open and the   │  │
│  │ user is already signed in.                             │  │
│  │                                                        │  │
│  │ Its job is to bridge structured requests and media     │  │
│  │ between the local relay and the selected chat surface. │  │
│  └────────────────────────────────────────────────────────┘  │
│                         │                                    │
│                         ▼                                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ CHAT SURFACE                                           │  │
│  │                                                        │  │
│  │ Existing ChatGPT conversation open in browser.         │  │
│  │ The teaching intelligence lives here.                  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

The desired user experience is:

```text
USER NEVER LEAVES THE EDITOR FOR NORMAL COACHING.

User types in Dumb Ways to Die panel
        ↓
editor context is captured
        ↓
request travels to local relay
        ↓
browser adapter delivers it to the selected chat surface
        ↓
chat produces a response
        ↓
browser adapter relays the response
        ↓
response appears inside the editor
```

The user should not need to manually copy source code, screenshots, prompts, or responses during the normal flow.

Manual fallback modes may exist for debugging, but they are NOT the product goal.

---

# 0B. THE TWO WINDOWS THAT ARE EXPECTED TO ALREADY BE OPEN

At runtime, assume the user intentionally launches:

```text
1. an editor
2. a browser with ChatGPT already open
```

Example:

```text
Window A:
VS Code
workspace = /Users/example/dev/job-agent

Window B:
Chrome / Edge / supported Chromium browser
tab = existing ChatGPT conversation
```

The bridge must NOT own ChatGPT authentication.

It must NOT ask for or store:

- ChatGPT password;
- session cookie;
- browser login token;
- OpenAI credentials.

Authentication remains owned by the normal browser session.

The bridge only connects to an already-running, user-authenticated browser surface through its browser adapter.

---

# 0C. EDITOR ENTRY POINT — WHAT THE USER CLICKS IN VS CODE

The primary editor entry point must be visible and obvious.

For VS Code, create an Activity Bar contribution:

```text
Activity Bar
    ↓
"Dumb Ways to Die" icon
    ↓
Sidebar / View Container
```

The panel must contain:

```text
DUMB WAYS TO DIE

Connection
  Editor: Connected
  Relay: Connected
  Browser: Connected
  Chat Surface: Ready

Session
  Job Agent

Current editor context
  public/index.html
  dirty: yes
  selection: L14-L22
  diagnostics: 1

Attachments
  screenshot.png

Message
  [________________________________]

  [ Send to Coach ]

Conversation
  user message
  coach response
  tool activity
```

This is the normal entry point.

Also register Command Palette commands, but the Activity Bar panel is the primary UX.

Example contribution concept:

```json
{
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "dumbways",
          "title": "Dumb Ways to Die",
          "icon": "media/dumbways.svg"
        }
      ]
    },
    "views": {
      "dumbways": [
        {
          "id": "dumbways.coach",
          "name": "Coach"
        }
      ]
    }
  }
}
```

Use the exact supported VS Code API shape when implementing.

Do not treat the example JSON as guaranteed copy-paste production code without checking the current extension manifest schema.

---

# 0D. VS CODE EXTENSION PROCESS ENTRY POINT

The desktop VS Code extension must have a normal extension-host entry point.

Target concept:

```text
package.json
   main
    ↓
dist/extension.js
    ↓
activate(context)
```

`activate()` is the application bootstrap for the editor side.

It must initialize in this order:

```text
activate()
   ↓
create ExtensionState
   ↓
create EditorAdapter
   ↓
create WorkspaceAdapter
   ↓
create PermissionManager
   ↓
create ToolRegistry
   ↓
create ContextEngine
   ↓
create SessionStore
   ↓
create RelayClient
   ↓
register commands
   ↓
register sidebar/webview provider
   ↓
start connection lifecycle
```

Do not put the whole application inside `activate()`.

`activate()` wires modules together.

`deactivate()` must dispose:

- sockets;
- listeners;
- watchers;
- child processes owned by this extension;
- temporary resources.

---

# 0E. EDITOR HOST ABSTRACTION — VS CODE AND ANTIGRAVITY ARE NOT TO BE BLINDLY ASSUMED IDENTICAL

The desired product may be used from:

```text
VS Code
or
Antigravity
or another compatible editor host later
```

Do NOT assume that every editor supports the VS Code Extension API just because the UI looks similar.

Build an editor-host abstraction.

```ts
export interface EditorHost {
  readonly hostId: string;
  readonly hostName: string;

  getWorkspaceRoots(): Promise<WorkspaceRoot[]>;
  getActiveDocument(): Promise<DocumentSnapshot | null>;
  getSelection(): Promise<SelectionSnapshot | null>;
  getCursor(): Promise<CursorSnapshot | null>;
  getDiagnostics(): Promise<DiagnosticSnapshot[]>;
  getOpenDocuments(): Promise<OpenDocumentSnapshot[]>;

  showInformation(message: string): Promise<void>;
  showError(message: string): Promise<void>;
}
```

First implementation:

```text
VsCodeEditorHost
```

For Antigravity support:

1. first verify what extension/plugin mechanism Antigravity actually exposes;
2. verify whether a VS Code extension package can run there;
3. if yes, create a thin host adapter;
4. if no, implement a separate Antigravity-facing adapter using its supported integration surface;
5. keep the relay and protocol unchanged.

The core protocol must not know whether the editor is VS Code or Antigravity.

---

# 0F. LOCAL RELAY ENTRY POINT

The relay is a local Node process.

Conceptual executable:

```text
node dist/server.js
```

or:

```text
dumbways-relay
```

Main entry:

```ts
async function main() {
  // load config
  // bind localhost
  // generate runtime auth token
  // create session registry
  // create websocket hub
  // create media registry
  // accept editor adapter connection
  // accept browser adapter connection
}
```

Default:

```text
host: 127.0.0.1
port: 43123
```

The editor extension should be capable of starting the relay automatically if it is not running.

Desired normal startup:

```text
User opens VS Code
   ↓
Dumb Ways extension activates
   ↓
extension checks 127.0.0.1:43123
   ↓
relay not found
   ↓
extension starts bundled/local relay process
   ↓
relay writes READY event
   ↓
extension authenticates
```

Never launch duplicate relays for the same configured port.

Use a lockfile or health check.

---

# 0G. BROWSER ADAPTER — WHAT IT IS

The browser adapter is a separate installable component.

For a Chromium implementation, conceptual structure:

```text
browser-adapter/
│
├── manifest.json
├── src/
│   ├── service-worker.ts
│   ├── content-script.ts
│   ├── chat-surface/
│   │   ├── ChatSurfaceAdapter.ts
│   │   └── ChatGptSurfaceAdapter.ts
│   ├── relay/
│   │   └── RelayClient.ts
│   ├── media/
│   │   └── AttachmentInjector.ts
│   └── state/
│       └── BrowserSessionState.ts
```

Responsibilities:

```text
service worker
    ↓
maintains relay connection / browser-extension state

content script
    ↓
lives only on explicitly allowed chat pages
    ↓
talks to ChatSurfaceAdapter

ChatSurfaceAdapter
    ↓
abstract interface describing:
- is surface ready?
- identify conversation
- deliver user text
- deliver media
- observe message lifecycle
- return completed response representation
```

Do not scatter site-specific browser logic throughout the extension.

Keep it isolated in one surface adapter.

---

# 0H. BROWSER ADAPTER ENTRY POINT

Normal runtime:

```text
Browser launches
   ↓
browser extension service worker starts when needed
   ↓
extension connects to:
ws://127.0.0.1:43123
   ↓
auth handshake
   ↓
browser announces:
browser.ready
   ↓
content script checks supported chat page
   ↓
chat surface adapter announces:
surface.ready
```

Example registration packet:

```json
{
  "type": "adapter.register",
  "adapterKind": "browser",
  "adapterId": "browser_abc123",
  "capabilities": [
    "chat.send_text",
    "chat.attach_media",
    "chat.receive_response"
  ]
}
```

The relay should then know:

```text
Editor adapter = connected
Browser adapter = connected
Chat surface = ready
```

The VS Code panel should display all three independently.

---

# 0I. DO NOT HIDE CONNECTION STATE

The user must always be able to see:

```text
Editor         ● connected
Relay          ● connected
Browser        ● connected
Chat surface   ● ready
```

Possible states:

```text
Editor
  connected
  disconnected

Relay
  starting
  connected
  error

Browser
  disconnected
  connecting
  connected

Chat surface
  not found
  wrong tab
  loading
  ready
  busy
  error
```

Do not collapse everything into a vague:

```text
"Connected"
```

A bridge is impossible to debug if each hop is invisible.

---

# 0J. SELECTING WHICH CHATGPT TAB / CONVERSATION IS THE COACH

The system must not randomly choose a browser tab.

There must be an explicit pairing operation.

Recommended UX:

```text
Browser is on the desired ChatGPT conversation.
User clicks browser extension icon.
User clicks:

[ Pair this chat with Dumb Ways to Die ]
```

The browser adapter then creates a local pairing record:

```ts
interface ChatSurfacePairing {
  pairingId: string;
  browserAdapterId: string;

  tabId: number;

  surfaceType: "chatgpt";

  conversationHint?: string;

  pairedAt: string;

  status: "ready" | "lost" | "closed";
}
```

Do not depend exclusively on a page title.

Tab IDs may change across browser restart, so pairing restoration must be best effort.

If the exact paired tab disappears:

```text
Chat surface: LOST
```

Do not silently switch to another conversation.

The user should intentionally re-pair.

---

# 0K. NORMAL USER FLOW — EXACTLY WHAT SHOULD HAPPEN

This is the core scenario.

## User setup

```text
1. User opens VS Code.
2. User opens project.
3. Dumb Ways to Die sidebar is visible.
4. Local relay starts automatically.
5. User opens browser.
6. User opens the desired existing ChatGPT conversation.
7. User pairs that tab through the browser adapter.
8. VS Code shows all connections green.
```

Then normal usage begins.

## Sending a coaching message

User is editing:

```text
public/index.html
```

The file has unsaved changes.

Lines 14-22 are selected.

A screenshot is attached.

The user types inside VS Code:

```text
I clicked Search and the page changed. I don't understand why.
```

Then presses:

```text
Send to Coach
```

The following must happen automatically:

```text
VS Code panel
    ↓
capture user message
    ↓
capture active editor metadata
    ↓
capture LIVE unsaved buffer snapshot
    ↓
capture selection
    ↓
capture relevant diagnostics
    ↓
resolve explicitly attached screenshot
    ↓
construct CoachRequest
    ↓
send CoachRequest to relay
```

Relay:

```text
receive CoachRequest
    ↓
assign correlation state
    ↓
find paired browser adapter
    ↓
route request
```

Browser adapter:

```text
receive CoachRequest
    ↓
verify paired tab still exists
    ↓
verify expected chat surface is ready
    ↓
prepare text context
    ↓
prepare explicit attachments
    ↓
deliver request through ChatSurfaceAdapter
    ↓
track request lifecycle
```

When a response is available:

```text
ChatSurfaceAdapter
    ↓
construct CoachResponse
    ↓
browser adapter
    ↓
relay
    ↓
VS Code extension
    ↓
conversation panel
```

From the user's perspective:

```text
typed in VS Code
got response in VS Code
```

That is the product.

---

# 0L. OUTGOING REQUEST TEXT CONSTRUCTION

Do NOT send only:

```text
"Why does this reload?"
```

Construct a deterministic context payload.

Internally keep JSON.

For a text-based chat surface, serialize it to readable Markdown.

Example:

```markdown
# DUMB WAYS TO DIE — EDITOR CONTEXT

## User message
I clicked Search and the page changed. I don't understand why.

## Workspace
job-agent

## Active editor
File: public/index.html
Language: html
Dirty: true

## Selection
Lines 14-22

```html
<form>
  ...
</form>
```

## Diagnostics
1 error

## Learning state
Current feature: company job search
Current micro-skill: HTML form behavior
Current understanding:
I think the button sends the input somehow.

## Attachments
- screenshot.png

## Coach behavior
Use the existing coaching context in this conversation.
Teach one blocking concept at a time.
Do not take over the implementation.
```

Do not include unrelated project files automatically.

The remote coach can request additional local context only if there is a supported return/tool channel.

---

# 0M. MEDIA FLOW — EXACT ROUTE

A screenshot does NOT need to become base64 inside the normal message envelope.

Flow:

```text
VS Code attachment
    ↓
.coach/media/<id>.png
    ↓
MediaRegistry registers:
id
mime type
size
sha256
local path
    ↓
CoachRequest references attachment ID
    ↓
browser adapter requests:
GET /media/<id>
    ↓
relay validates browser adapter authorization
    ↓
binary bytes returned
    ↓
ChatSurfaceAdapter handles attachment delivery
```

The normal JSON request contains:

```json
{
  "attachments": [
    {
      "id": "media_abc",
      "filename": "form.png",
      "mimeType": "image/png",
      "size": 184233,
      "sha256": "..."
    }
  ]
}
```

Not:

```text
"data:image/png;base64,iVBOR..."
```

---

# 0N. RESPONSE MODEL

Do not model a response as only one string.

Use:

```ts
export interface CoachResponse {
  id: string;
  requestId: string;
  sessionId: string;

  createdAt: string;

  content: ResponseContentPart[];

  source: {
    adapterKind: "browser" | "mock" | "other";
    surfaceType?: string;
  };

  completion: {
    state: "complete" | "cancelled" | "failed";
  };
}
```

Content:

```ts
export type ResponseContentPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "code";
      language?: string;
      code: string;
    }
  | {
      type: "attachment";
      attachment: AttachmentRef;
    };
```

Even if the first browser adapter initially returns plain text, do not permanently constrain the protocol to one string.

---

# 0O. BROWSER CHAT SURFACE ABSTRACTION

Use an interface roughly like:

```ts
export interface ChatSurfaceAdapter {
  readonly surfaceType: string;

  detect(): Promise<ChatSurfaceDetection>;

  pair(): Promise<ChatSurfacePairing>;

  getState(): Promise<ChatSurfaceState>;

  sendRequest(
    request: CoachRequest,
    attachments: ResolvedAttachment[]
  ): Promise<SurfaceRequestHandle>;

  waitForResponse(
    handle: SurfaceRequestHandle,
    signal: AbortSignal
  ): Promise<CoachResponse>;
}
```

Site-specific browser behavior belongs behind this interface.

The rest of Dumb Ways to Die must not know page structure details.

Important:

- do not bypass authentication;
- do not bypass access controls;
- do not attempt to defeat rate limits;
- do not implement anti-detection or anti-bot evasion;
- do not scrape unrelated user data;
- do not read other browser tabs;
- do not collect cookies.

If a chat surface does not permit or reliably support automated interaction, the adapter should fail clearly rather than adding bypass logic.

---

# 0P. BROWSER EXTENSION PERMISSIONS

Use minimum permissions.

Conceptually:

```text
activeTab
storage
scripting only if actually required
host permission limited to supported chat origin
localhost relay access
```

Do not ask for:

```text
<all_urls>
history
cookies
downloads
webRequestBlocking
```

unless a later feature genuinely requires a permission and the security review approves it.

The browser extension should operate only on:

```text
explicitly supported chat origin(s)
+
127.0.0.1 relay
```

---

# 0Q. STARTUP HANDSHAKE

The relay needs to know who is connected.

Use an adapter handshake.

Editor:

```json
{
  "type": "adapter.hello",
  "adapterKind": "editor",
  "adapterId": "editor_123",
  "host": "vscode",
  "protocolVersion": 1,
  "capabilities": [
    "editor.active_document",
    "editor.selection",
    "editor.diagnostics",
    "workspace.read_file"
  ]
}
```

Browser:

```json
{
  "type": "adapter.hello",
  "adapterKind": "browser",
  "adapterId": "browser_456",
  "browser": "chromium",
  "protocolVersion": 1,
  "capabilities": [
    "surface.pair",
    "chat.send",
    "chat.media",
    "chat.receive"
  ]
}
```

Relay replies:

```json
{
  "type": "adapter.welcome",
  "connectionId": "conn_xyz",
  "protocolVersion": 1,
  "sessionTokenAccepted": true
}
```

---

# 0R. HEARTBEATS

A browser can sleep service workers.

An editor can restart.

The relay must detect stale connections.

Use heartbeat:

```text
ping every 15s
consider stale after 45s
```

Exact values can be configurable.

Do not mark:

```text
Browser ● connected
```

for a socket that disappeared two minutes ago.

---

# 0S. RECONNECT BEHAVIOR

If VS Code reloads:

```text
extension activates
    ↓
reconnect relay
    ↓
restore local session
    ↓
request current adapter registry
    ↓
if browser pairing alive:
        resume
else:
        show Chat surface disconnected
```

If browser reloads:

```text
browser adapter reconnects
    ↓
attempt best-effort pairing restoration
    ↓
verify exact tab/surface
    ↓
announce ready
```

If ChatGPT tab is closed:

```text
paired surface = lost
```

No automatic reassignment.

---

# 0T. THE RELAY IS A ROUTER, NOT THE TEACHER

The relay must never contain coaching logic.

Bad:

```ts
if (userDoesNotKnowForm) {
  return "A form..."
}
```

Wrong layer.

Relay responsibilities:

```text
routing
authentication
session mapping
message correlation
media
connection state
adapter registry
timeouts
logging
```

Teaching belongs to the external coach surface.

---

# 0U. EDITOR-TO-BROWSER REQUEST ROUTING

Relay state:

```ts
interface RuntimeSession {
  sessionId: string;

  editorConnectionId?: string;
  browserConnectionId?: string;

  pairedSurface?: ChatSurfacePairing;

  pendingRequests: Map<string, PendingRequest>;
}
```

When editor sends:

```text
coach.request
```

Relay must:

```text
1. validate envelope
2. authenticate editor
3. verify session
4. verify browser adapter connected
5. verify paired surface ready
6. register request as pending
7. forward to browser
8. wait for browser events
9. forward response to editor
10. finalize pending request
```

---

# 0V. REQUEST EVENTS

Do not wait silently.

Emit progress.

Example:

```text
request.capturing
request.sent_to_relay
request.routed_to_browser
request.surface_delivering
request.surface_waiting
request.response_started
request.response_complete
request.delivered_to_editor
```

VS Code UI can show:

```text
Sending context...
Browser received...
Waiting for coach...
Coach responding...
Done.
```

This will make debugging dramatically easier.

---

# 0W. FAILURE MESSAGES MUST NAME THE BROKEN HOP

Examples:

Bad:

```text
Something went wrong.
```

Good:

```text
Browser adapter is not connected.
Open your browser and make sure the Dumb Ways to Die browser extension is enabled.
```

Good:

```text
The paired ChatGPT tab was closed.
Re-pair the conversation from the browser extension.
```

Good:

```text
The editor is connected, but the local relay is unavailable on 127.0.0.1:43123.
```

Good:

```text
The chat surface is currently busy with another request.
```

---

# 0X. FIRST-TIME INSTALL EXPERIENCE

Eventually provide a setup checklist inside VS Code:

```text
Dumb Ways to Die Setup

[✓] Editor extension installed
[✓] Local relay running
[ ] Browser adapter installed
[ ] Chat conversation paired

Step 1
Install/enable browser adapter.

Step 2
Open ChatGPT in the browser and sign in normally.

Step 3
Open the conversation you want to use as your coach.

Step 4
Click the Dumb Ways browser icon and choose:
"Pair this chat"

Step 5
Return to VS Code.

All indicators should now be green.
```

No credentials should be entered into Dumb Ways to Die.

---

# 0Y. DEVELOPMENT ENTRY POINTS — CLAUDE MUST KNOW EXACTLY WHAT TO RUN

Target development scripts:

```text
npm install

npm run build
npm run test

npm run dev:extension
npm run dev:relay
npm run dev:browser
```

If a monorepo runner is not needed, use npm workspaces.

Conceptual root scripts:

```json
{
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "dev:relay": "npm --workspace packages/relay run dev",
    "dev:browser": "npm --workspace packages/browser-adapter run dev"
  }
}
```

For the VS Code extension:

- provide `.vscode/launch.json`;
- pressing F5 should start an Extension Development Host;
- do not require obscure manual bootstrapping.

For browser adapter:

- build unpacked extension into a deterministic directory such as:

```text
packages/browser-adapter/dist/
```

README must explain how to load the unpacked development extension.

For relay:

```text
npm run dev:relay
```

must print something unambiguous:

```text
[DUMBWAYS] relay listening ws://127.0.0.1:43123
[DUMBWAYS] health http://127.0.0.1:43123/health
```

---

# 0Z. DEVELOPMENT TEST TOPOLOGY

Before connecting any real chat surface, use:

```text
VS Code Extension
       │
       ▼
Local Relay
       │
       ▼
Fake Browser Adapter
       │
       ▼
Mock Chat Surface
```

The fake browser adapter must implement the exact same browser-side protocol.

Then swap:

```text
Mock Chat Surface
```

for:

```text
ChatSurfaceAdapter implementation
```

without changing the editor or relay.

---

# 0AA. END-TO-END ACCEPTANCE TEST

The first real end-to-end test eventually must prove:

```text
1. VS Code is open.
2. job-agent workspace is open.
3. index.html has UNSAVED text.
4. a range is selected.
5. screenshot is attached.
6. browser is open.
7. desired chat conversation is paired.
8. all four connection indicators are green.

User types in VS Code:
"What am I misunderstanding here?"

9. Request leaves VS Code.
10. Live unsaved buffer is represented.
11. Selection is represented.
12. Screenshot reaches browser adapter.
13. Request is delivered to paired chat surface.
14. A response is received by browser adapter.
15. Response is correlated to the original request.
16. Response returns through relay.
17. Response appears in VS Code.
18. No manual copy/paste occurs.
19. No API key is required by Dumb Ways to Die.
20. No ChatGPT credential is stored by Dumb Ways to Die.
```

If any step cannot be implemented using a supported/reliable mechanism for a particular chat surface, report that constraint explicitly.

Do not fake success.

---

# 0AB. WHAT CLAUDE MUST NOT MISUNDERSTAND

Claude, these are NOT optional interpretations.

The user is NOT asking for:

```text
a generic chat sidebar
```

The user is asking for:

```text
EDITOR
  ↕
LOCAL CONTEXT/TOOL SYSTEM
  ↕
LOCAL RELAY
  ↕
BROWSER ADAPTER
  ↕
EXISTING CHAT SURFACE
```

The user wants the editor to be the daily interface.

The browser can remain open in the background.

The user's existing chat surface is the coaching brain.

The bridge transports:

```text
editor context
messages
screenshots
files
responses
tool results
```

The user should not normally shuttle those manually.

The architecture must therefore include ALL of:

```text
editor entry point
editor bootstrap
editor state capture
workspace adapter
local relay bootstrap
adapter handshake
browser adapter
chat pairing
media registry
request correlation
response return path
connection state UI
failure diagnosis
```

If one of these is absent, the product is incomplete.


The system should make it feel like the coach "lives in the editor" without requiring the model itself to be embedded inside VS Code.

---

# 0. The core idea

A normal chatbot only receives whatever the user types.

A coding agent feels different because it has access to tools.

The important distinction is:

```text
NORMAL CHAT

user message
    ↓
model
    ↓
response
```

versus:

```text
AGENT

user message
    ↓
model
    ↓
tool request
    ↓
local environment
    ↓
tool result
    ↓
model
    ↓
possibly another tool request
    ↓
...
    ↓
response
```

"Dumb Ways to Die" should build the local environment side of that architecture.

The model/provider is replaceable.

The VS Code context/tool layer is the product.

---

# 1. Product goal

The user should be able to stay inside VS Code and say something like:

> Why is my form doing this?

The system should already know, or be able to retrieve:

- the current workspace;
- the active file;
- the current unsaved editor buffer;
- the current selection;
- cursor position;
- visible files;
- open tabs;
- project structure;
- diagnostics;
- terminal output;
- Git diff;
- selected project files;
- screenshots;
- attached images;
- learning plan files;
- coaching instructions;
- relevant recent conversation state.

The external coach should then be able to ask for additional information using explicit tools.

Example:

```text
Coach:
READ_FILE public/app.js
```

The local system reads the file and returns it.

Then:

```text
Coach:
RUN_COMMAND npm test
```

The local system runs the command if permission allows it and returns stdout/stderr.

Then the coach can reason again.

That is the architecture to build.

---

# 2. The product is not "chat in VS Code"

Do NOT reduce this project to:

```text
sidebar textbox
    ↓
send message
    ↓
show response
```

That is only the UI shell.

The real product is:

```text
VS CODE
   │
   ├── editor state
   ├── workspace state
   ├── files
   ├── diagnostics
   ├── terminal
   ├── git
   ├── screenshots
   ├── user learning state
   │
   ▼
CONTEXT ENGINE
   │
   ▼
TOOL SERVER
   │
   ▼
TRANSPORT
   │
   ▼
PROVIDER ADAPTER
   │
   ▼
COACH / MODEL
```

The provider is the least important architectural layer.

The local context and tool protocol are the durable part.

---

# 3. Critical design rule: separate editor state from filesystem state

This must be explicit in the implementation.

A terminal process can see files on disk.

It cannot automatically know:

- which file is currently active;
- which lines are selected;
- cursor position;
- unsaved changes;
- open tabs;
- visible editors;
- VS Code diagnostics.

Therefore build two context sources.

## 3.1 Workspace adapter

The workspace adapter uses normal Node/filesystem capabilities.

Responsibilities:

- list files;
- read files from disk;
- search files;
- inspect folder structure;
- inspect package.json;
- inspect configuration files;
- inspect Git state;
- run commands;
- inspect command output;
- compute file metadata;
- create controlled snapshots.

Example interface:

```ts
export interface WorkspaceAdapter {
  getWorkspaceRoots(): Promise<WorkspaceRoot[]>;
  listDirectory(path: string): Promise<DirectoryEntry[]>;
  readDiskFile(path: string): Promise<FileResult>;
  searchText(query: SearchQuery): Promise<SearchResult[]>;
  getGitStatus(): Promise<GitStatusResult>;
  getGitDiff(options?: GitDiffOptions): Promise<GitDiffResult>;
  runCommand(request: RunCommandRequest): Promise<RunCommandResult>;
}
```

## 3.2 Editor adapter

The editor adapter uses VS Code APIs.

Responsibilities:

- active editor;
- active document;
- unsaved document contents;
- selection;
- cursor;
- visible editors;
- open text documents;
- language id;
- diagnostics;
- workspace folders;
- current editor-relative path.

Example interface:

```ts
export interface EditorAdapter {
  getActiveEditor(): ActiveEditorState | null;
  getActiveDocumentSnapshot(): DocumentSnapshot | null;
  getSelection(): SelectionSnapshot | null;
  getCursor(): CursorSnapshot | null;
  getVisibleEditors(): VisibleEditorSnapshot[];
  getOpenDocuments(): OpenDocumentSnapshot[];
  getDiagnostics(uri?: string): DiagnosticSnapshot[];
}
```

## 3.3 Unsaved buffers are first-class

If the user has typed changes but has not saved the file:

```text
filesystem version != editor buffer version
```

The agent should prefer the live editor buffer when working on the active file.

Store source metadata.

Example:

```ts
type FileContentSource = "editor-buffer" | "filesystem";

interface FileSnapshot {
  path: string;
  source: FileContentSource;
  isDirty: boolean;
  version?: number;
  content: string;
}
```

Never silently substitute disk content for a dirty editor buffer.

---

# 4. Repository layout

Use a monorepo-style structure.

```text
dumbways-to-die/
│
├── package.json
├── tsconfig.base.json
├── README.md
├── .gitignore
│
├── packages/
│   │
│   ├── protocol/
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── messages.ts
│   │       ├── tools.ts
│   │       ├── context.ts
│   │       ├── permissions.ts
│   │       └── errors.ts
│   │
│   ├── extension/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── extension.ts
│   │       ├── commands/
│   │       ├── context/
│   │       ├── tools/
│   │       ├── transport/
│   │       ├── providers/
│   │       ├── permissions/
│   │       ├── storage/
│   │       ├── diagnostics/
│   │       └── ui/
│   │
│   ├── relay/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── server.ts
│   │       ├── websocket.ts
│   │       ├── sessions.ts
│   │       ├── media.ts
│   │       ├── auth.ts
│   │       └── logging.ts
│   │
│   └── mock-provider/
│       ├── package.json
│       └── src/
│           └── index.ts
│
├── apps/
│   └── local-dashboard/
│       ├── index.html
│       ├── app.ts
│       └── styles.css
│
└── .coach/
    ├── README.md
    ├── sessions/
    ├── media/
    ├── logs/
    └── cache/
```

Do not implement every folder on day one.

This is the target structure.

Start small and evolve into it.

---

# 5. Shared protocol

All communication must use a shared typed protocol.

Do not let each layer invent its own payload shape.

The protocol package should be the source of truth.

Use TypeScript discriminated unions.

---

# 6. Session model

A session represents one editor/coach conversation.

```ts
export interface CoachSession {
  id: string;
  name: string;

  createdAt: string;
  updatedAt: string;

  workspaceRoots: WorkspaceRootRef[];

  learning?: LearningState;

  activeRequestId?: string;

  messages: SessionMessage[];

  permissions: SessionPermissions;
}
```

Learning state:

```ts
export interface LearningState {
  currentGoal?: string;
  currentFeature?: string;
  currentMicroSkill?: string;

  currentUnderstanding?: string;
  prediction?: string;
  observedResult?: string;

  demonstrated?: string[];
  shaky?: string[];
}
```

This matters because the bridge is meant to support learning, not just coding.

---

# 7. Request model

A user message should produce a `CoachRequest`.

```ts
export interface CoachRequest {
  id: string;
  sessionId: string;
  createdAt: string;

  message: string;

  workspace: WorkspaceContext;

  editor?: EditorContext;

  contextItems: ContextItem[];

  attachments: AttachmentRef[];

  learning?: LearningState;

  clientCapabilities: ClientCapabilities;
}
```

Example:

```json
{
  "id": "req_123",
  "sessionId": "session_job_agent",
  "createdAt": "2026-08-16T00:15:00-04:00",
  "message": "Why does clicking Search reload the page?",
  "workspace": {
    "name": "job-agent",
    "roots": ["/Users/kobby/dev/job-agent"]
  },
  "editor": {
    "activeFile": "public/index.html",
    "language": "html",
    "isDirty": true,
    "cursor": {
      "line": 18,
      "column": 7
    },
    "selection": {
      "startLine": 14,
      "endLine": 22,
      "content": "<form>...</form>"
    }
  },
  "contextItems": [],
  "attachments": [],
  "learning": {
    "currentFeature": "Company job search form",
    "currentMicroSkill": "HTML form submission",
    "currentUnderstanding": "I think the button sends the input."
  },
  "clientCapabilities": {
    "readFile": true,
    "searchFiles": true,
    "runCommand": false,
    "readDiagnostics": true
  }
}
```

---

# 8. Context item model

Use explicit context items.

```ts
export type ContextItem =
  | SelectionContextItem
  | FileContextItem
  | DiagnosticContextItem
  | TerminalContextItem
  | GitContextItem
  | NoteContextItem
  | ProjectTreeContextItem
  | LearningContextItem;
```

Selection:

```ts
export interface SelectionContextItem {
  type: "selection";
  path: string;
  language: string;
  startLine: number;
  endLine: number;
  content: string;
  isDirty: boolean;
}
```

File:

```ts
export interface FileContextItem {
  type: "file";
  path: string;
  source: "editor-buffer" | "filesystem";
  language?: string;
  content: string;
  truncated: boolean;
}
```

Diagnostics:

```ts
export interface DiagnosticContextItem {
  type: "diagnostics";
  path: string;
  diagnostics: {
    severity: "error" | "warning" | "info" | "hint";
    message: string;
    line: number;
    column: number;
    source?: string;
    code?: string | number;
  }[];
}
```

Terminal:

```ts
export interface TerminalContextItem {
  type: "terminal";
  terminalName?: string;
  content: string;
  capturedAt: string;
}
```

Git:

```ts
export interface GitContextItem {
  type: "git";
  branch?: string;
  status?: string;
  diff?: string;
}
```

---

# 9. Attachment/media model

Media should travel as metadata plus a local media endpoint.

Do not put large media blobs directly inside normal JSON messages.

```ts
export interface AttachmentRef {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;

  source:
    | "clipboard"
    | "screenshot"
    | "filesystem"
    | "editor"
    | "import";

  localMediaPath: string;
}
```

The relay can expose:

```text
GET /media/:id
```

The endpoint must resolve only IDs that were registered by the bridge.

Never expose arbitrary file paths.

---

# 10. Supported media

Initial:

- png
- jpg/jpeg
- webp
- gif
- pdf
- txt
- md
- json
- csv

Later:

- audio clips;
- recorded terminal sessions;
- small video clips;
- browser screenshots.

Default maximum:

```text
20 MB
```

Make this configurable.

---

# 11. Screenshot capture

The extension should support multiple screenshot sources.

## 11.1 Clipboard screenshot

A common macOS workflow is copying a screenshot to the clipboard.

Provide command:

```text
Dumb Ways to Die: Attach Clipboard Media
```

Behavior:

1. inspect clipboard capabilities;
2. if image data is available, read image;
3. save image into `.coach/media/`;
4. compute SHA-256;
5. register attachment;
6. show thumbnail/attachment entry.

If VS Code API cannot directly access image clipboard data, create a small platform abstraction or use an explicit helper process.

Do not pretend image clipboard support exists if it does not.

## 11.2 File attachment

Command:

```text
Dumb Ways to Die: Attach File
```

User chooses file.

The system copies or references it according to the security model.

Prefer copying into `.coach/media/`.

## 11.3 Screen capture

Later phase.

The tool can invoke an OS-level screenshot command only after explicit user action.

Do not continuously capture the screen.

---

# 12. Context engine

The context engine decides what should be sent initially.

This is separate from the tool server.

The context engine should be conservative.

Default automatic context:

- current workspace name;
- active file path;
- language;
- current selection if present;
- current cursor position;
- dirty state;
- active file diagnostics;
- current learning state;
- explicit attachments.

Do NOT automatically dump:

- entire repository;
- every open file;
- every environment variable;
- home directory;
- secrets;
- `.env`;
- SSH keys;
- credentials;
- browser profiles.

The coach can request more context later through tools.

That is the important architecture.

---

# 13. Token/context budget

The context engine must support size budgeting.

A model does not need the entire project every turn.

Implement approximate character/token budgets.

Example:

```ts
export interface ContextBudget {
  maxCharacters: number;
  maxFileCharacters: number;
  maxDiagnosticItems: number;
  maxTreeEntries: number;
}
```

Suggested defaults:

```text
max request context: 120,000 characters
single file: 40,000 characters
diagnostics: 100 entries
project tree: 500 entries
```

If something is truncated, mark it.

Never silently truncate without metadata.

Example:

```json
{
  "truncated": true,
  "originalCharacters": 78000,
  "includedCharacters": 40000
}
```

---

# 14. Tool protocol

This is the heart of the project.

The external coach/provider must be able to request local tools.

Use a request/response protocol.

Tool call:

```ts
export interface ToolCallRequest {
  type: "tool.call";

  id: string;
  sessionId: string;

  tool: ToolName;

  arguments: unknown;
}
```

Tool result:

```ts
export interface ToolCallResult {
  type: "tool.result";

  id: string;
  sessionId: string;

  ok: boolean;

  result?: unknown;

  error?: ToolError;
}
```

---

# 15. Initial tool set

Implement in phases.

## 15.1 read_active_document

Reads the live editor buffer.

```ts
{
  tool: "read_active_document",
  arguments: {}
}
```

Returns:

```ts
{
  path: "public/index.html",
  language: "html",
  isDirty: true,
  version: 14,
  content: "..."
}
```

## 15.2 read_file

Reads a workspace-relative file.

```ts
{
  tool: "read_file",
  arguments: {
    path: "public/app.js"
  }
}
```

Must enforce workspace boundaries.

## 15.3 list_directory

```ts
{
  tool: "list_directory",
  arguments: {
    path: "public"
  }
}
```

## 15.4 get_project_tree

Returns a bounded project tree.

Must ignore:

- node_modules
- .git
- dist
- build
- target
- large generated folders

Make ignore patterns configurable.

## 15.5 search_files

```ts
{
  tool: "search_files",
  arguments: {
    query: "fetch(",
    globs: ["**/*.js", "**/*.ts"]
  }
}
```

Prefer a fast search backend such as ripgrep if available.

Fall back to Node traversal.

## 15.6 get_diagnostics

Returns VS Code diagnostics.

```ts
{
  tool: "get_diagnostics",
  arguments: {
    path: "public/app.js"
  }
}
```

## 15.7 get_git_status

Returns branch and changes.

## 15.8 get_git_diff

Returns bounded diff output.

## 15.9 run_command

This requires explicit permission.

Example:

```ts
{
  tool: "run_command",
  arguments: {
    command": "npm test",
    "cwd": ".",
    "timeoutMs": 30000
  }
}
```

Do not allow arbitrary commands silently by default.

## 15.10 get_terminal_snapshot

Only implement if VS Code APIs/environment permit reliable capture.

Do not claim full terminal history access if unavailable.

A manual "Send terminal output" fallback is acceptable.

---

# 16. Tool permissions

Every tool must have a permission class.

```ts
export type PermissionClass =
  | "read"
  | "execute"
  | "write"
  | "destructive";
```

Suggested mapping:

```text
read_active_document  -> read
read_file             -> read
list_directory        -> read
search_files          -> read
get_diagnostics       -> read
get_git_status        -> read
get_git_diff          -> read

run_command           -> execute
write_file            -> write
apply_patch           -> write
delete_file           -> destructive
```

Initial MVP should be mostly read-only.

---

# 17. Permission modes

Support:

```ts
type PermissionMode =
  | "ask-every-time"
  | "allow-read"
  | "allow-safe"
  | "custom";
```

Recommended default:

```text
read tools: allowed
execute tools: ask
write tools: ask
destructive: always ask
```

The UI should clearly show what the coach requested.

Example:

```text
Coach wants to run:

npm test

cwd: /Users/kobby/dev/job-agent

[Allow once] [Always allow npm test] [Deny]
```

---

# 18. Do not confuse "provider" with "transport"

Use three separate concepts.

## Transport

Moves structured messages.

Examples:

- WebSocket;
- stdio;
- local IPC.

## Provider adapter

Translates between the internal protocol and an external model/coaching surface.

## Context/tool engine

Lives locally and understands VS Code.

Architecture:

```text
VS Code
   ↓
Context + Tool Engine
   ↓
Transport Protocol
   ↓
Provider Adapter
   ↓
External Coach
```

Do not embed provider-specific code into editor/context modules.

---

# 19. Provider interface

Define a provider abstraction.

```ts
export interface CoachProvider {
  readonly id: string;
  readonly displayName: string;

  connect(session: CoachSession): Promise<void>;

  sendRequest(request: CoachRequest): Promise<void>;

  sendToolResult(result: ToolCallResult): Promise<void>;

  onMessage(
    callback: (message: ProviderInboundMessage) => void
  ): Disposable;

  disconnect(): Promise<void>;
}
```

Inbound messages:

```ts
export type ProviderInboundMessage =
  | CoachResponseMessage
  | ToolCallRequest
  | ProviderStatusMessage
  | ProviderErrorMessage;
```

---

# 20. Mock provider first

Before connecting to any real external system, implement a mock provider.

This is mandatory.

The mock provider proves the architecture.

Behavior:

User sends:

```text
Why isn't my form working?
```

Mock provider responds:

```text
MOCK: I received your message.
Active file: public/index.html
```

Then test tool invocation.

Mock provider asks:

```json
{
  "type": "tool.call",
  "id": "tool_1",
  "tool": "read_active_document",
  "arguments": {}
}
```

Extension returns file content.

Mock provider then responds:

```text
MOCK: I received 842 characters from public/index.html.
```

If this works, the agent loop works.

---

# 21. Local relay

Use a local relay if it simplifies cross-process communication.

Default binding:

```text
127.0.0.1:43123
```

Never bind to `0.0.0.0` by default.

The relay may provide:

- WebSocket transport;
- session registry;
- media endpoint;
- health endpoint;
- local dashboard;
- provider registration.

Example:

```text
GET  /health
GET  /session/:id
GET  /media/:id

WS   /transport
```

Avoid unnecessary REST endpoints if WebSocket already handles messages.

---

# 22. WebSocket message envelope

Every message should use an envelope.

```ts
export interface Envelope<T> {
  protocolVersion: 1;
  id: string;
  timestamp: string;
  sessionId: string;
  payload: T;
}
```

Example:

```json
{
  "protocolVersion": 1,
  "id": "msg_123",
  "timestamp": "2026-08-16T00:22:00-04:00",
  "sessionId": "session_job_agent",
  "payload": {
    "type": "coach.request",
    "message": "Why is this button reloading the page?"
  }
}
```

---

# 23. Connection authentication

Even localhost services should authenticate.

At relay startup:

1. generate random 256-bit token;
2. hold it in memory;
3. share it with the extension/provider process through a controlled channel;
4. require it during WebSocket handshake or first authenticated message.

Never expose long-lived secrets in logs.

---

# 24. Connection lifecycle

Explicit states:

```ts
type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";
```

Implement:

- exponential backoff;
- max retry cap;
- manual reconnect;
- clear status indicator.

Do not create tight infinite retry loops.

---

# 25. Request lifecycle

Explicit request state machine:

```text
IDLE
  ↓
CAPTURING_CONTEXT
  ↓
REQUEST_READY
  ↓
SENDING
  ↓
SENT
  ↓
PROVIDER_PROCESSING
  ↓
TOOL_REQUESTED (optional)
  ↓
TOOL_RUNNING
  ↓
TOOL_RESULT_SENT
  ↓
PROVIDER_PROCESSING
  ↓
RESPONSE_RECEIVED
  ↓
DELIVERED
```

Failure states:

```text
FAILED
CANCELLED
TIMED_OUT
PERMISSION_DENIED
PROVIDER_DISCONNECTED
```

Persist request state transitions for diagnostics.

---

# 26. Correlation IDs

Every request, tool call, tool result, and response must be traceable.

Example:

```text
sessionId
  └── requestId
       ├── toolCallId #1
       ├── toolCallId #2
       └── responseId
```

This becomes critical once multiple requests exist.

---

# 27. VS Code extension commands

Register at least:

```text
Dumb Ways to Die: Open Coach
Dumb Ways to Die: New Session

Dumb Ways to Die: Send Message
Dumb Ways to Die: Send Current Selection
Dumb Ways to Die: Send Active File
Dumb Ways to Die: Attach File
Dumb Ways to Die: Attach Clipboard Media

Dumb Ways to Die: Show Current Context
Dumb Ways to Die: Clear Current Context

Dumb Ways to Die: Show Tool Permissions
Dumb Ways to Die: Show Diagnostics
Dumb Ways to Die: Reconnect Provider

Dumb Ways to Die: Open Learning State
Dumb Ways to Die: Add PLAN.md
Dumb Ways to Die: Add LEARNING_LOG.md
Dumb Ways to Die: Add coach.md
```

---

# 28. VS Code UI

Build a sidebar view.

Concept:

```text
┌──────── DUMB WAYS TO DIE ────────┐
│                                  │
│ Session: Job Agent               │
│ Provider: Mock                   │
│ Status: ● Connected              │
│                                  │
│ Current Goal                     │
│ Build company search form        │
│                                  │
│ Context                          │
│ ✓ public/index.html (dirty)      │
│ ✓ selection L14-L22              │
│ ✓ 2 diagnostics                  │
│ ✓ screenshot.png                 │
│                                  │
│ Message                          │
│ ┌──────────────────────────────┐ │
│ │ Why does this reload?       │ │
│ └──────────────────────────────┘ │
│                                  │
│ [ Send ]                         │
│                                  │
│ ──────────────────────────────── │
│ Coach                            │
│                                  │
│ Before changing the code, what   │
│ do you think the browser does    │
│ when a submit button is clicked? │
│                                  │
│ Tool activity                    │
│ ✓ read_active_document           │
│ ✓ get_diagnostics                │
│                                  │
└──────────────────────────────────┘
```

Follow the VS Code theme.

Do not make a giant custom design system.

---

# 29. Conversation rendering

Support message types:

- user;
- coach;
- system;
- tool call;
- tool result;
- error.

Tool calls should collapse by default.

Example:

```text
▸ read_file public/app.js
```

Expanded:

```text
Tool: read_file
Path: public/app.js
Result: 1,244 characters
Duration: 12 ms
```

Do not dump giant tool responses into the main conversation unless requested.

---

# 30. Learning mode

This project exists partly to support deliberate learning.

The bridge should expose structured learning fields.

```text
Goal
Current understanding
Prediction
Observed result
Question
```

The user should be able to fill them without writing a giant prompt.

Example:

```text
Goal:
Understand HTML form submission

Current understanding:
A form groups inputs.

Prediction:
Clicking Search sends the values.

Observed:
The page reloads and ?company=OpenAI appears.

Question:
Why?
```

The provider then receives these as structured context.

---

# 31. Coaching rules integration

If a `coach.md` file exists, show it as a known learning artifact.

Do not automatically inject it into every request unless configured.

Suggested settings:

```json
{
  "dumbways.coachRules.mode": "session-start"
}
```

Modes:

```text
never
session-start
every-request
manual
```

Default:

```text
session-start
```

---

# 32. Learning log

If `LEARNING_LOG.md` exists:

- allow provider to read it via tool;
- allow user to attach it manually;
- optionally expose a structured summary.

Do not let the model silently mark things "learned."

Only the user or explicit learning workflow should update demonstrated skills.

---

# 33. Project plan

If `PLAN.md` exists:

- offer one-click attach;
- allow read tool;
- allow provider to ask the user to update it.

Do not automatically rewrite the plan unless the user explicitly permits write operations.

---

# 34. File watching

Use VS Code filesystem watchers carefully.

Possible uses:

- notice when PLAN.md changes;
- notice when LEARNING_LOG.md changes;
- update attachment status;
- update project tree cache.

Do not continuously re-index the entire workspace on every keystroke.

Debounce changes.

---

# 35. Diagnostics

Use VS Code's diagnostic API.

A provider should be able to ask:

```text
get_diagnostics
```

and receive actual editor diagnostics.

This is better than forcing the user to paste compiler errors.

Include:

- severity;
- path;
- line;
- column;
- source;
- code;
- message.

---

# 36. Git context

Provide read-only Git context initially.

Useful:

- current branch;
- modified files;
- staged files;
- diff.

Do not auto-commit.

Do not auto-push.

Do not auto-reset.

---

# 37. Command execution

This is powerful and dangerous.

Implement strict controls.

Command request:

```ts
export interface RunCommandRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}
```

Default behavior:

- show user the exact command;
- show cwd;
- ask permission;
- run with timeout;
- capture stdout;
- capture stderr;
- capture exit code.

Result:

```ts
export interface RunCommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}
```

Truncate massive output and mark truncation.

---

# 38. Process execution security

Never run commands through unsafe string concatenation if arguments can be separated.

Prefer spawn-style execution when possible.

Do not inherit sensitive environment variables blindly.

Support an environment allowlist.

Never expose:

- API keys;
- tokens;
- SSH secrets;
- browser cookies;
- credential files.

---

# 39. Workspace boundary enforcement

All file operations must be restricted to workspace roots.

Given:

```text
workspace root:
/Users/kobby/dev/job-agent
```

Reject:

```text
../../.ssh/id_rsa
```

Reject symlink escapes where practical.

Resolve real path before access.

Check that final resolved path remains inside an allowed workspace root.

---

# 40. Secret filtering

Before sending context externally, inspect paths and filenames.

Default deny patterns:

```text
.env
.env.*
*.pem
*.key
id_rsa
id_ed25519
.aws/
.ssh/
credentials
secrets
```

Allow user override only explicitly.

Do not silently send known secret files.

---

# 41. Content redaction

Optional later phase.

Support patterns for:

- API keys;
- bearer tokens;
- private keys;
- connection strings.

If redaction occurs, mark:

```text
[REDACTED_BY_DUMBWAYS]
```

Do not silently mutate code without indicating redaction.

---

# 42. Local data storage

Store project-local state under:

```text
.coach/
```

Example:

```text
.coach/
├── sessions/
│   └── session_job_agent.json
├── media/
│   └── req_123_screen.png
├── logs/
│   └── 2026-08-16.jsonl
└── cache/
```

Add `.coach/` to `.gitignore` by default.

Do not modify `.gitignore` silently.

Ask once or provide command.

---

# 43. Logging

Use structured JSONL logs.

Each event:

```json
{
  "timestamp": "...",
  "level": "info",
  "sessionId": "...",
  "requestId": "...",
  "event": "tool.completed",
  "tool": "read_file",
  "durationMs": 8
}
```

Never log:

- auth tokens;
- secret file contents;
- entire binary attachments;
- environment dumps.

---

# 44. Diagnostics panel

Provide:

```text
Dumb Ways to Die: Show Diagnostics
```

Show:

- extension version;
- protocol version;
- relay state;
- provider state;
- current session id;
- workspace roots;
- pending requests;
- last transport error;
- registered tools;
- permission mode;
- media directory;
- log directory.

This will save hours of debugging.

---

# 45. Provider status

Provider adapter should emit status:

```ts
export interface ProviderStatusMessage {
  type: "provider.status";
  status:
    | "connecting"
    | "ready"
    | "busy"
    | "waiting-for-tool"
    | "disconnected"
    | "error";
  message?: string;
}
```

UI should reflect it.

---

# 46. Cancellation

A user must be able to cancel a request.

Command:

```text
Dumb Ways to Die: Cancel Current Request
```

If provider supports cancellation, forward it.

If not, locally mark request cancelled and ignore late response.

---

# 47. Timeouts

Tool calls should have timeouts.

Suggested:

```text
read file: 5s
search: 15s
git diff: 10s
command: configurable, default 30s
provider request: configurable
```

Never allow an unbounded process by default.

---

# 48. Error protocol

Use typed errors.

```ts
export interface ToolError {
  code:
    | "NOT_FOUND"
    | "PERMISSION_DENIED"
    | "OUTSIDE_WORKSPACE"
    | "TIMEOUT"
    | "INVALID_ARGUMENT"
    | "TOO_LARGE"
    | "EXECUTION_FAILED"
    | "UNSUPPORTED"
    | "INTERNAL";

  message: string;

  details?: Record<string, unknown>;
}
```

The provider should receive useful but not sensitive errors.

---

# 49. Version the protocol

Start:

```text
protocolVersion = 1
```

Every envelope includes version.

If incompatible version:

- reject clearly;
- do not guess.

---

# 50. Browser/provider boundary

Do not hardwire the system to one consumer website.

The local architecture must work even if the provider adapter changes.

Possible future providers:

```text
MockProvider
LocalModelProvider
OfficialAPIProvider
CustomRemoteProvider
HumanRelayProvider
```

The local tool/context architecture must remain unchanged.

Do not build unsupported scraping or automated extraction of consumer ChatGPT pages into the core project.

If a future provider has an official supported integration, implement it as a provider adapter.

---

# 51. Human relay provider

Provide a fallback provider that proves full transport without any model API.

Behavior:

1. local dashboard receives request;
2. shows prepared context;
3. human can supply response;
4. response returns to VS Code.

This is useful for architecture testing.

It should not be the final UX, but it proves transport.

---

# 52. Fake tool-agent provider

Build an even better test provider.

Rules:

If user message contains:

```text
"show file"
```

provider issues `read_active_document`.

If user message contains:

```text
"diagnostics"
```

provider issues `get_diagnostics`.

If user message contains:

```text
"tree"
```

provider issues `get_project_tree`.

This allows testing full agent loops without any real model.

---

# 53. Phase plan

Do NOT build the whole architecture at once.

---

## PHASE 0 — Repository and protocol

Build only:

- root workspace;
- extension package;
- protocol package;
- mock provider.

Acceptance:

```text
npm install
npm run build
```

succeeds.

Stop.

---

## PHASE 1 — VS Code extension loads

Build:

- extension activation;
- sidebar shell;
- status indicator;
- command registration.

Acceptance:

- Extension Development Host opens;
- sidebar appears;
- no errors in extension host.

Stop.

---

## PHASE 2 — Active editor context

Implement:

- active file path;
- active buffer content;
- dirty state;
- selection;
- cursor;
- language;
- diagnostics.

Acceptance test:

1. open HTML file;
2. modify without saving;
3. select lines;
4. invoke `Show Current Context`;
5. displayed content must reflect unsaved buffer;
6. selected lines must be correct.

Stop.

---

## PHASE 3 — Mock request/response

Implement:

```text
VS Code message
    ↓
MockProvider
    ↓
Mock response
    ↓
VS Code conversation
```

Acceptance:

User types:

```text
hello
```

UI displays:

```text
MOCK: hello
```

Stop.

---

## PHASE 4 — Tool calls

Implement:

- read_active_document;
- read_file;
- list_directory;
- get_diagnostics.

Mock provider should request tools.

Acceptance:

```text
user: show active file
provider -> read_active_document
extension -> tool result
provider -> "I read X characters"
```

Stop.

This is the first true agent loop.

---

## PHASE 5 — Workspace search

Implement:

- project tree;
- search_files;
- ignore rules.

Acceptance:

Provider can request search for `fetch`.

Stop.

---

## PHASE 6 — Relay transport

Only now introduce localhost relay.

Implement:

```text
Extension
   ↕
WebSocket
   ↕
Relay
   ↕
Mock external provider
```

Acceptance:

Provider runs as separate process.

Stop.

---

## PHASE 7 — Permissions

Implement:

- read permission;
- execute permission;
- approval UI.

Acceptance:

Provider requests `run_command`.

User must approve.

Stop.

---

## PHASE 8 — Command execution

Implement controlled command runner.

Acceptance:

Provider requests:

```text
npm test
```

User approves.

stdout/stderr return to provider.

Stop.

---

## PHASE 9 — Attachments

Implement:

- file attachment;
- image attachment;
- metadata;
- media endpoint.

Acceptance:

Request includes screenshot metadata.

Provider can fetch registered attachment from relay.

Stop.

---

## PHASE 10 — Learning state

Implement:

- Goal;
- Feature;
- Micro-skill;
- Understanding;
- Prediction;
- Observation.

Acceptance:

These appear in request payload.

Stop.

---

## PHASE 11 — coach.md / PLAN.md / LEARNING_LOG.md

Implement known learning artifacts.

Acceptance:

User can attach them with one click.

Do not auto-write them.

Stop.

---

## PHASE 12 — Polish

Add:

- keyboard shortcuts;
- history;
- request cancellation;
- reconnect;
- diagnostics;
- settings;
- status bar.

---

# 54. Testing strategy

Use multiple layers.

## Unit tests

Protocol serialization.

Test:

- valid envelopes;
- invalid protocol versions;
- tool argument validation;
- context truncation;
- path security;
- ignore patterns;
- secret filtering.

## Integration tests

Test:

```text
Extension context engine
Mock provider
Tool call
Tool result
```

## Relay tests

Test:

- authentication;
- reconnect;
- session isolation;
- media access;
- invalid IDs;
- oversized uploads.

## Security tests

Attempt:

```text
../../etc/passwd
../.ssh/id_rsa
symlink escape
oversized file
invalid MIME
invalid auth token
```

Must fail.

---

# 55. Manual test script

Maintain `TESTING.md`.

Example:

## Unsaved buffer

1. Open `public/index.html`.
2. Type `UNSAVED_TEST`.
3. Do not save.
4. Run `Dumb Ways to Die: Show Current Context`.
5. Confirm `UNSAVED_TEST` appears.

## Selection

1. Select lines 5-10.
2. Show current context.
3. Confirm line range and content.

## Tool call

1. Send `show active file`.
2. Confirm mock provider requests tool.
3. Confirm tool result.
4. Confirm provider response.

Every phase must include a manual test.

---

# 56. Configuration

Use VS Code settings.

Suggested:

```json
{
  "dumbways.relay.port": 43123,
  "dumbways.context.maxCharacters": 120000,
  "dumbways.context.maxFileCharacters": 40000,
  "dumbways.permissions.mode": "allow-read",
  "dumbways.media.maxSizeMb": 20,
  "dumbways.learning.enabled": true,
  "dumbways.coachRules.mode": "session-start"
}
```

Do not create 50 settings initially.

Add as features become real.

---

# 57. Keyboard shortcuts

Later:

```text
Cmd+Shift+D
Open Coach

Cmd+Enter
Send Coach Message

Cmd+Shift+S
Send Current Selection

Cmd+Shift+A
Attach Clipboard Media

Escape
Cancel Current Request
```

Avoid collisions.

Let users customize.

---

# 58. Performance

Do not make VS Code slow.

Rules:

- do not recursively scan workspace on every message;
- cache project tree with invalidation;
- debounce watchers;
- stream large search results;
- cap outputs;
- do expensive work off the extension activation path;
- lazy-load relay when needed.

Measure durations.

---

# 59. Context freshness

Every context object should have timestamp/version.

Example:

```ts
interface DocumentSnapshot {
  path: string;
  documentVersion: number;
  capturedAt: string;
  content: string;
}
```

If provider requests file later, return current content, not stale snapshot unless specifically requested.

---

# 60. Stale-context warning

If the user sends request using a selection and then edits the file while provider is working:

mark selection snapshot as historic.

The tool server can return current buffer separately.

Do not pretend old context is current.

---

# 61. Tool result size control

Tool results need limits.

Example:

`read_file`:

- max default 40k chars;
- provider may request range.

Support:

```ts
{
  path: "server.js",
  startLine: 100,
  endLine: 180
}
```

This is better than shipping entire files.

---

# 62. Line-aware file reads

Implement:

```ts
interface ReadFileArgs {
  path: string;
  startLine?: number;
  endLine?: number;
}
```

Return:

```ts
interface ReadFileResult {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
  truncated: boolean;
}
```

---

# 63. Search result shape

```ts
interface SearchResult {
  path: string;
  line: number;
  preview: string;
}
```

Provider can then request specific ranges.

---

# 64. Project tree format

Do not send gigantic JSON trees.

Return compact entries:

```ts
interface ProjectTreeEntry {
  path: string;
  type: "file" | "directory";
}
```

Apply ignore patterns.

---

# 65. Terminal philosophy

Do not build around magical terminal access assumptions.

There are three cases:

1. command was executed by this bridge;
   - bridge owns stdout/stderr;
   - safe to return.

2. integrated VS Code terminal output is accessible through supported API/environment;
   - use it carefully.

3. terminal history is not programmatically accessible;
   - provide explicit capture/import.

Never fabricate terminal history.

---

# 66. Browser context

This project may later include browser state for web development.

Possible future adapter:

```text
Browser Dev Adapter
```

It could expose:

- current URL;
- console logs;
- network requests;
- DOM selection;
- screenshot.

Only build using supported browser debugging interfaces.

Keep separate from core VS Code extension.

---

# 67. Browser tool ideas

Future tools:

```text
browser.get_url
browser.screenshot
browser.get_console
browser.get_network
browser.inspect_element
```

These should be their own adapter.

Do not bake them into workspace code.

---

# 68. Context routing

Eventually the provider should be able to ask the correct adapter:

```text
editor.read_active_document
workspace.read_file
workspace.search
git.diff
browser.screenshot
browser.network
terminal.run
```

Namespacing tools will help.

Potential future naming:

```text
editor.active_document
editor.selection
editor.diagnostics

workspace.read_file
workspace.list
workspace.search

git.status
git.diff

shell.run

media.get

browser.screenshot
browser.network
```

---

# 69. Tool registry

Implement a tool registry.

```ts
export interface ToolDefinition<TArgs, TResult> {
  name: string;
  description: string;
  permission: PermissionClass;

  validate(args: unknown): TArgs;

  execute(
    args: TArgs,
    context: ToolExecutionContext
  ): Promise<TResult>;
}
```

Registry:

```ts
toolRegistry.register(readFileTool);
toolRegistry.register(searchFilesTool);
```

Avoid giant switch statements.

---

# 70. Tool descriptions

Keep tool metadata machine-readable.

Example:

```ts
{
  name: "workspace.read_file",
  description: "Read a UTF-8 text file inside the current VS Code workspace.",
  permission: "read"
}
```

A future model adapter can expose these definitions directly.

---

# 71. Tool validation

Use runtime validation.

TypeScript types disappear at runtime.

Use a lightweight schema library or handwritten validation.

Do not trust provider arguments.

---

# 72. Text encoding

Initial file support:

```text
UTF-8 text
```

If binary:

return:

```text
UNSUPPORTED_BINARY_FILE
```

unless explicitly handled as attachment.

---

# 73. File change writes

Do NOT implement write tools until read/tool transport is stable.

When later implementing writes:

- use VS Code WorkspaceEdit where appropriate;
- support preview;
- require explicit approval;
- preserve undo history.

Avoid direct disk writes for active editor modifications when VS Code APIs give better UX.

---

# 74. Apply patch

Future tool:

```text
workspace.apply_patch
```

Requirements:

- preview diff;
- user approval;
- apply through VS Code;
- preserve undo;
- return actual applied diff.

Not MVP.

---

# 75. Security principle

The external provider is untrusted input.

Even if it is an AI assistant.

Never assume a tool call is safe because "the model asked for it."

Local bridge must enforce:

- path boundaries;
- permissions;
- timeouts;
- size limits;
- validation;
- secret filtering.

---

# 76. Privacy principle

Automatic context should be minimal.

Retrieval should be on demand.

Good:

```text
User asks about button.
Send active selection.
Coach asks for app.js.
Tool reads app.js.
```

Bad:

```text
Send entire repository every message.
```

---

# 77. The learning principle

The bridge should help the coach teach.

It should not make the agent write everything automatically.

The user should be able to configure a "learning mode" where:

- write tools are disabled;
- commands may require approval;
- provider receives coaching instructions;
- current micro-skill is visible;
- response style favors questions over patches.

This is a product-level constraint, not just prompt text.

---

# 78. Learning mode presets

```ts
type LearningMode =
  | "strict-coach"
  | "guided"
  | "normal-agent";
```

Strict coach:

```text
read tools: yes
diagnostics: yes
search: yes
run command: ask
write: disabled
destructive: disabled
```

Guided:

```text
read: yes
run: ask
write: ask
destructive: disabled
```

Normal agent:

```text
read: yes
run: according to permissions
write: according to permissions
destructive: always ask
```

Default for this project:

```text
strict-coach
```

---

# 79. Coaching metadata

A request can include:

```ts
interface CoachingMetadata {
  mode: LearningMode;

  rules?: string[];

  currentMicroSkill?: string;

  requirePredictionBeforeRun?: boolean;

  requireUserAttemptBeforeWrite?: boolean;
}
```

This lets provider adapters enforce behavior more reliably.

---

# 80. Session start packet

When starting a session, send:

- coach rules summary;
- learning state;
- project name;
- current feature;
- current micro-skill;
- tool capabilities;
- permission mode.

Do not resend giant coaching instructions every message if provider maintains session state.

---

# 81. State persistence

Persist:

- session metadata;
- learning state;
- conversation metadata;
- tool history references;
- attachment metadata.

Do not persist giant duplicate file contents unless needed.

Prefer references + timestamps.

---

# 82. Conversation history

Store local history for UX.

But do not assume a provider has remembered every previous turn.

Provider adapter should decide what history needs to be replayed.

Keep internal history independent of provider transport.

---

# 83. Provider reconnect

If provider disconnects:

- preserve local session;
- mark disconnected;
- reconnect;
- re-establish provider session if supported;
- do not silently duplicate user requests.

Use request IDs for deduplication.

---

# 84. Idempotency

A resent message should not accidentally execute a command twice.

Tool call IDs must be processed once.

Maintain recent tool-call cache.

If duplicate:

return cached result when safe.

Never rerun destructive operations from duplicate packets.

---

# 85. Media deduplication

Hash attachments.

If same SHA-256 already exists:

reuse local media object.

Do not store duplicate screenshots endlessly.

---

# 86. Cleanup

Provide retention policy.

Example:

```text
media older than 30 days
logs older than 14 days
```

Do not delete active session data silently.

Provide:

```text
Dumb Ways to Die: Clean Local Cache
```

---

# 87. README expectations

README must explain:

1. what the project is;
2. what it is not;
3. architecture diagram;
4. local-only security model;
5. how to build;
6. how to launch Extension Development Host;
7. how to test mock provider;
8. tool permission model;
9. where data is stored;
10. current implementation phase;
11. known limitations.

Keep README updated after every phase.

---

# 88. CHANGELOG

Maintain:

```text
CHANGELOG.md
```

Record features by phase.

---

# 89. DEVELOPMENT.md

Maintain detailed developer setup.

Include:

```text
Node version
npm commands
build
watch
test
extension launch
relay launch
mock provider launch
debugging
logs
```

---

# 90. Architectural decision records

Use:

```text
docs/adr/
```

Examples:

```text
0001-separate-editor-and-workspace-adapters.md
0002-shared-protocol-package.md
0003-localhost-only-relay.md
0004-tool-permission-model.md
```

Do not overdo ADRs, but record important decisions.

---

# 91. Claude Code operating instructions

When Claude Code receives this specification:

DO NOT immediately implement every section.

Claude must:

1. inspect repository;
2. identify current phase;
3. state the smallest next milestone;
4. implement only that milestone;
5. compile;
6. run tests;
7. report real failures;
8. fix failures;
9. stop once acceptance criteria pass.

Do not jump ahead because later architecture is described here.

This document is the map, not permission to build everything at once.

---

# 92. Claude must not hide failures

After running commands, report:

```text
Command:
Result:
Exit code:
What failed:
What changed:
```

Do not say "should work."

Prove it.

---

# 93. Claude must use real workspace context

Before modifying code:

- inspect existing files;
- inspect package.json;
- inspect tsconfig;
- inspect current phase implementation.

Do not overwrite working architecture with a fresh scaffold unnecessarily.

---

# 94. Claude must not overengineer

Do not add:

- Kubernetes;
- Docker;
- Redis;
- databases;
- queues;
- microservices;
- React;
- Next.js;
- Electron;

unless the project reaches a point where one is clearly justified.

This is a local VS Code extension + local relay.

Keep it lean.

---

# 95. Claude must preserve learning value

If the user is actively learning from the build:

- explain architecture choices;
- avoid replacing every file wholesale;
- identify the concept being introduced;
- keep changes reviewable;
- let the user implement small learning-target pieces when requested.

This project can itself teach:

```text
TypeScript
VS Code APIs
Node
WebSockets
protocol design
security
tool systems
agent loops
media transport
state machines
testing
```

Use the project as a curriculum when asked.

---

# 96. The "Codex feeling"

The final user experience should eventually create this illusion:

> The coach knows what I am doing in VS Code.

But internally that illusion is produced by explicit systems:

```text
editor adapter
+
workspace adapter
+
context engine
+
tool server
+
transport
+
provider
```

No magic.

That is exactly the point.

---

# 97. Final target architecture

```text
                         ┌─────────────────────────┐
                         │     External Coach      │
                         │       / Provider        │
                         └────────────┬────────────┘
                                      │
                             Provider Adapter
                                      │
                         structured protocol
                                      │
                         ┌────────────▼────────────┐
                         │      Local Relay        │
                         │                         │
                         │ sessions                │
                         │ websocket               │
                         │ authentication          │
                         │ media registry          │
                         │ correlation IDs         │
                         └────────────┬────────────┘
                                      │
                         structured protocol
                                      │
                         ┌────────────▼────────────┐
                         │  VS Code Extension      │
                         │                         │
                         │ Context Engine          │
                         │ Tool Registry           │
                         │ Permission Manager      │
                         │ Session Store           │
                         │ Coach UI                │
                         └──────┬──────────┬───────┘
                                │          │
                ┌───────────────┘          └──────────────┐
                │                                         │
        ┌───────▼────────┐                       ┌────────▼───────┐
        │ Editor Adapter │                       │Workspace Adapter│
        │                │                       │                 │
        │ active buffer  │                       │ filesystem      │
        │ selection      │                       │ search          │
        │ cursor         │                       │ git             │
        │ diagnostics    │                       │ commands        │
        │ dirty files    │                       │ project tree    │
        └────────────────┘                       └─────────────────┘
```

Future:

```text
                    Browser Dev Adapter
                           │
                 console / network / DOM
                           │
                     screenshots
```

---

# 98. Definition of success

Phase-level success is NOT:

> "There is a chat panel."

Real success is:

1. user asks a question from VS Code;
2. request includes active editor state;
3. provider receives it;
4. provider requests another file;
5. tool server reads that file;
6. provider receives tool result;
7. provider requests diagnostics;
8. diagnostics are returned;
9. provider forms response;
10. response appears in VS Code;
11. all actions are traceable;
12. permissions were enforced;
13. unsaved editor state was preserved;
14. no entire repository dump was necessary.

That is an actual agent bridge.

---

# 99. First implementation task

Claude Code must begin with ONLY this:

## Milestone A

Create a minimal VS Code extension that can:

1. open a sidebar;
2. detect active file;
3. read the LIVE editor buffer;
4. show whether the file is dirty;
5. show current selection;
6. show current diagnostics;
7. accept one user message;
8. send all of the above to a mock provider in-process;
9. receive a mock response;
10. display it in the sidebar.

No WebSocket.

No relay.

No media.

No shell commands.

No browser.

No external provider.

No write tools.

No future-phase implementation.

Acceptance test:

- modify a file without saving;
- select part of it;
- create a diagnostic/error if possible;
- send "what am I looking at?";
- mock provider response must confirm:
  - active path;
  - unsaved buffer content is current;
  - selection range;
  - diagnostic count.

After this passes, stop.

Do not begin Milestone B until explicitly asked.

---

# 100. Final instruction to Claude

Build the **agent environment first**.

Do not chase the external model connection first.

The most valuable thing in this project is the layer that can answer:

```text
What file is Kobby looking at?
What has he selected?
What has he changed but not saved?
What errors does VS Code see?
What other file does the coach need?
Can the coach request it?
Can the tool server return it safely?
Can commands eventually be run with permission?
Can screenshots and other media be transported?
```

Once those answers exist, any compliant provider can sit on top.

That is Dumb Ways to Die.
