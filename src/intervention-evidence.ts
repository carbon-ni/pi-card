export const INTERVENTION_EVIDENCE_TYPE = "pi-card.intervention";

export type StreamingBehavior = "steer" | "followUp";
export type EvidenceAction = "send" | "continue" | "queued_followUp" | "abort_requested" | "transform";
export type EvidenceDelivery = "normal" | "steer" | "followUp";
export type EvidenceInputKind = "jevRouted" | "interruptCard" | "followUpCard" | "brainstormCard";

export interface EvidenceMetadata {
  schemaVersion: 3;
  source: "interactive";
  activeAtInput: boolean;
  streamingBehavior: StreamingBehavior | null;
  taskAnchorEntryId: string | null;
  inputLeafEntryId: string | null;
  inputKind: EvidenceInputKind;
  observedAction: EvidenceAction;
  deliveryAtPersistence: EvidenceDelivery;
}

export interface SessionBranchEntry {
  id?: unknown;
  type?: unknown;
  customType?: unknown;
  parentId?: unknown;
  message?: { role?: unknown; content?: unknown };
}

export interface InputSnapshot {
  readonly generation: number;
  readonly agentStartCount: number;
  readonly baselineEntryIds: readonly string[];
  readonly taskAnchorEntryId: string | null;
  readonly inputLeafEntryId: string | null;
  readonly source: "interactive";
  readonly activeAtInput: boolean;
  readonly streamingBehavior: StreamingBehavior | null;
}

export type CorrelationResult =
  | { status: "waiting" }
  | { status: "ambiguous" }
  | { status: "matched"; entryId: string; metadata: EvidenceMetadata };

interface PendingEvidence {
  snapshot: InputSnapshot;
  metadata: EvidenceMetadata;
}

function isEntryId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasPiCardDiagnosticPath(
  entriesById: Map<string, SessionBranchEntry>,
  parentId: unknown,
  inputLeafEntryId: string | null,
): boolean {
  const visited = new Set<string>();
  let currentId = parentId;
  while (currentId !== inputLeafEntryId) {
    if (typeof currentId !== "string" || visited.has(currentId)) return false;
    visited.add(currentId);
    const entry = entriesById.get(currentId);
    if (!entry || entry.type !== "custom" || entry.customType !== "pi-card.routing") return false;
    currentId = entry.parentId;
    if (currentId !== null && typeof currentId !== "string") return false;
  }
  return true;
}

function persistedText(entry: SessionBranchEntry): string | undefined {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.some((part) =>
    !part || typeof part !== "object" || part.type !== "text" || typeof part.text !== "string",
  )) return;
  return content.map((part) => part.text).join("");
}

export class InterventionEvidenceSession {
  private ready = false;
  private enabled = false;
  private blocked = false;
  private generation = 0;
  private agentStartCount = 0;
  private pending?: PendingEvidence;

  startSession(): void {
    this.generation++;
    this.ready = true;
    this.enabled = false;
    this.blocked = false;
    this.pending = undefined;
    this.agentStartCount = 0;
  }

  enable(isIdle: boolean): boolean {
    if (!this.ready || !isIdle) return false;
    this.generation++;
    this.enabled = true;
    this.blocked = false;
    this.pending = undefined;
    return true;
  }

  disable(): void {
    this.generation++;
    this.enabled = false;
    this.blocked = false;
    this.pending = undefined;
  }

  snapshot(
    source: string,
    isIdle: boolean,
    streamingBehavior: unknown,
    branch: readonly SessionBranchEntry[],
    leafId: unknown,
  ): InputSnapshot | undefined {
    if (!this.ready || !this.enabled || this.blocked || source !== "interactive") return;
    if (!Array.isArray(branch)) return;

    const ids = branch.map((entry) => entry.id);
    if (!ids.every(isEntryId) || new Set(ids).size !== ids.length) return;
    if (branch.length === 0) {
      if (!isIdle || (leafId !== null && leafId !== undefined)) return;
    } else if (!isEntryId(leafId) || ids.at(-1) !== leafId) {
      return;
    }

    const taskAnchor = isIdle ? undefined : [...branch].reverse().find((entry) =>
      entry.type === "message" && entry.message?.role === "user" && isEntryId(entry.id),
    );
    if (!isIdle && (!taskAnchor || !isEntryId(taskAnchor.id))) return;

    return {
      generation: this.generation,
      agentStartCount: this.agentStartCount,
      baselineEntryIds: ids,
      taskAnchorEntryId: taskAnchor && isEntryId(taskAnchor.id) ? taskAnchor.id : null,
      inputLeafEntryId: isEntryId(leafId) ? leafId : null,
      source: "interactive",
      activeAtInput: !isIdle,
      streamingBehavior: streamingBehavior === "steer" || streamingBehavior === "followUp"
        ? streamingBehavior
        : null,
    };
  }

