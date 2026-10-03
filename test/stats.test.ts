import { describe, expect, it } from 'vitest';
import type { ServerStatus } from '../src/rcon.ts';
import {
  DAYS_KEPT,
  discordDue,
  emptyStats,
  HISTORY_MS,
  hourlyAverages,
  MATCHES_KEPT,
  namedSteamIds,
  parseStats,
  publicStats,
  recordDiscord,
  recordMatch,
  recordObservation,
  removeRecentMatch,
  type Observation,
} from '../src/stats.ts';
import type { MatchState, MatchSummary } from '../src/tracking.ts';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
// 2026-09-30T00:00:00Z
const MIDNIGHT = Date.UTC(2026, 8, 30);
const BUSY = 97;

const status = (players: number, overrides: Partial<ServerStatus> = {}): ServerStatus => ({
  name: 'UK Wardogs #1',
  players,
  maxPlayers: 98,
  map: 'Kavkazi',
  rotationIndex: 0,
  factionScores: [
    { name: 'Valkyra', score: 120 },
    { name: 'Kharr', score: 90 },
  ],
  ...overrides,
});

const match: MatchState = {
  key: 'Kavkazi#0',
  startedAt: MIDNIGHT,
  lastSeenAt: MIDNIGHT,
  liveAt: MIDNIGHT,
  summarisable: true,
  peakPlayers: 30,
  players: {
    '76561198000000001': { name: 'Ash', kills: 4, deaths: 1, lastKills: 4, lastDeaths: 1 },
    '76561198000000002': { name: 'Bo', kills: 9, deaths: 3, lastKills: 9, lastDeaths: 3 },
  },
  factionScores: [],
};

const observation = (at: number, players: number, phase: Observation['phase'] = 'live'): Observation => ({
  at,
  status: status(players),
  players: [],
  phase,
  seeding: phase === 'seeding',
  match,
});

const summary: MatchSummary = {
  map: 'Europe',
  durationMs: 40 * 60_000,
  peakPlayers: 44,
  factionScores: [
    { name: 'Valkyra', score: 300 },
    { name: 'Kharr', score: 255 },
  ],
  top: [{ name: 'Bo', kills: 9, deaths: 3 }],
};

