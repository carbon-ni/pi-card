import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { debounceDelayFromEnv, TimeGapDebouncer } from "./debounce.js";
import { classifyMessageDetailed, type RoutingExample } from "./router.js";
import { loadRoutingExamples } from "./routing-examples.js";

export type SteeringTrigger =
  | { kind: "interrupt"; message: string }
  | { kind: "followUp"; message: string }
  | { kind: "brainstorm"; message: string };

type QueueEntry = SteeringTrigger;
type InputResult = { action: "continue" | "handled" };

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
  const internalDeliveries = new Map<string, number>();
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

  const sendUserMessage = async (
    text: string,
    options?: { deliverAs?: "steer" | "followUp" },
  ): Promise<void> => {
    internalDeliveries.set(text, (internalDeliveries.get(text) ?? 0) + 1);
    try {
      if (options) await pi.sendUserMessage(text, options);
      else await pi.sendUserMessage(text);
    } finally {
      const remaining = (internalDeliveries.get(text) ?? 1) - 1;
      if (remaining === 0) internalDeliveries.delete(text);
      else internalDeliveries.set(text, remaining);
    }
  };

  const routeText = (text: string, ctx: any, combinedFallback = false): Promise<InputResult> => {
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
          return { action: "continue" as const };
        }
        const mode = ctx.isIdle() ? "normal" : "steer";
        diagnostic("action", { routeId, action: "safe_delivery", mode });
        if (ctx.isIdle()) await sendUserMessage(text);
        else await sendUserMessage(text, { deliverAs: "steer" });
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
            await sendUserMessage(text);
            return { action: "handled" as const };
          }
          diagnostic("action", { routeId, action: "native_pass_through", reason: "unclear_while_idle" });
          return { action: "continue" as const };
        }
        queue.push({ kind: "followUp", message: text });
        diagnostic("action", { routeId, action: "queue", kind: "followUp", reason: "unclear_while_active" });
        ctx.ui.notify("Unclear intent; queued as a follow-up", "info");
        return { action: "handled" as const };
      }

      if (ctx.isIdle()) {
        diagnostic("action", { routeId, action: "deliver", mode: "normal", reason: "idle" });
        await sendUserMessage(text);
        return { action: "handled" as const };
      }
      if (route === "stop") {
        queue.push({ kind: "interrupt", message: text });
        diagnostic("action", { routeId, action: "abort_and_queue", kind: "interrupt" });
        ctx.abort();
        ctx.ui.notify("Current work interrupted", "warning");
      } else {
        const mode = route === "steer" ? "steer" : "followUp";
        diagnostic("action", { routeId, action: "deliver", mode, reason: "jev_route" });
        await sendUserMessage(text, { deliverAs: mode });
      }
      return { action: "handled" as const };
    });
    routingQueue = routeTask.then(() => undefined, () => undefined);
    return routeTask;
  };

  const debouncer = debounceEnabled
    ? new TimeGapDebouncer<InputResult, any>(debounceDelay, (text, ctx) => routeText(text, ctx, true))
    : undefined;

  pi.on("session_start", (event) => {
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

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") {
      if (internalDeliveries.has(event.text)) {
        diagnostic("input", { branch: "internal_extension" });
        return { action: "continue" };
      }
      diagnostic("input", { branch: "extension_bypass" });
      await debouncer?.flush();
      return { action: "continue" };
    }

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
      await sendUserMessage(last.message, { deliverAs: "steer" });
      ctx.ui.notify(`Flipped to steer: ${last.message}`, "info");
      return { action: "handled" };
    }

    const trigger = parseTrigger(event.text);
    if (trigger) {
      diagnostic("input", { branch: "prefix", kind: trigger.kind });
      await debouncer?.flush();
      if (ctx.isIdle()) {
        diagnostic("action", { action: "deliver", mode: "normal", reason: "prefix_while_idle", kind: trigger.kind });
        return { action: "transform", text: immediateMessage(trigger) };
      }

      queue.push(trigger);
      diagnostic("action", { action: trigger.kind === "followUp" ? "queue" : "abort_and_queue", kind: trigger.kind });
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
      void debouncer.add(event.text, ctx);
      return { action: "handled" };
    }
    diagnostic("input", { branch: "immediate_interactive" });
    return routeText(event.text, ctx);
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
    await sendUserMessage(entries.map(deliveredMessage).join("\n\n"));
  });
}
