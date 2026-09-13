import { ProtocolViolation } from "./errors";
import { PROTOCOL_VERSION, type Envelope } from "./messages";
import { createMessageId } from "./ids";

/**
 * Runtime validation (spec §71: "TypeScript types disappear at runtime").
 *
 * Milestone A is in-process, so these are not load-bearing yet. They are
 * written and tested now because the moment a socket exists, everything
 * arriving on it is untrusted input (spec §75).
 */

export function createEnvelope<T>(sessionId: string, payload: T): Envelope<T> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    id: createMessageId(),
    timestamp: new Date().toISOString(),
    sessionId,
    payload,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses an unknown value as an envelope, or throws ProtocolViolation.
 *
 * Deliberately does NOT validate the payload — the payload's own validator
 * owns that. This checks only the transport contract.
 */
export function parseEnvelope(value: unknown): Envelope<unknown> {
  if (!isRecord(value)) {
    throw new ProtocolViolation("MALFORMED_ENVELOPE", "Envelope must be an object.");
  }

  const { protocolVersion, id, timestamp, sessionId } = value;

  if (protocolVersion !== PROTOCOL_VERSION) {
    // Spec §49: reject clearly, do not guess.
    throw new ProtocolViolation(
      "UNSUPPORTED_PROTOCOL_VERSION",
      `Unsupported protocol version. Expected ${PROTOCOL_VERSION}, received ${String(protocolVersion)}.`,
      { expected: PROTOCOL_VERSION, received: protocolVersion },
    );
  }

  for (const [field, fieldValue] of Object.entries({ id, timestamp, sessionId })) {
    if (typeof fieldValue !== "string" || fieldValue.length === 0) {
      throw new ProtocolViolation(
        "MALFORMED_ENVELOPE",
        `Envelope field "${field}" must be a non-empty string.`,
        { field },
      );
    }
  }

  if (!("payload" in value)) {
    throw new ProtocolViolation("MALFORMED_ENVELOPE", 'Envelope is missing "payload".');
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    id: id as string,
    timestamp: timestamp as string,
    sessionId: sessionId as string,
    payload: value["payload"],
  };
}
