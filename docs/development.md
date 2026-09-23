# Develop Pi Card

From the repository root:

```sh
npm install
npm test
npm run lint
pi -e ./src/index.ts
```

`src/index.ts` registers Pi's `input` and `agent_settled` hooks. `src/router.ts` asks Jev for a route and checks its confidence before delivery. `src/routing-examples.ts` reads the optional user config.

## Check Jev decisions

With `TYPESAFE_API_KEY` set, run:

```sh
npm run eval:jev
```

This sends only synthetic English and Portuguese messages to TypeSafe. It prints the model version, latency, a confusion matrix, mismatches, and baseline versus example guided decisions. It also compares safety cases with and without examples. It exits nonzero for any false stop, but other mismatches stay visible for review. The target is at least 80% exact matches and no false stops on the safety cases.

This is not a test of a full Pi session. Jev decisions can change between runs. One run with Jev 1.13.0 matched 9 of 10 baseline cases with no false stops; it treated “stop editing README but continue tests” as `unclear` rather than `steer`. Keep that miss visible instead of claiming the classifier is exact.

## Extension API

```ts
import registerCard, { parseTrigger, type SteeringTrigger } from "pi-card";
```

`registerCard(pi)` is the default export Pi loads. `parseTrigger(text)` returns `undefined` for an invalid or empty card, or a trigger with the message after its prefix:

```ts
type SteeringTrigger =
  | { kind: "interrupt"; message: string }
  | { kind: "followUp"; message: string }
  | { kind: "brainstorm"; message: string };
```

The `~~` flip is handled by the input hook, not by `parseTrigger`.
