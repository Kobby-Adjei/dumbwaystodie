import * as vscode from "vscode";

import type {
  AttachmentRef,
  AvailableSurface,
  ConnectionSnapshot,
  HopState,
  RequestLifecycleState,
} from "@dumbways/protocol";

/**
 * Connection and request state (spec §0I, §25).
 *
 * Every hop is tracked separately and on purpose. Collapsing them into one
 * "Connected" light makes a bridge impossible to debug, and Milestone A has
 * hops that genuinely do not exist yet — those report "not-implemented"
 * rather than borrowing a green dot from the hop next door.
 */
export class ExtensionState implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  private connections: ConnectionSnapshot = {
    editor: "connected",
    provider: "disconnected",
    relay: "not-implemented",
    browser: "not-implemented",
    chatSurface: "not-implemented",
    providerName: "Mock (in-process)",
  };

  private requestState: RequestLifecycleState = "IDLE";
  private lastError: string | undefined;
  /** Attachments staged for the next request, not yet sent. */
  private attachments: AttachmentRef[] = [];
  /** Set while the clipboard transport is waiting on the user (spec §0G). */
  private awaitingPaste: string | undefined;

  dispose(): void {
    this.changeEmitter.dispose();
  }

  getConnections(): ConnectionSnapshot {
    return { ...this.connections };
  }

  getRequestState(): RequestLifecycleState {
    return this.requestState;
  }

  getLastError(): string | undefined {
    return this.lastError;
  }

  getAwaitingPaste(): string | undefined {
    return this.awaitingPaste;
  }

  setAwaitingPaste(kind: string | undefined): void {
    if (this.awaitingPaste === kind) {
      return;
    }
    this.awaitingPaste = kind;
    this.changeEmitter.fire();
  }

  getAttachments(): AttachmentRef[] {
    return [...this.attachments];
  }

  addAttachment(attachment: AttachmentRef): void {
    // Re-attaching the same file is a no-op rather than a duplicate chip: the
    // registry already deduplicates by hash, so the ids match.
    if (this.attachments.some((existing) => existing.id === attachment.id)) {
      return;
    }
    this.attachments = [...this.attachments, attachment];
    this.changeEmitter.fire();
  }

  removeAttachment(id: string): void {
    const next = this.attachments.filter((attachment) => attachment.id !== id);
    if (next.length !== this.attachments.length) {
      this.attachments = next;
      this.changeEmitter.fire();
    }
  }

  clearAttachments(): void {
    if (this.attachments.length > 0) {
      this.attachments = [];
      this.changeEmitter.fire();
    }
  }

  setProviderName(name: string): void {
    if (this.connections.providerName === name) {
      return;
    }
    this.connections = { ...this.connections, providerName: name };
    this.changeEmitter.fire();
  }

  /**
   * The chats available to answer, and which one is chosen.
   *
   * The router lives here rather than in a transport because it is a user
   * decision, not a connection detail — and because the panel, the harness
   * endpoint and any future surface all have to agree on it.
   */
  private surfaces: AvailableSurface[] = [];
  private chosenModel: string | undefined;

  setSurfaces(surfaces: AvailableSurface[]): void {
    const before = JSON.stringify(this.surfaces);
    this.surfaces = surfaces;

    // Selection is a promise that this chat can answer now.  Closed, lost and
    // policy-blocked records remain in the list so the UI can explain them,
    // but none may remain selected: naming one on a request would manufacture
    // the exact "selected but not connected" state the router exists to avoid.
    if (
      this.chosenModel &&
      !surfaces.some(
        (entry) => entry.id === this.chosenModel && entry.status === "ready",
      )
    ) {
      this.chosenModel = undefined;
    }

    if (before !== JSON.stringify(this.surfaces)) {
      this.changeEmitter.fire();
    }
  }

  getSurfaces(): AvailableSurface[] {
    return this.surfaces;
  }

  /** Undefined means "whichever is ready", which is what one chat always wants. */
  getModel(): string | undefined {
    return this.chosenModel;
  }

  setModel(model: string | undefined): void {
    if (this.chosenModel === model) {
      return;
    }
    this.chosenModel = model;
    this.changeEmitter.fire();
  }

  setHop(hop: keyof Omit<ConnectionSnapshot, "providerName" | "detail">, value: HopState): void {
    if (this.connections[hop] === value) {
      return;
    }
    this.connections = { ...this.connections, [hop]: value };
    this.changeEmitter.fire();
  }

  setRequestState(state: RequestLifecycleState, error?: string): void {
    this.requestState = state;
    this.lastError = error;
    this.changeEmitter.fire();
  }
}
