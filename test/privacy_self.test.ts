import { describe, expect, it } from 'vitest';
import { makePrivate, parsePrivateProfiles } from '../src/privacy.ts';

describe('profiles a player made private themselves', () => {
  it('are marked, and staff ones are not', () => {
    const player = { steamId: '76561198000000001', name: 'Sarge' };
    expect(makePrivate({}, player, '100000000000000001', 'Sarge', 5, true)?.['76561198000000001']).toEqual({
      name: 'Sarge',
      at: 5,
      by: '100000000000000001',
      byName: 'Sarge',
      self: true,
    });
    expect(makePrivate({}, player, '100000000000000002', 'Mod', 5)?.['76561198000000001']).not.toHaveProperty('self');
  });

  it('are read back with the mark', () => {
    expect(parsePrivateProfiles({ a: { name: 'x', at: 1, by: '1', self: true } })).toEqual({ a: { name: 'x', at: 1, by: '1', self: true } });
  });
});
