import { describe, expect, it } from 'vitest';
import {
  addOutcome,
  AUTO_RULES,
  decide,
  parseOutcomes,
  parseShadow,
  recordShadow,
  summariseShadow,
  type DayEvidence,
  type OutcomeEntry,
  type ShadowEntry,
} from '../src/autoflag.ts';

const NOW = Date.UTC(2026, 9, 24, 20);
const DAY = 24 * 60 * 60_000;

const day = (chance: number | null, more: Partial<DayEvidence> = {}): DayEvidence => ({
  day: '2026-10-24',
  kills: 30,
  headshots: 20,
  chance,
  flagged: chance !== null && chance < 1e-3 && (more.kills ?? 30) >= 10,
  ...more,
});

describe('decide', () => {
  it('does nothing for a day that is not flagged', () => {
    expect(decide(day(0.5), [], [])).toBeNull();
    expect(decide(day(null), [], [])).toBeNull();
    // 1 in 500 is not flagged, so no mark applies however the rest looks.
    expect(decide(day(2e-3), [day(1e-9, { day: '2026-10-23' })], ['vacBan', 'recentBan'])).toBeNull();
  });

  it('leaves a plain flagged day to staff', () => {
    expect(decide(day(5e-4), [], [])).toBeNull();
    expect(decide(day(5e-5), [], [])).toBeNull();
  });

  it('would ban for a week on a day 1 in 1,000,000 with enough kills', () => {
    expect(decide(day(5e-7), [], [])).toEqual({ tier: 2, rule: 'extreme-day', flaggedDays: 1 });
    // The same odds from 12 kills is not enough to act on.
    expect(decide(day(5e-7, { kills: 12 }), [], [])).toBeNull();
  });

  it('would kick on a day 1 in 100,000 with enough kills', () => {
    expect(decide(day(5e-6), [], [])).toEqual({ tier: 1, rule: 'strong-day', flaggedDays: 1 });
    expect(decide(day(5e-6, { kills: 24 }), [], [])).toBeNull();
  });

  it('counts flagged days within the window, once each, and not unflagged ones', () => {
    const before = day(4e-4, { day: '2026-10-20' });
    expect(decide(day(5e-4), [before], [])).toEqual({ tier: 2, rule: 'repeat-days', flaggedDays: 2 });
    expect(decide(day(5e-4), [before, before], [])?.flaggedDays).toBe(2);
    expect(decide(day(5e-4), [day(0.4, { day: '2026-10-20' })], [])).toBeNull();
    // Today is not counted twice if it is among the earlier days.
    expect(decide(day(5e-4), [day(5e-4)], [])).toBeNull();
  });

  it('lowers the mark to 1 in 10,000 for a VAC or game ban in the last year, never on the ban alone', () => {
    const banned = ['vacBan', 'recentBan'] as const;
    expect(decide(day(5e-5), [], banned)).toEqual({ tier: 1, rule: 'ban-and-headshots', flaggedDays: 1 });
    expect(decide(day(5e-4), [], banned)).toBeNull();
    expect(decide(day(5e-5), [], ['vacBan'])).toBeNull();
    expect(decide(day(5e-5), [], ['recentBan', 'communityBan'])).toBeNull();
    expect(decide(day(5e-5), [], ['newAccount', 'hidden'])).toBeNull();
  });

  it('takes the highest tier when several marks are met', () => {
    expect(decide(day(5e-7), [day(4e-4, { day: '2026-10-20' })], ['gameBan', 'recentBan'])?.tier).toBe(2);
  });

  it('keeps its marks where the review put them', () => {
    expect(AUTO_RULES).toMatchObject({ minKills: 25, strong: 100_000, withBan: 10_000, extreme: 1_000_000 });
  });
});

