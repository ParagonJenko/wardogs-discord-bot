import { z } from 'zod';

// One bot, many communities. Each community (a tenant) has its own Discord server, its own game server and its own
// Durable Object, which holds everything the bot knows about it: settings, encrypted secrets, players and matches.
// The operator registers each community; until then a Discord server or website gets nothing from the bot.

// Lowercase letters, digits and dashes, 3 to 32 long: it appears in the stats URL, such as /t/gaminginit/api/stats.
export const TENANT_ID = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const DISCORD_ID = /^\d{17,20}$/;

// What the operator lets each community use, so no one community can run up the bill for everyone.
export type TenantLimits = {
  // GET /t/<id>/api/stats, /api/players and /api/player, for the community's website.
  publicApi: boolean;
  // While the server seeds, who is in game is read every 5 seconds (720 Durable Object alarms an hour) so the seeding
  // message goes out soon after someone joins. Off: only the check each minute sees joins.
  joinChecks: boolean;
  // Website reads the Durable Object answers each minute. Answers are cached for 30 seconds, so this only counts reads
  // the cache missed, such as many different player pages.
  publicReadsPerMinute: number;
  // Slash commands each minute, from everyone in the community's Discord server. Suggestions while staff type are
  // allowed five times as many.
  commandsPerMinute: number;
};

export const DEFAULT_LIMITS: TenantLimits = { publicApi: true, joinChecks: true, publicReadsPerMinute: 60, commandsPerMinute: 20 };

const LimitsSchema = z.object({
  publicApi: z.boolean(),
  joinChecks: z.boolean(),
  publicReadsPerMinute: z.number().int().min(1).max(600),
  commandsPerMinute: z.number().int().min(1).max(120),
});

export type TenantStatus = 'active' | 'suspended';

export type TenantRecord = {
  id: string;
  // The community's Discord server. Its slash commands only ever reach this tenant.
  guildId: string;
  name: string;
  // Suspended: no checks, no website stats, no commands. Nothing is deleted.
  status: TenantStatus;
  // The community this bot ran for before it served several. Its records stay in the Durable Object they were in.
  legacy?: true;
  limits: TenantLimits;
  createdAt: number;
  updatedAt: number;
};

