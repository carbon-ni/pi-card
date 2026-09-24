import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { debounceDelayFromEnv, TimeGapDebouncer } from "./debounce.js";
import { classifyMessageDetailed, type RoutingExample } from "./router.js";
import { loadRoutingExamples } from "./routing-examples.js";
import {
  INTERVENTION_EVIDENCE_TYPE,
  InterventionEvidenceSession,
  type EvidenceAction,
  type EvidenceInputKind,
  type EvidenceMetadata,
  type InputSnapshot,
} from "./intervention-evidence.js";

export type SteeringTrigger =
  | { kind: "interrupt"; message: string }
  | { kind: "followUp"; message: string }
  | { kind: "brainstorm"; message: string };

type EvidenceIntent = {
  session: InterventionEvidenceSession;
  snapshot: InputSnapshot;
  observedAction: EvidenceAction;
  inputKind: EvidenceInputKind;
};
type QueueEntry = SteeringTrigger & { evidence?: EvidenceIntent };
type InputResult = { action: "continue" | "handled" };
type ActiveInternalDelivery = {
  expectedText: string;
  inputCount: number;
  ambiguous: boolean;
  session?: InterventionEvidenceSession;
};

export function parseTrigger(text: string): SteeringTrigger | undefined {
  const prefix = text.slice(0, 2);
  const message = text.slice(2).trim();
  if (!message) return;

  if (prefix === "**") return { kind: "interrupt", message };
  if (prefix === "&&") return { kind: "followUp", message };
  if (prefix === "??") return { kind: "brainstorm", message };
}

function immediateMessage(trigger: SteeringTrigger): string {
  if (trigger.kind === "brainstorm") {
    return `Let's brainstorm ${trigger.message} before taking further action.`;
  }
  return trigger.message;
}

function deliveredMessage(entry: QueueEntry): string {
  if (entry.kind === "brainstorm") {
    return `Stop the previous approach. Let's brainstorm ${entry.message} before taking further action.`;
  }
  return entry.message;
}

