import { describe, expect, it } from 'vitest';
import type { ServerStatus } from '../src/rcon.ts';
import {
  DAYS_KEPT,
  discordDue,
  emptyStats,
  HISTORY_MS,
  MATCHES_KEPT,
  parseStats,
  publicStats,
  recordDiscord,
  recordMatch,
  recordObservation,
  type Observation,
} from '../src/stats.ts';
import type { MatchState, MatchSummary } from '../src/tracking.ts';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
// 2026-09-30T00:00:00Z
const MIDNIGHT = Date.UTC(2026, 8, 30);

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
    '76561198000000001': { name: 'Ash', kills: 4, deaths: 1 },
    '76561198000000002': { name: 'Bo', kills: 9, deaths: 3 },
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
    const stats = recordObservation(emptyStats(), observation(MIDNIGHT, 24), 1);

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
      (acc, hoursLater) => recordObservation(acc, observation(MIDNIGHT + hoursLater * HOUR, hoursLater), 1),
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
    ].reduce((acc, obs) => recordObservation(acc, obs, 1), emptyStats());

    expect(stats.days).toEqual([
      { day: '2026-09-30', peak: 31, liveMinutes: 2 },
      { day: '2026-10-01', peak: 3, liveMinutes: 0 },
    ]);
  });

  it('drops days from before a long outage', () => {
    const stats = [observation(MIDNIGHT, 30), observation(MIDNIGHT + 30 * DAY, 5)].reduce(
      (acc, obs) => recordObservation(acc, obs, 1),
      emptyStats(),
    );

    expect(stats.days.map((d) => d.day)).toEqual(['2026-10-30']);
  });

  it(`keeps the last ${DAYS_KEPT} days`, () => {
    const stats = Array.from({ length: DAYS_KEPT + 3 }, (_, i) => observation(MIDNIGHT + i * DAY, i)).reduce(
      (acc, obs) => recordObservation(acc, obs, 1),
      emptyStats(),
    );

    expect(stats.days).toHaveLength(DAYS_KEPT);
    expect(stats.days[0]?.day).toBe('2026-10-03');
  });

  it('shows the current match top players without their Steam IDs', () => {
    const stats = recordObservation(emptyStats(), observation(MIDNIGHT, 30), 1);

    expect(stats.currentMatch?.top).toEqual([
      { name: 'Bo', kills: 9, deaths: 3 },
      { name: 'Ash', kills: 4, deaths: 1 },
    ]);
    expect(JSON.stringify(stats)).not.toContain('76561198');
  });

  it('has no current match while the server is empty', () => {
    expect(recordObservation(emptyStats(), observation(MIDNIGHT, 0, 'empty'), 1).currentMatch).toBeNull();
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
    const stats = recordMatch(recordObservation(emptyStats(), observation(MIDNIGHT, 30), 1), summary, MIDNIGHT);

    expect(parseStats(structuredClone(stats))).toEqual(stats);
  });

  it('starts fresh when nothing or something unrecognisable was saved', () => {
    expect(parseStats(undefined)).toEqual(emptyStats());
    expect(parseStats({ history: 'nope' })).toEqual(emptyStats());
  });
});

describe('publicStats', () => {
  it('adds the time, the thresholds the site draws on its chart, the leaderboard and what seeding earns', () => {
    const rules = { seeding: 1, live: 20, lowPop: 20, cooldownMs: 0 };
    const leaderboard = { days: 30, kdMinMatches: 3, kills: [], kd: [], playtime: [], seeding: [] };
    const vip = { seedDays: 3, seedMinutes: 10, windowDays: 7, lengthDays: 7 };

    expect(publicStats(emptyStats(), rules, MIDNIGHT, { leaderboard, vip })).toEqual({
      ...emptyStats(),
      generatedAt: MIDNIGHT,
      thresholds: { seeding: 1, live: 20 },
      leaderboard,
      vip,
    });
  });
});
