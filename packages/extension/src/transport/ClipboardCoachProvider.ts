import {
  buildChatPrimer,
  createId,
  extractChatBlocks,
  renderChatBlock,
  type ChatBlockProblem,
  type CoachProvider,
  type CoachRequest,
  type CoachResponse,
  type CoachSession,
  type Disposable,
  type ProviderInboundMessage,
  type ToolCallRequest,
  type ToolCallResult,
  type ToolDescriptor,
} from "@dumbways/protocol";

/**
 * A coach on the other end of the clipboard.
 *
 * This is the surface-agnostic transport: it works with ChatGPT, Claude, a
 * local model, or anything else a person can paste into, because it makes no
 * assumption about the page at all. There is no browser extension here and no
 * site-specific code — which is exactly why it is built first. When an
 * automated adapter is added later and its selectors break, it degrades into
 * *this*, which is real working code rather than a promise.
 *
 * No `vscode` import: the clipboard is an interface, so the whole loop is
 * testable without an editor.
 */

export interface ClipboardAccess {
  write(text: string): Promise<void>;
  read(): Promise<string>;
}

export type AwaitingKind = "request" | "tool-result" | "primer";

export interface ClipboardCoachProviderOptions {
  clipboard: ClipboardAccess;
  /** Renders a request for a text surface (spec §0L). */
  renderRequest: (request: CoachRequest) => string;
  /** The live tool list, so the primer cannot advertise what does not exist. */
  listTools: () => ToolDescriptor[];
  log: (message: string) => void;
  /** Drives the panel's "paste the reply" affordance. */
  onAwaiting: (awaiting: AwaitingKind | undefined) => void;
}

export class ClipboardCoachProvider implements CoachProvider {
  readonly id = "clipboard";
  readonly displayName = "Clipboard (any chat)";

  private readonly listeners = new Set<(message: ProviderInboundMessage) => void>();
  private session: CoachSession | undefined;
  private pendingRequestId: string | undefined;
  private awaiting: AwaitingKind | undefined;
  /** The primer goes out once per conversation, folded into the first message. */
  private primerSent = false;

  /**
   * Our tool-call id -> the id the coach chose.
   *
   * The coach's ids are its own business and it will happily reuse `call_1`
   * every turn. Passing those straight to the tool registry would collide with
   * its idempotency cache and return a stale result for a brand-new request,
   * so we mint our own id and translate back when the result is rendered.
   */
  private readonly callIds = new Map<string, string>();

  constructor(private readonly options: ClipboardCoachProviderOptions) {}

  async connect(session: CoachSession): Promise<void> {
    this.session = session;
    // A new conversation needs the protocol explained again.
    this.primerSent = false;
    this.emit({
      type: "provider.status",
      status: "ready",
      message: "Ready. Messages are copied to your clipboard.",
    });
  }

  /**
   * Puts the primer on the clipboard on its own.
   *
   * Not needed in the normal flow — the first message carries it. This exists
   * for re-priming a conversation that has drifted or been cleared.
   */
  async copyPrimer(): Promise<void> {
    await this.options.clipboard.write(buildChatPrimer(this.options.listTools()));
    this.setAwaiting("primer");
    this.options.log("[clipboard] primer copied");
  }

  async sendRequest(request: CoachRequest): Promise<void> {
    this.pendingRequestId = request.id;
    this.callIds.clear();

    // The primer rides along with the first message instead of being a setup
    // step. Asking someone to copy a primer, paste it, wait for "ready", and
    // only then start is three chances to give up before anything has
    // happened — and the chat does not care whether it arrives separately.
    const body = this.options.renderRequest(request);
    const payload = this.primerSent
      ? body
      : `${buildChatPrimer(this.options.listTools())}\n\n---\n\n${body}`;

    this.primerSent = true;

    await this.options.clipboard.write(payload);
    this.setAwaiting("request");
    this.options.log(`[clipboard] request ${request.id} copied (${request.contextItems.length} items)`);

    this.emit({
      type: "provider.status",
      status: "busy",
      message: "Paste into your chat, then bring the reply back.",
    });
  }

