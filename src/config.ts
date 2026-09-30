import { z } from 'zod';
import type { AlertRules } from './alerts.ts';

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
    SEEDING_THRESHOLD: count(1),
    LIVE_THRESHOLD: count(20),
    LOW_POP_THRESHOLD: count(20),
    POLL_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(60),
    ALERT_COOLDOWN_MINUTES: z.coerce.number().int().min(0).default(10),
  })
  .refine((env) => env.SEEDING_THRESHOLD < env.LIVE_THRESHOLD, {
    path: ['SEEDING_THRESHOLD'],
    message: 'must be below LIVE_THRESHOLD',
  })
  .refine((env) => env.LOW_POP_THRESHOLD <= env.LIVE_THRESHOLD, {
    path: ['LOW_POP_THRESHOLD'],
    message: 'must not be above LIVE_THRESHOLD',
  });

export type Config = {
  rconUrl: string;
  rconPassword: string;
  webhookUrl: string;
  roleId: string | undefined;
  inviteCode: string | undefined;
  pollIntervalMs: number;
  rules: AlertRules;
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
    pollIntervalMs: e.POLL_INTERVAL_SECONDS * 1000,
    rules: {
      seeding: e.SEEDING_THRESHOLD,
      live: e.LIVE_THRESHOLD,
      lowPop: e.LOW_POP_THRESHOLD,
      cooldownMs: e.ALERT_COOLDOWN_MINUTES * 60_000,
    },
  };
};
