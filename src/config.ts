import { z } from 'zod';
import type { AlertRules, QuietHours } from './alerts.ts';
import { MAX_TOP_PLAYERS, type MatchEndRule } from './matchend.ts';
import type { MapVoteRule } from './mapvote.ts';
import { discordLink, type MessageRule, type SeedingMessageRule, type WelcomeRule } from './messages.ts';

const numericId = z.string().regex(/^\d+$/, 'must be a numeric ID');
// Just the listener's address; the bot adds /v1/status itself. Pasted values often carry quotes, stray
// whitespace or no scheme, so those are tidied rather than rejected.
const tidyAddress = (value: string): string => {
  const bare = value.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  return /^[a-z]+:\/\//i.test(bare) ? bare : `http://${bare}`;
};
const rconUrl = z
  .string()
  .transform(tidyAddress)
  .pipe(
    z
      .string()
      .regex(
        /^https?:\/\/[^/\s]+\/?$/,
        'must be the address and port only, like http://203.0.113.10:7776 (no path after the port)',
      ),
  );
const webhookUrl = z
  .string()
  .regex(/^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/, 'must be a Discord webhook URL');
const count = (fallback: number) => z.coerce.number().int().min(1).default(fallback);
// An invite code, or a discord.gg / discord.com/invite link; only the code is kept.
const invite = z
  .string()
  .regex(
    /^(?:https?:\/\/)?(?:www\.)?(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)?[\w-]+\/?$/,
    'must be an invite link like https://discord.gg/abc123',
  )
  .transform((value) => value.replace(/\/$/, '').split('/').pop() ?? value);

const isTimeZone = (name: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: name });
    return true;
  } catch {
    return false;
  }
};

