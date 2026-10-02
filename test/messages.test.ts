import { describe, expect, it } from 'vitest';
import * as lines from '../src/lines.ts';
import { joinMessageDue, milestones, nextMessage, seedingMessage, seedingMessageDue, watchJoins, type MatchMessages } from '../src/messages.ts';
import type { MatchState } from '../src/tracking.ts';

const MINUTE = 60_000;
const rule = { siteHost: 'gaminginit.com', scoreToWin: 100 };
const vip = { seedDays: 3, seedMinutes: 10, windowDays: 7, lengthDays: 7 };

const match = (overrides: Partial<MatchState> = {}): MatchState => ({
  key: 'Europe#1',
  startedAt: 0,
  lastSeenAt: 0,
  liveAt: 0,
  summarisable: true,
  peakPlayers: 40,
  players: {},
  factionScores: [
    { name: 'Valkyra', score: 10 },
    { name: 'Kharr', score: 8 },
    { name: 'Haldor', score: 3 },
  ],
  ...overrides,
});

const scores = (valkyra: number, kharr: number, haldor = 0) => ({
  factionScores: [
    { name: 'Valkyra', score: valkyra },
    { name: 'Kharr', score: kharr },
    { name: 'Haldor', score: haldor },
  ],
});

// The first line of every list, so the texts are known.
const first = () => 0;

describe('milestones', () => {
  it('reaches ten minutes after the match went live', () => {
    expect(milestones(match(), 9 * MINUTE, rule, null, first)).toEqual([]);
    expect(milestones(match(), 10 * MINUTE, rule, null, first)).toEqual([
      { key: 'ten-minutes', text: '10 minutes in and nobody has rage quit yet. Rules are in our Discord, leaderboard at gaminginit.com' },
    ]);
  });

  it('never reaches ten minutes for a match not seen from its start, or not live', () => {
    expect(milestones(match({ summarisable: false }), 30 * MINUTE, rule, null)).toEqual([]);
    expect(milestones(match({ liveAt: null }), 30 * MINUTE, rule, null)).toEqual([]);
  });

  it('reaches halfway when a team has half the winning score, and mentions seeding when VIP is on', () => {
    expect(milestones(match(scores(49, 20)), 0, rule, null)).toEqual([]);
    expect(milestones(match(scores(50, 20)), 0, rule, null, first)).toEqual([
      {
        key: 'halfway',
        text: 'Halfway there! Valkyra leads on 50. Not my points, OUR points, comrade. Check the leaderboard and join our Discord at gaminginit.com',
      },
    ]);
    expect(milestones(match(scores(50, 20)), 0, rule, vip, first)[0]?.text).toBe(
      'Halfway there! Valkyra leads on 50. Not my points, OUR points, comrade. Seed on 3 days in a week and get a reserved slot. How at gaminginit.com',
    );
  });

  it("picks at random from the leading faction's own list, whatever the server calls it", () => {
    const halfway = (leader: string, random: () => number) =>
      milestones(match({ factionScores: [{ name: leader, score: 52 }, { name: 'Other', score: 10 }] }), 0, rule, null, random)[0]?.text.split(
        ' Check the',
      )[0];

    for (const [name, key] of [['Lonestar', 'lonestar'], ['MANTICORE', 'manticore'], ['Valkyra', 'valkyra'], ['Lone Star', 'lonestar']] as const) {
      const list = lines.HALFWAY[key] ?? [];
      const picked = list.map((_, i) => halfway(name, () => i / list.length));
      expect(picked).toEqual(list.map((line) => `Halfway there! ${line.replace('{score}', '52')}`));
    }
  });

  it('names only the leader, plainly for a team without a list, and nobody when the top teams are level', () => {
    const text = (s: ReturnType<typeof scores>) => milestones(match(s), 0, rule, null, first)[0]?.text.split(' Check the')[0];

    expect(text(scores(30, 50, 12))).toBe('Halfway there! Kharr leads on 50!');
    expect(text(scores(50, 50, 12))).toBe("Halfway there and it's neck and neck!");
  });

  it('reaches "nearly there" once per match, for the team in front, at 90% of the winning score', () => {
    expect(milestones(match(scores(92, 90, 60)), 0, rule, null).map((m) => m.key)).toEqual(['halfway', 'nearly']);
    expect(milestones(match(scores(90, 94, 60)), 0, rule, null, first)[1]?.text).toBe(
      'Kharr has 90 points! Where do you rank? Leaderboard, Discord and seeding at gaminginit.com',
    );
    expect(milestones(match(scores(92, 20)), 0, rule, null, first)[1]?.text).toBe(
      'Valkyra has 90! Victory for the motherland is in sight, comrades. Where do you rank? Leaderboard, Discord and seeding at gaminginit.com',
    );
    expect(milestones(match(scores(135, 20)), 0, { ...rule, scoreToWin: 150 }, null)[1]?.key).toBe('nearly');
  });

  it("picks the 90-point line at random from the leading faction's own list", () => {
    const list = lines.NEARLY['manticore'] ?? [];
    const picked = list.map(
      (_, i) =>
        milestones(match({ factionScores: [{ name: 'Manticore', score: 91 }] }), 0, rule, null, () => i / list.length)
          .find((m) => m.key === 'nearly')
          ?.text.split(' Where do you rank?')[0],
    );

    expect(picked).toEqual(list.map((line) => line.replace('{score}', '90')));
  });

  it('keeps messages short enough for the game', () => {
    const long = { factionScores: [{ name: 'x'.repeat(300), score: 95 }] };

    expect(milestones(match(long), 0, rule, null).every((m) => m.text.length <= 200)).toBe(true);
  });
});

