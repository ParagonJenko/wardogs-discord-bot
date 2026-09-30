# WARDOGS Discord bot

Watches a WARDOGS server on [BattleMetrics](https://www.battlemetrics.com/servers/wardogs) and posts to a
Discord channel when:

| Alert        | When                                                       | Default     |
| ------------ | ---------------------------------------------------------- | ----------- |
| 🌱 Seeding   | An empty server reaches `SEEDING_THRESHOLD` players        | 1 player    |
| 🟢 Live      | The server reaches `LIVE_THRESHOLD` players                | 20 players  |
| 🔻 Low pop   | A live server drops below `LOW_POP_THRESHOLD` players      | below 20    |

It posts through a Discord webhook, so there is no bot account or token to set up. It checks BattleMetrics
every 60 seconds; no API key is needed.

## Setup

1. **Server ID.** Find your server on BattleMetrics. The ID is the number at the end of the URL:
   `https://www.battlemetrics.com/servers/wardogs/12345678` → `12345678`.
2. **Webhook.** In Discord: channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.
3. **Role to ping (optional).** Enable Developer Mode (User Settings → Advanced), then Server Settings →
   Roles → right-click the role → Copy Role ID.
4. Copy `.env.example` to `.env` and fill in the values.

## Run

With Node 22.18 or newer:

```bash
npm ci --omit=dev
npm start
```

With Docker:

```bash
docker build -t wardogs-discord-bot .
docker run -d --restart unless-stopped --env-file .env --name wardogs-bot wardogs-discord-bot
```

On start it logs the current population. It does not post on start, so restarting the bot never
re-announces a server that is already seeding or live.

## Behaviour

- Seeding only fires coming from empty. A server that drops from live to 12 players gets a low-pop alert,
  not a seeding alert.
- An empty server that jumps straight to 20+ gets a live alert only.
- Each alert type has a cooldown (`ALERT_COOLDOWN_MINUTES`, default 10). Without it, a server sitting at
  19–20 players would post live / low-pop every minute.
- `LOW_POP_THRESHOLD` can be set lower than `LIVE_THRESHOLD` (for example live at 40, warn below 30) to
  give more slack before the warning.
- If a Discord post fails, the alert is retried on the next check. If BattleMetrics is unreachable, the
  check is skipped and logged.
- A server BattleMetrics reports as offline counts as 0 players.

## Development

```bash
npm ci
npm test
npm run typecheck
```
