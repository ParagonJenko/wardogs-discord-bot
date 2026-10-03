import { describe, expect, it } from 'vitest';
import {
  afterCheck,
  applyTenantInput,
  DEFAULT_LIMITS,
  maxTenants,
  MinuteBudget,
  objectName,
  parseHealth,
  parseTenantRecord,
  rconAddressProblem,
  type TenantRecord,
} from '../src/tenants.ts';

const NOW = 1_790_000_000_000;
const GUILD_A = '1552990539455144086';
const GUILD_B = '1552990539455144087';

const tenant = (id: string, guildId: string, extra: Partial<TenantRecord> = {}): TenantRecord => ({
  id,
  guildId,
  name: id,
  status: 'active',
  limits: DEFAULT_LIMITS,
  createdAt: NOW - 1000,
  updatedAt: NOW - 1000,
  ...extra,
});

describe('applyTenantInput', () => {
  it('adds a community with the default limits', () => {
    expect(applyTenantInput([], 'alpha', { guildId: GUILD_A, name: 'Alpha Squad' }, NOW, 25)).toEqual({
      record: { id: 'alpha', guildId: GUILD_A, name: 'Alpha Squad', status: 'active', limits: DEFAULT_LIMITS, createdAt: NOW, updatedAt: NOW },
    });
  });

  it('changes only what is sent, keeping when it was added', () => {
    const result = applyTenantInput([tenant('alpha', GUILD_A)], 'alpha', { status: 'suspended', limits: { joinChecks: false } }, NOW, 25);

    expect(result).toEqual({
      record: { ...tenant('alpha', GUILD_A), status: 'suspended', limits: { ...DEFAULT_LIMITS, joinChecks: false }, updatedAt: NOW },
    });
  });

  it('refuses a bad id, a Discord server another community has, and a new community without one', () => {
    expect(applyTenantInput([], 'Alpha!', { guildId: GUILD_A }, NOW, 25)).toMatchObject({ error: expect.stringMatching(/lowercase/) });
    expect(applyTenantInput([], 'ab', { guildId: GUILD_A }, NOW, 25)).toMatchObject({ error: expect.any(String) });
    expect(applyTenantInput([tenant('alpha', GUILD_A)], 'beta', { guildId: GUILD_A }, NOW, 25)).toEqual({
      error: 'That Discord server already belongs to "alpha"',
    });
    expect(applyTenantInput([], 'beta', { name: 'Beta' }, NOW, 25)).toEqual({ error: 'guildId is required for a new community' });
  });

  it('refuses unknown fields and limits beyond their bounds', () => {
    expect(applyTenantInput([], 'beta', { guildId: GUILD_B, secret: 'x' }, NOW, 25)).toMatchObject({ error: expect.any(String) });
    expect(applyTenantInput([], 'beta', { guildId: GUILD_B, limits: { publicReadsPerMinute: 100_000 } }, NOW, 25)).toMatchObject({
      error: expect.stringMatching(/publicReadsPerMinute/),
    });
  });

  it('stops at MAX_TENANTS, but still lets existing communities change', () => {
    const full = [tenant('alpha', GUILD_A)];
    expect(applyTenantInput(full, 'beta', { guildId: GUILD_B }, NOW, 1)).toEqual({
      error: 'This bot already has 1 communities, its limit (MAX_TENANTS)',
    });
    expect(applyTenantInput(full, 'alpha', { name: 'A' }, NOW, 1)).toMatchObject({ record: { name: 'A' } });
  });

  it('allows one legacy community, which can never stop being one', () => {
    const legacy = tenant('alpha', GUILD_A, { legacy: true });
    expect(applyTenantInput([legacy], 'beta', { guildId: GUILD_B, legacy: true }, NOW, 25)).toEqual({
      error: 'Another community is already the legacy one',
    });
    expect(applyTenantInput([legacy], 'alpha', { legacy: false }, NOW, 25)).toMatchObject({ error: expect.stringMatching(/cannot change/) });
    expect(applyTenantInput([tenant('beta', GUILD_B)], 'beta', { legacy: true }, NOW, 25)).toMatchObject({ error: expect.stringMatching(/cannot change/) });
  });
});

