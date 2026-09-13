import { createId } from "./ids";

/**
 * Making a chat tab look like an OpenAI model.
 *
 * Coding harnesses (Codex, OpenCode, Aider) all speak one dialect:
 * `POST /v1/chat/completions`. Point one at a server that speaks it and the
 * harness cannot tell what is behind it — which is the whole idea here. The
 * intelligence is the tab the user already pays for; the harness supplies the
 * loop that reads files, runs commands and checks results.
 *
 * This module is the translation, both directions, and it is pure so it can be
 * tested without a browser or a socket:
 *
 *   harness JSON  --renderForChat-->  text a person could have typed
 *   tab's prose   --parseFromChat-->  harness JSON, tool calls and all
 *
 * The return trip is the risky half. A harness is strict about the shape of
 * `tool_calls`, and a chat window can only produce prose, so the tab is taught
 * to emit fenced JSON and that fence is parsed back into structure.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCallPayload[];
}

export interface ToolCallPayload {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface CompletionsRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: Array<{
    type: "function";
    function: { name: string; description?: string; parameters?: unknown };
  }>;
  stream?: boolean;
}

/** The fence the tab is told to use. Distinct from the panel's `dwtd`. */
export const CALL_FENCE = "tool";

/* ------------------------------------------------------------------ *
 * Outbound: harness -> tab
 * ------------------------------------------------------------------ */

/**
 * The system prompt that turns a chat into a harness backend.
 *
 * A chat window has no idea it is being driven by an agent loop. Left
 * untold it answers conversationally, offers to help, and asks follow-up
 * questions — none of which a harness can parse. So it is told plainly what
 * it now is, and given exactly one output format.
 */
export function harnessPrimer(tools: CompletionsRequest["tools"]): string {
  const lines = [
    "You are the model inside an agent harness. A program is calling you, not a person.",
    "",
    "It will give you a task and the results of actions it took for you. Reply with",
    "your reasoning in plain prose. When you want the program to do something, end",
    "your reply with one fenced block and nothing after it:",
    "",
    "```" + CALL_FENCE,
    '{ "name": "<tool>", "arguments": { } }',
    "```",
    "",
    "Rules that the program depends on:",
    "",
    "- one block per reply, always last, always closed;",
    '- `arguments` is a JSON object, never a string;',
    "- ask for one thing, then wait — the result comes back as the next message;",
    "- when the task is done, reply with prose and no block at all;",
    "- never invent a tool, and never apologise for a refusal: read it and adapt.",
  ];

  if (tools && tools.length > 0) {
    lines.push("", "Tools:", "");
    for (const tool of tools) {
      const description = tool.function.description ?? "";
      lines.push(`- \`${tool.function.name}\` — ${description}`);
      if (tool.function.parameters) {
        lines.push(`  arguments: ${JSON.stringify(tool.function.parameters)}`);
      }
    }
  } else {
    lines.push("", "No tools are available; answer in prose.");
  }

  return lines.join("\n");
}

/**
 * Renders messages as one block of text for the tab.
 *
 * Only ever called with the messages a given tab has not already been shown.
 * A harness resends its entire transcript on every call — it is stateless by
 * design — while the tab is stateful and still has the earlier turns on
 * screen. Replaying everything would exhaust the window in a handful of
 * steps, so the caller passes the delta and this renders exactly that.
 */
export function renderForChat(messages: ChatMessage[]): string {
  const parts: string[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      parts.push(message.content ?? "");
      continue;
    }

    if (message.role === "user") {
      parts.push(message.content ?? "");
      continue;
    }

    if (message.role === "tool") {
      // The harness's answer to something the tab asked for. Labelled so the
      // tab can tell a result from a new instruction.
      parts.push(
        [
          `Result of \`${message.name ?? "tool"}\`:`,
          "",
          "```json",
          (message.content ?? "").slice(0, 20_000),
          "```",
        ].join("\n"),
      );
      continue;
    }

    // An assistant turn in the delta means the tab has not seen its own reply
    // — which happens after a reconnect. Echoing it keeps the thread coherent.
    if (message.content) {
      parts.push(message.content);
    }
  }

  return parts.filter((part) => part.trim().length > 0).join("\n\n---\n\n");
}

/* ------------------------------------------------------------------ *
 * Inbound: tab -> harness
 * ------------------------------------------------------------------ */

const FENCE = new RegExp(
  `(\`{3,})[ \\t]*(?:${CALL_FENCE}|json|tool_call)?[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*\\1`,
  "g",
);

