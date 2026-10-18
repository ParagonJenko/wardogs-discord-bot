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
  weatherOptions,
  weatherOf,
  parseWeatherButton,
  parseLastZones,
  randomZone,
  zoneForTry,
  outcomeWithZone,
  votePool,
  RANDOM_MAP,
  type Lighting,
  voteMessage,
  editVoteMessage,
  deleteVoteMessage,
  postVoteMessage,
  mapIdOf,
  parseRainRecord,
  rainRecordFor,
  voteLogLine,
  voteLogMessage,
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

describe('voteLogLine', () => {
  const base = { ...vote(), conditions: conditionOptions(serverLightings), weather: weatherOptions(serverLightings) };
  const cast = (v: MapVote, ballotOf: Parameters<typeof castVote>[1], at: number): MapVote => {
    const result = castVote(v, ballotOf, at);
    if (!('vote' in result)) throw new Error(result.result);
    return result.vote;
  };

  it('says who voted for which map, by name and Discord ID', () => {
    const voted = cast(base, { user: '9001', map: 'B' }, NOW + 1);
    expect(voteLogLine(voted, { userId: '9001', map: 'B', userName: 'Ash' }, undefined)).toBe('Map vote 42: "Ash" (9001) voted map Bravo via discord');
  });

  it('says what a changed vote replaced', () => {
    const first = cast(base, { user: '9001', map: 'B' }, NOW + 1);
    const moved = cast(first, { user: '9001', map: 'C' }, NOW + 2);
    expect(voteLogLine(moved, { userId: '9001', map: 'C' }, first.ballots[0])).toBe('Map vote 42: 9001 voted map Charlie (was Bravo) via discord');
  });

  it('names the time of day and the weather, and where the vote came from', () => {
    const voted = cast(cast(base, { user: '5', light: 'dusk' }, NOW + 1), { user: '5', weather: 'rain' }, NOW + 2);
    expect(voteLogLine(voted, { userId: '5', light: 'dusk' }, undefined)).toBe('Map vote 42: 5 voted time of day Dusk via discord');
    expect(voteLogLine(voted, { userId: '5', weather: 'rain', via: 'website' }, undefined)).toBe('Map vote 42: 5 voted weather Rain via website');
  });

  it('keeps a name with quotes or line breaks on one line', () => {
    const voted = cast(base, { user: '1', map: 'A' }, NOW + 1);
    const line = voteLogLine(voted, { userId: '1', map: 'A', userName: 'Bo "x"\nHacker' }, undefined);
    expect(line).not.toContain('\n');
    expect(line).toContain('"Bo \\"x\\"\\nHacker" (1)');
  });
});

describe('rain after rain', () => {
  it('has no rule on a vote that was saved before there was one', () => {
    const { rain, ...old } = vote();
    expect(rain).toEqual({ all: false, skipped: null });
    expect(parseMapVote(old)?.rain).toEqual({ all: false, skipped: null });
    expect(parseMapVote({ ...old, rain: { all: true, skipped: 'A' } })?.rain).toEqual({ all: true, skipped: 'A' });
  });

  it("notes whether a match is in the rain from its map's lighting, and carries the last map that had rain", () => {
    const first = rainRecordFor(null, 100, 'Ozeti', 'DayClear');
    expect(first).toEqual({ matchStartedAt: 100, map: 'Ozeti', rain: false, ban: null, lastRain: null });
    // Rain: no rain is allowed in this vote, and this map is the last that had it.
    const rainy = rainRecordFor(first, 200, 'Zestafona', 'DayLateRain');
    expect(rainy).toEqual({ matchStartedAt: 200, map: 'Zestafona', rain: true, ban: null, lastRain: 'Zestafona' });
    // The match after it is clear: rain is allowed again, but not for the map that had it last.
    const clear = rainRecordFor(rainy, 300, 'Bakurani', 'DayClear');
    expect(clear).toEqual({ matchStartedAt: 300, map: 'Bakurani', rain: false, ban: 'Zestafona', lastRain: 'Zestafona' });
    // And it stays so until a map has rain again.
    expect(rainRecordFor(clear, 400, 'Ozeti', undefined)).toMatchObject({ rain: false, ban: 'Zestafona', lastRain: 'Zestafona' });
    expect(rainRecordFor(clear, 400, 'Ozeti', 'DayLateRain')).toMatchObject({ rain: true, ban: null, lastRain: 'Ozeti' });
  });

  it('keeps the record it has for a match it already noted', () => {
    const noted = rainRecordFor(null, 100, 'Ozeti', 'DayLateRain');
    expect(rainRecordFor(noted, 100, 'Ozeti', 'DayClear')).toBe(noted);
  });

  it('reads what was saved, and nothing else', () => {
    const saved = { matchStartedAt: 1, map: 'A', rain: true, ban: null, lastRain: 'A' };
    expect(parseRainRecord(saved)).toEqual(saved);
    expect(parseRainRecord({ ...saved, rain: 'yes' })).toBeNull();
    expect(parseRainRecord(undefined)).toBeNull();
  });
});

