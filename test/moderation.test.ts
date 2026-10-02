import { describe, expect, it } from 'vitest';
import {
  appendMod,
  BAN_LENGTHS,
  banReason,
  expiredBans,
  isBotBan,
  modLogKey,
  parseBanBook,
  parseModLog,
  waitingBansFor,
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

  it('finds the waiting bans of players now in game, unless they ran out first', () => {
    const CY = '76561198000000003';
    const book = parseBanBook({
      [ASH]: { name: 'Ash', until: 100, reason: 'x', serverReason: 'x (ends …)', by: '1', at: 0, waiting: true },
      [BO]: { name: 'Bo', until: null, reason: 'y', serverReason: 'y', by: '1', at: 0, waiting: true },
      [CY]: { name: 'Cy', until: null, reason: 'z', serverReason: 'z', by: '1', at: 0 },
    });

    expect(book[BO]?.waiting).toBe(true);
    expect(waitingBansFor(book, [ASH, BO, CY], 99)).toEqual([ASH, BO]);
    expect(waitingBansFor(book, [ASH, BO, CY], 100)).toEqual([BO]);
    expect(waitingBansFor(book, [CY], 0)).toEqual([]);
  });

  it('offers lengths from an hour to permanent', () => {
    expect(BAN_LENGTHS.map((l) => l.value)).toEqual(['1h', '1d', '3d', '7d', '30d', 'permanent']);
    expect(BAN_LENGTHS.at(-1)?.ms).toBeNull();
  });
});
