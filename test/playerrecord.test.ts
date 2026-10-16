import { describe, expect, it } from 'vitest';
import { buildAdminPlayerRecord } from '../src/admin.ts';
import type { PlayerProfile } from '../src/discord.ts';
import { emptyGriefDay, playerGrief, recordGrief } from '../src/griefing.ts';
import { banReason } from '../src/moderation.ts';
import { isBanned, playerBan, playerVip } from '../src/playerrecord.ts';
import type { PlayerRecord } from '../src/staff.ts';
import type { FeedEvent } from '../src/weapons.ts';

const NOW = Date.UTC(2026, 9, 16, 12);
const DAY = 24 * 60 * 60_000;
const ID = '76561198000000001';
const BO = '76561198000000002';
const record: PlayerRecord = { name: 'Ash', totals: null, vip: null, vipBlockedUntil: null, staffSpot: false, privateProfile: false, log: [], ban: null, grief: null };
const profile: PlayerProfile = { steamId: ID, name: 'Ash', record, online: null, reserved: false, serverBan: null, days: 90, now: NOW };
const grant = { name: 'Ash', grantedAt: NOW - DAY, expiresAt: NOW + 6 * DAY };

describe('playerVip', () => {
  it('trusts the whitelist when it can be read', () => {
    expect(playerVip(profile)).toEqual({ kind: 'none', checked: true, blockedUntil: null });
    expect(playerVip({ ...profile, reserved: true })).toEqual({ kind: 'permanent', checked: true, blockedUntil: null });
    expect(playerVip({ ...profile, reserved: true, record: { ...record, vip: grant } })).toEqual({ kind: 'bot', until: grant.expiresAt, checked: true, blockedUntil: null });
    // VIP the bot still has a record of, but no longer on the whitelist.
    expect(playerVip({ ...profile, record: { ...record, vip: grant } })).toMatchObject({ kind: 'none' });
    expect(playerVip({ ...profile, reserved: true, record: { ...record, staffSpot: true } })).toMatchObject({ kind: 'staff', pending: false });
    expect(playerVip({ ...profile, record: { ...record, staffSpot: true } })).toMatchObject({ kind: 'staff', pending: true });
  });

  it('falls back on the bot’s records when the whitelist can’t be read, and says when VIP is held back', () => {
    expect(playerVip({ ...profile, reserved: null })).toEqual({ kind: 'unknown', checked: false, blockedUntil: null });
    expect(playerVip({ ...profile, reserved: null, record: { ...record, vip: grant } })).toMatchObject({ kind: 'bot', checked: false });
    expect(playerVip({ ...profile, reserved: null, record: { ...record, staffSpot: true } })).toMatchObject({ kind: 'staff', checked: false });
    expect(playerVip({ ...profile, record: { ...record, vipBlockedUntil: NOW + DAY } }).blockedUntil).toBe(NOW + DAY);
    expect(playerVip({ ...profile, record: { ...record, vipBlockedUntil: NOW - 1 } }).blockedUntil).toBeNull();
  });
});

describe('playerBan', () => {
  const ban = { name: 'Ash', until: NOW + DAY, reason: 'Cheating', serverReason: banReason('Cheating', NOW + DAY), by: '42', at: NOW };
  const bots = { kind: 'bot', reason: 'Cheating', by: '42', at: NOW, until: NOW + DAY };

  it('trusts the server’s ban list when it can be read', () => {
    const onServer = { steamId: ID, reason: ban.serverReason, bannedBy: 'rcon' };
    expect(playerBan({ ...profile, record: { ...record, ban }, serverBan: onServer })).toEqual({ ...bots, waiting: false, checked: true });
    // Lifted by hand.
    expect(playerBan({ ...profile, record: { ...record, ban } })).toEqual({ kind: 'none', checked: true });
    // Replaced by hand, or made outside the bot.
    expect(playerBan({ ...profile, record: { ...record, ban }, serverBan: { steamId: ID, reason: 'Abuse', bannedBy: 'console' } })).toEqual({
      kind: 'server',
      reason: 'Abuse',
      checked: true,
    });
    expect(playerBan({ ...profile, serverBan: { steamId: ID, reason: null, bannedBy: 'config' } })).toEqual({ kind: 'server', reason: null, checked: true });
  });

  it('says when a ban waits for them to join, and falls back on the bot’s records', () => {
    expect(playerBan({ ...profile, record: { ...record, ban: { ...ban, waiting: true } } })).toEqual({ ...bots, waiting: true, checked: true });
    expect(playerBan({ ...profile, record: { ...record, ban }, serverBan: undefined })).toEqual({ ...bots, waiting: false, checked: false });
    expect(playerBan({ ...profile, serverBan: undefined })).toEqual({ kind: 'unknown', checked: false });
  });

  it('says whether they are banned', () => {
    expect(isBanned(profile)).toBe(false);
    expect(isBanned({ ...profile, serverBan: undefined })).toBe(false);
    expect(isBanned({ ...profile, record: { ...record, ban: { ...ban, waiting: true } } })).toBe(true);
    expect(isBanned({ ...profile, serverBan: { steamId: ID, reason: null, bannedBy: 'config' } })).toBe(true);
  });
});

