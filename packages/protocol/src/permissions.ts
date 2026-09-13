/**
 * Permission model (spec §16, §17, §78).
 *
 * Milestone A ships no tools, so nothing consumes these at runtime yet.
 * They live here because the permission class of a tool is part of the
 * protocol contract, not an implementation detail of whoever runs the tool.
 */

export type PermissionClass = "read" | "execute" | "write" | "destructive";

export type PermissionMode =
  | "ask-every-time"
  | "allow-read"
  | "allow-safe"
  | "custom";

export type PermissionDecision = "allow" | "ask" | "deny";

export type LearningMode = "strict-coach" | "guided" | "normal-agent";

export interface SessionPermissions {
  mode: PermissionMode;
  learningMode: LearningMode;
  byClass: Record<PermissionClass, PermissionDecision>;
}

/**
 * Project default is strict-coach (spec §78): read freely, ask before
 * running anything, never write.
 */
export const STRICT_COACH_PERMISSIONS: SessionPermissions = {
  mode: "allow-read",
  learningMode: "strict-coach",
  byClass: {
    read: "allow",
    execute: "ask",
    write: "deny",
    destructive: "deny",
  },
};

export interface CoachingMetadata {
  mode: LearningMode;
  rules?: string[];
  currentMicroSkill?: string;
  requirePredictionBeforeRun?: boolean;
  requireUserAttemptBeforeWrite?: boolean;
}
