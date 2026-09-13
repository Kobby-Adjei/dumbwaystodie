import { TOOL_NAMES, type CoachRequest } from "@dumbways/protocol";

/**
 * The fake tool-agent (spec §52).
 *
 * Keyword rules, not intelligence — that is the point. It makes the full agent
 * loop reproducible without a model, so a failure in the loop is unambiguous.
 *
 * Two rules it must obey, because a real provider must obey them too:
 *  - never plan a tool the request did not advertise as available;
 *  - never plan a tool the bridge says it lacks the capability for.
 */

export interface PlannedCall {
  tool: string;
  arguments: unknown;
}

const READ_FILE_PATTERN = /\b(?:read|open|show)\s+([\w./@-]+\.[a-z0-9]+)\b/i;

/**
 * "look" is deliberately absent: "look at the file" is not a search request,
 * and treating it as one sends the bridge hunting for the word "at".
 */
const SEARCH_VERB = /\b(?:search|grep|find)\b/i;

/** Words that describe *how* to search, not *what* to search for. */
const MODIFIER = /^(?:regex|regexp|pattern|whole|exact|word|words|case|sensitive|for)$/i;

export function extractSearchQuery(message: string): string | undefined {
  const verbMatch = SEARCH_VERB.exec(message);
  if (!verbMatch?.[0]) {
    return undefined;
  }
  const verb = verbMatch[0].toLowerCase();

  // Walk past "for", "regex", "whole word" etc. to where the term begins.
  const words = message
    .slice(verbMatch.index + verbMatch[0].length)
    .trim()
    .split(/\s+/);
  let index = 0;
  while (index < words.length && MODIFIER.test(words[index] ?? "")) {
    index += 1;
  }
  const rest = words.slice(index).join(" ");
  if (rest.length === 0) {
    return undefined;
  }

  // A quote only delimits the term when it *opens* it. Searching for
  // `fetch('/api')` must not be mistaken for searching for `/api`.
  const quote = rest[0];
  if (quote === '"' || quote === "'" || quote === "`") {
    const close = rest.indexOf(quote, 1);
    return close > 1 ? rest.slice(1, close) : undefined;
  }

  // An unquoted term is only trusted after an unambiguous verb: "find the bug"
  // is a request for help, not a request to search for "the".
  if (verb === "find") {
    return undefined;
  }

  // Strip sentence punctuation, but nothing that could belong to a code
  // search — "fetch(" must survive intact.
  const term = (words[index] ?? "").replace(/[.,;:!?]+$/, "");
  return term.length > 0 ? term : undefined;
}

export function planToolCalls(request: CoachRequest): PlannedCall[] {
  const message = request.message.toLowerCase();
  const capabilities = request.clientCapabilities;
  const available = new Set((request.availableTools ?? []).map((tool) => tool.name));
  const planned: PlannedCall[] = [];

  const canUse = (tool: string, capable: boolean): boolean => capable && available.has(tool);

  // "run <command>" only at the start of the message. "why does this run
  // slowly" is not a request to execute anything.
  const runMatch = /^\s*run\s+(?:the\s+command\s+)?(.+?)\s*$/i.exec(request.message);
  if (runMatch?.[1] && canUse(TOOL_NAMES.runCommand, capabilities.runCommand)) {
    const command = runMatch[1].replace(/^["'`]|["'`]$/g, "");
    if (command.length > 0) {
      planned.push({ tool: TOOL_NAMES.runCommand, arguments: { command } });
      // A command request stands alone: bundling a read alongside it would
      // make the approval dialog ambiguous about what is being approved.
      return planned;
    }
  }

  const searchQuery = extractSearchQuery(request.message);
  if (searchQuery && canUse(TOOL_NAMES.search, capabilities.searchFiles)) {
    // A real provider would decide this from intent. The mock takes an explicit
    // cue, so both code paths are reachable from the panel.
    const wantsRegex = /\b(regex|regexp|pattern)\b/.test(message);
    const wantsWholeWord = /\b(whole word|exact word|word boundary)\b/.test(message);

    const args: Record<string, unknown> = { query: searchQuery };
    if (wantsRegex) {
      args["isRegex"] = true;
    }
    if (wantsWholeWord) {
      args["wholeWord"] = true;
    }
    planned.push({ tool: TOOL_NAMES.search, arguments: args });
  }

  if (
    /\b(tree|structure|layout|project files|what files are|how is .* organi[sz]ed)\b/.test(message) &&
    canUse(TOOL_NAMES.projectTree, capabilities.projectTree)
  ) {
    planned.push({ tool: TOOL_NAMES.projectTree, arguments: {} });
  }

  const explicitFile = READ_FILE_PATTERN.exec(request.message);
  if (explicitFile?.[1] && canUse(TOOL_NAMES.readFile, capabilities.readFile)) {
    planned.push({ tool: TOOL_NAMES.readFile, arguments: { path: explicitFile[1] } });
  } else if (
    /\b(show|read|see|look at)\b.*\b(file|document|code|buffer)\b|active file|what am i looking at/.test(
      message,
    ) &&
    canUse(TOOL_NAMES.activeDocument, capabilities.readActiveDocument)
  ) {
    planned.push({ tool: TOOL_NAMES.activeDocument, arguments: {} });
  }

  if (
    /\b(diagnostic|diagnostics|error|errors|problem|problems|squiggle)\b/.test(message) &&
    canUse(TOOL_NAMES.diagnostics, capabilities.readDiagnostics)
  ) {
    planned.push({ tool: TOOL_NAMES.diagnostics, arguments: {} });
  }

  // Only when a tree was not already planned: the tree is a superset, and
  // asking for both makes the bridge do the same walk twice.
  const plannedTree = planned.some((call) => call.tool === TOOL_NAMES.projectTree);
  if (
    !plannedTree &&
    /\b(list|directory|folder)\b/.test(message) &&
    canUse(TOOL_NAMES.listDirectory, capabilities.listDirectory)
  ) {
    planned.push({ tool: TOOL_NAMES.listDirectory, arguments: { path: "." } });
  }

  return planned;
}