  arm(snapshot: InputSnapshot | undefined, metadata: EvidenceMetadata): boolean {
    if (!snapshot || !this.ready || !this.enabled || this.blocked || snapshot.generation !== this.generation) return false;
    if (metadata.taskAnchorEntryId !== snapshot.taskAnchorEntryId || metadata.inputLeafEntryId !== snapshot.inputLeafEntryId ||
        metadata.activeAtInput !== snapshot.activeAtInput) {
      this.failClosed();
      return false;
    }
    if (this.pending) {
      this.failClosed();
      return false;
    }
    this.pending = { snapshot, metadata };
    return true;
  }

  noteAgentStart(): void {
    this.agentStartCount++;
  }

  correlate(branch: readonly SessionBranchEntry[], leafId: unknown): CorrelationResult {
    if (!this.pending || !this.enabled || this.blocked) return { status: "waiting" };

    const { snapshot, metadata } = this.pending;
    const ids = branch.map((entry) => entry.id);
    if (!ids.every(isEntryId) || new Set(ids).size !== ids.length) return this.reject();

    const currentIds = new Set(ids as string[]);
    if (snapshot.generation !== this.generation ||
        !snapshot.baselineEntryIds.every((id) => currentIds.has(id)) ||
        (snapshot.inputLeafEntryId !== null && !currentIds.has(snapshot.inputLeafEntryId))) {
      return this.reject();
    }

    const newUsers = branch.filter((entry) =>
      entry.type === "message" && entry.message?.role === "user" &&
      isEntryId(entry.id) && !snapshot.baselineEntryIds.includes(entry.id),
    );

    if (newUsers.length === 0) {
      if (this.agentStartCount > snapshot.agentStartCount) return this.reject();
      return { status: "waiting" };
    }
    const text = newUsers.length === 1 ? persistedText(newUsers[0]) : undefined;
    if (newUsers.length !== 1 || !isEntryId(leafId) || newUsers[0].id !== leafId || !text) return this.reject();

    const entriesById = new Map(branch.filter((entry) => isEntryId(entry.id)).map((entry) => [entry.id as string, entry]));
    if (!snapshot.activeAtInput) {
      if (!hasPiCardDiagnosticPath(entriesById, newUsers[0].parentId, snapshot.inputLeafEntryId)) return this.reject();
    } else {
      const ancestors = new Set<string>();
      const visited = new Set<string>();
      let parentId = newUsers[0].parentId;
      while (typeof parentId === "string") {
        if (visited.has(parentId)) return this.reject();
        visited.add(parentId);
        const parent = entriesById.get(parentId);
        if (!parent) return this.reject();
        ancestors.add(parentId);
        parentId = parent.parentId;
        if (parentId === null || parentId === undefined) break;
        if (typeof parentId !== "string") return this.reject();
      }
      if (parentId !== null && parentId !== undefined) return this.reject();
      if (!snapshot.baselineEntryIds.every((id) => ancestors.has(id))) return this.reject();
    }

    this.pending = undefined;
    return { status: "matched", entryId: leafId, metadata };
  }

  failClosed(): void {
    this.pending = undefined;
    this.blocked = true;
  }

  get isEnabled(): boolean {
    return this.ready && this.enabled && !this.blocked;
  }

  get hasPending(): boolean {
    return this.pending !== undefined;
  }

  get isReady(): boolean {
    return this.ready;
  }

  private reject(): CorrelationResult {
    this.failClosed();
    return { status: "ambiguous" };
  }
}
