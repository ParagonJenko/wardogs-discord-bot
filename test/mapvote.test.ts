import { describe, expect, it } from 'vitest';
import {
  castVote,
  chooseWinner,
  closeDue,
  closeScoreFor,
  isOpen,
  matchIsOver,
  openVote,
  parseMapVote,
  parseVoteButton,
  voteLink,
  votingNow,
  chooseConditions,
  conditionOptions,
  parseLightButton,
  tallyConditions,
  type Lighting,
  voteMessage,
  editVoteMessage,
  postVoteMessage,
  pickOptions,
  publicVote,
  withPlayed,
  type MapVote,
} from '../src/mapvote.ts';
import type { MatchFeed } from '../src/matchfeed.ts';
import type { MapChoice } from '../src/rotationspage.ts';

const choice = (id: string, modes = 1, infantry = true): MapChoice => ({
  id,
  name: id,
  modes: Array.from({ length: modes }, (_, i) => ({ id: `${id}_${i}`, name: `Mode ${i}` })),
  modifiers: infantry ? [{ key: 'infantry_only', name: 'Infantry only', id: `${id}_InfantryOnly` }] : [],
  zones: [],
});

const NOW = 1_000_000;
const vote = (): MapVote =>
  openVote({ startedAt: 42 }, 'Kavkazi', [{ map: 'A', name: 'Alpha' }, { map: 'B', name: 'Bravo' }, { map: 'C', name: 'Charlie' }], { options: 3, minutes: 15, closePercent: 95, channelId: '1', botToken: 't', staging: 'rotation' }, NOW, 95);
const ballot = (n: number, map: string) => ({ user: `user${n}`, map });

describe('pickOptions', () => {
  it('offers playable maps other than the one being played, up to the count', () => {
    const maps = [choice('Now'), choice('A'), choice('B'), choice('C'), choice('D'), choice('NoModes', 0)];
    const options = pickOptions(maps, 'Now', ['Now'], 3, () => 0);
    expect(options).toHaveLength(3);
    expect(options.map((o) => o.map)).not.toContain('Now');
    expect(options.map((o) => o.map)).not.toContain('NoModes');
  });

  it('does not offer maps played lately', () => {
    const maps = ['Now', 'Old1', 'Old2', 'A', 'B', 'C'].map((id) => choice(id));
    for (const roll of [0, 0.5, 0.99]) {
      const offered = pickOptions(maps, 'Now', ['Old1', 'Old2', 'Now'], 4, () => roll).map((o) => o.map);
      expect(offered.sort()).toEqual(['A', 'B', 'C']);
    }
  });

  it('lets the maps played longest ago back in when too few are fresh, never the one being played', () => {
    const maps = ['Now', 'Oldest', 'Older', 'Newer', 'A'].map((id) => choice(id));
    const offered = pickOptions(maps, 'Now', ['Oldest', 'Older', 'Newer', 'Now'], 4, () => 0).map((o) => o.map);
    expect(offered.sort()).toEqual(['A', 'Oldest']);
  });

  it('does not offer a map that has no infantry only of its own, so the id sent is always one that map lists', () => {
    const maps = [choice('Now'), choice('A'), choice('B'), choice('Plain', 1, false)];
    expect(pickOptions(maps, 'Now', ['Now'], 4, () => 0).map((o) => o.map).sort()).toEqual(['A', 'B']);
  });

  it('offers nothing when fewer than two maps could be voted on', () => {
    expect(pickOptions([choice('Now'), choice('A')], 'Now', ['Now'], 4, Math.random)).toEqual([]);
  });
});

describe('withPlayed', () => {
  it('puts the map last once, and keeps the current map and the four before it', () => {
    expect(withPlayed(['A', 'B'], 'A')).toEqual(['B', 'A']);
    expect(withPlayed([], 'A')).toEqual(['A']);
    expect(withPlayed(['A', 'B', 'C', 'D'], 'E')).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(withPlayed(['A', 'B', 'C', 'D', 'E'], 'F')).toEqual(['B', 'C', 'D', 'E', 'F']);
  });
});