describe('voteLogMessage', () => {
  const lightings = serverLightings;
  const closed = (picks: { user: string; map?: string; light?: string; weather?: string }[], outcome: MapVote['outcome']): MapVote => {
    let v: MapVote = { ...vote(), conditions: conditionOptions(lightings), weather: weatherOptions(lightings) };
    for (const [i, pick] of picks.entries()) {
      const cast = castVote(v, pick, NOW + i + 1);
      if (!('vote' in cast)) throw new Error(cast.result);
      v = cast.vote;
    }
    return { ...v, outcome };
  };

  it('puts every ballot in one message, by choice, with the voters as mentions that ping nobody', () => {
    const v = closed(
      [{ user: '1', map: 'B' }, { user: '2', map: 'B' }, { user: '3', map: 'C' }, { user: '1', light: 'day' }, { user: '2', weather: 'clear' }, { user: '3', weather: 'clear' }],
      { at: NOW + 50, winner: 'B', pending: true, lighting: 'DayClear', lightingName: 'Day, clear' },
    );
    const message = voteLogMessage(v);
    expect(message.embeds).toHaveLength(1);
    expect(message.allowed_mentions).toEqual({ parse: [], roles: [] });
    const embed = message.embeds[0]!;
    expect(embed.title).toBe('🗳️ Map vote closed · after Bakurani');
    expect(embed.description).toContain('**Bravo** won, **Day, clear**. 3 people voted.');
    expect(embed.description).toContain('Bravo ✅ (2): <@1> <@2>');
    expect(embed.description).toContain('Charlie (1): <@3>');
    expect(embed.description).toContain('Day (1): <@1>');
    expect(embed.description).toContain('Clear (2): <@2> <@3>');
    expect(embed.footer?.text).toBe('Vote 42');
  });

  it('leaves out choices nobody voted for, and says when no map won', () => {
    const v = closed([{ user: '9', light: 'dusk' }], { at: NOW + 5, winner: null, pending: false });
    const text = voteLogMessage(v).embeds[0]!.description!;
    expect(text).toContain('No map won. 1 person voted.');
    expect(text).toContain('Dusk (1): <@9>');
    expect(text).not.toContain('(0)');
    expect(text).not.toContain('🗺️ Map');
  });

  it('is cut short with a note rather than past what one embed holds', () => {
    const picks = Array.from({ length: 300 }, (_, i) => ({ user: String(100_000_000_000_000_000n + BigInt(i)), map: 'A' }));
    const v = closed([...picks, ...picks.map((p) => ({ user: p.user, light: 'day' })), ...picks.map((p) => ({ user: p.user, weather: 'clear' }))], {
      at: NOW + 5,
      winner: 'A',
      pending: true,
    });
    const description = voteLogMessage(v).embeds[0]!.description!;
    expect(description.length).toBeLessThanOrEqual(4096);
    expect(description).toContain('more lines cut');
  });
});

describe('mapIdOf', () => {
  const maps = [{ ...choice('Europe'), name: 'Ozeti' }, { ...choice('NorthAmerica'), name: 'Zestafona' }];

  it('finds the id of a map the server reports by its name or its id, ignoring case', () => {
    expect(mapIdOf(maps, 'Ozeti')).toBe('Europe');
    expect(mapIdOf(maps, 'zestafona')).toBe('NorthAmerica');
    expect(mapIdOf(maps, 'Europe')).toBe('Europe');
  });

  it('keeps a map the catalogue does not list as it was', () => {
    expect(mapIdOf(maps, 'Nowhere')).toBe('Nowhere');
    expect(mapIdOf([], 'Ozeti')).toBe('Ozeti');
  });

  it('lets the map being played and the ones played lately be left out of a vote, whatever they are called', () => {
    const all = [...maps, choice('Kavkazi'), choice('Other')];
    const offered = pickOptions(all, mapIdOf(all, 'Ozeti'), ['Zestafona', 'Ozeti'].map((m) => mapIdOf(all, m)), 4, () => 0).map((o) => o.map);
    expect(offered).toEqual(expect.arrayContaining(['Kavkazi', 'Other']));
    expect(offered).not.toContain('Europe');
    expect(offered).not.toContain('NorthAmerica');
  });
});