export default function registerCard(pi: ExtensionAPI): void {
  const queue: QueueEntry[] = [];
  let activeInternalDelivery: ActiveInternalDelivery | undefined;
  const evidenceSessions = new WeakMap<object, InterventionEvidenceSession>();
  let routingQueue = Promise.resolve();
  let nextRouteId = 1;
  const apiKey = process.env.TYPESAFE_API_KEY;
  let routingExamples: RoutingExample[] = [];
  try {
    routingExamples = loadRoutingExamples();
  } catch {
    // Invalid preferences must not prevent extension startup or change fallback behavior.
    console.warn("[pi-card] Invalid routing config; using default Jev routing.");
  }
  const debounceRequested = process.env.PI_CARD_DEBOUNCE_ENABLED === "true";
  const debounceEnabled = debounceRequested && Boolean(apiKey);
  const debounceDelay = debounceDelayFromEnv(process.env.PI_CARD_DEBOUNCE_MS);
  const debugEnabled = process.env.PI_CARD_DEBUG === "true";
  const diagnostic = (event: string, details: Record<string, string | number | boolean> = {}): void => {
    if (!debugEnabled) return;
    try {
      pi.appendEntry("pi-card.routing", { event, ...details });
    } catch {
      // Diagnostics must never change message routing behavior.
    }
  };

  const evidenceSessionFor = (ctx: any): InterventionEvidenceSession | undefined => {
    const manager = ctx?.sessionManager;
    if (!manager || typeof manager !== "object") return;
    let session = evidenceSessions.get(manager);
    if (!session) {
      session = new InterventionEvidenceSession();
      evidenceSessions.set(manager, session);
    }
    return session;
  };

  const snapshotInput = (event: any, ctx: any): { session: InterventionEvidenceSession; snapshot: InputSnapshot } | undefined => {
    if (ctx?.mode !== "tui") return;
    const session = evidenceSessionFor(ctx);
    if (!session?.isEnabled) return;
    try {
      const snapshot = session.snapshot(
        event.source,
        ctx.isIdle(),
        event.streamingBehavior,
        ctx.sessionManager.getBranch(),
        ctx.sessionManager.getLeafId(),
      );
      return snapshot ? { session, snapshot } : undefined;
    } catch {
      return;
    }
  };

  const evidenceIntent = (
    input: { session: InterventionEvidenceSession; snapshot: InputSnapshot } | undefined,
    observedAction: EvidenceAction,
    inputKind: EvidenceInputKind,
  ): EvidenceIntent | undefined => input ? { ...input, observedAction, inputKind } : undefined;

  const evidenceMetadata = (evidence: EvidenceIntent, deliveryAtPersistence: "normal" | "steer" | "followUp"): EvidenceMetadata => ({
    schemaVersion: 3,
    source: evidence.snapshot.source,
    activeAtInput: evidence.snapshot.activeAtInput,
    streamingBehavior: evidence.snapshot.streamingBehavior,
    taskAnchorEntryId: evidence.snapshot.taskAnchorEntryId,
    inputLeafEntryId: evidence.snapshot.inputLeafEntryId,
    inputKind: evidence.inputKind,
    observedAction: evidence.observedAction,
    deliveryAtPersistence,
  });

  const armHostPersistedInput = (
    input: { session: InterventionEvidenceSession; snapshot: InputSnapshot } | undefined,
    inputKind: EvidenceInputKind,
    observedAction: EvidenceAction,
  ): void => {
    const evidence = evidenceIntent(input, observedAction, inputKind);
    if (evidence && !evidence.session.arm(evidence.snapshot, evidenceMetadata(evidence, "normal"))) {
      evidence.session.failClosed();
    }
  };

  const sendUserMessage = async (
    text: string,
    options?: { deliverAs?: "steer" | "followUp" },
    evidence?: EvidenceIntent,
  ): Promise<void> => {
    const previousDelivery = activeInternalDelivery;
    if (previousDelivery) {
      previousDelivery.ambiguous = true;
      previousDelivery.session?.failClosed();
      evidence?.session.failClosed();
    }
    const delivery: ActiveInternalDelivery = {
      expectedText: text,
      inputCount: 0,
      ambiguous: false,
      session: evidence?.session,
    };
    activeInternalDelivery = delivery;
    const metadata = evidence ? evidenceMetadata(evidence, options?.deliverAs ?? "normal") : undefined;
    if (evidence && metadata && !evidence.session.arm(evidence.snapshot, metadata)) {
      evidence.session.failClosed();
    }
    try {
      if (options) await pi.sendUserMessage(text, options);
      else await pi.sendUserMessage(text);
    } catch (error) {
      evidence?.session.failClosed();
      throw error;
    } finally {
      if (evidence && (delivery.inputCount !== 1 || delivery.ambiguous)) evidence.session.failClosed();
      if (activeInternalDelivery === delivery) activeInternalDelivery = previousDelivery;
    }
  };

  const routeText = (
    text: string,
    ctx: any,
    combinedFallback = false,
    input?: { session: InterventionEvidenceSession; snapshot: InputSnapshot },
    inputKind: EvidenceInputKind = "jevRouted",
  ): Promise<InputResult> => {
    const routeId = nextRouteId++;
    const routeTask = routingQueue.then(async () => {
      let decision;
      try {
        decision = await classifyMessageDetailed(text, apiKey!, fetch, routingExamples);
      } catch (error) {
        const failure = error instanceof Error && error.name === "AbortError"
          ? "timeout"
          : "classifier_error";
        diagnostic("classifier_failure", {
          routeId,
          failure,
          fallback: combinedFallback ? "safe_delivery" : "native_input",
        });
        if (!combinedFallback) {
          // Preserve Pi's native behavior when routing is unavailable.
          diagnostic("action", { routeId, action: "native_pass_through", reason: failure });
          armHostPersistedInput(input, inputKind, "continue");
          return { action: "continue" as const };
        }
        const mode = ctx.isIdle() ? "normal" : "steer";
        diagnostic("action", { routeId, action: "safe_delivery", mode });
        const evidence = evidenceIntent(input, "send", inputKind);
        if (ctx.isIdle()) await sendUserMessage(text, undefined, evidence);
        else await sendUserMessage(text, { deliverAs: "steer" }, evidence);
        return { action: "handled" as const };
      }

      const route = decision.route;
      diagnostic("route", {
        routeId,
        choice: decision.choice,
        outcome: route,
        policy: decision.choice === route ? "accepted" : "downgraded",
        confidence: decision.confidence,
      });

      if (route === "unclear") {
        if (ctx.isIdle()) {
          if (combinedFallback) {
            diagnostic("action", { routeId, action: "deliver", mode: "normal", reason: "unclear_while_idle" });
            await sendUserMessage(text, undefined, evidenceIntent(input, "send", inputKind));
            return { action: "handled" as const };
          }
          diagnostic("action", { routeId, action: "native_pass_through", reason: "unclear_while_idle" });
          armHostPersistedInput(input, inputKind, "continue");
          return { action: "continue" as const };
        }
        queue.push({
          kind: "followUp",
          message: text,
          evidence: evidenceIntent(input, "queued_followUp", inputKind),
        });
        diagnostic("action", { routeId, action: "queue", kind: "followUp", reason: "unclear_while_active" });
        ctx.ui.notify("Unclear intent; queued as a follow-up", "info");
        return { action: "handled" as const };
      }

      if (ctx.isIdle()) {
        diagnostic("action", { routeId, action: "deliver", mode: "normal", reason: "idle" });
        await sendUserMessage(text, undefined, evidenceIntent(input, "send", inputKind));
        return { action: "handled" as const };
      }
      if (route === "stop") {
        queue.push({
          kind: "interrupt",
          message: text,
          evidence: evidenceIntent(input, "abort_requested", inputKind),
        });
        diagnostic("action", { routeId, action: "abort_and_queue", kind: "interrupt" });
        ctx.abort();
        ctx.ui.notify("Current work interrupted", "warning");
      } else {
        const mode = route === "steer" ? "steer" : "followUp";
        diagnostic("action", { routeId, action: "deliver", mode, reason: "jev_route" });
        await sendUserMessage(text, { deliverAs: mode }, evidenceIntent(input, "send", inputKind));
      }
      return { action: "handled" as const };
    });
    routingQueue = routeTask.then(() => undefined, () => undefined);
    return routeTask;
  };

  const debouncer = debounceEnabled
    ? new TimeGapDebouncer<InputResult, { ctx: any; input?: { session: InterventionEvidenceSession; snapshot: InputSnapshot } }>(
      debounceDelay,
      (text, context) => routeText(text, context.ctx, true, context.input),
    )
    : undefined;

  pi.registerCommand("pi-card-capture", {
    description: "Enable or disable prospective Pi Card intervention markers for this session",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Pi Card capture can only be controlled from the interactive TUI", "warning");
        return;
      }
      const session = evidenceSessionFor(ctx);
      if (!session?.isReady) {
        ctx.ui.notify("Pi Card capture is available after the session starts", "warning");
        return;
      }

      const action = args.trim().toLowerCase();
      if (action === "off") {
        session.disable();
        ctx.ui.notify("Pi Card capture is off", "info");
        return;
      }
      if (action !== "on") {
        ctx.ui.notify("Usage: /pi-card-capture on|off", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Enable Pi Card capture only while the agent is idle", "warning");
        return;
      }
      let confirmed = false;
      try {
        confirmed = await ctx.ui.confirm(
          "Enable prospective Pi Card capture?",
          "Capture future interactive Jev-routed text and **/&&/?? cards while Pi is idle or active. The marker stores no input text or Jev result; the exact persisted Pi Card user message remains in this session and may differ from what you typed (prefixes can be stripped or text transformed). Metadata includes idle/active, card kind, action, delivery, branch IDs, and Pi's standard timestamp. Commands handled before Pi Card, attachments, extension/RPC inputs are excluded. Capture is session-only; turning it off does not delete markers, and mining requires separate consent. Continue?",
        );
      } catch {
        // Capture must stay off when interactive confirmation is unavailable.
      }
      if (!confirmed) {
        ctx.ui.notify("Pi Card capture remains off; confirmation is required", "info");
        return;
      }
      if (!session.enable(ctx.isIdle())) {
        ctx.ui.notify("Enable Pi Card capture only while the agent is idle", "warning");
        return;
      }
      ctx.ui.notify("Pi Card capture is on for this session; persisted-message metadata only", "info");
    },
  });

  pi.on("session_start", (event, ctx) => {
    evidenceSessionFor(ctx)?.startSession();
    diagnostic("session_start", {
      reason: event.reason,
      apiKeyConfigured: Boolean(apiKey),
      routingEnabled: Boolean(apiKey),
      debounceRequested,
      debounceEnabled,
      debounceDelayMs: debounceDelay,
      routingExamplesConfigured: routingExamples.length > 0,
    });
  });

  const invalidateEvidence = (_event: any, ctx: any): void => {
    evidenceSessionFor(ctx)?.failClosed();
  };
  pi.on("session_before_switch", invalidateEvidence);
  pi.on("session_before_fork", invalidateEvidence);
  pi.on("session_before_compact", invalidateEvidence);
  pi.on("session_compact", invalidateEvidence);

  pi.on("agent_start", (_event, ctx) => {
    evidenceSessionFor(ctx)?.noteAgentStart();
  });

  pi.on("message_start", (event, ctx) => {
    if (event.message?.role !== "assistant") return;
    const session = evidenceSessionFor(ctx);
    if (!session?.hasPending) return;

    try {
      const result = session.correlate(ctx.sessionManager.getBranch(), ctx.sessionManager.getLeafId());
      if (result.status !== "matched") return;

      pi.appendEntry(INTERVENTION_EVIDENCE_TYPE, result.metadata);
      const markerId = ctx.sessionManager.getLeafId();
      const marker = ctx.sessionManager.getEntries().find((entry: any) => entry.id === markerId);
      if (marker?.parentId !== result.entryId) session.failClosed();
    } catch {
      session.failClosed();
    }
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") {
      if (activeInternalDelivery) {
        const delivery = activeInternalDelivery;
        delivery.inputCount++;
        if (delivery.inputCount !== 1 || event.text !== delivery.expectedText || event.images?.length) {
          delivery.ambiguous = true;
          delivery.session?.failClosed();
        }
        diagnostic("input", { branch: delivery.ambiguous ? "ambiguous_internal_extension" : "internal_extension" });
        return { action: "continue" };
      }
      const session = evidenceSessionFor(ctx);
      if (session?.hasPending) session.failClosed();
      diagnostic("input", { branch: "extension_bypass" });
      await debouncer?.flush();
      return { action: "continue" };
    }

    const evidenceSession = evidenceSessionFor(ctx);
    if (evidenceSession?.hasPending) evidenceSession.failClosed();
    const captureEligible = ctx?.mode === "tui" && event.source === "interactive" &&
      !event.images?.length && !event.text?.trimStart().startsWith("/");
    const inputSnapshot = captureEligible ? snapshotInput(event, ctx) : undefined;

    if (event.text === "~~") {
      diagnostic("input", { branch: "flip" });
      await debouncer?.flush();
      const last = queue[queue.length - 1];
      if (!last || last.kind !== "followUp") {
        const reason = last ? "Only && cards can be flipped" : "Nothing queued to flip";
        ctx.ui.notify(reason, "warning");
        return { action: "handled" };
      }

      queue.pop();
      diagnostic("action", { action: "deliver", mode: "steer", reason: "flipped_followUp" });
      const evidence = last.evidence;
      await sendUserMessage(last.message, { deliverAs: "steer" }, evidence);
      ctx.ui.notify(`Flipped to steer: ${last.message}`, "info");
      return { action: "handled" };
    }

    const trigger = parseTrigger(event.text);
    if (trigger) {
      diagnostic("input", { branch: "prefix", kind: trigger.kind });
      await debouncer?.flush();
      const inputKind: EvidenceInputKind = trigger.kind === "interrupt"
        ? "interruptCard"
        : trigger.kind === "followUp" ? "followUpCard" : "brainstormCard";
      if (ctx.isIdle()) {
        diagnostic("action", { action: "deliver", mode: "normal", reason: "prefix_while_idle", kind: trigger.kind });
        const transformedText = immediateMessage(trigger);
        armHostPersistedInput(inputSnapshot, inputKind, "transform");
        return { action: "transform", text: transformedText };
      }

      const action = trigger.kind === "followUp" ? "queue" : "abort_and_queue";
      const observedAction = trigger.kind === "followUp" ? "queued_followUp" : "abort_requested";
      queue.push({ ...trigger, evidence: evidenceIntent(inputSnapshot, observedAction, inputKind) });
      diagnostic("action", { action, kind: trigger.kind });
      if (trigger.kind === "followUp") {
        ctx.ui.notify("Follow-up queued", "info");
      } else {
        ctx.abort();
        ctx.ui.notify("Current work interrupted", "warning");
      }
      return { action: "handled" };
    }

    if (!apiKey || event.source !== "interactive" || event.images?.length) {
      const branch = !apiKey ? "no_api_key" : event.images?.length ? "attachment_bypass" : "non_interactive";
      diagnostic("input", { branch });
      await debouncer?.flush();
      return { action: "continue" };
    }

    if (debouncer) {
      diagnostic("input", { branch: "debounced_interactive" });
      void debouncer.add(event.text, { ctx, input: inputSnapshot });
      return { action: "handled" };
    }
    diagnostic("input", { branch: "immediate_interactive" });
    return routeText(event.text, ctx, false, inputSnapshot);
  });

  pi.on("session_shutdown", async () => {
    diagnostic("lifecycle", { action: "session_shutdown_flush" });
    await debouncer?.flush();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!ctx.isIdle() || queue.length === 0) return;

    const entries = queue.splice(0);
    diagnostic("action", {
      action: "queue_drain",
      count: entries.length,
      kinds: [...new Set(entries.map((entry) => entry.kind))].join(","),
    });
    const evidence = entries.length === 1 ? entries[0].evidence : undefined;
    if (entries.length > 1) {
      for (const entry of entries) entry.evidence?.session.failClosed();
    }
    await sendUserMessage(entries.map(deliveredMessage).join("\n\n"), undefined, evidence);
  });
}
