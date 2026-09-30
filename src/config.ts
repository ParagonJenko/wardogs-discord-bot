import { z } from 'zod';
import type { AlertRules } from './alerts.ts';
import type { MessageRule } from './messages.ts';

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
const count = (fallback: number) => z.coerce.number().int().min(1).default(fallback);
// An invite code, or a discord.gg / discord.com/invite link; only the code is kept.
const invite = z
  .string()
  .regex(
    /^(?:https?:\/\/)?(?:www\.)?(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)?[\w-]+\/?$/,
    'must be an invite link like https://discord.gg/abc123',
  )
  .transform((value) => value.replace(/\/$/, '').split('/').pop() ?? value);

const EnvSchema = z
  .object({
    RCON_URL: rconUrl,
    RCON_PASSWORD: z.string().min(1),
    DISCORD_WEBHOOK_URL: z
      .string()
      .regex(/^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/, 'must be a Discord webhook URL'),
    DISCORD_ROLE_ID: numericId.optional(),
    DISCORD_INVITE: invite.optional(),
    // The community website; Discord posts link to it.
    SITE_URL: z.url({ protocol: /^https?$/ }).optional(),
    SEEDING_THRESHOLD: count(1),
    LIVE_THRESHOLD: count(20),
    LOW_POP_THRESHOLD: count(20),
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
    // The score a faction needs to win, for "halfway" and "nearly there" messages.
    SCORE_TO_WIN: z.coerce.number().int().min(2).default(100),
  })
  .refine((env) => env.SEEDING_THRESHOLD < env.LIVE_THRESHOLD, {
    path: ['SEEDING_THRESHOLD'],
    message: 'must be below LIVE_THRESHOLD',
  })
  .refine((env) => env.LOW_POP_THRESHOLD <= env.LIVE_THRESHOLD, {
    path: ['LOW_POP_THRESHOLD'],
    message: 'must not be above LIVE_THRESHOLD',
  });

// Seed on `seedDays` days within `windowDays` and get a reserved slot for `lengthDays`. A day counts when the player
// was on for more than `seedMinutes` while the server seeded, and it then went live.
export type VipRule = { seedDays: number; seedMinutes: number; windowDays: number; lengthDays: number };

export const VIP_WEEK_DAYS = 7;

export type Config = {
  rconUrl: string;
  rconPassword: string;
  webhookUrl: string;
  roleId: string | undefined;
  inviteCode: string | undefined;
  siteUrl: string | undefined;
  pollIntervalMs: number;
  rules: AlertRules;
  // A player must seed for more than this for it to count as a successful seed, whether or not VIP is on.
  seedMinutes: number;
  vip: VipRule | null;
  // Null when MATCH_MESSAGES is off or there is no SITE_URL to point players at.
  matchMessages: MessageRule | null;
};

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
    roleId: e.DISCORD_ROLE_ID,
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
    seedMinutes: e.VIP_SEED_MINUTES,
    vip:
      e.VIP_SEED_DAYS > 0
        ? { seedDays: e.VIP_SEED_DAYS, seedMinutes: e.VIP_SEED_MINUTES, windowDays: VIP_WEEK_DAYS, lengthDays: VIP_WEEK_DAYS }
        : null,
    matchMessages:
      e.MATCH_MESSAGES === 'on' && e.SITE_URL
        ? { siteHost: new URL(e.SITE_URL).host, scoreToWin: e.SCORE_TO_WIN }
        : null,
  };
};
