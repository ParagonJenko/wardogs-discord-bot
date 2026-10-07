import { describe, expect, it } from 'vitest';
import type { AlertRules } from '../src/alerts.ts';
import { emptyGriefDay, recordGrief } from '../src/griefing.ts';
import type { KillDaySummary } from '../src/killfeed.ts';
import type { Outage, OutageEvent } from '../src/outages.ts';
import {
  buildReview,
  chanceBand,
  countAlert,
  histogram,
  logOutage,
  OUTAGES_KEPT,
  parseAlertLog,
  parseOutageLog,
  REVIEW_DAYS,
} from '../src/review.ts';
import type { SteamCheck } from '../src/steam.ts';
import type { FeedEvent } from '../src/weapons.ts';

const DAY = 86_400_000;
const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 7, 12);
const ASH = '76561198000000001';
const BO = '76561198000000002';
const CY = '76561198000000003';
const AK = 'Id.Item.AK74M';

describe('alert log', () => {
  it('counts posts by UTC day and kind, keeping the last 60 days', () => {
    let log = countAlert({}, 'seeding', NOW);
    log = countAlert(log, 'seeding', NOW + MINUTE);
    log = countAlert(log, 'headshot', NOW, 3);

    expect(log).toEqual({ '2026-10-07': { seeding: 2, headshot: 3 } });

    const later = countAlert(log, 'live', NOW + REVIEW_DAYS * DAY);
    expect(Object.keys(later)).toEqual(['2026-12-06']);
  });

  it('reads what was saved, and nothing from anything else', () => {
    expect(parseAlertLog({ '2026-10-07': { live: 1 } })).toEqual({ '2026-10-07': { live: 1 } });
    expect(parseAlertLog('nonsense')).toEqual({});
  });
});

describe('outage log', () => {
  const outage: Outage = {
    kind: 'crash',
    at: NOW,
    before: 99,
    map: 'Kavkazi',
    lowest: 0,
    unreachableSince: null,
    unreachableMs: 0,
    confirmedAt: NOW + 3 * MINUTE,
  };

  it('logs an outage when it is confirmed, and fills it in when it is over', () => {
    const down: OutageEvent = { type: 'down', at: NOW + 3 * MINUTE, outage, players: 3, map: 'Kavkazi' };
    const back: OutageEvent = { type: 'back', at: NOW + 70 * MINUTE, outage: { ...outage, unreachableMs: 31 * MINUTE }, players: 94, map: 'Kavkazi', refilled: true };

    const opened = logOutage([], down);
    expect(opened).toEqual([{ ...outage, endedAt: null, players: null, refilled: null }]);

    const closed = logOutage(opened, back);
    expect(closed).toEqual([{ ...outage, unreachableMs: 31 * MINUTE, endedAt: NOW + 70 * MINUTE, players: 94, refilled: true }]);
    expect(parseOutageLog(structuredClone(closed))).toEqual(closed);
    expect(parseOutageLog(undefined)).toEqual([]);
  });

  it(`keeps the latest ${OUTAGES_KEPT}`, () => {
    let log = parseOutageLog([]);
    for (let i = 0; i < OUTAGES_KEPT + 5; i++) {
      log = logOutage(log, { type: 'down', at: NOW + i, outage: { ...outage, at: NOW + i }, players: 0, map: 'Kavkazi' });
    }

    expect(log).toHaveLength(OUTAGES_KEPT);
    expect(log[0]?.at).toBe(NOW + 5);
  });
});

describe('histogram and bands', () => {
  it('counts values up to a top that takes everything above it', () => {
    expect(histogram([0, 1, 1, 3, 7, 12], 5)).toEqual({ '0': 1, '1': 2, '3': 1, '5+': 2 });
  });

  it('puts a chance by luck in its band, the flag at 1 in 1,000 among them', () => {
    expect(chanceBand(0.5)).toBe('likelier than 1 in 20');
    expect(chanceBand(0.02)).toBe('1 in 20 to 100');
    expect(chanceBand(0.0009)).toBe('1 in 1,000 to 10,000');
    expect(chanceBand(1e-9)).toBe('1 in 1,000,000 or less');
  });
});

