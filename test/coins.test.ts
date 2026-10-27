import { describe, expect, it } from 'vitest';
import {
  adjust,
  blankAccount,
  buy,
  canBuy,
  catalogue,
  coinsInfo,
  dayMissions,
  itemById,
  migrationGrant,
  missionsFor,
  onBreak,
  onKills,
  onMatch,
  onPlay,
  onSeed,
  parseAccount,
  playerCoins,
  reroll,
  rolled,
  setTitle,
  topEarners,
  weekOf,
  type CoinRule,
} from '../src/coins.ts';

const rule: CoinRule = {
  seed: 150,
  seedMinutesPer: 2,
  seedMinutesCap: 30,
  playMinutesPer: 10,
  match: 6,
  win: 6,
  matchesPaid: 6,
  activityCap: 100,
  vipDayPrice: 100,
  vipWeekPrice: 600,
  vipAheadDays: 14,
  rerollPrice: 40,
  roles: [{ id: '123', name: 'Night Owl', price: 1500 }],
  streaks: true,
  playedLeast: 3,
};

// Tuesday 27 October 2026, midday UTC.
const NOW = Date.parse('2026-10-27T12:00:00Z');
const DAY = 86_400_000;

describe('weeks', () => {
  it('start on Monday, UTC', () => {
    expect(weekOf(NOW)).toBe('2026-10-26');
    expect(weekOf(Date.parse('2026-11-01T23:59:00Z'))).toBe('2026-10-26');
    expect(weekOf(Date.parse('2026-11-02T00:00:00Z'))).toBe('2026-11-02');
  });
});

describe('missions', () => {
  it('are three a day and three a week, easiest first, the same for everyone', () => {
    const day = missionsFor('day', '2026-10-27', rule);
    expect(day.map((m) => m.tier)).toEqual([0, 1, 2]);
    expect(missionsFor('day', '2026-10-27', rule)).toEqual(day);
    expect(missionsFor('week', '2026-10-26', rule).map((m) => m.tier)).toEqual([0, 1, 2]);
  });

  it('leave out the kill streak mission when streaks are off', () => {
    for (let i = 0; i < 60; i++) {
      const key = new Date(NOW + i * DAY).toISOString().slice(0, 10);
      expect(missionsFor('day', key, { streaks: false }).some((m) => m.id === 'd-streak-end')).toBe(false);
    }
  });

  it('pay once when done, and not again', () => {
    let a = blankAccount('Ash', NOW);
    const [easy] = dayMissions(a, rule);
    expect(easy).toBeDefined();
    let paid = 0;
    for (let i = 0; i < 12; i++) {
      const r = onMatch(a, { id: NOW + i, kills: 12, deaths: 3, won: true }, NOW + i * 1000, rule);
      a = r.account;
      paid += r.completed.filter((c) => c.mission.scope === 'day').reduce((sum, c) => sum + c.paid, 0);
    }
    const day = dayMissions(a, rule);
    expect(day.every((m) => a.day.done.includes(m.id))).toBe(true);
    expect(paid).toBe(day.reduce((sum, m) => sum + m.reward, 0));
  });
});

describe('seeding', () => {
  it('pays the seed and the minutes past the least, once a day', () => {
    const first = onSeed(blankAccount('Ash', NOW), 30, 10, NOW, rule);
    // 150 + (30 - 10) / 2 = 10 more
    expect(first.account.balance).toBeGreaterThanOrEqual(160);
    expect(first.account.day.m.seeded).toBe(1);
    const again = onSeed(first.account, 30, 10, NOW + 60_000, rule);
    expect(again.paid).toBe(0);
    expect(again.account.balance).toBe(first.account.balance);
  });

  it('caps the minutes bonus', () => {
    const r = onSeed(blankAccount('Ash', NOW), 600, 10, NOW, rule);
    expect(r.account.log.find((t) => t.why === 'seed-time')?.delta).toBe(30);
  });

  it('counts the week for the weekly seed missions', () => {
    let a = blankAccount('Ash', NOW);
    for (let i = 0; i < 3; i++) a = onSeed(a, 20, 10, NOW + i * DAY, rule).account;
    expect(rolled(a, NOW + 2 * DAY).week.m.seedDays).toBe(3);
  });
});