describe('recordObservation', () => {
  it('keeps the latest server reading with the map name players see', () => {
    const stats = recordObservation(emptyStats(), observation(MIDNIGHT, 24), 1, BUSY);

    expect(stats.server).toEqual({
      name: 'UK Wardogs #1',
      players: 24,
      maxPlayers: 98,
      map: 'Bakurani',
      phase: 'live',
      factionScores: status(24).factionScores,
      seenAt: MIDNIGHT,
    });
  });

  it('keeps 24 hours of population samples', () => {
    const stats = [0, 1, 2, 25].reduce(
      (acc, hoursLater) => recordObservation(acc, observation(MIDNIGHT + hoursLater * HOUR, hoursLater), 1, BUSY),
      emptyStats(),
    );

    expect(stats.history).toEqual([
      [MIDNIGHT + 2 * HOUR, 2],
      [MIDNIGHT + 25 * HOUR, 25],
    ]);
    expect(stats.history.every(([at]) => at > MIDNIGHT + 25 * HOUR - HISTORY_MS)).toBe(true);
  });

  it('tracks each UTC day’s peak and minutes live', () => {
    const stats = [
      observation(MIDNIGHT + 10 * HOUR, 12, 'seeding'),
      observation(MIDNIGHT + 11 * HOUR, 31, 'live'),
      observation(MIDNIGHT + 12 * HOUR, 22, 'live'),
      observation(MIDNIGHT + DAY + HOUR, 3, 'seeding'),
    ].reduce((acc, obs) => recordObservation(acc, obs, 1, BUSY), emptyStats());

    expect(stats.days).toEqual([
      { day: '2026-09-30', peak: 31, liveMinutes: 2 },
      { day: '2026-10-01', peak: 3, liveMinutes: 0 },
    ]);
  });

  it('drops days from before a long outage', () => {
    const stats = [observation(MIDNIGHT, 30), observation(MIDNIGHT + 30 * DAY, 5)].reduce(
      (acc, obs) => recordObservation(acc, obs, 1, BUSY),
      emptyStats(),
    );

    expect(stats.days.map((d) => d.day)).toEqual(['2026-10-30']);
  });

  it(`keeps the last ${DAYS_KEPT} days`, () => {
    const stats = Array.from({ length: DAYS_KEPT + 3 }, (_, i) => observation(MIDNIGHT + i * DAY, i)).reduce(
      (acc, obs) => recordObservation(acc, obs, 1, BUSY),
      emptyStats(),
    );

    expect(stats.days).toHaveLength(DAYS_KEPT);
    expect(stats.days[0]?.day).toBe('2026-10-03');
  });

  it('adds each reading to its UTC hour, for the last 14 days', () => {
    const stats = [
      observation(MIDNIGHT + 20 * HOUR, 30),
      observation(MIDNIGHT + 20 * HOUR + 30 * 60_000, 40),
      observation(MIDNIGHT + 21 * HOUR, 10),
      observation(MIDNIGHT + DAY + 20 * HOUR, 50),
    ].reduce((acc, obs) => recordObservation(acc, obs, 1, BUSY), emptyStats());

    expect(stats.hours.map((h) => h.day)).toEqual(['2026-09-30', '2026-10-01']);
    expect(stats.hours[0]?.players[20]).toBe(70);
    expect(stats.hours[0]?.readings[20]).toBe(2);
    expect(stats.hours[0]?.players[21]).toBe(10);
    expect(stats.hours[0]?.readings[21]).toBe(1);
    expect(stats.hours[1]?.readings.reduce((a, b) => a + b)).toBe(1);

    const later = recordObservation(stats, observation(MIDNIGHT + DAYS_KEPT * DAY, 5), 1, BUSY);
    expect(later.hours.map((h) => h.day)).toEqual(['2026-10-01', '2026-10-14']);
  });

  it('counts the readings with at least the busy threshold', () => {
    const stats = [96, 97, 98].reduce(
      (acc, players, i) => recordObservation(acc, observation(MIDNIGHT + 20 * HOUR + i * 60_000, players), 1, BUSY),
      emptyStats(),
    );

    expect(stats.hours[0]?.readings[20]).toBe(3);
    expect(stats.hours[0]?.busyThreshold).toBe(BUSY);
    expect(stats.hours[0]?.checked[20]).toBe(3);
    expect(stats.hours[0]?.busy[20]).toBe(2);
    expect(stats.hours[0]?.busy.reduce((a, b) => a + b)).toBe(2);
  });

  it('checks the last 24 hours of readings again when the threshold changes', () => {
    const first = recordObservation(emptyStats(), observation(MIDNIGHT + 20 * HOUR, 50), 1, 40);
    const stats = recordObservation(first, observation(MIDNIGHT + 21 * HOUR, 70), 1, 60);

    expect(first.hours[0]?.busy[20]).toBe(1);
    expect(stats.hours[0]?.busyThreshold).toBe(60);
    expect(stats.hours[0]?.checked[20]).toBe(1);
    expect(stats.hours[0]?.busy[20]).toBe(0);
    expect(stats.hours[0]?.busy[21]).toBe(1);
  });

  it('checks the readings from the last 24 hours that were saved before busy ones were counted', () => {
    const full = Array.from({ length: 7 }, (_, i) => observation(MIDNIGHT + (14 + i) * HOUR, 98)).reduce(
      (acc, obs) => recordObservation(acc, obs, 1, BUSY),
      emptyStats(),
    );
    const older = { ...full, hours: full.hours.map(({ busyThreshold: _t, checked: _c, busy: _b, ...h }) => h) };
    const stats = recordObservation(parseStats(structuredClone(older)), observation(MIDNIGHT + 21 * HOUR, 90), 1, BUSY);

    const { busy } = hourlyAverages(stats.hours, MIDNIGHT + 21 * HOUR, BUSY);
    expect(busy.slice(14, 22)).toEqual([1, 1, 1, 1, 1, 1, 1, 0]);
    expect(stats.hours[0]?.checked[14]).toBe(1);

    const next = recordObservation(stats, observation(MIDNIGHT + 21 * HOUR + 60_000, 98), 1, BUSY);
    expect(next.hours[0]?.checked[21]).toBe(2);
    expect(next.hours[0]?.checked[14]).toBe(1);

    // As left by a bot that only counted busy readings from its deploy on: today at 97, only the last hour checked.
    const lastHourOnly = (counts: number[]) => counts.map((c, i) => (i === 21 ? c : 0));
    const deployed = { ...stats, hours: stats.hours.map((h) => ({ ...h, checked: lastHourOnly(h.checked), busy: lastHourOnly(h.busy) })) };
    const fixed = recordObservation(deployed, observation(MIDNIGHT + 21 * HOUR + 60_000, 98), 1, BUSY);
    expect(hourlyAverages(fixed.hours, MIDNIGHT + 22 * HOUR, BUSY).busy.slice(14, 22)).toEqual([1, 1, 1, 1, 1, 1, 1, 0.5]);
  });

  it('shows the current match top players, keeping their Steam IDs for publicStats to swap', () => {
    const stats = recordObservation(emptyStats(), observation(MIDNIGHT, 30), 1, BUSY);

    expect(stats.currentMatch?.top).toEqual([
      { steamId: '76561198000000002', name: 'Bo', kills: 9, deaths: 3 },
      { steamId: '76561198000000001', name: 'Ash', kills: 4, deaths: 1 },
    ]);
  });

  it('has no current match while the server is empty', () => {
    expect(recordObservation(emptyStats(), observation(MIDNIGHT, 0, 'empty'), 1, BUSY).currentMatch).toBeNull();
  });
});

