import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

  pi.on("input", (event, ctx) => {
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
    if (!trigger) return { action: "continue" };

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