  async sendToolResult(result: ToolCallResult): Promise<void> {
    const coachId = this.callIds.get(result.id) ?? result.id;

    const block = renderChatBlock({
      v: 1,
      type: "tool.result",
      id: coachId,
      ok: result.ok,
      ...(result.ok ? { result: result.result } : {}),
      ...(result.error ? { error: { code: result.error.code, message: result.error.message } } : {}),
    });

    // A human is going to look at this before pasting it, so it says what it
    // is rather than being a bare wall of JSON.
    const header = result.ok
      ? `Result for \`${coachId}\` — paste this back into the chat.`
      : `\`${coachId}\` was refused (${result.error?.code}). Paste this back so the coach can adapt.`;

    await this.options.clipboard.write(`${header}\n\n${block}`);
    this.setAwaiting("tool-result");
    this.options.log(`[clipboard] tool result for ${coachId} copied (ok=${String(result.ok)})`);
  }

  /**
   * Takes whatever the user brought back from the chat.
   *
   * A reply containing tool-call blocks continues the loop; a reply without
   * them is the answer.
   */
  async receiveReply(text: string): Promise<{ blocks: number; problems: ChatBlockProblem[] }> {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return { blocks: 0, problems: [{ index: 0, reason: "the clipboard was empty" }] };
    }

    const { prose, blocks, problems } = extractChatBlocks(trimmed);
    for (const problem of problems) {
      this.options.log(`[clipboard] block ${problem.index} ignored: ${problem.reason}`);
    }

    const calls = blocks.filter((block) => block.type === "tool.call");

    if (calls.length === 0) {
      this.setAwaiting(undefined);
      this.emit({ type: "coach.response", response: this.buildResponse(prose || trimmed, problems) });
      this.emit({ type: "provider.status", status: "ready" });
      return { blocks: 0, problems };
    }

    // One at a time: the loop is a conversation, and a burst of calls would
    // leave the user pasting several results in an order nobody defined.
    const first = calls[0];
    if (!first || first.type !== "tool.call") {
      return { blocks: 0, problems };
    }

    if (calls.length > 1) {
      this.options.log(`[clipboard] ${calls.length} calls in one reply; running the first only`);
    }

    const ourId = createId("tool");
    this.callIds.set(ourId, first.id);
    this.setAwaiting(undefined);

    const call: ToolCallRequest = {
      type: "tool.call",
      id: ourId,
      sessionId: this.session?.id ?? "clipboard",
      tool: first.tool,
      arguments: first.args ?? {},
    };
    if (this.pendingRequestId) {
      call.requestId = this.pendingRequestId;
    }

    this.emit(call);
    return { blocks: calls.length, problems };
  }

  onMessage(callback: (message: ProviderInboundMessage) => void): Disposable {
    this.listeners.add(callback);
    return { dispose: () => this.listeners.delete(callback) };
  }

  async cancelRequest(): Promise<void> {
    this.pendingRequestId = undefined;
    this.callIds.clear();
    this.setAwaiting(undefined);
  }

  async disconnect(): Promise<void> {
    this.listeners.clear();
    this.callIds.clear();
    this.setAwaiting(undefined);
    this.session = undefined;
  }

  private buildResponse(text: string, problems: ChatBlockProblem[]): CoachResponse {
    const notes =
      problems.length > 0
        ? `\n\n---\n${problems.length} block(s) in that reply could not be read: ` +
          problems.map((problem) => problem.reason).join("; ")
        : "";

    return {
      id: createId("res"),
      requestId: this.pendingRequestId ?? "unknown",
      sessionId: this.session?.id ?? "clipboard",
      createdAt: new Date().toISOString(),
      content: [{ type: "text", text: text + notes }],
      source: { adapterKind: "other", surfaceType: "clipboard" },
      completion: { state: "complete" },
    };
  }

  private emit(message: ProviderInboundMessage): void {
    for (const listener of this.listeners) {
      listener(message);
    }
  }

  private setAwaiting(kind: AwaitingKind | undefined): void {
    if (this.awaiting === kind) {
      return;
    }
    this.awaiting = kind;
    this.options.onAwaiting(kind);
  }
}
