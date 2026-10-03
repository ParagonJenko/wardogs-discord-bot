import { describe, expect, it } from 'vitest';
import {
  appendMod,
  BAN_LENGTHS,
  banChanges,
  parseServerBans,
  banReason,
  expiredBans,
  isBotBan,
  modLogKey,
  parseBanBook,
  joinWork,
  parseModLog,
  type ModEntry,
} from '../src/moderation.ts';

const ASH = '76561198000000001';
const BO = '76561198000000002';

describe('moderation log', () => {
  it('reads what was saved, and nothing from anything else', () => {
    const entry: ModEntry = { action: 'kick', at: 5, by: '123', reason: 'spawn camping' };

    expect(modLogKey(ASH)).toBe(`mod:${ASH}`);
    expect(parseModLog([entry])).toEqual([entry]);
    expect(parseModLog(undefined)).toEqual([]);
    expect(parseModLog([{ action: 'nuke', at: 1, by: 'x' }])).toEqual([]);
  });

  it('keeps the newest 50 entries', () => {
    const log = Array.from({ length: 50 }, (_, at): ModEntry => ({ action: 'warn', at, by: '123' }));

    const next = appendMod(log, { action: 'ban', at: 50, by: '123' });

    expect(next).toHaveLength(50);
    expect(next[0]?.at).toBe(1);
    expect(next.at(-1)).toEqual({ action: 'ban', at: 50, by: '123' });
  });
});

describe('ban book', () => {
  it('finds the timed bans that have run out, never a permanent one', () => {
    const book = parseBanBook({
      [ASH]: { name: 'Ash', until: 100, reason: 'x', serverReason: 'x (ends …)', by: '1', at: 0 },
      [BO]: { name: 'Bo', until: null, reason: 'y', serverReason: 'y', by: '1', at: 0 },
    });

    expect(expiredBans(book, 99)).toEqual([]);
    expect(expiredBans(book, 100)).toEqual([ASH]);
    expect(expiredBans(book, Number.MAX_SAFE_INTEGER)).toEqual([ASH]);
    expect(parseBanBook('nonsense')).toEqual({});
  });

  it('writes when a timed ban ends into its reason, and knows its own bans by that reason', () => {
    const until = Date.UTC(2026, 9, 7, 12, 30);
    const ban = { name: 'Ash', until, reason: 'Cheating', serverReason: banReason('Cheating', until), by: '42', at: 0 };

    expect(banReason('Cheating', until)).toBe('Cheating (ends 2026-10-07 12:30 UTC)');
    expect(banReason('Cheating', null)).toBe('Cheating');
    expect(isBotBan('Cheating (ends 2026-10-07 12:30 UTC)', ban)).toBe(true);
    expect(isBotBan('Cheating', ban)).toBe(false);
    expect(isBotBan(null, ban)).toBe(false);
  });

  it('bans players in game whose ban waited for them, and kicks them until they have gone', () => {
    const CY = '76561198000000003';
    const DI = '76561198000000004';
    const book = parseBanBook({
      [ASH]: { name: 'Ash', until: 100, reason: 'x', serverReason: 'x (ends …)', by: '1', at: 0, waiting: true },
      [BO]: { name: 'Bo', until: null, reason: 'y', serverReason: 'y', by: '1', at: 0, waiting: true },
      [CY]: { name: 'Cy', until: null, reason: 'z', serverReason: 'z', by: '1', at: 0, kicking: true },
      [DI]: { name: 'Di', until: null, reason: 'w', serverReason: 'w', by: '1', at: 0 },
    });

    expect([book[BO]?.waiting, book[CY]?.kicking]).toEqual([true, true]);
    expect(joinWork(book, [ASH, BO, CY, DI], 99)).toEqual({ ban: [ASH, BO], kick: [CY], gone: [] });
    expect(joinWork(book, [ASH, BO, CY, DI], 100)).toEqual({ ban: [BO], kick: [CY], gone: [] });
    expect(joinWork(book, [DI], 0)).toEqual({ ban: [], kick: [], gone: [CY] });
  });

  it('offers lengths from an hour to permanent', () => {
    expect(BAN_LENGTHS.map((l) => l.value)).toEqual(['1h', '1d', '3d', '7d', '30d', 'permanent']);
    expect(BAN_LENGTHS.at(-1)?.ms).toBeNull();
  });
});

describe("the server's ban list", () => {
  it('reads the saved list, and null before the bot first read one', () => {
    const saved = { [ASH]: { reason: 'Cheating', bannedBy: null } };

    expect(parseServerBans(saved)).toEqual(saved);
    expect(parseServerBans(undefined)).toBeNull();
    expect(parseServerBans({ [ASH]: { reason: 1 } })).toBeNull();
  });

  it('finds the bans made and lifted since the last check', () => {
    const before = { [ASH]: { reason: 'Cheating', bannedBy: null } };

    expect(banChanges(before, [{ steamId: BO, reason: 'Racism', bannedBy: 'Admin' }])).toEqual({
      added: [{ steamId: BO, ban: { reason: 'Racism', bannedBy: 'Admin' } }],
      lifted: [{ steamId: ASH, ban: { reason: 'Cheating', bannedBy: null } }],
    });
    expect(banChanges(before, [{ steamId: ASH, reason: 'Changed', bannedBy: null }])).toEqual({ added: [], lifted: [] });
  });
});
