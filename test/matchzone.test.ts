import { describe, expect, it } from 'vitest';
import { parseMatchZone, zoneOfMatch, zoneOfSlot } from '../src/matchzone.ts';
import type { Rotation } from '../src/rcon.ts';

const rotation: Rotation = {
  enabled: true,
  mode: 'sequence',
  entries: [
    { map: 'Bakurani', status: 'now', zoneAlternator: 'ZoneAlternator.Bakurani.Default.Circle' },
    { map: 'Bakurani', status: null },
  ],
};

describe('zoneOfSlot', () => {
  it('names the layout of the slot the server is on', () => {
    expect(zoneOfSlot(rotation, { rotationIndex: 0 })).toBe('Circle');
  });
  it('has none when the entry sets no layout', () => {
    expect(zoneOfSlot({ ...rotation, entries: [{ map: 'Bakurani', status: 'now' }] }, { rotationIndex: null })).toBeUndefined();
  });
});

describe('zoneOfMatch', () => {
  it('only gives the layout noted for that match', () => {
    const noted = parseMatchZone({ key: 'Bakurani#0', zone: 'Circle' });
    expect(zoneOfMatch(noted, 'Bakurani#0')).toBe('Circle');
    expect(zoneOfMatch(noted, 'Bakurani#1')).toBeUndefined();
    expect(zoneOfMatch(null, 'Bakurani#0')).toBeUndefined();
  });
});