describe('buildReview', () => {
  const rules: AlertRules = { seeding: 1, live: 20, lowPop: 20, cooldownMs: 10 * MINUTE, graceMs: 5 * MINUTE, seedHoldMs: 5 * MINUTE };
  const sides = (steamId: string) => (steamId === CY ? 'Kharr' : 'Valkyra');
  const kill = (killer: string, victim: string, overrides: Partial<FeedEvent> = {}): FeedEvent => ({
    eventId: `${killer}-${victim}-${Math.random()}`,
    time: 0,
    matchId: 'm',
    map: 'Kavkazi',
    victimSteamId: victim,
    victimName: 'Victim',
    killerSteamId: killer,
    killerName: 'Killer',
    cause: AK,
    distance: 10,
    headshot: false,
    tags: [],
    ...overrides,
  });
  const summary = (steamId: string, day: string, kills: number, headshots: number): KillDaySummary => ({
    steamId,
    day,
    name: 'Someone',
    kills,
    headshots,
    weapons: { [AK]: { kills, headshots } },
  });
  // 40 others a day, a quarter of their kills headshots.
  const crowd = (day: string): KillDaySummary[] =>
    Array.from({ length: 40 }, (_, i) => summary(`7656119900000${String(i).padStart(4, '0')}`, day, 25, 6));
  const steam = (overrides: Partial<SteamCheck>): SteamCheck => ({
    at: NOW,
    found: true,
    vacBans: 0,
    gameBans: 0,
    lastBanAt: null,
    communityBanned: false,
    tradeBan: 'none',
    public: true,
    setUp: true,
    createdAt: NOW - 5 * 365 * DAY,
    ...overrides,
  });

  const review = buildReview({
    now: NOW,
    days: 2,
    rules,
    quietHours: { start: 21, end: 6, timeZone: 'Europe/London' },
    posts: { modLog: true, grief: true, steam: true, headshot: true, outage: true },
    alertLog: { '2026-10-01': { seeding: 9 }, '2026-10-06': { seeding: 2, down: 1 }, '2026-10-07': { live: 1, headshot: 1 } },
    outageLog: [],
    outage: null,
    grief: [
      recordGrief(emptyGriefDay(), [kill(ASH, BO), kill(ASH, BO), kill(ASH, BO), kill(ASH, BO), kill(BO, ASH)], NOW - DAY, sides).day,
      recordGrief(emptyGriefDay(), [kill(BO, ASH, { cause: 'Vehicle.Variant.Air.Rotary.Littlebird.Default', tags: ['VehicleExplosion'] })], NOW, sides).day,
    ],
    kept: [...crowd('2026-10-06'), ...crowd('2026-10-07'), summary(ASH, '2026-10-07', 12, 10), summary(BO, '2026-10-07', 4, 1)],
    steam: [steam({}), steam({ vacBans: 1, lastBanAt: NOW - 10 * DAY, createdAt: NOW - 10 * DAY })],
  });

  it('gives the marks the alerts use', () => {
    expect(review.thresholds.population).toEqual({
      seeding: 1,
      live: 20,
      lowPop: 20,
      cooldownMinutes: 10,
      dropGraceMinutes: 5,
      seedingAlertMinutes: 5,
      quietHours: { start: 21, end: 6, timeZone: 'Europe/London' },
    });
    expect(review.thresholds.grief).toEqual({ teamKills: 4, sameTeammate: 3, vehicleSuicides: 4, suicides: 10 });
    expect(review.thresholds.headshots).toEqual({ kills: 10, odds: 1_000 });
  });

  it('counts what was posted in the period', () => {
    expect(review.alerts).toEqual({
      totals: { seeding: 2, down: 1, live: 1, headshot: 1 },
      byDay: [
        { day: '2026-10-06', seeding: 2, down: 1 },
        { day: '2026-10-07', live: 1, headshot: 1 },
      ],
    });
  });

  it('spreads the players’ griefing days out against the flags, crashes left out', () => {
    expect(review.grief).toMatchObject({
      playerDays: 4,
      // Ash's four on Bo, Bo's one on Ash, and Bo's helicopter crash the next day, which does not count.
      teamKills: { '0': 2, '1': 1, '4': 1 },
      crashTeamKills: 1,
      sameTeammate: { '0': 2, '1': 1, '4': 1 },
      flaggedDays: { teamKills: 1, sameTeammate: 1, vehicleSuicides: 0, suicides: 0 },
      flaggedPlayers: 1,
      playersByFlaggedDays: { '1': 1 },
    });
  });

  it('spreads the headshot days out by chance by luck', () => {
    expect(review.headshots).toMatchObject({
      serverShare: 0.244,
      playerDays: 82,
      judgedDays: 81,
      flaggedDays: 1,
      flaggedPlayers: 1,
      playersByFlaggedDays: { '1': 1 },
    });
    expect(review.headshots.chance['1 in 10,000 to 100,000']).toBe(1);
  });

  it('spreads the Steam accounts out by risk', () => {
    expect(review.steam).toMatchObject({ checked: 2, risk: { low: 1, high: 1 }, atAlertMark: 1 });
  });

  it('never names anyone or gives a Steam ID', () => {
    const text = JSON.stringify(review);

    expect(text).not.toMatch(/7656119\\d{10}/);
    expect(text).not.toContain('Someone');
    expect(text).not.toContain('Killer');
  });
});
