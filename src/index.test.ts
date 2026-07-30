import { describe, expect, it, vi } from "vitest";
import registerCard, { parseTrigger } from "./index.js";

describe("parseTrigger", () => {
  it.each([
    ["**focus on tests", { kind: "interrupt", message: "focus on tests" }],
    ["&&summarize afterward", { kind: "followUp", message: "summarize afterward" }],
    ["??how could we simplify this?", { kind: "brainstorm", message: "how could we simplify this?" }],
  ])("parses %s", (text, expected) => expect(parseTrigger(text)).toEqual(expected));

  it("preserves whitespace inside the message", () => {
    expect(parseTrigger("**  focus here  ")).toEqual({ kind: "interrupt", message: "focus here" });
  });

  it.each(["ordinary message", "*partial", "**   ", "&&", "??"])("ignores invalid input %j", (text) => {
    expect(parseTrigger(text)).toBeUndefined();
  });
});

describe("steering trigger wiring", () => {
  it("interrupts active work and sends the stripped message after agent settles", () => {
    const harness = createHarness(false);
    expect(harness.input({ text: "**focus on tests", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    expect(harness.ctx.abort).toHaveBeenCalledOnce();
    expect(harness.pi.sendUserMessage).not.toHaveBeenCalled();

    harness.setIdle(true);
    harness.settled({}, harness.ctx);
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("focus on tests");
  });

  it("interrupts active work and sends a brainstorming prompt after agent settles", () => {
    const harness = createHarness(false);
    harness.input({ text: "??alternatives to inheritance", source: "interactive" }, harness.ctx);
    harness.setIdle(true);
    harness.settled({}, harness.ctx);
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith(
      "Stop the previous approach. Let's brainstorm alternatives to inheritance before taking further action.",
    );
  });

  it("queues && as a follow-up while active", () => {
    const harness = createHarness(false);
    expect(harness.input({ text: "&&summarize", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("summarize", { deliverAs: "followUp" });
    expect(harness.ctx.abort).not.toHaveBeenCalled();
  });

  it.each([
    ["**focus", "focus"],
    ["&&summarize", "summarize"],
    ["??options", "Let's brainstorm options before taking further action."],
  ])("transforms %s immediately while idle", (text, expected) => {
    const harness = createHarness(true);
    expect(harness.input({ text, source: "interactive" }, harness.ctx)).toEqual({ action: "transform", text: expected });
  });

  it("ignores extension-generated and ordinary messages", () => {
    const harness = createHarness(false);
    expect(harness.input({ text: "**focus", source: "extension" }, harness.ctx)).toEqual({ action: "continue" });
    expect(harness.input({ text: "hello", source: "interactive" }, harness.ctx)).toEqual({ action: "continue" });
  });
});

function createHarness(initialIdle: boolean) {
  let idle = initialIdle;
  const handlers = new Map<string, (...args: any[]) => any>();
  const pi = {
    on: vi.fn((name: string, handler: (...args: any[]) => any) => handlers.set(name, handler)),
    sendUserMessage: vi.fn(),
  };
  const ctx = { isIdle: vi.fn(() => idle), abort: vi.fn(), ui: { notify: vi.fn() } };
  registerCard(pi as any);
  return {
    pi,
    ctx,
    input: handlers.get("input")!,
    settled: handlers.get("agent_settled")!,
    setIdle(value: boolean) { idle = value; },
  };
}