describe('playing', () => {
  it('pays a coin per block of minutes, with the cap', () => {
    let a = blankAccount('Ash', NOW);
    for (let i = 0; i < 25; i++) a = onPlay(a, 1, NOW + i * 60_000, rule).account;
    expect(a.day.m.minutes).toBe(25);
    expect(a.log.filter((t) => t.why === 'play').reduce((sum, t) => sum + t.delta, 0)).toBe(2);
  });

  it('stops paying activity at the day cap, but missions still pay', () => {
    let a = blankAccount('Ash', NOW);
    for (let i = 0; i < 12 * 60; i++) a = onPlay(a, 1, NOW + i * 1000, { ...rule, activityCap: 5 }).account;
    expect(a.day.activity).toBe(5);
  });

  it('starts again the next day', () => {
    let a = blankAccount('Ash', NOW);
    for (let i = 0; i < 30; i++) a = onPlay(a, 1, NOW + i * 60_000, rule).account;
    const next = onPlay(a, 10, NOW + DAY, rule).account;
    expect(next.day.m.minutes).toBe(10);
  });
});

describe('matches', () => {
  it('pays for a played match and a win, once per match', () => {
    const r = onMatch(blankAccount('Ash', NOW), { id: 1, kills: 5, deaths: 4, won: true }, NOW, rule);
    expect(r.account.log.map((t) => t.why)).toEqual(expect.arrayContaining(['match', 'win']));
    const again = onMatch(r.account, { id: 1, kills: 5, deaths: 4, won: true }, NOW + 1, rule);
    expect(again.account.balance).toBe(r.account.balance);
    expect(again.account.day.m.matches).toBe(1);
  });

  it('pays nothing for sitting in a match', () => {
    const r = onMatch(blankAccount('Ash', NOW), { id: 1, kills: 0, deaths: 1, won: true }, NOW, rule);
    expect(r.account.balance).toBe(0);
    expect(r.account.day.m.matches).toBe(0);
  });

  it('pays the first few matches of the day only', () => {
    let a = blankAccount('Ash', NOW);
    for (let i = 1; i <= 10; i++) a = onMatch(a, { id: i, kills: 5, deaths: 5, won: false }, NOW + i, rule).account;
    expect(a.day.m.matches).toBe(10);
    expect(a.log.filter((t) => t.why === 'match')).toHaveLength(6);
  });

  it('tracks the best match for the kills in one match mission', () => {
    let a = onMatch(blankAccount('Ash', NOW), { id: 1, kills: 4, deaths: 4, won: false }, NOW, rule).account;
    a = onMatch(a, { id: 2, kills: 14, deaths: 4, won: false }, NOW + 1, rule).account;
    expect(a.day.m.bestKills).toBe(14);
    expect(a.day.m.kills).toBe(18);
  });
});

describe('kill streaks', () => {
  it('count once per kill', () => {
    const a = onBreak(blankAccount('Ash', NOW), 'e1', NOW, rule).account;
    expect(onBreak(a, 'e1', NOW, rule).account.day.m.breaks).toBe(1);
    expect(onBreak(a, 'e2', NOW, rule).account.day.m.breaks).toBe(2);
  });
});

