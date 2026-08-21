# dsh-whatsapp-inbox

A WhatsApp channel for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
over Twilio. One WhatsApp number is one durable agent session.

**It polls the API instead of hosting a webhook.** Twilio's documented path for inbound WhatsApp
is a webhook, which means a public HTTPS endpoint — a tunnel, a DNS record, and a URL on the
internet that accepts POSTs. This trades a few seconds of latency for none of that. At a 5s
interval it is still more responsive than a Telegram long-poll's 25s hold, and for a harness
whose distinguishing property is that it runs nothing resident and exposed, that is the right
side of the trade.

## Install

```sh
dsh plugin --profile <name> add dsh-whatsapp-inbox
```

```yaml
- insert:
    - id: whatsapp-inbox
      name: 'dsh-whatsapp-inbox'
      config:
        credentialsFile: /etc/dsh/twilio.env   # TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN
        from: 'whatsapp:+15550001111'          # your approved sender
        appDir: /path/to/harness/install
        allowedNumbers: [15550002222]          # empty refuses everyone
        cursorFile: /var/lib/dsh/whatsapp-cursor.json
```

## Config

| field | default | meaning |
|---|---|---|
| `credentialsFile` | — | env-style file with `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`. |
| `accountSid` / `authToken` | env | Alternatives for debugging. |
| `from` | *required* | Your WhatsApp sender, `whatsapp:+…`. |
| `appDir` | `$DSH_APP_DIR` | Harness installation to resolve `dsh-llm` / `dsh-agent` from. |
| `allowedNumbers` | `[]` | Numbers permitted to talk to the bot. **Empty refuses everyone.** |
| `cursorFile` | — | Where to persist the read position. Strongly recommended. |
| `pollSeconds` | `5` | Poll interval. |
| `workspace` / `preset` / `provider` / `model` | harness defaults | Session shape. |
| `maxChats` / `chatIdleMs` | `32` / 6h | Live chats held before eviction. |
| `logLevel` | `info` | Also `DSH_WHATSAPP_LOG_LEVEL`. |

Commands in chat: `/new` starts a fresh conversation, `/status` reports what is held.

## Things that will bite you

- **Twilio has no acknowledgement.** Every list call returns the same history, so without a
  durable cursor a restart re-answers days of messages. The cursor is a watermark *plus* a
  bounded set of message ids — the watermark alone is not enough, because Twilio timestamps
  have one-second resolution and a strict `>` drops messages sharing a second.
- **The 24-hour window is real.** Outside 24h from the customer's last message, only a
  pre-approved template will deliver; free-form sends fail with `63016`. That is caught and
  logged explicitly, because otherwise a proactive nudge just silently vanishes.
- **`63051` is not this plugin.** It means Meta has locked the sender — inactivity, a policy
  restriction, or a two-step-verification PIN mismatch. Inbound keeps working while it applies.
- **An empty allow-list refuses everyone**, and strangers get silence rather than a refusal
  message: replying confirms the number is live.
- **1600 characters per message.** Replies split with a part counter, and code fences reopen
  across the break, because WhatsApp shows no grouping between bubbles.

## Tests

```sh
npm test
```

57 tests, no dependencies, no Twilio account required.

## Part of a set

| plugin | what it adds |
|---|---|
| **dsh-whatsapp-inbox** *(this one)* | WhatsApp over Twilio, polled — no public endpoint |
| [dsh-telegram-inbox](https://github.com/Eyalm321/dsh-telegram-inbox) | the same idea for Telegram, long-polled |
| [dsh-headless-resume](https://github.com/Eyalm321/dsh-headless-resume) | durable sessions for one-shot CLI runs |
| [dsh-claude-cli-provider](https://github.com/Eyalm321/dsh-claude-cli-provider) | Claude on a subscription as a model route |
| [dsh-mcp-bridge](https://github.com/Eyalm321/dsh-mcp-bridge) | harness capabilities as MCP tools for any client |

## License

MIT
