import { describe, expect, it } from 'vitest';
import { parseMatchZones, withMatchZone, zoneOfMatch, zoneOfSlot } from '../src/matchzone.ts';
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

describe('match notes', () => {
  it('give the layout noted for that match only', () => {
    const notes = withMatchZone(withMatchZone([], { startedAt: 1, zone: 'Circle' }), { startedAt: 2 });
    expect(zoneOfMatch(notes, 1)).toBe('Circle');
    expect(zoneOfMatch(notes, 2)).toBeUndefined();
    expect(zoneOfMatch(notes, 3)).toBeUndefined();
  });
  it('keep an earlier match note while a later one is added, and only the latest few', () => {
    let notes = withMatchZone([], { startedAt: 1, zone: 'Circle' });
    expect(zoneOfMatch(withMatchZone(notes, { startedAt: 2, zone: 'Line' }), 1)).toBe('Circle');
    for (let i = 2; i <= 7; i++) notes = withMatchZone(notes, { startedAt: i, zone: 'Line' });
    expect(zoneOfMatch(notes, 1)).toBeUndefined();
    expect(zoneOfMatch(notes, 7)).toBe('Line');
  });
  it('are read back, or none when unreadable', () => {
    expect(parseMatchZones([{ startedAt: 1, zone: 'Circle' }])).toEqual([{ startedAt: 1, zone: 'Circle' }]);
    expect(parseMatchZones('nope')).toEqual([]);
  });
});
