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
      { key: 'ten-minutes', text: 'Enjoying the match? Join our Discord and see the leaderboard at gaminginit.com' },
    ]);
  });

  it('never reaches ten minutes for a match not seen from its start, or not live', () => {
    expect(milestones(match({ summarisable: false }), 30 * MINUTE, rule, null)).toEqual([]);
    expect(milestones(match({ liveAt: null }), 30 * MINUTE, rule, null)).toEqual([]);
  });

  it('reaches halfway when a team has half the winning score, saying who is ahead, and mentions seeding when VIP is on', () => {
    const two = (valkyra: number, kharr: number) => ({
      factionScores: [
        { name: 'Valkyra', score: valkyra },
        { name: 'Kharr', score: kharr },
      ],
    });

    expect(milestones(match(scores(49, 20)), 0, rule, null)).toEqual([]);
    expect(milestones(match(two(50, 20)), 0, rule, null)).toEqual([
      {
        key: 'halfway',
        text: 'Halfway there! Valkyra leads Kharr 50 to 20. Check the leaderboard and join our Discord at gaminginit.com',
      },
    ]);
    expect(milestones(match(two(20, 50)), 0, rule, vip)[0]?.text).toBe(
      'Halfway there! Kharr leads Valkyra 50 to 20. Seed on 3 days in a week and get a reserved slot. How at gaminginit.com',
    );
  });

  it('names every team at halfway when there are three, and says when the leaders are level', () => {
    const text = (s: ReturnType<typeof scores>) => milestones(match(s), 0, rule, null)[0]?.text;

    expect(text(scores(30, 50, 12))).toBe(
      'Halfway there! Kharr leads on 50, Valkyra 30, Haldor 12. Check the leaderboard and join our Discord at gaminginit.com',
    );
    expect(text(scores(50, 50, 12))).toBe(
      "Halfway there! It's level: Valkyra 50, Kharr 50, Haldor 12. Check the leaderboard and join our Discord at gaminginit.com",
    );
  });

  it('reaches "nearly there" once for each team at 90% of the winning score', () => {
    expect(milestones(match(scores(92, 90, 60)), 0, rule, null).map((m) => m.key)).toEqual([
      'halfway',
      'nearly:Valkyra',
      'nearly:Kharr',
    ]);
    expect(milestones(match(scores(92, 20)), 0, rule, null)[1]?.text).toBe(
      'Valkyra has 90 points! Where do you rank? Leaderboard, Discord and seeding at gaminginit.com',
    );
    expect(milestones(match(scores(135, 20)), 0, { ...rule, scoreToWin: 150 }, null)[1]?.key).toBe('nearly:Valkyra');
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

  it('sends each message once, one per check, in order', () => {
    const { sent } = run([
      { at: 0, match: match() },
      { at: 10 * MINUTE, match: match(scores(55, 30)) },
      { at: 11 * MINUTE, match: match(scores(60, 30)) },
      { at: 12 * MINUTE, match: match(scores(70, 40)) },
      { at: 30 * MINUTE, match: match(scores(90, 60)) },
      { at: 31 * MINUTE, match: match(scores(91, 90)) },
      { at: 32 * MINUTE, match: match(scores(95, 92)) },
    ]);

    expect(sent.map((s) => s?.split(' ')[0] ?? null)).toEqual([null, 'Enjoying', 'Halfway', null, 'Valkyra', 'Kharr', null]);
  });

  it('does not announce late what a match reached before it was first seen', () => {
    const { sent } = run([
      { at: 20 * MINUTE, match: match(scores(95, 60)) },
      { at: 21 * MINUTE, match: match(scores(96, 91)) },
    ]);

    expect(sent).toEqual([null, 'Kharr has 90 points! Where do you rank? Leaderboard, Discord and seeding at gaminginit.com']);
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
