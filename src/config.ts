import { z } from 'zod';
import type { AlertRules } from './alerts.ts';

const numericId = z.string().regex(/^\d+$/, 'must be a numeric ID');
const count = (fallback: number) => z.coerce.number().int().min(1).default(fallback);

const EnvSchema = z
  .object({
    BATTLEMETRICS_SERVER_ID: numericId,
    DISCORD_WEBHOOK_URL: z
      .string()
      .regex(/^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/, 'must be a Discord webhook URL'),
    DISCORD_ROLE_ID: numericId.optional(),
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
  serverId: string;
  webhookUrl: string;
  roleId: string | undefined;
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
    serverId: e.BATTLEMETRICS_SERVER_ID,
    webhookUrl: e.DISCORD_WEBHOOK_URL,
    roleId: e.DISCORD_ROLE_ID,
    pollIntervalMs: e.POLL_INTERVAL_SECONDS * 1000,
    rules: {
      seeding: e.SEEDING_THRESHOLD,
      live: e.LIVE_THRESHOLD,
      lowPop: e.LOW_POP_THRESHOLD,
      cooldownMs: e.ALERT_COOLDOWN_MINUTES * 60_000,
    },
  };
};