describe('objectName', () => {
  it("gives every community its own Durable Object, and the legacy one the bot's old one", () => {
    expect(objectName({ id: 'alpha' })).toBe('tenant:alpha');
    expect(objectName({ id: 'watcher' })).toBe('tenant:watcher');
    expect(objectName({ id: 'alpha', legacy: true })).toBe('watcher');
  });
});

describe('parseTenantRecord', () => {
  it('reads a stored record, and nothing else', () => {
    expect(parseTenantRecord(tenant('alpha', GUILD_A, { legacy: true }))).toEqual(tenant('alpha', GUILD_A, { legacy: true }));
    expect(parseTenantRecord({ ...tenant('alpha', GUILD_A), id: '../x' })).toBeNull();
    expect(parseTenantRecord(null)).toBeNull();
  });
});

describe('maxTenants', () => {
  it('defaults to 25', () => {
    expect(maxTenants(undefined)).toBe(25);
    expect(maxTenants('nope')).toBe(25);
    expect(maxTenants('40')).toBe(40);
  });
});

describe('rconAddressProblem', () => {
  it('accepts public addresses and names on the usual ports', () => {
    for (const ok of ['http://203.0.113.10:7776', 'https://rcon.example.com', 'http://8.8.8.8:80', 'http://[2001:db8::1]:7776']) {
      expect(rconAddressProblem(ok)).toBeNull();
    }
  });

  it('refuses private, loopback, link-local and other non-public addresses', () => {
    for (const bad of [
      'http://127.0.0.1:7776',
      'http://10.1.2.3:7776',
      'http://172.16.0.1:7776',
      'http://192.168.1.10:7776',
      'http://169.254.169.254:7776',
      'http://100.64.0.1:7776',
      'http://0.0.0.0:7776',
      'http://224.0.0.1:7776',
      'http://2130706433:7776',
      'http://0x7f000001:7776',
      'http://[::1]:7776',
      'http://[fd00::1]:7776',
      'http://[fe80::1]:7776',
      'http://[::ffff:10.0.0.1]:7776',
    ]) {
      expect(rconAddressProblem(bad), bad).toBe('must be a public address');
    }
  });

  it('refuses local names and well-known ports', () => {
    expect(rconAddressProblem('http://localhost:7776')).toMatch(/local name/);
    expect(rconAddressProblem('http://db.internal:7776')).toMatch(/local name/);
    expect(rconAddressProblem('http://router:7776')).toMatch(/local name/);
    expect(rconAddressProblem('http://203.0.113.10:25')).toMatch(/port/);
    expect(rconAddressProblem('http://203.0.113.10:22')).toMatch(/port/);
  });
});

describe('MinuteBudget', () => {
  it('allows the limit each minute', () => {
    const budget = new MinuteBudget();
    expect([1, 2, 3].map(() => budget.take(2, NOW))).toEqual([true, true, false]);
    expect(budget.take(2, NOW + 59_999)).toBe(false);
    expect(budget.take(2, NOW + 60_000)).toBe(true);
  });
});

describe('afterCheck', () => {
  it('checks every minute, then less often while the server stays unreachable, and every minute again once it answers', () => {
    let health = parseHealth(undefined);
    for (let i = 0; i < 14; i++) health = afterCheck(health, false, NOW);
    expect(health).toEqual({ failures: 14, nextCheckAt: 0 });
    health = afterCheck(health, false, NOW);
    expect(health).toEqual({ failures: 15, nextCheckAt: NOW + 5 * 60_000 - 10_000 });
    health = afterCheck({ failures: 59, nextCheckAt: 0 }, false, NOW);
    expect(health).toEqual({ failures: 60, nextCheckAt: NOW + 15 * 60_000 - 10_000 });
    expect(afterCheck(health, true, NOW)).toEqual({ failures: 0, nextCheckAt: 0 });
  });
});
