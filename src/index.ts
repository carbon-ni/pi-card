import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type SteeringTrigger =
  | { kind: "interrupt"; message: string }
  | { kind: "followUp"; message: string }
  | { kind: "brainstorm"; message: string };

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

function interruptedMessage(trigger: SteeringTrigger): string {
  if (trigger.kind === "brainstorm") {
    return `Stop the previous approach. Let's brainstorm ${trigger.message} before taking further action.`;
  }
  return trigger.message;
}

export default function registerCard(pi: ExtensionAPI): void {
  const interruptedMessages: string[] = [];

  pi.on("input", (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };

    const trigger = parseTrigger(event.text);
    if (!trigger) return { action: "continue" };

    if (ctx.isIdle()) {
      return { action: "transform", text: immediateMessage(trigger) };
    }

    if (trigger.kind === "followUp") {
      pi.sendUserMessage(trigger.message, { deliverAs: "followUp" });
      ctx.ui.notify("Follow-up queued", "info");
      return { action: "handled" };
    }

    interruptedMessages.push(interruptedMessage(trigger));
    ctx.abort();
    ctx.ui.notify("Current work interrupted", "warning");
    return { action: "handled" };
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!ctx.isIdle() || interruptedMessages.length === 0) return;

    const message = interruptedMessages.splice(0).join("\n\n");
    pi.sendUserMessage(message);
  });
}