const EnvSchema = z
  .object({
    RCON_URL: rconUrl,
    RCON_PASSWORD: z.string().min(1),
    DISCORD_WEBHOOK_URL: webhookUrl,
    // A webhook in a channel of its own, for the live server status the bot keeps up to date there.
    DISCORD_STATUS_WEBHOOK_URL: webhookUrl.optional(),
    // Where the weekly and monthly roundups go, when not to the alerts channel.
    DISCORD_ROUNDUP_WEBHOOK_URL: webhookUrl.optional(),
    // A staff-only channel for the moderation log: warnings, kicks, bans and unbans, and possible griefing.
    DISCORD_MODLOG_WEBHOOK_URL: webhookUrl.optional(),
    DISCORD_ROLE_ID: numericId.optional(),
    DISCORD_INVITE: invite.optional(),
    // Player accounts (see accounts.ts): the role a player gets for linking their Steam account, and the one they have
    // while they have seeder VIP. Both optional; the bot's role must be above them. Need DISCORD_BOT_TOKEN.
    DISCORD_LINKED_ROLE_ID: numericId.optional(),
    DISCORD_VIP_ROLE_ID: numericId.optional(),
    DISCORD_PLAYER_OF_MONTH_ROLE_ID: numericId.optional(),
    DISCORD_CHALLENGE_ROLE_ID: numericId.optional(),
    // A path on the website that sends people to the Discord invite and counts the click, such as /discord. The welcome
    // message gives it instead of the invite code: it is short enough to type. It needs the website to have the path.
    DISCORD_SHORT_LINK: z
      .string()
      .trim()
      .regex(/^\/[\w-]+$/, 'must be a path on the website, like /discord')
      .optional(),
    // The community website; Discord posts link to it.
    SITE_URL: z.url({ protocol: /^https?$/ }).optional(),
    // The server's ID for Join by ID in the game's server browser; the status posts show it so people can join.
    SERVER_ID: z
      .string()
      .trim()
      .regex(/^[\w-]+$/, "must be the server's ID for Join by ID, like 2615de90-da95-4950-913a-246b1db49237")
      .optional(),
    SEEDING_THRESHOLD: count(1),
    LIVE_THRESHOLD: count(20),
    LOW_POP_THRESHOLD: count(20),
    // The website's busy times: the hours when the server usually has at least this many players.
    BUSY_THRESHOLD: count(97),
    POLL_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(60),
    ALERT_COOLDOWN_MINUTES: z.coerce.number().int().min(0).default(10),
    // A drop in players only counts (low-pop alert, seeding re-armed) once it has lasted this long.
    DROP_GRACE_MINUTES: z.coerce.number().int().min(0).default(5),
    // The seeding alert waits until an empty server has kept its first players this long. 0 sends it straight away.
    SEEDING_ALERT_MINUTES: z.coerce.number().int().min(0).default(5),
    // The night, when the seeding and low-pop alerts go out without pinging the role: from QUIET_START_HOUR up to
    // QUIET_END_HOUR, in QUIET_TIME_ZONE's own time, so it follows the clocks changing. The same hour for both turns it off.
    QUIET_START_HOUR: z.coerce.number().int().min(0).max(23).default(21),
    QUIET_END_HOUR: z.coerce.number().int().min(0).max(23).default(6),
    QUIET_TIME_ZONE: z
      .string()
      .trim()
      .refine(isTimeZone, 'must be a time zone name like Europe/London or UTC')
      .default('Europe/London'),
    // Automatic VIP: days with a successful seed needed in a week. 0 turns it off. Only for VIP_MODE "week".
    VIP_SEED_DAYS: z.coerce.number().int().min(0).max(7).default(0),
    // Which automatic VIP rule: "week" (seed on VIP_SEED_DAYS days in a week for a week) or "day" (seed on one day for
    // 3 days). "day" turns automatic VIP on whatever VIP_SEED_DAYS says.
    VIP_MODE: z.enum(['week', 'day']).default('week'),
    // A seed counts when a player was on for more than this many minutes while the server seeded, and it then went live.
    VIP_SEED_MINUTES: z.coerce.number().int().min(1).default(10),
    // Kill a player on a streak of this many kills or more without dying and get a whitelist slot for the next BOUNTY_VIP_DAYS calendar days (UTC), starting tomorrow.
    // 0 turns it off. On by default, at 20.
    BOUNTY_STREAK: z.coerce.number().int().min(0).default(20),
    BOUNTY_VIP_DAYS: z.coerce.number().int().min(1).max(30).default(1),
    // Tell the whole server in game who has a bounty (a player reaching BOUNTY_STREAK kills) and who ended it.
    BOUNTY_ANNOUNCE: z.enum(['on', 'off']).default('on'),
    // In-game messages during matches, pointing players at SITE_URL. Need SITE_URL.
    MATCH_MESSAGES: z.enum(['on', 'off']).default('on'),
    // The score a faction needs to win: for "halfway" and "nearly there" messages, and to record a win the last check
    // saw one point short.
    SCORE_TO_WIN: z.coerce.number().int().min(2).default(100),
    // While the server seeds, an in-game message about seeding and what it earns, every this many minutes and 30 seconds
    // after someone joins. 0 turns both off.
    SEEDING_MESSAGE_MINUTES: z.coerce.number().int().min(0).default(5),
    // A private message to each player this many minutes after they join, with the basic rules, the Discord
    // (DISCORD_INVITE) and the website (SITE_URL). 0 turns it off.
    WELCOME_MESSAGE_MINUTES: z.coerce.number().int().min(0).default(2),
    // The moment a team wins a match, a private message to this many of the top players on its scoreboard, with where
    // they finished and the website (SITE_URL) for their stats. Needs SITE_URL. 0 sends none.
    TOP_PLAYER_MESSAGES: z.coerce.number().int().min(0).max(MAX_TOP_PLAYERS).default(5),
    // With the top players' messages, one to each of the match's award winners from the kill feed (best demolitions,
    // most headshots and the rest): "on" or "off". Needs SITE_URL.
    AWARD_MESSAGES: z.enum(['on', 'off']).default('on'),
    // Weekly and monthly roundups of the best players and team, posted to Discord: "on" or "off".
    ROUNDUPS: z.enum(['on', 'off']).default('on'),
    // A Discord message to linked players who have been away, when the server seeds (see README, "Asking players back"):
    // "on" or "off". Off unless set.
    ASK_BACK: z.enum(['on', 'off']).default('off'),
    // The hour (UTC) on Mondays, and on the 1st of the month, when the roundups go out.
    ROUNDUP_HOUR: z.coerce.number().int().min(0).max(23).default(17),
    // The hour (UTC) each day's map rotation starts, so a late night still plays the evening's rotation.
    ROTATION_HOUR: z.coerce.number().int().min(0).max(23).default(5),
    // Posts to the moderation log when a player passes a griefing flag (team kills, vehicle suicides): "on" or "off".
    GRIEF_ALERTS: z.enum(['on', 'off']).default('on'),
    // Messages a player in game when they team kill, telling them it is against the rules and to apologise in team chat:
    // "on" or "off".
    TEAMKILL_WARNING: z.enum(['on', 'off']).default('on'),
    // Posts to the moderation log when a player with one of the riskiest Steam accounts is in game (needs STEAM_API_KEY):
    // "on" or "off".
    STEAM_ALERTS: z.enum(['on', 'off']).default('on'),
    // Posts to the moderation log when a player in game has a day of unlikely headshots: "on" or "off".
    HEADSHOT_ALERTS: z.enum(['on', 'off']).default('on'),
    // Posts to the moderation log when the server crashes or cannot be reached, and when it is back: "on" or "off".
    OUTAGE_ALERTS: z.enum(['on', 'off']).default('on'),
    // Posts to the moderation log when the server is live and the kill feed has sent nothing for 10 minutes, and when
    // kills arrive again: "on" or "off".
    FEED_ALERTS: z.enum(['on', 'off']).default('on'),
    // The next-map vote on the website: when a match goes live, a vote between MAP_VOTE_OPTIONS maps, open for
    // MAP_VOTE_MINUTES (or until a team has MAP_VOTE_CLOSE_PERCENT of SCORE_TO_WIN). The winner is put on the server as the next map. "on" or "off".
    MAP_VOTE: z.enum(['on', 'off']).default('off'),
    // The channel the vote is posted in, and the bot's token to post it with (a webhook can't carry buttons). The bot
    // needs View Channel, Send Messages and Embed Links there.
    DISCORD_VOTE_CHANNEL_ID: numericId.optional(),
    DISCORD_BOT_TOKEN: z.string().trim().optional(),
    MAP_VOTE_OPTIONS: z.coerce.number().int().min(2).max(6).default(4),
    // A backstop: a match lasts about 50 minutes, and the vote normally closes when a team reaches the close percent.
    MAP_VOTE_MINUTES: z.coerce.number().int().min(1).max(120).default(60),
    MAP_VOTE_CLOSE_PERCENT: z.coerce.number().int().min(50).max(99).default(95),
    // How the winner is put on the server: "rotation" writes it into the rotation as the next map, which can be done as soon as
    // the vote closes, and writes the rotation back once it is playing; "queue" stages it (POST /v1/match/map) once the match is
    // over, which the server travels to when the end screen finishes.
    MAP_VOTE_STAGING: z.enum(['rotation', 'queue']).default('rotation'),
  })
  .refine((env) => env.SEEDING_THRESHOLD < env.LIVE_THRESHOLD, {
    path: ['SEEDING_THRESHOLD'],
    message: 'must be below LIVE_THRESHOLD',
  })
  .refine((env) => env.LOW_POP_THRESHOLD <= env.LIVE_THRESHOLD, {
    path: ['LOW_POP_THRESHOLD'],
    message: 'must not be above LIVE_THRESHOLD',
  });