describe('keeping the map that last had rain out of a vote', () => {
  const maps = [choice('Now'), choice('A'), choice('B'), choice('C'), choice('D')];

  it('leaves it out, as the map being played is', () => {
    expect(votePool(maps, 'Now', ['Now'], 4, ['B']).map((m) => m.id)).toEqual(['A', 'C', 'D']);
    for (const roll of [0, 0.5, 0.99]) expect(pickOptions(maps, 'Now', ['Now'], 4, () => roll, ['B']).map((o) => o.map)).not.toContain('B');
  });

  it('puts it back rather than have no vote', () => {
    // Leaving B out would leave one map, which is no vote.
    expect(votePool([choice('Now'), choice('A'), choice('B')], 'Now', ['Now'], 4, ['B']).map((m) => m.id)).toEqual(['A', 'B']);
  });

  it('is nothing unless a map is given', () => {
    expect(votePool(maps, 'Now', ['Now'], 4).map((m) => m.id)).toEqual(['A', 'B', 'C', 'D']);
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
  const withVotes = (picks: string[]): MapVote => ({ ...vote(), ballots: picks.map((map, i) => ({ ...ballot(i, map), light: null, weather: null, at: NOW })) });

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
    const v: MapVote = { ...vote(), ballots: [{ ...ballot(1, 'A'), light: null, weather: null, at: NOW }], outcome: { at: NOW, winner: 'A', pending: false } };
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
    ballots: picks.map(([n, map]) => ({ ...ballot(n, map), light: null, weather: null, at: NOW })),
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

  it('does not say the winner waits for the end of the match while it is being put on the server', () => {
    const pending = { ...cast(vote(), [[1, 'B']]), outcome: { at: NOW, winner: 'B', pending: true } };
    const description = voteMessage(pending, NOW + 1).embeds[0]?.description;
    expect(description).toContain('**Bravo** won');
    expect(description).not.toContain('when the match ends');
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

  it('deletes the old message with the bot token, tolerates one already gone, and fails on other refusals', async () => {
    const seen: { url: string; method?: string; auth?: string }[] = [];
    const answer = (status: number) =>
      (async (url: string, init: RequestInit) => {
        seen.push({ url, method: init.method, auth: (init.headers as Record<string, string>)['authorization'] });
        return new Response(status === 204 ? null : 'no', { status });
      }) as unknown as typeof fetch;
    await expect(deleteVoteMessage('tok', '1', '2', answer(204))).resolves.toBeUndefined();
    expect(seen[0]).toEqual({ url: 'https://discord.com/api/v10/channels/1/messages/2', method: 'DELETE', auth: 'Bot tok' });
    await expect(deleteVoteMessage('tok', '1', '2', answer(404))).resolves.toBeUndefined();
    await expect(deleteVoteMessage('tok', '1', '2', answer(403))).rejects.toThrow(/403/);
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

const lighting = (id: string, name = id): Lighting => ({ id, name });
// The server's own lighting ids, as of season 2.
const SERVER_IDS = ['DayStartClear', 'DayEarlyClear', 'DayEarlyFog', 'DayClear', 'DayLateClear', 'DayLateGray', 'DayLateGrayFog', 'DayLateRain', 'DayEndClear'];
const serverLightings = SERVER_IDS.map((id) => lighting(id));
const idsOf = (options: { key: string; lightings: Lighting[] }[], key: string) => options.find((o) => o.key === key)?.lightings.map((l) => l.id);

describe('conditionOptions (time of day)', () => {
  it("groups the server's own lighting ids: Start and Early are morning, Late is afternoon, End is dusk", () => {
    const options = conditionOptions(serverLightings);
    expect(options.map((o) => o.key)).toEqual(['morning', 'day', 'afternoon', 'dusk', 'random']);
    expect(idsOf(options, 'morning')).toEqual(['DayStartClear', 'DayEarlyClear', 'DayEarlyFog']);
    expect(idsOf(options, 'day')).toEqual(['DayClear']);
    expect(idsOf(options, 'afternoon')).toEqual(['DayLateClear', 'DayLateGray', 'DayLateGrayFog', 'DayLateRain']);
    expect(idsOf(options, 'dusk')).toEqual(['DayEndClear']);
    expect(options.find((o) => o.key === 'random')?.lightings).toHaveLength(9);
  });

  it('uses names when ids say nothing, and keeps a row to four groups and Random', () => {
    const named = [lighting('A', 'Night, clear'), lighting('B', 'Dusk'), lighting('C', 'Dawn'), lighting('D', 'Sunset'), lighting('E', 'Noon'), lighting('F', 'Day')];
    const options = conditionOptions(named);
    expect(options).toHaveLength(5);
    expect(options.at(-1)?.key).toBe('random');
    // The five times do not all fit: Afternoon and Morning are the ones that go first.
    expect(conditionOptions(named).map((o) => o.key)).toEqual(['morning', 'day', 'dusk', 'night', 'random']);
  });

  it('offers no row when there is nothing to choose between', () => {
    expect(conditionOptions([])).toEqual([]);
    expect(conditionOptions([lighting('Sunny'), lighting('Other')])).toEqual([]);
    expect(conditionOptions([lighting('DayClear')])).toEqual([]);
  });
});

describe('weatherOptions', () => {
  it('groups the server lightings as clear, fog or rain, with overcast counted as clear', () => {
    const options = weatherOptions(serverLightings);
    expect(options.map((o) => o.key)).toEqual(['clear', 'fog', 'rain', 'random']);
    expect(idsOf(options, 'clear')).toEqual(['DayStartClear', 'DayEarlyClear', 'DayClear', 'DayLateClear', 'DayLateGray', 'DayEndClear']);
    expect(idsOf(options, 'fog')).toEqual(['DayEarlyFog', 'DayLateGrayFog']);
    expect(idsOf(options, 'rain')).toEqual(['DayLateRain']);
  });

  it('offers no row when the server has only one kind of weather', () => {
    expect(weatherOptions([lighting('DayClear'), lighting('NightClear')])).toEqual([]);
    expect(weatherOptions([lighting('DayClear'), lighting('NightStorm')]).map((o) => o.key)).toEqual(['clear', 'rain', 'random']);
  });
});

describe('the time of day and weather votes', () => {
  const withBoth = (): MapVote => ({ ...vote(), conditions: conditionOptions(serverLightings), weather: weatherOptions(serverLightings) });
  const apply = (v: MapVote, ballotOf: { user: string; map?: string; light?: string; weather?: string }, at = NOW + 1): MapVote => {
    const cast = castVote(v, ballotOf, at);
    if (!('vote' in cast)) throw new Error(cast.result);
    return cast.vote;
  };
  const voted = (...picks: { light?: string; weather?: string }[]): MapVote =>
    picks.reduce((v, pick, i) => apply(v, { user: `u${i}`, ...pick }), withBoth());
  const chosen = (v: MapVote, roll = 0) => chooseConditions(v, () => roll)?.id;

  it('keeps one vote on the map, the time of day and the weather for each person, changed independently', () => {
    let v = apply(withBoth(), { user: 'a', map: 'A' });
    v = apply(v, { user: 'a', light: 'dusk' });
    v = apply(v, { user: 'a', weather: 'rain' });
    expect(v.ballots).toEqual([{ user: 'a', map: 'A', light: 'dusk', weather: 'rain', at: NOW + 1 }]);
    v = apply(v, { user: 'a', weather: 'fog' });
    v = apply(v, { user: 'a', map: 'B' });
    expect(v.ballots[0]).toMatchObject({ map: 'B', light: 'dusk', weather: 'fog' });
    expect(v.ballots).toHaveLength(1);
  });

  it('says whether a vote was new or moved, for each of the three', () => {
    const v = apply(withBoth(), { user: 'a', map: 'A' });
    expect(castVote(v, { user: 'a', light: 'day' }, NOW + 2).result).toBe('counted');
    expect(castVote(v, { user: 'a', weather: 'fog' }, NOW + 2).result).toBe('counted');
    expect(castVote(v, { user: 'a', map: 'B' }, NOW + 2).result).toBe('changed');
    expect(castVote(apply(v, { user: 'a', weather: 'fog' }), { user: 'a', weather: 'rain' }, NOW + 3).result).toBe('changed');
  });

  it('refuses a choice that is not offered, two at once or none, and any vote on a vote without the row', () => {
    expect(castVote(withBoth(), { user: 'a', light: 'night' }, NOW + 1).result).toBe('unknown-map');
    expect(castVote(withBoth(), { user: 'a', weather: 'snow' }, NOW + 1).result).toBe('unknown-map');
    expect(castVote(withBoth(), { user: 'a', map: 'A', weather: 'rain' }, NOW + 1).result).toBe('unknown-map');
    expect(castVote(withBoth(), { user: 'a' }, NOW + 1).result).toBe('unknown-map');
    expect(castVote(vote(), { user: 'a', light: 'day' }, NOW + 1).result).toBe('unknown-map');
    expect(castVote(vote(), { user: 'a', weather: 'rain' }, NOW + 1).result).toBe('unknown-map');
  });

  it('chooses no lighting when nobody voted on the time of day or the weather', () => {
    expect(chooseConditions(withBoth(), Math.random)).toBeNull();
  });

  it('chooses a lighting that has both the winning time and the winning weather', () => {
    expect(chosen(voted({ light: 'afternoon' }, { weather: 'rain' }))).toBe('DayLateRain');
    expect(chosen(voted({ light: 'morning' }, { weather: 'fog' }))).toBe('DayEarlyFog');
    expect(chosen(voted({ light: 'dusk' }, { weather: 'clear' }))).toBe('DayEndClear');
  });

  it('lets the weather win when no lighting has both, with the time nearest the one chosen', () => {
    // Rain exists only in the afternoon: a dusk vote still gets rain.
    expect(chosen(voted({ light: 'dusk' }, { weather: 'rain' }))).toBe('DayLateRain');
    // Fog is in the morning and the afternoon: day is one step from each, so either.
    expect(new Set([0, 0.99].map((roll) => chosen(voted({ light: 'day' }, { weather: 'fog' }), roll)))).toEqual(new Set(['DayEarlyFog', 'DayLateGrayFog']));
    // Dusk is nearer the afternoon than the morning.
    expect(chosen(voted({ light: 'dusk' }, { weather: 'fog' }), 0.99)).toBe('DayLateGrayFog');
  });

  it('gives any time for weather alone, and a clear lighting for a time alone', () => {
    expect(new Set([0, 0.4, 0.99].map((roll) => chosen(voted({ weather: 'fog' }), roll)))).toEqual(new Set(['DayEarlyFog', 'DayLateGrayFog']));
    // The afternoon has rain and fog too, but nobody asked for them.
    for (const roll of [0, 0.5, 0.99]) expect(['DayLateClear', 'DayLateGray']).toContain(chosen(voted({ light: 'afternoon' }), roll));
  });

  it('gives rain to the weather with the most votes, and a tie to the safest weather rather than to chance', () => {
    // More want rain than clear: rain.
    expect(chosen(voted({ weather: 'rain' }, { weather: 'rain' }, { weather: 'clear' }))).toBe('DayLateRain');
    // Fewer: clear.
    for (const roll of [0, 0.5, 0.99]) {
      expect(chosen(voted({ weather: 'rain' }, { weather: 'clear' }, { weather: 'clear' }), roll)).not.toBe('DayLateRain');
      // Tied: clear, whatever the roll.
      expect(weatherOf(chooseConditions(voted({ weather: 'rain' }, { weather: 'clear' }), () => roll)!)).toBe('clear');
      expect(weatherOf(chooseConditions(voted({ weather: 'rain' }, { weather: 'fog' }), () => roll)!)).toBe('fog');
    }
  });

  it('counts the most votes on each row on its own, and lets Random win across every lighting', () => {
    const v = voted({ light: 'dusk' }, { light: 'dusk' }, { light: 'day' }, { weather: 'rain' }, { weather: 'rain' }, { weather: 'fog' });
    expect(tallyConditions(v).map((c) => c.votes)).toEqual([0, 1, 0, 2, 0]);
    expect(chosen(v)).toBe('DayLateRain');
    const random = voted({ light: 'random' });
    expect(new Set([0, 0.4, 0.99].map((roll) => chosen(random, roll))).size).toBeGreaterThan(1);
  });

  it('never chooses rain when it is not allowed, and counts a vote for rain as no vote', () => {
    const noRain = (v: MapVote, roll = 0) => chooseConditions(v, () => roll, true)?.id;
    for (const roll of [0, 0.5, 0.99]) {
      // Rain with the most votes: it is left out, so the vote for clear is the one that counts.
      expect(noRain(voted({ weather: 'rain' }, { weather: 'rain' }, { weather: 'clear' }), roll)).not.toBe('DayLateRain');
      // Rain alone: no weather was voted on, so the lighting stays as the rotation has it.
      expect(noRain(voted({ weather: 'rain' }), roll)).toBeUndefined();
      // The afternoon has rain too, but a time alone gets a clear lighting anyway; with rain left out, so does Random.
      expect(['DayLateClear', 'DayLateGray']).toContain(noRain(voted({ light: 'afternoon' }, { weather: 'rain' }), roll));
      expect(noRain(voted({ light: 'random' }), roll)).not.toBe('DayLateRain');
      expect(noRain(voted({ weather: 'random' }), roll)).not.toBe('DayLateRain');
      // Fog in the afternoon (with gray) is still fine.
      expect(['DayLateGrayFog', 'DayEarlyFog']).toContain(noRain(voted({ weather: 'fog' }), roll));
    }
  });

  it('keeps rain out of every lighting Random can give, however many vote for it', () => {
    const many = voted(...Array.from({ length: 6 }, () => ({ weather: 'random' })));
    const rolls = Array.from({ length: 100 }, (_, i) => i / 100);
    for (const roll of rolls) expect(weatherOf(chooseConditions(many, () => roll, true)!)).not.toBe('rain');
    // Allowed, it still can.
    expect(rolls.some((roll) => chooseConditions(many, () => roll)?.id === 'DayLateRain')).toBe(true);
  });

  it('says in the Discord message why there may be no rain, or a map is missing', () => {
    const text = (rain: { all: boolean; skipped: string | null }) => voteMessage({ ...withBoth(), rain }, NOW + 1).embeds[0]?.description ?? '';
    expect(text({ all: false, skipped: null })).not.toContain('rain');
    expect(text({ all: true, skipped: null })).toContain('No rain this time');
    expect(text({ all: false, skipped: 'Kavkazi' })).toContain('Bakurani is not in the vote: it had rain last.');
    expect(text({ all: false, skipped: 'Kavkazi' })).not.toContain('No rain');
  });

  it('shows the counts on the website and the chosen lighting once it is on the server', () => {
    let v = voted({ light: 'dusk' }, { weather: 'rain' });
    expect(publicVote(v, NOW + 2).conditions.find((c) => c.key === 'dusk')).toEqual({ key: 'dusk', label: 'Dusk', votes: 1 });
    expect(publicVote(v, NOW + 2).weather.map((c) => [c.key, c.votes])).toEqual([['clear', 0], ['fog', 0], ['rain', 1], ['random', 0]]);
    v = { ...v, outcome: { at: NOW, winner: 'A', pending: false, lighting: 'DayLateRain', lightingName: 'Afternoon, rain' } };
    expect(publicVote(v, NOW + 2).lightingName).toBe('Afternoon, rain');
  });

  it('puts a row and a field for each in the Discord message, and names the lighting at the end', () => {
    const message = voteMessage(withBoth(), NOW + 1);
    expect(message.components).toHaveLength(3);
    const buttons = (i: number) => (message.components[i] as { components: { label: string; custom_id: string }[] }).components;
    expect(buttons(1).map((b) => b.label)).toEqual(['Morning', 'Day', 'Afternoon', 'Dusk', '🎲 Random']);
    expect(buttons(1).map((b) => parseLightButton(b.custom_id)?.light)).toEqual(['morning', 'day', 'afternoon', 'dusk', 'random']);
    expect(buttons(2).map((b) => b.label)).toEqual(['Clear', 'Fog', 'Rain', '🎲 Random']);
    expect(buttons(2).map((b) => parseWeatherButton(b.custom_id))).toEqual([
      { poll: '42', weather: 'clear' },
      { poll: '42', weather: 'fog' },
      { poll: '42', weather: 'rain' },
      { poll: '42', weather: 'random' },
    ]);
    expect(message.embeds[0]?.fields?.slice(-2).map((f) => f.name.replace(/^\S+ /, ''))).toEqual(['Time of day', 'Weather']);
    expect(message.embeds[0]?.description).toContain('the time of day and the weather');
    const done = voteMessage(
      { ...withBoth(), outcome: { at: NOW, winner: 'B', pending: false, lighting: 'DayLateRain', lightingName: 'Afternoon, rain' } },
      NOW + 1,
    );
    expect(done.components).toEqual([]);
    expect(done.embeds[0]?.description).toContain('Bravo');
    expect(done.embeds[0]?.description).toContain('Afternoon, rain');
  });

  it('has no time of day or weather row or field when the server gave too few groups', () => {
    const message = voteMessage(vote(), NOW + 1);
    expect(message.components).toHaveLength(1);
    expect(message.embeds[0]?.fields?.some((f) => f.name.includes('Time') || f.name.includes('Weather'))).toBe(false);
    expect(voteMessage({ ...vote(), weather: weatherOptions(serverLightings) }, NOW + 1).components).toHaveLength(2);
  });

  it('reads a vote stored before the weather vote, with no weather row or votes', () => {
    const { weather: _row, ...older } = vote();
    const stored = { ...older, ballots: [{ user: 'a', map: 'A', light: 'day', at: NOW }] };
    const parsed = parseMapVote(stored);
    expect(parsed?.weather).toEqual([]);
    expect(parsed?.ballots[0]?.weather).toBeNull();
  });
});

describe('parseLightButton and parseWeatherButton', () => {
  it('read only buttons of their own kind', () => {
    expect(parseLightButton('maplight:42:dusk')).toEqual({ poll: '42', light: 'dusk' });
    expect(parseLightButton('mapweather:42:rain')).toBeNull();
    expect(parseLightButton('mapvote:42:Kavkazi')).toBeNull();
    expect(parseLightButton('maplight:x:dusk')).toBeNull();
    expect(parseLightButton(undefined)).toBeNull();
    expect(parseWeatherButton('mapweather:42:rain')).toEqual({ poll: '42', weather: 'rain' });
    expect(parseWeatherButton('maplight:42:dusk')).toBeNull();
    expect(parseWeatherButton('mapweather:x:rain')).toBeNull();
    expect(parseWeatherButton(undefined)).toBeNull();
  });
});

describe('the random map', () => {
  const maps = [choice('Bakurani'), choice('Ozeti'), choice('Zestafona'), choice('Bare')];
  const poolOf = (ms: typeof maps) => ms.map((m) => ({ map: m.id, name: m.name }));
  const withAll = (): MapVote =>
    openVote(
      { startedAt: 42 },
      'Kavkazi',
      [{ map: 'Bakurani', name: 'Bakurani' }, { map: 'Ozeti', name: 'Ozeti' }],
      { options: 2, minutes: 15, closePercent: 95, channelId: '1', botToken: 't', staging: 'rotation' },
      NOW,
      95,
      conditionOptions(serverLightings),
      weatherOptions(serverLightings),
      { pool: poolOf(maps) },
    );
  const apply = (v: MapVote, ballotOf: { user: string; map?: string; light?: string; weather?: string }): MapVote => {
    const cast = castVote(v, ballotOf, NOW + 1);
    if (!('vote' in cast)) throw new Error(cast.result);
    return cast.vote;
  };

  it('offers every playable map the pool, and a Random button only when there is a pool', () => {
    expect(votePool([choice('Now'), choice('A'), choice('B'), choice('C'), choice('NoModes', 0)], 'Now', ['Now'], 2).map((m) => m.id)).toEqual(['A', 'B', 'C']);
    expect(votePool([choice('Now'), choice('A')], 'Now', ['Now'], 2)).toEqual([]);
    expect(withAll().options.map((o) => o.map)).toEqual(['Bakurani', 'Ozeti', RANDOM_MAP]);
    expect(vote().options.map((o) => o.map)).not.toContain(RANDOM_MAP);
  });

  it('picks a map of the pool at random when Random has the most votes', () => {
    const v = apply(apply(withAll(), { user: 'a', map: 'Bakurani' }), { user: 'b', map: RANDOM_MAP });
    // A tie between Bakurani and Random: either way, a map the pool has.
    const winners = new Set([0, 0.4, 0.99].map((roll) => chooseWinner(v, () => roll)));
    expect([...winners].every((w) => ['Bakurani', 'Ozeti', 'Zestafona', 'Bare'].includes(w!))).toBe(true);
    const random = apply(v, { user: 'c', map: RANDOM_MAP });
    expect(new Set([0, 0.3, 0.6, 0.99].map((roll) => chooseWinner(random, () => roll))).size).toBeGreaterThan(1);
    expect(chooseWinner(apply(withAll(), { user: 'a', map: 'Ozeti' }), () => 0.5)).toBe('Ozeti');
  });

  it('puts three rows below the maps in the Discord message, at most five rows in all', () => {
    const message = voteMessage(withAll(), NOW + 1);
    expect(message.components).toHaveLength(3);
    const labels = (i: number) => (message.components[i] as { components: { label: string }[] }).components.map((b) => b.label);
    expect(labels(0)).toEqual(['Bakurani', 'Ozeti', '🎲 Random']);
    expect(message.embeds[0]?.description).toContain('the time of day and the weather');
    expect(message.embeds[0]?.description).not.toContain('circles');
    const six = { ...withAll(), options: Array.from({ length: 7 }, (_, i) => ({ map: `M${i}`, name: `M${i}` })) };
    expect(voteMessage(six, NOW + 1).components).toHaveLength(4);
  });

  it('says the circles the winner got, once it is on the server', () => {
    const won = { ...withAll(), outcome: { at: NOW, winner: 'Ozeti', pending: false, zone: 'Z.Line', zoneName: 'Line' } };
    expect(voteMessage(won, NOW + 1).embeds[0]?.description).toContain('**Line** circles');
    expect(publicVote(won, NOW + 1).zoneName).toBe('Line');
  });

  it('reads a vote stored with a circles row and votes, ignoring them', () => {
    const stored = { ...vote(), zones: [{ key: 'z0', label: 'Circle', zones: [] }], ballots: [{ user: 'a', map: 'A', light: null, weather: null, zone: 'z0', at: NOW }] };
    const parsed = parseMapVote(stored);
    expect(parsed?.ballots[0]).toEqual({ user: 'a', map: 'A', light: null, weather: null, at: NOW });
    expect(parsed).not.toHaveProperty('zones');
  });
});

describe('randomZone', () => {
  const layouts = [
    { id: 'Z.Circle', name: 'Circle' },
    { id: 'Z.Line', name: 'Line' },
    { id: 'Z.Factory', name: 'Factory' },
  ];
  const rolls = [0, 0.2, 0.4, 0.6, 0.8, 0.99];

  it('never gives the layout the map last had', () => {
    for (const last of layouts.map((l) => l.id)) {
      const picked = rolls.map((roll) => randomZone(layouts, last, () => roll)?.id);
      expect(picked).not.toContain(last);
      expect(new Set(picked).size).toBe(2);
    }
  });

  it('can give any layout when the map has not had one from a vote, or the last is not listed any more', () => {
    expect(new Set(rolls.map((roll) => randomZone(layouts, undefined, () => roll)?.id)).size).toBe(3);
    expect(new Set(rolls.map((roll) => randomZone(layouts, 'Z.Gone', () => roll)?.id)).size).toBe(3);
  });

  it('leaves the rotation as it is for a map with no choice of layout', () => {
    expect(randomZone([], undefined, () => 0)).toBeNull();
    expect(randomZone([layouts[0]!], 'Z.Line', () => 0)).toBeNull();
    expect(randomZone([layouts[0]!, { id: 'Z.None', name: 'None' }], undefined, () => 0)).toBeNull();
    // "None" is never given when there are real layouts.
    const withNone = [{ id: 'Z.Circle', name: 'Circle' }, { id: 'Z.None', name: 'None' }, { id: 'Z.Line', name: 'Line' }];
    expect(new Set(rolls.map((roll) => randomZone(withNone, undefined, () => roll)?.id))).toEqual(new Set(['Z.Circle', 'Z.Line']));
  });
});

describe('the circles across staging retries', () => {
  const layouts = [
    { id: 'Z.Circle', name: 'Circle' },
    { id: 'Z.Line', name: 'Line' },
    { id: 'Z.Factory', name: 'Factory' },
  ];
  const pending = { at: NOW, winner: 'Ozeti', pending: true };

  it('reuses the layout an earlier try drew, even when the draw would now differ', () => {
    const first = zoneForTry(pending, layouts, 'Z.Circle', () => 0);
    const retry = zoneForTry(outcomeWithZone(pending, first), layouts, 'Z.Circle', () => 0.99);
    expect(retry).toEqual(first);
    expect(retry?.id).not.toBe('Z.Circle');
  });

  it('draws again when the layout kept is no longer listed, and still avoids the last', () => {
    const kept = { ...pending, zone: 'Z.Gone', zoneName: 'Gone' };
    for (const roll of [0, 0.5, 0.99]) expect(zoneForTry(kept, layouts, 'Z.Line', () => roll)?.id).not.toBe('Z.Line');
  });

  it('reports the layout that is put on, and none a vote saved before this carried but is not put on', () => {
    expect(outcomeWithZone(pending, layouts[1]!)).toEqual({ ...pending, zone: 'Z.Line', zoneName: 'Line' });
    const legacy = { ...pending, zone: 'Z.Line', zoneName: 'Line' };
    expect(outcomeWithZone(legacy, null)).toEqual(pending);
    expect(outcomeWithZone(legacy, layouts[2]!)).toEqual({ ...pending, zone: 'Z.Factory', zoneName: 'Factory' });
    // Not decided yet (such as the catalogue could not be read): the outcome stays as it was.
    expect(outcomeWithZone(legacy, undefined)).toEqual(legacy);
  });
});

describe('parseLastZones', () => {
  it('reads the layout each map last had, and nothing from anything else', () => {
    expect(parseLastZones({ Ozeti: 'Z.Line' })).toEqual({ Ozeti: 'Z.Line' });
    expect(parseLastZones(undefined)).toEqual({});
    expect(parseLastZones({ Ozeti: 3 })).toEqual({});
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
