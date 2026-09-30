import { describe, expect, it } from 'vitest';
import { appendMod, BAN_LENGTHS, expiredBans, modLogKey, parseBanBook, parseModLog, type ModEntry } from '../src/moderation.ts';

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
      [ASH]: { name: 'Ash', until: 100, reason: 'x', by: '1', at: 0 },
      [BO]: { name: 'Bo', until: null, reason: 'y', by: '1', at: 0 },
    });

    expect(expiredBans(book, 99)).toEqual([]);
    expect(expiredBans(book, 100)).toEqual([ASH]);
    expect(expiredBans(book, Number.MAX_SAFE_INTEGER)).toEqual([ASH]);
    expect(parseBanBook('nonsense')).toEqual({});
  });

  it('offers lengths from an hour to permanent', () => {
    expect(BAN_LENGTHS.map((l) => l.value)).toEqual(['1h', '1d', '3d', '7d', '30d', 'permanent']);
    expect(BAN_LENGTHS.at(-1)?.ms).toBeNull();
  });
});
