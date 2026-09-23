import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { debounceDelayFromEnv, TimeGapDebouncer } from "./debounce.js";
import { classifyMessage } from "./router.js";

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
  let routingQueue = Promise.resolve();
  const apiKey = process.env.TYPESAFE_API_KEY;
  const debounceEnabled = process.env.PI_CARD_DEBOUNCE_ENABLED === "true" && Boolean(apiKey);
  const debounceDelay = debounceDelayFromEnv(process.env.PI_CARD_DEBOUNCE_MS);

  const routeText = (text: string, ctx: any, combinedFallback = false): Promise<InputResult> => {
    const routeTask = routingQueue.then(async () => {
      let route;
      try {
        route = await classifyMessage(text, apiKey!);
              } catch {
          if (!combinedFallback) {
            // Preserve Pi's native behavior when routing is unavailable.
            return { action: "continue" as const };
          }
          if (ctx.isIdle()) pi.sendUserMessage(text);
          else pi.sendUserMessage(text, { deliverAs: "steer" });
          return { action: "handled" as const };
        }

      if (route === "unclear") {
        if (ctx.isIdle()) return { action: "continue" as const };
        queue.push({ kind: "followUp", message: text });
        ctx.ui.notify("Unclear intent; queued as a follow-up", "info");
        return { action: "handled" as const };
      }

      if (ctx.isIdle()) {
        pi.sendUserMessage(text);
        return { action: "handled" as const };
      }
      if (route === "stop") {
        queue.push({ kind: "interrupt", message: text });
        ctx.abort();
        ctx.ui.notify("Current work interrupted", "warning");
      } else {
        pi.sendUserMessage(text, { deliverAs: route === "steer" ? "steer" : "followUp" });
      }
      return { action: "handled" as const };
    });
    routingQueue = routeTask.then(() => undefined, () => undefined);
    return routeTask;
  };

  const debouncer = debounceEnabled
    ? new TimeGapDebouncer<InputResult, any>(debounceDelay, (text, ctx) => routeText(text, ctx, true))
    : undefined;

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") {
      await debouncer?.flush();
      return { action: "continue" };
    }

    if (event.text === "~~") {
      await debouncer?.flush();
      const last = queue[queue.length - 1];
      if (!last || last.kind !== "followUp") {
        const reason = last ? "Only && cards can be flipped" : "Nothing queued to flip";
        ctx.ui.notify(reason, "warning");
        return { action: "handled" };
      }

      queue.pop();
      pi.sendUserMessage(last.message, { deliverAs: "steer" });
      ctx.ui.notify(`Flipped to steer: ${last.message}`, "info");
      return { action: "handled" };
    }

    const trigger = parseTrigger(event.text);
    if (trigger) {
      await debouncer?.flush();
      if (ctx.isIdle()) {
        return { action: "transform", text: immediateMessage(trigger) };
      }

      queue.push(trigger);
      if (trigger.kind === "followUp") {
        ctx.ui.notify("Follow-up queued", "info");
      } else {
        ctx.abort();
        ctx.ui.notify("Current work interrupted", "warning");
      }
      return { action: "handled" };
    }

    if (!apiKey || event.source !== "interactive" || event.images?.length) {
      await debouncer?.flush();
      return { action: "continue" };
    }

    if (debouncer) return debouncer.add(event.text, ctx);
    return routeText(event.text, ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!ctx.isIdle() || queue.length === 0) return;

    const entries = queue.splice(0);
    pi.sendUserMessage(entries.map(deliveredMessage).join("\n\n"));
  });
}
