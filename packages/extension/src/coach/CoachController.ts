import * as vscode from "vscode";

import {
  TERMINAL_REQUEST_STATES,
  toolFailure,
  type CoachProvider,
  type CoachRequest,
  type CoachResponse,
  type CoachSession,
  type ProviderInboundMessage,
  type RequestLifecycleState,
  type ResponseContentPart,
  type ToolCallRequest,
  type ToolCallResult,
} from "@dumbways/protocol";

import type { ContextEngine } from "../context/ContextEngine";
import type { SessionStore } from "../session/SessionStore";
import type { ExtensionState } from "../state/ExtensionState";
import type { ToolRegistry } from "../tools/ToolRegistry";
import { buildReceipt, type Destination } from "../context/receipt";
import { summarizeArgs, summarizeResult } from "../tools/summarize";

/** Spec §47: nothing waits forever. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Drives one request through its lifecycle (spec §25) and keeps the panel
 * honest about which step it is on (spec §0V).
 *
 * The controller knows nothing about *how* the provider is reached. In
 * Milestone A the provider is in-process; when the relay arrives, only the
 * provider implementation changes.
 */
export class CoachController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private pendingRequestId: string | undefined;
  private timeoutHandle: NodeJS.Timeout | undefined;
  private settleHandle: NodeJS.Timeout | undefined;
  private timeoutPaused = false;
  /** Aborts tools belonging to the request in flight (spec §46). */
  private abortController: AbortController | undefined;

  constructor(
    private readonly state: ExtensionState,
    private readonly sessions: SessionStore,
    private readonly contextEngine: ContextEngine,
    private provider: CoachProvider,
    private readonly tools: ToolRegistry,
    private readonly log: vscode.OutputChannel,
    /** Where this transport sends things, for the receipt (spec: transparency). */
    private readonly destination: () => { kind: Destination; relayPort?: number } = () => ({
      kind: "in-process",
    }),
    /**
     * Reduces context to what the far side does not already have.
     *
     * Applied here, before the receipt is built, and deliberately not in the
     * transport: if the payload were trimmed after the receipt, the receipt
     * would describe a message nobody sent. It is allowed to be wrong about
     * nothing at all, so the trimming has to happen upstream of it.
     */
    private readonly planContext: (request: CoachRequest) => CoachRequest = (request) => request,
    /** Which chat should answer, when the user has chosen one. */
    private readonly chosenModel: () => string | undefined = () => undefined,
  ) {}

  /**
   * Swaps the transport without restarting the window.
   *
   * Switching to the relay used to mean "change a setting, reload, lose the
   * conversation". Since every provider implements the same interface, the
   * controller can simply be handed a different one — the conversation, the
   * tools and the context engine are all unaffected.
   */
  /**
   * The transport in use, for the few callers that need its specific abilities.
   *
   * Opening a browser tab is not part of the CoachProvider contract, and it
   * should not be — a clipboard transport has no tabs. So the router asks for
   * the concrete provider and checks what it is, rather than every provider
   * growing a method most of them would have to refuse.
   */
  currentProvider(): CoachProvider {
    return this.provider;
  }

  async swapProvider(next: CoachProvider): Promise<void> {
    this.clearTimeout();
    this.pendingRequestId = undefined;
    this.sessions.setActiveRequest(undefined);
    this.state.setRequestState("IDLE");

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;

    try {
      await this.provider.disconnect();
    } catch (error) {
      this.log.appendLine(`[provider] old transport failed to close: ${describeError(error)}`);
    }

    this.log.appendLine(`[provider] switching to ${next.displayName}`);
    this.provider = next;
    await this.start();
  }

  async start(): Promise<void> {
    this.disposables.push(this.provider.onMessage((message) => this.handleInbound(message)));
    this.state.setHop("provider", "connecting");
    try {
      await this.provider.connect(this.sessions.current);
      this.state.setHop("provider", "ready");
      this.log.appendLine(`[provider] connected: ${this.provider.displayName}`);
    } catch (error) {
      this.state.setHop("provider", "error");
      this.log.appendLine(`[provider] connect failed: ${describeError(error)}`);
      this.sessions.appendMessage(
        "error",
        `The ${this.provider.displayName} provider failed to connect: ${describeError(error)}`,
      );
    }
  }

  isBusy(): boolean {
    return this.pendingRequestId !== undefined;
  }

  /**
   * Cancels the request in flight (spec §46).
   *
   * Three things have to happen, and only the first is obvious:
   *
   *  1. stop waiting, and forward the cancellation if the provider supports it;
   *  2. abort whatever tool is running, so a 30s command actually stops rather
   *     than finishing for an audience that has left;
   *  3. forget the request id, so a late answer is dropped by the existing
   *     correlation check instead of arriving after the user moved on.
   */
  async cancel(): Promise<void> {
    const requestId = this.pendingRequestId;
    if (!requestId) {
      return;
    }

    this.log.appendLine(`[request ${requestId}] cancelled by the user`);
    this.abortController?.abort();
    this.abortController = undefined;

    // Forgetting the id first means anything still in flight is already
    // uncorrelated by the time it lands.
    this.pendingRequestId = undefined;
    this.sessions.setActiveRequest(undefined);

    if (this.provider.cancelRequest) {
      try {
        await this.provider.cancelRequest(requestId);
      } catch (error) {
        this.log.appendLine(`[request ${requestId}] provider cancel failed: ${describeError(error)}`);
      }
    }

    this.sessions.appendMessage("system", "Cancelled. Any answer that arrives now is ignored.", {
      requestId,
    });
    this.finish("CANCELLED");
  }

  /**
   * Stops the request clock while something legitimately slow is happening —
   * in practice, while an approval dialog is waiting on a human (spec §17).
   *
   * Without this, deliberating for longer than the request timeout would time
   * out the request and then discard the answer the user just approved.
   */
  pauseTimeout(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
      this.timeoutPaused = true;
    }
  }

  resumeTimeout(): void {
    if (this.timeoutPaused) {
      this.timeoutPaused = false;
      if (this.pendingRequestId) {
        this.armTimeout(this.pendingRequestId);
      }
    }
  }

  /**
   * Starts a fresh session. Any in-flight request is abandoned: its response
   * will no longer correlate, so handleResponse drops it rather than dropping
   * it into the new conversation.
   */
  async resetSession(): Promise<CoachSession> {
    this.clearTimeout();
    this.pendingRequestId = undefined;
    this.state.setRequestState("IDLE");

    const session = this.sessions.newSession();
    await this.provider.connect(session);
    return session;
  }

  async send(message: string): Promise<void> {
    const text = message.trim();
    if (text.length === 0) {
      return;
    }

    if (this.pendingRequestId) {
      // Spec §0W: name the hop, do not say "something went wrong".
      this.sessions.appendMessage(
        "system",
        "Still working on your last message. Wait for it to land before sending another.",
      );
      return;
    }

    this.state.setRequestState("CAPTURING_CONTEXT");
    const attachments = this.state.getAttachments();
    const captured = this.contextEngine.buildRequest({
      sessionId: this.sessions.current.id,
      message: text,
      attachments,
    });
    const { notes } = captured;
    const model = this.chosenModel();
    const request = this.planContext(
      model ? { ...captured.request, model } : captured.request,
    );
    this.state.setRequestState("REQUEST_READY");

    const where = this.destination();
    this.sessions.appendMessage("user", text, {
      requestId: request.id,
      // Built from the request that is actually being sent, so the receipt
      // cannot describe something other than what left.
      receipt: buildReceipt(request, where.kind, where.relayPort),
    });
    for (const note of notes) {
      this.sessions.appendMessage("system", note, { requestId: request.id });
    }

    this.log.appendLine(
      `[request ${request.id}] captured ${request.contextItems.length} context items ` +
        `(active file: ${request.editor?.activeFile ?? "none"}, dirty: ${request.editor?.isDirty ?? false})`,
    );

    if (attachments.length > 0) {
      this.log.appendLine(
        `[request ${request.id}] ${attachments.length} attachment(s): ` +
          attachments.map((attachment) => `${attachment.filename} (${attachment.id})`).join(", "),
      );
      // Staged attachments belong to the message that was just sent, not to
      // the next one.
      this.state.clearAttachments();
    }

    this.pendingRequestId = request.id;
    this.abortController = new AbortController();
    this.sessions.setActiveRequest(request.id);
    this.armTimeout(request.id);

    try {
      this.state.setRequestState("SENDING");
      await this.provider.sendRequest(request);
      this.state.setRequestState("PROVIDER_PROCESSING");
    } catch (error) {
      this.finish("FAILED", `Could not deliver the request to ${this.provider.displayName}.`);
      this.sessions.appendMessage(
        "error",
        `Could not deliver the request to ${this.provider.displayName}: ${describeError(error)}`,
      );
      this.log.appendLine(`[request ${request.id}] send failed: ${describeError(error)}`);
    }
  }

  dispose(): void {
    this.clearTimeout();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    void this.provider.disconnect();
  }

  private handleInbound(message: ProviderInboundMessage): void {
    switch (message.type) {
      case "coach.response":
        this.handleResponse(message.response);
        return;

      case "tool.call":
        void this.handleToolCall(message);
        return;

      case "provider.status":
        this.state.setHop(
          "provider",
          message.status === "ready"
            ? "ready"
            : message.status === "busy" || message.status === "waiting-for-tool"
              ? "busy"
              : message.status === "error"
                ? "error"
                : message.status === "connecting"
                  ? "connecting"
                  : "disconnected",
        );
        return;

      case "provider.error":
        this.log.appendLine(`[provider] error: ${message.message}`);
        this.sessions.appendMessage("error", message.message);
        if (!message.requestId || message.requestId === this.pendingRequestId) {
          this.finish("FAILED", message.message);
        }
        return;
    }
  }

  /**
   * The agent loop (spec §0, §14).
   *
   * A tool call is only honoured while one of *our* requests is in flight, for
   * this session. A provider that asks for a file when nothing was asked of it
   * gets a typed refusal, not a file.
   */
  private async handleToolCall(call: ToolCallRequest): Promise<void> {
    const rejection = this.rejectToolCall(call);
    if (rejection) {
      this.log.appendLine(`[tool ${call.id}] rejected: ${rejection.error?.message ?? "unknown"}`);
      await this.deliverToolResult(rejection);
      return;
    }

    this.state.setRequestState("TOOL_REQUESTED");

    const argsSummary = summarizeArgs(call);
    const entry = this.sessions.appendMessage("tool", `${call.tool} ${argsSummary}`.trim(), {
      requestId: this.pendingRequestId ?? "",
      tool: {
        callId: call.id,
        tool: call.tool,
        argsSummary,
        status: "running",
      },
    });

    this.state.setRequestState("TOOL_RUNNING");
    const result = await this.tools.execute(call, this.abortController?.signal);

    this.sessions.updateMessage(entry.id, (message) => {
      if (message.tool) {
        message.tool.status = result.ok ? "ok" : "error";
        message.tool.durationMs = result.durationMs;
        message.tool.resultSummary = summarizeResult(result);
        if (result.error) {
          message.tool.errorCode = result.error.code;
        }
      }
    });

    // Tool activity is progress: the request has not stalled, so it should not
    // be timed out for the time the tool spent working.
    if (this.pendingRequestId) {
      this.armTimeout(this.pendingRequestId);
    }

    await this.deliverToolResult(result);
  }

  private rejectToolCall(call: ToolCallRequest): ToolCallResult | undefined {
    if (!this.pendingRequestId) {
      return toolFailure(
        call,
        "PERMISSION_DENIED",
        "No request is in flight. Tools can only be called while answering a request.",
      );
    }
    if (call.requestId !== undefined && call.requestId !== this.pendingRequestId) {
      return toolFailure(
        call,
        "PERMISSION_DENIED",
        "This tool call does not correlate to the request in flight.",
        { expected: this.pendingRequestId, received: call.requestId },
      );
    }
    if (call.sessionId !== this.sessions.current.id) {
      return toolFailure(call, "PERMISSION_DENIED", "This tool call is for a different session.");
    }
    return undefined;
  }

  private async deliverToolResult(result: ToolCallResult): Promise<void> {
    this.state.setRequestState("TOOL_RESULT_SENT");
    try {
      await this.provider.sendToolResult(result);
      this.state.setRequestState("PROVIDER_PROCESSING");
    } catch (error) {
      this.sessions.appendMessage(
        "error",
        `Could not return the tool result to ${this.provider.displayName}: ${describeError(error)}`,
      );
      this.finish("FAILED", "Tool result could not be delivered.");
    }
  }

  private handleResponse(response: CoachResponse): void {
    if (response.requestId !== this.pendingRequestId) {
      // Spec §46: a late or duplicate response is dropped, not rendered.
      this.log.appendLine(
        `[response ${response.id}] ignored: does not correlate to pending request ` +
          `(expected ${this.pendingRequestId ?? "none"}, got ${response.requestId})`,
      );
      return;
    }

    this.state.setRequestState("RESPONSE_RECEIVED");

    /*
     * A partial reply is shown and the request stays open.
     *
     * This is what makes text appear as the chat writes it instead of landing
     * as one block at the end — and, more importantly, it means a transport
     * that misjudges the end of a reply has already delivered what it had
     * rather than silently dropping the tail.
     */
    if (response.completion.state === "partial") {
      const text = flattenParts(response.content);
      if (text.length > 0) {
        this.sessions.replaceStreamingMessage(response.requestId, text);
      }
      // The request timeout is an inactivity timeout. A growing response is
      // proof that the provider is alive, so a long answer must not be failed
      // sixty seconds after it started while new tokens are still arriving.
      this.armTimeout(response.requestId);
      return;
    }

    if (response.completion.state !== "complete") {
      this.sessions.appendMessage(
        "error",
        `The reply did not finish: ${response.completion.state}${
          response.completion.reason ? ` — ${response.completion.reason}` : ""
        }`,
        { requestId: response.requestId },
      );
      this.finish(response.completion.state === "cancelled" ? "CANCELLED" : "FAILED");
      return;
    }

    /*
     * Say so when a different chat answered than the one that was asked.
     *
     * The reply carries the surface it came from, and until now nothing
     * compared it with the surface that was chosen — so a misroute produced a
     * perfectly ordinary-looking answer from the wrong model. An answer you
     * cannot attribute is worse than an error, because you act on it.
     */
    const chosen = this.chosenModel();
    const answered = response.source?.surfaceType;
    if (chosen && answered && answered !== chosen && answered !== "unknown") {
      this.sessions.appendMessage(
        "error",
        `That answer came from ${answered}, not ${chosen}. Pick the chat again before trusting it.`,
        { requestId: response.requestId },
      );
    }

    /*
     * The finished reply *replaces* the streaming one, rather than joining it.
     *
     * Partials were written into a streaming message and the completion then
     * appended a second one, so every streamed answer appeared twice — once as
     * the run-on `textContent` the poll reads, and again as the laid-out
     * `innerText` read at the end. Two copies of the same answer, the first one
     * worse, on every single turn.
     */
    this.sessions.replaceStreamingMessage(
      response.requestId,
      flattenParts(response.content),
      response.content,
    );

    this.log.appendLine(
      `[response ${response.id}] delivered for request ${response.requestId} ` +
        `(${response.content.length} content parts)`,
    );
    this.finish("DELIVERED");
  }

  private armTimeout(requestId: string): void {
    this.clearTimeout();
    this.timeoutHandle = setTimeout(() => {
      if (this.pendingRequestId !== requestId) {
        return;
      }
      this.sessions.appendMessage(
        "error",
        `No response from ${this.provider.displayName} after ${REQUEST_TIMEOUT_MS / 1000}s. The request was abandoned.`,
        { requestId },
      );
      this.finish("TIMED_OUT", "Provider did not respond in time.");
    }, REQUEST_TIMEOUT_MS);
  }

  private clearTimeout(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
    if (this.settleHandle) {
      clearTimeout(this.settleHandle);
      this.settleHandle = undefined;
    }
  }

  private finish(state: RequestLifecycleState, error?: string): void {
    this.clearTimeout();
    this.abortController = undefined;
    this.pendingRequestId = undefined;
    this.sessions.setActiveRequest(undefined);
    this.state.setRequestState(state, error);

    if (TERMINAL_REQUEST_STATES.includes(state)) {
      // Settle back to IDLE so the panel does not sit on a stale final state.
      this.settleHandle = setTimeout(() => {
        this.settleHandle = undefined;
        if (!this.pendingRequestId) {
          this.state.setRequestState("IDLE");
        }
      }, 1_200);
      this.settleHandle.unref?.();
    }
  }
}

function flattenParts(parts: ResponseContentPart[]): string {
  return parts
    .map((part) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "code":
          return `\`\`\`${part.language ?? ""}\n${part.code}\n\`\`\``;
        case "attachment":
          return `[attachment: ${part.attachment.filename}]`;
      }
    })
    .join("\n\n");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