describe('kill feed missions', () => {
  const feed: CoinRule = { ...rule, feed: true, weapons: { day: { tag: 'Id.Item.Mosin', name: 'Mosin Nagant' }, week: { tag: 'Id.Item.MP5', name: 'MP5' } } };
  const none = { kills: 0, headshots: 0, streak: 0, dayWeapon: 0, dayWeaponHeads: 0, weekWeapon: 0, weekWeaponHeads: 0 };
  const ids = (r: CoinRule, scope: 'day' | 'week') =>
    new Set(Array.from({ length: 80 }, (_, i) => missionsFor(scope, new Date(Date.parse('2026-01-05T00:00:00Z') + i * 7 * DAY).toISOString().slice(0, 10), r).map((m) => m.id)).flat());

  it('are only offered with the kill feed, and the weapon ones only with a weapon to ask for', () => {
    const wanted = (r: CoinRule) => [...ids(r, 'day'), ...ids(r, 'week')].filter((id) => /heads|streak-[0-9]|weapon/.test(id));
    expect(wanted(rule)).toEqual([]);
    expect(wanted({ ...rule, feed: true, weapons: null }).some((id) => id.includes('weapon'))).toBe(false);
    expect(wanted({ ...rule, feed: true, weapons: null }).length).toBeGreaterThan(0);
    expect(wanted(feed).some((id) => id.includes('weapon'))).toBe(true);
  });

  it('name the weapon in the mission', () => {
    const texts = [...Array.from(ids(feed, 'day')), ...Array.from(ids(feed, 'week'))];
    expect(texts.length).toBeGreaterThan(0);
    const all = Array.from({ length: 200 }, (_, i) => new Date(Date.parse('2026-01-01T00:00:00Z') + i * DAY).toISOString().slice(0, 10)).flatMap((key) => missionsFor('day', key, feed));
    const weapon = all.find((m) => m.id.startsWith('d-weapon'));
    expect(weapon?.text).toContain('Mosin Nagant');
    expect(weapon?.text).not.toContain('{weapon}');
    const week = Array.from({ length: 80 }, (_, i) => new Date(Date.parse('2026-01-05T00:00:00Z') + i * 7 * DAY).toISOString().slice(0, 10)).flatMap((key) => missionsFor('week', key, feed));
    expect(week.find((m) => m.id.startsWith('w-weapon'))?.text).toContain('MP5');
  });

  it('count headshots, the best streak and the weapons, and pay a mission when it is done', () => {
    let a = blankAccount('Ash', NOW);
    a = onKills(a, { ...none, kills: 5, headshots: 3, streak: 4, dayWeapon: 2, dayWeaponHeads: 1, weekWeapon: 1 }, NOW, feed).account;
    a = onKills(a, { ...none, kills: 2, headshots: 2, streak: 2, dayWeapon: 1, weekWeaponHeads: 1 }, NOW + 1000, feed).account;
    expect(a.day.m).toMatchObject({ headshots: 5, bestStreak: 4, weaponKills: 3, weaponHeads: 1 });
    expect(a.week.m).toMatchObject({ headshots: 5, bestStreak: 4, weaponKills: 1, weaponHeads: 1 });
  });

  it('pay the streak and headshot missions of the day', () => {
    // Find a day that asks for a streak.
    const key = Array.from({ length: 200 }, (_, i) => new Date(Date.parse('2026-01-01T00:00:00Z') + i * DAY).toISOString().slice(0, 10)).find((k) =>
      missionsFor('day', k, feed).some((m) => m.id === 'd-streak-4'),
    );
    expect(key).toBeDefined();
    const at = Date.parse(`${key}T12:00:00Z`);
    const done = onKills(blankAccount('Ash', at), { ...none, kills: 4, streak: 4 }, at, feed);
    expect(done.completed.map((c) => c.mission.id)).toContain('d-streak-4');
    expect(done.paid).toBeGreaterThanOrEqual(15);
  });

  it('name the weapon of a mission swapped in', () => {
    const a = { ...blankAccount('Ash', NOW), balance: 1000 };
    for (let slot = 0; slot < 3; slot++) {
      const r = reroll(a, slot, NOW, feed);
      if (r.ok) expect(r.mission.text).not.toContain('{weapon}');
    }
  });
});

