# WARDOGS Discord bot

Watches a WARDOGS server through its RCON API and posts to a Discord channel when:

| Alert        | When                                                       | Default     |
| ------------ | ---------------------------------------------------------- | ----------- |
| 🌱 Seeding   | An empty server reaches `SEEDING_THRESHOLD` players        | 1 player    |
| 🟢 Live      | The server reaches `LIVE_THRESHOLD` players                | 20 players  |
| 🔻 Low pop   | A live server drops below `LOW_POP_THRESHOLD` players      | below 20    |

It also posts:

- **Top seeders** on the live alert: the 3 players who were online longest while the server seeded.
- **What seeding earns** on the seeding alert, when [automatic VIP](#automatic-vip) is on.
- **A match summary** when a match ends, if the server was live during it: map, winning faction and score,
  length, peak population, and the top 5 players by kills with deaths and K/D.

Posts are Discord embeds in one style: a population bar in the colour of the state (🟨 seeding, 🟩 live, 🟥 low
pop), medals for the top three players, each faction with its own emoji (🤠 Lonestar, 🐻 Valkyra, 🦂 Manticore; any
other faction gets a dot in its in-game colour), each map with its own colour (🟧 Bakurani, 🟦 Ozeti, 🟪 Zestafona,
the same as on the website; `/rotation` takes the colour of the map being played), and match summaries in the winning
faction's colour.

And it has Discord slash commands: `/serverstatus`, `/players`, `/lastmatch`, `/rotation` and, for admins,
`/broadcast`, `/seeders` and `/removematch` (Cloudflare only; see [Slash commands](#slash-commands)).

On Cloudflare it also serves **`GET /api/stats`** for a community website: live status, 24 hours of
population, daily peaks, the current and recent matches, Discord member counts and a public leaderboard
(see [Website stats](#website-stats)). It keeps [player records](#player-records):
every finished match's full scoreboard, and each player's seeding, play time, kills and deaths. And it gives
[automatic VIP](#automatic-vip): seed on 3 days in a week and get a reserved slot for a week.

Alerts and summaries go through a Discord webhook. Every 60 seconds the bot reads `GET /v1/status` and
`GET /v1/players` from the server's RCON listener.

## Setup

1. **RCON address and password.** From your host's control panel (QONZER, BisectHosting, xREALM), or
   `[/Script/WDRCON.WDRCONSettings]` in `ServerSettings.ini`. The address is the server IP and RCON port,
   written as a URL: `http://203.0.113.10:7776` (7776 is the default port; use whatever port your host
   gives you). No path after the port. If your host puts RCON behind HTTPS, use the `https://` address
   it gives you. Quotes, spaces and a missing `http://` are tidied up automatically.
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
3. Optionally set the role ID and thresholds in the `vars` block of `wrangler.jsonc`, and `SITE_URL` (your community
   website, such as `https://gaminginit.com`): post titles then link to it, and their footer points people there.
4. Deploy:
   ```bash
   npm run deploy
   ```
   Wrangler prints the Worker's URL, like `https://wardogs-discord-bot.<you>.workers.dev`. You need it
   for `/serverstatus`.

Logs are under Workers & Pages → wardogs-discord-bot → Logs in the Cloudflare dashboard. The first run
logs `Watching "<server name>": N/M players`. `RCON rejected the password (401)` means the password
is wrong; `timed out` means the address or port is wrong or the host's firewall blocks it. On Workers the check always runs every minute;
`POLL_INTERVAL_SECONDS` is not used.

To change a threshold later, edit `wrangler.jsonc` and run `npm run deploy` again.

Workers' `fetch()` cannot call a bare IP address or a port like 7776, so on Workers the bot opens a TCP
socket to the RCON listener and sends the HTTP request itself.

## Slash commands

| Command         | Who                  | What                                                               |
| --------------- | -------------------- | ------------------------------------------------------------------ |
| `/serverstatus` | Everyone             | Population, state (empty / seeding / live), map and score          |
| `/players`      | Everyone             | Who is online, with kills and deaths (top 30)                      |
| `/lastmatch`    | Everyone             | The summary of the last finished match, and when it ended          |
| `/rotation`     | Everyone             | The current map and the next few in the rotation                   |
| `/broadcast`    | Staff only           | Sends a message (up to 200 characters) to everyone in game         |
| `/seeders`      | Staff only           | Top 25 seeders over the last 7 days (or `days`: 1–90): seed days, minutes, Steam ID and VIP |
| `/removematch`  | Staff only           | Deletes a wrongly recorded match, picked from the recent matches, and its leaderboard counts |
| `/warn`         | Staff only           | Sends a player in game a private message: "Staff warning: …"       |
| `/player`       | Staff only           | A player's Steam ID, playtime and seeding (90 days), VIP, ban and staff history |
| `/kick`         | Staff only           | Removes a player from the server, with a reason they see; they can rejoin |
| `/switchteam`   | Staff only           | Moves a player to another team (`team`, or the other one when there are two) and respawns them |
| `/ban`          | Staff only           | Bans a player for 1 hour, 1 day, 3 days, 7 days, 30 days or for good, with a reason |
| `/unban`        | Staff only           | Lifts a ban                                                        |
| `/setnextmap`   | Staff only           | Sets the map after this match, and optionally its mode, infantry only, hardcore, lighting and zones, without changing the rotation |
| `/changemap`    | Staff only           | Ends the current match now and changes to the map, with the same options |
| `/vip add`      | Staff only           | Gives a player a reserved slot for 1–365 days                      |
| `/vip remove`   | Staff only           | Takes a player off the reserved list; automatic VIP skips them for 7 days |

Every player, team, map and ban option lists the choices as staff type. See [Staff commands](#staff-commands).

Slash commands need a Discord application, because webhooks cannot receive commands. Discord sends each
command to the Worker's URL; nothing has to stay connected.

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → New Application.
2. On **General Information**, copy the **Application ID** and **Public Key**. Store the public key:
   ```bash
   npx wrangler secret put DISCORD_PUBLIC_KEY
   npm run deploy
   ```
3. Still on **General Information**, set **Interactions Endpoint URL** to the Worker's URL and save.
   Discord checks the endpoint straight away; if saving fails, the public key is wrong or not deployed.
4. On **Bot**, click **Reset Token** and copy the token. It is only used to register the command, so
   it does not need to be stored anywhere.
5. Register the command. Put both values in `.env` (it is git-ignored; no quotes needed), which works the
   same on Windows, macOS and Linux:
   ```
   DISCORD_APPLICATION_ID=123456789012345678
   DISCORD_BOT_TOKEN=<token from the Bot page>
   ```
   then run:
   ```bash
   npm run register
   ```
   It prints `Registered: /serverstatus, /players, …`. A 401 means the token is wrong: it must come from **Bot →
   Reset Token**, not the Public Key or the OAuth2 Client Secret.
   This replaces the app's whole command list, so running it again after an update also removes
   commands that no longer exist (such as the old `/status`).
6. Add the app to your Discord server by opening this link:
   `https://discord.com/oauth2/authorize?client_id=<application id>&scope=applications.commands`

Commands reply publicly in the channel, except the staff commands, whose replies only the sender sees. If the game
server cannot be reached, the reply says so, and the reason is in the Worker logs. After adding or renaming
commands, run `npm run register` again.

Staff commands use the RCON password's write access, change the records or show Steam IDs, so they are locked down:

- It only works in your own Discord server. Set `DISCORD_GUILD_ID` in the `vars` block of `wrangler.jsonc`
  (enable Developer Mode, right-click your server's icon → Copy Server ID) and `npm run deploy`. Until it is
  set, staff commands are refused everywhere. Commands are registered globally, so without this an admin in any
  other server that added the app could control your game server.
- Only staff can use them: members with Discord's **Administrator** permission, or with a role listed in
  `DISCORD_ADMIN_ROLE_IDS` in the `vars` block of `wrangler.jsonc` (comma-separated role IDs; right-click the
  role in Server Settings → Roles → Copy Role ID). The Worker checks this on every use, so letting other roles
  see the commands in Discord still does not let them use them.
- Discord only shows staff commands to Administrators at first. To show them to a staff role too: Server
  Settings → Integrations → the bot → pick each staff command (or the whole app) → Add Roles or Members → the
  role → ✓. It lasts across deploys and `npm run register`, but new commands need it once each.
- Each broadcast is logged before it is sent and again once the server confirms it, with the sender's
  Discord user ID. If the reply says delivery could not be confirmed, check in game before sending again.


`/removematch` is for a match the bot recorded by mistake, such as part of a match it wrongly thought had ended.
Start typing and pick the match from the list of recent matches (map, result, length and end time, UTC). It takes
the match off the recent matches, deletes its record, and takes its match, kills and deaths back off its players'
totals for the day it ended. Seeding and play time are not changed. Each removal is logged with the admin's Discord
user ID. If a match was wrongly split into parts, remove every part except the last: the last part has everyone's
full kills and deaths.

The Node/Docker version does not support slash commands, because Discord needs a public HTTPS URL to send
commands to. Alerts, top seeders and match summaries work in both.

## Staff commands

For players, staff start typing and pick from the list, which shows each player's name, team and Steam ID.
`/warn`, `/kick` and `/switchteam` list the players in game. `/player`, `/ban` and `/vip add` also list players seen
in the last 30 days and players with VIP or a ban from the bot, and take any Steam ID. A name typed without picking
works when it matches exactly one player.

- **`/warn`** sends a private message in game, starting "Staff warning:", up to 140 characters.
- **`/kick`** needs a reason; the player sees it. They can rejoin.
- Warnings, kicks and the kick that comes with a ban tell the player where the rules are: "… | Rules: our Discord at
  gaminginit.com" (`SITE_URL`), or "… | Rules are in our Discord" without it.
- **`/switchteam`** lists the other teams in the match, with how many players and points each has. With two teams,
  leave `team` out to move them to the other one. Like the game's own console, the bot then kills the player so they
  respawn on the new side.
- **`/ban`** needs a length and a reason. The server's own bans are permanent (they go into `ServerSettings.ini`), so
  for a timed ban the bot writes when it ends into the reason, remembers it, and lifts the ban itself at the first
  check after it ends (within a minute), logging `Ban ended: …`. It only lifts a ban whose reason is still exactly
  the one it wrote: if someone lifted it and banned the player again some other way, that ban stays. A player in
  game is kicked too. A player who is already banned is left as they are; to change a ban, `/unban` them first.
- **`/unban`** lists the banned players. It works on any ban, however it was made.
- **`/setnextmap`** sets the map the server goes to when this match ends (`POST /v1/match/map`). The rotation is not
  changed. **`/changemap`** does the same, then ends the current match straight away (`POST /v1/match/end`); the
  server shows the end screen, then changes map. Both take how the map is played, all optional:

  | Option          | What                                                                      |
  | --------------- | ------------------------------------------------------------------------- |
  | `mode`          | The game mode, from the modes that map has                                |
  | `infantry_only` | Infantry only: on or off                                                  |
  | `hardcore`      | Hardcore: on or off                                                       |
  | `lighting`      | Time of day and weather                                                   |
  | `zones`         | The control-zone layout, from the layouts that map has                    |

  Anything left out is what the rotation plays that map with (for a map not in the rotation: its first mode, and the
  server's own lighting and zones). So `/setnextmap map:Ozeti infantry_only:True` is the rotation's Ozeti, infantry
  only. `mode` and `zones` list the choices once a map is picked. The reply says the setup, such as
  "Next map: **Ozeti** · King of the Hill · Infantry only · Day, clear".
- **`/vip add`** puts a player on the reserved list for the number of days given. It ends like automatic VIP: when
  the time is up, unless they have earned it by seeding by then. For a player who already has VIP from the bot, it
  sets the end to the later of the two. A reserved slot an admin added by hand in `ServerSettings.ini` is left as it
  is. **`/vip remove`** takes a player off the list, however they got there, and automatic VIP does not give it back
  for 7 days (`/vip add` lifts that). Both take effect at the server's next restart, like automatic VIP.
- **`/player`** shows the Steam ID with a link to the Steam profile, whether they are in game, their playtime,
  seeding and matches over the last 90 days, VIP, ban, and the staff history: the last 5 warnings, kicks, bans,
  unbans, team moves and VIP changes, with who did each.

The staff history only covers what staff do through the bot, from the deploy with these commands on. Each action is
also logged in the Worker logs with the staff member's Discord user ID. If a reply says an action could not be
confirmed, check in game before trying again: it may have gone through.

There is no chat log command: the game's RCON API has no way to read chat.

## Website stats

`GET <worker url>/api/stats` returns public JSON for a community website, such as
[gaminginit](https://github.com/ParagonJenko/gaminginit). Any site may read it (CORS `*`). It contains:

| Field          | What                                                                                   |
| -------------- | -------------------------------------------------------------------------------------- |
| `server`       | Name, players, max players, map, phase (`empty`/`seeding`/`live`), score, `seenAt`     |
| `history`      | `[time, players]` for every check in the last 24 hours                                 |
| `days`         | Peak players and minutes live for each of the last 14 days (UTC)                       |
| `currentMatch` | Map, start time, peak, score and the top 5 players by kills                            |
| `matches`      | The last 10 match summaries, newest first                                              |
| `discord`      | Server name, member count and online count, refreshed every 10 minutes                 |
| `thresholds`   | The seeding and live thresholds, so the site can say how many players are needed      |
| `leaderboard`  | Top 10 by kills, K/D (3+ matches), time played and seeding, over the last 30 days (UTC)  |
| `vip`          | What seeding earns (`seedDays`, `seedMinutes`, `windowDays`, `lengthDays`), or `null` when automatic VIP is off |

Times are Unix milliseconds. It never includes Steam IDs, the RCON address or the password: leaderboard rows
are names with their totals.

`server.seenAt` only moves when a check reaches the game server, so a site can tell the server is down when
it is a few minutes old. The stats are kept in the same Durable Object as the bot's state.

For the Discord counts, set `DISCORD_INVITE` in the `vars` block of `wrangler.jsonc` to an invite link that
does not expire (`https://discord.gg/abc123` or just `abc123`), then `npm run deploy`. Leave it empty to skip
them.

Every page view that loads the stats is a Worker request, and the free plan allows 100,000 a day,
including the bot's own 1,440 cron runs. Each Worker instance reuses its last answer for 30 seconds, and the
gaminginit site only polls once a minute while its tab is visible, which is plenty for a community site.

The Node/Docker version does not serve `/api/stats`.

## Player records

On Cloudflare, the bot also keeps records for leaderboards and seeder rewards (such as VIP). They are keyed by
Steam ID, so they are private: `/api/stats` never includes them. Admins can see the top seeders with `/seeders`.

| Record                       | What                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| Each finished match          | Map, start, live and end times, length, peak, faction scores, and every player's Steam ID, name, kills and deaths |
| Each player, each UTC day    | Name, seeding minutes, live minutes, whether they had a successful seed, matches played, kills, deaths |
| Each player's staff history  | The last 50 warnings, kicks, bans, unbans, team moves and VIP changes made through the bot: when, by whom (Discord user ID), and why |
| Bans the bot made            | Name, reason, who made it, and when a timed ban ends                                    |

- A match counts the same way as the match summary: only matches that went live, and not the one already running
  when the bot started. Its kills and deaths go on the day it ended, to everyone seen in it, including players who
  only seeded it and left.
- Seeding is the time from an empty server until it first goes live: each check (every minute) adds a minute for
  everyone online. Once the server has been live, time online counts as live minutes until it empties, even if it
  drops below `LOW_POP_THRESHOLD`. The check that finds the server live counts as live.
- A successful seed is being online for more than `VIP_SEED_MINUTES` (default 10) of that seeding, and the server
  then going live. It marks the day it went live (UTC), once however many times it happens that day.
- Records are kept for good. They start from the first deploy with this feature; older matches only have the
  public top 5, without Steam IDs.
- Both are stored in the same Durable Object as the bot's state, so they are covered by the free plan: a check
  writes one row for the day's totals, however many players are online.

The Node/Docker version does not keep player records.

## Automatic VIP

Players who seed get a reserved slot, so they skip the queue when the server is full:

- **Seed on 3 days in a week** (`VIP_SEED_DAYS` successful seeds in the last 7 UTC days, including today), and the
  bot adds you to the server's reserved list for **a week**.
- When the week is up, you come off the list, unless you earned it again during that week. Then it runs for
  another week.
- The bot checks every 10 minutes. The game server only reads the reserved list when it restarts, so VIP starts
  (and ends) at the server's next restart, usually its daily one.
- When players get a reserved slot, or keep one for another week, the bot posts it to the Discord channel
  ("🎖️ Reserved slots for seeders: **Ash and Bo** earned reserved slots for a week by seeding.") with what seeding
  earns. It never pings anyone. If the post fails it is logged, not retried, so nobody is announced twice.

Set it in the `vars` block of `wrangler.jsonc`, then `npm run deploy`:

| Variable           | What                                                                   | Default in `wrangler.jsonc` |
| ------------------ | ---------------------------------------------------------------------- | --------------------------- |
| `VIP_SEED_DAYS`    | Days with a successful seed needed in a week. `0` turns automatic VIP off | `3`                      |
| `VIP_SEED_MINUTES` | A seed counts when a player is on for more than this, and it goes live | `10`                        |

How it changes the server:

- Live WARDOGS builds only change reserved slots through `ServerSettings.ini`, so the bot reads it with
  `GET /v1/config`, adds or removes `+DefaultReservedPlayerIds=<Steam ID>` lines in
  `[/Script/WDGame.WDGameSession]`, checks the result with `POST /v1/config/validate`, and writes it back with
  `PUT /v1/config`. Every other line stays exactly as it was.
- It writes with the revision it read, so if someone edits the file in between, the server refuses the write and
  the bot tries again 10 minutes later.
- It only removes players it added itself. Reserved slots an admin gave out by hand are never touched, and a
  player who already has one is left as they are.
- If an admin takes a bot-given VIP off the list, the bot forgets it. It adds them again only if they earn it again.
- If the file removes reserved players with `-DefaultReservedPlayerIds` or `!DefaultReservedPlayerIds` lines, the
  bot stops and logs why, rather than guess. Remove those lines by hand to let it work.
- `MaxReservedSlots` in the same section sets how many slots are held back for reserved players. The bot does not
  change it.
- Each change is logged (`VIP added: …`, `VIP ended: …`), and `/seeders` shows who has VIP from the bot and until when.
- Staff can give or take away VIP by hand with [`/vip add` and `/vip remove`](#staff-commands).

Turning it off (`VIP_SEED_DAYS` `"0"`) stops players earning it. VIP the bot already gave, by seeding or through
`/vip add`, still ends on time.
Automatic VIP is Cloudflare only.

## In-game messages

During a match, the bot broadcasts short messages in game that point players at the website (`SITE_URL`) for the
leaderboard, the Discord and seeding:

| When                                             | Message                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| 10 minutes after the match went live             | 10 minutes in and nobody has rage quit yet. Rules are in our Discord, leaderboard at gaminginit.com |
| A team reaches half of `SCORE_TO_WIN` (50)        | Halfway there! Valkyra leads on 52. Not my points, OUR points, comrade. Seed on 3 days in a week and get a reserved slot. How at gaminginit.com (without VIP: the leaderboard and Discord) |
| The first team to reach 90% of `SCORE_TO_WIN` (90) | Valkyra has 90! Victory for the motherland is in sight, comrades. Where do you rank? Leaderboard, Discord and seeding at gaminginit.com |

- Every line the bot says in game is in one list, `src/lines.ts`: the 10-minute lines, and for halfway and 90 points
  a list for each faction (🤠 Lonestar, 🦂 Manticore, 🐻 Valkyra), plus lines for level scores and for any other
  faction. Each time a message goes out, one line is picked at random from its list (for halfway and 90 points, from
  the leading faction's list). Add, remove or reword lines there and `npm run deploy`; `{team}`, `{score}` and
  `{site}` are filled in. The tests check every line still fits the game's 200 characters.
- The halfway and 90-point messages name only the team in front. Factions are matched however the server spells them
  ("LONESTAR", "Lone Star").
- Each goes out once per match, and at most one per check (a minute), so they never arrive in a burst. The 90-point
  message is for the first team to get there only, not one per team.
- After the bot restarts or is deployed mid-match, milestones the match already passed are not announced late.
  The 10-minute message only goes out for a match the bot saw go live.
- A message that fails to send is logged (`In-game message failed: …`) and not tried again.
- They use the RCON password's write access (`POST /v1/broadcast`), like `/broadcast`.

Set `MATCH_MESSAGES` to `"off"` in the `vars` block of `wrangler.jsonc` to stop them, and `SCORE_TO_WIN` if a match
is won at a score other than 100. They need `SITE_URL`; without it none are sent.

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
- A drop only counts once it has lasted `DROP_GRACE_MINUTES` (default 5). If a live server crashes or restarts and
  fills again within that time, there is no low-pop alert, no seeding alert and no live alert, and nobody gets
  seeding credit for rejoining. A drop that lasts longer gets its low-pop alert then. `0` alerts straight away.
- `LOW_POP_THRESHOLD` can be set lower than `LIVE_THRESHOLD` (for example live at 40, warn below 30) to
  give more slack before the warning.
- Seeding time is counted once per check (every minute) for everyone online while the server is seeding.
  The check that finds the server live does not count, so players who join at 20+ are not credited. The
  count resets when the server goes live, and only starts again once it has emptied: a live server that drops
  below `LOW_POP_THRESHOLD` is not seeding.
- WARDOGS RCON does not report when a match ends. The bot treats a map change, a restart on the same map, or
  the server emptying as the end of a match, and summarises it from the last stats it saw. That can miss up to
  one minute at the end of the match. A restart means the faction scores drop and most players' kills and
  deaths start again from 0 at once. One player's counters starting again (they rejoined or switched team)
  is not a new match: their earlier kills and deaths are kept and the new ones added. The rotation slot
  moving, or a reading without the map, does not end a match either. Players who left mid-match keep their
  last stats. Length is timed from when the server went live. Matches that never went live are not
  summarised, and neither is the match already running when the bot starts.
- With three or more factions, the summary names them all: "**Valkyra** won 100, Kharr 67, Haldor 41".
- If a Discord post fails, the alert is retried on the next check while it is still true. A match summary
  is retried until it posts, or until the next match ends. Matches are recorded before their summary is
  posted, so a Discord outage does not lose them. If RCON is unreachable (for example during the game's
  daily restart), the check is skipped and logged; no alert is sent for the outage itself.

## Security

The RCON password gives full admin control of the server (kick, ban, end match, change settings). On its own
the bot only reads the server, sends the [in-game messages](#in-game-messages) (`POST /v1/broadcast`), changes the
reserved list in `ServerSettings.ini` for [automatic VIP](#automatic-vip) (`PUT /v1/config`) and lifts timed bans
when they end (`DELETE /v1/bans/…`). Everything else it changes is asked for by staff through a
[staff command](#staff-commands). Still:

- Keep the password in a Wrangler secret or `.env`, never in `wrangler.jsonc` or the repo.
- Over `http://`, the password is sent unencrypted on every check. Use an `https://` RCON address if
  your host offers one.
- `/serverstatus` requests are only accepted with a valid Discord signature (checked against
  `DISCORD_PUBLIC_KEY`) and a timestamp within 5 minutes, so nobody else can make the Worker call your
  server and a captured request cannot be replayed later.
- Player names in posts are escaped, and posts never ping anyone except the configured role.

## Development

```bash
npm ci
npm test
npm run typecheck
```
