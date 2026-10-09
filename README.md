# WARDOGS Discord bot

Watches a WARDOGS server through its RCON API and posts to a Discord channel when:

| Alert        | When                                                       | Default     |
| ------------ | ---------------------------------------------------------- | ----------- |
| 🌱 Seeding   | An empty server reaches `SEEDING_THRESHOLD` players, and keeps players for `SEEDING_ALERT_MINUTES` | 1 player, 5 minutes |
| 🟢 Live      | The server reaches `LIVE_THRESHOLD` players                | 20 players  |
| 🔻 Low pop   | A live server drops below `LOW_POP_THRESHOLD` players      | below 20    |
| 🔁 Back up   | The server is back after a crash and has kept players for `SEEDING_ALERT_MINUTES`, in place of the low-pop and seeding alerts | |

The alerts ping `DISCORD_ROLE_ID` when it is set, except the seeding, low-pop and back-up alerts at night (see
[Behaviour](#behaviour)).

It also posts:

- **Top seeders** on the live alert: the 3 players who were online longest while the server seeded. Never
  [staff](#staff-steam-accounts).
- **What seeding earns** on the seeding alert, when [automatic VIP](#automatic-vip) is on.
- **A match summary** when a match ends, if the server was live during it: map, winning faction and score,
  length, peak population, and the top 5 players by kills with deaths and K/D. With `SITE_URL` set (Cloudflare), its
  title links to that match on the website's matches page.
- **A [live server status](#live-server-status)** (Cloudflare only): one message in a channel of its own,
  edited every minute with the state, players, map, next map, score and top players.
- **[Weekly and monthly roundups](#roundups)** (Cloudflare only): the team of the week or month, the top 3 players for
  kills, K/D, kills in a match, wins, MVPs, time played and seeding, the highlights, and awards: the best assaulter,
  support player, machine gunner, marksman, demolitions and vehicle crew, and shout-outs.
- **A [moderation log](#moderation-log)** (Cloudflare only), in a staff channel: every warning, kick, ban, unban, team
  move and VIP added or removed with its reason and who did it, bans made or lifted outside the bot, possible griefing as it happens, players
  in game with one of the [riskiest Steam accounts](#risky-steam-accounts) or a day of unlikely headshots, and the server crashing
  or not answering, and when it is back.
- **An [alert review](#alert-review)** (Cloudflare only): what each alert posted, every outage, and how players' days
  spread out against each mark, with no names or Steam IDs, for whoever tunes the alerts.

It also keeps **[map rotations](#map-rotations)** (Cloudflare only): staff save rotations by name, such as "Rotation 1"
and "Weekend", pick which one plays on each day of the week, and swap between them with one command.

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
[staff page](#staff-page): staff sign in with Discord to see possible griefers (team kills, suicides in vehicles),
[risky Steam accounts](#risky-steam-accounts) (VAC and game bans, new and hidden accounts), the moderation log and the bans
on the server. And it enforces [weapon rules](#weapon-rules): staff pick weapons the server doesn't allow, such as the
Humvee's gun, and the bot warns or kicks whoever kills with one.

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
   website, such as `https://gaminginit.com`): post titles then link to it, and their footer points people there. A
   match summary and `/lastmatch` link to their match on the website's matches page instead.
   Set `SERVER_ID` to the server's ID for Join by ID in the game's server browser, and the alerts, `/serverstatus` and
   the [live server status](#live-server-status) show it under **Join the server**, with how to join.
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

To change a threshold later, edit `wrangler.jsonc` and run `npm run deploy` again, or merge it to `main` with
[Deploy from GitHub](#deploy-from-github) set up.

### Deploy from GitHub

With two repository secrets, every push to `main` deploys the bot once the typecheck and tests pass (the CI workflow's
`deploy` job). A push that fails them is not deployed, and the bot keeps running the last version that passed.

1. In the Cloudflare dashboard: My Profile → API Tokens → Create Token → **Edit Cloudflare Workers** template. Limit it
   to your account, then create it and copy the token.
2. Your **Account ID**: `npx wrangler whoami` prints it, or it is on Workers & Pages in the dashboard.
3. On GitHub: the repository's Settings → Secrets and variables → Actions → New repository secret. Add
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

Until both are set, the `deploy` job passes with a warning and deploys nothing. Actions → CI → Run workflow deploys
`main` again by hand.

A deploy from GitHub is the same as `npm run deploy`: it sets `vars` from `wrangler.jsonc` and keeps the secrets set
with `wrangler secret put`. It does not register slash commands: after adding or changing a command, run
`npm run register` as before.

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
- **Join the server:** the server's ID to copy, and how to join with it in game (Deploy → Server Browser → Join by
  ID, paste the code, then Lookup), when `SERVER_ID` is set. Not shown while the server is offline.

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
  is on. The bot reads the rotation again when the map changes, when it puts a rotation on the server itself, and at
  least every 15 minutes, so a rotation changed in game shows within 15 minutes.
- **Turning it off:** delete the secret (`npx wrangler secret delete DISCORD_STATUS_WEBHOOK_URL`).

It costs one Discord edit a minute, and one more RCON request (the rotation) for each map and at least every 15
minutes. The Node/Docker version does not have it.

## Roundups

Every Monday the bot posts a roundup of the week before (Monday to Sunday, UTC) to the alerts channel, and on the 1st of
every month a roundup of the month before. Each one celebrates:

| Section                 | What                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------- |
| Summary                 | Matches, time played, players and the peak                                              |
| 🏆 Team of the week     | The side with the best win rate, from 3 matches up. None when the top two are level     |
| ⚔️ Teams                | Every side's wins, losses and win rate, best first                                      |
| 🔫 Most kills           | The top 3 by kills                                                                     |
| 🎯 Best K/D             | The top 3 by K/D, from 2 hours played in a week or 9 to 10 in a month (the website's leaderboard needs 10 over 30 days) |
| 💥 Most kills in a match | Each player's best match, top 3, with the map                                         |
| 🏅 Most wins            | Matches won on the winning side, out of the matches they played                         |
| ⭐ Most MVPs            | Times top of a match's scoreboard (most kills, then fewest deaths; players level share it) |
| ⏱️ Most time played     | Seeding and live time                                                                  |
| 🌱 Top seeders          | Seed days, then seeding time. Not [staff](#staff-steam-accounts)                       |
| ✨ Highlights           | The biggest win, the closest finish, the map played most and the busiest day           |

Then the awards. With the [kill feed](#weapon-stats) on, the top 3 by kills with each role's weapons (team kills don't
count):

| Award                   | Kills with                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------- |
| 🪖 Best assaulter       | Assault rifles, SMGs and shotguns                                                   |
| 💣 Best support         | Mortars, the SPH-2's artillery and the other emplacements (CIWS, Talon 9K-SAM)      |
| 🔥 Best machine gunner  | LMGs (M249 SAW, PKM)                                                                |
| 🔭 Best marksman        | Marksman and sniper rifles, and the bow                                             |
| 🧨 Best demolitions     | Launchers, grenades, mines, IEDs and C4                                             |
| 🚁 Best vehicle crew    | Vehicle guns: tanks, helicopters and mounted guns                                   |

And 🌟 shout-outs, one player each:

| Shout-out               | Who                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------- |
| 💀 Headhunter           | Most headshots, not on teammates (fewer kills first when level)                     |
| 📏 Longest shot         | The longest kill with a hand-held weapon, not on a teammate, and the weapon         |
| 🧰 Jack of all trades   | Kills with the most different weapons                                               |
| 🚗 Road rage            | Most players run over, or blown up in a vehicle                                     |
| 🔨 Bonk                 | Most melee kills: fists, the Halligan bar, hammers, drills and the defibrillator    |
| 🤠 Quickdraw            | Most pistol kills                                                                   |
| 📆 Ever-present         | On the server on the most days (more time played first when level)                  |
| 🐣 Rookie of the week   | The player first seen this week (or month) who played the most. Only once the records go back 4 weeks before it |

The last two come from the player records, so they need no kill feed. A weapon the bot does not know (see
`ROLES` in `src/weapons.ts`) counts for no role. Kills from before this update still include team kills, as
the bot did not keep them apart until then, and have no longest shot.

- Names link to each player's page on the website when `SITE_URL` is set. Posts never ping anyone.
- It goes out at `ROUNDUP_HOUR` (UTC, default `17`: 6pm in the UK in summer, 5pm in winter), on the Monday, and on the
  1st for the month. When the 1st is a Monday, both go out.
- A match counts in the week it ended, like the leaderboard. A week or month nobody played in gets no post.
- If the post fails, the bot tries again at each check until the end of that day. A bot deployed after that day waits
  for the next week, rather than posting a late one.
- Anyone can see a roundup any time with `/roundup`: last week, last month, or this week or month so far.
- They come from the [player records](#player-records), so they cover matches since those started. The awards from
  the kill feed cover kills since the [staff page's kill records](#kills-and-headshots) started; the footer says so
  when that was during the week or month.
- Discord takes 6,000 characters a message. If it would be longer, names lose their links, and if it is still too long
  the awards are left out.

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
| `/lastmatch`    | Everyone             | The summary of the last finished match, and when it ended; its title links to the match on the website |
| `/rotation`     | Everyone             | The current map and the next few in the rotation                   |
| `/roundup`      | Everyone             | The [roundup](#roundups) of last week (default), last month, or this week or month so far |
| `/broadcast`    | Staff only           | Sends a message (up to 200 characters) to everyone in game         |
| `/seeders`      | Staff only           | Top 25 seeders over the last 7 days (or `days`: 1–90): seed days, minutes, Steam ID and VIP. Not [staff](#staff-steam-accounts) |
| `/seednow`      | Staff only           | Posts "We're going to try to seed now. Come join!" to the alerts channel and pings the role, with an optional `message` |
| `/removematch`  | Staff only           | Deletes a wrongly recorded match, picked from the recent matches, and its leaderboard counts |
| `/warn`         | Staff only           | Sends a player in game a private message: "Staff warning: …"       |
| `/player`       | Staff only           | A player's Steam ID, playtime and seeding (90 days), team kills today, [Steam account](#risky-steam-accounts), VIP, ban and staff history |
| `/kick`         | Staff only           | Removes a player from the server, with a reason they see; they can rejoin |
| `/switchteam`   | Staff only           | Moves a player to another team (`team`, or the other one when there are two) and respawns them |
| `/ban`          | Staff only           | Bans a player for 1 hour, 1 day, 3 days, 7 days, 30 days or for good, with a reason |
| `/unban`        | Staff only           | Lifts a ban                                                        |
| `/setnextmap`   | Staff only           | Sets the map after this match, and optionally its mode, infantry only, hardcore, lighting and zones, without changing the rotation |
| `/changemap`    | Staff only           | Ends the current match now and changes to the map, with the same options |
| `/vip add`      | Staff only           | Gives a player a reserved slot for 1–365 days, or for good with `permanent`, with a reason: Friend, Regular, Seeder, Paid or Other |
| `/vip remove`   | Staff only           | Takes a player off the reserved list, with an optional reason; automatic VIP skips them for 7 days. Not a [staff spot](#staff-steam-accounts) |
| `/rotations …`  | Staff only           | Saved [map rotations](#map-rotations): `show`, `use`, `schedule`, `add`, `remove`, `save` and `delete` |
| `/private …`    | Staff only           | [Private profiles](#private-profiles): `add` makes a player's profile private, `remove` makes it public again, `list` shows them |

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
server cannot be reached, the reply says so, and the reason is in the Worker logs. For a public command that message
is private too: the bot deletes its public "thinking…" reply and sends the error as a follow-up only the sender sees,
so a failure is not shown to the whole channel. If Discord will not delete the reply, the error is edited into the
public reply instead (logged as `/<command> could not delete the public reply`). After adding or renaming
commands, or changing a fixed list of choices (such as `/switchteam`'s teams), run `npm run register` again.

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

For players, staff start typing and pick from the list, which shows each player's name, team and Steam ID. Teams
in the lists staff pick from have a dot in their colour, to spot at a glance: 🔵 Lonestar, 🟢 Manticore, 🔴 Valkyra.
`/warn`, `/kick` and `/switchteam` list the players in game. `/player`, `/ban`, `/vip add` and `/private add` also list
players seen in the last 30 days and players with VIP or a ban from the bot, and take any Steam ID. A name typed without picking
works when it matches exactly one player.

- **`/warn`** sends a private message in game, starting "Staff warning:", up to 140 characters.
- **`/kick`** needs a reason; the player sees it. They can rejoin.
- Warnings, kicks and the kick that comes with a ban tell the player where the rules are: "… | Rules: our Discord at
  gaminginit.com" (`SITE_URL`), or "… | Rules are in our Discord" without it.
- **`/switchteam`** only offers the game's three teams: 🔵 Lonestar, 🟢 Manticore and 🔴 Valkyra. A team that is not
  in the match is refused. With two teams, leave `team` out to move them to the other one. Like the game's own
  console, the bot then kills the player so they respawn on the new side.
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
- **`/vip add`** puts a player on the reserved list for the number of days given, and needs a `reason`: Friend,
  Regular, Seeder, Paid or Other. `note` adds more, such as "Patreon, October", and is needed for Other. The reason
  and note go in the staff history and the [moderation log](#moderation-log). It ends like automatic VIP: when
  the time is up, unless they have earned it by seeding by then. For a player who already has VIP from the bot, it
  sets the end to the later of the two. With `permanent` set to True instead of `days`, the slot has no end date: the
  bot leaves it on the list, as it does a slot added by hand, until staff remove it. That also makes VIP the bot gave
  earlier permanent. A reserved slot an admin added by hand in `ServerSettings.ini` is left as it is. **`/vip remove`**
  takes a player off the list, however they got there, and automatic VIP does not give it back for 7 days (`/vip add`
  lifts that). It takes an optional `reason`. Both take effect at the server's next restart, like automatic VIP.
- **`/player`** shows the Steam ID with a link to the Steam profile, whether they are in game, their playtime,
  seeding and matches over the last 90 days, their team kills today, what Steam says about their account (see
  [Risky Steam accounts](#risky-steam-accounts)), VIP, ban, and the staff history: the last 5 warnings, kicks, bans,
  unbans, team moves and VIP changes, with who did each. It says when their [profile is private](#private-profiles).
- **Team kills today** in `/player` is for checking a report like "X is team killing" without leaving Discord. From the
  [kill feed](#weapon-stats), over the UTC day so far: their team kills (and how many with a vehicle, and in a
  helicopter crash), times a
  teammate killed them, suicides (and how many in a vehicle), any [griefing flag](#staff-page) the day earned, the
  teammates they killed and how often, and their latest 5 team kills and vehicle suicides, and team kills on them, with
  when, the weapon, the distance and the map. Sides come from the bot's last check, up to a minute old, as on the
  staff page. Left out until the bot has had the kill feed, and in the Node/Docker version.

The staff history covers what staff do through the bot, from the deploy with these commands on, and bans made or lifted
outside the bot, from the deploy with the [moderation log](#moderation-log) on. Each action is
also logged in the Worker logs with the staff member's Discord user ID. If a reply says an action could not be
confirmed, check in game before trying again: it may have gone through.

There is no chat log command: the game's RCON API has no way to read chat.

## Private profiles

A player who does not want to be named in public can have a private profile (Cloudflare only). Staff make it private
with `/private add`, in Discord or from the staff page's tools. From then on, everywhere the public sees, they go by
**[private profile]**, with no link to a player page:

- **The website** (`/api/stats`, `/api/live` and its socket): the leaderboard, the current and recent matches, who has
  VIP from seeding, the weapons' longest kills, and the [live match](#live-match): the kill feed, the scoreboard and
  the highlights. They are left off the players list (`/api/players`), and their player page answers 404, as for an
  id nobody has, so a private profile cannot be told from nobody.
- **The bot's public Discord posts and commands**: the match summary, the live alert's top seeders, the reserved slots
  for seeders, the [live server status](#live-server-status), the [roundups](#roundups), `/players`, `/lastmatch` and
  `/roundup`.

Their numbers still count, under that name, so nobody else's place on a board changes. Staff still see them as they
are: on the staff page, in the staff commands (`/player` says their profile is private), and in the moderation log.

- **`/private add`** takes any player: pick from the list, or type a name or Steam ID. **`/private remove`** lists
  the private profiles and makes one public again. **`/private list`** shows them, the latest first, with who made
  each private and when.
- The public pages reuse an answer for up to 30 seconds, and browsers for 30 more, so a change shows within a minute.
  The live page shows it at its next update.
- Not changed: what players see in game, such as the scoreboard, and Discord posts sent
  before. Matches recorded before Steam IDs were kept have names only, so they still show the name they had.
- Kept by Steam ID in the Durable Object (`privateProfiles`). Each change is logged in the Worker logs with the staff
  member's Discord user ID (`/private add by Discord user …`).
- New commands need `npm run register` once (see [Slash commands](#slash-commands)). The staff page lists them as
  soon as the bot is deployed.

## Map rotations

Staff save map rotations by name, such as "Rotation 1" and "Weekend", and pick which one the server plays on each day of
the week. **Default** starts as the rotation the server had when the bot first looked, and plays on every day without a
rotation of its own. The easiest place to do all this is the staff page's [Rotations tab](#rotations-tab); the
`/rotations` command does the same from Discord.

The bot puts a rotation on the server by writing its maps into `ServerSettings.ini` (`PUT /v1/config`, checked first with
`POST /v1/config/validate`), as live builds have no other way to change the rotation. The server rebuilds its rotation
straight away and plays it from the next map change, so the match on now is never cut short. Only the `RotationEntries`
lines are written: whether the rotation is on, and in order or random, stay as they are.

Each rotation the bot puts on starts from its first map at the next map change. The server keeps its place in the list
when the rotation changes, and goes to the next slot in the new list, whatever map is there now. So the bot writes the
rotation with its first map in that slot and the rest after it in order. That is also how each day's rotation starts
from the top, even when it is the same as the day before. If the map being played is the rotation's first map, it plays
twice in a row. The list in `ServerSettings.ini` can start part-way round, so a server restart starts from where the
list starts; the next day's rotation then starts from the first map again. The Rotations tab and `/rotations save` show
and save the server's list in the saved rotation's order.

| Command                 | What                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `/rotations show`       | The saved rotations, the week and which one is on today; or, with `rotation`, its maps in order |
| `/rotations use`        | Swaps the server to a rotation now, for the rest of the day                              |
| `/rotations schedule`   | Picks the rotation for a day: one weekday, weekdays, the weekend or every day. Leave `rotation` out for Default |
| `/rotations add`        | Adds a map to a rotation, with the same options as `/setnextmap`, and `position` (default: the end). A new name starts a new rotation |
| `/rotations remove`     | Takes a map out of a rotation, picked from its list                                      |
| `/rotations save`       | Saves the rotation the server has now under a name, or in place of a saved one          |
| `/rotations delete`     | Deletes a saved rotation. The days it was planned for go back to Default                 |

Setting up a weekend rotation, for example (every other day keeps playing Default):

```
/rotations add rotation:Weekend map:Ozeti infantry_only:True
/rotations add rotation:Weekend map:Zestafona hardcore:True
/rotations schedule day:Weekend (Saturday and Sunday) rotation:Weekend
```

- **Each day starts at `ROTATION_HOUR`** (UTC, default `5`: 6am in the UK in summer, 5am in winter), so a late night
  still plays the evening's rotation. At the first check after that, the bot puts the day's rotation on the server: its
  own, or Default.
- **Default** can be changed like any rotation, but not renamed, deleted or left with no maps. The bot saves it from the
  server at the first check after this deploy (from `ServerSettings.ini`, or what the server reports when the file has
  no rotation), and the server already has those maps, so nothing changes in game. Without a Default (a server with no
  maps), a day with no rotation of its own keeps whatever the server has.
- **`/rotations use`** lasts until the next day starts; then the week takes over again. Planning today puts that
  rotation on straight away too, and so does deleting today's rotation (Default goes on).
- **Changing today's rotation** (its maps, or their order) puts it on the server again, from its first map, unless it
  has no maps left: the bot never leaves the server without a rotation.
- In `add`, anything left out is the map's own: its first game mode, infantry only and hardcore off, and the map's own
  lighting and zones. A map can be in a rotation more than once, such as Bakurani by day and at dusk.
- If the server can't take the rotation (it is not answering, doesn't say where it is in its rotation, or the settings
  file is read-only), the reply says why, and the bot tries again at every check until the server has it.
- Changes made by hand on the server stay until the bot next puts a rotation on: the start of the next day, or a staff
  change. `/rotation` (for everyone) shows what the server is playing either way.

| Variable        | What                                                    | Default |
| --------------- | ------------------------------------------------------- | ------- |
| `ROTATION_HOUR` | The hour (UTC, 0 to 23) each day's rotation starts      | `"5"`   |

Up to 10 rotations besides Default, of up to 100 maps each. A rotation staff already called "Default" before this
became Default; if it had no maps, it takes the server's. The Node/Docker version does not have map rotations.

### Rotations tab

The [staff page](#staff-page) has a tab of its own for rotations: the week, with each day's rotation to pick; what is on
the server now, with the map being played and the next; and an editor where staff drag maps into a rotation, drag them
into order, and set each one's mode, infantry only, hardcore, lighting and zones. Nothing changes until they press Save,
and Put on server swaps to it for the rest of the day.

It reads `GET /api/admin/rotations` (the saved rotations, the week, the server's rotation, and each map's modes,
modifiers, lighting and zone layouts, kept for 10 minutes) and sends changes to `POST /api/admin/rotations`
(`save`, with `from` to rename; `use`; `schedule`; `delete`), with the same rules as `/rotations`. Each change is logged
as `Staff page: rotations <action> "<name>" by "<staff>" (Discord user <ID>)`.

## Moderation log

A staff-only Discord channel where the bot posts, as they happen:

| Post                    | When                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| ⚠️ Warning, 👢 Kick, 🔨 Ban, ✅ Unban, 🔀 Team move | Staff use `/warn`, `/kick`, `/ban`, `/unban` or `/switchteam`. With the player, their Steam ID, the reason, the length of a ban and who did it |
| ⚠️ Warning, 👢 Kick by the bot | A player kills with a weapon a [weapon rule](#weapon-rules) doesn't allow. With the rule, the weapon and which warning it was |
| 🎖️ VIP added / removed  | Staff use `/vip add` or `/vip remove`. With the player, their Steam ID, the reason (Friend, Regular, Seeder, Paid or Other, and any note), how long and who did it. Not automatic VIP from seeding, which is announced in the alerts channel |
| ✅ Unban by the bot      | A timed ban runs out                                                                       |
| 🔨 Ban / ✅ Unban outside the bot | A ban made or lifted some other way: in game, in `ServerSettings.ini`, or by another tool. With the reason and who the server says made it |
| 🚩 Possible griefing     | A player reaches 4, 8, 12… team kills in a day, 4, 8, 12… suicides in a vehicle, or kills the same teammate a third time that day. Teammates killed in a helicopter crash don't count (see [Possible griefers](#staff-page)). With their latest incidents, and their [Steam account](#risky-steam-accounts) when it is high risk or worth a look. Needs the [kill feed](#weapon-stats) |
| 🕵️ Risky Steam account   | A player in game has one of the riskiest Steam accounts (7 points or more), such as a new account with a VAC ban, or VAC and game bans with one recent. Once, and again if it gets riskier. Needs `STEAM_API_KEY`: see [Risky Steam accounts](#risky-steam-accounts) |
| 🎯 Unlikely headshots    | A player in game has a flagged day of headshots (see [Kills and headshots](#kills-and-headshots)): today's headshots and kills, what is usual for their weapons, the chance by luck and their weapon with the most kills. Once a UTC day for each player. Red, and "again", when they were flagged on another day in the last 30, and red with their [Steam account](#risky-steam-accounts) when it is high risk or worth a look. Needs the [kill feed](#weapon-stats) |
| 🔴 Server crashed / 📉 players dropped at once | A live server lost more than three quarters of its players from one check to the next, and 3 minutes later still has under half of them. With the players before and now, and whether it was at a map change |
| 🔴 Can't reach the server | The bot could not reach a server that had players for 5 minutes. It may still be running with only RCON down |
| 🟢 Server back / ⚪ not back | After either of those: when 90% of the players are back, with how long it took, the fewest players and how long the bot could not reach it; or 3 hours on, when they never came back |

To set it up:

1. Make a channel only staff can see, such as `#mod-log`.
2. In that channel: settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.
3. Store it as a secret:
   ```bash
   npx wrangler secret put DISCORD_MODLOG_WEBHOOK_URL
   ```

- Staff are mentioned by name (`@Sarge`), which never pings them. Posts link to the [staff page](#staff-page) when
  `SITE_URL` is set.
- **Bans outside the bot.** Every 10 minutes, a check reads the server's ban list (`GET /v1/bans`) and compares it
  with the last one. A ban that appeared or went that the bot did not make is posted, up to 10 minutes after it was
  made, and goes in the player's staff history (`/player`) too. The first reading after the deploy only saves the
  list, so the bans already there are not posted. It costs one RCON request every 10 minutes: each request can make
  the game server stutter, and bans outside the bot are rare.
- **Kicks outside the bot** cannot be seen: the game's RCON does not report them, and its kill feed only has deaths.
- **Possible griefing** posts can be turned off with `GRIEF_ALERTS` `"off"` in the `vars` block of `wrangler.jsonc`.
  They are a reason to look, not proof: sides come from the bot's last check (see [Staff page](#staff-page)).
- **Risky Steam account** posts can be turned off with `STEAM_ALERTS` `"off"`. They are a reason to look, not proof too.
- **Unlikely headshots** posts can be turned off with `HEADSHOT_ALERTS` `"off"`. The bot judges everyone in game at each
  check, so a post goes out up to a minute after the kill that flags the day. A reason to look, not proof.
- **Outage** posts can be turned off with `OUTAGE_ALERTS` `"off"`. A map change that empties the server for a minute or
  two is never posted: the players are back to half before the 3 minutes are up. The [alert review](#alert-review)
  keeps every outage either way.
- A post that fails is logged (`Moderation log post failed`) and not retried: the staff history has it either way.
- **Turning it off:** delete the secret (`npx wrangler secret delete DISCORD_MODLOG_WEBHOOK_URL`). The staff history and
  the staff page still record everything.

The Node/Docker version does not have the moderation log.

## Staff page

The website has two pages for staff: Moderation (gaminginit's `/admin`), in tabs for watching the server live,
reviewing what the bot flagged, and any player's history; and Server settings (`/server-settings`), for the rotations,
lines, weapon rules and admin tools. Staff sign in with Discord, and the pages show:

- **Who is in game now**, from the bot's last check (every minute): each player's team, kills and deaths this match,
  time on the server today, whether they are new (first seen today, in 90 days), their
  [Steam account](#risky-steam-accounts)'s risk, today's headshots against what their weapons usually get
  ([Kills and headshots](#kills-and-headshots)), today's griefing flags, VIP and bans, and whether a staff member
  [checked them](#checked-theyre-fine) today. Nothing while the server has not answered for 3 minutes.
- **Who joined and left**: the server's latest 500 joins and leaves, newest first, with how long each player who left
  had been on. The bot compares who is in game at each check with the check before, so a join or leave shows up to a
  minute late, and someone on for less than a minute between two checks is missed. When the bot could not read the
  server for a while, the first check after notes everyone who joined or left meanwhile, with since when. The players
  on when the bot started keeping the log have no join, so their time on is left out when they leave. Stored as
  `joinLog`, written only when someone joined or left. Each time someone leaves, their time on the server also goes in
  the SQLite database's `sessions` table for their history, kept for 30 days.
- **The kill feed, live**: every kill a second or two after the game sends it (see below).
- **Possible griefers** over today, 7 or 30 days: everyone who team killed, was team killed or killed themselves, from
  the [kill feed](#weapon-stats). A player's day is flagged for 4 or more team kills, killing the same teammate 3 times
  or more, 4 or more suicides in a vehicle (crashing it, or blowing it up with themselves in it), or 10 or more
  suicides (`FLAGS` in `src/griefing.ts`, set from the [alert review](#alert-review) of the first days of the kill
  feed). Teammates killed in a helicopter crash are counted and listed, but don't count towards the team kill or
  same-teammate flags: pilots crash by accident, and one crash can kill a full load. A pilot who crashes 4 times in a
  day is still flagged for vehicle suicides. Those in game now first, then most flagged days first, with their matches, kills and time played for scale,
  and whether they are banned.
- **Team kills and vehicle suicides**, each with when, who, which teammate, with what, how far and on which map.
- **[Kills and headshots](#kills-and-headshots)**: who gets far more headshots than the server's players get with the
  same weapons, over today, 7 or 30 days, and any player's every kill, with the weapon. From the
  [kill feed](#weapon-stats).
- **Any player's history**: their record (as `/player` shows it), their times on the server (when they joined and left,
  and for how long), their kills and headshots, and their team kills.
- **[Risky Steam accounts](#risky-steam-accounts)** among everyone seen in the period or in game now, those in game
  first, then riskiest first, with why, how old the account is, whether they are in game or banned, and their matches, kills, K/D and headshots for
  scale. With `STEAM_API_KEY` only.
- **The moderation log**: every warning, kick, ban, unban, team move and VIP added or removed through the bot, with the
  reason and who did it, and bans made or lifted outside the bot.
- **The bans on the server**, with their reasons, who made them and when timed bans end, and bans waiting for the
  player to join.
- **The reserved slots**: everyone on the reserved list in `ServerSettings.ini`, with VIP from the bot and when it ends,
  or added by hand, and how many slots `MaxReservedSlots` holds back.
- **Admin tools**: every staff slash command, run from the page: warn, kick, move team, ban, unban, look up a player,
  give or remove VIP, top seeders, message everyone in game, set the next map, change map now, call for seeders,
  [map rotations](#map-rotations), and remove a wrongly recorded match. See below.
- **[Rotations](#rotations-tab)**: the week, what is on the server, and a drag and drop editor for the saved rotations.
- **[Lines](#lines-tab)**: the lines the bot says in game, to reword, add or take out.
- **[Weapon rules](#weapon-rules)**: weapons the server doesn't allow, and whether the bot warns or kicks for them.
- **[Staff Steam accounts](#staff-steam-accounts)**: who has linked theirs, so the bot never counts them as seeders.

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
  reads the server's ban list and `ServerSettings.ini` (two RCON requests). With it, the page reads
  `GET /api/admin/kills?days=1|7|30` for the headshots list, and `&player=<Steam ID>` for one player's kills, the same
  way, with their times on the server in the period (`sessions`, newest first, the one they are on now first).
- The live kill feed is a WebSocket, `GET /api/admin/live`. A browser can't send a header with one, so the page sends
  its session as the socket's second subprotocol (`wardogs-staff`, then the session), which keeps it out of addresses
  and logs. The Worker checks the session and that the socket comes from `SITE_URL`, and the Durable Object keeps it
  (up to 50 at once), sending the latest 250 kills when it opens and then each batch's kills as they come in. It closes
  a socket whose session has run out (code 4401) at the next batch. The page closes it while its browser tab is hidden.
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

### Kills and headshots

Many headshots, day after day, can be a sign of cheating. The staff page shows who gets them, from the
[kill feed](#weapon-stats):

- **The kill feed, live**: the server's latest 250 kills, newest first, each a second or two after the game sends it:
  who killed whom, with what, from how far, on which map, and whether it was a headshot, a team kill or through a wall.
- **Today's headshots** of everyone in game, on the server list, when they are unlikely by luck.
- **Headshots**: everyone with a headshot in the period, those in game first, then most flagged days, then least likely
  by luck, with their headshots, what is usual for their weapons, the chance by luck, and the weapon they killed most
  with.
- **A player's kills**: any name opens their history: their kills in the period by weapon, by day, and each kill (their
  latest 1,000 a day) with whom, the weapon, headshot, distance and map.
- **Weapons to name**: the weapons the bot has no name for, so it names them from the game's tag (`WEPN 099`), over
  the last 30 days, most kills first: their kills, longest kill and who used them most, those in game first. The game's
  own kill feed names them, so staff can watch one of those players and see what it is. Their kills in the live feed
  are marked too. Tell whoever runs the bot, who adds the name to `NAMES` in `src/weapons.ts`.

How headshots are judged:

- **Usual.** For each weapon, the share of headshots everyone else got with it over the last 30 days. A weapon few
  people use is pulled towards the share for every weapon (as if it had 20 more kills at that share), so one lucky day
  does not decide. Added up over a player's kills by weapon, that is how many headshots a player with the server's
  usual aim would get: `expected`. A sniper rifle gets more headshots than a machine gun, so snipers are not flagged
  for sniping.
- **Chance by luck** (`chance`): how often a player with that usual aim would get at least as many headshots in as many
  kills. It treats every kill as having the player's average usual share, which never makes it look less likely than
  it is.
- **Flagged**: a day with **10 or more kills** and a chance **below 1 in 1,000** (`HEADSHOT_FLAG` in
  `src/killfeed.ts`). With a few hundred players a day, an honest player has a flagged day now and then; flagged day
  after day is the red flag.
- Nothing is judged until the other players have 100 kills between them.
- **A reason to look, not proof.** Watch them play, and look at their kills (distances, weapons, wallbangs), before
  acting.

The records start with the first kill after this is deployed, and keep each kill for 30 days. The counts (kills,
headshots, team kills and the longest kill by weapon) stay 62 days, for the [roundups' awards](#roundups). They are keyed by Steam ID, so
only signed-in staff see them.

Storage is charged by the row read (the free plan allows 5 million a day), and each player's day is a row: a busy
server has well over a thousand a day. The headshot checks need everyone's days over 30 days, so the Durable Object
reads them once and keeps them in step with each batch it writes, and the check each minute reads none. A day's counts
are also saved a few hundred players to a row (`kill_day_summaries`) once it is over, so when the object wakes up
again it reads about 200 rows and today's, not 30 days of players. Old days are deleted, and old kills cleared, once a
day; the day is noted in storage, so waking up again does not read every old row again.

### Checked, they're fine

A player the staff page says is worth a look (banned, flagged for griefing or headshots today, or a risky Steam account)
stays at the top of its server list until someone looks. A staff member who checks them and finds nothing to act on
clicks **Checked, they're fine**, and the page moves them down to everyone else for all staff, saying who checked them
and when:

- It lasts until the end of the UTC day, like the flags. Only today's checks are kept (`checked`).
- Each check keeps what the player was flagged for then: the reasons, their team kills and vehicle suicides today. The
  page puts them back at the top when more comes up, such as another team kill or a new flag, saying they were checked
  before.
- Anyone can take a check back.
- The page sends `POST /api/admin/check` (`{"action": "check", "steamId": "…", "reasons": ["griefing", "steam"],
  "teamKills": 4, "vehicleSuicides": 0}`, or `{"action": "uncheck", "steamId": "…"}`), and the overview gives each
  player in game `checked` (who, when, and what they were flagged for), or `null`. Each is logged
  (`Staff page: "<name>" (Discord user <ID>) checked <Steam ID> (griefing, steam)`).

### Staff Steam accounts

Seeder VIP and the top seeders are for the players who seed, not for staff. So each staff member links their Steam
account to their Discord sign-in, and the bot then counts their time on the server as playing, never seeding:

- The first time they sign in without one, the page asks for their Steam64 ID (17 digits, starting `7656119`), with how
  to find it. They can paste their Steam profile's link instead, when it has the ID in it
  (`steamcommunity.com/profiles/<ID>`). They can skip it, change it or unlink it later from the page.
- A linked account never earns [automatic VIP](#automatic-vip), and is left off the live alert's top seeders,
  `/seeders`, the roundups' top seeders, the website's seeding board and its list of who has VIP from seeding. Its
  seeding time counts as time played, so time played stays the same. Its player page shows no seed days and no
  progress towards seeder VIP. Everything else (kills, K/D, matches, time played) shows as for anyone.
- **Staff spots.** Each linked staff member gets a reserved slot on the server's reserved list for as long as they are
  linked, in place of one an admin adds by hand. A slot they already had (added by hand, or VIP from the bot) is taken
  over as it is, so nothing changes in `ServerSettings.ini` for them, and VIP the bot gave them stops running out. The
  bot puts it on (or takes it off) at the check after they link (or unlink), within a minute, and so for staff who
  linked before the bot kept staff spots, at the first check after it is deployed. The server uses it
  after its next restart. It is never announced in Discord. `/vip remove` leaves a staff spot alone and says to unlink
  their Steam account instead; an admin who takes one off by hand sees it put back. Each change is logged
  (`Staff spots added: …`, `Staff spots taken over from the reserved list: …`, `Staff spots ended: …`).
- A Steam account can only be linked to one staff member. Any staff member can unlink anyone's, for someone who is no
  longer staff: their staff spot comes off the reserved list (unless they have earned seeder VIP, which they then keep
  as a seeder), and their time counts as seeding again, including before they were unlinked, as the bot keeps the
  records as they were.
- The page sends `POST /api/admin/profile` (`{"action": "link", "steamId": "…"}`, or `{"action": "unlink"}` with
  an optional `userId`), and the overview lists everyone linked (`staffProfiles`). Each change is logged
  (`Staff page: "<name>" (Discord user <ID>) linked Steam account <ID>`).

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
- **Helicopter crashes.** A teammate killed by a helicopter itself (the game blames the helicopter, not its guns), mostly
  in a crash, is a team kill by whoever flew it, and counted apart as one in a helicopter crash. Those count towards no
  flag and no 🚩 post. Shooting a teammate with a helicopter's guns is a team kill like any other.
- **Vehicles destroyed** without anyone dying in them are not in the feed, so they are not counted.
- Each day keeps its latest 300 incidents; the counts are always complete.
- They start from the deploy with this feature. Like the other records, they are kept for good.

The Node/Docker version does not have the staff page.

## Risky Steam accounts

With a Steam Web API key, the bot checks each player's Steam account for the signs of a cheater: bans on the account, and
accounts that are new or show nothing. Staff see it in [`/player`](#staff-commands), on the [staff page](#staff-page),
on griefing posts and, for the riskiest accounts, in the [moderation log](#moderation-log) channel.

To turn it on:

1. Get a key at [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey), signed in to any Steam account
   that has spent at least $5 on Steam (Steam gives no keys to other accounts). For the domain, put your website, such as
   `gaminginit.com`.
2. Store it as a secret:
   ```bash
   npx wrangler secret put STEAM_API_KEY
   ```

The next check asks Steam about everyone in game. Each account gets points for what Steam says about it:

| Flag           | When                                                                                         | Points |
| -------------- | -------------------------------------------------------------------------------------------- | ------ |
| VAC ban        | VAC bans on the account, in any game                                                         | 3      |
| Game ban       | Game bans: another game's anti-cheat or developer banned them                                 | 3      |
| Recent ban     | The latest VAC or game ban was in the last year                                              | 1      |
| Community ban  | Banned from the Steam Community                                                              | 2      |
| Trade ban      | Banned from trading on Steam                                                                 | 1      |
| New account    | Made in the last 30 days                                                                     | 3      |
| Young account  | Made in the last 6 months, but not new                                                       | 1      |
| Hidden profile | The profile is private, or was never set up: Steam shows nothing about it, not even its age  | 1      |

- **4 points or more is high risk**: a VAC ban in the last year, an old VAC ban on a hidden profile, or a new account with
  a hidden profile. **2 or 3 is worth a look**: an old VAC ban alone, or a new account with a public profile. Less is
  nothing risky. Plenty of players keep their profile private, so a hidden profile alone is not enough.
- **A reason to look, not proof.** A VAC ban may be years old and from another game, and honest players have new and
  private accounts too. Watch how they play before acting.
- **When.** Each check (every minute) asks Steam about the players in game it has not checked, or not for a day, so a
  new ban shows within a day. That is two requests (`GetPlayerBans` and `GetPlayerSummaries`) for up to 100 players, and
  none while nobody new is on. Steam allows 100,000 a day.
- **The moderation log** gets a 🕵️ post only for the riskiest accounts: **7 points or more**, such as a new account
  with a VAC ban, VAC and game bans with one recent, or a recent VAC ban on a hidden profile that is also banned from
  the Steam Community. High-risk accounts below that are not posted on their own, as there are too many: staff see them
  in `/player`, on the staff page, and on any 🚩 Possible griefing post for that player. Up to 10 players a post. Each
  account is posted once, and again only if it gets riskier, such as with a new ban. A post that fails is logged
  (`Risky Steam account alert failed`) and not retried. Set `STEAM_ALERTS` to `"off"` in the `vars` block of
  `wrangler.jsonc` to stop them; `/player`, griefing posts and the staff page still show the checks.
- **`/player`** shows the risk, the bans, how old the account is, the profile and when it was checked. For a player the
  bot has not checked, or not for a day, it asks Steam there and then, so staff can check anyone by Steam ID.
- **The staff page** lists everyone seen in the period, or in game now, whose account is worth a look or high risk,
  those in game first, then riskiest first, so its limit of 100 never leaves out someone in game, with their matches, kills, K/D and, from the [kill feed](#weapon-stats), headshots over the period.
- **Logs.** Each risky account found is logged (`Risky Steam account: …`). If Steam does not answer, the checks wait 10
  minutes (`Steam checks failed, trying again in 10 minutes`). `Steam refused STEAM_API_KEY (403)` means the key is
  wrong.
- What Steam says is kept with the [player records](#player-records), keyed by Steam ID, so only staff see it: never the
  website's public pages.
- **Turning it off:** delete the secret (`npx wrangler secret delete STEAM_API_KEY`).

The Node/Docker version does not check Steam accounts.

## Weapon rules

Some servers don't allow some weapons, such as the guns on the Humvee and the Kodiak, or the MGL. The bot sees every
kill in the [kill feed](#weapon-stats) a second or two after it happens, so it can enforce that: staff pick the weapons
on the staff page's **Weapon rules** tab, and what the bot does when someone kills with one.

Each rule has a name, its weapons, and one of:

| Mode               | What the bot does                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------- |
| Off                | Nothing                                                                                   |
| Warn               | Sends the player the rule's warning in game, privately, like `/warn`                      |
| Warn, then kick    | Warns them for their first 1 to 5 offences of the day (staff pick how many), then kicks them for each one after |
| Kick               | Kicks them with the rule's kick reason, like `/kick`. They can rejoin                     |

It starts with three rules, all off, with their messages ready:

| Rule           | Weapons                          | Warning                                                          |
| -------------- | -------------------------------- | ---------------------------------------------------------------- |
| Humvee gunner  | Humvee M249, Humvee minigun      | No kills from the Humvee gun. It is not allowed on this server.  |
| Kodiak gunner  | Kodiak M249                      | No kills from the Kodiak gun. It is not allowed on this server.  |
| MGL            | MGL-40                           | The MGL is not allowed on this server. Switch weapon.            |

The Humvee and Kodiak rules are for their guns only: running someone over with one is not a gunner kill.

- **Messages.** A warning goes out as `Warning: <the warning> | Rules: our Discord at <SITE_URL>`. With warn, then
  kick, it says which it is (`Warning 1 of 2:`), and the last one says `Last warning:`. A kick's reason is
  `<the kick reason> | Rules: our Discord at <SITE_URL>`. The tab checks each message fits the game's 200 characters
  with what the bot adds.
- **One offence, not one per kill.** Kills with a rule's weapons within 30 seconds of the bot warning or kicking for
  that rule are the same offence (`SAME_OFFENCE_MS` in `src/weaponrules.ts`): one burst from a gun gets one warning,
  and so do kills before the player could read it.
- **Counted per rule, per UTC day.** A new day starts from nothing, so yesterday's warnings never lead to a kick today.
  A kicked player who rejoins and does it again is kicked again.
- **A kick comes alone.** When one batch of kills breaks two rules and one of them kicks, the player gets the kick and
  not the warning. The warning's offence still counts.
- **On the record.** Every warning and kick goes in the player's history (`/player`) and the
  [moderation log](#moderation-log) as done by the bot, with the rule, the weapon and which warning it was, and in the
  Worker logs (`Weapon rule: warned "<name>" (<Steam ID>). …`). One that fails, such as a kick for a player who has
  just left, is logged (`Weapon rule kick for … failed: …`) and not tried again; the offence still counts.
- **Any weapon the bot has a name for** can be in a rule; each weapon in one rule only. Up to 20 rules of up to 20
  weapons. A weapon the bot has no name for yet (see [Weapons to name](#kills-and-headshots)) can't be picked until it
  is added to `NAMES` in `src/weapons.ts`.
- **Everyone.** Rules apply to every player, staff too, and while the server seeds.
- **The tab.** It shows each rule with how many warnings and kicks the bot gave for it today, and who changed it last.
  The page reads `GET /api/admin/rules` and sends changes to `POST /api/admin/rules` (`{"action": "save", "id": null |
  "<rule>", "name": "…", "weapons": ["<tag>", …], "mode": "off" | "warn" | "warn-kick" | "kick", "warnings": 1,
  "warning": "…", "kick": "…"}`, or `{"action": "remove", "id": "<rule>"}`). Each change is logged as
  `Staff page: weapon rule <action> …`. The rules are kept as `weaponRules`, and today's offences as `ruleBreaks`.
- **Costs.** A batch with no kill against a rule that is on costs nothing more. One with an offence is a storage read
  and write, an RCON request for each warning or kick, and one more write to count those that went out. The tab's
  counts are of warnings and kicks that went out; one that failed still counts as an offence.
- It needs the [kill feed](#weapon-stats), and the RCON password's write access (`POST /v1/players/<Steam ID>/message`
  and `/kick`), like `/warn` and `/kick`.

The Node/Docker version does not have weapon rules: they need the kill feed.

## Alert review

`GET <worker url>/api/review` gives what you need to judge whether the alerts' marks are right, over the last 30 UTC
days (`?days=` for 1 to 30). It has no names and no Steam IDs, but it says how often players get flagged, so it is only
there with a token:

1. Make a long random token, such as `openssl rand -hex 32`, and store it as a secret:
   ```bash
   npx wrangler secret put REVIEW_TOKEN
   ```
2. Read it with the token as a bearer:
   ```bash
   curl -H "Authorization: Bearer $REVIEW_TOKEN" https://wardogs-discord-bot.<you>.workers.dev/api/review
   ```

Without the secret the address is not there (404), and a wrong token gets 401. The token must be at least 16
characters. To let Claude Code on the web read it, add the token to the environment's secrets as `REVIEW_TOKEN`.

| Field        | What                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------- |
| `thresholds` | Every mark the alerts use: population (seeding, live, low pop, cooldown, drop grace, the seeding alert's wait, quiet hours), outages, griefing flags, the headshot flag, Steam risk points, and which moderation log posts are on |
| `alerts`     | What was posted: `totals` and `byDay`, by kind: `seeding`, `live`, `lowPop`, `back`, and in the moderation log `grief`, `steam`, `headshot`, `down` and `up`. Counted from this update on, for 60 days |
| `outages`    | The outage going on `now`, if any, and the `log` of outages confirmed in the period: kind, when, players before, the fewest, how long unreachable, and when they ended and whether the players came back. The last 100 are kept |
| `grief`      | Each player's day with a team kill, team death or suicide: how many had 0, 1, 2… team kills (not counting helicopter crashes), the most kills of one teammate, vehicle suicides and suicides; the days each flag was earned; how many players were flagged on 1, 2… days; and `vehicles`: team kills and vehicle suicides with a vehicle by how (`helicopter`, `runOver`, `explosion`, `other`), how many run-over team kills each player's day had, and how many of the day's team kills and vehicle suicides the kept incidents cover |
| `headshots`  | The server's share of headshots; players' days by kills (`killsPerDay`) and, for days with enough kills to judge, by chance by luck; flagged days, and how many players were flagged on 1, 2… days |
| `steam`      | The checked Steam accounts of everyone on the server in the period, by risk and by points, and how many are at the alert mark. `null` without `STEAM_API_KEY` |

## Website stats

`GET <worker url>/api/stats` returns public JSON for a community website, such as
[gaminginit](https://github.com/ParagonJenko/gaminginit). Any site may read it (CORS `*`). It contains:

| Field          | What                                                                                   |
| -------------- | -------------------------------------------------------------------------------------- |
| `server`       | Name, players, max players, map, phase (`empty`/`seeding`/`live`), score, `seenAt`     |
| `history`      | `[time, players]` for every check in the last 24 hours                                 |
| `days`         | Peak players and minutes live for each of the last 14 days (UTC)                       |
| `hourly`       | `{ "days": 14, "players": [24 numbers], "busy": [24 numbers] }`: for each UTC hour (0 to 23) over the last 14 days, the average players and the share of readings (0 to 1) with at least `thresholds.busy` players, each on the median day, so one bad day does not drag an hour down. Readings during a crash are left out (see below). `null` for an hour with no readings (for `busy`: none checked against that threshold) |
| `currentMatch` | Map, start time, peak, score and the top 5 players by kills                            |
| `matches`      | The last 10 match summaries, newest first                                              |
| `discord`      | Server name, member count and online count, refreshed every 10 minutes                 |
| `thresholds`   | The seeding and live thresholds, so the site can say how many players are needed, and `busy` (`BUSY_THRESHOLD`, default 97): the players from which the server counts as busy |
| `leaderboard`  | Top 10 by kills, K/D (10+ hours played, `kdMinHours`), time played and seeding, over the last 30 days (UTC)  |
| `vip`          | What seeding earns (`seedDays`, `seedMinutes`, `windowDays`, `lengthDays`), or `null` when automatic VIP is off |
| `seederVip`    | Who has VIP from seeding now: each player's `name`, `id` and `until`, the latest to earn it first. Not VIP from staff (`/vip add`), nor [staff](#staff-steam-accounts). `null` when automatic VIP is off |
| `weapons`      | The top 10 weapons by kills over the last 30 days (UTC), from the [kill feed](#weapon-stats). See below. `null` until the bot has had the feed |
| `teams`        | Which team wins most over the last 30 days (UTC), overall and on each map, from the bot's match records. See below |

Times are Unix milliseconds. It never includes Steam IDs, the RCON address or the password. Each player on the
leaderboard and in the current and recent matches has their name, their totals and an `id` for their
[player page](#player-pages). Each player in `seederVip` has their `name`, `id` and `until`. Matches recorded before ids were added have names only.
A [private profile](#private-profiles) has `[private profile]` for its name, and no `id`.

`weapons` has:

| Field      | What                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `days`     | How many UTC days it covers, today included: 30                                                |
| `since`    | The UTC day the bot first had the kill feed. Kills before it have no weapon                    |
| `kills`    | Every kill in the feed in those days, and `headshots`, how many of them were headshots         |
| `top`      | Most kills first: each weapon's `name`, `kind` (`weapon` for hand-held, `placed`, `vehicle-weapon`, `emplacement`, `vehicle` or `buildable`), `kills`, `headshots`, `averageDistance` in metres (null when the game sent no distances) and `longest`: its longest kill, `{ distance, name, id }` |
| `longest`  | The longest kill of all with a hand-held weapon: `{ weapon, distance, name, id }`, or null     |

`teams` has:

| Field      | What                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `days`     | How many UTC days it covers, today included: 30                                                |
| `matches`  | The matches recorded in those days with a result (see below). `averageMs`: their average length |
| `teams`    | Most wins first: each team's `name`, `colorHex` (its colour in game, when the server sent one), `matches` played and `wins` |
| `maps`     | Most played first: each map's `matches`, `averageMs` and `teams`: each team that played it, `{ name, wins }`, most wins first |
| `streak`   | The team that won the latest match and how many in a row it has won, `{ name, wins }`, or null with no matches |
| `closest`  | The win by the fewest points over the next team, `{ map, endedAt, durationMs, factionScores }`, or null. `biggest`: the win by the most |

A match goes to the team with the most points. Teams never draw, so a match recorded with the top teams level has no
result: the bot missed the winning points (it reads the server once a minute), or the match was cut short, by a crash or
a map change. Those are left out of the teams, the roundups and players' wins, and so are matches recorded without two
teams' scores. The match summary in Discord says "No result" for them. Teams are matched by name whatever its case or
spacing, and named and coloured as in their latest match. The records start when the bot started keeping them for the player pages.

`server.seenAt` only moves when a check reaches the game server, so a site can tell the server is down when
it is a few minutes old. The stats are kept in the same Durable Object as the bot's state.

The site's busy times are the hours when the server usually has `BUSY_THRESHOLD` players or more (default 97). Each
hour is taken from the median day of the last 14, not from all their readings together, so one bad day, like a crash
or a quiet evening, does not take an hour off the busy times. Set `BUSY_THRESHOLD` in the `vars` block of
`wrangler.jsonc`.

Crashes are left out of the busy times. The bot counts a crash when the server was live (`LIVE_THRESHOLD` players or
more) and lost more than three quarters of its players from one reading to the next: it restarted, or could not be
reached for up to 3 hours and came back nearly empty. Players leaving at the end of the night go a few at a time, so
that is never a crash. A map change that empties the server for a minute or two looks the same, so those minutes are
left out too. The readings from the fall are left out until the players are back to where they were (at most
`BUSY_THRESHOLD`), or for 3 hours if they do not come back. Everything else still counts them: the 24-hour chart, the
daily peak and time live. Crashes before this was added cannot be told apart any more, and are only outvoted by the
median. Changing it counts busy readings again from the last 24 hours, and older
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
| `GET /api/players`       | Everyone seen in the last 90 days, most time played first: `id`, `name`, `minutes` played, `lastSeen` (UTC day) and whether they are `online` now. Not [private profiles](#private-profiles) |
| `GET /api/player?id=<id>` | One player's page, or 404 for an id nobody seen in the last 90 days has, or a private profile's |

A player page has:

| Field      | What                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------ |
| `name`     | The name they used most recently                                                           |
| `activity` | Each UTC day they were on in the last 90 days: seeding and live minutes, seed day, matches, kills and deaths |
| `matches`  | Their matches in the last 90 days (up to 500), newest first: map, end time, length, kills, deaths, place on the scoreboard out of how many, their side (`faction`), `result` (`won` or `lost`, or null when their side was level at the top: see below) and every side's score, with its in-game colour (`colorHex`) when the server reported it |
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
- **What counts.** A kill counts for the weapon that made it: guns, launchers, grenades and tools, things placed (mines,
  claymores, C4, IEDs), a vehicle's gun, an emplacement (the L81 mortar and other fixed weapons, such as AA, which the
  game counts as vehicles though nobody drives them), a vehicle (running someone over, or blowing up with them in it)
  and things built, like barbed wire. The game blames placed and built things on whoever put them there. Suicides,
  falls and deaths with nobody to blame are left out. The feed does not say who is on which side, so team kills count
  too.
- **Longest kill.** The longest kill of all, and the live match's, count hand-held weapons only (`kind` `weapon`): how
  far a mine was from whoever laid it, or an emplacement from its target, says nothing about their aim. Each weapon
  still has its own longest kill.
- **Names.** The game sends tags like `Id.Item.AK74M`. The bot names the ones it knows (AK74), from
  [Warcon](https://github.com/warcon-app/warcon)'s list. Some Warcon has no name for: `Id.Item.WEPN_030` is the FAL,
  `WEPN_033` the Bushmaster M17S, `SMG_03` the PP-19 Vityaz, `WEPN_028` the MP5, `WEPN_026` the M1911, `WEPN_027` the
  Deagle and `WEPN_032` the GGX 18, as staff found in game; `Id.Item.WEPN_035` the Scout Rifle TD,
  `Id.Item.Launcher_04` the 9K333 Verba and `Vehicle.Variant.Stationary.STN_05` the Stingray, as [Wardogs
  Zone](https://wardogs.zone/database), whose pages go by the game's tags, names them; and `Id.Item.SR_04` the AMR 50,
  the one sniper rifle left. That names all 34 of the game's weapons. A new one is named from its tag
  (`Id.Item.WEPN_099` is "WEPN 099") until it is added to `NAMES` in `src/weapons.ts`; the staff page lists those
  ([Weapons to name](#kills-and-headshots)), so staff can find out what they are in game. Tags with the same name,
  like each side's M113, or the mortar (`Vehicle.Variant.Stationary.Mortar`) and its barrel
  (`Id.Vehicle.WeaponExtension.STN_03.MainBarrel`), are one weapon.
- **Distances** are between the killer and the victim, in metres. A vehicle blowing up has none, so its average
  distance is left out.
- **A batch sent twice** counts once: the bot remembers the last 5,000 kills it counted, until it restarts.
- **`/removematch`** does not change weapon stats: they come from the feed, not from matches.
- **Requests.** Each batch is one Worker request. The game sends one at most every 2 seconds while people are being
  killed, and a capture of a busy server saw about 550 an hour: some 6,600 a day for a server live 12 hours a day,
  against the free plan's 100,000. Each is one storage write, of the day's totals and each killer's, and one more row
  for each killer's day on the staff page's [Kills tab](#kills-and-headshots).
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
| `highlights` | `firstBlood`, `longest` kill (hand-held weapons only), `bestStreak` (3 or more), `onFire` (up to 3 players on 5 or more kills without dying now), `bestMultiKill` (2 or more kills each within 8 seconds), `mostHeadshots`, and a `rivalry` (one player killing another 3 or more times) |

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
- **Long, busy matches.** The match is saved with each kill feed batch, and storage takes at most 128 KiB in one
  value. Past 90 KB, the bot first forgets pairs of players with fewer than 3 kills of one by the other (only a rivalry
  needs them), then the players with the fewest kills and deaths, who never show on the page. Everyone in the feed,
  first blood, the rivalry, a highlight or the top 10 stays. A player it forgot who kills or dies again starts from
  nothing, and their kills leave the match's top weapons. If those left still don't fit, each keeps only the weapon
  they have the most kills with, and as a last resort the match keeps only its totals, so a batch is never refused.
- **Replies to the game.** The bot replies to each batch once it is saved, and only then updates the open pages.

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
| Each UTC day's griefing      | From the kill feed, for the [staff page](#staff-page): each player's team kills (and whom, other than in a helicopter crash), times team killed, suicides and vehicle suicides, and the day's latest 300 team kills and vehicle suicides |
| The latest kills             | From the kill feed, for the staff page's [Kills tab](#kills-and-headshots): the server's latest 250 kills, with the Steam IDs and names of killer and victim |
| Each player's kills, each UTC day | From the kill feed, for the Kills tab, in the Durable Object's SQLite database: their kills and headshots, by weapon too, and each kill (their latest 1,000) with whom, with what, how far, headshot, team kill and map. Kept 30 days |
| The server's ban list        | As at the last reading (every 10 minutes), to notice bans made or lifted outside the bot ([moderation log](#moderation-log)) |
| Each player's Steam account  | From Steam, for [risky accounts](#risky-steam-accounts): their VAC, game, community and trading bans, whether the profile is public and set up, when the account was made, and when the bot checked |

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
- Records are kept for good, except as the table says (each player's kills for the Kills tab: 30 days). They start from
  the first deploy with this feature; older matches only have the public top 5, without Steam IDs.
- Both are stored in the same Durable Object as the bot's state, so they are covered by the free plan: a check
  writes one row for the day's totals, however many players are online.

The Node/Docker version does not keep player records.

## Automatic VIP

Players who seed get a reserved slot, so they skip the queue when the server is full:

- **Seed on 3 days in a week** (`VIP_SEED_DAYS` successful seeds in the last 7 UTC days, including today), and the
  bot adds you to the server's reserved list for **a week**.
- Staff who linked their Steam account on the [staff page](#staff-steam-accounts) never earn it: it is for the players
  who seed.
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
- It only removes players it added itself, and the [staff spots](#staff-steam-accounts) of staff who unlinked. Reserved
  slots an admin gave out by hand are never touched, unless they are a linked staff member's, which the bot takes over
  as their staff spot. A player who already has one is left as they are.
- If an admin takes a bot-given VIP off the list, the bot forgets it. It adds them again only if they earn it again.
- It reads the list's lines in order, as the game does: `!DefaultReservedPlayerIds=ClearArray` empties the list so
  far, `-DefaultReservedPlayerIds=<Steam ID>` takes a player off, and `+` adds one. It leaves those lines as they are.
  It adds a player with a line after the list's last line, so nothing before it takes them off again, and removes one
  by deleting the lines that add them.
- `MaxReservedSlots` in the same section sets how many slots are held back for reserved players. The bot does not
  change it.
- Each change is logged (`VIP added: …`, `VIP ended: …`), and `/seeders` shows who has VIP from the bot and until when.
- The website lists who has VIP from seeding (`seederVip` in [`/api/stats`](#website-stats)). The bot keeps whether
  each player got VIP by seeding or from staff. VIP it gave before it kept that counts as seeding; VIP from staff
  stays from staff when it is extended, and a seeder's stays from seeding.
- Staff can give or take away VIP by hand with [`/vip add` and `/vip remove`](#staff-commands).

Turning it off (`VIP_SEED_DAYS` `"0"`) stops players earning it. VIP the bot already gave, by seeding or through
`/vip add`, still ends on time.
Automatic VIP is Cloudflare only.

## In-game messages

### Welcome

Each player who joins gets a private message in game (like `/warn`, only they see it) 2 minutes after the bot sees
them join (`WELCOME_MESSAGE_MINUTES`), with the basic rules and where the Discord and the website are:

> Welcome! Rules: no cheating or exploits, no team killing or griefing, no racism or abuse, and listen to admins. Full
> rules on our Discord. Discord: discord.gg/qsJFYGhSJ4 | Website: gaminginit.com

- The bot sees joins at its check each minute, so the welcome arrives 2 to 3 minutes after the player joins.
- **Not again for 6 hours:** a player who rejoins within 6 hours of their welcome (a map change, a crash) doesn't get
  it again. Players already on when the bot starts watching (a deploy, a restart) count as welcomed.
- Someone who leaves before their welcome goes out doesn't get it; they wait again if they come back.
- The Discord link comes from `DISCORD_INVITE` and the website from `SITE_URL`; either is left out when not set.
- The rules line is on the [Lines tab](#lines-tab) (Welcome), so staff can change it without a deploy. The default is
  in `src/lines.ts`.
- A welcome that fails to send is logged (`Welcome to "<name>" (<Steam ID>) failed: …`) and not tried again. Each one
  sent is logged as `Sent welcome to "<name>" (<Steam ID>): …`.
- It uses the RCON password's write access (`POST /v1/players/<Steam ID>/message`), like `/warn`.
- Set `WELCOME_MESSAGE_MINUTES` to another number of minutes in the `vars` block of `wrangler.jsonc`, or `"0"` to turn
  it off.

### Seeding and match messages

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
- The opening line is picked at random from the seeding lines (staff change them on the [Lines tab](#lines-tab));
  `{needed}` is filled in, such as "15 more players". The reward after it comes from `VIP_SEED_DAYS` and `VIP_SEED_MINUTES`, so it always matches what
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

- Each message's line is picked at random from its list: the seeding lines, the 10-minute lines, and for halfway and
  90 points a list for each faction (🤠 Lonestar, 🦂 Manticore, 🐻 Valkyra), plus lines for level scores and for any
  other faction (for halfway and 90 points, from the leading faction's list). Staff change them on the staff page's
  [Lines tab](#lines-tab). `{team}`, `{score}` and `{site}` are filled in.
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

### Lines tab

The [staff page](#staff-page) has a tab for the lines the bot says in game, so staff can reword them, add new ones or
take some out without a deploy. Each list (seeding, welcome, 10 minutes in, halfway and 90 points for each faction,
level scores, any other team) has its own editor:

- Each line shows the whole message as it goes out in game, with what the bot adds before and after it (such as
  "Halfway there!" and the seeding call to action) and its placeholders filled in, and how many of the game's 200
  characters it uses. A line that doesn't fit, or has a placeholder the bot can't fill in for that list, can't be saved.
  The count takes each placeholder at the longest it can be when the message goes out, not as the preview shows it:
  the halfway `{score}` as the winning score (the leader can be anywhere from half of it up), and `{team}` as 16
  characters (the server may spell a faction its own way, and any other team could be called anything).
  The lines are checked against the bot's settings now (`SITE_URL`, VIP, `SCORE_TO_WIN`, `LIVE_THRESHOLD`); if those
  change and a saved line no longer fits, the page marks it, and the bot cuts it short with "…" until it is changed.
- Nothing changes until staff press Save. The next message of that kind uses the new lines.
- **Use the bot's lines** puts a list back to the bot's own, in `src/lines.ts`. Lists staff never changed (or saved the
  same as the bot's) always use the bot's own, so lines reworded in `src/lines.ts` reach them on the next deploy. Lists
  staff changed keep staff's lines.
- Each list says who changed it last and when. A list has 1 to 50 lines.
- The page reads `GET /api/admin/lines` and sends changes to `POST /api/admin/lines` (`{"action": "save", "list":
  "halfway.valkyra", "lines": ["…"]}`, or `{"action": "reset", "list": "…"}`). Each change is logged as
  `Staff page: lines <action> "<list>" by "<staff>" (Discord user <ID>)`.

The Node/Docker version has no staff page, so it says the lines in `src/lines.ts`.

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
- At night the seeding, low-pop and back-up alerts are posted without pinging `DISCORD_ROLE_ID`: the server dying down then is
  everyone going to bed, and a ping would only annoy the seeders. Night is from `QUIET_START_HOUR` up to
  `QUIET_END_HOUR` in `QUIET_TIME_ZONE`'s own time, so it follows the clocks changing (defaults `21`, `6` and
  `Europe/London`: 9pm to 6am in the UK, summer and winter). The same hour for both turns it off. A live alert still
  pings at night, and so does a `/seednow` call.
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
- The summary's title links to `<SITE_URL>/matches#match-<endedAt>` (a trailing slash on `SITE_URL` is fine), where
  `endedAt` is the time the match was recorded as ending, in milliseconds: the same `endedAt` as in `matches` on
  `/api/stats`, which the website names each match by. The bot takes it from what it recorded, never from the clock
  when the post goes out, so a summary retried after a Discord outage, or posted twice after a failed save, still links
  to the right match. `/lastmatch` links the same way from the match it shows. Without that time the title links to
  `SITE_URL` alone: the Node/Docker version, which records no matches, and a summary saved before this was added
  and still waiting to post. The website keeps only the last 10 matches, so the link of an older one finds nothing
  on the matches page.
- With three or more factions, the summary names them all: "**Valkyra** won 100, Kharr 67, Haldor 41".
- If a Discord post fails, the alert is retried on the next check while it is still true. A match summary
  is retried until it posts, or until the next match ends. Matches are recorded before their summary is
  posted, so a Discord outage does not lose them. If RCON is unreachable (for example during the game's
  daily restart), the check is skipped and logged. A server that had players and stays unreachable for 5 minutes is
  posted to the [moderation log](#moderation-log); one nobody was on is not.
- The seeding alert waits until the server has kept players for `SEEDING_ALERT_MINUTES` (default 5), so someone who
  joins an empty server and leaves a minute later pings nobody. Seeding itself starts with the first player, so their
  time still counts towards [automatic VIP](#automatic-vip). If the server goes live first, only the live alert goes
  out. A `/seednow` call covers the alert when the first player joins within its cooldown, however long the wait. `0`
  sends it straight away.
- **Crashes.** When a live server crashes (it loses more than three quarters of its players at once, and has under
  half of them 3 minutes later), there is no low-pop alert and no seeding alert. Once players have been back on for
  `SEEDING_ALERT_MINUTES`, the 🔁 back-up alert pings `DISCORD_ROLE_ID` once, then the live alert as usual. Staff hear
  about the crash in the [moderation log](#moderation-log). This needs `DROP_GRACE_MINUTES` of 3 or more, as it is by
  default: with less, the low-pop alert goes out before the crash is confirmed.

## Security

The RCON password gives full admin control of the server (kick, ban, end match, change settings). On its own
the bot only reads the server, sends the [in-game messages](#in-game-messages) (`POST /v1/broadcast`, and
`POST /v1/players/…/message` for the welcome), changes the
reserved list in `ServerSettings.ini` for [automatic VIP](#automatic-vip) (`PUT /v1/config`), puts each day's planned
[map rotation](#map-rotations) there in the same way, and lifts timed bans when they end (`DELETE /v1/bans/…`). Everything else it changes is asked for by staff through a
[staff command](#staff-commands). Still:

- Keep the password in a Wrangler secret or `.env`, never in `wrangler.jsonc` or the repo.
- Over `http://`, the password is sent unencrypted on every check. Use an `https://` RCON address if
  your host offers one.
- `/serverstatus` requests are only accepted with a valid Discord signature (checked against
  `DISCORD_PUBLIC_KEY`) and a timestamp within 5 minutes, so nobody else can make the Worker call your
  server and a captured request cannot be replayed later.
- The [kill feed](#weapon-stats) is only taken with `KILL_FEED_TOKEN` as the bearer, so nobody else can add kills.
  Anyone who has the token can, so keep it secret like the password.
- The [Steam checks](#risky-steam-accounts) only send `STEAM_API_KEY` and players' Steam IDs, to Steam
  (`api.steampowered.com`). Keep the key secret: requests made with it count against its daily limit.
- The [staff page](#staff-page)'s data is only served for a session the Worker signed after Discord confirmed the person
  is staff in `DISCORD_GUILD_ID`. Keep `DISCORD_CLIENT_SECRET` secret: anyone with it could sign their own sessions.
- Player names in posts are escaped, and posts never ping anyone except the configured role.

## Development

```bash
npm ci
npm test
npm run typecheck
```

`test/worker.test.ts` runs the Worker as Cloudflare does: Wrangler builds it from `wrangler.jsonc` and runs it in
workerd, with the Durable Object's storage, against a fake game server on localhost. It checks the cron, the website's
API, the kill feed, the alert review, the staff page's sign-in and the slash commands' signature and staff checks. Nothing in it reaches Discord
or the game.
