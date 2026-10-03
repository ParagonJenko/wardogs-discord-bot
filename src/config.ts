import { z } from 'zod';
import type { AlertRules } from './alerts.ts';
import type { MessageRule, SeedingMessageRule } from './messages.ts';

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
// Comma-separated role IDs; blanks and stray spaces are dropped.
const roleIds = z
  .string()
  .transform((value) => value.split(',').map((id) => id.trim()).filter((id) => id !== ''))
  .pipe(z.array(numericId).max(25, 'at most 25 roles'));

// What gives access to the game server or a Discord channel. Hosted for several communities, these are kept
// encrypted, and never shown again once set.
const SECRET_FIELDS = {
  RCON_URL: rconUrl,
  // No control characters: it goes into a request header.
  RCON_PASSWORD: z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/, 'must not contain line breaks or control characters'),
  DISCORD_WEBHOOK_URL: webhookUrl,
  // A webhook in a channel of its own, for the live server status the bot keeps up to date there.
  DISCORD_STATUS_WEBHOOK_URL: webhookUrl.optional(),
  // Where the weekly and monthly roundups go, when not to the alerts channel.
  DISCORD_ROUNDUP_WEBHOOK_URL: webhookUrl.optional(),
};

// Everything else: how the bot behaves. A community's admins can change these themselves.
const SETTING_FIELDS = {
  DISCORD_ROLE_ID: numericId.optional(),
  // Roles whose members may use the staff commands as well as Administrators.
  DISCORD_ADMIN_ROLE_IDS: roleIds.optional(),
  DISCORD_INVITE: invite.optional(),
  // The community website; Discord posts link to it.
  SITE_URL: z.url({ protocol: /^https?$/ }).max(200).optional(),
  SEEDING_THRESHOLD: count(1),
  LIVE_THRESHOLD: count(20),
  LOW_POP_THRESHOLD: count(20),
  // The website's busy times: the hours when the server usually has at least this many players.
  BUSY_THRESHOLD: count(97),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(60),
  ALERT_COOLDOWN_MINUTES: z.coerce.number().int().min(0).default(10),
  // A drop in players only counts (low-pop alert, seeding re-armed) once it has lasted this long.
  DROP_GRACE_MINUTES: z.coerce.number().int().min(0).default(5),
  // Automatic VIP: days with a successful seed needed in a week. 0 turns it off.
  VIP_SEED_DAYS: z.coerce.number().int().min(0).max(7).default(0),
  // A seed counts when a player was on for more than this many minutes while the server seeded, and it then went live.
  VIP_SEED_MINUTES: z.coerce.number().int().min(1).default(10),
  // In-game messages during matches, pointing players at SITE_URL. Need SITE_URL.
  MATCH_MESSAGES: z.enum(['on', 'off']).default('on'),
  // The score a faction needs to win: for "halfway" and "nearly there" messages, and to record a win the last check
  // saw one point short.
  SCORE_TO_WIN: z.coerce.number().int().min(2).default(100),
  // While the server seeds, an in-game message about seeding and what it earns, every this many minutes and 30 seconds
  // after someone joins. 0 turns both off.
  SEEDING_MESSAGE_MINUTES: z.coerce.number().int().min(0).default(5),
  // Weekly and monthly roundups of the best players and team, posted to Discord: "on" or "off".
  ROUNDUPS: z.enum(['on', 'off']).default('on'),
  // The hour (UTC) on Mondays, and on the 1st of the month, when the roundups go out.
  ROUNDUP_HOUR: z.coerce.number().int().min(0).max(23).default(17),
};

export type SecretName = keyof typeof SECRET_FIELDS;
export const SECRET_NAMES = Object.keys(SECRET_FIELDS) as SecretName[];
// POLL_INTERVAL_SECONDS only applies to the Node version: on Cloudflare the check runs every minute.
export type SettingName = Exclude<keyof typeof SETTING_FIELDS, 'POLL_INTERVAL_SECONDS'>;
export const SETTING_NAMES = Object.keys(SETTING_FIELDS).filter((name) => name !== 'POLL_INTERVAL_SECONDS') as SettingName[];

type Thresholds = { SEEDING_THRESHOLD: number; LIVE_THRESHOLD: number; LOW_POP_THRESHOLD: number };
const thresholdChecks = <T extends z.ZodType<Thresholds>>(schema: T) =>
  schema
    .refine((env) => env.SEEDING_THRESHOLD < env.LIVE_THRESHOLD, {
      path: ['SEEDING_THRESHOLD'],
      message: 'must be below LIVE_THRESHOLD',
    })
    .refine((env) => env.LOW_POP_THRESHOLD <= env.LIVE_THRESHOLD, {
      path: ['LOW_POP_THRESHOLD'],
      message: 'must not be above LIVE_THRESHOLD',
    });

const SettingsSchema = thresholdChecks(z.object(SETTING_FIELDS));
const SecretsSchema = z.object(SECRET_FIELDS);
const EnvSchema = thresholdChecks(z.object({ ...SETTING_FIELDS, ...SECRET_FIELDS }));

