import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerCard, { parseTrigger } from "./index.js";
import { classifyMessage } from "./router.js";

beforeEach(() => vi.stubEnv("TYPESAFE_API_KEY", ""));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("parseTrigger", async () => {
  it.each([
    ["**focus on tests", { kind: "interrupt", message: "focus on tests" }],
    ["&&summarize afterward", { kind: "followUp", message: "summarize afterward" }],
    ["??how could we simplify this?", { kind: "brainstorm", message: "how could we simplify this?" }],
  ])("parses %s", async (text, expected) => expect(parseTrigger(text)).toEqual(expected));

  it("preserves whitespace inside the message", async () => {
    expect(parseTrigger("**  focus here  ")).toEqual({ kind: "interrupt", message: "focus here" });
  });

  it.each(["ordinary message", "*partial", "**   ", "&&", "??"])("ignores invalid input %j", async (text) => {
    expect(parseTrigger(text)).toBeUndefined();
  });
});

describe("Jev auto-routing", async () => {
  it.each([
    ["stop", 0.97, 0.92, "stop"],
    ["stop", 0.94, 0.99, "unclear"],
    ["steer", 0.7, 0.9, "steer"],
    ["followUp", 0.7, 0.4, "unclear"],
  ])("accepts %s only with confidence policy (%s, %s)", async (choice, stopProbability, confidence, expected) => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ answers: { route: {
        type: "choice", choice, confidence,
        probabilities: {
          stop: stopProbability,
          steer: (1 - stopProbability) / 3,
          followUp: (1 - stopProbability) / 3,
          unclear: (1 - stopProbability) / 3,
        },
      } } }),
    });
    await expect(classifyMessage("please stop", "secret", fetcher as any)).resolves.toBe(expected);
    expect(fetcher).toHaveBeenCalledWith("https://api.typesafe.ai/v1/systemone", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer secret" }),
    }));
  });

  it.each(["Please stop this now", "Por favor, pare agora"]) (
    "classifies raw-language input without adding runtime context: %s",
    async (message) => {
      const fetcher = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ answers: { route: {
          type: "choice", choice: "stop", confidence: 0.99,
          probabilities: { stop: 0.98, steer: 0.01, followUp: 0.005, unclear: 0.005 },
        } } }),
      });
      await classifyMessage(message, "key", fetcher as any);
      const request = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
      expect(request.state).toEqual({ message });
    },
  );

  it("aborts inference at the deadline", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const pending = classifyMessage("hello", "key", fetcher as any);
    const rejected = expect(pending).rejects.toThrow("Aborted");
    await vi.advanceTimersByTimeAsync(1_500);
    await rejected;
    vi.useRealTimers();
  });

  it("fails closed for malformed answers and network errors", async () => {
    await expect(classifyMessage("hello", "key", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as any)).rejects.toThrow();
    const invalidProbabilities = { stop: 1.2, steer: 0, followUp: 0, unclear: 0 };
    await expect(classifyMessage("hello", "key", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ answers: { route: { type: "choice", choice: "stop", confidence: 0.99, probabilities: invalidProbabilities } } }),
    }) as any)).rejects.toThrow("Invalid TypeSafe route answer");
    await expect(classifyMessage("hello", "key", vi.fn().mockRejectedValue(new Error("offline")) as any)).rejects.toThrow("offline");
  });

  it("aborts only for a high-confidence stop and delivers after settling", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ answers: { route: {
        type: "choice", choice: "stop", confidence: 0.99,
        probabilities: { stop: 0.98, steer: 0.01, followUp: 0.005, unclear: 0.005 },
      } } }),
    } as Response);
    const harness = createHarness(false);
    expect(await harness.input({ text: "Stop this now", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    expect(harness.ctx.abort).toHaveBeenCalledOnce();
    expect(harness.pi.sendUserMessage).not.toHaveBeenCalled();
    harness.setIdle(true);
    harness.settled({}, harness.ctx);
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("Stop this now");
  });

  it("preserves prefix-card behavior when Jev is enabled", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    const fetcher = vi.spyOn(globalThis, "fetch");
    const harness = createHarness(false);
    expect(await harness.input({ text: "&&summarize", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    expect(fetcher).not.toHaveBeenCalled();
    harness.setIdle(true);
    harness.settled({}, harness.ctx);
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("summarize");
  });

  it("keeps concurrent input decisions attached to their own text", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    const resolvers: Array<(response: Response) => void> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve); }));
    const harness = createHarness(false);
    const first = harness.input({ text: "correction", source: "interactive" }, harness.ctx);
    const second = harness.input({ text: "extra summary", source: "interactive" }, harness.ctx);
    const answer = (choice: string): Response => ({
      ok: true,
      json: async () => ({ answers: { route: {
        type: "choice", choice, confidence: 0.95,
        probabilities: choice === "steer"
          ? { stop: 0.01, steer: 0.9, followUp: 0.08, unclear: 0.01 }
          : { stop: 0.01, steer: 0.08, followUp: 0.9, unclear: 0.01 },
      } } }),
    } as Response);
    resolvers[1](answer("followUp"));
    resolvers[0](answer("steer"));
    await Promise.all([first, second]);
    expect(harness.pi.sendUserMessage).toHaveBeenNthCalledWith(1, "extra summary", { deliverAs: "followUp" });
    expect(harness.pi.sendUserMessage).toHaveBeenNthCalledWith(2, "correction", { deliverAs: "steer" });
  });

  it("bypasses media input and extension input without making network requests", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    const fetcher = vi.spyOn(globalThis, "fetch");
    const harness = createHarness(false);
    expect(await harness.input({ text: "hello", images: [{}], source: "interactive" }, harness.ctx)).toEqual({ action: "continue" });
    expect(await harness.input({ text: "hello", source: "extension" }, harness.ctx)).toEqual({ action: "continue" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses explicit steer and follow-up delivery for active input", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    const fetcher = vi.spyOn(globalThis, "fetch");
    fetcher.mockImplementation(async (_url, init) => ({
      ok: true,
      json: async () => ({ answers: { route: {
        type: "choice", choice: JSON.parse(String(init?.body)).state.message === "correct this" ? "steer" : "followUp",
        confidence: 0.95, probabilities: { stop: 0.01, steer: 0.9, followUp: 0.08, unclear: 0.01 },
      } } }),
    }) as Response);
    const harness = createHarness(false);
    await harness.input({ text: "correct this", source: "interactive" }, harness.ctx);
    await harness.input({ text: "also summarize", source: "interactive" }, harness.ctx);
    expect(harness.pi.sendUserMessage).toHaveBeenNthCalledWith(1, "correct this", { deliverAs: "steer" });
    expect(harness.pi.sendUserMessage).toHaveBeenNthCalledWith(2, "also summarize", { deliverAs: "followUp" });
    expect(harness.ctx.abort).not.toHaveBeenCalled();
    fetcher.mockRestore();
    vi.unstubAllEnvs();
  });

  it("falls back to native delivery when the inference deadline expires", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const harness = createHarness(false);
    const pending = harness.input({ text: "hello", source: "interactive" }, harness.ctx);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await pending).toEqual({ action: "continue" });
    expect(harness.ctx.abort).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("uses current idle state after inference before choosing delivery", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    let resolveResponse!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((resolve) => { resolveResponse = resolve; }));
    const harness = createHarness(false);
    const pending = harness.input({ text: "correct this", source: "interactive" }, harness.ctx);
    harness.setIdle(true);
    resolveResponse({
      ok: true,
      json: async () => ({ answers: { route: {
        type: "choice", choice: "steer", confidence: 0.95,
        probabilities: { stop: 0.01, steer: 0.9, followUp: 0.08, unclear: 0.01 },
      } } }),
    } as Response);
    expect(await pending).toEqual({ action: "handled" });
    expect(harness.pi.sendUserMessage).toHaveBeenCalledOnce();
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("correct this");
    expect(harness.ctx.abort).not.toHaveBeenCalled();
  });

  it("preserves native input when the key is absent or inference fails", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const harness = createHarness(false);
    expect(await harness.input({ text: "hello", source: "interactive" }, harness.ctx)).toEqual({ action: "continue" });
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("offline"));
    expect(await harness.input({ text: "hello", source: "interactive" }, harness.ctx)).toEqual({ action: "continue" });
    expect(harness.ctx.abort).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
});