describe('castVote', () => {
  it('counts a ballot, and a second from the same Discord user moves it', () => {
    const first = castVote(vote(), ballot(1, 'A'), NOW + 1);
    expect(first.result).toBe('counted');
    if (!('vote' in first)) throw new Error('no vote');
    const second = castVote(first.vote, ballot(1, 'B'), NOW + 2);
    expect(second.result).toBe('changed');
    if (!('vote' in second)) throw new Error('no vote');
    expect(second.vote.ballots).toHaveLength(1);
    expect(second.vote.ballots[0]?.map).toBe('B');
  });

  it('counts different people separately', () => {
    let v = vote();
    for (const n of [1, 2, 3]) {
      const cast = castVote(v, ballot(n, n === 3 ? 'B' : 'A'), NOW + n);
      if (!('vote' in cast)) throw new Error('no vote');
      v = cast.vote;
    }
    expect(publicVote(v, NOW + 10).options.map((o) => o.votes)).toEqual([2, 1, 0]);
    expect(publicVote(v, NOW + 10).total).toBe(3);
  });

  it('refuses a map that is not offered, and any ballot once the vote is closed', () => {
    expect(castVote(vote(), ballot(1, 'Z'), NOW + 1).result).toBe('unknown-map');
    expect(castVote(vote(), ballot(1, 'A'), NOW + 15 * 60_000).result).toBe('closed');
    expect(castVote({ ...vote(), outcome: { at: NOW, winner: null, pending: false } }, ballot(1, 'A'), NOW + 1).result).toBe('closed');
  });
});

describe('chooseWinner', () => {
  const withVotes = (picks: string[]): MapVote => ({ ...vote(), ballots: picks.map((map, i) => ({ ...ballot(i, map), light: null, at: NOW })) });

  it('takes the map with the most votes', () => {
    expect(chooseWinner(withVotes(['A', 'B', 'B']), Math.random)).toBe('B');
  });

  it('settles a tie by chance between the tied maps only', () => {
    const tied = withVotes(['A', 'B', 'C', 'C', 'A']);
    for (const roll of [0, 0.5, 0.99]) expect(['A', 'C']).toContain(chooseWinner(tied, () => roll));
  });

  it('has no winner when nobody voted', () => {
    expect(chooseWinner(vote(), Math.random)).toBeNull();
  });
});

describe('closeDue', () => {
  it('closes when time is up or a team reaches the close score, and only once', () => {
    expect(closeDue(vote(), NOW + 1, 10)).toBe(false);
    expect(closeDue(vote(), NOW + 1, 94)).toBe(false);
    expect(closeDue(vote(), NOW + 15 * 60_000, 10)).toBe(true);
    expect(closeDue(vote(), NOW + 1, 95)).toBe(true);
    expect(closeDue({ ...vote(), outcome: { at: NOW, winner: null, pending: false } }, NOW + 1, 99)).toBe(false);
  });

  it('closes on time alone for a vote saved without a close score', () => {
    const old = { ...vote(), closeScore: 0 };
    expect(closeDue(old, NOW + 1, 99)).toBe(false);
    expect(closeDue(old, NOW + 15 * 60_000, 0)).toBe(true);
  });
});

describe('closeScoreFor', () => {
  it('is the share of the winning score, rounded up', () => {
    expect(closeScoreFor(100, 95)).toBe(95);
    expect(closeScoreFor(150, 95)).toBe(143);
  });

  it('stays below the winning score, whatever the settings', () => {
    expect(closeScoreFor(10, 95)).toBe(9);
    expect(closeScoreFor(50, 99)).toBe(49);
    expect(closeScoreFor(2, 99)).toBe(1);
  });
});