// Seed on `seedDays` days within `windowDays` and get a reserved slot for `lengthDays`. A day counts when the player
// was on for more than `seedMinutes` while the server seeded, and it then went live.
export type VipRule = { seedDays: number; seedMinutes: number; windowDays: number; lengthDays: number };

export const VIP_WEEK_DAYS = 7;

// How the bot behaves, without anything secret: enough for the public stats and player pages.
export type Settings = {
  roleId: string | undefined;
  // Roles whose members may use the staff commands as well as Administrators.
  adminRoleIds: string[];
  inviteCode: string | undefined;
  siteUrl: string | undefined;
  pollIntervalMs: number;
  rules: AlertRules;
  // Players from which the server counts as busy, for the website.
  busyThreshold: number;
  // The score a faction needs to win.
  scoreToWin: number;
  // A player must seed for more than this for it to count as a successful seed, whether or not VIP is on.
  seedMinutes: number;
  vip: VipRule | null;
  // Null when MATCH_MESSAGES is off or there is no SITE_URL to point players at.
  matchMessages: MessageRule | null;
  // Null when SEEDING_MESSAGE_MINUTES is 0.
  seedingMessages: SeedingMessageRule | null;
};

export type Config = Settings & {
  rconUrl: string;
  rconPassword: string;
  webhookUrl: string;
  // Where the live server status is kept, when there is one.
  statusWebhookUrl: string | undefined;
  // When the roundups go out (an hour, UTC) and where. Null when ROUNDUPS is off.
  roundups: RoundupRule | null;
};

export type RoundupRule = { hour: number; webhookUrl: string };

type Values = Record<string, string | undefined>;

// A copied .env.example leaves optional keys blank; treat those as unset so defaults apply.
const present = (env: Values): Values => Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));

const problemsOf = (error: z.ZodError): string[] => error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);

const parse = <T>(schema: z.ZodType<T>, env: Values): T => {
  const parsed = schema.safeParse(present(env));
  if (!parsed.success) throw new Error(`Invalid configuration:\n${problemsOf(parsed.error).map((p) => `  ${p}`).join('\n')}`);
  return parsed.data;
};

const settingsOf = (e: z.output<typeof SettingsSchema>): Settings => ({
  roleId: e.DISCORD_ROLE_ID,
  adminRoleIds: e.DISCORD_ADMIN_ROLE_IDS ?? [],
  inviteCode: e.DISCORD_INVITE,
  siteUrl: e.SITE_URL,
  pollIntervalMs: e.POLL_INTERVAL_SECONDS * 1000,
  rules: {
    seeding: e.SEEDING_THRESHOLD,
    live: e.LIVE_THRESHOLD,
    lowPop: e.LOW_POP_THRESHOLD,
    cooldownMs: e.ALERT_COOLDOWN_MINUTES * 60_000,
    graceMs: e.DROP_GRACE_MINUTES * 60_000,
  },
  busyThreshold: e.BUSY_THRESHOLD,
  scoreToWin: e.SCORE_TO_WIN,
  seedMinutes: e.VIP_SEED_MINUTES,
  vip:
    e.VIP_SEED_DAYS > 0
      ? { seedDays: e.VIP_SEED_DAYS, seedMinutes: e.VIP_SEED_MINUTES, windowDays: VIP_WEEK_DAYS, lengthDays: VIP_WEEK_DAYS }
      : null,
  matchMessages:
    e.MATCH_MESSAGES === 'on' && e.SITE_URL ? { siteHost: new URL(e.SITE_URL).host, scoreToWin: e.SCORE_TO_WIN } : null,
  seedingMessages:
    e.SEEDING_MESSAGE_MINUTES > 0
      ? { everyMs: e.SEEDING_MESSAGE_MINUTES * 60_000, siteHost: e.SITE_URL ? new URL(e.SITE_URL).host : null }
      : null,
});

// Just the settings: secrets are not needed, or read.
export const loadSettings = (env: Values): Settings => settingsOf(parse(SettingsSchema, env));

export const loadConfig = (env: Values): Config => {
  const e = parse(EnvSchema, env);
  return {
    rconUrl: e.RCON_URL,
    rconPassword: e.RCON_PASSWORD,
    webhookUrl: e.DISCORD_WEBHOOK_URL,
    statusWebhookUrl: e.DISCORD_STATUS_WEBHOOK_URL,
    ...settingsOf(e),
    roundups:
      e.ROUNDUPS === 'on' ? { hour: e.ROUNDUP_HOUR, webhookUrl: e.DISCORD_ROUNDUP_WEBHOOK_URL ?? e.DISCORD_WEBHOOK_URL } : null,
  };
};

// What is wrong with these settings, as "NAME: problem" lines; none when they are fine.
export const settingsProblems = (settings: Values): string[] => {
  const parsed = SettingsSchema.safeParse(present(settings));
  return parsed.success ? [] : problemsOf(parsed.error);
};

// The same for secrets, which must be complete. The RCON address comes back tidied, as it would be used.
export const parseSecrets = (secrets: Values): { values: Partial<Record<SecretName, string>> } | { problems: string[] } => {
  const parsed = SecretsSchema.safeParse(present(secrets));
  return parsed.success ? { values: parsed.data } : { problems: problemsOf(parsed.error) };
};
