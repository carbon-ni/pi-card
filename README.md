# Pi Card

<img height="150" alt="image" src="https://github.com/user-attachments/assets/d2e4e0af-4e88-47db-be32-4a8d9ff0e7a8" align="left" />

Pi Card figures out what you want to do with a message while Pi is working: correct the current run, stop it, or leave something for later. You can just type. When timing must be exact, use a card.

## Try it

From this checkout:

```sh
npm install
export TYPESAFE_API_KEY="your-api-key"
pi -e ./src/index.ts
```

While Pi is working, write what you mean:

| You say | Pi Card treats it as |
| --- | --- |
| “Actually, use the simpler approach.” | A steer: change direction without stopping. |
| “When you finish, summarize what changed.” | A follow-up: wait until the run finishes. |
| “Stop this task now. Don't continue.” | A stop: abort, then deliver your message. |

These are examples, not exact phrase rules. If your intent is unclear, Pi Card queues a follow-up rather than interrupting work. It also lets you [add examples in your own words](docs/configuration.md#personal-examples). If you tend to send a correction right after the first message, [combine them before routing](docs/configuration.md#combine-messages-before-routing).

## Take control when you need to

| Type | What happens while Pi is working |
| --- | --- |
| `**fix the type error` | Stop the current run, then send this message. |
| `&&summarize what changed` | Wait until the current run finishes. |
| `??is there a simpler way?` | Stop and ask Pi to brainstorm before doing more. |
| `~~` | Send the last queued `&&` now as a steer, without stopping the run. |

Cards work without an API key. The three message cards run immediately while Pi is idle. `~~` only flips a queued `&&`; it cannot undo a stop. To force a steer while Pi is active, send `&&` followed by `~~`.

## More

- [Configuration](docs/configuration.md): API key, personal examples, privacy, and diagnostics.
- [Development](docs/development.md): local checks, routing eval, and extension API.

Without `TYPESAFE_API_KEY`, plain text keeps Pi's native behavior. With the key, eligible messages and configured examples go to an external service for classification. Check [the privacy details](docs/configuration.md#let-jev-choose) before enabling it.
