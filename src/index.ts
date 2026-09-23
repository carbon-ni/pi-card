import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyMessage } from "./router.js";

export type SteeringTrigger =
  | { kind: "interrupt"; message: string }
  | { kind: "followUp"; message: string }
  | { kind: "brainstorm"; message: string };

type QueueEntry = SteeringTrigger;

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

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };

    if (event.text === "~~") {
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
    if (!trigger) {
      const apiKey = process.env.TYPESAFE_API_KEY;
      if (!apiKey || event.source !== "interactive" || event.images?.length) return { action: "continue" };

      let route;
      try {
        route = await classifyMessage(event.text, apiKey);
      } catch {
        // Preserve Pi's native behavior when routing is unavailable.
        return { action: "continue" };
      }

      if (route === "unclear") {
        if (ctx.isIdle()) return { action: "continue" };
        queue.push({ kind: "followUp", message: event.text });
        ctx.ui.notify("Unclear intent; queued as a follow-up", "info");
        return { action: "handled" };
      }

      if (ctx.isIdle()) {
        pi.sendUserMessage(event.text);
        return { action: "handled" };
      }
      if (route === "stop") {
        queue.push({ kind: "interrupt", message: event.text });
        ctx.abort();
        ctx.ui.notify("Current work interrupted", "warning");
      } else {
        pi.sendUserMessage(event.text, { deliverAs: route === "steer" ? "steer" : "followUp" });
      }
      return { action: "handled" };
    }

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
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!ctx.isIdle() || queue.length === 0) return;

    const entries = queue.splice(0);
    pi.sendUserMessage(entries.map(deliveredMessage).join("\n\n"));
  });
}
