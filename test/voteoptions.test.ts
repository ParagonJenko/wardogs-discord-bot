import { describe, expect, it } from 'vitest';
import { offMapIds, parseVoteOptions, withMap, withRain, type VoteOptions } from '../src/voteoptions.ts';

const NOW = 1_000_000;
const none: VoteOptions = { noRain: null, offMaps: {} };

describe('withRain', () => {
  it('turns rain off with who did it, and on again', () => {
    const off = withRain(none, false, '42', 'Sam', NOW);
    expect(off).toEqual({ noRain: { at: NOW, by: '42', byName: 'Sam' }, offMaps: {} });
    expect(withRain(off!, true, '42', undefined, NOW)).toEqual(none);
  });

  it('is null when rain already is as asked', () => {
    expect(withRain(none, true, '42', undefined, NOW)).toBeNull();
    expect(withRain(withRain(none, false, '42', undefined, NOW)!, false, '43', undefined, NOW + 1)).toBeNull();
  });
});

describe('withMap', () => {
  it('turns a map off and on, and leaves the others and rain alone', () => {
    const rainOff = withRain(none, false, '1', undefined, NOW)!;
    const one = withMap(rainOff, 'NorthAmerica', false, '42', undefined, NOW)!;
    const two = withMap(one, 'Europe', false, '42', undefined, NOW)!;
    expect(offMapIds(two)).toEqual(['NorthAmerica', 'Europe']);
    expect(two.noRain).not.toBeNull();
    const back = withMap(two, 'NorthAmerica', true, '42', undefined, NOW)!;
    expect(offMapIds(back)).toEqual(['Europe']);
  });

  it('is null when the map already is as asked', () => {
    expect(withMap(none, 'NorthAmerica', true, '42', undefined, NOW)).toBeNull();
    expect(withMap(withMap(none, 'NorthAmerica', false, '42', undefined, NOW)!, 'NorthAmerica', false, '43', undefined, NOW)).toBeNull();
  });
});

describe('parseVoteOptions', () => {
  it('reads what was kept, and nothing off from anything else', () => {
    const kept = withMap(none, 'NorthAmerica', false, '42', undefined, NOW)!;
    expect(parseVoteOptions(kept)).toEqual(kept);
    expect(parseVoteOptions(undefined)).toEqual(none);
    expect(parseVoteOptions({ offMaps: 3 })).toEqual(none);
    expect(parseVoteOptions({})).toEqual(none);
  });
});
