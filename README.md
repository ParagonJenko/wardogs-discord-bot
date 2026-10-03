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
- **A [live server status](#live-server-status)** (Cloudflare only): one message in a channel of its own,
  edited every minute with the state, players, map, next map, score and top players.
- **[Weekly and monthly roundups](#roundups)** (Cloudflare only): the team of the week or month, the top 3 players for
  kills, K/D, kills in a match, wins, MVPs, time played and seeding, and the highlights.
- **A [moderation log](#moderation-log)** (Cloudflare only), in a staff channel: every warning, kick, ban, unban and team
  move with its reason and who did it, bans made or lifted outside the bot, and possible griefing as it happens.

Posts are Discord embeds in one style: a population bar in the colour of the state (🟨 seeding, 🟩 live, 🟥 low
pop), medals for the top three players, each faction with its own emoji (🤠 Lonestar, 🐻 Valkyra, 🦂 Manticore; any
other faction gets a dot in its in-game colour), each map with its own colour (🟧 Bakurani, 🟦 Ozeti, 🟪 Zestafona,
the same as on the website; `/rotation` takes the colour of the map being played), and match summaries in the winning
faction's colour.

And it has Discord slash commands: `/serverstatus`, `/players`, `/lastmatch`, `/rotation`, `/roundup` and, for admins,
`/broadcast`, `/seeders`, `/seednow` and `/removematch` (Cloudflare only; see [Slash commands](#slash-commands)).

On Cloudflare it also serves **`GET /api/stats`** for a community website: live status, 24 hours of
population, daily peaks, the busiest hours, the current and recent matches, Discord member counts and a public
leaderboard (see [Website stats](#website-stats)). It serves a page of stats for every player, too (see
[Player pages](#player-pages)). It keeps [player records](#player-records):
every finished match's full scoreboard, and each player's seeding, play time, kills and deaths. It takes the game's
kill feed for [weapon stats](#weapon-stats): the weapons people use most, and each player's, and for a
[live match page](#live-match): the kill feed, streaks and highlights of the match on now, as it happens. It gives
[automatic VIP](#automatic-vip): seed on 3 days in a week and get a reserved slot for a week. And it runs the website's
[staff page](#staff-page): staff sign in with Discord to see possible griefers (team kills, suicides in vehicles), the
moderation log and the bans on the server.

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

## Live server status

One message in a channel of its own that the bot edits every minute, so anyone can see the server at a glance:

- **State:** live, seeding (and how many more it needs), empty, or offline with when it was last seen.
- **Players:** the population bar.
- **Maps:** the map, and the next map.
- **Timing:** when the match started, or how long the server has been seeding.
- **Score:** each team's score, with how many players are on each team.
- **Top players:** the top 3 this match, by kills.

Discord shows when it was last updated next to the footer, and times like "34 minutes ago" count up by themselves.

To set it up:

1. Make a channel, such as `#server-status`. In its permissions, turn off **Send Messages** for `@everyone`, so the
   status stays the only message there.
2. In that channel: settings → Integrations → Webhooks → New Webhook → Copy Webhook URL. Make a new webhook rather
   than reusing the alerts one, or alerts would push the status up the channel.
3. Store it as a secret:
   ```bash
   npx wrangler secret put DISCORD_STATUS_WEBHOOK_URL
   ```

The next check posts the message, and every check after that edits it.

- **Deleted message:** the next check posts a new one.
- **Changed webhook:** the bot posts in the new channel, and you delete the old message yourself.
- **Server stops answering:** the message stays as it was for 3 minutes (a slow reply or a quick restart), then
  shows the server as offline.
- **Next map:** the rotation's next map, or the map staff set with `/setnextmap` or `/changemap` while this match
  is on.
- **Turning it off:** delete the secret (`npx wrangler secret delete DISCORD_STATUS_WEBHOOK_URL`).

It costs one more RCON request (the rotation) and one Discord edit a minute. The Node/Docker version does not
have it.

## Roundups

Every Monday the bot posts a roundup of the week before (Monday to Sunday, UTC) to the alerts channel, and on the 1st of
every month a roundup of the month before. Each one celebrates:

| Section                 | What                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------- |
| Summary                 | Matches, time played, players and the peak                                              |
| 🏆 Team of the week     | The side with the best win rate, from 3 matches up. None when the top two are level     |
| ⚔️ Teams                | Every side's wins, losses, draws and win rate, best first                               |
| 🔫 Most kills           | The top 3 by kills                                                                     |
| 🎯 Best K/D             | The top 3 by K/D, from 3 matches up, like the website's leaderboard                    |
| 💥 Most kills in a match | Each player's best match, top 3, with the map                                         |
| 🏅 Most wins            | Matches won on the winning side, out of the matches they played                         |
| ⭐ Most MVPs            | Times top of a match's scoreboard (most kills, then fewest deaths; players level share it) |
| ⏱️ Most time played     | Seeding and live time                                                                  |
| 🌱 Top seeders          | Seed days, then seeding time                                                           |
| ✨ Highlights           | The biggest win, the closest finish, the map played most and the busiest day           |

- Names link to each player's page on the website when `SITE_URL` is set. Posts never ping anyone.
- It goes out at `ROUNDUP_HOUR` (UTC, default `17`: 6pm in the UK in summer, 5pm in winter), on the Monday, and on the
  1st for the month. When the 1st is a Monday, both go out.
- A match counts in the week it ended, like the leaderboard. A week or month nobody played in gets no post.
- If the post fails, the bot tries again at each check until the end of that day. A bot deployed after that day waits
  for the next week, rather than posting a late one.
- Anyone can see a roundup any time with `/roundup`: last week, last month, or this week or month so far.
- They come from the [player records](#player-records), so they cover matches since those started.

Set them in the `vars` block of `wrangler.jsonc`, then `npm run deploy`:

| Variable       | What                                                       | Default |
| -------------- | ---------------------------------------------------------- | ------- |
| `ROUNDUPS`     | `"on"` or `"off"`                                          | `"on"`  |
| `ROUNDUP_HOUR` | The hour (UTC, 0 to 23) the roundups go out                 | `"17"`  |

To post them in a channel of their own, such as `#hall-of-fame`, make a webhook there and store it as a secret:

```bash
npx wrangler secret put DISCORD_ROUNDUP_WEBHOOK_URL
```

The Node/Docker version does not post roundups.

## Slash commands

| Command         | Who                  | What                                                               |
| --------------- | -------------------- | ------------------------------------------------------------------ |
| `/serverstatus` | Everyone             | Population, state (empty / seeding / live), map and score          |
| `/players`      | Everyone             | Who is online, with kills and deaths (top 30)                      |
| `/lastmatch`    | Everyone             | The summary of the last finished match, and when it ended          |
| `/rotation`     | Everyone             | The current map and the next few in the rotation                   |
| `/roundup`      | Everyone             | The [roundup](#roundups) of last week (default), last month, or this week or month so far |
| `/broadcast`    | Staff only           | Sends a message (up to 200 characters) to everyone in game         |
| `/seeders`      | Staff only           | Top 25 seeders over the last 7 days (or `days`: 1–90): seed days, minutes, Steam ID and VIP |
| `/seednow`      | Staff only           | Posts "We're going to try to seed now. Come join!" to the alerts channel and pings the role, with an optional `message` |
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


`/seednow` posts a seeding call to the alerts channel (`DISCORD_WEBHOOK_URL`) whenever staff want one, without waiting
for the server to reach `SEEDING_THRESHOLD`. It looks like the seeding alert (players, map, how many more to go live and,
when [automatic VIP](#automatic-vip) is on, what seeding earns), says "We're going to try to seed now. Come join!", adds
the optional `message` (such as which squad to join) and who called it, and pings `DISCORD_ROLE_ID` if it is set.

- It sends nothing when the server is already live.
- It counts as the seeding alert: if the first players join within `ALERT_COOLDOWN_MINUTES` (default 10), there is no
  automatic seeding alert as well, so the role is not pinged twice. Its time is saved before it is posted, and it never
  goes out while a check is running, so a slow post or a check at the same moment cannot ping twice either.
- Each call is logged with the staff member's Discord user ID before anything is sent, and again once it is posted.

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
- **`/switchteam`** only offers the game's three teams: Lonestar, Manticore and Valkyra. A team that is not in the
  match is refused. With two teams, leave `team` out to move them to the other one. Like the game's own console, the
  bot then kills the player so they respawn on the new side.
- **`/ban`** needs a length and a reason. The server's own bans are permanent (they go into `ServerSettings.ini`), so
  for a timed ban the bot writes when it ends into the reason, remembers it, and lifts the ban itself at the first
  check after it ends (within a minute), logging `Ban ended: …`. It only lifts a ban whose reason is still exactly
  the one it wrote: if someone lifted it and banned the player again some other way, that ban stays. A player in
  game is kicked too. A player who is already banned is left as they are; to change a ban, `/unban` them first.
- The game only bans players who are in game: for anyone else it answers `404 player_not_found`. So when staff ban
  someone who is not on, the bot keeps the ban and puts it on the server, with a kick, at the first check that sees
  them join (within a minute), logging `Ban put on the server as they joined: …`. A kick that fails is tried again
  at each check until they have gone. The ban's time runs from when staff
  made it, so a timed ban that ends before they join is dropped. `/player` shows such a ban as not on the server yet.
- **`/unban`** lists the banned players. It works on any ban, however it was made, and also cancels a ban still
  waiting for the player to join (type their name or Steam ID: the list only shows the server's bans).
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

The staff history covers what staff do through the bot, from the deploy with these commands on, and bans made or lifted
outside the bot, from the deploy with the [moderation log](#moderation-log) on. Each action is
also logged in the Worker logs with the staff member's Discord user ID. If a reply says an action could not be
confirmed, check in game before trying again: it may have gone through.

There is no chat log command: the game's RCON API has no way to read chat.

## Moderation log

A staff-only Discord channel where the bot posts, as they happen:

| Post                    | When                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| ⚠️ Warning, 👢 Kick, 🔨 Ban, ✅ Unban, 🔀 Team move | Staff use `/warn`, `/kick`, `/ban`, `/unban` or `/switchteam`. With the player, their Steam ID, the reason, the length of a ban and who did it |
| ✅ Unban by the bot      | A timed ban runs out                                                                       |
| 🔨 Ban / ✅ Unban outside the bot | A ban made or lifted some other way: in game, in `ServerSettings.ini`, or by another tool. With the reason and who the server says made it |
| 🚩 Possible griefing     | A player reaches 3, 6, 9… team kills in a day, 2, 4, 6… suicides in a vehicle, or kills the same teammate a second time that day. With their latest incidents. Needs the [kill feed](#weapon-stats) |

To set it up:

1. Make a channel only staff can see, such as `#mod-log`.
2. In that channel: settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.
3. Store it as a secret:
   ```bash
   npx wrangler secret put DISCORD_MODLOG_WEBHOOK_URL
   ```

- Staff are mentioned by name (`@Sarge`), which never pings them. Posts link to the [staff page](#staff-page) when
  `SITE_URL` is set.
- **Bans outside the bot.** Each check (every minute) reads the server's ban list (`GET /v1/bans`) and compares it with
  the last one. A ban that appeared or went that the bot did not make is posted, and goes in the player's staff history
  (`/player`) too. The first check after the deploy only saves the list, so the bans already there are not posted. It
  costs one more RCON request a minute.
- **Kicks outside the bot** cannot be seen: the game's RCON does not report them, and its kill feed only has deaths.
- **Possible griefing** posts can be turned off with `GRIEF_ALERTS` `"off"` in the `vars` block of `wrangler.jsonc`.
  They are a reason to look, not proof: sides come from the bot's last check (see [Staff page](#staff-page)).
- A post that fails is logged (`Moderation log post failed`) and not retried: the staff history has it either way.
- **Turning it off:** delete the secret (`npx wrangler secret delete DISCORD_MODLOG_WEBHOOK_URL`). The staff history and
  the staff page still record everything.

The Node/Docker version does not have the moderation log.

## Staff page

The website has a page for staff (gaminginit's `/admin`). Staff sign in with Discord, and the page shows:

- **Possible griefers** over today, 7 or 30 days: everyone who team killed, was team killed or killed themselves, from
  the [kill feed](#weapon-stats). A player's day is flagged for 3 or more team kills, killing the same teammate twice
  or more, 2 or more suicides in a vehicle (crashing it, or blowing it up with themselves in it), or 10 or more
  suicides. Most flagged days first, with their matches, kills and time played for scale, and whether they are banned.
- **Team kills and vehicle suicides**, each with when, who, which teammate, with what, how far and on which map.
- **The moderation log**: every warning, kick, ban, unban and team move through the bot, with the reason and who did
  it, and bans made or lifted outside the bot.
- **The bans on the server**, with their reasons, who made them and when timed bans end, and bans waiting for the
  player to join.
- **The reserved slots**: everyone on the reserved list in `ServerSettings.ini`, with VIP from the bot and when it ends,
  or added by hand, how many slots `MaxReservedSlots` holds back, and any `-`/`!DefaultReservedPlayerIds` lines that
  stop [automatic VIP](#automatic-vip) until someone edits them out.
- **Admin tools**: every staff slash command, run from the page: warn, kick, move team, ban, unban, look up a player,
  give or remove VIP, top seeders, message everyone in game, set the next map, change map now, call for seeders, and
  remove a wrongly recorded match. See below.

Staff are the same people who can use the [staff commands](#slash-commands): members of `DISCORD_GUILD_ID` with
Discord's **Administrator** permission, or with a role in `DISCORD_ADMIN_ROLE_IDS`, or the server's owner.

To set it up, with the [slash commands](#slash-commands) app:

1. In the [Discord Developer Portal](https://discord.com/developers/applications), open the app → **OAuth2**:
   - Under **Redirects**, add the Worker's URL with `/auth/callback` on the end, such as
     `https://wardogs-discord-bot.<you>.workers.dev/auth/callback`, and save.
   - Click **Reset Secret** under Client Secret, copy it, and store it:
     ```bash
     npx wrangler secret put DISCORD_CLIENT_SECRET
     ```
2. In the `vars` block of `wrangler.jsonc`, set `DISCORD_APPLICATION_ID` to the app's **Application ID** (General
   Information; the same one as in `.env`). It is not secret. Don't set it in the Cloudflare dashboard instead: every
   deploy replaces the dashboard's variables with `wrangler.jsonc`'s. `DISCORD_GUILD_ID` and `SITE_URL` must be set too.
   If one is missing, the Worker logs say which (`Staff sign-in is not set up on the bot. Missing: …`), and so does the
   staff page, as long as `SITE_URL` itself is set: without it no site may read the bot's answer.
3. Optionally, so the page names every staff member (see below), store the bot token from `.env` as a secret:
   ```bash
   npx wrangler secret put DISCORD_BOT_TOKEN
   ```
4. `npm run deploy`.

How it works:

- The page's "Sign in with Discord" goes to `<worker>/auth/login`, which sends the browser to Discord. Discord asks the
  person to let the app know who they are, their servers and their roles in them (scopes `identify`, `guilds` and
  `guilds.members.read`), once. Discord then sends them back to `/auth/callback`, and the Worker asks Discord whether
  they are staff in your server. The Discord access token is used for that and then dropped.
- Staff go back to the page with a session that lasts 8 hours. It is signed with `DISCORD_CLIENT_SECRET`, so resetting
  the client secret signs everyone out. Someone who stops being staff can use a session they already have until it
  runs out.
- Anyone else goes back to the page with why: not in the server, or not staff. Each sign-in is logged
  (`Staff signed in: …`, `Staff sign-in refused: …`).
- The page reads `GET /api/admin/overview?days=1|7|30` with the session as a bearer token. Only `SITE_URL` may read it
  from a browser, it is never cached, and it is the only place the bot shows Steam IDs outside Discord. Each load also
  reads the server's ban list and `ServerSettings.ini` (two RCON requests).
- Sign-ins only go back to pages on `SITE_URL`, so a session is never handed to another site.

Admin tools: the page runs the staff commands through the bot, as the signed-in staff member:

- `GET /api/admin/commands` gives the page the staff commands as Discord has them, and it builds its forms from them, so
  they always match. `POST /api/admin/suggest` fills the pick-lists (players, teams, maps, modes, bans, the reserved
  list, recent matches) from the same suggestions Discord shows, and `POST /api/admin/command` runs one.
- A command is checked the way Discord checks one (its options only, required ones given, lengths, ranges and choices),
  then run by the same code as the slash command, so it does exactly the same: the same replies, the staff history,
  the [moderation log](#moderation-log) and the Worker logs, with the staff member's Discord user ID and name. Each is
  also logged as `Staff page: /<command> by "<name>" (Discord user <ID>)`.
- The page asks before anything that changes the game or the records, such as a kick, a ban or a map change.

Staff names: the bot's records name staff by their Discord user ID, so the page puts names to them:

- The bot learns each staff member's name, the one they go by in the server, and their Discord username, when they sign
  in to the page or use a staff command. Each warning, kick, ban and team move also keeps the name of who made it.
- With `DISCORD_BOT_TOKEN`, it asks Discord (`GET /users/{id}`) about anyone it has not seen that way, such as staff who
  made bans before names were kept: up to 10 each time the page loads, and again after 30 days. A name from Discord is
  their display name, not their server nickname.
- Anyone it still has no name for shows as "Discord user" and their ID.

What the griefing figures can and cannot tell:

- **Sides.** The kill feed does not say who is on which side, so the bot takes it from its last check (every minute),
  like the [live match](#live-match). A kill between two players on the same side is a team kill. A player who switched
  sides in the last minute, or joined since the last check, can be counted wrongly, and a team kill where either side is
  not known is left out.
- **Suicides** are deaths the game tags as a suicide, or a player killing themselves. A suicide with a vehicle (the game
  blames the vehicle, or says it blew up or ran someone over) is a vehicle suicide. `/switchteam` kills the player so
  they respawn, which the game may count as a suicide.
- **Vehicles destroyed** without anyone dying in them are not in the feed, so they are not counted.
- Each day keeps its latest 300 incidents; the counts are always complete.
- They start from the deploy with this feature. Like the other records, they are kept for good.

The Node/Docker version does not have the staff page.

## Website stats

`GET <worker url>/api/stats` returns public JSON for a community website, such as
[gaminginit](https://github.com/ParagonJenko/gaminginit). Any site may read it (CORS `*`). It contains:

| Field          | What                                                                                   |
| -------------- | -------------------------------------------------------------------------------------- |
| `server`       | Name, players, max players, map, phase (`empty`/`seeding`/`live`), score, `seenAt`     |
| `history`      | `[time, players]` for every check in the last 24 hours                                 |
| `days`         | Peak players and minutes live for each of the last 14 days (UTC)                       |
| `hourly`       | `{ "days": 14, "players": [24 numbers], "busy": [24 numbers] }`: for each UTC hour (0 to 23) over the last 14 days, the average players and the share of readings (0 to 1) with at least `thresholds.busy` players. `null` for an hour with no readings (for `busy`: none checked against that threshold) |
| `currentMatch` | Map, start time, peak, score and the top 5 players by kills                            |
| `matches`      | The last 10 match summaries, newest first                                              |
| `discord`      | Server name, member count and online count, refreshed every 10 minutes                 |
| `thresholds`   | The seeding and live thresholds, so the site can say how many players are needed, and `busy` (`BUSY_THRESHOLD`, default 97): the players from which the server counts as busy |
| `leaderboard`  | Top 10 by kills, K/D (3+ matches), time played and seeding, over the last 30 days (UTC)  |
| `vip`          | What seeding earns (`seedDays`, `seedMinutes`, `windowDays`, `lengthDays`), or `null` when automatic VIP is off |
| `weapons`      | The top 10 weapons by kills over the last 30 days (UTC), from the [kill feed](#weapon-stats). See below. `null` until the bot has had the feed |

Times are Unix milliseconds. It never includes Steam IDs, the RCON address or the password. Each player on the
leaderboard and in the current and recent matches has their name, their totals and an `id` for their
[player page](#player-pages). Matches recorded before ids were added have names only.

`weapons` has:

| Field      | What                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `days`     | How many UTC days it covers, today included: 30                                                |
| `since`    | The UTC day the bot first had the kill feed. Kills before it have no weapon                    |
| `kills`    | Every kill in the feed in those days, and `headshots`, how many of them were headshots         |
| `top`      | Most kills first: each weapon's `name`, `kind` (`weapon`, `vehicle-weapon`, `vehicle` or `buildable`), `kills`, `headshots`, `averageDistance` in metres (null when the game sent no distances) and `longest`: its longest kill, `{ distance, name, id }` |
| `longest`  | The longest kill of all: `{ weapon, distance, name, id }`, or null                             |

`server.seenAt` only moves when a check reaches the game server, so a site can tell the server is down when
it is a few minutes old. The stats are kept in the same Durable Object as the bot's state.

The site's busy times are the hours when the server usually has `BUSY_THRESHOLD` players or more (default 97). Set
it in the `vars` block of `wrangler.jsonc`. Changing it counts busy readings again from the last 24 hours, and older
readings counted under another threshold, or from before busy counts were kept, are left out.

For the Discord counts, set `DISCORD_INVITE` in the `vars` block of `wrangler.jsonc` to an invite link that
does not expire (`https://discord.gg/abc123` or just `abc123`), then `npm run deploy`. Leave it empty to skip
them.

Every page view that loads the stats is a Worker request, and the free plan allows 100,000 a day,
including the bot's own 1,440 cron runs. Each Worker instance reuses its last answer for 30 seconds, and the
gaminginit site only polls once a minute while its tab is visible, which is plenty for a community site.

The Node/Docker version does not serve `/api/stats`.

## Player pages

Two more public endpoints let a website show every player's stats, not only the top 10:

| Endpoint                 | What                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `GET /api/players`       | Everyone seen in the last 90 days, most time played first: `id`, `name`, `minutes` played, `lastSeen` (UTC day) and whether they are `online` now |
| `GET /api/player?id=<id>` | One player's page, or 404 for an id nobody seen in the last 90 days has              |

A player page has:

| Field      | What                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------ |
| `name`     | The name they used most recently                                                           |
| `activity` | Each UTC day they were on in the last 90 days: seeding and live minutes, seed day, matches, kills and deaths |
| `matches`  | Their matches in the last 90 days (up to 500), newest first: map, end time, length, kills, deaths, place on the scoreboard out of how many, their side (`faction`), `result` (`won`, `lost` or `draw`) and every side's score, with its in-game colour (`colorHex`) when the server reported it |
| `ranks`    | Their place on each leaderboard board over the last 30 days (null when they are not on it), out of how many players |
| `online`   | When they are in game now: the map, their side, and their kills and deaths this match      |
| `vip`      | `{ until }` while they have a reserved slot from the bot                                   |
| `seeding`  | Their seed days in the VIP window and the rule they count towards, or `null` when automatic VIP is off |
| `weapons`  | From the [kill feed](#weapon-stats): `since` (as in `/api/stats`) and `used`, a row for each weapon on each day they killed with it in the last 90 days: `day`, `name`, `kind`, `kills`, `headshots` and `longest` (metres, or null). `null` until the bot has had the feed |

- Players are known by a public `id`, never their Steam ID: the first 12 hex characters of an HMAC of the Steam ID,
  with a random key the bot makes the first time it needs one and keeps in its storage (`playerIdKey`). Ids stay the
  same for good, so links to player pages keep working, and they cannot be turned back into Steam IDs.
- A match's `faction` and `result` are only known for matches recorded since the bot started keeping each player's
  side; older matches have `null`.
- Staff history, bans, warnings and Steam IDs are never on a player page.
- Like `/api/stats`, each Worker instance reuses an answer for 30 seconds. The Durable Object keeps past days and
  finished matches in memory, as they do not change, so a page only reads the last two days and any new matches.
  `/removematch` clears them.
- Who is in game is saved with each check (`online`), in the same write as the stats, so it survives the Durable
  Object restarting. It counts as unknown once the server has not answered for 3 minutes.
- A match counts on the UTC day it ended, like the player's days, so `matches` covers the same 90 days as `activity`.

The Node/Docker version does not serve player pages.

## Weapon stats

The game server can send the bot every kill as it happens: who killed whom, with what, from how far, and whether it was
a headshot. The bot adds them up by weapon for the website: the top 10 weapons over the last 30 days in
[`/api/stats`](#website-stats), and each player's weapons on their [player page](#player-pages).

To turn it on:

1. Make a long random token, such as the output of `openssl rand -hex 32`, and store it as a secret:
   ```bash
   npx wrangler secret put KILL_FEED_TOKEN
   ```
   It must be at least 16 characters.
2. In the game server's `ServerSettings.ini` (your host's file manager or config editor), add this section, with the
   Worker's URL and the same token:
   ```ini
   [WDServerFeed]
   Url=https://wardogs-discord-bot.<you>.workers.dev
   Token=<the token>
   ```
   Only the Worker's URL, with nothing after it: the game adds `/api/ingest/events` itself.
3. Restart the game server. It reads the section when it starts, so the daily restart also does.

When the first kills arrive, the Worker logs `Kill feed: first kills received`. `Kill feed refused: the token does not
match` means `Token` in the file is not the secret.

- **One feed per server.** The game sends its kills to one URL. If `[WDServerFeed]` already points at another tool,
  such as a server panel, pointing it at the bot stops that tool getting them.
- **From the day it starts.** Only kills from then on have a weapon. `since` says which day, and the website says it too.
- **What counts.** A kill counts for the weapon that made it: guns, grenades and tools, a vehicle's gun, a vehicle
  (running someone over, or blowing up with them in it) and things built, like barbed wire, which the game blames on
  whoever built it. Suicides, falls and deaths with nobody to blame are left out. The feed does not say who is on which
  side, so team kills count too.
- **Names.** The game sends tags like `Id.Item.AK74M`. The bot names the ones it knows (AK74), from
  [Warcon](https://github.com/warcon-app/warcon)'s list. A new one is named from its tag (`Id.Item.WEPN_035` is
  "WEPN 035") until it is added to `NAMES` in `src/weapons.ts`. Tags with the same name, like each side's M113, are one
  weapon.
- **Distances** are between the killer and the victim, in metres. A vehicle blowing up has none, so its average
  distance is left out.
- **A batch sent twice** counts once: the bot remembers the last 5,000 kills it counted, until it restarts.
- **`/removematch`** does not change weapon stats: they come from the feed, not from matches.
- **Requests.** Each batch is one Worker request. The game sends one at most every 2 seconds while people are being
  killed, and a capture of a busy server saw about 550 an hour: some 6,600 a day for a server live 12 hours a day,
  against the free plan's 100,000. Each is one storage write, of the day's totals and each killer's.
- **Turning it off:** delete the secret (`npx wrangler secret delete KILL_FEED_TOKEN`), and the section from
  `ServerSettings.ini`. Without the secret, the bot answers the game with a 404. The stats it kept stay.

The Node/Docker version does not take the kill feed: the game needs a public URL to send it to.

## Live match

With the [kill feed](#weapon-stats) on, the bot follows the match on now for the website's live page: every death as it
happens, each player's kills, deaths and streaks, and the match's highlights. It serves it two ways, both public and
without Steam IDs:

| Endpoint                      | What                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `GET /api/live`               | What the live page shows now (below). Each Worker instance reuses it for 5 seconds   |
| `GET /api/live/socket`        | A WebSocket: the same, straight away, and again after every kill feed batch and every check. Send `ping` to keep it open through quiet spells; the answer is `pong` |

It has:

| Field          | What                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------ |
| `feed`         | Whether the bot has ever had the kill feed                                                  |
| `server`       | As in [`/api/stats`](#website-stats): name, players, map, phase, score, `seenAt`            |
| `currentMatch` | As in `/api/stats`: the match on the server, with the top 5 by kills from its scoreboard. Null when the server is empty or not answering |
| `match`        | The kill feed's match, or null before it has a death. See below                             |

`match` has the map, when its first and latest deaths came in (`startedAt`, `lastKillAt`), the kills, headshots, team
kills and other deaths (`otherDeaths`: suicides and falls), and:

| Field        | What                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------- |
| `feed`       | The last 40 deaths, newest first: `killer` (null for a fall or suicide) and `victim` (`name`, `id`, `faction`), `weapon`, `kind`, `distance`, `headshot`, `teamKill`, `tags` (`RoadKill`, `Penetration`, `Ricochet`, `WeaponMelee`, `VehicleExplosion`, `Falling`, `Suicide`), and the killer's `streak` and `chain` after it |
| `players`    | The top 10 by kills, then fewest deaths: kills, deaths, headshots, team kills, `streak` (kills since they last died), `bestStreak` and the `weapon` they have the most kills with |
| `weapons`    | The top 5 weapons this match                                                                   |
| `highlights` | `firstBlood`, `longest` kill, `bestStreak` (3 or more), `onFire` (up to 3 players on 5 or more kills without dying now), `bestMultiKill` (2 or more kills each within 8 seconds), `mostHeadshots`, and a `rivalry` (one player killing another 3 or more times) |

- **Sides.** The feed does not say who is on which side, so the bot takes it from its last check of the server. Two
  players on the same side make a team kill, which counts as neither a kill nor towards a streak.
- **Streaks.** Any death ends one: a fall or a suicide too.
- **A new match.** The feed does not say when a match ends. A new one starts when the match clock starts again (the game
  restarts it with each match), the map changes, the game restarts, or nobody dies for 20 minutes. The page shows the
  feed's match only while it is the one on the server: on the same map, and not over before the bot's checks saw the
  server's match start. With nobody on, it stays up for 10 minutes after its last death.
- **Cost.** A page opening its WebSocket is one Worker request, and so is reconnecting. The updates it is sent are not
  requests, and pings are answered without waking the Durable Object, so a page left open all evening costs one
  request. While a page cannot connect, it loads `/api/live` every 15 seconds instead. At most 500 pages can be
  connected at once.
- **`/removematch`** does not change it.

The Node/Docker version does not have the live match.

## Player records

On Cloudflare, the bot also keeps records for leaderboards and seeder rewards (such as VIP). They are keyed by
Steam ID, so they are private: `/api/stats` never includes them. Admins can see the top seeders with `/seeders`.

| Record                       | What                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| Each finished match          | Map, start, live and end times, length, peak, faction scores, and every player's Steam ID, name, kills, deaths and side |
| Each player, each UTC day    | Name, seeding minutes, live minutes, whether they had a successful seed, matches played, kills, deaths |
| Each player's staff history  | The last 50 warnings, kicks, bans, unbans, team moves and VIP changes made through the bot: when, by whom (Discord user ID), and why |
| Bans the bot made            | Name, reason, who made it, when a timed ban ends, and whether it waits for them to join |
| Each UTC day's weapons       | From the [kill feed](#weapon-stats): each weapon's kills, headshots, distances and longest kill, with the Steam ID and name of who made it |
| Each player's weapons        | From the kill feed: their kills, headshots and longest kill with each weapon, on each of their last 90 UTC days |
| The live match               | From the kill feed: the match on now, for the [live page](#live-match). Its last 40 deaths, and each player's totals and streaks |
| Each UTC day's griefing      | From the kill feed, for the [staff page](#staff-page): each player's team kills (and whom), times team killed, suicides and vehicle suicides, and the day's latest 300 team kills and vehicle suicides |
| The server's ban list        | As at the last check, to notice bans made or lifted outside the bot ([moderation log](#moderation-log)) |

- A match counts the same way as the match summary: only matches that went live, and not the one already running
  when the bot started. Its kills and deaths go on the day it ended, to everyone seen in it, including players who
  only seeded it and left.
- Seeding is time online while the server is seeding: each check (every minute) adds a minute for everyone online.
  That is filling up from empty, and building back up after a drop from live (a crash, or players leaving) that
  lasted longer than `DROP_GRACE_MINUTES`. A shorter drop is a blip: the server stays live, and the time counts as
  live minutes. The check that finds the server live counts as live.
- A successful seed is being online for more than `VIP_SEED_MINUTES` (default 10) of that seeding, and the server
  then going live. Each time the server is seeded back to live counts, so after a crash the players who get it live
  again are credited too. It marks the day it went live (UTC), once however many times it happens that day.
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

While the server seeds, the bot broadcasts a seeding message in game every 5 minutes (`SEEDING_MESSAGE_MINUTES`), and
30 seconds after someone joins: how many more players it needs to go live, and what seeding earns.

| VIP and website                     | Message                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| Automatic VIP on, `SITE_URL` set    | We're seeding! 15 more players and we go live. Seed for over 10 min on 3 days in a week and get a reserved slot. How at gaminginit.com |
| Automatic VIP off, `SITE_URL` set   | We're seeding! 15 more players and we go live. Top seeders make the leaderboard at gaminginit.com |
| Neither                             | We're seeding! 15 more players and we go live. Thanks for helping get it live! |

- **When someone joins:** 30 seconds after they join, so they have loaded in to see it. When several join close
  together, it waits until 30 seconds after the last of them and goes out once. While the server seeds, the bot reads
  who is in game every 5 seconds to see joins, so it goes out 30 to 35 seconds after the join. For the player who
  starts the seed on an empty server, the bot only sees them at the next minute's check, then waits 30 seconds.
- **Every 5 minutes:** 5 minutes after the last seeding message, including one for a join. A 5-minute message that is
  due while one for a join is waiting holds back, so they never both go out.
- **Never at 20 players:** no seeding message goes out once the server has `LIVE_THRESHOLD` (20) players, even in
  the seconds before the next check marks it live. A join that takes it to 20, or a join while it is live, sends
  nothing, and a message still waiting for an earlier join is dropped.
- **Map changes:** a live server that drops below 20 players, such as while players reconnect after a map change,
  stays live. It only counts as seeding again once it has stayed below 20 for `DROP_GRACE_MINUTES` (5) in a row, and
  only then do seeding messages start. Until then nobody gets one, however many rejoin.
- It is the same whether the server is filling up from empty or building back up after dropping from live.
- The opening line is picked at random from `SEEDING` in `src/lines.ts`; `{needed}` is filled in, such as
  "15 more players". The reward after it comes from `VIP_SEED_DAYS` and `VIP_SEED_MINUTES`, so it always matches what
  the bot does.
- When a match message (below) is due on the same check, it goes first and the seeding message waits a minute.
- Set `SEEDING_MESSAGE_MINUTES` to another number of minutes in the `vars` block of `wrangler.jsonc`, or `"0"` to
  turn them all off, the ones for joins too. They do not need `SITE_URL`.
- The reads every 5 seconds only happen while the server seeds: on Cloudflare, a Durable Object alarm (12 a minute,
  about 720 for each hour of seeding, within the free plan); with Node, a second timer. Each is one RCON request
  (`GET /v1/players`).

During a match, the bot broadcasts short messages in game that point players at the website (`SITE_URL`) for the
leaderboard, the Discord and seeding:

| When                                             | Message                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| 10 minutes after the match went live             | 10 minutes in and nobody has rage quit yet. Rules are in our Discord, leaderboard at gaminginit.com |
| A team reaches half of `SCORE_TO_WIN` (50)        | Halfway there! Valkyra leads on 52. Not my points, OUR points, comrade. Seed on 3 days in a week and get a reserved slot. How at gaminginit.com (without VIP: the leaderboard and Discord) |
| The first team to reach 90% of `SCORE_TO_WIN` (90) | Valkyra has 90! Victory for the motherland is in sight, comrades. Where do you rank? Leaderboard, Discord and seeding at gaminginit.com |

- Every line the bot says in game is in one list, `src/lines.ts`: the seeding lines, the 10-minute lines, and for halfway and 90 points
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
- A message that fails to send is logged (`In-game message failed: …`) and not tried again. A seeding message
  that fails waits for its next turn, 5 minutes later.
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
  count resets when the server goes live or empties.
- A live server that drops below `LOW_POP_THRESHOLD` for longer than `DROP_GRACE_MINUTES` is being seeded again,
  whether it crashed or players left, and whether or not it emptied. Its seeding count starts once the drop has
  lasted that long, so the first `DROP_GRACE_MINUTES` after a drop do not count as seeding.
- WARDOGS RCON does not report when a match ends. The bot treats a map change, a restart on the same map, or
  the server emptying as the end of a match, and summarises it from the last stats it saw. That can miss up to
  one minute at the end of the match. A side one point short of `SCORE_TO_WIN` in that last reading (99 of 100)
  scored the winning point in that minute, so the match is recorded with it on 100. Matches saved on 99 before
  this was added are put right once, on the first check after the deploy. A restart means the faction scores
  drop and most players' kills and deaths start again from 0 at once. One player's counters starting again (they
  rejoined or switched team) is not a new match: their earlier kills and deaths are kept and the new ones added.
  The rotation slot moving, or a reading without the map, does not end a match either. Players who left mid-match
  keep their last stats. Length is timed from when the server went live. Matches that never went live are not
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
- The [kill feed](#weapon-stats) is only taken with `KILL_FEED_TOKEN` as the bearer, so nobody else can add kills.
  Anyone who has the token can, so keep it secret like the password.
- The [staff page](#staff-page)'s data is only served for a session the Worker signed after Discord confirmed the person
  is staff in `DISCORD_GUILD_ID`. Keep `DISCORD_CLIENT_SECRET` secret: anyone with it could sign their own sessions.
- Player names in posts are escaped, and posts never ping anyone except the configured role.

## Development

```bash
npm ci
npm test
npm run typecheck
```
