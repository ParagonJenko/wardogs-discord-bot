import { describe, expect, it } from 'vitest';
import { lightingAllowed, lightingsFor } from '../src/maplightings.ts';

const all = ['DayClear', 'DayEarlyFog', 'DayEndClear', 'DayLateGray', 'DayLateRain', 'NightClear'].map((id) => ({ id }));

describe('lightingsFor', () => {
  it('keeps only the four Sabatulo lightings for its map, whatever the case of the ids', () => {
    expect(lightingsFor('Russia', all).map((l) => l.id)).toEqual(['DayClear', 'DayLateGray', 'DayLateRain']);
    expect(lightingsFor('russia', all)).toHaveLength(3);
    expect(lightingAllowed('RUSSIA', 'daylateclear')).toBe(true);
  });

  it('allows every lighting on a map that has no limit', () => {
    expect(lightingsFor('Kavkazi', all)).toEqual(all);
    expect(lightingAllowed('constructor', 'NightClear')).toBe(true);
  });
});
