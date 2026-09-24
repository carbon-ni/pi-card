import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerCard, { parseTrigger } from "./index.js";
import { classifyMessage, classifyMessageDetailed } from "./router.js";
import { debounceDelayFromEnv } from "./debounce.js";
import { loadRoutingExamples, routingExamplesPath } from "./routing-examples.js";
import { INTERVENTION_EVIDENCE_TYPE } from "./intervention-evidence.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

beforeEach(() => {
  vi.stubEnv("TYPESAFE_API_KEY", "");
  vi.stubEnv("PI_CARD_DEBUG", "false");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
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

describe("routing examples config", () => {
  it("resolves config under Pi's configured agent directory", () => {
    expect(routingExamplesPath("/custom/pi-agent")).toBe("/custom/pi-agent/pi-card.json");
  });

  it("rejects oversized files before parsing", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-card-"));
    const path = join(dir, "config.json");
    writeFileSync(path, " ".repeat(32_001));
    try { expect(() => loadRoutingExamples(path)).toThrow("exceeds size limit"); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("sends examples as structured context, not instructions", async () => {
    const fetcher = vi.fn().mockResolvedValue(routeResponse("steer"));
    await classifyMessageDetailed("fix that now", "key", fetcher as any, [{ text: "please correct this", route: "steer" }]);
    const request = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(request.state).toEqual({ message: "fix that now", examples: [{ message: "please correct this", expectedRoute: "steer" }] });
  });

  it("loads valid labeled examples", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-card-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ examples: [{ text: "hold this thought", route: "followUp" }] }));
    try {
      expect(loadRoutingExamples(path)).toEqual([{ text: "hold this thought", route: "followUp" }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([
    { examples: [{ text: "", route: "steer" }] },
    { examples: [{ text: "hello", route: "unclear" }] },
    { examples: [{ text: "same", route: "steer" }, { text: " SAME ", route: "stop" }] },
  ])("rejects invalid config safely", (config) => {
    const dir = mkdtempSync(join(tmpdir(), "pi-card-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(config));
    try { expect(() => loadRoutingExamples(path)).toThrow(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("Jev auto-routing", () => {
  it.each([
    [undefined, 600],
    ["", 600],
    ["0", 600],
    ["abc", 600],
    ["75", 75],
    ["9000", 5000],
  ])("uses a bounded debounce delay for %j", (value, expected) => {
    expect(debounceDelayFromEnv(value)).toBe(expected);
  });

  it("routes with configured examples and keeps them out of diagnostics", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-card-agent-"));
    writeFileSync(join(dir, "pi-card.json"), JSON.stringify({ examples: [{ text: "private example phrase", route: "steer" }] }));
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("PI_CARD_DEBUG", "true");
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("steer"));
    const harness = createHarness(false);
    try {
      await harness.input({ text: "private current message", source: "interactive" }, harness.ctx);
      const request = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
      expect(request.state.examples).toEqual([{ message: "private example phrase", expectedRoute: "steer" }]);
      expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("private current message", { deliverAs: "steer" });
      const diagnostics = JSON.stringify(harness.pi.appendEntry.mock.calls);
      expect(diagnostics).not.toContain("private example phrase");
      expect(diagnostics).not.toContain("private current message");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("ignores invalid config as a whole and preserves baseline request behavior", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-card-agent-"));
    writeFileSync(join(dir, "pi-card.json"), JSON.stringify({ examples: [{ text: "valid row", route: "steer" }, { text: "invalid row", route: "bad" }] }));
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("steer"));
    const harness = createHarness(false);
    try {
      await harness.input({ text: "current text", source: "interactive" }, harness.ctx);
      expect(warning).toHaveBeenCalledWith("[pi-card] Invalid routing config; using default Jev routing.");
      expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).state).toEqual({ message: "current text" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("waits until session_start before writing load diagnostics", async () => {
    vi.stubEnv("PI_CARD_DEBUG", "true");
    const harness = createHarness(false);
    expect(harness.pi.appendEntry).not.toHaveBeenCalled();
    expect(() => harness.pi.appendEntry("probe", {})).toThrow("Action methods cannot be called during extension loading");
    harness.pi.appendEntry.mockClear();

    await harness.startSession("startup");
    await harness.startSession("reload");

    expect(harness.pi.appendEntry).toHaveBeenNthCalledWith(1, "pi-card.routing", expect.objectContaining({ event: "session_start", reason: "startup" }));
    expect(harness.pi.appendEntry).toHaveBeenNthCalledWith(2, "pi-card.routing", expect.objectContaining({ event: "session_start", reason: "reload" }));
  });

  it("writes privacy-safe structured routing diagnostics when debugging is enabled", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "private-api-key");
    vi.stubEnv("PI_CARD_DEBUG", "true");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("stop"));
    const harness = createHarness(false);
    await harness.startSession();

    expect(await harness.input({ text: "private user text", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });

    const entries = harness.pi.appendEntry.mock.calls.map(([, data]) => data);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "session_start", apiKeyConfigured: true, debounceEnabled: false }),
      expect.objectContaining({ event: "input", branch: "immediate_interactive" }),
      expect.objectContaining({ event: "route", choice: "stop", outcome: "stop", confidence: 0.99 }),
      expect.objectContaining({ event: "action", action: "abort_and_queue", kind: "interrupt" }),
    ]));
    const routeEntry = entries.find((entry: any) => entry.event === "route") as any;
    const actionEntry = entries.find((entry: any) => entry.action === "abort_and_queue") as any;
    expect(actionEntry.routeId).toBe(routeEntry.routeId);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("private user text");
    expect(serialized).not.toContain("private-api-key");
  });

  it("logs confidence-policy downgrades without logging message details", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("PI_CARD_DEBUG", "true");
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ answers: { route: { type: "choice", choice: "stop", confidence: 0.7, probabilities: { stop: 0.97, steer: 0.01, followUp: 0.01, unclear: 0.01 } } } }),
    } as Response);
    const harness = createHarness(false);
    await harness.startSession();
    await harness.input({ text: "sensitive message", source: "interactive" }, harness.ctx);
    const entries = harness.pi.appendEntry.mock.calls.map(([, data]) => data);
    expect(entries).toContainEqual(expect.objectContaining({ event: "route", choice: "stop", outcome: "unclear", policy: "downgraded", confidence: 0.7 }));
    expect(JSON.stringify(entries)).not.toContain("sensitive message");
  });

  it("logs timeout as a safe failure category", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("PI_CARD_DEBUG", "true");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("private detail", "AbortError"));
    const harness = createHarness(false);
    await harness.startSession();
    await harness.input({ text: "sensitive message", source: "interactive" }, harness.ctx);
    expect(JSON.stringify(harness.pi.appendEntry.mock.calls)).toContain('"failure":"timeout"');
    expect(JSON.stringify(harness.pi.appendEntry.mock.calls)).not.toContain("private detail");
  });

  it("records prefix and bypass branches without message text", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("PI_CARD_DEBUG", "true");
    const harness = createHarness(false);
    await harness.startSession();
    await harness.input({ text: "**private prefix body", source: "interactive" }, harness.ctx);
    await harness.input({ text: "private attachment body", images: [{}], source: "interactive" }, harness.ctx);
    await harness.input({ text: "private extension body", source: "extension" }, harness.ctx);
    const entries = harness.pi.appendEntry.mock.calls.map(([, data]) => data);
    expect(entries).toContainEqual(expect.objectContaining({ event: "input", branch: "prefix", kind: "interrupt" }));
    expect(entries).toContainEqual(expect.objectContaining({ event: "input", branch: "attachment_bypass" }));
    expect(entries).toContainEqual(expect.objectContaining({ event: "input", branch: "extension_bypass" }));
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("private prefix body");
    expect(serialized).not.toContain("private attachment body");
    expect(serialized).not.toContain("private extension body");
  });

  it("does not let a failing diagnostic sink affect routing", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("PI_CARD_DEBUG", "true");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("steer"));
    const harness = createHarness(false);
    await harness.startSession();
    harness.pi.appendEntry.mockImplementation(() => { throw new Error("diagnostic sink failed"); });
    expect(await harness.input({ text: "fix this", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("fix this", { deliverAs: "steer" });
  });

  it("keeps routing diagnostics disabled by default", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("steer"));
    const harness = createHarness(false);
    await harness.input({ text: "do not log this", source: "interactive" }, harness.ctx);
    expect(harness.pi.appendEntry).not.toHaveBeenCalled();
  });

  it("logs classifier failure category without raw error details", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "private-api-key");
    vi.stubEnv("PI_CARD_DEBUG", "true");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("secret error text"));
    const harness = createHarness(false);
    await harness.startSession();
    expect(await harness.input({ text: "private user text", source: "interactive" }, harness.ctx)).toEqual({ action: "continue" });
    const serialized = JSON.stringify(harness.pi.appendEntry.mock.calls);
    expect(serialized).toContain('"failure":"classifier_error"');
    expect(serialized).not.toContain("private user text");
    expect(serialized).not.toContain("private-api-key");
    expect(serialized).not.toContain("secret error text");
  });

  it("debounces partial English and Portuguese messages until a quiet gap", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("PI_CARD_DEBOUNCE_ENABLED", "true");
    vi.stubEnv("PI_CARD_DEBOUNCE_MS", "600");
    vi.useFakeTimers();
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("followUp"));
    const harness = createHarness(false);

    expect(await harness.input({ text: "Can you help me", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    await vi.advanceTimersByTimeAsync(400);
    expect(await harness.input({ text: "resolver isto?", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    await vi.advanceTimersByTimeAsync(599);
    expect(fetcher).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    const request = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(request.state.message).toBe("Can you help me\n\nresolver isto?");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(harness.pi.sendUserMessage).toHaveBeenCalledOnce();
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("Can you help me\n\nresolver isto?", { deliverAs: "followUp" });
  });

  it("keeps debounce disabled without a key and preserves immediate Jev routing by default", async () => {
    vi.stubEnv("PI_CARD_DEBOUNCE_ENABLED", "true");
    const harness = createHarness(false);
    expect(await harness.input({ text: "hello", source: "interactive" }, harness.ctx)).toEqual({ action: "continue" });
    expect(harness.pi.sendUserMessage).not.toHaveBeenCalled();

    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("PI_CARD_DEBOUNCE_ENABLED", "false");
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("steer"));
    const keyed = createHarness(false);
    expect(await keyed.input({ text: "fix this", source: "interactive" }, keyed.ctx)).toEqual({ action: "handled" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(keyed.pi.sendUserMessage).toHaveBeenCalledWith("fix this", { deliverAs: "steer" });
  });

  it("delivers one combined message when idle routing is unclear", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("PI_CARD_DEBOUNCE_ENABLED", "true");
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("unclear"));
    const harness = createHarness(true);
    expect(await harness.input({ text: "some partial", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    expect(await harness.input({ text: "ordinary thought", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    await vi.advanceTimersByTimeAsync(600);
    expect(harness.pi.sendUserMessage).toHaveBeenCalledOnce();
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("some partial\n\nordinary thought");
    expect(harness.ctx.abort).not.toHaveBeenCalled();
  });

  it("uses current idle state when the debounce interval expires", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("PI_CARD_DEBOUNCE_ENABLED", "true");
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("stop"));
    const harness = createHarness(false);
    expect(await harness.input({ text: "stop this", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    harness.setIdle(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(harness.ctx.abort).not.toHaveBeenCalled();
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("stop this");
  });

  it.each([
    [{ text: "attachment", images: [{}], source: "interactive" }],
    [{ text: "extension message", source: "extension" }],
  ])("flushes buffered text before bypass input %j", async (bypassEvent) => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("PI_CARD_DEBOUNCE_ENABLED", "true");
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("steer"));
    const harness = createHarness(false);
    expect(await harness.input({ text: "buffered", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    expect(await harness.input(bypassEvent, harness.ctx)).toEqual({ action: "continue" });
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("buffered", { deliverAs: "steer" });
  });

  it("routes oversized input after the earlier buffered batch", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("PI_CARD_DEBOUNCE_ENABLED", "true");
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("followUp"));
    const harness = createHarness(false);
    expect(await harness.input({ text: "earlier input", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    const oversized = "x".repeat(16_001);
    expect(await harness.input({ text: oversized, source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const sent = fetcher.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).state.message);
    expect(sent).toEqual(["earlier input", oversized]);
  });

  it("keeps input after oversized text behind it while earlier routing is pending", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("PI_CARD_DEBOUNCE_ENABLED", "true");
    vi.useFakeTimers();
    const resolvers: Array<(response: Response) => void> = [];
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    const harness = createHarness(false);
    expect(await harness.input({ text: "first", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    const oversized = "x".repeat(16_001);
    expect(await harness.input({ text: oversized, source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    expect(await harness.input({ text: "third", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });

    await vi.advanceTimersByTimeAsync(600);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).state.message).toBe("first");
    resolvers[0](routeResponse("followUp"));

    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).state.message).toBe(oversized);
    resolvers[1](routeResponse("followUp"));

    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body)).state.message).toBe("third");
    resolvers[2](routeResponse("followUp"));
  });

  it("flushes and clears the pending timer during session shutdown", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("PI_CARD_DEBOUNCE_ENABLED", "true");
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("followUp"));
    const harness = createHarness(false);
    expect(await harness.input({ text: "pending before shutdown", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    expect(vi.getTimerCount()).toBe(1);
    await harness.shutdown({}, harness.ctx);
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("pending before shutdown", { deliverAs: "followUp" });
  });

  it("does not deadlock when routed delivery re-enters as extension input", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("PI_CARD_DEBOUNCE_ENABLED", "true");
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("steer"));
    const harness = createHarness(false);
    harness.pi.sendUserMessage.mockImplementation(async (text: string) => {
      expect(await harness.input({ text, source: "extension" }, harness.ctx)).toEqual({ action: "continue" });
    });
    expect(await harness.input({ text: "deliver this", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    await vi.advanceTimersByTimeAsync(600);
    expect(harness.pi.sendUserMessage).toHaveBeenCalledOnce();
  });

  it("waits for an in-flight batch before processing a prefix card", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("PI_CARD_DEBOUNCE_ENABLED", "true");
    vi.useFakeTimers();
    let resolveRoute!: (response: Response) => void;
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((resolve) => { resolveRoute = resolve; }));
    const harness = createHarness(false);
    expect(await harness.input({ text: "earlier", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    await vi.advanceTimersByTimeAsync(600);
    expect(fetcher).toHaveBeenCalledOnce();

    let cardHandled = false;
    const card = harness.input({ text: "&&later", source: "interactive" }, harness.ctx).then((result: { action: string }) => {
      cardHandled = true;
      return result;
    });
    await Promise.resolve();
    expect(cardHandled).toBe(false);

    resolveRoute(routeResponse("steer"));
    expect(await card).toEqual({ action: "handled" });
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("earlier", { deliverAs: "steer" });
    harness.setIdle(true);
    harness.settled({}, harness.ctx);
    expect(harness.pi.sendUserMessage).toHaveBeenNthCalledWith(2, "later");
  });

  it("flushes debounced text before prefix-card input", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("PI_CARD_DEBOUNCE_ENABLED", "true");
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("steer"));
    const harness = createHarness(false);
    expect(await harness.input({ text: "first text", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    expect(await harness.input({ text: "&&later", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    expect(harness.pi.sendUserMessage).toHaveBeenNthCalledWith(1, "first text", { deliverAs: "steer" });
    harness.setIdle(true);
    harness.settled({}, harness.ctx);
    expect(harness.pi.sendUserMessage).toHaveBeenNthCalledWith(2, "later");
  });

  it("flushes the whole batch on inference failure without aborting", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("PI_CARD_DEBOUNCE_ENABLED", "true");
    vi.useFakeTimers();
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const harness = createHarness(false);
    expect(await harness.input({ text: "partial one", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    expect(await harness.input({ text: "partial two", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    await vi.advanceTimersByTimeAsync(600);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(harness.pi.sendUserMessage).toHaveBeenCalledOnce();
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("partial one\n\npartial two", { deliverAs: "steer" });
    expect(harness.ctx.abort).not.toHaveBeenCalled();
  });

  it("falls back once with the combined text when a debounced request times out", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("PI_CARD_DEBOUNCE_ENABLED", "true");
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const harness = createHarness(false);
    expect(await harness.input({ text: "combine this", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    expect(await harness.input({ text: "please", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(harness.pi.sendUserMessage).toHaveBeenCalledOnce();
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("combine this\n\nplease", { deliverAs: "steer" });
    expect(harness.ctx.abort).not.toHaveBeenCalled();
  });

  it("applies stop routing once to a combined active batch", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("PI_CARD_DEBOUNCE_ENABLED", "true");
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("stop"));
    const harness = createHarness(false);
    expect(await harness.input({ text: "Stop", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    expect(await harness.input({ text: "right now", source: "interactive" }, harness.ctx)).toEqual({ action: "handled" });
    await vi.advanceTimersByTimeAsync(600);
    expect(harness.ctx.abort).toHaveBeenCalledOnce();
    expect(harness.pi.sendUserMessage).not.toHaveBeenCalled();
    harness.setIdle(true);
    harness.settled({}, harness.ctx);
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("Stop\n\nright now");
  });
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
    await expect(classifyMessage("hello", "key", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ answers: { route: {
        type: "choice", choice: "stop", confidence: 1.1,
        probabilities: { stop: 1, steer: 0, followUp: 0, unclear: 0 },
      } } }),
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
    await Promise.resolve();
    const answer = (choice: string): Response => ({
      ok: true,
      json: async () => ({ answers: { route: {
        type: "choice", choice, confidence: 0.95,
        probabilities: choice === "steer"
          ? { stop: 0.01, steer: 0.9, followUp: 0.08, unclear: 0.01 }
          : { stop: 0.01, steer: 0.08, followUp: 0.9, unclear: 0.01 },
      } } }),
    } as Response);
    expect(resolvers).toHaveLength(1);
    resolvers[0](answer("steer"));
    await first;
    expect(resolvers).toHaveLength(2);
    resolvers[1](answer("followUp"));
    await second;
    expect(harness.pi.sendUserMessage).toHaveBeenNthCalledWith(1, "correction", { deliverAs: "steer" });
    expect(harness.pi.sendUserMessage).toHaveBeenNthCalledWith(2, "extra summary", { deliverAs: "followUp" });
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
    await Promise.resolve();
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

describe("prospective intervention capture", () => {
  beforeEach(() => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
  });

  it("requires an explicit session-scoped opt-in after session startup", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("steer"));
    const harness = createHarness(false);

    await harness.command("pi-card-capture", "on");
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith("Pi Card capture is available after the session starts", "warning");
    await harness.startSession();
    harness.setIdle(true);
    await harness.command("pi-card-capture", "on");
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Pi Card capture is on for this session; persisted-message metadata only",
      "info",
    );
    harness.setIdle(false);
    harness.addBranchEntry({ id: "active-leaf", type: "message", parentId: "task", message: { role: "assistant" } });
    await harness.agentStart({}, harness.ctx);
    await harness.input({ text: "private intervention text", source: "interactive", streamingBehavior: "followUp" }, harness.ctx);
    await completeCapturedTurn(harness, "captured-user");

    const marker = markerFor(harness);
    expect(marker).toBeDefined();
    expect(marker.parentId).toBe("captured-user");
    expect(marker.data).toEqual({
      schemaVersion: 3,
      source: "interactive",
      activeAtInput: true,
      streamingBehavior: "followUp",
      taskAnchorEntryId: "task",
      inputLeafEntryId: "active-leaf",
      inputKind: "jevRouted",
      observedAction: "send",
      deliveryAtPersistence: "steer",
    });
    expect(JSON.stringify(marker.data)).not.toContain("private intervention text");
    expect(JSON.stringify(marker.data)).not.toMatch(/hash|fingerprint|text/i);
  });

  it("rejects opt-in commands outside the interactive TUI", async () => {
    const harness = createHarness(true);
    await harness.startSession();
    harness.ctx.mode = "rpc";
    await harness.command("pi-card-capture", "on");
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
      "Pi Card capture can only be controlled from the interactive TUI",
      "warning",
    );
    harness.ctx.mode = "tui";
    harness.ctx.isIdle.mockReturnValue(false);
    await harness.command("pi-card-capture", "on");
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith("Enable Pi Card capture only while the agent is idle", "warning");
  });

  it("requires human confirmation even when an extension invokes the capture command", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("steer"));
    const harness = createHarness(false);
    await harness.startSession();
    harness.setIdle(true);
    harness.ctx.ui.confirm.mockResolvedValueOnce(false);
    await harness.command("pi-card-capture", "on");
    expect(harness.ctx.ui.confirm).toHaveBeenCalledOnce();
    expect(harness.ctx.ui.confirm).toHaveBeenCalledWith(
      "Enable prospective Pi Card capture?",
      expect.stringContaining("while Pi is idle or active"),
    );
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith("Pi Card capture remains off; confirmation is required", "info");

    harness.setIdle(false);
    harness.addBranchEntry({ id: "active-leaf", type: "message", parentId: "task", message: { role: "assistant" } });
    await harness.agentStart({}, harness.ctx);
    await harness.input({ text: "private intervention text", source: "interactive" }, harness.ctx);
    await completeCapturedTurn(harness, "unconfirmed-user");
    expect(markerFor(harness)).toBeUndefined();
  });

  it("keeps capture off by default", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("steer"));
    const harness = createHarness(false);
    await harness.startSession();
    await harness.agentStart({}, harness.ctx);
    await harness.input({ text: "private intervention text", source: "interactive" }, harness.ctx);
    await completeCapturedTurn(harness, "uncaptured-user");
    expect(markerFor(harness)).toBeUndefined();
  });

  it("captures idle Jev-routed text with no active task anchor", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("steer"));
    const harness = createHarness(true);
    await enableCaptureAtIdle(harness);
    await harness.input({ text: "idle routed message", source: "interactive" }, harness.ctx);
    await persistIdleMessage(harness, "idle-routed-user", "idle routed message", "task");

    expect(markerFor(harness).data).toEqual({
      schemaVersion: 3,
      source: "interactive",
      activeAtInput: false,
      streamingBehavior: null,
      taskAnchorEntryId: null,
      inputLeafEntryId: "task",
      inputKind: "jevRouted",
      observedAction: "send",
      deliveryAtPersistence: "normal",
    });
  });

  it("captures the final persisted text after an idle prefix transform from an empty session", async () => {
    const harness = createHarness(true);
    await enableCaptureAtIdle(harness, true);
    const result = await harness.input({ text: "?? simplify this", source: "interactive" }, harness.ctx);
    const persistedText = "Let's brainstorm simplify this before taking further action.";
    expect(result).toEqual({ action: "transform", text: persistedText });
    await persistIdleMessage(harness, "first-idle-user", "host-normalized brainstorm text", null);

    expect(markerFor(harness).data).toEqual({
      schemaVersion: 3,
      source: "interactive",
      activeAtInput: false,
      streamingBehavior: null,
      taskAnchorEntryId: null,
      inputLeafEntryId: null,
      inputKind: "brainstormCard",
      observedAction: "transform",
      deliveryAtPersistence: "normal",
    });
  });

  it.each([
    ["** stop this", "stop this", "interruptCard"],
    ["&& add a follow-up", "add a follow-up", "followUpCard"],
  ])("captures idle prefix %s as a transform", async (typed, persistedText, inputKind) => {
    const harness = createHarness(true);
    await enableCaptureAtIdle(harness);
    expect(await harness.input({ text: typed, source: "interactive" }, harness.ctx))
      .toEqual({ action: "transform", text: persistedText });
    await persistIdleMessage(harness, "idle-prefix-user", persistedText, "task");
    expect(markerFor(harness).data).toMatchObject({
      activeAtInput: false,
      taskAnchorEntryId: null,
      inputLeafEntryId: "task",
      inputKind,
      observedAction: "transform",
      deliveryAtPersistence: "normal",
    });
  });

  it("captures idle Jev delivery across Pi Card debug entries", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "key");
    vi.stubEnv("PI_CARD_DEBUG", "true");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("steer"));
    const harness = createHarness(true);
    await enableCaptureAtIdle(harness);
    await harness.input({ text: "private idle input", source: "interactive" }, harness.ctx);
    await persistIdleMessage(harness, "debug-idle-user", "private idle input", harness.getBranch().at(-1).id);
    expect(markerFor(harness).data).toMatchObject({
      activeAtInput: false,
      inputKind: "jevRouted",
      observedAction: "send",
      deliveryAtPersistence: "normal",
    });
  });

  it("captures idle prefix transforms across Pi Card debug entries", async () => {
    vi.stubEnv("PI_CARD_DEBUG", "true");
    const harness = createHarness(true);
    await enableCaptureAtIdle(harness);
    const result = await harness.input({ text: "?? brainstorm", source: "interactive" }, harness.ctx);
    expect(result.action).toBe("transform");
    await persistIdleMessage(harness, "debug-prefix-user", result.text, harness.getBranch().at(-1).id);
    expect(markerFor(harness).data).toMatchObject({
      activeAtInput: false,
      inputKind: "brainstormCard",
      observedAction: "transform",
      deliveryAtPersistence: "normal",
    });
  });

  it("captures an empty-session transform through debug entries back to the null root", async () => {
    vi.stubEnv("PI_CARD_DEBUG", "true");
    const harness = createHarness(true);
    await enableCaptureAtIdle(harness, true);
    const result = await harness.input({ text: "?? brainstorm", source: "interactive" }, harness.ctx);
    expect(result.action).toBe("transform");
    await persistIdleMessage(harness, "debug-empty-user", result.text, harness.getBranch().at(-1).id);
    expect(markerFor(harness).data).toMatchObject({
      activeAtInput: false,
      taskAnchorEntryId: null,
      inputLeafEntryId: null,
      inputKind: "brainstormCard",
      observedAction: "transform",
    });
  });

  it("captures idle native continuation only after Jev returns unclear", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("unclear"));
    const harness = createHarness(true);
    await enableCaptureAtIdle(harness);
    expect(await harness.input({ text: "not clear enough to route", source: "interactive" }, harness.ctx))
      .toEqual({ action: "continue" });
    await persistIdleMessage(harness, "unclear-user", "not clear enough to route", "task");

    expect(markerFor(harness).data).toMatchObject({
      activeAtInput: false,
      taskAnchorEntryId: null,
      inputKind: "jevRouted",
      observedAction: "continue",
      deliveryAtPersistence: "normal",
    });
  });

  it("does not capture after opt-out clears a pending candidate", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("steer"));
    const harness = createHarness(false);
    await enableCapture(harness);
    await harness.agentStart({}, harness.ctx);
    await harness.input({ text: "private intervention text", source: "interactive" }, harness.ctx);
    await harness.command("pi-card-capture", "off");
    await completeCapturedTurn(harness, "uncaptured-user");
    expect(markerFor(harness)).toBeUndefined();
  });

  it("fails closed when duplicate inputs create concurrent candidates", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("steer"));
    const harness = createHarness(false);
    await enableCapture(harness);
    await harness.agentStart({}, harness.ctx);
    await harness.input({ text: "same private input", source: "interactive" }, harness.ctx);
    await harness.input({ text: "same private input", source: "interactive" }, harness.ctx);
    await completeCapturedTurn(harness, "ambiguous-user");
    expect(markerFor(harness)).toBeUndefined();
  });

  it("fails closed when an earlier extension transforms the internal input", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("steer"));
    const harness = createHarness(false);
    await enableCapture(harness);
    await harness.agentStart({}, harness.ctx);
    harness.pi.sendUserMessage.mockImplementationOnce(async (text: string) => {
      await harness.input({ text: `transformed ${text}`, source: "extension" }, harness.ctx);
    });

    await harness.input({ text: "private intervention text", source: "interactive" }, harness.ctx);
    await completeCapturedTurn(harness, "early-transform-user", "transformed private intervention text");
    expect(markerFor(harness)).toBeUndefined();
  });

  it("fails closed when same-text extension inputs interleave with Pi Card delivery", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("steer"));
    const harness = createHarness(false);
    await enableCapture(harness);
    await harness.agentStart({}, harness.ctx);
    harness.pi.sendUserMessage.mockImplementation(async (text: string) => {
      await harness.input({ text, source: "extension" }, harness.ctx);
      await harness.input({ text, source: "extension" }, harness.ctx);
    });

    await harness.input({ text: "same private input", source: "interactive" }, harness.ctx);
    await completeCapturedTurn(harness, "same-text-user");
    expect(markerFor(harness)).toBeUndefined();
  });

  it("fails closed for queue batches instead of linking one row to several inputs", async () => {
    const harness = createHarness(false);
    await enableCapture(harness);
    await harness.agentStart({}, harness.ctx);
    await harness.input({ text: "&& first private item", source: "interactive" }, harness.ctx);
    await harness.input({ text: "&& second private item", source: "interactive" }, harness.ctx);
    harness.setIdle(true);
    await harness.settled({}, harness.ctx);
    await completeCapturedTurn(harness, "combined-user");
    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("first private item\n\nsecond private item");
    expect(markerFor(harness)).toBeUndefined();
  });

  it("captures a single queued prefix follow-up after settlement", async () => {
    const harness = createHarness(false);
    await enableCapture(harness);
    await harness.agentStart({}, harness.ctx);
    await harness.input({ text: "&& summarize privately", source: "interactive" }, harness.ctx);
    harness.setIdle(true);
    await harness.settled({}, harness.ctx);
    await completeCapturedTurn(harness, "followup-user", "summarize privately");

    expect(markerFor(harness).data).toEqual({
      schemaVersion: 3,
      source: "interactive",
      activeAtInput: true,
      streamingBehavior: null,
      taskAnchorEntryId: "task",
      inputLeafEntryId: "active-leaf",
      inputKind: "followUpCard",
      observedAction: "queued_followUp",
      deliveryAtPersistence: "normal",
    });
  });

  it("records a flipped follow-up as a steer", async () => {
    const harness = createHarness(false);
    await enableCapture(harness);
    await harness.agentStart({}, harness.ctx);
    await harness.input({ text: "&& summarize privately", source: "interactive" }, harness.ctx);
    await harness.input({ text: "~~", source: "interactive" }, harness.ctx);
    await completeCapturedTurn(harness, "flipped-user", "summarize privately");

    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("summarize privately", { deliverAs: "steer" });
    expect(markerFor(harness).data).toMatchObject({
      schemaVersion: 3,
      inputLeafEntryId: "active-leaf",
      inputKind: "followUpCard",
      observedAction: "queued_followUp",
      deliveryAtPersistence: "steer",
    });
  });

  it("records a stop only after the queued delivery has a persisted user entry", async () => {
    const harness = createHarness(false);
    await enableCapture(harness);
    await harness.agentStart({}, harness.ctx);
    await harness.input({ text: "** stop privately", source: "interactive" }, harness.ctx);
    expect(harness.ctx.abort).toHaveBeenCalledOnce();
    harness.setIdle(true);
    await harness.settled({}, harness.ctx);
    await completeCapturedTurn(harness, "stop-user", "stop privately");

    expect(harness.pi.sendUserMessage).toHaveBeenCalledWith("stop privately");
    expect(markerFor(harness).data).toMatchObject({
      schemaVersion: 3,
      inputLeafEntryId: "active-leaf",
      inputKind: "interruptCard",
      observedAction: "abort_requested",
      deliveryAtPersistence: "normal",
    });
  });

  it("does not mark a queued card until its user message is persisted", async () => {
    const harness = createHarness(false);
    await enableCapture(harness);
    await harness.agentStart({}, harness.ctx);
    await harness.input({ text: "&& not delivered yet", source: "interactive" }, harness.ctx);

    expect(harness.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(markerFor(harness)).toBeUndefined();
  });

  it("captures an active brainstorm card by its exact persisted delivery", async () => {
    const harness = createHarness(false);
    await enableCapture(harness);
    await harness.agentStart({}, harness.ctx);
    await harness.input({ text: "?? explore a smaller change", source: "interactive" }, harness.ctx);
    const persistedText = "Stop the previous approach. Let's brainstorm explore a smaller change before taking further action.";
    harness.setIdle(true);
    await harness.settled({}, harness.ctx);
    await completeCapturedTurn(harness, "brainstorm-user", persistedText);

    expect(markerFor(harness).data).toMatchObject({
      inputKind: "brainstormCard",
      observedAction: "abort_requested",
      deliveryAtPersistence: "normal",
    });
  });

  it("captures debounce-combined routed inputs as the single persisted candidate", async () => {
    vi.stubEnv("PI_CARD_DEBOUNCE_ENABLED", "true");
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("steer"));
    const harness = createHarness(false);
    await enableCapture(harness);
    await harness.agentStart({}, harness.ctx);
    await harness.input({ text: "first private message", source: "interactive" }, harness.ctx);
    await harness.input({ text: "second private message", source: "interactive" }, harness.ctx);
    await vi.advanceTimersByTimeAsync(600);
    await completeCapturedTurn(harness, "debounced-user", "first private message\n\nsecond private message");
    expect(markerFor(harness).data).toMatchObject({
      inputKind: "jevRouted",
      observedAction: "send",
      deliveryAtPersistence: "steer",
    });
  });

  it("associates the persisted text after a downstream extension transforms delivery", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("steer"));
    const harness = createHarness(false);
    await enableCapture(harness);
    await harness.agentStart({}, harness.ctx);
    let persistedText = "";
    harness.pi.sendUserMessage.mockImplementationOnce(async (text: string) => {
      const result = await harness.input({ text, source: "extension" }, harness.ctx);
      expect(result).toEqual({ action: "continue" });
      const downstreamTransform = { action: "transform", text: `transformed ${text}` };
      if (downstreamTransform.action === "transform") persistedText = downstreamTransform.text;
    });
    await harness.input({ text: "private intervention text", source: "interactive" }, harness.ctx);
    await completeCapturedTurn(harness, "transformed-user", persistedText);
    expect(markerFor(harness).data).toMatchObject({
      inputKind: "jevRouted",
      observedAction: "send",
      deliveryAtPersistence: "steer",
    });
  });

  it("fails closed when Pi signals a fork even if entry ancestry is still present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("steer"));
    const harness = createHarness(false);
    await enableCapture(harness);
    await harness.agentStart({}, harness.ctx);
    await harness.input({ text: "private intervention text", source: "interactive" }, harness.ctx);
    await harness.beforeFork({}, harness.ctx);
    await completeCapturedTurn(harness, "forked-user");
    expect(markerFor(harness)).toBeUndefined();
  });

  it("fails closed after branch drift", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("steer"));
    const harness = createHarness(false);
    await enableCapture(harness);
    await harness.agentStart({}, harness.ctx);
    await harness.input({ text: "private intervention text", source: "interactive" }, harness.ctx);
    harness.setBranch([
      { id: "other-root", type: "session" },
      { id: "drift-user", type: "message", parentId: "other-root", message: { role: "user" } },
    ]);
    await harness.agentStart({}, harness.ctx);
    await harness.messageStart({ message: { role: "assistant" } }, harness.ctx);
    expect(markerFor(harness)).toBeUndefined();
  });

  it("does not capture when the current Pi mode is not the TUI", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("steer"));
    const harness = createHarness(false);
    await enableCapture(harness);
    harness.ctx.mode = "rpc";
    await harness.agentStart({}, harness.ctx);
    await harness.input({ text: "private intervention text", source: "interactive" }, harness.ctx);
    await completeCapturedTurn(harness, "rpc-mode-user");
    expect(markerFor(harness)).toBeUndefined();
  });

  it("does not capture interactive inputs with attachments", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("steer"));
    const harness = createHarness(false);
    await enableCapture(harness);
    await harness.agentStart({}, harness.ctx);
    expect(await harness.input({ text: "describe this", source: "interactive", images: [{ type: "image" }] }, harness.ctx))
      .toEqual({ action: "continue" });
    await completeCapturedTurn(harness, "image-user", "describe this");
    expect(markerFor(harness)).toBeUndefined();
  });

  it("does not capture slash commands that reach the input hook", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(routeResponse("steer"));
    const harness = createHarness(false);
    await enableCapture(harness);
    await harness.agentStart({}, harness.ctx);
    await harness.input({ text: "/help", source: "interactive" }, harness.ctx);
    await completeCapturedTurn(harness, "command-user", "/help");
    expect(markerFor(harness)).toBeUndefined();
  });

  it("does not capture non-interactive input sources", async () => {
    const harness = createHarness(false);
    await enableCapture(harness);
    await harness.agentStart({}, harness.ctx);
    await harness.input({ text: "**private rpc intervention", source: "rpc" }, harness.ctx);
    harness.setIdle(true);
    await harness.settled({}, harness.ctx);
    await completeCapturedTurn(harness, "rpc-user");
    expect(markerFor(harness)).toBeUndefined();
  });
});

