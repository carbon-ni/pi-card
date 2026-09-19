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

  it("queues && locally while active and delivers it after agent settles", () => {
    const harness = createHarness(false);
    expect(harness.input({ text: "&&summarize", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    expect(harness.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(harness.ctx.abort).not.toHaveBeenCalled();

    harness.setIdle(true);
    harness.settled({}, harness.ctx);
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("summarize");
  });

  it("delivers queued cards in the order they were sent", () => {
    const harness = createHarness(false);
    harness.input({ text: "&&summarize", source: "interactive" }, harness.ctx);
    harness.input({ text: "**run tests", source: "interactive" }, harness.ctx);
    harness.setIdle(true);
    harness.settled({}, harness.ctx);
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("summarize\n\nrun tests");
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

describe("~~ flip", () => {
  it("flips the last queued follow-up into a steer without interrupting the agent", () => {
    const harness = createHarness(false);
    harness.input({ text: "&&check the diff", source: "interactive" }, harness.ctx);
    harness.ctx.abort.mockClear();

    expect(harness.input({ text: "~~", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("check the diff", { deliverAs: "steer" });
    expect(harness.ctx.abort).not.toHaveBeenCalled();

    harness.setIdle(true);
    harness.settled({}, harness.ctx);
    expect(harness.pi.sendUserMessage).not.toHaveBeenCalledWith("check the diff");
  });

  it("flips only the most recent card and leaves the rest queued", () => {
    const harness = createHarness(false);
    harness.input({ text: "&&first", source: "interactive" }, harness.ctx);
    harness.input({ text: "&&second", source: "interactive" }, harness.ctx);
    harness.input({ text: "~~", source: "interactive" }, harness.ctx);

    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("second", { deliverAs: "steer" });

    harness.setIdle(true);
    harness.settled({}, harness.ctx);
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("first");
  });

  it("drains the queue when every follow-up is flipped", () => {
    const harness = createHarness(false);
    harness.input({ text: "&&first", source: "interactive" }, harness.ctx);
    harness.input({ text: "&&second", source: "interactive" }, harness.ctx);
    harness.input({ text: "~~", source: "interactive" }, harness.ctx);
    harness.input({ text: "~~", source: "interactive" }, harness.ctx);

    harness.setIdle(true);
    harness.settled({}, harness.ctx);
    expect(harness.pi.sendUserMessage).not.toHaveBeenCalledWith(expect.stringContaining("first"));
  });

  it("refuses to flip an interrupt card because the abort cannot be undone", () => {
    const harness = createHarness(false);
    harness.input({ text: "**focus on tests", source: "interactive" }, harness.ctx);
    harness.ctx.abort.mockClear();

    expect(harness.input({ text: "~~", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    expect(harness.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(harness.ctx.abort).not.toHaveBeenCalled();

    harness.setIdle(true);
    harness.settled({}, harness.ctx);
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("focus on tests");
  });

  it("refuses to flip a brainstorm card", () => {
    const harness = createHarness(false);
    harness.input({ text: "??simpler approach", source: "interactive" }, harness.ctx);

    expect(harness.input({ text: "~~", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    expect(harness.pi.sendUserMessage).not.toHaveBeenCalled();

    harness.setIdle(true);
    harness.settled({}, harness.ctx);
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith(
      "Stop the previous approach. Let's brainstorm simpler approach before taking further action.",
    );
  });

  it("notifies when there is nothing queued to flip", () => {
    const harness = createHarness(false);
    expect(harness.input({ text: "~~", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith("Nothing queued to flip", "warning");
    expect(harness.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(harness.ctx.abort).not.toHaveBeenCalled();
  });

  it("passes through messages that merely start with ~~", () => {
    const harness = createHarness(false);
    expect(harness.input({ text: "~~like this~~", source: "interactive" }, harness.ctx)).toEqual({ action: "continue" });
    expect(harness.pi.sendUserMessage).not.toHaveBeenCalled();
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
