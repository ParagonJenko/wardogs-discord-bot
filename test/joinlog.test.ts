import { describe, expect, it } from 'vitest';
import { JOIN_GAP_MS, JOINS_BYTES, JOINS_KEPT, minutesOn, parseJoinLog, recordJoins, type JoinLog } from '../src/joinlog.ts';
import type { Player } from '../src/rcon.ts';

const ASH = '76561198000000001';
const BO = '76561198000000002';
const CY = '76561198000000003';
const NOW = Date.UTC(2026, 9, 5, 19);
const MINUTE = 60_000;

const player = (steamId: string, name: string): Player => ({ steamId, name, kills: null, deaths: null });

describe('recordJoins', () => {
  it('starts with everyone in game and no joins, as it cannot tell when they came on', () => {
    expect(recordJoins(null, [player(ASH, 'Ash'), player(BO, 'Bo')], 2, NOW, null)).toEqual({
      inGame: { [ASH]: { name: 'Ash', since: null }, [BO]: { name: 'Bo', since: null } },
      events: [],
    });
  });

  it('notes who joined and who left since the check before', () => {
    const log = recordJoins(null, [player(ASH, 'Ash'), player(BO, 'Bo')], 2, NOW, null);
    const next = recordJoins(log, [player(BO, 'Bo'), player(CY, 'Cy')], 2, NOW + MINUTE, NOW);
    expect(next.events).toEqual([
      { at: NOW + MINUTE, kind: 'left', steamId: ASH, name: 'Ash', joinedAt: null },
      { at: NOW + MINUTE, kind: 'joined', steamId: CY, name: 'Cy' },
    ]);
    expect(next.inGame).toEqual({ [BO]: { name: 'Bo', since: null }, [CY]: { name: 'Cy', since: NOW + MINUTE } });
  });

  it('gives back the same log when nobody joined or left, so there is nothing to write', () => {
    const log = recordJoins(null, [player(ASH, 'Ash')], 1, NOW, null);
    expect(recordJoins(log, [player(ASH, 'Ash')], 1, NOW + MINUTE, NOW)).toBe(log);
  });

  it('remembers when someone joined, for how long they were on when they leave', () => {
    let log = recordJoins(null, [], 0, NOW, null);
    log = recordJoins(log, [player(ASH, 'Ash')], 1, NOW + MINUTE, NOW);
    log = recordJoins(log, [], 0, NOW + 46 * MINUTE, NOW + 45 * MINUTE);
    const left = log.events.at(-1);
    expect(left).toEqual({ at: NOW + 46 * MINUTE, kind: 'left', steamId: ASH, name: 'Ash', joinedAt: NOW + MINUTE });
    expect(left && minutesOn(left)).toBe(45);
  });

  it('says since when after the bot could not read the server, and counts time on to the last check that saw them', () => {
    let log = recordJoins(null, [], 0, NOW, null);
    log = recordJoins(log, [player(ASH, 'Ash')], 1, NOW + MINUTE, NOW);
    const back = NOW + 31 * MINUTE + JOIN_GAP_MS + MINUTE;
    log = recordJoins(log, [player(BO, 'Bo')], 1, back, NOW + 31 * MINUTE);
    expect(log.events.slice(-2)).toEqual([
      { at: back, kind: 'left', steamId: ASH, name: 'Ash', from: NOW + 31 * MINUTE, joinedAt: NOW + MINUTE },
      { at: back, kind: 'joined', steamId: BO, name: 'Bo', from: NOW + 31 * MINUTE },
    ]);
    const left = log.events.at(-2);
    expect(left && minutesOn(left)).toBe(30);
  });

  it('does not trust a reading that lists nobody while the server says it has players', () => {
    const log = recordJoins(null, [player(ASH, 'Ash'), player(BO, 'Bo')], 2, NOW, null);
    expect(recordJoins(log, [], 2, NOW + MINUTE, NOW)).toBe(log);
    expect(recordJoins(log, [], 0, NOW + MINUTE, NOW).events).toHaveLength(2);
  });

  it('counts a player listed twice once', () => {
    const log = recordJoins(null, [], 0, NOW, null);
    expect(recordJoins(log, [player(ASH, 'Ash'), player(ASH, 'Ash')], 1, NOW + MINUTE, NOW).events).toHaveLength(1);
  });

  it('keeps the latest joins and leaves, and fewer when long names would make it too big to store', () => {
    let log: JoinLog = recordJoins(null, [], 0, NOW, null);
    for (let i = 1; i <= JOINS_KEPT / 2 + 10; i++) {
      log = recordJoins(log, [player(ASH, 'Ash')], 1, NOW + (2 * i - 1) * MINUTE, NOW + (2 * i - 2) * MINUTE);
      log = recordJoins(log, [], 0, NOW + 2 * i * MINUTE, NOW + (2 * i - 1) * MINUTE);
    }
    expect(log.events).toHaveLength(JOINS_KEPT);
    expect(log.events.at(-1)).toMatchObject({ kind: 'left', at: NOW + (JOINS_KEPT + 20) * MINUTE });

    const long = 'Ж'.repeat(100);
    let big: JoinLog = recordJoins(null, [], 0, NOW, null);
    for (let i = 1; i <= JOINS_KEPT; i++) big = recordJoins(big, i % 2 === 1 ? [player(ASH, long)] : [], i % 2, NOW + i * MINUTE, NOW + (i - 1) * MINUTE);
    expect(new TextEncoder().encode(JSON.stringify(big.events)).length).toBeLessThanOrEqual(JOINS_BYTES);
    expect(big.events.length).toBeGreaterThan(100);
    expect(big.events.at(-1)?.at).toBe(NOW + JOINS_KEPT * MINUTE);
  });
});

describe('parseJoinLog', () => {
  it('reads back what it wrote, and nothing from anything else', () => {
    let log = recordJoins(null, [player(ASH, 'Ash')], 1, NOW, null);
    log = recordJoins(log, [player(BO, 'Bo')], 1, NOW + 10 * MINUTE, NOW);
    expect(parseJoinLog(JSON.parse(JSON.stringify(log)))).toEqual(log);
    expect(parseJoinLog(undefined)).toBeNull();
    expect(parseJoinLog({ events: 'x' })).toBeNull();
  });
});

describe('minutesOn', () => {
  it('is only for a leave by someone the bot saw join', () => {
    expect(minutesOn({ at: NOW, kind: 'joined', steamId: ASH, name: 'Ash' })).toBeNull();
    expect(minutesOn({ at: NOW, kind: 'left', steamId: ASH, name: 'Ash', joinedAt: null })).toBeNull();
    expect(minutesOn({ at: NOW, kind: 'left', steamId: ASH, name: 'Ash', joinedAt: NOW - 90 * MINUTE })).toBe(90);
  });
});