describe('the lines', () => {
  const all = [
    ...lines.TEN_MINUTES,
    ...Object.values(lines.HALFWAY).flat(),
    ...lines.HALFWAY_LEVEL,
    ...Object.values(lines.NEARLY).flat(),
    ...lines.HALFWAY_OTHER,
    ...lines.NEARLY_OTHER,
  ];

  it('has something in every list, for all three factions', () => {
    for (const list of [lines.TEN_MINUTES, lines.HALFWAY_LEVEL, lines.HALFWAY_OTHER, lines.NEARLY_OTHER]) expect(list.length).toBeGreaterThan(0);
    for (const faction of ['lonestar', 'manticore', 'valkyra']) {
      expect(lines.HALFWAY[faction]?.length).toBeGreaterThan(0);
      expect(lines.NEARLY[faction]?.length).toBeGreaterThan(0);
    }
  });

  it('only uses {team}, {score} and {site}', () => {
    const used = all.flatMap((line) => [...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

    expect(used.every((name) => ['team', 'score', 'site'].includes(name ?? ''))).toBe(true);
    expect(lines.TEN_MINUTES.every((line) => line.includes('Discord') && line.includes('{site}'))).toBe(true);
  });

  it('has seeding lines that only use {needed}', () => {
    expect(lines.SEEDING.length).toBeGreaterThan(0);
    expect(lines.SEEDING.every((line) => [...line.matchAll(/\{(\w+)\}/g)].every((m) => m[1] === 'needed'))).toBe(true);
    expect(lines.SEEDING.every((line) => line.includes('{needed}'))).toBe(true);
  });

  it('fits every message in the game with its call to action, without cutting it', () => {
    const texts = [0, 0.25, 0.5, 0.75, 0.99].flatMap((r) => [
      ...milestones(match({ factionScores: [{ name: 'Manticore', score: 95 }] }), 10 * MINUTE, rule, vip, () => r),
      ...milestones(match({ factionScores: [{ name: 'Lonestar', score: 95 }] }), 0, rule, vip, () => r),
      ...milestones(match({ factionScores: [{ name: 'Valkyra', score: 95 }] }), 0, rule, vip, () => r),
      ...milestones(match({ factionScores: [{ name: 'Valkyra', score: 60 }, { name: 'Kharr', score: 60 }] }), 0, rule, vip, () => r),
    ]);

    expect(texts.every((m) => m.text.length <= 200 && !m.text.endsWith('…'))).toBe(true);
  });
});

describe('seedingMessage', () => {
  const site = { everyMs: 5 * MINUTE, siteHost: 'gaminginit.com' };
  const noSite = { everyMs: 5 * MINUTE, siteHost: null };

  it('says how many more players are needed to go live, and what seeding earns', () => {
    expect(seedingMessage(5, 20, site, vip, first)).toBe(
      "We're seeding! 15 more players and we go live. Seed for over 10 min on 3 days in a week and get a reserved slot. How at gaminginit.com",
    );
    expect(seedingMessage(19, 20, noSite, vip, first)).toBe(
      "We're seeding! 1 more player and we go live. Seed for over 10 min on 3 days in a week and get a reserved slot.",
    );
  });

  it('points at the top seeders board without VIP, and just thanks seeders without a website either', () => {
    expect(seedingMessage(5, 20, site, null, first)).toBe("We're seeding! 15 more players and we go live. Top seeders make the leaderboard at gaminginit.com");
    expect(seedingMessage(5, 20, noSite, null, first)).toBe("We're seeding! 15 more players and we go live. Thanks for helping get it live!");
  });

  it('picks the line at random', () => {
    const picked = lines.SEEDING.map((_, i) => seedingMessage(17, 20, noSite, null, () => i / lines.SEEDING.length).split(' Thanks for helping')[0]);

    expect(picked).toEqual(lines.SEEDING.map((line) => line.replace('{needed}', '3 more players')));
  });

  it('fits every line in the game with the longest reward, without cutting it', () => {
    const rule = { everyMs: 5 * MINUTE, siteHost: 'community.example-gaming-site.com' };
    const texts = lines.SEEDING.map((_, i) => seedingMessage(1, 100, rule, { ...vip, seedMinutes: 120 }, () => i / lines.SEEDING.length));

    expect(texts.every((text) => text.length <= 200 && !text.endsWith('…'))).toBe(true);
  });

  it('is due every few minutes, allowing for checks that land a little early', () => {
    expect(seedingMessageDue(null, 0, site, MINUTE)).toBe(true);
    expect(seedingMessageDue(0, 4 * MINUTE, site, MINUTE)).toBe(false);
    expect(seedingMessageDue(0, 5 * MINUTE - 20_000, site, MINUTE)).toBe(true);
    expect(seedingMessageDue(0, 5 * MINUTE, site, MINUTE)).toBe(true);
  });
});

describe('watchJoins', () => {
  it('counts nobody as joining on the first reading', () => {
    expect(watchJoins(null, ['a', 'b'], 0, true)).toEqual({ online: ['a', 'b'], lastJoinAt: null });
  });

  it('notes when the latest player joined, and not when someone leaves', () => {
    const first = watchJoins({ online: ['a'], lastJoinAt: null }, ['a', 'b'], 10_000, true);
    const second = watchJoins(first, ['a', 'b', 'c'], 20_000, true);
    const left = watchJoins(second, ['a', 'c'], 25_000, true);

    expect([first.lastJoinAt, second.lastJoinAt, left.lastJoinAt]).toEqual([10_000, 20_000, 20_000]);
    expect(left.online).toEqual(['a', 'c']);
  });

  it('drops a waiting message when one cannot go out', () => {
    expect(watchJoins({ online: ['a'], lastJoinAt: 5_000 }, ['a', 'b'], 10_000, false)).toEqual({ online: ['a', 'b'], lastJoinAt: null });
  });

  it('is due 30 seconds after the latest join', () => {
    expect(joinMessageDue({ online: [], lastJoinAt: null }, 60_000)).toBe(false);
    expect(joinMessageDue({ online: [], lastJoinAt: 10_000 }, 39_999)).toBe(false);
    expect(joinMessageDue({ online: [], lastJoinAt: 10_000 }, 40_000)).toBe(true);
  });
});

describe('nextMessage', () => {
  const run = (steps: { at: number; match: MatchState }[], start: MatchMessages | null = null) =>
    steps.reduce<{ messages: MatchMessages | null; sent: (string | null)[] }>(
      (acc, step) => {
        const { messages, send } = nextMessage(acc.messages, step.match, step.at, rule, null, first);
        return { messages, sent: [...acc.sent, send] };
      },
      { messages: start, sent: [] },
    );

  it('sends each message once, one per check, in order, and "nearly there" only for the first team', () => {
    const { sent } = run([
      { at: 0, match: match() },
      { at: 10 * MINUTE, match: match(scores(55, 30)) },
      { at: 11 * MINUTE, match: match(scores(60, 30)) },
      { at: 12 * MINUTE, match: match(scores(70, 40)) },
      { at: 30 * MINUTE, match: match(scores(90, 60)) },
      { at: 31 * MINUTE, match: match(scores(91, 90)) },
      { at: 32 * MINUTE, match: match(scores(95, 92)) },
    ]);

    expect(sent.map((s) => s?.split(' ')[0] ?? null)).toEqual([null, '10', 'Halfway', null, 'Valkyra', null, null]);
  });

  it('does not announce late what a match reached before it was first seen', () => {
    const { sent } = run([
      { at: 20 * MINUTE, match: match(scores(95, 60)) },
      { at: 21 * MINUTE, match: match(scores(96, 91)) },
    ]);

    expect(sent).toEqual([null, null]);
  });

  it('counts "nearly there" as sent when a match saved before the change sent it for a team', () => {
    const { sent } = run([{ at: 30 * MINUTE, match: match(scores(55, 92)) }], { match: 0, sent: ['ten-minutes', 'halfway', 'nearly:Valkyra'] });

    expect(sent).toEqual([null]);
  });

  it('starts again for the next match', () => {
    const { sent } = run([
      { at: 0, match: match() },
      { at: 5 * MINUTE, match: match(scores(55, 30)) },
      { at: 40 * MINUTE, match: match({ startedAt: 40 * MINUTE, liveAt: 40 * MINUTE, ...scores(0, 0) }) },
      { at: 60 * MINUTE, match: match({ startedAt: 40 * MINUTE, liveAt: 40 * MINUTE, ...scores(51, 30) }) },
    ]);

    expect(sent.map((s) => s?.split(' ')[0] ?? null)).toEqual([null, 'Halfway', null, '10']);
  });
});