describe('publicVote and storage', () => {
  it('shows votes and the winner but never who voted', () => {
    const v: MapVote = { ...vote(), ballots: [{ ...ballot(1, 'A'), light: null, at: NOW }], outcome: { at: NOW, winner: 'A', pending: false } };
    const shown = publicVote(v, NOW + 1);
    expect(shown).toMatchObject({ open: false, total: 1, winner: { map: 'A', name: 'Alpha' }, infantryOnly: true, pending: false, closeScore: 95, closedAt: NOW });
    expect(JSON.stringify(shown)).not.toContain('user1');
  });

  it('is open until it closes', () => {
    expect(isOpen(vote(), NOW + 1)).toBe(true);
    expect(isOpen(vote(), NOW + 15 * 60_000)).toBe(false);
  });

  it('reads back what it saved, and nothing from rubbish', () => {
    const v = vote();
    expect(parseMapVote(JSON.parse(JSON.stringify(v)))).toEqual(v);
    expect(parseMapVote({ nope: true })).toBeNull();
    expect(parseMapVote(null)).toBeNull();
  });
});

describe('voteMessage', () => {
  const cast = (v: MapVote, picks: [number, string][]): MapVote => ({
    ...v,
    ballots: picks.map(([n, map]) => ({ ...ballot(n, map), light: null, at: NOW })),
  });

  it('has a button per map while open, each carrying the vote and the map', () => {
    const message = voteMessage(cast(vote(), [[1, 'A'], [2, 'A'], [3, 'B']]), NOW + 1, 'https://gaminginit.com/');
    const buttons = (message.components[0] as { components: { label: string; custom_id: string }[] }).components;
    expect(buttons.map((b) => b.custom_id)).toEqual(['mapvote:42:A', 'mapvote:42:B', 'mapvote:42:C']);
    expect(buttons.map((b) => parseVoteButton(b.custom_id))).toEqual([
      { poll: '42', map: 'A' },
      { poll: '42', map: 'B' },
      { poll: '42', map: 'C' },
    ]);
    expect(message.embeds[0]?.fields?.map((f) => f.value.endsWith('votes') || f.value.endsWith('vote'))).toEqual([true, true, true]);
    expect(message.embeds[0]?.fields?.[0]?.value).toContain('2 votes');
    expect(message.embeds[0]?.description).toContain('infantry only');
    expect(message.embeds[0]?.description).toContain('reaches 95 points');
    expect(message.embeds[0]?.description).toContain('https://gaminginit.com/vote');
    expect(message.allowed_mentions).toEqual({ parse: [] });
  });

  it('splits more than five buttons into rows', () => {
    const many = { ...vote(), options: ['A', 'B', 'C', 'D', 'E', 'F'].map((map) => ({ map, name: map })) };
    expect(voteMessage(many, NOW + 1).components).toHaveLength(2);
  });

  it('takes the buttons away and names the winner once closed', () => {
    const closed = { ...cast(vote(), [[1, 'B']]), outcome: { at: NOW, winner: 'B', pending: false } };
    const message = voteMessage(closed, NOW + 1);
    expect(message.components).toEqual([]);
    expect(message.embeds[0]?.description).toContain('Bravo');
    expect(message.embeds[0]?.fields?.[1]?.name).toContain('✅');
  });
});

describe('parseVoteButton', () => {
  it('reads only buttons of this vote', () => {
    expect(parseVoteButton('mapvote:42:Kavkazi')).toEqual({ poll: '42', map: 'Kavkazi' });
    expect(parseVoteButton('mapvote:x:Kavkazi')).toBeNull();
    expect(parseVoteButton('other:42:A')).toBeNull();
    expect(parseVoteButton(undefined)).toBeNull();
  });
});

describe('Discord messages', () => {
  it('posts as the bot and answers the message id', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ id: '999' });
    }) as unknown as typeof fetch;
    expect(await postVoteMessage('tok', '123', voteMessage(vote(), NOW), fetchFn)).toBe('999');
    expect(calls[0]?.url).toBe('https://discord.com/api/v10/channels/123/messages');
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe('Bot tok');
  });

  it('edits the message, tolerates one that was deleted, and fails on other refusals', async () => {
    const answer = (status: number) => (async () => new Response('no', { status })) as unknown as typeof fetch;
    await expect(editVoteMessage('tok', '1', '2', voteMessage(vote(), NOW), answer(404))).resolves.toBeUndefined();
    await expect(editVoteMessage('tok', '1', '2', voteMessage(vote(), NOW), answer(403))).rejects.toThrow(/403/);
  });
});

