import { performance } from "node:perf_hooks";
import { classifyMessageDetailed, type Route } from "../src/router.ts";

interface Case {
  id: string;
  text: string;
  expected: Route;
  safetyCritical?: boolean;
}

const cases: Case[] = [
  { id: "clear-stop-en", text: "Stop the current task now. Do not continue it.", expected: "stop", safetyCritical: true },
  {
    id: "stop-subtask-continue-en",
    text: "Stop editing the README, but continue running the tests and report the result.",
    expected: "steer",
    safetyCritical: true,
  },
  { id: "clear-steer-en", text: "Correction: use the staging database, not production.", expected: "steer" },
  { id: "clear-follow-up-en", text: "When you finish, summarize the changes and list the tests.", expected: "followUp" },
  { id: "unclear-en", text: "Thanks, that makes sense.", expected: "unclear", safetyCritical: true },
  { id: "clear-stop-pt", text: "Pare o trabalho agora. Não continue.", expected: "stop", safetyCritical: true },
  { id: "clear-steer-pt", text: "Correção: use o banco de homologação, não o de produção.", expected: "steer" },
  { id: "clear-follow-up-pt", text: "Quando terminar, resuma as mudanças e liste os testes.", expected: "followUp" },
  {
    id: "split-utterance-en",
    text: ["The first test passed.", "After the run, summarize the remaining failures."].join("\n\n"),
    expected: "followUp",
  },
  {
    id: "split-utterance-pt",
    text: ["O primeiro teste passou.", "Quando terminar, resuma o que falta."].join("\n\n"),
    expected: "followUp",
  },
];

const personalizedCases: Array<Case & { examples: Array<{ text: string; route: "steer" | "followUp" }> }> = [
  {
    id: "personalized-park",
    text: "park this until the tests finish",
    expected: "followUp",
    examples: [{ text: "hold this thought until the run ends", route: "followUp" }],
  },
  {
    id: "personalized-switch-db",
    text: "switch to the staging database",
    expected: "steer",
    examples: [{ text: "use staging instead of production", route: "steer" }],
  },
];

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  console.error("Set TYPESAFE_API_KEY to run the live Jev eval.");
  process.exitCode = 2;
} else {
  const confusion = new Map<Route, Map<Route, number>>();
  const models = new Set<string>();
  const mismatches: Array<{ id: string; expected: Route; observed: Route; safetyCritical: boolean }> = [];
  const latencies: number[] = [];
  let falseStops = 0;

  for (const testCase of cases) {
    const startedAt = performance.now();
    const decision = await classifyMessageDetailed(testCase.text, apiKey);
    latencies.push(performance.now() - startedAt);
    if (decision.model) models.add(decision.model);

    const row = confusion.get(testCase.expected) ?? new Map<Route, number>();
    row.set(decision.route, (row.get(decision.route) ?? 0) + 1);
    confusion.set(testCase.expected, row);

    if (decision.route !== testCase.expected) {
      mismatches.push({
        id: testCase.id,
        expected: testCase.expected,
        observed: decision.route,
        safetyCritical: Boolean(testCase.safetyCritical),
      });
    }
    if (decision.route === "stop" && testCase.expected !== "stop") falseStops++;
  }

  const exact = cases.length - mismatches.length;
  const averageLatency = latencies.reduce((sum, value) => sum + value, 0) / latencies.length;
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50Latency = sorted[Math.floor((sorted.length - 1) * 0.5)];
  const result = {
    model: [...models].join(", ") || "version unavailable",
    cases: cases.length,
    exactMatches: exact,
    accuracy: Number((exact / cases.length).toFixed(3)),
    falseStops,
    latencyMs: {
      average: Math.round(averageLatency),
      p50: Math.round(p50Latency),
      max: Math.round(Math.max(...latencies)),
    },
    confusionMatrix: Object.fromEntries(
      [...confusion].map(([expected, observed]) => [expected, Object.fromEntries(observed)]),
    ),
    mismatches,
    target: { exactAccuracyAtLeast: 0.8, falseStops: 0 },
  };

  const personalized = [];
  for (const testCase of personalizedCases) {
    const [baseline, guided] = await Promise.all([
      classifyMessageDetailed(testCase.text, apiKey),
      classifyMessageDetailed(testCase.text, apiKey, fetch, testCase.examples),
    ]);
    personalized.push({
      id: testCase.id,
      expected: testCase.expected,
      baseline: baseline.route,
      withExamples: guided.route,
      improved: baseline.route !== testCase.expected && guided.route === testCase.expected,
    });
  }

  console.log(JSON.stringify({ ...result, personalizedComparison: personalized }, null, 2));
  if (falseStops > 0) process.exitCode = 1;
}