async function enableCaptureAtIdle(harness: ReturnType<typeof createHarness>, emptySession = false) {
  await harness.startSession();
  harness.setIdle(true);
  if (emptySession) harness.setBranch([]);
  await harness.command("pi-card-capture", "on");
}

async function enableCapture(harness: ReturnType<typeof createHarness>) {
  await enableCaptureAtIdle(harness);
  harness.setIdle(false);
  harness.addBranchEntry({ id: "active-leaf", type: "message", parentId: "task", message: { role: "assistant" } });
}

async function persistIdleMessage(
  harness: ReturnType<typeof createHarness>,
  userEntryId: string,
  userText: string,
  parentId: string | null,
) {
  harness.addBranchEntry({
    id: userEntryId,
    type: "message",
    parentId,
    message: { role: "user", content: [{ type: "text", text: userText }] },
  });
  await harness.messageStart({ message: { role: "assistant" } }, harness.ctx);
}

async function completeCapturedTurn(
  harness: ReturnType<typeof createHarness>,
  userEntryId: string,
  userText = "private intervention text",
) {
  harness.messageStart({ message: { role: "assistant" } }, harness.ctx);
  harness.addBranchEntry({
    id: "prior-assistant",
    type: "message",
    parentId: harness.getBranch().at(-1)?.id,
    message: { role: "assistant" },
  });
  await harness.agentStart({}, harness.ctx);
  harness.addBranchEntry({
    id: userEntryId,
    type: "message",
    parentId: "prior-assistant",
    message: { role: "user", content: [{ type: "text", text: userText }] },
  });
  await harness.messageStart({ message: { role: "assistant" } }, harness.ctx);
}

