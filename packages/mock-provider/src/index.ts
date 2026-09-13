import {
  createId,
  createResponseId,
  type CoachProvider,
  type CoachRequest,
  type CoachResponse,
  type CoachSession,
  type Disposable,
  type ProviderInboundMessage,
  type ResponseContentPart,
  type ToolCallRequest,
  type ToolCallResult,
} from "@dumbways/protocol";

import { describeRequest, describeToolOutcome, findSelection } from "./describe";
import { planToolCalls, type PlannedCall } from "./plan";

export * from "./describe";
export * from "./plan";

/**
 * Builds the direct (no-tool) response. Pure and synchronous so it can be
 * tested without any provider plumbing.
 */
export function buildMockResponse(request: CoachRequest): CoachResponse {
  const content: ResponseContentPart[] = [{ type: "text", text: describeRequest(request) }];

  // Echo the selection back as a *code* part rather than folding it into the
  // text. The protocol is multi-part (spec §0N) and the first provider should
  // exercise that or it will quietly rot.
  const selection = findSelection(request);
  if (selection) {
    content.push({
      type: "code",
      language: selection.language,
      code: selection.content,
    });
  }

  return finishResponse(request, content);
}

/** The response after an agent loop: what was asked, what came back. */
export function buildToolLoopResponse(
  request: CoachRequest,
  outcomes: { tool: string; result: ToolCallResult }[],
): CoachResponse {
  const lines: string[] = [
    "MOCK: I received your message and asked the bridge for more context.",
    "",
  ];

  for (const outcome of outcomes) {
    lines.push(describeToolOutcome(outcome.tool, outcome.result));
  }

  lines.push("");
  lines.push(
    `That is the agent loop: your message → ${outcomes.length} tool call(s) → tool result(s) → this response.`,
  );

  return finishResponse(request, [{ type: "text", text: lines.join("\n") }]);
}

function finishResponse(request: CoachRequest, content: ResponseContentPart[]): CoachResponse {
  return {
    id: createResponseId(),
    requestId: request.id,
    sessionId: request.sessionId,
    createdAt: new Date().toISOString(),
    content,
    source: { adapterKind: "mock" },
    completion: { state: "complete" },
  };
}

export interface MockProviderOptions {
  /** Simulated think time, so the UI's lifecycle states are actually visible. */
  latencyMs?: number;
}

interface Exchange {
  request: CoachRequest;
  remaining: PlannedCall[];
  outcomes: { tool: string; result: ToolCallResult }[];
  /** Tool call currently awaiting a result. */
  inFlight?: { callId: string; tool: string };
}

/**
 * In-process mock provider (spec §20, §52).
 *
 * Proves the architecture end to end before any external system is involved.
 * It never touches the filesystem, the network, or vscode — when it wants a
 * file it must ask the bridge, exactly like a real coach would.
 */
export class MockCoachProvider implements CoachProvider {
  readonly id = "mock";
  readonly displayName = "Mock (in-process)";

  private readonly latencyMs: number;
  private readonly listeners = new Set<(message: ProviderInboundMessage) => void>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly exchanges = new Map<string, Exchange>();
  private session: CoachSession | undefined;

  constructor(options: MockProviderOptions = {}) {
    this.latencyMs = options.latencyMs ?? 250;
  }

  async connect(session: CoachSession): Promise<void> {
    this.session = session;
    this.exchanges.clear();
    this.emit({ type: "provider.status", status: "ready", message: "Mock provider ready." });
  }

  async sendRequest(request: CoachRequest): Promise<void> {
    if (!this.session) {
      this.emit({
        type: "provider.error",
        message: "Mock provider received a request before connect().",
        requestId: request.id,
      });
      return;
    }

    this.emit({ type: "provider.status", status: "busy" });

    const planned = planToolCalls(request);
    if (planned.length === 0) {
      this.after(() => {
        this.emit({ type: "coach.response", response: buildMockResponse(request) });
        this.emit({ type: "provider.status", status: "ready" });
      });
      return;
    }

    const exchange: Exchange = { request, remaining: [...planned], outcomes: [] };
    this.exchanges.set(request.id, exchange);
    this.after(() => this.issueNextCall(exchange));
  }

  async sendToolResult(result: ToolCallResult): Promise<void> {
    const exchange = [...this.exchanges.values()].find(
      (candidate) => candidate.inFlight?.callId === result.id,
    );

    if (!exchange || !exchange.inFlight) {
      // Spec §84: a stray or duplicate result must not advance the loop.
      return;
    }

    exchange.outcomes.push({ tool: exchange.inFlight.tool, result });
    delete exchange.inFlight;

    this.after(() => {
      if (exchange.remaining.length > 0) {
        this.issueNextCall(exchange);
        return;
      }

      this.exchanges.delete(exchange.request.id);
      this.emit({
        type: "coach.response",
        response: buildToolLoopResponse(exchange.request, exchange.outcomes),
      });
      this.emit({ type: "provider.status", status: "ready" });
    });
  }

  onMessage(callback: (message: ProviderInboundMessage) => void): Disposable {
    this.listeners.add(callback);
    return { dispose: () => this.listeners.delete(callback) };
  }

  async disconnect(): Promise<void> {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.listeners.clear();
    this.exchanges.clear();
    this.session = undefined;
  }

  private issueNextCall(exchange: Exchange): void {
    const next = exchange.remaining.shift();
    if (!next) {
      return;
    }

    const call: ToolCallRequest = {
      type: "tool.call",
      id: createId("tool"),
      sessionId: exchange.request.sessionId,
      requestId: exchange.request.id,
      tool: next.tool,
      arguments: next.arguments,
    };

    exchange.inFlight = { callId: call.id, tool: call.tool };
    this.emit({ type: "provider.status", status: "waiting-for-tool" });
    this.emit(call);
  }

  private after(action: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      action();
    }, this.latencyMs);
    this.timers.add(timer);
    timer.unref?.();
  }

  private emit(message: ProviderInboundMessage): void {
    for (const listener of this.listeners) {
      listener(message);
    }
  }
}