describe('the shop', () => {
  const rich = { ...blankAccount('Ash', NOW), balance: 5000 };

  it('sells whitelist days, titles and the configured roles', () => {
    expect(catalogue(rule).map((i) => i.id)).toEqual(
      expect.arrayContaining(['vip-1', 'vip-7', 'title-seeder', 'role-123']),
    );
  });

  it('takes the price', () => {
    const item = itemById(rule, 'vip-7');
    expect(item).toBeDefined();
    if (item === undefined) return;
    expect(canBuy(rich, item, null, NOW, rule)).toEqual({ ok: true });
    const bought = buy(rich, item, NOW);
    expect(bought.balance).toBe(4400);
    expect(bought.spent).toBe(600);
  });

  it('refuses when they cannot afford it', () => {
    const item = itemById(rule, 'vip-7');
    if (item === undefined) throw new Error('no item');
    const check = canBuy({ ...rich, balance: 599 }, item, null, NOW, rule);
    expect(check.ok).toBe(false);
  });

  it('will not stockpile whitelist beyond the days ahead', () => {
    const week = itemById(rule, 'vip-7');
    if (week === undefined) throw new Error('no item');
    // 10 days left: 10 + 7 is over 14
    expect(canBuy(rich, week, NOW + 10 * DAY, NOW, rule).ok).toBe(false);
    // 7 days left: 14 exactly is fine
    expect(canBuy(rich, week, NOW + 7 * DAY, NOW, rule).ok).toBe(true);
  });

  it('sells each title once and the first becomes the one shown', () => {
    const item = itemById(rule, 'title-grunt');
    if (item === undefined) throw new Error('no item');
    const bought = buy(rich, item, NOW);
    expect(bought.title).toBe('title-grunt');
    expect(canBuy(bought, item, null, NOW, rule).ok).toBe(false);
    expect(setTitle(bought, 'title-alpha')).toBeNull();
    expect(setTitle(bought, null)?.title).toBeNull();
  });

  it('gives a role back for nothing once owned', () => {
    const item = itemById(rule, 'role-123');
    if (item === undefined) throw new Error('no item');
    const once = buy(rich, item, NOW);
    expect(once.balance).toBe(3500);
    const poor = { ...once, balance: 0 };
    expect(canBuy(poor, item, null, NOW, rule).ok).toBe(true);
    expect(buy(poor, item, NOW).balance).toBe(0);
  });
});

describe('swapping a mission', () => {
  it('costs coins, picks another of the same tier, and is limited', () => {
    let a = { ...blankAccount('Ash', NOW), balance: 1000 };
    const before = dayMissions(a, rule);
    const r = reroll(a, 0, NOW, rule);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.account.balance).toBe(960);
    expect(r.mission.tier).toBe(before[0]?.tier);
    expect(r.mission.id).not.toBe(before[0]?.id);
    a = r.account;
    expect(dayMissions(a, rule)[0]?.id).toBe(r.mission.id);
    for (let i = 0; i < 2; i++) {
      const next = reroll(a, 1, NOW, rule);
      if (next.ok) a = next.account;
    }
    expect(reroll(a, 2, NOW, rule).ok).toBe(false);
  });

  it('refuses without the coins', () => {
    expect(reroll(blankAccount('Ash', NOW), 0, NOW, rule).ok).toBe(false);
  });
});

describe('staff and the move from VIP', () => {
  it('gives and takes coins, never below 0', () => {
    const a = adjust(blankAccount('Ash', NOW), 100, 'event', NOW);
    expect(a.balance).toBe(100);
    expect(adjust(a, -500, 'oops', NOW).balance).toBe(0);
  });

  it('gives seeders what their seeds would have earned, once', () => {
    const once = migrationGrant(blankAccount('Ash', NOW), 4, false, NOW, rule);
    expect(once.balance).toBe(600);
    expect(migrationGrant(once, 4, false, NOW, rule).balance).toBe(600);
    expect(migrationGrant(blankAccount('Bea', NOW), 0, false, NOW, rule).balance).toBe(0);
  });
});