const death = (killer: string, victim: string, n: number): FeedEvent => ({
  eventId: `e${n}`,
  time: 100,
  matchId: 'm1',
  map: 'Europe',
  victimSteamId: victim,
  victimName: victim === ID ? 'Ash' : 'Bo',
  killerSteamId: killer,
  killerName: killer === ID ? 'Ash' : 'Bo',
  cause: 'Id.Item.AK74M',
  distance: 12.34,
  headshot: false,
  tags: [],
});

describe('buildAdminPlayerRecord', () => {
  it('gives what /player says as facts, with no Discord markup', () => {
    const steam = {
      at: NOW - 3_600_000,
      found: true,
      vacBans: 1,
      gameBans: 0,
      lastBanAt: NOW - 40 * DAY,
      communityBanned: false,
      tradeBan: 'none' as const,
      public: false,
      setUp: true,
      createdAt: null,
    };
    const side = () => 'Valkyra';
    // Two checks' kills, a minute and half a minute ago.
    const first = recordGrief(emptyGriefDay(), [death(ID, BO, 1)], NOW - 60_000, side).day;
    const day = recordGrief(first, [death(ID, BO, 2)], NOW - 30_000, side).day;
    const log = [
      { action: 'warn' as const, at: NOW - 2 * DAY, by: '42', byName: 'Sarge', name: 'Ash', reason: 'Team killing' },
      { action: 'kick' as const, at: NOW - DAY, by: '42', byName: 'Sarge', name: 'Ash', reason: 'Again' },
    ];
    const full: PlayerProfile = {
      ...profile,
      record: {
        ...record,
        totals: { name: 'Ash', seedingMinutes: 30, liveMinutes: 90, seedDays: 1, matches: 4, kills: 50, deaths: 40 },
        privateProfile: true,
        log,
        grief: playerGrief(day, ID),
      },
      online: { steamId: ID, name: 'Ash', faction: 'Valkyra', kills: 3, deaths: 1 },
      reserved: true,
      steam,
    };

    const out = buildAdminPlayerRecord(full);

    expect(out).toMatchObject({
      steamId: ID,
      name: 'Ash',
      inGame: { faction: 'Valkyra', kills: 3, deaths: 1 },
      privateProfile: true,
      days: 90,
      totals: { minutes: 120, seedingMinutes: 30, seedDays: 1, matches: 4, kills: 50, deaths: 40 },
      steam: { status: 'found', risk: 'high', score: 5, facts: ['1 VAC ban, 40 days ago', 'Account age hidden', 'Private profile'], checkedAt: NOW - 3_600_000 },
      vip: { kind: 'permanent', checked: true },
      ban: { kind: 'none', checked: true },
    });
    // Newest first, without the player's name.
    expect(out.log).toEqual([
      { action: 'kick', at: NOW - DAY, by: '42', byName: 'Sarge', reason: 'Again' },
      { action: 'warn', at: NOW - 2 * DAY, by: '42', byName: 'Sarge', reason: 'Team killing' },
    ]);
    expect(out.grief).toMatchObject({ teamKills: 2, victims: [{ steamId: BO, name: 'Bo', kills: 2 }] });
    expect(out.grief?.incidents.map((i) => [i.at, i.player.name, i.victim?.name, i.weapon])).toEqual([
      [NOW - 30_000, 'Ash', 'Bo', 'AK74'],
      [NOW - 60_000, 'Ash', 'Bo', 'AK74'],
    ]);
    expect(JSON.stringify(out)).not.toMatch(/<t:|<@|\*\*|🔨|🎖️/u);
  });

  it('says when Steam is off, could not be asked, or has no such account, and when they were never seen', () => {
    expect(buildAdminPlayerRecord(profile)).toMatchObject({ name: 'Ash', inGame: null, totals: null, grief: null, steam: { status: 'off' }, log: [] });
    expect(buildAdminPlayerRecord({ ...profile, steam: 'failed' }).steam).toEqual({ status: 'failed' });
    const missing = { at: NOW, found: false, vacBans: 0, gameBans: 0, lastBanAt: null, communityBanned: false, tradeBan: 'none' as const, public: false, setUp: false, createdAt: null };
    expect(buildAdminPlayerRecord({ ...profile, steam: missing }).steam).toEqual({ status: 'missing', checkedAt: NOW });
  });
});
