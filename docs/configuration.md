# Configure Pi Card

Cards need no setup. The options below only affect plain text routing, unless stated otherwise.

## Let Jev choose

Set a [TypeSafe API key](https://docs.typesafe.ai/introduction/quickstart) before starting Pi:

```sh
export TYPESAFE_API_KEY="your-api-key"
pi -e ./src/index.ts
```

With the key, Pi Card sends unprefixed interactive text to Jev. Jev chooses `stop`, `steer`, `followUp`, or `unclear`. While Pi is active, `unclear` queues a follow-up. A stop needs high probability and confidence; Jev can still get a message wrong. Use a card when timing must be exact.

Inference times out after 1.5 seconds. Without debounce, a failed request passes the original input through to Pi. With debounce, Pi Card still delivers the combined message: normally when idle, as a steer while active. Prefix cards take priority. Messages with images and input sent by extensions or through RPC bypass Jev. Without the key, plain text also keeps Pi's native behavior (a steer while Pi is active).

**Privacy:** eligible message text goes to TypeSafe. If you configure examples below, their text goes too. Pi Card does not log the text or your key. Do not put secrets in examples.

## Personal examples

Create `pi-card.json` in Pi's agent config directory. It is normally `~/.pi/agent`; if you set `PI_CODING_AGENT_DIR`, use that directory instead.

```json
{
  "examples": [
    { "text": "stop this task now; don't continue", "route": "stop" },
    { "text": "actually, use the simpler approach", "route": "steer" },
    { "text": "when you finish, summarize the changes", "route": "followUp" }
  ]
}
```

These are preferences for similar wording, not exact phrase shortcuts. A stop example does not bypass the stop safety check. Pi Card reads only this user config, not project config. It accepts up to 20 examples, up to 1,000 characters per example, and a file up to 32 KB. Empty text, unknown routes, or the same text assigned to different routes make the whole config invalid. It then warns without showing the content and uses the normal Jev rules. Reload Pi after editing the file with `/reload`.

## Calibrate from past sessions

The packaged `/skill:pi-card-callibration` can help review a small sample of past user messages. It does not run automatically. Invocation is not consent: before any session JSONL is read, the skill states the sessions root, current-project filter, inclusive date range, file/candidate caps, and local extraction, then asks for explicit approval. It mines only approved matching sessions, redacts likely personal data locally, and requires you to label each candidate. No session text is sent to TypeSafe or another external service. Review redactions carefully; they are best-effort. Only examples you approve can be added to `pi-card.json`, and each `stop` example requires separate confirmation. The stop confidence/probability gate is unchanged.

## Combine messages before routing

Jev normally classifies each submitted message on its own. If you tend to send a correction right after the first message, enable a short pause:

```sh
export PI_CARD_DEBOUNCE_ENABLED=true
export PI_CARD_DEBOUNCE_MS=600
```

The default is off. The delay defaults to 600 ms and is capped at 5,000 ms. Pi Card combines eligible submissions in order, separated by a blank line, and classifies them once after the quiet period. A batch flushes after five seconds or 16,000 characters. One submission over 16,000 characters skips batching. Cards, extension input, and images flush pending text first, so order stays intact. Shutdown also flushes it. Debounce requires `TYPESAFE_API_KEY`.

## Inspect a routing decision

Set `PI_CARD_DEBUG=true` before starting Pi. Pi Card then appends `pi-card.routing` records to the local session. They show the input branch, Jev choice, confidence policy, failure category, and delivery action. A `routeId` connects a decision to its action. They contain no message text, example text, key, or raw error details.

```sh
jq -c 'select(.type == "custom" and .customType == "pi-card.routing") | {timestamp, data}' "$PI_SESSION_FILE"
```

A `session_start` record appears on startup and reload. If it is missing, check which copy of the extension Pi loaded. This checkout does not change a global installation.
