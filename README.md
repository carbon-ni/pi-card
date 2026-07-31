# Pi Card

<img width="124" height="100" alt="image" src="https://github.com/user-attachments/assets/d2e4e0af-4e88-47db-be32-4a8d9ff0e7a8" align="left" />  

Control message delivery to Pi with prefix cards — even while Pi is mid-work.
Prefix your message with a two-character card to decide when and how it gets delivered.

</br>

## Cards

| Prefix | Card | Active | Idle |
|---|---|---|---|
| `**` | Interrupt | Aborts current work, delivers message after agent settles | Sends immediately |
| `&&` | Follow-up | Queues message after current run finishes | Sends immediately |
| `??` | Brainstorm | Aborts current work, delivers a brainstorming prompt after agent settles | Sends immediately with brainstorming framing |

## Behavior by agent state

### Agent is idle

All prefixes are stripped and the message is sent immediately. Brainstorm (`??`) wraps the message in a brainstorming prompt.

### Agent is active (mid-run)

- **`**`** — aborts the current agent run and queues the message. Once the agent settles, the message is delivered as the next prompt.
- **`&&`** — queues the message as a follow-up. Delivered after the current run completes without interrupting it.
- **`??`** — aborts the current run and queues a brainstorming prompt (`Stop the previous approach. Let's brainstorm … before taking further action.`).

## Usage

```
**fix the type error in auth.ts
&&summarize what you changed
??is there a simpler approach to this caching layer
```

Ordinary messages without a prefix pass through unchanged.

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