// Seed on `seedDays` days within `windowDays` and get a whitelist slot for `lengthDays`. A day counts when the player
// was on for more than `seedMinutes` while the server seeded, and it then went live.
export type VipRule = { seedDays: number; seedMinutes: number; windowDays: number; lengthDays: number };

export const VIP_WEEK_DAYS = 7;
// VIP_MODE "day": one seed day gives this many days. A seed in the last this many days keeps it, as a week does.
export const VIP_DAY_LENGTH_DAYS = 3;

const vipRule = (mode: 'week' | 'day', seedDays: number, seedMinutes: number): VipRule | null => {
  if (mode === 'day') return { seedDays: 1, seedMinutes, windowDays: VIP_DAY_LENGTH_DAYS, lengthDays: VIP_DAY_LENGTH_DAYS };
  return seedDays > 0 ? { seedDays, seedMinutes, windowDays: VIP_WEEK_DAYS, lengthDays: VIP_WEEK_DAYS } : null;
};

export type Config = {
  rconUrl: string;
  rconPassword: string;
  webhookUrl: string;
  // Where the live server status is kept, when there is one.
  statusWebhookUrl: string | undefined;
  // The staff-only moderation log channel, when there is one.
  modLogWebhookUrl: string | undefined;
  // Whether possible griefing is posted to the moderation log.
  griefAlerts: boolean;
  // Whether a player who team kills is messaged in game.
  teamKillWarning: boolean;
  // Whether the riskiest Steam accounts are posted to the moderation log.
  steamAlerts: boolean;
  // Whether days of unlikely headshots are posted to the moderation log.
  headshotAlerts: boolean;
  // Whether crashes and the server being unreachable are posted to the moderation log.
  outageAlerts: boolean;
  // Whether the kill feed going quiet on a live server is posted to the moderation log.
  feedAlerts: boolean;
  roleId: string | undefined;
  inviteCode: string | undefined;
  siteUrl: string | undefined;
  // What the bot does for player accounts: the roles, and whether it can send them messages and add them to the server.
  accounts: { linkedRoleId: string | undefined; vipRoleId: string | undefined; botToken: string | undefined };
  // The roles the player of the month and the weekly challenge's winner get (see drives.ts).
  drives: { playerOfMonthRoleId: string | undefined; challengeRoleId: string | undefined };
  // Whether linked players who have been away are asked back when the server seeds (ASK_BACK).
  askBack: boolean;
  // The server's ID for Join by ID in game, when set.
  serverId: string | undefined;
  pollIntervalMs: number;
  rules: AlertRules;
  // When the seeding and low-pop alerts ping nobody. Null when QUIET_START_HOUR and QUIET_END_HOUR are the same.
  quietHours: QuietHours | null;
  // Players from which the server counts as busy, for the website.
  busyThreshold: number;
  // The score a faction needs to win.
  scoreToWin: number;
  // A player must seed for more than this for it to count as a successful seed, whether or not VIP is on.
  seedMinutes: number;
  vip: VipRule | null;
  // A whitelist slot for killing a player on a long kill streak, when it is on.
  bounty: { streak: number; days: number; announce: boolean } | null;
  // Null when MATCH_MESSAGES is off or there is no SITE_URL to point players at.
  matchMessages: MessageRule | null;
  // Null when SEEDING_MESSAGE_MINUTES is 0.
  seedingMessages: SeedingMessageRule | null;
  // Null when WELCOME_MESSAGE_MINUTES is 0.
  welcomeMessages: WelcomeRule | null;
  // Null when TOP_PLAYER_MESSAGES is 0 and AWARD_MESSAGES is off, or there is no SITE_URL to point players at.
  matchEndMessages: MatchEndRule | null;
  // When the roundups go out (an hour, UTC) and where. Null when ROUNDUPS is off.
  roundups: RoundupRule | null;
  // The hour (UTC) each day's map rotation starts.
  rotationHour: number;
  // Null when MAP_VOTE is off.
  mapVote: MapVoteRule | null;
};