describe('voteLink', () => {
  const posted = { ...vote(), message: { channelId: '22', messageId: '33' } };

  it('links to the vote message while the vote is open', () => {
    expect(voteLink(posted, '11', NOW + 1)).toBe('https://discord.com/channels/11/22/33');
  });

  it('has no link once the vote closes, before it is posted, or without the server', () => {
    expect(voteLink(posted, '11', NOW + 15 * 60_000)).toBeNull();
    expect(voteLink(vote(), '11', NOW + 1)).toBeNull();
    expect(voteLink(posted, undefined, NOW + 1)).toBeNull();
    expect(voteLink(null, '11', NOW + 1)).toBeNull();
  });
});

describe('conditionOptions', () => {
  const lighting = (id: string, name = id): Lighting => ({ id, name });
  const lightings = [
    lighting('DayClear', 'Day, clear'),
    lighting('DayRain', 'Day, rain'),
    lighting('NightClear', 'Night, clear'),
    lighting('NightStorm', 'Night, storm'),
    lighting('Dusk', 'Dusk'),
  ];

  it('groups lightings by time of day and weather, with Random across all of them', () => {
    const options = conditionOptions(lightings);
    expect(options.map((o) => o.key)).toEqual(['day', 'night', 'rain', 'dusk', 'random']);
    expect(options.find((o) => o.key === 'day')?.lightings.map((l) => l.id)).toEqual(['DayClear', 'DayRain']);
    // A rainy night is in Night and in Rain.
    expect(options.find((o) => o.key === 'rain')?.lightings.map((l) => l.id)).toEqual(['DayRain', 'NightStorm']);
    expect(options.find((o) => o.key === 'random')?.lightings).toHaveLength(5);
  });

  it('leaves out groups the server has no lighting for, and keeps a row to five buttons', () => {
    const many = [...lightings, lighting('Dawn'), lighting('Fog'), lighting('Snow'), lighting('Overcast')];
    const options = conditionOptions(many);
    expect(options).toHaveLength(5);
    expect(options.at(-1)?.key).toBe('random');
    expect(conditionOptions([lighting('DayClear'), lighting('DayRain')]).map((o) => o.key)).toEqual(['day', 'rain', 'random']);
  });

  it("groups the server's own lighting ids: Start is dawn, End is dusk, Gray is overcast", () => {
    const ids = ['DayStartClear', 'DayEarlyClear', 'DayEarlyFog', 'DayClear', 'DayLateClear', 'DayLateGray', 'DayLateGrayFog', 'DayLateRain', 'DayEndClear'];
    const options = conditionOptions(ids.map((id) => lighting(id)));
    expect(options.map((o) => o.key)).toEqual(['day', 'rain', 'fog', 'dusk', 'random']);
    const of = (key: string) => options.find((o) => o.key === key)?.lightings.map((l) => l.id);
    expect(of('day')).toEqual(['DayEarlyClear', 'DayEarlyFog', 'DayClear', 'DayLateClear', 'DayLateGray', 'DayLateGrayFog', 'DayLateRain']);
    expect(of('rain')).toEqual(['DayLateRain']);
    expect(of('fog')).toEqual(['DayEarlyFog', 'DayLateGrayFog']);
    expect(of('dusk')).toEqual(['DayEndClear']);
    expect(conditionOptions(ids.slice(0, 1).concat('DayLateGray').map((id) => lighting(id))).map((o) => o.key)).toEqual(['day', 'overcast', 'dawn', 'random']);
  });

  it('offers no row when there is nothing to choose between', () => {
    expect(conditionOptions([])).toEqual([]);
    expect(conditionOptions([lighting('Sunny'), lighting('Other')])).toEqual([]);
    expect(conditionOptions([lighting('DayClear')])).toEqual([]);
  });
});

