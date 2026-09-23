import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Route } from "./router.js";

export type RoutingExample = { text: string; route: Exclude<Route, "unclear"> };
const ROUTES = new Set(["stop", "steer", "followUp"]);
const MAX_FILE_BYTES = 32_000;
const MAX_EXAMPLES = 20;
const MAX_TEXT_LENGTH = 1_000;

export const routingExamplesPath = join(homedir(), ".pi", "agent", "pi-card.json");

export function loadRoutingExamples(path = routingExamplesPath): RoutingExample[] {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return [];
    throw new Error("Unable to read routing configuration");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    throw new Error("Routing configuration exceeds size limit");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Routing configuration is not valid JSON");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.examples) || parsed.examples.length > MAX_EXAMPLES) {
    throw new Error("Routing configuration has an invalid examples list");
  }

  const seen = new Map<string, string>();
  const examples = parsed.examples.map((item): RoutingExample => {
    if (!isRecord(item) || typeof item.text !== "string" || !item.text.trim() || item.text.length > MAX_TEXT_LENGTH || typeof item.route !== "string" || !ROUTES.has(item.route)) {
      throw new Error("Routing configuration contains an invalid example");
    }
    const key = item.text.trim().toLocaleLowerCase();
    const previousRoute = seen.get(key);
    if (previousRoute && previousRoute !== item.route) {
      throw new Error("Routing configuration contains conflicting examples");
    }
    seen.set(key, item.route);
    return { text: item.text.trim(), route: item.route as RoutingExample["route"] };
  });
  return examples;
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