export type RoundupRule = { hour: number; webhookUrl: string };

export const loadConfig = (env: Record<string, string | undefined>): Config => {
  // A copied .env.example leaves optional keys blank; treat those as unset so defaults apply.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = EnvSchema.safeParse(present);

  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid configuration:\n${problems.join('\n')}`);
  }

  const e = parsed.data;
  return {
    rconUrl: e.RCON_URL,
    rconPassword: e.RCON_PASSWORD,
    webhookUrl: e.DISCORD_WEBHOOK_URL,
    statusWebhookUrl: e.DISCORD_STATUS_WEBHOOK_URL,
    modLogWebhookUrl: e.DISCORD_MODLOG_WEBHOOK_URL,
    griefAlerts: e.GRIEF_ALERTS === 'on',
    teamKillWarning: e.TEAMKILL_WARNING === 'on',
    steamAlerts: e.STEAM_ALERTS === 'on',
    headshotAlerts: e.HEADSHOT_ALERTS === 'on',
    outageAlerts: e.OUTAGE_ALERTS === 'on',
    feedAlerts: e.FEED_ALERTS === 'on',
    roleId: e.DISCORD_ROLE_ID,
    inviteCode: e.DISCORD_INVITE,
    siteUrl: e.SITE_URL,
    accounts: { linkedRoleId: e.DISCORD_LINKED_ROLE_ID, vipRoleId: e.DISCORD_VIP_ROLE_ID, botToken: e.DISCORD_BOT_TOKEN || undefined },
    drives: { playerOfMonthRoleId: e.DISCORD_PLAYER_OF_MONTH_ROLE_ID, challengeRoleId: e.DISCORD_CHALLENGE_ROLE_ID },
    askBack: e.ASK_BACK === 'on',
    serverId: e.SERVER_ID,
    pollIntervalMs: e.POLL_INTERVAL_SECONDS * 1000,
    rules: {
      seeding: e.SEEDING_THRESHOLD,
      live: e.LIVE_THRESHOLD,
      lowPop: e.LOW_POP_THRESHOLD,
      cooldownMs: e.ALERT_COOLDOWN_MINUTES * 60_000,
      graceMs: e.DROP_GRACE_MINUTES * 60_000,
      seedHoldMs: e.SEEDING_ALERT_MINUTES * 60_000,
    },
    quietHours:
      e.QUIET_START_HOUR === e.QUIET_END_HOUR
        ? null
        : { start: e.QUIET_START_HOUR, end: e.QUIET_END_HOUR, timeZone: e.QUIET_TIME_ZONE },
    busyThreshold: e.BUSY_THRESHOLD,
    scoreToWin: e.SCORE_TO_WIN,
    seedMinutes: e.VIP_SEED_MINUTES,
    vip: vipRule(e.VIP_MODE, e.VIP_SEED_DAYS, e.VIP_SEED_MINUTES),
    bounty: e.BOUNTY_STREAK > 0 ? { streak: e.BOUNTY_STREAK, days: e.BOUNTY_VIP_DAYS, announce: e.BOUNTY_ANNOUNCE === 'on' } : null,
    matchMessages:
      e.MATCH_MESSAGES === 'on' && e.SITE_URL
        ? {
            siteHost: new URL(e.SITE_URL).host,
            scoreToWin: e.SCORE_TO_WIN,
            ...(e.MAP_VOTE === 'on' && e.DISCORD_VOTE_CHANNEL_ID && e.DISCORD_BOT_TOKEN ? { vote: true } : {}),
          }
        : null,
    seedingMessages:
      e.SEEDING_MESSAGE_MINUTES > 0
        ? { everyMs: e.SEEDING_MESSAGE_MINUTES * 60_000, siteHost: e.SITE_URL ? new URL(e.SITE_URL).host : null }
        : null,
    welcomeMessages:
      e.WELCOME_MESSAGE_MINUTES > 0
        ? {
            afterMs: e.WELCOME_MESSAGE_MINUTES * 60_000,
            siteHost: e.SITE_URL ? new URL(e.SITE_URL).host : null,
            discord:
              e.SITE_URL && e.DISCORD_SHORT_LINK
                ? `${new URL(e.SITE_URL).host}${e.DISCORD_SHORT_LINK}`
                : e.DISCORD_INVITE
                  ? discordLink(e.DISCORD_INVITE)
                  : null,
          }
        : null,
    matchEndMessages:
      (e.TOP_PLAYER_MESSAGES > 0 || e.AWARD_MESSAGES === 'on') && e.SITE_URL
        ? { count: e.TOP_PLAYER_MESSAGES, awards: e.AWARD_MESSAGES === 'on', siteHost: new URL(e.SITE_URL).host }
        : null,
    roundups:
      e.ROUNDUPS === 'on' ? { hour: e.ROUNDUP_HOUR, webhookUrl: e.DISCORD_ROUNDUP_WEBHOOK_URL ?? e.DISCORD_WEBHOOK_URL } : null,
    rotationHour: e.ROTATION_HOUR,
    mapVote:
      e.MAP_VOTE === 'on'
        ? { options: e.MAP_VOTE_OPTIONS, minutes: e.MAP_VOTE_MINUTES, closePercent: e.MAP_VOTE_CLOSE_PERCENT, channelId: e.DISCORD_VOTE_CHANNEL_ID, botToken: e.DISCORD_BOT_TOKEN, staging: e.MAP_VOTE_STAGING }
        : null,
  };
};