describe('recordMatch', () => {
  it(`lists finished matches newest first, up to ${MATCHES_KEPT}`, () => {
    const stats = Array.from({ length: MATCHES_KEPT + 2 }, (_, i) => i).reduce(
      (acc, i) => recordMatch(acc, summary, MIDNIGHT + i * HOUR),
      emptyStats(),
    );

    expect(stats.matches).toHaveLength(MATCHES_KEPT);
    expect(stats.matches[0]).toEqual({ ...summary, map: 'Ozeti', endedAt: MIDNIGHT + (MATCHES_KEPT + 1) * HOUR });
  });
});

describe('removeRecentMatch', () => {
  it('takes off the match that ended at that time, and nothing else', () => {
    const stats = [0, 1, 2].reduce((acc, i) => recordMatch(acc, summary, MIDNIGHT + i * HOUR), emptyStats());

    const { stats: after, removed } = removeRecentMatch(stats, MIDNIGHT + HOUR);

    expect(removed).toEqual({ ...summary, map: 'Ozeti', endedAt: MIDNIGHT + HOUR });
    expect(after.matches.map((m) => m.endedAt)).toEqual([MIDNIGHT + 2 * HOUR, MIDNIGHT]);
    expect(removeRecentMatch(stats, MIDNIGHT + 5 * HOUR)).toEqual({ stats, removed: null });
  });
});

describe('Discord counts', () => {
  const counts = { name: 'WARDOGS UK', members: 1200, online: 180, fetchedAt: MIDNIGHT };

  it('refreshes every 10 minutes', () => {
    const stats = recordDiscord(emptyStats(), counts);

    expect(discordDue(emptyStats(), MIDNIGHT)).toBe(true);
    expect(discordDue(stats, MIDNIGHT + 9 * 60_000)).toBe(false);
    expect(discordDue(stats, MIDNIGHT + 10 * 60_000)).toBe(true);
  });
});

describe('parseStats', () => {
  it('reads back what was saved', () => {
    const stats = recordMatch(recordObservation(emptyStats(), observation(MIDNIGHT, 30), 1, BUSY), summary, MIDNIGHT);

    expect(parseStats(structuredClone(stats))).toEqual(stats);
  });

  it('starts the hours from the last 24 hours of readings when they were saved without them', () => {
    const stats = [0, 1, 2].reduce(
      (acc, minutes) => recordObservation(acc, observation(MIDNIGHT + 20 * HOUR + minutes * 60_000, 30 + minutes), 1, BUSY),
      emptyStats(),
    );
    const { hours, ...older } = stats;
    const parsed = parseStats(structuredClone(older));

    expect({ ...parsed, hours: [] }).toEqual({ ...stats, hours: [] });
    expect(parsed.hours[0]?.players).toEqual(hours[0]?.players);
    expect(parsed.hours[0]?.readings[20]).toBe(3);
    expect(parsed.hours[0]?.busyThreshold).toBeNull();
    expect(parsed.hours[0]?.checked).toEqual(Array(24).fill(0));
  });

  it('leaves readings saved before busy ones were counted out of the busy shares', () => {
    const stats = recordObservation(emptyStats(), observation(MIDNIGHT + 20 * HOUR, 30), 1, BUSY);
    const older = { ...stats, hours: stats.hours.map(({ busyThreshold: _t, checked: _c, busy: _b, ...h }) => h) };
    const parsed = parseStats(structuredClone(older));

    expect(parsed.hours[0]?.readings[20]).toBe(1);
    expect(parsed.hours[0]?.checked[20]).toBe(0);
    expect(hourlyAverages(parsed.hours, MIDNIGHT + 20 * HOUR, BUSY).busy[20]).toBeNull();

    const later = recordObservation(parsed, observation(MIDNIGHT + DAY + 20 * HOUR, 98), 1, BUSY);
    expect(hourlyAverages(later.hours, MIDNIGHT + DAY + 20 * HOUR, BUSY).busy[20]).toBe(1);
    expect(hourlyAverages(later.hours, MIDNIGHT + DAY + 20 * HOUR, BUSY).players[20]).toBe(64);
  });

  it('starts fresh when nothing or something unrecognisable was saved', () => {
    expect(parseStats(undefined)).toEqual(emptyStats());
    expect(parseStats({ history: 'nope' })).toEqual(emptyStats());
  });
});

