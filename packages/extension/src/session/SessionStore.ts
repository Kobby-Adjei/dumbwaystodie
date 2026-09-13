import * as vscode from "vscode";

import {
  createMessageId,
  createSessionId,
  STRICT_COACH_PERMISSIONS,
  type CoachSession,
  type SessionMessage,
  type SessionMessageRole,
  type WorkspaceRootRef,
} from "@dumbways/protocol";

import { belongsToWorkspace, boundMessages } from "./persistence";

/**
 * Session state (spec §6).
 *
 * Persisted in the editor's own workspace storage, not in the user's repo —
 * a conversation is not a project artefact and writing one into `.coach/`
 * would put it in front of `git status`.
 *
 * Why it is persisted at all: reloading the window is something people do
 * constantly, and losing the whole conversation each time made the panel feel
 * disposable. The context ledger keyed off the session id too, so a reload
 * also silently re-sent every file the chat already had.
 */
/** Where a conversation is kept. An interface so tests need no extension host. */
export interface SessionStorage {
  read(): CoachSession | undefined;
  write(session: CoachSession): void;
}

export class SessionStore implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<CoachSession>();
  readonly onDidChange = this.changeEmitter.event;

  private session: CoachSession;

  constructor(
    private readonly getWorkspaceRoots: () => WorkspaceRootRef[],
    private readonly storage?: SessionStorage,
  ) {
    this.session = this.restore() ?? this.createSession();
  }

  /**
   * The last conversation, if it is still about this workspace.
   *
   * A session restored into a different project would describe files that are
   * not there, so the roots have to match — better a fresh session than a
   * confusing one.
   */
  private restore(): CoachSession | undefined {
    const saved = this.storage?.read();
    if (!saved) {
      return undefined;
    }

    return belongsToWorkspace(saved, this.getWorkspaceRoots()) ? saved : undefined;
  }

  private persist(): void {
    // Bounded: a conversation that grows without limit becomes a startup cost.
    this.storage?.write({ ...this.session, messages: boundMessages(this.session.messages) });
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  get current(): CoachSession {
    return this.session;
  }

  newSession(): CoachSession {
    this.session = this.createSession();
    this.persist();
    this.changeEmitter.fire(this.session);
    return this.session;
  }

  /**
   * Shows a reply that is still arriving, replacing what is there.
   *
   * One message per request rather than one per update: appending each partial
   * would fill the panel with progressively longer copies of the same answer.
   * The id is reused so the renderer updates in place and the user's scroll
   * position survives.
   */
  replaceStreamingMessage(
    requestId: string,
    text: string,
    /** Structured content, once the reply is finished and there is some. */
    parts?: SessionMessage["parts"],
  ): SessionMessage {
    const existing = this.session.messages.find(
      (message) => message.role === "coach" && message.requestId === requestId,
    );

    if (!existing) {
      return this.appendMessage("coach", text, { requestId, ...(parts ? { parts } : {}) });
    }

    existing.text = text;
    if (parts) {
      existing.parts = parts;
    }
    this.session.updatedAt = new Date().toISOString();
    this.persist();
    this.changeEmitter.fire(this.session);
    return existing;
  }

  appendMessage(
    role: SessionMessageRole,
    text: string,
    extra: Partial<Pick<SessionMessage, "parts" | "requestId" | "tool" | "receipt">> = {},
  ): SessionMessage {
    const message: SessionMessage = {
      id: createMessageId(),
      role,
      createdAt: new Date().toISOString(),
      text,
    };
    if (extra.parts) {
      message.parts = extra.parts;
    }
    if (extra.requestId) {
      message.requestId = extra.requestId;
    }
    if (extra.tool) {
      message.tool = extra.tool;
    }
    if (extra.receipt) {
      message.receipt = extra.receipt;
    }

    this.session.messages.push(message);
    this.session.updatedAt = message.createdAt;
    this.persist();
    this.changeEmitter.fire(this.session);
    return message;
  }

  /**
   * In-place update, used when a tool call that is already on screen finishes.
   * The alternative — appending a second entry for the result — would make the
   * conversation twice as long and half as readable.
   */
  updateMessage(id: string, mutate: (message: SessionMessage) => void): void {
    const message = this.session.messages.find((candidate) => candidate.id === id);
    if (!message) {
      return;
    }
    mutate(message);
    this.session.updatedAt = new Date().toISOString();
    this.persist();
    this.changeEmitter.fire(this.session);
  }

  setActiveRequest(requestId: string | undefined): void {
    if (requestId === undefined) {
      delete this.session.activeRequestId;
    } else {
      this.session.activeRequestId = requestId;
    }
    this.persist();
    this.changeEmitter.fire(this.session);
  }

  private createSession(): CoachSession {
    const roots = this.getWorkspaceRoots();
    const now = new Date().toISOString();
    return {
      id: createSessionId(),
      name: roots[0]?.name ?? "Dumb Ways to Die",
      createdAt: now,
      updatedAt: now,
      workspaceRoots: roots,
      messages: [],
      permissions: STRICT_COACH_PERMISSIONS,
    };
  }
}
