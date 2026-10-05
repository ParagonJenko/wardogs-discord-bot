import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  createSessions,
  JOIN_GAP_MS,
  JOINS_BYTES,
  JOINS_KEPT,
  minutesOn,
  parseJoinLog,
  playerSessions,
  pruneSessions,
  recordJoins,
  SESSIONS_LISTED,
  writeSessions,
  type JoinEvent,
  type JoinLog,
} from '../src/joinlog.ts';
import type { Sql } from '../src/killfeed.ts';
import type { Player } from '../src/rcon.ts';

const ASH = '76561198000000001';
const BO = '76561198000000002';
const CY = '76561198000000003';
const NOW = Date.UTC(2026, 9, 5, 19);
const MINUTE = 60_000;
const DAY_MS = 24 * 60 * MINUTE;

const player = (steamId: string, name: string): Player => ({ steamId, name, kills: null, deaths: null });

// One check that found `players` in game, as many as the server said it had.
const check = (log: JoinLog | null, players: Player[], at: number, lastCheckAt: number | null): JoinLog =>
  recordJoins(log, players, players.length, at, lastCheckAt).log;

// The Durable Object's database, as Node's SQLite. Like Cloudflare's, a statement runs as soon as it is given.
const database = (): Sql => {
  const db = new DatabaseSync(':memory:');
  return {
    exec: (query, ...bindings) => {
      const rows = db.prepare(query).all(...(bindings as SQLInputValue[])) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
  };
};

describe('recordJoins', () => {
  it('starts with everyone in game and no joins, as it cannot tell when they came on', () => {
    expect(recordJoins(null, [player(ASH, 'Ash'), player(BO, 'Bo')], 2, NOW, null)).toEqual({
      log: { inGame: { [ASH]: { name: 'Ash', since: null }, [BO]: { name: 'Bo', since: null } }, events: [] },
      added: [],
    });
  });

  it('notes who joined and who left since the check before', () => {
    const log = check(null, [player(ASH, 'Ash'), player(BO, 'Bo')], NOW, null);
    const next = recordJoins(log, [player(BO, 'Bo'), player(CY, 'Cy')], 2, NOW + MINUTE, NOW);
    const added = [
      { at: NOW + MINUTE, kind: 'left', steamId: ASH, name: 'Ash', joinedAt: null },
      { at: NOW + MINUTE, kind: 'joined', steamId: CY, name: 'Cy' },
    ];
    expect(next.added).toEqual(added);
    expect(next.log.events).toEqual(added);
    expect(next.log.inGame).toEqual({ [BO]: { name: 'Bo', since: null }, [CY]: { name: 'Cy', since: NOW + MINUTE } });
  });

  it('gives back the same log when nobody joined or left, so there is nothing to write', () => {
    const log = check(null, [player(ASH, 'Ash')], NOW, null);
    expect(recordJoins(log, [player(ASH, 'Ash')], 1, NOW + MINUTE, NOW)).toEqual({ log, added: [] });
    expect(recordJoins(log, [player(ASH, 'Ash')], 1, NOW + MINUTE, NOW).log).toBe(log);
  });

  it('remembers when someone joined, for how long they were on when they leave', () => {
    let log = check(null, [], NOW, null);
    log = check(log, [player(ASH, 'Ash')], NOW + MINUTE, NOW);
    log = check(log, [], NOW + 46 * MINUTE, NOW + 45 * MINUTE);
    const left = log.events.at(-1);
    expect(left).toEqual({ at: NOW + 46 * MINUTE, kind: 'left', steamId: ASH, name: 'Ash', joinedAt: NOW + MINUTE });
    expect(left && minutesOn(left)).toBe(45);
  });

  it('says since when after the bot could not read the server, and counts time on to the last check that saw them', () => {
    let log = check(null, [], NOW, null);
    log = check(log, [player(ASH, 'Ash')], NOW + MINUTE, NOW);
    const back = NOW + 31 * MINUTE + JOIN_GAP_MS + MINUTE;
    log = check(log, [player(BO, 'Bo')], back, NOW + 31 * MINUTE);
    expect(log.events.slice(-2)).toEqual([
      { at: back, kind: 'left', steamId: ASH, name: 'Ash', from: NOW + 31 * MINUTE, joinedAt: NOW + MINUTE },
      { at: back, kind: 'joined', steamId: BO, name: 'Bo', from: NOW + 31 * MINUTE },
    ]);
    const left = log.events.at(-2);
    expect(left && minutesOn(left)).toBe(30);
    // When Bo leaves, the leave carries the gap before their join.
    log = check(log, [], back + 10 * MINUTE, back + 9 * MINUTE);
    expect(log.events.at(-1)).toEqual({
      at: back + 10 * MINUTE,
      kind: 'left',
      steamId: BO,
      name: 'Bo',
      joinedAt: back,
      joinedFrom: NOW + 31 * MINUTE,
    });
  });

  it('does not trust a reading that lists nobody while the server says it has players', () => {
    const log = check(null, [player(ASH, 'Ash'), player(BO, 'Bo')], NOW, null);
    expect(recordJoins(log, [], 2, NOW + MINUTE, NOW)).toEqual({ log, added: [] });
    expect(recordJoins(log, [], 0, NOW + MINUTE, NOW).added).toHaveLength(2);
  });

  it('counts a player listed twice once', () => {
    const log = check(null, [], NOW, null);
    expect(recordJoins(log, [player(ASH, 'Ash'), player(ASH, 'Ash')], 1, NOW + MINUTE, NOW).added).toHaveLength(1);
  });

  it('keeps the latest joins and leaves, and fewer when long names would make it too big to store', () => {
    let log = check(null, [], NOW, null);
    for (let i = 1; i <= JOINS_KEPT / 2 + 10; i++) {
      log = check(log, [player(ASH, 'Ash')], NOW + (2 * i - 1) * MINUTE, NOW + (2 * i - 2) * MINUTE);
      log = check(log, [], NOW + 2 * i * MINUTE, NOW + (2 * i - 1) * MINUTE);
    }
    expect(log.events).toHaveLength(JOINS_KEPT);
    expect(log.events.at(-1)).toMatchObject({ kind: 'left', at: NOW + (JOINS_KEPT + 20) * MINUTE });

    const long = 'Ж'.repeat(100);
    let big = check(null, [], NOW, null);
    for (let i = 1; i <= JOINS_KEPT; i++) big = check(big, i % 2 === 1 ? [player(ASH, long)] : [], NOW + i * MINUTE, NOW + (i - 1) * MINUTE);
    expect(new TextEncoder().encode(JSON.stringify(big.events)).length).toBeLessThanOrEqual(JOINS_BYTES);
    expect(big.events.length).toBeGreaterThan(100);
    expect(big.events.at(-1)?.at).toBe(NOW + JOINS_KEPT * MINUTE);
  });
});

describe('parseJoinLog', () => {
  it('reads back what it wrote, and nothing from anything else', () => {
    let log = check(null, [player(ASH, 'Ash')], NOW, null);
    log = check(log, [player(BO, 'Bo')], NOW + 10 * MINUTE, NOW);
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

describe('sessions', () => {
  const sessionsDb = (): Sql => {
    const sql = database();
    createSessions(sql);
    createSessions(sql);
    return sql;
  };
  const left = (at: number, steamId: string, joinedAt: number | null, more: Partial<JoinEvent> = {}): JoinEvent => ({
    at,
    kind: 'left',
    steamId,
    name: 'x',
    joinedAt,
    ...more,
  });

  it("lists a player's times on the server newest first, with how long each was, and only theirs", () => {
    const sql = sessionsDb();
    writeSessions(sql, [
      left(NOW - 300 * MINUTE, ASH, NOW - 360 * MINUTE),
      { at: NOW - 200 * MINUTE, kind: 'joined', steamId: ASH, name: 'Ash' },
      left(NOW - 100 * MINUTE, ASH, NOW - 200 * MINUTE, { from: NOW - 130 * MINUTE, joinedFrom: NOW - 240 * MINUTE }),
      left(NOW - 50 * MINUTE, BO, null),
    ]);
    expect(playerSessions(sql, ASH, NOW - DAY_MS, null, NOW)).toEqual([
      { joinedAt: NOW - 200 * MINUTE, joinedFrom: NOW - 240 * MINUTE, leftAt: NOW - 100 * MINUTE, leftFrom: NOW - 130 * MINUTE, minutes: 70 },
      { joinedAt: NOW - 360 * MINUTE, joinedFrom: null, leftAt: NOW - 300 * MINUTE, leftFrom: null, minutes: 60 },
    ]);
    expect(playerSessions(sql, BO, NOW - DAY_MS, null, NOW)).toEqual([
      { joinedAt: null, joinedFrom: null, leftAt: NOW - 50 * MINUTE, leftFrom: null, minutes: null },
    ]);
  });

  it('leaves out the times that ended before the period, and puts the one they are on now first', () => {
    const sql = sessionsDb();
    writeSessions(sql, [left(NOW - 2 * DAY_MS, ASH, NOW - 2 * DAY_MS - 30 * MINUTE), left(NOW - 60 * MINUTE, ASH, NOW - 90 * MINUTE)]);
    const sessions = playerSessions(sql, ASH, NOW - DAY_MS, { name: 'Ash', since: NOW - 20 * MINUTE }, NOW - MINUTE);
    expect(sessions).toEqual([
      { joinedAt: NOW - 20 * MINUTE, joinedFrom: null, leftAt: null, leftFrom: null, minutes: 19 },
      { joinedAt: NOW - 90 * MINUTE, joinedFrom: null, leftAt: NOW - 60 * MINUTE, leftFrom: null, minutes: 30 },
    ]);
  });

  it(`lists at most ${SESSIONS_LISTED}`, () => {
    const sql = sessionsDb();
    writeSessions(
      sql,
      Array.from({ length: SESSIONS_LISTED + 5 }, (_, i) => left(NOW - i * MINUTE, ASH, NOW - i * MINUTE - 30_000)),
    );
    const sessions = playerSessions(sql, ASH, 0, { name: 'Ash', since: NOW }, NOW);
    expect(sessions).toHaveLength(SESSIONS_LISTED);
    expect(sessions[0]?.leftAt).toBeNull();
  });

  it('deletes the times that ended before the ones kept', () => {
    const sql = sessionsDb();
    writeSessions(sql, [left(NOW - 40 * DAY_MS, ASH, null), left(NOW - DAY_MS, ASH, null)]);
    pruneSessions(sql, NOW - 30 * DAY_MS);
    expect(playerSessions(sql, ASH, 0, null, NOW).map((s) => s.leftAt)).toEqual([NOW - DAY_MS]);
  });
});