describe('publicStats', () => {
  it('adds the time, the thresholds the site draws on its chart, the leaderboard and what seeding earns', () => {
    const thresholds = { seeding: 1, live: 20, busy: BUSY };
    const leaderboard = { days: 30, kdMinMatches: 3, kills: [], kd: [], playtime: [], seeding: [] };
    const vip = { seedDays: 3, seedMinutes: 10, windowDays: 7, lengthDays: 7 };
    const teams = { days: 30, matches: 0, draws: 0, averageMs: 0, teams: [], maps: [], streak: null, closest: null, biggest: null };

    const { hours: _hours, ...stats } = emptyStats();

    expect(publicStats(emptyStats(), thresholds, MIDNIGHT, { leaderboard, vip, seederVip: [], weapons: null, teams }, () => undefined)).toEqual({
      ...stats,
      generatedAt: MIDNIGHT,
      thresholds,
      hourly: { days: DAYS_KEPT, players: Array(24).fill(null), busy: Array(24).fill(null) },
      leaderboard,
      vip,
      seederVip: [],
      weapons: null,
      teams,
    });
  });
});

describe('publicStats and Steam IDs', () => {
  const teams = { days: 30, matches: 0, draws: 0, averageMs: 0, teams: [], maps: [], streak: null, closest: null, biggest: null };
  const ids: Record<string, string> = { '76561198000000001': 'a1a1a1a1a1a1', '76561198000000002': 'b2b2b2b2b2b2' };
  const thresholds = { seeding: 1, live: 20, busy: BUSY };
  const ash = { steamId: '76561198000000001', name: 'Ash', seedingMinutes: 5, liveMinutes: 60, seedDays: 1, matches: 2, kills: 4, deaths: 1 };
  const leaderboard = { days: 30, kdMinMatches: 3, kills: [ash], kd: [], playtime: [ash], seeding: [ash] };
  const stats = recordMatch(
    recordObservation(emptyStats(), observation(MIDNIGHT, 30), 1, BUSY),
    { ...summary, top: [{ steamId: '76561198000000002', name: 'Bo', kills: 9, deaths: 3 }, { name: 'Old', kills: 1, deaths: 0 }] },
    MIDNIGHT,
  );

  it('swaps every Steam ID for the player’s public id', () => {
    const served = publicStats(stats, thresholds, MIDNIGHT, { leaderboard, vip: null, seederVip: null, weapons: null, teams }, (steamId) => ids[steamId]);

    expect(served.currentMatch?.top).toEqual([
      { id: 'b2b2b2b2b2b2', name: 'Bo', kills: 9, deaths: 3 },
      { id: 'a1a1a1a1a1a1', name: 'Ash', kills: 4, deaths: 1 },
    ]);
    // A match saved before Steam IDs were kept names its players without an id.
    expect(served.matches[0]?.top).toEqual([
      { id: 'b2b2b2b2b2b2', name: 'Bo', kills: 9, deaths: 3 },
      { name: 'Old', kills: 1, deaths: 0 },
    ]);
    expect(served.leaderboard.kills).toEqual([{ ...ash, steamId: undefined, id: 'a1a1a1a1a1a1' }]);
    expect(JSON.stringify(served)).not.toMatch(/7656119|steamId/);
  });

  it('names who has VIP from seeding by their public id', () => {
    const seederVip = [{ steamId: '76561198000000001', name: 'Ash', until: MIDNIGHT + 86_400_000 }];
    const served = publicStats(stats, thresholds, MIDNIGHT, { leaderboard, vip: null, seederVip, weapons: null, teams }, (steamId) => ids[steamId]);

    expect(served.seederVip).toEqual([{ id: 'a1a1a1a1a1a1', name: 'Ash', until: MIDNIGHT + 86_400_000 }]);
    expect(JSON.stringify(served)).not.toMatch(/7656119|steamId/);
  });

  it('lists everyone the public stats name, once each', () => {
    expect(namedSteamIds(stats, leaderboard).sort()).toEqual(['76561198000000001', '76561198000000002']);
  });

  it('leaves out ids it does not know, and still no Steam IDs', () => {
    const served = publicStats(stats, thresholds, MIDNIGHT, { leaderboard, vip: null, seederVip: null, weapons: null, teams }, () => undefined);

    expect(served.leaderboard.kills[0]).not.toHaveProperty('id');
    expect(JSON.stringify(served)).not.toMatch(/7656119|steamId/);
  });

  it('reads stats saved before Steam IDs were kept', () => {
    const saved = JSON.parse(JSON.stringify({ ...stats, matches: [{ ...stats.matches[0], top: [{ name: 'Bo', kills: 9, deaths: 3 }] }] }));

    expect(parseStats(saved).matches[0]?.top).toEqual([{ name: 'Bo', kills: 9, deaths: 3 }]);
  });
});