describe('the conditions vote', () => {
  const conditions = conditionOptions([
    { id: 'DayClear', name: 'Day, clear' },
    { id: 'NightClear', name: 'Night, clear' },
    { id: 'NightStorm', name: 'Night, storm' },
  ]);
  const withConditions = (): MapVote => ({ ...vote(), conditions });
  const apply = (v: MapVote, ballotOf: { user: string; map?: string; light?: string }, at = NOW + 1): MapVote => {
    const cast = castVote(v, ballotOf, at);
    if (!('vote' in cast)) throw new Error(cast.result);
    return cast.vote;
  };

  it('keeps one vote on the map and one on the conditions for each person, changed independently', () => {
    let v = apply(withConditions(), { user: 'a', map: 'A' });
    v = apply(v, { user: 'a', light: 'night' });
    expect(v.ballots).toEqual([{ user: 'a', map: 'A', light: 'night', at: NOW + 1 }]);
    v = apply(v, { user: 'a', light: 'day' });
    expect(v.ballots[0]).toMatchObject({ map: 'A', light: 'day' });
    v = apply(v, { user: 'a', map: 'B' });
    expect(v.ballots[0]).toMatchObject({ map: 'B', light: 'day' });
    expect(v.ballots).toHaveLength(1);
  });

  it('says whether a vote was new or moved, for each of the two', () => {
    const v = apply(withConditions(), { user: 'a', map: 'A' });
    expect(castVote(v, { user: 'a', light: 'day' }, NOW + 2).result).toBe('counted');
    expect(castVote(v, { user: 'a', map: 'B' }, NOW + 2).result).toBe('changed');
  });

  it('refuses a choice that is not offered, both or neither at once, and any vote on a vote without the row', () => {
    expect(castVote(withConditions(), { user: 'a', light: 'snow' }, NOW + 1).result).toBe('unknown-map');
    expect(castVote(withConditions(), { user: 'a', map: 'A', light: 'day' }, NOW + 1).result).toBe('unknown-map');
    expect(castVote(withConditions(), { user: 'a' }, NOW + 1).result).toBe('unknown-map');
    expect(castVote(vote(), { user: 'a', light: 'day' }, NOW + 1).result).toBe('unknown-map');
  });

  it('chooses a random lighting from the group with the most votes, none when nobody voted', () => {
    let v = withConditions();
    expect(chooseConditions(v, Math.random)).toBeNull();
    for (const [user, light] of [['a', 'night'], ['b', 'night'], ['c', 'day']] as const) v = apply(v, { user, light });
    expect(tallyConditions(v).map((c) => c.votes)).toEqual([1, 2, 0, 0]);
    for (const roll of [0, 0.5, 0.99]) expect(['NightClear', 'NightStorm']).toContain(chooseConditions(v, () => roll)?.id);
  });

  it('lets Random win across every lighting', () => {
    const v = apply(withConditions(), { user: 'a', light: 'random' });
    expect(new Set([0, 0.4, 0.99].map((roll) => chooseConditions(v, () => roll)?.id))).toEqual(new Set(['DayClear', 'NightClear', 'NightStorm']));
  });

  it('shows the counts on the website and the chosen lighting once it is on the server', () => {
    let v = apply(withConditions(), { user: 'a', light: 'night' });
    expect(publicVote(v, NOW + 2).conditions).toEqual([
      { key: 'day', label: 'Day', votes: 0 },
      { key: 'night', label: 'Night', votes: 1 },
      { key: 'rain', label: 'Rain', votes: 0 },
      { key: 'random', label: 'Random', votes: 0 },
    ]);
    v = { ...v, outcome: { at: NOW, winner: 'A', pending: false, lighting: 'NightStorm', lightingName: 'Night, storm' } };
    expect(publicVote(v, NOW + 2).lightingName).toBe('Night, storm');
  });

  it('puts the conditions in the Discord message as a second row and a field, and names the lighting at the end', () => {
    const message = voteMessage(withConditions(), NOW + 1);
    expect(message.components).toHaveLength(2);
    const row = (message.components[1] as { components: { label: string; custom_id: string }[] }).components;
    expect(row.map((b) => b.label)).toEqual(['Day', 'Night', 'Rain', '🎲 Random']);
    expect(row.map((b) => parseLightButton(b.custom_id))).toEqual([
      { poll: '42', light: 'day' },
      { poll: '42', light: 'night' },
      { poll: '42', light: 'rain' },
      { poll: '42', light: 'random' },
    ]);
    expect(message.embeds[0]?.fields?.at(-1)?.name).toContain('Conditions');
    const done = voteMessage(
      { ...withConditions(), outcome: { at: NOW, winner: 'B', pending: false, lighting: 'NightStorm', lightingName: 'Night, storm' } },
      NOW + 1,
    );
    expect(done.components).toEqual([]);
    expect(done.embeds[0]?.description).toContain('Bravo');
    expect(done.embeds[0]?.description).toContain('Night, storm');
  });

  it('has no conditions row or field when the server gave too few groups', () => {
    const message = voteMessage(vote(), NOW + 1);
    expect(message.components).toHaveLength(1);
    expect(message.embeds[0]?.fields?.some((f) => f.name.includes('Conditions'))).toBe(false);
  });
});

