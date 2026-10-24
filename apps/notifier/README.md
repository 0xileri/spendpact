# Spact Telegram notifier

Watches one Spact vault and messages the owner on Telegram when a payment waits for approval. It messages again when the payment is paid, rejected or expires.

The bot only notifies. Its messages have no approve or reject buttons, and it holds no NEAR keys. To approve, the owner opens the linked approval page, checks the terms against the chain, and signs with their wallet (AGENTS.md section 7).

## What a message looks like

```text
Payment waiting for your approval (testnet)

Amount: 25 TUSD
To: api.demo.testnet
Token contract: tusd.demo.testnet
Vault: vault.demo.testnet
Requested by: agent.demo.testnet
Request: demo-approve-1
Expires: 2026-11-02 14:05 UTC (in 23 h 59 min)
Budget left today: 47 TUSD of 50 TUSD

Agent's note (written by the agent, not checked): "Weather API: monthly plan upgrade"

Nothing has been paid. To approve, open the approval page, check the terms there, and sign with your wallet. This message cannot approve anything.
https://<approval page>/?request=demo-approve-1
```

- **Plain text:** no `parse_mode`, so nothing can turn into formatting or hidden links.
- **Agent's note:** labeled as the agent's own words. It is stripped of control and invisible characters, and capped at 200 characters. Links in it are defanged (`evil[.]com`, `https[:]//`, `(at)name`), so the approval page is the only tappable link.
- **Warning:** if today's budget can't cover the payment, the message says so.
- **Review button:** a URL button is added only for https approval links. Local links stay in the text.

## Linking your chat

Create a bot with @BotFather in Telegram and copy its token. Start the notifier without `TELEGRAM_CHAT_ID`. It prints a one-time code on its own terminal:

```text
spact-notifier: to link your Telegram chat, send this to your bot within 10 minutes:

  /start Xb2_9kQe1tZp
```

Send that exact message to your bot in a private chat. The notifier replies **Linked.** and saves the chat id in its state file. It ignores messages from groups or channels, other codes, and every other kind of update, including button presses. The code is shown only to whoever runs the notifier, so a chat cannot be bound by an unauthenticated message.

To skip linking, set `TELEGRAM_CHAT_ID` yourself.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `SPACT_NETWORK` | yes | `sandbox`, `testnet` or `mainnet`; must match the vault |
| `SPACT_RPC_URL` | yes | NEAR JSON-RPC endpoint (https outside sandbox) |
| `SPACT_VAULT_ID` | yes | the vault to watch |
| `SPACT_APPROVAL_URL` | yes | base URL of the approval page (https outside sandbox) |
| `TELEGRAM_BOT_TOKEN` | yes | from @BotFather. Never logged or written to the state file. |
| `TELEGRAM_CHAT_ID` | no | the owner's chat id; otherwise link with `/start <code>` |
| `SPACT_NOTIFIER_STATE` | no | state file (default `~/.spact/notifier-<network>-<vault>.json`, mode 600) |
| `SPACT_POLL_SECONDS` | no | how often to read the vault (default 5) |

## How it works

- **Polling:** every poll it reads `get_config` and `list_requests` over RPC and validates the answers. New requests that wait for approval and haven't expired by chain time get an alert. Requests it already alerted about get re-read for a state change.
- **Retries:** each alert is saved to the state file right after it's sent, so a restart doesn't repeat alerts. If a send fails, the next poll retries the same request.
- **Flood limits:** sends are spaced at least 1.1 s apart. A 429 waits for Telegram's `retry_after`, and server errors back off.
- **No webhook:** long polling (`getUpdates`) is used only while linking a chat, so there's no public endpoint or webhook secret to protect.
- **Logs:** one JSON line per event on stderr (request id, status). Never the bot token or message text.

## Run it

```bash
pnpm install --frozen-lockfile && pnpm build
SPACT_NETWORK=testnet SPACT_RPC_URL=https://test.rpc.fastnear.com \
SPACT_VAULT_ID=vault.<name>.testnet SPACT_APPROVAL_URL=https://<your approval page>/ \
TELEGRAM_BOT_TOKEN=<token from @BotFather> \
  node apps/notifier/dist/index.js
```

On the local sandbox, `scripts/dev-sandbox.sh` prints the command with the right values. Each run is a new chain, so you link the chat again each time, or set `TELEGRAM_CHAT_ID`. The approval link points at `localhost`, so open it on the same machine.

## Tests

```bash
pnpm --filter @spact/notifier test   # messages, Telegram client, binding, state, the watch loop
pnpm notifier:sandbox                # the built notifier against a sandbox chain and a mock Bot API
```

The sandbox suite links a chat while ignoring a group, a wrong code and a forged button press (T06). It checks that the alert shows the exact terms with the only link being the approval page, and that the follow-up comes after the owner approves and pays. After a restart nothing is repeated, and a new request from the agent's restricted key is still alerted, with the link in its note defanged.

The real Telegram API was not reachable from the build environment. The client follows the shapes in Telegram's Bot API server source (docs/INTEGRATIONS.md) and is tested against the mock.