describe('seeds on the day of the move, and late events', () => {
  it('pays a seed from today once, whichever of the move and the live seed comes first', () => {
    const moved = migrationGrant(blankAccount('Ash', NOW), 2, true, NOW, rule);
    expect(moved.balance).toBe(450);
    // The live seed finds today's already paid.
    expect(onSeed(moved, 30, 10, NOW + 60_000, rule).paid).toBe(0);
    // And the other way round: the move leaves a seed already paid today alone.
    const seeded = onSeed(blankAccount('Bea', NOW), 30, 10, NOW, rule).account;
    expect(migrationGrant(seeded, 2, true, NOW + 1, rule).balance).toBe(seeded.balance + 300);
  });

  it('does not pay a second seed for a day when busy play has pushed the seed out of the recent keys', () => {
    let a = onSeed(blankAccount('Ash', NOW), 20, 10, NOW, rule).account;
    for (let i = 1; i <= 90; i++) a = onBreak(a, `e${i}`, NOW + i, rule).account;
    expect(a.keys.includes(`seed:2026-10-27`)).toBe(false);
    expect(onSeed(a, 20, 10, NOW + 100_000, rule).paid).toBe(0);
    expect(a.week.m.seedDays).toBe(1);
  });

  it('counts an event from before midnight in the account’s current day, never rolling it back', () => {
    const lateEvening = Date.parse('2026-10-27T23:59:30Z');
    let a = blankAccount('Ash', lateEvening);
    a = onPlay(a, 30, lateEvening + 60_000, rule).account;
    expect(a.day.day).toBe('2026-10-28');
    const before = a.day.m.minutes;
    a = onMatch(a, { id: lateEvening, kills: 5, deaths: 5, won: true }, lateEvening, rule).account;
    expect(a.day.day).toBe('2026-10-28');
    expect(a.day.m.minutes).toBe(before);
    expect(a.day.m.matches).toBe(1);
  });
});

describe('what is shown', () => {
  it('lists the leaders by what they earned, not what they hold', () => {
    const rows = topEarners(
      [
        ['1', { ...blankAccount('Ash', NOW), earned: 500, balance: 0 }],
        ['2', { ...blankAccount('Bea', NOW), earned: 900, balance: 900 }],
        ['3', { ...blankAccount('Cal', NOW), earned: 0 }],
      ],
      10,
    );
    expect(rows.map((r) => r.name)).toEqual(['Bea', 'Ash']);
  });

  it('builds a player view and the public info', () => {
    const view = playerCoins({ ...blankAccount('Ash', NOW), balance: 700 }, null, true, NOW, rule);
    expect(view.daily).toHaveLength(3);
    expect(view.weekly).toHaveLength(3);
    expect(view.shop.find((s) => s.id === 'vip-7')?.afford).toBe(true);
    expect(view.shop.find((s) => s.id === 'title-alpha')?.afford).toBe(false);
    const info = coinsInfo(rule, NOW);
    expect(info.prices.vipWeek).toBe(600);
    expect(info.missions.daily).toHaveLength(3);
  });

  it('reads back what was saved and refuses what was not', () => {
    const a = onMatch(blankAccount('Ash', NOW), { id: 1, kills: 5, deaths: 4, won: true }, NOW, rule).account;
    expect(parseAccount(JSON.parse(JSON.stringify(a)))).toEqual(a);
    expect(parseAccount({ nonsense: true })).toBeNull();
  });
});

describe('balance', () => {
  // A week of the game for a few kinds of player, against the whitelist price. The point of the numbers: seeding is the
  // way to keep VIP, and playing alone gets it much more slowly.
  const week = (seedDays: number, playDays: number, minutesPerDay: number, matchesPerDay: number): number => {
    let a = blankAccount('Ash', Date.parse('2026-10-26T08:00:00Z'));
    for (let d = 0; d < 7; d++) {
      const at = Date.parse('2026-10-26T08:00:00Z') + d * DAY;
      if (d < seedDays) a = onSeed(a, 25, 10, at, rule).account;
      if (d < playDays) {
        for (let m = 0; m < minutesPerDay; m++) a = onPlay(a, 1, at + m * 60_000, rule).account;
        for (let i = 0; i < matchesPerDay; i++) a = onMatch(a, { id: at + i, kills: 8, deaths: 6, won: i % 2 === 0 }, at + i * 1000, rule).account;
      }
    }
    return a.earned;
  };

  it('keeps a player who seeds 3 days a week in whitelist', () => {
    expect(week(3, 0, 0, 0)).toBeGreaterThanOrEqual(rule.seed * 3);
    expect(week(3, 3, 60, 3)).toBeGreaterThanOrEqual(rule.vipWeekPrice);
  });

  it('takes a player who only plays much longer', () => {
    expect(week(0, 4, 90, 4)).toBeLessThan(rule.vipWeekPrice);
  });
});
