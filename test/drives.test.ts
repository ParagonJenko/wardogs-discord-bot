import { describe, expect, it } from 'vitest';
import {
  buildChallengeMessage,
  buildPlayerOfMonthMessage,
  challengeFor,
  CHALLENGES,
  mostMvps,
  parseDrives,
  type DriveSources,
} from '../src/drives.ts';
import type { MatchRecord, PlayerTotals } from '../src/players.ts';
import { PRIVATE_NAME } from '../src/privacy.ts';

const WEEK_MS = 7 * 24 * 60 * 60_000;

const record = (endedAt: number, players: [string, number, number, string?][], scores: [string, number][] = []): MatchRecord => ({
  map: 'Ozeti',
  startedAt: endedAt - 1,
  liveAt: endedAt - 1,
  endedAt,
  durationMs: 1,
  peakPlayers: 40,
  factionScores: scores.map(([name, score]) => ({ name, score })),
  players: players.map(([steamId, kills, deaths, faction]) => ({ steamId, name: steamId.toUpperCase(), kills, deaths, ...(faction ? { faction } : {}) })),
});

const day = (rows: Record<string, Partial<PlayerTotals>>) =>
  Object.fromEntries(
    Object.entries(rows).map(([steamId, t]) => [
      steamId,
      { name: steamId.toUpperCase(), seedingMinutes: 0, liveMinutes: 0, seedDays: 0, matches: 0, kills: 0, deaths: 0, ...t },
    ]),
  );

const sources: DriveSources = {
  days: [day({ a: { kills: 30, seedDays: 1, seedingMinutes: 40, liveMinutes: 100 } }), day({ b: { kills: 40, liveMinutes: 600 }, a: { seedDays: 1 } })],
  matches: [
    record(1, [['a', 10, 2, 'Valkyra'], ['b', 25, 1, 'Lonestar']], [['Valkyra', 100], ['Lonestar', 80]]),
    record(2, [['a', 12, 0, 'Valkyra'], ['b', 12, 0, 'Lonestar']], [['Valkyra', 100], ['Lonestar', 90]]),
    record(3, [['a', 3, 1, 'Valkyra'], ['b', 9, 4, 'Lonestar']], [['Valkyra', 70], ['Lonestar', 70]]),
  ],
};

const winnerOf = (id: string) => CHALLENGES.find((c) => c.id === id)?.winner(sources) ?? null;

describe('challenges', () => {
  it('finds each winner, with what they did', () => {
    expect(winnerOf('kills')).toEqual({ steamId: 'b', name: 'B', says: '40 kills' });
    expect(winnerOf('bestMatch')).toEqual({ steamId: 'b', name: 'B', says: '25 kills on Ozeti' });
    // A level match has no winner.
    expect(winnerOf('wins')).toEqual({ steamId: 'a', name: 'A', says: '2 wins' });
    expect(winnerOf('seeding')).toEqual({ steamId: 'a', name: 'A', says: '2 seed days' });
    expect(winnerOf('playtime')).toEqual({ steamId: 'b', name: 'B', says: '10 hours' });
  });

  it('counts players level at the top of a match as MVPs, as the roundups do', () => {
    // b tops matches 1 and 3, and is level with a in match 2.
    expect(mostMvps(sources)).toEqual({ steamId: 'b', name: 'B', says: '3 MVPs' });
    expect(mostMvps({ days: [], matches: [] })).toBeNull();
  });

  it('goes round the challenges one a week', () => {
    const monday = Date.UTC(2026, 9, 19);
    const ids = Array.from({ length: CHALLENGES.length + 1 }, (_, i) => challengeFor(monday + i * WEEK_MS).id);

    expect(new Set(ids.slice(0, CHALLENGES.length)).size).toBe(CHALLENGES.length);
    expect(ids[CHALLENGES.length]).toBe(ids[0]);
  });
});

describe('drive posts', () => {
  const winner = { steamId: 'a', name: 'Ash_*', says: '7 MVPs' };

  it('names the player of the month, and says how to get the role when they have no linked account', () => {
    const given = buildPlayerOfMonthMessage(Date.UTC(2026, 9, 1), winner, new Set(), 'given', '123', 'https://gaminginit.com/');
    const [embed] = given.embeds;

    expect(embed?.title).toBe('👑 Player of the month · October 2026');
    expect(embed?.description).toBe('**Ash\\_\\*** topped the scoreboard the most times: 7 MVPs. They have the <@&123> role for the month.');
    expect(given.allowed_mentions).toEqual({ parse: [], roles: [] });

    const unlinked = buildPlayerOfMonthMessage(Date.UTC(2026, 9, 1), winner, new Set(), 'unlinked', '123', 'https://gaminginit.com');
    expect(unlinked.embeds[0]?.description).toContain('Link your account at https://gaminginit.com/account to get the role next time.');
    expect(buildPlayerOfMonthMessage(0, winner, new Set(), 'none', undefined, undefined).embeds[0]?.description).toBe(
      '**Ash\\_\\*** topped the scoreboard the most times: 7 MVPs.',
    );
  });

  it('keeps a private profile private', () => {
    expect(buildPlayerOfMonthMessage(0, winner, new Set(['a']), 'none', undefined, undefined).embeds[0]?.description).toContain(PRIVATE_NAME);
  });

  it("gives last week's winner and this week's challenge, or only this week's", () => {
    const [kills, bestMatch] = CHALLENGES as [(typeof CHALLENGES)[number], (typeof CHALLENGES)[number]];
    const both = buildChallengeMessage({ challenge: kills, winner: { ...winner, says: '90 kills' } }, bestMatch, new Set(), 'given', '9', undefined);

    expect(both.embeds[0]?.fields).toEqual([
      { name: 'Last week: Most kills', value: '**Ash\\_\\*** won with 90 kills. They have the <@&9> role for the week.' },
      { name: 'This week: Most kills in one match', value: 'Top it by Monday (UTC) for a shout-out here and the <@&9> role for the week.' },
    ]);
    expect(buildChallengeMessage({ challenge: kills, winner: null }, bestMatch, new Set(), 'none', undefined, undefined).embeds[0]?.fields?.[0]?.value).toBe(
      'Nobody took it.',
    );
    expect(buildChallengeMessage(null, bestMatch, new Set(), 'none', undefined, undefined).embeds[0]?.fields).toEqual([
      { name: 'This week: Most kills in one match', value: 'Top it by Monday (UTC) for a shout-out here.' },
    ]);
  });

  it('reads back what it saved, and starts empty', () => {
    const state = {
      month: { steamId: 'a', userId: '1' },
      challenge: { steamId: 'b', userId: null },
      announced: '2026-10-19',
      stale: [{ userId: '2', roleId: '9' }],
    };

    expect(parseDrives(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(parseDrives(undefined)).toEqual({ month: null, challenge: null, announced: null, stale: [] });
    // Saved before stale roles were kept.
    expect(parseDrives({ month: null, challenge: null, announced: null }).stale).toEqual([]);
  });
});
