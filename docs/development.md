# Develop Pi Card

From the repository root:

```sh
npm ci --legacy-peer-deps
npm test
npm run lint
npm run verify:package
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
import registerCard, { parseTrigger, type SteeringTrigger } from "@carbon-ni/pi-card";
```

`registerCard(pi)` is the default export Pi loads. `parseTrigger(text)` returns `undefined` for an invalid or empty card, or a trigger with the message after its prefix:

```ts
type SteeringTrigger =
  | { kind: "interrupt"; message: string }
  | { kind: "followUp"; message: string }
  | { kind: "brainstorm"; message: string };
```

The `~~` flip is handled by the input hook, not by `parseTrigger`.

## Package and release preparation

`npm run verify:package` packs the scoped package, checks its explicit file allowlist, then installs the tarball into a temporary consumer and verifies the Pi extension entrypoint. It excludes `.pi` state and tests. npm's current optional-peer resolver requires `--legacy-peer-deps`; use the committed lockfile and matching flag in CI.

CI runs lint, unit tests, and package verification for pull requests and pushes to `main`. A GitHub `release.published` event runs the same quality gate at the release tag, packs one canonical tarball, and checks its SHA-256. The publish job is deliberately disabled unless repository variable `PI_CARD_NPM_PUBLISH_ENABLED` is exactly `true`. **Do not enable it until maintainers confirm ownership/access for `@carbon-ni/pi-card` and configure npm trusted publishing for this exact GitHub repository/workflow.** The workflow uses npm OIDC, publishes stable versions as `latest` and prereleases as `next`, and attaches the tarball/checksum to the GitHub release. npm versions are immutable; if a publish partially succeeds, verify npm and GitHub release assets before rerunning because this minimal workflow does not reconcile an already-published artifact. No release, tag, registry, or remote configuration has been created by this preparation.
