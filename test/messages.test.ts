import { describe, expect, it } from 'vitest';
import { milestones, nextMessage, type MatchMessages } from '../src/messages.ts';
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

describe('milestones', () => {
  it('reaches ten minutes after the match went live', () => {
    expect(milestones(match(), 9 * MINUTE, rule, null)).toEqual([]);
    expect(milestones(match(), 10 * MINUTE, rule, null)).toEqual([
      { key: 'ten-minutes', text: 'Enjoying the match? Server rules are in our Discord. Join it and see the leaderboard at gaminginit.com' },
    ]);
  });

  it('never reaches ten minutes for a match not seen from its start, or not live', () => {
    expect(milestones(match({ summarisable: false }), 30 * MINUTE, rule, null)).toEqual([]);
    expect(milestones(match({ liveAt: null }), 30 * MINUTE, rule, null)).toEqual([]);
  });

  it('reaches halfway when a team has half the winning score, and mentions seeding when VIP is on', () => {
    expect(milestones(match(scores(49, 20)), 0, rule, null)).toEqual([]);
    expect(milestones(match(scores(50, 20)), 0, rule, null)).toEqual([
      {
        key: 'halfway',
        text: 'Halfway there! Valkyra leads on 50. Not my points, OUR points, comrade. Check the leaderboard and join our Discord at gaminginit.com',
      },
    ]);
    expect(milestones(match(scores(50, 20)), 0, rule, vip)[0]?.text).toBe(
      'Halfway there! Valkyra leads on 50. Not my points, OUR points, comrade. Seed on 3 days in a week and get a reserved slot. How at gaminginit.com',
    );
  });

  it('has a line for whichever of the three factions leads at halfway, which changes from match to match', () => {
    const halfway = (leader: string, startedAt = 0) =>
      milestones(
        match({
          startedAt,
          factionScores: [
            { name: 'Lonestar', score: leader === 'Lonestar' ? 52 : 10 },
            { name: 'Valkyra', score: leader === 'Valkyra' ? 52 : 20 },
            { name: 'MANTICORE', score: leader === 'MANTICORE' ? 52 : 30 },
          ],
        }),
        0,
        rule,
        null,
      )[0]?.text.split(' Check the')[0];

    expect(halfway('Lonestar')).toBe('Halfway there! Lonestar leads on 52! Screenshot it, this never happens.');
    expect(halfway('Lonestar', 60_000)).toBe('Halfway there! Lonestar leads on 52! The default pick is cooking. Yeehaw.');
    expect(halfway('MANTICORE')).toBe('Halfway there! Manticore leads on 52. Green winning? Shocking. Truly.');
    expect(halfway('MANTICORE', 60_000)).toBe('Halfway there! Manticore leads on 52. The shadow army doing shadow army things.');
    expect(halfway('Valkyra')).toBe('Halfway there! Valkyra leads on 52. Not my points, OUR points, comrade.');
    expect(halfway('Valkyra', 60_000)).toBe('Halfway there! Valkyra leads on 52. Restoring greatness, one point at a time.');
  });

  it('names only the leader, plainly for a team it has no line for, and nobody when the top teams are level', () => {
    const text = (s: ReturnType<typeof scores>) => milestones(match(s), 0, rule, null)[0]?.text.split(' Check the')[0];

    expect(text(scores(30, 50, 12))).toBe('Halfway there! Kharr leads on 50!');
    expect(text(scores(50, 50, 12))).toBe("Halfway there and it's neck and neck!");
  });

  it('reaches "nearly there" once per match, for the team in front, at 90% of the winning score', () => {
    expect(milestones(match(scores(92, 90, 60)), 0, rule, null).map((m) => m.key)).toEqual(['halfway', 'nearly']);
    expect(milestones(match(scores(90, 94, 60)), 0, rule, null)[1]?.text).toBe(
      'Kharr has 90 points! Where do you rank? Leaderboard, Discord and seeding at gaminginit.com',
    );
    expect(milestones(match(scores(92, 20)), 0, rule, null)[1]?.text).toBe(
      'Valkyra has 90 points! Where do you rank? Leaderboard, Discord and seeding at gaminginit.com',
    );
    expect(milestones(match(scores(135, 20)), 0, { ...rule, scoreToWin: 150 }, null)[1]?.key).toBe('nearly');
  });

  it('keeps messages short enough for the game', () => {
    const long = { factionScores: [{ name: 'x'.repeat(300), score: 95 }] };

    expect(milestones(match(long), 0, rule, null).every((m) => m.text.length <= 200)).toBe(true);
  });
});

describe('nextMessage', () => {
  const run = (steps: { at: number; match: MatchState }[], start: MatchMessages | null = null) =>
    steps.reduce<{ messages: MatchMessages | null; sent: (string | null)[] }>(
      (acc, step) => {
        const { messages, send } = nextMessage(acc.messages, step.match, step.at, rule, null);
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

    expect(sent.map((s) => s?.split(' ')[0] ?? null)).toEqual([null, 'Enjoying', 'Halfway', null, 'Valkyra', null, null]);
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

    expect(sent.map((s) => s?.split(' ')[0] ?? null)).toEqual([null, 'Halfway', null, 'Enjoying']);
  });
});