export interface ParsedReply {
  content: string;
  toolCalls: ToolCallPayload[];
}

/**
 * Pulls structure out of prose. Never throws.
 *
 * A model that is having a bad day writes three blocks, or forgets the fence,
 * or wraps the JSON in commentary. None of that may crash a harness mid-run,
 * so anything unparseable is simply left as prose — the harness then sees a
 * plain answer, which is a recoverable state, rather than a 500.
 */
export function parseFromChat(text: string): ParsedReply {
  const toolCalls: ToolCallPayload[] = [];
  let content = text;

  for (const match of text.matchAll(FENCE)) {
    const body = match[2];
    if (!body) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }

    if (typeof parsed !== "object" || parsed === null) {
      continue;
    }

    const record = parsed as { name?: unknown; arguments?: unknown; tool?: unknown };
    const name = typeof record.name === "string" ? record.name : record.tool;
    if (typeof name !== "string" || name.length === 0) {
      continue;
    }

    /*
     * `arguments` is a JSON *string* in OpenAI's schema, not an object.
     * Harnesses call JSON.parse on it, so an object here would throw inside
     * code we do not control.
     */
    const args =
      typeof record.arguments === "string"
        ? record.arguments
        : JSON.stringify(record.arguments ?? {});

    toolCalls.push({
      id: `call_${createId("x").slice(2, 14)}`,
      type: "function",
      function: { name, arguments: args },
    });

    content = content.replace(match[0], "");
  }

  return { content: content.trim(), toolCalls };
}

/** Wraps a parsed reply in the response body a harness expects. */
export function toCompletionsResponse(
  reply: ParsedReply,
  model: string,
): Record<string, unknown> {
  const message: ChatMessage = { role: "assistant", content: reply.content || null };
  if (reply.toolCalls.length > 0) {
    message.tool_calls = reply.toolCalls;
  }

  return {
    id: `chatcmpl_${createId("x").slice(2, 14)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: reply.toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    // Harnesses read these for budgeting. A chat tab reports no counts, so
    // rather than inventing numbers these are zeroed — a visible "unknown"
    // beats a plausible lie that a budget is then computed from.
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/* ------------------------------------------------------------------ *
 * Streaming
 * ------------------------------------------------------------------ */

/**
 * The same answer, as the chunks a harness expects on an SSE stream.
 *
 * Codex and OpenCode require `stream: true` and will not run without it. The
 * reply is not streamed from the tab in real time — it is read once the tab
 * has settled — so this splits a finished answer into the shape a streaming
 * client parses.
 *
 * That is a real limitation, not a hidden one: the user waits the same amount
 * of time, they just see it arrive at the end. What it buys is compatibility,
 * and the alternative is those harnesses refusing to start at all.
 */
export function toStreamChunks(reply: ParsedReply, model: string): string[] {
  const id = `chatcmpl_${createId("x").slice(2, 14)}`;
  const created = Math.floor(Date.now() / 1000);

  const frame = (delta: Record<string, unknown>, finish: string | null): string =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;

  const chunks: string[] = [frame({ role: "assistant" }, null)];

  if (reply.content) {
    // Split on whitespace boundaries so a client rendering progressively does
    // not show words being cut in half.
    for (const piece of reply.content.match(/\S+\s*/g) ?? [reply.content]) {
      chunks.push(frame({ content: piece }, null));
    }
  }

  reply.toolCalls.forEach((call, index) => {
    chunks.push(
      frame(
        {
          tool_calls: [
            {
              index,
              id: call.id,
              type: "function",
              function: { name: call.function.name, arguments: call.function.arguments },
            },
          ],
        },
        null,
      ),
    );
  });

  chunks.push(frame({}, reply.toolCalls.length > 0 ? "tool_calls" : "stop"));
  chunks.push("data: [DONE]\n\n");

  return chunks;
}

/* ------------------------------------------------------------------ *
 * The delta
 * ------------------------------------------------------------------ */

/**
 * Which messages this tab has not been shown yet.
 *
 * The harness sends the whole transcript every time; the tab already has all
 * but the tail of it. Comparing by count is enough because a harness only
 * ever appends — and if it ever does not, a mismatch means a new conversation,
 * so the whole thing is sent again rather than a confusing fragment.
 */
export function messagesToSend(all: ChatMessage[], alreadySent: number): ChatMessage[] {
  if (alreadySent <= 0 || alreadySent > all.length) {
    return all;
  }
  return all.slice(alreadySent);
}
