# Pi Card

<img width="124" height="100" alt="image" src="https://github.com/user-attachments/assets/d2e4e0af-4e88-47db-be32-4a8d9ff0e7a8" align="left" />  

Control message delivery to Pi with prefix cards — even while Pi is mid-work.
Prefix your message with a two-character card to decide when and how it gets delivered.

</br>

## Cards

| Prefix | Card | Active | Idle |
|---|---|---|---|
| `**` | Interrupt | Aborts current work, delivers message after agent settles | Sends immediately |
| `&&` | Follow-up | Queues message after current run finishes (flippable) | Sends immediately |
| `??` | Brainstorm | Aborts current work, delivers a brainstorming prompt after agent settles | Sends immediately with brainstorming framing |
| `~~` | Flip | Delivers the last queued `&&` as a steer — agent sees it mid-run, no abort | — |

## Behavior by agent state

### Agent is idle

All prefixes are stripped and the message is sent immediately. Brainstorm (`??`) wraps the message in a brainstorming prompt.

### Agent is active (mid-run)

- **`**`** — aborts the current agent run and queues the message. Once the agent settles, the message is delivered as the next prompt.
- **`&&`** — queues the message as a follow-up. Delivered after the current run completes without interrupting it.
- **`??`** — aborts the current run and queues a brainstorming prompt (`Stop the previous approach. Let's brainstorm … before taking further action.`).
- **`~~`** (sent alone) — flips the most recent queued `&&` into a steer: the message is handed to the agent immediately, mid-run, without interrupting it. Work in progress continues. Flipping an interrupt or brainstorm card is refused (an aborted run can't be resumed), and `~~text` passes through untouched so markdown strikethrough stays safe.

Without a TypeSafe key, plain text follows Pi's native behavior. While Pi is active, it is a steer as soon as you submit it and cannot be recalled. With routing enabled, Jev chooses the delivery timing. Use a prefix card when you want to choose the timing yourself.

## Usage

```
**fix the type error in auth.ts
&&summarize what you changed
??is there a simpler approach to this caching layer
~~
```

Without `TYPESAFE_API_KEY`, ordinary messages without a prefix pass through unchanged. With the key configured, unprefixed interactive text is sent to TypeSafe Jev for delivery-timing classification: clear stop requests interrupt, clear corrections steer, clear follow-ups queue, and unclear intent is non-destructive (queued as a follow-up while active). Stop requires a high probability and confidence threshold. Inference has a 1.5-second timeout; network, timeout, or invalid-response failures preserve Pi's native input behavior. Prefix cards always take precedence; extension-injected input and messages with attachments bypass classification.

**Privacy:** with the key configured, eligible raw text is transmitted to TypeSafe AI's API for classification. Do not enable this if that external processing is unsuitable for your messages. The key and message text are not logged by pi-card.

### Optional time-gap debounce

Set `PI_CARD_DEBOUNCE_ENABLED=true` to combine consecutive eligible unprefixed interactive text submissions and route them together after a quiet period. It requires `TYPESAFE_API_KEY`; otherwise the existing behavior is unchanged. The default is disabled, preserving immediate Jev routing when a key is configured. `PI_CARD_DEBOUNCE_MS` sets the quiet period in milliseconds (default `600`; positive integers are capped at `5000`). A batch also flushes after five seconds or 16,000 characters to prevent indefinite delay or unbounded buffering. A single submission over 16,000 characters bypasses batching and is sent to Jev immediately after any earlier pending batch. Combined messages retain input order, separated by blank lines (`\n\n`). Prefix cards, extension input, and image-bearing input flush any pending text before bypassing debounce. That preserves order, but the bypassing input waits for classification (up to the 1.5-second request timeout). Pending text is flushed when the session shuts down.

### Check routing against synthetic examples

Run `npm run eval:jev` with `TYPESAFE_API_KEY` set. This sends only the synthetic English and Portuguese fixtures in `scripts/eval-jev.ts` to TypeSafe. It runs the live Jev classifier and pi-card's confidence/stop policy, then prints observed routes, the returned model version, latency, a confusion matrix, and mismatches. It does not start a Pi agent or measure full Pi end-to-end behavior. The target is at least 80% exact matches and no false stops on the safety cases. The command exits nonzero for any false stop; other mismatches remain visible for review.

In one run, Jev 1.13.0 matched 10/10 fixtures with zero false stops. The partial-subtask stop-but-continue case is labeled `unclear` because aborting all current work would be unsafe. This is a small synthetic check, not a quality guarantee. Re-run it after changing the classifier or policy.

## API

```ts
import registerCard, { parseTrigger, type SteeringTrigger } from "pi-card";
```

### `parseTrigger(text: string): SteeringTrigger | undefined`

Parses a two-character prefix from the message. Returns `undefined` for invalid or prefix-only input.

### `SteeringTrigger`

```ts
type SteeringTrigger =
  | { kind: "interrupt"; message: string }
  | { kind: "followUp"; message: string }
  | { kind: "brainstorm"; message: string };
```

### `registerCard(pi: ExtensionAPI): void`

Registers the `input` and `agent_settled` hooks. This is the default export — Pi loads it automatically.

## Development

```bash
npm install
npm test
npm run lint
```

## Try locally

```bash
pi -e ./src/index.ts
```