const entry = (more: Partial<ShadowEntry> = {}): ShadowEntry => ({
  steamId: '76561198000000001',
  name: 'Vex',
  day: '2026-10-24',
  at: NOW,
  tier: 1,
  rule: 'strong-day',
  kills: 30,
  headshots: 20,
  chance: 5e-6,
  flaggedDays: 1,
  ...more,
});

describe('the shadow log', () => {
  it('records a player once a day per tier, and again when it gets worse', () => {
    const first = recordShadow([], entry());
    expect(first).toHaveLength(1);
    expect(recordShadow(first!, entry({ at: NOW + 60_000 }))).toBeNull();
    const worse = recordShadow(first!, entry({ tier: 2, rule: 'extreme-day' }));
    expect(worse?.map((e) => e.tier)).toEqual([1, 2]);
    // A lower tier after a higher one is not worth writing.
    expect(recordShadow(worse!, entry())).toBeNull();
    // Another day is another entry.
    expect(recordShadow(first!, entry({ day: '2026-10-25', at: NOW + DAY }))).toHaveLength(2);
  });

  it('drops entries past 60 days', () => {
    const old = entry({ steamId: '76561198000000002', at: NOW - 61 * DAY });
    expect(recordShadow([old], entry())?.map((e) => e.steamId)).toEqual(['76561198000000001']);
  });

  it('reads nothing from anything unrecognisable', () => {
    expect(parseShadow(undefined)).toEqual([]);
    expect(parseShadow([{ steamId: 1 }])).toEqual([]);
    expect(parseShadow([entry()])).toEqual([entry()]);
  });
});

const outcome = (more: Partial<OutcomeEntry> = {}): OutcomeEntry => ({
  steamId: '76561198000000001',
  at: NOW + 60_000,
  by: '1',
  outcome: 'cheating',
  headshotDay: '2026-10-24',
  ...more,
});

describe('outcomes', () => {
  it('keeps the newest 1,000', () => {
    const full = Array.from({ length: 1_000 }, (_, i) => outcome({ at: i }));
    const next = addOutcome(full, outcome({ at: 5_000 }));
    expect(next).toHaveLength(1_000);
    expect(next[0]?.at).toBe(1);
    expect(parseOutcomes(next)).toHaveLength(1_000);
    expect(parseOutcomes('nope')).toEqual([]);
  });

  it('judges each shadow player by their latest outcome since being flagged', () => {
    const a = '76561198000000001';
    const b = '76561198000000002';
    const c = '76561198000000003';
    const d = '76561198000000004';
    const shadow = [entry({ steamId: a }), entry({ steamId: b, tier: 2, rule: 'extreme-day' }), entry({ steamId: c }), entry({ steamId: d })];
    const outcomes = [
      outcome({ steamId: a }),
      // A false alarm before being flagged does not count; the later cheating does.
      outcome({ steamId: b, outcome: 'false-alarm', at: NOW - DAY }),
      outcome({ steamId: b, outcome: 'cheating', at: NOW + 1 }),
      outcome({ steamId: c, outcome: 'false-alarm' }),
      outcome({ steamId: d, outcome: 'griefing' }),
    ];
    const s = summariseShadow(shadow, outcomes, NOW + DAY, 30);
    expect(s.players).toBe(4);
    expect(s.byTier).toEqual({ '1': 3, '2': 1 });
    expect(s.judged).toEqual({ cheating: 2, falseAlarm: 1, other: 1, pending: 0 });
    expect(s.precision).toBeCloseTo(0.667, 3);
    expect(s.outcomes).toEqual({ cheating: 2, 'false-alarm': 2, griefing: 1 });
  });

  it('has no precision until staff have judged one, and counts the rest as pending', () => {
    const s = summariseShadow([entry()], [], NOW, 30);
    expect(s.precision).toBeNull();
    expect(s.judged).toEqual({ cheating: 0, falseAlarm: 0, other: 0, pending: 1 });
    expect(summariseShadow([entry({ at: NOW - 40 * DAY })], [], NOW, 30).players).toBe(0);
  });
});
