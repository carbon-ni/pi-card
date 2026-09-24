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

## Record prospective Pi Card inputs

Capture is off by default. To opt in, use the command from Pi's interactive TUI after the session starts and while the agent is idle:

```text
/pi-card-capture on
```

Enabling requires interactive confirmation, even if another extension invokes the command. It applies only to this session and resets to off after a new session or reload. When enabled, capture covers future interactive text routed through Jev while Pi is idle or active, plus explicit `**`, `&&`, and `??` cards. It excludes Pi commands handled before Pi Card, attachments, and extension/RPC input. The `~~` flip is not a separate text candidate; the original queued card records its final delivery mode. Capture does not read or mine old sessions. Mining is a separate, consented operation.

A `pi-card.intervention` marker is attached only after one exact persisted Pi Card user message is uniquely observed. The candidate is that persisted message after best-effort redaction, not necessarily the original keystrokes: card prefixes may be stripped, and `??` text may be wrapped. Overlong persisted messages are skipped rather than truncated. The marker stores no message text, hash, Jev choice/route/confidence/response, or session ID. It stores schema/source, idle-or-active state, card kind, streaming behavior, observed action, actual delivery mode, and branch entry IDs. For active input it also stores the nearest user task-anchor ID; for idle input that anchor is `null`. An empty-session idle input has a `null` input-leaf ID and is accepted only when the persisted user's parent chain reaches an explicit `null` root through Pi Card's own `pi-card.routing` diagnostics, if present. Pi adds its standard entry timestamp; timestamps are used only for approved date filtering. The marker parent and exact branch IDs establish persisted-target linkage. A transient check rejects unexpected Pi Card extension inputs; no text is stored in the marker or used as the miner's join key. A queued action is not a candidate until its delivery persists. Multiple queued cards drained into one user entry are ambiguous and receive no marker. Incomplete deliveries, unexpected internal extension inputs, or ambiguous branch parentage fail closed. Turning capture off does not remove existing markers.

The separate `/skill:pi-card-callibration` is opt-in and mines only supported schema-v3 markers. It validates the direct target parent and unique branch IDs. Active candidates require their task anchor and input leaf on the target's parent chain; idle candidates require their parent chain to reach the frozen input leaf, allowing only intervening `pi-card.routing` diagnostics; empty-session chains must reach an explicit `null` root. They have no task context. Duplicate, missing, broken, ambiguous, unsupported, or out-of-range evidence is skipped and counted; valid candidates omitted after the requested limit are counted separately. The reviewer displays persisted text, idle/active state, card kind, observed action, and actual delivery separately from the user's label; it never infers a label from behavior metadata. Candidate IDs are opaque per-run ordinals, not session filenames or entry IDs.

## Calibrate from marked inputs

The packaged `/skill:pi-card-callibration` builds a local, offline HTML page for labeling a small sample of prospectively marked Pi Card user messages. Unmarked historical messages are never mined; before capture was enabled, the marker-linked candidate count is zero. It does not run automatically. Before reading any session JSONL, it states the configured sessions root, current project, UTC date range, file/candidate limits, and extraction plan, then asks for approval. Raw sessions stay local; redacted excerpts stay out of the active Pi model unless you separately approve sharing them in chat. The miner is pinned to `${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions`, rejects symlinked roots, extracts at most 20 candidates, and uses opaque per-run candidate IDs rather than session filenames. Review the best-effort redaction yourself. The browser's reviewed-JSON download may use permissive file permissions or a synced Downloads folder; save it privately and delete it after review. Only examples you approve can be added to `pi-card.json`; Pi Card then sends those examples to TypeSafe alongside future eligible messages. Each `stop` example needs separate confirmation. Invalid or full configs stay unchanged, and the stop confidence/probability gate remains in force.

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