describe('hourlyAverages', () => {
  it(`averages the players in each UTC hour over the last ${DAYS_KEPT} days, with null for an hour with no readings`, () => {
    const stats = [
      observation(MIDNIGHT + 20 * HOUR, 30),
      observation(MIDNIGHT + 20 * HOUR + 30 * 60_000, 40),
      observation(MIDNIGHT + DAY + 20 * HOUR, 50),
      observation(MIDNIGHT + DAY + 3 * HOUR, 1),
      observation(MIDNIGHT + DAY + 3 * HOUR + 60_000, 2),
      observation(MIDNIGHT + DAY + 3 * HOUR + 2 * 60_000, 2),
    ].reduce((acc, obs) => recordObservation(acc, obs, 1, BUSY), emptyStats());

    const { days, players } = hourlyAverages(stats.hours, MIDNIGHT + DAY + 21 * HOUR, BUSY);

    expect(days).toBe(DAYS_KEPT);
    expect(players).toHaveLength(24);
    expect(players[20]).toBe(40);
    expect(players[3]).toBe(1.7);
    expect(players.filter((p) => p === null)).toHaveLength(22);
  });

  it('gives the share of each hour’s readings that were busy', () => {
    const stats = [
      observation(MIDNIGHT + 20 * HOUR, 98),
      observation(MIDNIGHT + 20 * HOUR + 60_000, 97),
      observation(MIDNIGHT + DAY + 20 * HOUR, 90),
      observation(MIDNIGHT + DAY + 3 * HOUR, 98),
      observation(MIDNIGHT + DAY + 3 * HOUR + 60_000, 40),
      observation(MIDNIGHT + DAY + 3 * HOUR + 2 * 60_000, 30),
      observation(MIDNIGHT + DAY + 4 * HOUR, 50),
    ].reduce((acc, obs) => recordObservation(acc, obs, 1, BUSY), emptyStats());

    const { busy } = hourlyAverages(stats.hours, MIDNIGHT + DAY + 21 * HOUR, BUSY);

    expect(busy[20]).toBe(0.67);
    expect(busy[3]).toBe(0.33);
    expect(busy[4]).toBe(0);
    expect(busy[5]).toBeNull();
  });

  it('leaves out busy counts made under another threshold', () => {
    const first = recordObservation(emptyStats(), observation(MIDNIGHT + 20 * HOUR, 98), 1, BUSY);
    const later = MIDNIGHT + 2 * DAY + 20 * HOUR;
    const stats = [observation(later, 70), observation(later + 60_000, 50)].reduce(
      (acc, obs) => recordObservation(acc, obs, 1, 60),
      first,
    );

    expect(hourlyAverages(first.hours, later, 60).busy[20]).toBeNull();
    expect(hourlyAverages(stats.hours, later + HOUR, 60).busy[20]).toBe(0.5);
    expect(hourlyAverages(stats.hours, later + HOUR, BUSY).busy[20]).toBeNull();
  });

  it('leaves out days older than that, as after a long outage', () => {
    const stats = recordObservation(emptyStats(), observation(MIDNIGHT + 20 * HOUR, 30), 1, BUSY);

    expect(hourlyAverages(stats.hours, MIDNIGHT + (DAYS_KEPT - 1) * DAY, BUSY).players[20]).toBe(30);
    expect(hourlyAverages(stats.hours, MIDNIGHT + DAYS_KEPT * DAY, BUSY).players[20]).toBeNull();
  });
});
