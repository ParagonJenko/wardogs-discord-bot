# WARDOGS Discord bot

Watches a WARDOGS server through its RCON API and posts to a Discord channel when:

| Alert        | When                                                       | Default     |
| ------------ | ---------------------------------------------------------- | ----------- |
| 🌱 Seeding   | An empty server reaches `SEEDING_THRESHOLD` players        | 1 player    |
| 🟢 Live      | The server reaches `LIVE_THRESHOLD` players                | 20 players  |
| 🔻 Low pop   | A live server drops below `LOW_POP_THRESHOLD` players      | below 20    |

It posts through a Discord webhook, so there is no bot account or token to set up. It reads
`GET /v1/status` from the server's RCON listener every 60 seconds.

## Setup

1. **RCON address and password.** From your host's control panel (QONZER, BisectHosting, xREALM), or
   `[/Script/WDRCON.WDRCONSettings]` in `ServerSettings.ini`. The address is the server IP and RCON port,
   written as a URL: `http://203.0.113.10:7776` (7776 is the default port). If your host puts RCON
   behind HTTPS, use the `https://` address it gives you.
2. **Webhook.** In Discord: channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.
3. **Role to ping (optional).** Enable Developer Mode (User Settings → Advanced), then Server Settings →
   Roles → right-click the role → Copy Role ID.

## Run on Cloudflare Workers (free)

A cron trigger runs the check every minute. A Durable Object keeps the alert state between runs. Both are
on the Workers free plan, and the bot uses about 1,440 invocations a day against a 100,000 limit.

1. Create a free Cloudflare account, then log in from this folder:
   ```bash
   npm ci
   npx wrangler login
   ```
2. Store the RCON address, RCON password and webhook as secrets, so they are never committed:
   ```bash
   npx wrangler secret put RCON_URL
   npx wrangler secret put RCON_PASSWORD
   npx wrangler secret put DISCORD_WEBHOOK_URL
   ```
3. Optionally set the role ID and thresholds in the `vars` block of `wrangler.jsonc`.
4. Deploy:
   ```bash
   npm run deploy
   ```

Logs are under Workers & Pages → wardogs-discord-bot → Logs in the Cloudflare dashboard. The first run
logs `Watching "<server name>": N/M players`. `RCON rejected the password (401)` means the password
is wrong; `timed out` means the address or port is wrong or the host's firewall blocks it. On Workers the check always runs every minute;
`POLL_INTERVAL_SECONDS` is not used.

To change a threshold later, edit `wrangler.jsonc` and run `npm run deploy` again.

Workers' `fetch()` cannot call a bare IP address or a port like 7776, so on Workers the bot opens a TCP
socket to the RCON listener and sends the HTTP request itself.

## Run with Node or Docker

With Node 22.18 or newer, copy `.env.example` to `.env`, fill it in, then:

```bash
npm ci --omit=dev
npm start
```

With Docker:

```bash
docker build -t wardogs-discord-bot .
docker run -d --restart unless-stopped --env-file .env --name wardogs-bot wardogs-discord-bot
```

## Behaviour

- The first check only logs the current population and does not post, so starting the bot never
  announces a server that is already seeding or live. State is kept across Cloudflare runs.
- Seeding only fires coming from empty. A server that drops from live to 12 players gets a low-pop alert,
  not a seeding alert.
- An empty server that jumps straight to 20+ gets a live alert only.
- Each alert type has a cooldown (`ALERT_COOLDOWN_MINUTES`, default 10). Without it, a server sitting at
  19–20 players would post live / low-pop every minute.
- `LOW_POP_THRESHOLD` can be set lower than `LIVE_THRESHOLD` (for example live at 40, warn below 30) to
  give more slack before the warning.
- If a Discord post fails, the alert is retried on the next check while it is still true. If RCON is
  unreachable (for example during the game's daily restart), the check is skipped and logged; no alert
  is sent for the outage itself.

## Security

The RCON password gives full admin control of the server (kick, ban, end match, change settings). The
bot only ever calls `GET /v1/status`, but:

- Keep the password in a Wrangler secret or `.env`, never in `wrangler.jsonc` or the repo.
- Over `http://`, the password is sent unencrypted on every check. Use an `https://` RCON address if
  your host offers one.

## Development

```bash
npm ci
npm test
npm run typecheck
```
