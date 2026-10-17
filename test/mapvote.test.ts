import { describe, expect, it } from 'vitest';
import {
  castVote,
  chooseWinner,
  closeDue,
  isOpen,
  MAX_BALLOTS,
  networkMark,
  openVote,
  parseMapVote,
  pickOptions,
  publicVote,
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
  openVote({ startedAt: 42 }, 'Kavkazi', [{ map: 'A', name: 'Alpha' }, { map: 'B', name: 'Bravo' }, { map: 'C', name: 'Charlie' }], { options: 3, minutes: 15 }, NOW);
const ballot = (n: number, map: string) => ({ ip: `ip${n}`, token: `token${n}`, map });

describe('pickOptions', () => {
  it('offers playable maps other than the one being played, up to the count', () => {
    const maps = [choice('Now'), choice('A'), choice('B'), choice('C'), choice('D'), choice('NoModes', 0)];
    const options = pickOptions(maps, 'Now', 3, () => 0);
    expect(options).toHaveLength(3);
    expect(options.map((o) => o.map)).not.toContain('Now');
    expect(options.map((o) => o.map)).not.toContain('NoModes');
  });

  it('offers nothing when fewer than two maps could be voted on', () => {
    expect(pickOptions([choice('Now'), choice('A')], 'Now', 4, Math.random)).toEqual([]);
  });
});

describe('castVote', () => {
  it('counts a ballot, and a second from the same browser replaces it', () => {
    const first = castVote(vote(), ballot(1, 'A'), NOW + 1);
    expect(first.result).toBe('counted');
    if (!('vote' in first)) throw new Error('no vote');
    const second = castVote(first.vote, { ...ballot(1, 'B'), ip: 'elsewhere' }, NOW + 2);
    expect(second.result).toBe('changed');
    if (!('vote' in second)) throw new Error('no vote');
    expect(second.vote.ballots).toHaveLength(1);
    expect(second.vote.ballots[0]?.map).toBe('B');
  });

  it('counts one ballot per network, whatever browser it comes from', () => {
    const first = castVote(vote(), ballot(1, 'A'), NOW + 1);
    if (!('vote' in first)) throw new Error('no vote');
    const second = castVote(first.vote, { ip: 'ip1', token: 'a-private-window', map: 'C' }, NOW + 2);
    if (!('vote' in second)) throw new Error('no vote');
    expect(second.result).toBe('changed');
    expect(second.vote.ballots).toHaveLength(1);
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

  it('stops taking new voters at the limit but still lets a voter change theirs', () => {
    const full: MapVote = { ...vote(), ballots: Array.from({ length: MAX_BALLOTS }, (_, i) => ({ ...ballot(i, 'A'), at: NOW })) };
    expect(castVote(full, ballot(MAX_BALLOTS + 1, 'A'), NOW + 1).result).toBe('full');
    expect(castVote(full, ballot(0, 'B'), NOW + 1).result).toBe('changed');
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
  it('closes when time is up or a team is close to winning, and only once', () => {
    expect(closeDue(vote(), NOW + 1, 10, 100)).toBe(false);
    expect(closeDue(vote(), NOW + 15 * 60_000, 10, 100)).toBe(true);
    expect(closeDue(vote(), NOW + 1, 75, 100)).toBe(true);
    expect(closeDue({ ...vote(), outcome: { at: NOW, winner: null, pending: false } }, NOW + 1, 99, 100)).toBe(false);
  });
});

describe('publicVote and storage', () => {
  it('shows votes and the winner but never the ballots or salt', () => {
    const v: MapVote = { ...vote(), ballots: [{ ...ballot(1, 'A'), at: NOW }], outcome: { at: NOW, winner: 'A', pending: false } };
    const shown = publicVote(v, NOW + 1);
    expect(shown).toMatchObject({ open: false, total: 1, winner: { map: 'A', name: 'Alpha' }, infantryOnly: true, pending: false });
    expect(JSON.stringify(shown)).not.toContain(v.salt);
    expect(JSON.stringify(shown)).not.toContain('token1');
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

  it('marks a network differently in each vote, the same within one', async () => {
    const a = vote();
    const b = vote();
    expect(await networkMark(a, '1.2.3.4')).toBe(await networkMark(a, '1.2.3.4'));
    expect(await networkMark(a, '1.2.3.4')).not.toBe(await networkMark(b, '1.2.3.4'));
    expect(await networkMark(a, '1.2.3.4')).not.toContain('1.2.3.4');
  });
});
