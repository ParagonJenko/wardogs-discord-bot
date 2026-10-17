import { describe, expect, it } from 'vitest';
import {
  castVote,
  chooseWinner,
  closeDue,
  closeScoreFor,
  isOpen,
  openVote,
  parseMapVote,
  parseVoteButton,
  voteMessage,
  editVoteMessage,
  postVoteMessage,
  pickOptions,
  publicVote,
  withPlayed,
  type MapVote,
} from '../src/mapvote.ts';
import type { MapChoice } from '../src/rotationspage.ts';

const choice = (id: string, modes = 1): MapChoice => ({
  id,
  name: id,
  modes: Array.from({ length: modes }, (_, i) => ({ id: `${id}_${i}`, name: `Mode ${i}` })),
  modifiers: [],
  zones: [],
});

const NOW = 1_000_000;
const vote = (): MapVote =>
  openVote({ startedAt: 42 }, 'Kavkazi', [{ map: 'A', name: 'Alpha' }, { map: 'B', name: 'Bravo' }, { map: 'C', name: 'Charlie' }], { options: 3, minutes: 15, closePercent: 95, channelId: '1', botToken: 't' }, NOW, 95);
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
  const withVotes = (picks: string[]): MapVote => ({ ...vote(), ballots: picks.map((map, i) => ({ ...ballot(i, map), at: NOW })) });

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
    const v: MapVote = { ...vote(), ballots: [{ ...ballot(1, 'A'), at: NOW }], outcome: { at: NOW, winner: 'A', pending: false } };
    const shown = publicVote(v, NOW + 1);
    expect(shown).toMatchObject({ open: false, total: 1, winner: { map: 'A', name: 'Alpha' }, infantryOnly: true, pending: false });
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
    ballots: picks.map(([n, map]) => ({ ...ballot(n, map), at: NOW })),
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