const RecordSchema = z.object({
  id: z.string().regex(TENANT_ID),
  guildId: z.string().regex(DISCORD_ID),
  name: z.string(),
  status: z.enum(['active', 'suspended']),
  legacy: z.literal(true).optional(),
  limits: LimitsSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const parseTenantRecord = (raw: unknown): TenantRecord | null => {
  const parsed = RecordSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { legacy, ...rest } = parsed.data;
  return legacy ? { ...rest, legacy } : rest;
};

// The Durable Object a community's records live in. The community the bot ran for alone keeps its old one.
export const LEGACY_OBJECT = 'watcher';
export const objectName = (record: Pick<TenantRecord, 'id' | 'legacy'>): string => (record.legacy ? LEGACY_OBJECT : `tenant:${record.id}`);

// What the operator sends to add a community or change one.
const InputSchema = z
  .object({
    guildId: z.string().regex(DISCORD_ID, 'must be a Discord server ID'),
    name: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[^\x00-\x1f\x7f]+$/, 'must not contain control characters'),
    status: z.enum(['active', 'suspended']),
    legacy: z.boolean(),
    limits: LimitsSchema.partial().strict(),
  })
  .partial()
  .strict();

export type TenantInput = z.input<typeof InputSchema>;

// Adds or changes a community. Each Discord server belongs to one community at most, only one community can be the
// legacy one, and once a community exists whether it is legacy cannot change, as that would move it to other records.
export const applyTenantInput = (
  existing: TenantRecord[],
  id: string,
  input: unknown,
  now: number,
  maxTenants: number,
): { record: TenantRecord } | { error: string } => {
  if (!TENANT_ID.test(id)) return { error: 'The id must be 3 to 32 lowercase letters, digits and dashes, such as "gaminginit"' };
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') };
  const change = parsed.data;
  const current = existing.find((t) => t.id === id);
  const others = existing.filter((t) => t.id !== id);

  if (current === undefined && others.length >= maxTenants) {
    return { error: `This bot already has ${others.length} communities, its limit (MAX_TENANTS)` };
  }
  const guildId = change.guildId ?? current?.guildId;
  if (guildId === undefined) return { error: 'guildId is required for a new community' };
  const sharing = others.find((t) => t.guildId === guildId);
  if (sharing !== undefined) return { error: `That Discord server already belongs to "${sharing.id}"` };
  if (current !== undefined && change.legacy !== undefined && change.legacy !== (current.legacy === true)) {
    return { error: 'Whether a community is the legacy one cannot change once it exists' };
  }
  const legacy = current === undefined ? change.legacy === true : current.legacy === true;
  if (legacy && others.some((t) => t.legacy)) return { error: 'Another community is already the legacy one' };

  const record: TenantRecord = {
    id,
    guildId,
    name: change.name ?? current?.name ?? id,
    status: change.status ?? current?.status ?? 'active',
    ...(legacy ? { legacy: true as const } : {}),
    limits: { ...DEFAULT_LIMITS, ...current?.limits, ...change.limits },
    createdAt: current?.createdAt ?? now,
    // Always later than the last change, even within the same millisecond: the newest record wins (see Watcher.adopt).
    updatedAt: Math.max(now, (current?.updatedAt ?? 0) + 1),
  };
  return { record };
};

// MAX_TENANTS: how many communities this bot will take. Each one's check is a Durable Object call from the cron, so
// this also keeps the cron within Cloudflare's subrequest limit (50 on the free plan).
export const maxTenants = (value: unknown): number => {
  const n = Number(value ?? '');
  return Number.isInteger(n) && n >= 1 && n <= 500 ? n : 25;
};

// The game server's RCON address comes from a community, and the bot opens connections to it, so it must not be
// usable to reach anything else: no private, loopback, link-local or multicast addresses, no local names, and no
// well-known ports other than HTTP and HTTPS. Null when the address is fine.
export const rconAddressProblem = (address: string): string | null => {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return 'is not an address';
  }
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  if (port !== 80 && port !== 443 && port < 1024) return 'must use port 80, 443 or 1024 and above';
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa|intranet|corp)$/.test(host) || (!host.includes('.') && !host.includes(':'))) {
    return 'must be a public address, not a local name';
  }
  if (host.includes(':')) return privateIpv6(host) ? 'must be a public address' : null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return privateIpv4(host) ? 'must be a public address' : null;
  return null;
};

const privateIpv4 = (host: string): boolean => {
  const [a = 0, b = 0, c = 0] = host.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
};

const privateIpv6 = (host: string): boolean => {
  if (host === '::' || host === '::1') return true;
  // IPv4 written as IPv6, such as ::ffff:10.0.0.1 or ::ffff:a00:1.
  if (host.startsWith('::ffff:')) return true;
  // Unique local (fc00::/7), link-local (fe80::/10) and multicast (ff00::/8).
  return /^(f[cd]|fe[89ab]|ff)[0-9a-f]{0,2}:/.test(host);
};

// Counts uses in the current minute; false once there have been `limit` already.
export class MinuteBudget {
  private windowStart = 0;
  private used = 0;

  take(limit: number, now: number): boolean {
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.used = 0;
    }
    this.used += 1;
    return this.used <= limit;
  }
}

// A game server that stops answering is checked less often, so a community whose server is gone for good costs next
// to nothing: every minute for the first 15 failed checks, then every 5 minutes for a few hours, then every 15.
export type Health = { failures: number; nextCheckAt: number };

export const parseHealth = (raw: unknown): Health => {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    failures: typeof r['failures'] === 'number' ? r['failures'] : 0,
    nextCheckAt: typeof r['nextCheckAt'] === 'number' ? r['nextCheckAt'] : 0,
  };
};

export const afterCheck = (health: Health, reached: boolean, now: number): Health => {
  if (reached) return { failures: 0, nextCheckAt: 0 };
  const failures = health.failures + 1;
  const waitMs = failures < 15 ? 0 : failures < 60 ? 5 * 60_000 : 15 * 60_000;
  // A little early, so a check a few seconds late is not put off a whole extra interval.
  return { failures, nextCheckAt: waitMs === 0 ? 0 : now + waitMs - 10_000 };
};
