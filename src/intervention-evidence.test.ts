import { describe, expect, it } from "vitest";
import { InterventionEvidenceSession, type EvidenceMetadata, type SessionBranchEntry } from "./intervention-evidence.js";

const baseline: SessionBranchEntry[] = [
  { id: "root", type: "session" },
  { id: "task", type: "message", parentId: "root", message: { role: "user" } },
];
const metadata: EvidenceMetadata = {
  schemaVersion: 3,
  source: "interactive",
  activeAtInput: true,
  streamingBehavior: "steer",
  taskAnchorEntryId: "task",
  inputLeafEntryId: "task",
  inputKind: "jevRouted",
  observedAction: "send",
  deliveryAtPersistence: "steer",
};

function readySession(): InterventionEvidenceSession {
  const session = new InterventionEvidenceSession();
  session.startSession();
  expect(session.enable(true)).toBe(true);
  return session;
}

function snapshot(session: InterventionEvidenceSession, branch = baseline, isIdle = false) {
  return session.snapshot("interactive", isIdle, "steer", branch, branch.at(-1)?.id ?? null);
}

function arm(session: InterventionEvidenceSession, input = snapshot(session)) {
  return session.arm(input, metadata);
}

describe("InterventionEvidenceSession", () => {
  it("captures active and idle interactive snapshots only after explicit enable", () => {
    const session = new InterventionEvidenceSession();
    expect(session.snapshot("interactive", false, undefined, baseline, "task")).toBeUndefined();
    session.startSession();
    expect(session.snapshot("interactive", false, undefined, baseline, "task")).toBeUndefined();
    expect(session.enable(false)).toBe(false);
    expect(session.enable(true)).toBe(true);
    expect(session.snapshot("rpc", false, undefined, baseline, "task")).toBeUndefined();
    expect(session.snapshot("interactive", true, undefined, baseline, "task")).toMatchObject({
      generation: 2,
      baselineEntryIds: ["root", "task"],
      taskAnchorEntryId: null,
      inputLeafEntryId: "task",
      source: "interactive",
      activeAtInput: false,
      streamingBehavior: null,
    });
    expect(session.snapshot("interactive", true, undefined, [], null)).toMatchObject({
      generation: 2,
      baselineEntryIds: [],
      taskAnchorEntryId: null,
      inputLeafEntryId: null,
      activeAtInput: false,
    });
    expect(session.snapshot("interactive", false, "followUp", baseline, "task")).toEqual({
      generation: 2,
      agentStartCount: 0,
      baselineEntryIds: ["root", "task"],
      taskAnchorEntryId: "task",
      inputLeafEntryId: "task",
      source: "interactive",
      activeAtInput: true,
      streamingBehavior: "followUp",
    });
  });

  it("freezes the nearest task user and exact input leaf IDs", () => {
    const session = readySession();
    const branch = [...baseline, { id: "assistant-leaf", type: "message", parentId: "task", message: { role: "assistant" } }];
    expect(snapshot(session, branch)).toMatchObject({
      taskAnchorEntryId: "task",
      inputLeafEntryId: "assistant-leaf",
    });
  });

  it("links only the unique new persisted user entry when it is the current leaf", () => {
    const session = readySession();
    const input = snapshot(session)!;
    expect(arm(session, input)).toBe(true);

    const branch = [...baseline, { id: "assistant", type: "message", parentId: "task", message: { role: "assistant" } },
      { id: "intervention", type: "message", parentId: "assistant", message: { role: "user", content: [{ type: "text", text: "private input" }] } }];
    expect(session.correlate(branch, "intervention")).toEqual({
      status: "matched",
      entryId: "intervention",
      metadata,
    });
    expect(session.correlate(branch, "intervention")).toEqual({ status: "waiting" });
  });

  it("matches an idle transform from an empty session only to a root persisted user entry", () => {
    const session = readySession();
    const input = snapshot(session, [], true)!;
    const idleMetadata: EvidenceMetadata = {
      ...metadata,
      activeAtInput: false,
      taskAnchorEntryId: null,
      inputLeafEntryId: null,
      inputKind: "interruptCard",
      observedAction: "transform",
      deliveryAtPersistence: "normal",
    };
    expect(session.arm(input, idleMetadata)).toBe(true);

    const branch = [{
      id: "first-user",
      type: "message",
      parentId: null,
      message: { role: "user", content: "transformed persisted text" },
    }];
    expect(session.correlate(branch, "first-user")).toEqual({
      status: "matched",
      entryId: "first-user",
      metadata: idleMetadata,
    });
  });

  it("fails closed when an idle delivery is not a direct child of its frozen input leaf", () => {
    const session = readySession();
    const input = snapshot(session, baseline, true)!;
    const idleMetadata = { ...metadata, activeAtInput: false, taskAnchorEntryId: null, inputLeafEntryId: "task" };
    expect(session.arm(input, idleMetadata)).toBe(true);
    const branch = [...baseline, {
      id: "intervention",
      type: "message",
      parentId: "root",
      message: { role: "user", content: "private input" },
    }];
    expect(session.correlate(branch, "intervention")).toEqual({ status: "ambiguous" });
    expect(session.isEnabled).toBe(false);
  });

  it("fails closed when the persisted user entry contains non-text content", () => {
    const session = readySession();
    expect(arm(session)).toBe(true);
    const branch = [...baseline,
      { id: "assistant", type: "message", parentId: "task", message: { role: "assistant" } },
      { id: "intervention", type: "message", parentId: "assistant", message: { role: "user", content: [{ type: "text", text: "private input" }, { type: "image" }] } },
    ];
    expect(session.correlate(branch, "intervention")).toEqual({ status: "ambiguous" });
    expect(session.isEnabled).toBe(false);
  });

  it("associates the persisted target by exact branch IDs, not by its text", () => {
    const session = readySession();
    expect(arm(session)).toBe(true);
    const branch = [...baseline,
      { id: "assistant", type: "message", parentId: "task", message: { role: "assistant" } },
      { id: "intervention", type: "message", parentId: "assistant", message: { role: "user", content: "persisted transformed input" } },
    ];
    expect(session.correlate(branch, "intervention")).toMatchObject({
      status: "matched",
      entryId: "intervention",
    });
  });

  it("fails closed when marker ancestry metadata differs from the frozen snapshot", () => {
    const session = readySession();
    const input = snapshot(session)!;
    expect(session.arm(input, { ...metadata, taskAnchorEntryId: "other-task" })).toBe(false);
    expect(session.isEnabled).toBe(false);
  });

  it("waits while the active turn has not persisted a new user entry", () => {
    const session = readySession();
    expect(arm(session)).toBe(true);
    expect(session.correlate(baseline, "task")).toEqual({ status: "waiting" });
    expect(session.isEnabled).toBe(true);
  });

  it.each([
    ["multiple new user entries", [
      ...baseline,
      { id: "first", type: "message", message: { role: "user" } },
      { id: "second", type: "message", message: { role: "user" } },
    ], "second"],
    ["a new user entry that is not the leaf", [
      ...baseline,
      { id: "new-user", type: "message", message: { role: "user" } },
      { id: "other-leaf", type: "custom" },
    ], "other-leaf"],
    ["branch drift", [
      { id: "new-root", type: "session" },
      { id: "new-user", type: "message", message: { role: "user" } },
    ], "new-user"],
    ["malformed entry IDs", [
      ...baseline,
      { id: null, type: "message", message: { role: "user" } },
    ], null],
  ] as const)("fails closed for %s", (_caseName, branch, leafId) => {
    const session = readySession();
    expect(arm(session)).toBe(true);
    expect(session.correlate(branch, leafId)).toEqual({ status: "ambiguous" });
    expect(session.isEnabled).toBe(false);
    expect(arm(session)).toBe(false);
  });

  it("fails closed when a queued delivery reaches a new agent turn without its user entry", () => {
    const session = readySession();
    expect(arm(session)).toBe(true);
    session.noteAgentStart();
    expect(session.correlate(baseline, "task")).toEqual({ status: "ambiguous" });
    expect(session.isEnabled).toBe(false);
  });

  it("fails closed when concurrent candidates would make the ID join ambiguous", () => {
    const session = readySession();
    const input = snapshot(session);
    expect(arm(session, input)).toBe(true);
    expect(arm(session, input)).toBe(false);
    expect(session.isEnabled).toBe(false);
  });

  it("does not carry opt-in or pending state across session starts", () => {
    const session = readySession();
    expect(arm(session)).toBe(true);
    session.startSession();
    expect(session.isEnabled).toBe(false);
    expect(session.correlate([...baseline, { id: "new-user", type: "message", message: { role: "user" } }], "new-user"))
      .toEqual({ status: "waiting" });
  });

  it("rejects malformed or duplicate baseline IDs", () => {
    const session = readySession();
    expect(session.snapshot("interactive", false, undefined, [{ id: "same" }, { id: "same" }], "same")).toBeUndefined();
    expect(session.snapshot("interactive", false, undefined, [{ id: "root" }, { id: 42 }], "root")).toBeUndefined();
  });
});