describe("steering trigger wiring", () => {
  it("interrupts active work and sends the stripped message after agent settles", async () => {
    const harness = createHarness(false);
    expect(await harness.input({ text: "**focus on tests", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    expect(harness.ctx.abort).toHaveBeenCalledOnce();
    expect(harness.pi.sendUserMessage).not.toHaveBeenCalled();

    harness.setIdle(true);
    harness.settled({}, harness.ctx);
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("focus on tests");
  });

  it("interrupts active work and sends a brainstorming prompt after agent settles", async () => {
    const harness = createHarness(false);
    await harness.input({ text: "??alternatives to inheritance", source: "interactive" }, harness.ctx);
    harness.setIdle(true);
    harness.settled({}, harness.ctx);
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith(
      "Stop the previous approach. Let's brainstorm alternatives to inheritance before taking further action.",
    );
  });

  it("queues && locally while active and delivers it after agent settles", async () => {
    const harness = createHarness(false);
    expect(await harness.input({ text: "&&summarize", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    expect(harness.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(harness.ctx.abort).not.toHaveBeenCalled();

    harness.setIdle(true);
    harness.settled({}, harness.ctx);
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("summarize");
  });

  it("delivers queued cards in the order they were sent", async () => {
    const harness = createHarness(false);
    await harness.input({ text: "&&summarize", source: "interactive" }, harness.ctx);
    await harness.input({ text: "**run tests", source: "interactive" }, harness.ctx);
    harness.setIdle(true);
    harness.settled({}, harness.ctx);
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("summarize\n\nrun tests");
  });

  it.each([
    ["**focus", "focus"],
    ["&&summarize", "summarize"],
    ["??options", "Let's brainstorm options before taking further action."],
  ])("transforms %s immediately while idle", async (text, expected) => {
    const harness = createHarness(true);
    expect(await harness.input({ text, source: "interactive" }, harness.ctx)).toEqual({ action: "transform", text: expected });
  });

  it("ignores extension-generated and ordinary messages", async () => {
    const harness = createHarness(false);
    expect(await harness.input({ text: "**focus", source: "extension" }, harness.ctx)).toEqual({ action: "continue" });
    expect(await harness.input({ text: "hello", source: "interactive" }, harness.ctx)).toEqual({ action: "continue" });
  });
});

describe("~~ flip", () => {
  it("flips the last queued follow-up into a steer without interrupting the agent", async () => {
    const harness = createHarness(false);
    await harness.input({ text: "&&check the diff", source: "interactive" }, harness.ctx);
    harness.ctx.abort.mockClear();

    expect(await harness.input({ text: "~~", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("check the diff", { deliverAs: "steer" });
    expect(harness.ctx.abort).not.toHaveBeenCalled();

    harness.setIdle(true);
    harness.settled({}, harness.ctx);
    expect(harness.pi.sendUserMessage).not.toHaveBeenCalledWith("check the diff");
  });

  it("flips only the most recent card and leaves the rest queued", async () => {
    const harness = createHarness(false);
    await harness.input({ text: "&&first", source: "interactive" }, harness.ctx);
    await harness.input({ text: "&&second", source: "interactive" }, harness.ctx);
    await harness.input({ text: "~~", source: "interactive" }, harness.ctx);

    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("second", { deliverAs: "steer" });

    harness.setIdle(true);
    harness.settled({}, harness.ctx);
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("first");
  });

  it("drains the queue when every follow-up is flipped", async () => {
    const harness = createHarness(false);
    await harness.input({ text: "&&first", source: "interactive" }, harness.ctx);
    await harness.input({ text: "&&second", source: "interactive" }, harness.ctx);
    await harness.input({ text: "~~", source: "interactive" }, harness.ctx);
    await harness.input({ text: "~~", source: "interactive" }, harness.ctx);

    harness.setIdle(true);
    harness.settled({}, harness.ctx);
    expect(harness.pi.sendUserMessage).not.toHaveBeenCalledWith(expect.stringContaining("first"));
  });

  it("refuses to flip an interrupt card because the abort cannot be undone", async () => {
    const harness = createHarness(false);
    await harness.input({ text: "**focus on tests", source: "interactive" }, harness.ctx);
    harness.ctx.abort.mockClear();

    expect(await harness.input({ text: "~~", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    expect(harness.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(harness.ctx.abort).not.toHaveBeenCalled();

    harness.setIdle(true);
    harness.settled({}, harness.ctx);
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("focus on tests");
  });

  it("refuses to flip a brainstorm card", async () => {
    const harness = createHarness(false);
    await harness.input({ text: "??simpler approach", source: "interactive" }, harness.ctx);

    expect(await harness.input({ text: "~~", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    expect(harness.pi.sendUserMessage).not.toHaveBeenCalled();

    harness.setIdle(true);
    harness.settled({}, harness.ctx);
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith(
      "Stop the previous approach. Let's brainstorm simpler approach before taking further action.",
    );
  });

  it("notifies when there is nothing queued to flip", async () => {
    const harness = createHarness(false);
    expect(await harness.input({ text: "~~", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith("Nothing queued to flip", "warning");
    expect(harness.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(harness.ctx.abort).not.toHaveBeenCalled();
  });

  it("passes through messages that merely start with ~~", async () => {
    const harness = createHarness(false);
    expect(await harness.input({ text: "~~like this~~", source: "interactive" }, harness.ctx)).toEqual({ action: "continue" });
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