function markerFor(harness: ReturnType<typeof createHarness>) {
  return harness.getBranch().find((entry) => entry.type === "custom" && entry.customType === INTERVENTION_EVIDENCE_TYPE);
}

function routeResponse(choice: string): Response {
  const probabilities = {
    stop: choice === "stop" ? 0.98 : 0.01,
    steer: choice === "steer" ? 0.9 : 0.01,
    followUp: choice === "followUp" ? 0.9 : 0.01,
    unclear: choice === "unclear" ? 0.9 : 0.01,
  };
  const remainder = 1 - Object.values(probabilities).reduce((sum, value) => sum + value, 0);
  probabilities.unclear = Math.max(0, probabilities.unclear + remainder);
  return {
    ok: true,
    json: async () => ({ answers: { route: { type: "choice", choice, confidence: 0.99, probabilities } } }),
  } as Response;
}

function createHarness(initialIdle: boolean) {
  let idle = initialIdle;
  let actionsReady = false;
  let nextEntryId = 0;
  let branch: any[] = [
    { id: "root", type: "session" },
    { id: "task", type: "message", parentId: "root", message: { role: "user" } },
  ];
  const handlers = new Map<string, (...args: any[]) => any>();
  const sessionManager = {
    getBranch: vi.fn(() => branch),
    getEntries: vi.fn(() => branch),
    getLeafId: vi.fn(() => branch.at(-1)?.id),
  };
  let ctx: any;
  const pi = {
    on: vi.fn((name: string, handler: (...args: any[]) => any) => handlers.set(name, handler)),
    registerCommand: vi.fn((name: string, options: { handler: (...args: any[]) => any }) =>
      handlers.set(`command:${name}`, options.handler)),
    appendEntry: vi.fn((type: string, data?: unknown) => {
      if (!actionsReady) throw new Error("Action methods cannot be called during extension loading");
      branch = [...branch, {
        id: `custom-${++nextEntryId}`,
        type: "custom",
        customType: type,
        data,
        parentId: sessionManager.getLeafId() ?? null,
      }];
    }),
    sendUserMessage: vi.fn(async (text: string, options?: { deliverAs?: "steer" | "followUp" }) => {
      const input = handlers.get("input");
      if (input) await input({ text, source: "extension", streamingBehavior: options?.deliverAs }, ctx);
    }),
  };
  ctx = {
    mode: "tui",
    isIdle: vi.fn(() => idle),
    abort: vi.fn(),
    ui: { notify: vi.fn(), confirm: vi.fn(async () => true) },
    sessionManager,
  };
  registerCard(pi as any);
  return {
    pi,
    ctx,
    input: handlers.get("input")!,
    settled: handlers.get("agent_settled")!,
    shutdown: handlers.get("session_shutdown")!,
    messageStart: handlers.get("message_start")!,
    agentStart: handlers.get("agent_start")!,
    beforeFork: handlers.get("session_before_fork")!,
    beforeCompact: handlers.get("session_before_compact")!,

    command: async (name: string, args: string) => handlers.get(`command:${name}`)?.(args, ctx),
    getBranch: () => branch,
    setBranch(nextBranch: any[]) { branch = nextBranch; },
    addBranchEntry(entry: any) { branch = [...branch, entry]; },
    async startSession(reason = "startup") {
      actionsReady = true;
      return handlers.get("session_start")!({ type: "session_start", reason }, ctx);
    },
    setIdle(value: boolean) { idle = value; },
  };
}
