export type Route = "stop" | "steer" | "followUp" | "unclear";

const ROUTES = ["stop", "steer", "followUp", "unclear"] as const;
const STOP_THRESHOLD = 0.95;
const ROUTE_CONFIDENCE_THRESHOLD = 0.8;
export const ROUTE_TIMEOUT_MS = 1_500;

type FetchLike = typeof fetch;

export interface RouteDecision {
  route: Route;
  model?: string;
  confidence: number;
  probabilities: Record<Route, number>;
}

export async function classifyMessage(
  text: string,
  apiKey: string,
  fetcher: FetchLike = fetch,
): Promise<Route> {
  return (await classifyMessageDetailed(text, apiKey, fetcher)).route;
}

export async function classifyMessageDetailed(
  text: string,
  apiKey: string,
  fetcher: FetchLike = fetch,
): Promise<RouteDecision> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);

  try {
    const response = await fetcher("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: "jev-latest",
        state: { message: text },
        questions: {
          route: {
            type: "choice",
            instructions: "Choose message delivery timing from the message text alone. Do not infer from runtime state or hidden metadata. Classify urgency to stop current work, immediate steering/correction, a request to handle after current work, or unclear/ordinary text.",
            criteria: {
              stop: "Clearly asks to stop or interrupt ongoing work now; require explicit, unambiguous urgency.",
              steer: "Clearly asks for an immediate correction or direction while work is ongoing, without asking to stop it.",
              followUp: "Clearly asks for additional work, a summary, or something to handle after the current work completes.",
              unclear: "Ordinary conversation, ambiguous intent, or no clear timing signal.",
            },
          },
        },
      }),
    });
    if (!response.ok) throw new Error(`TypeSafe returned HTTP ${response.status}`);

    const payload: unknown = await response.json();
    if (!isRecord(payload) || !isRecord(payload.answers) || !isRecord(payload.answers.route)) {
      throw new Error("Invalid TypeSafe response");
    }
    const answer = payload.answers.route;
    if (
      answer.type !== "choice" ||
      typeof answer.choice !== "string" ||
      !ROUTES.includes(answer.choice as Route) ||
      typeof answer.confidence !== "number" ||
      !Number.isFinite(answer.confidence) ||
      answer.confidence < 0 ||
      answer.confidence > 1 ||
      !isRecord(answer.probabilities) ||
      ROUTES.some((route) =>
        typeof answer.probabilities[route] !== "number" ||
        !Number.isFinite(answer.probabilities[route]) ||
        answer.probabilities[route] < 0 ||
        answer.probabilities[route] > 1
      ) ||
      Math.abs(ROUTES.reduce((sum, route) => sum + answer.probabilities[route], 0) - 1) > 0.02
    ) throw new Error("Invalid TypeSafe route answer");

    const choice = answer.choice as Route;
    const route = choice === "stop"
      ? answer.probabilities.stop >= STOP_THRESHOLD && answer.confidence >= ROUTE_CONFIDENCE_THRESHOLD
        ? "stop"
        : "unclear"
      : answer.confidence >= ROUTE_CONFIDENCE_THRESHOLD ? choice : "unclear";
    return {
      route,
      model: typeof payload.model === "string" ? payload.model : undefined,
      confidence: answer.confidence,
      probabilities: answer.probabilities as Record<Route, number>,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