describe('parseLightButton', () => {
  it('reads only conditions buttons of this vote', () => {
    expect(parseLightButton('maplight:42:night')).toEqual({ poll: '42', light: 'night' });
    expect(parseLightButton('mapvote:42:Kavkazi')).toBeNull();
    expect(parseLightButton('maplight:x:night')).toBeNull();
    expect(parseLightButton(undefined)).toBeNull();
  });
});

describe('votingNow', () => {
  const match = (leading: number, extra: { endedAt?: number } = {}) => ({
    startedAt: 42,
    factionScores: [{ score: leading }, { score: 3 }],
    ...extra,
  });

  it('is true while the vote is open for this match and no team has reached the close score', () => {
    expect(votingNow(vote(), match(50), NOW + 1)).toBe(true);
    expect(votingNow(vote(), match(94), NOW + 1)).toBe(true);
  });

  it('is false once a team has reached the close score, even before the check that closes the vote', () => {
    expect(votingNow(vote(), match(95), NOW + 1)).toBe(false);
    expect(votingNow({ ...vote(), closeScore: 80 }, match(85), NOW + 1)).toBe(false);
  });

  it('is false when time is up, the vote is closed, the match has ended or it is another match, or there is no vote', () => {
    expect(votingNow(vote(), match(10), NOW + 15 * 60_000)).toBe(false);
    expect(votingNow({ ...vote(), outcome: { at: NOW, winner: null, pending: false } }, match(10), NOW + 1)).toBe(false);
    expect(votingNow(vote(), match(10, { endedAt: NOW }), NOW + 1)).toBe(false);
    expect(votingNow(vote(), { ...match(10), startedAt: 43 }, NOW + 1)).toBe(false);
    expect(votingNow(vote(), null, NOW + 1)).toBe(false);
    expect(votingNow(null, match(10), NOW + 1)).toBe(false);
  });

  it('is open on time alone for a vote saved without a close score', () => {
    expect(votingNow({ ...vote(), closeScore: 0 }, match(99), NOW + 1)).toBe(true);
  });
});

describe('matchIsOver', () => {
  const feed = (state: string | null, stateAt: number | null, resultAt: number | null = null): MatchFeed => ({
    state,
    stateAt,
    playingAt: null,
    result: resultAt === null ? null : { at: resultAt, map: 'A', matchId: '1', winner: null, factionScores: [], players: null },
  });

  it('is not over while the match is being played, even on the close score', () => {
    expect(matchIsOver(vote(), feed('MatchState.Playing.KOTH', NOW + 1), 96, 100)).toBe(false);
    expect(matchIsOver(vote(), null, 96, 100)).toBe(false);
  });

  it('is over at the end screen, or at the result, since the vote opened', () => {
    expect(matchIsOver(vote(), feed('MatchState.PostMatch', NOW + 1), 96, 100)).toBe(true);
    expect(matchIsOver(vote(), feed('MatchState.Playing', NOW + 1, NOW + 2), 96, 100)).toBe(true);
  });

  it('does not take the last match\'s end screen or result for this one', () => {
    expect(matchIsOver(vote(), feed('MatchState.PostMatch', NOW - 1, NOW - 1), 10, 100)).toBe(false);
  });

  it('is over without the feed once a team has the winning score', () => {
    expect(matchIsOver(vote(), null, 99, 100)).toBe(false);
    expect(matchIsOver(vote(), null, 100, 100)).toBe(true);
  });
});
