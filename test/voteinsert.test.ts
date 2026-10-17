import { describe, expect, it } from 'vitest';
import type { Rotation } from '../src/rcon.ts';
import { fromTheStart } from '../src/rotations.ts';
import { parseVoteInsert, planInsert, stillInserted } from '../src/voteinsert.ts';

const rotation = (maps: string[], now: number, over: Partial<Rotation> = {}): Rotation => ({
  enabled: true,
  mode: 'ordered',
  entries: maps.map((map, i) => ({ map, status: i === now ? 'now' : null, ...(map === 'A' ? { lighting: 'DayClear' } : {}) })),
  ...over,
});

// The server keeps the slot it is on when the rotation changes and goes to the next slot in the new list.
const nextAfter = (written: { map: string }[], slot: number): string => written[(slot + 1) % written.length]!.map;

describe('planInsert', () => {
  const voted = { map: 'V', experiences: ['V_KOTH', 'KOTH_InfantryOnly'], lighting: 'Night' };

  it('puts the winner first, then the rotation as it would have gone, then the map being played', () => {
    const plan = planInsert(rotation(['A', 'B', 'C', 'D'], 1), 1, voted)!;
    expect(plan.staged.map((e) => e.map)).toEqual(['V', 'C', 'D', 'A', 'B']);
    expect(plan.restore.map((e) => e.map)).toEqual(['C', 'D', 'A', 'B']);
    expect(plan.staged[0]).toEqual(voted);
  });

  it('keeps each map\'s own setup, and not whether it is the one playing', () => {
    const plan = planInsert(rotation(['A', 'B'], 1), 1, voted)!;
    expect(plan.restore).toEqual([{ map: 'A', lighting: 'DayClear' }, { map: 'B' }]);
  });

  it('plays the winner next, then the rotation carries on where it was, wherever the slot is', () => {
    for (const slot of [0, 1, 2, 3]) {
      const maps = ['A', 'B', 'C', 'D'];
      const plan = planInsert(rotation(maps, slot), slot, voted)!;
      // The winner goes in.
      const written = fromTheStart(plan.staged, slot);
      expect(nextAfter(written, slot)).toBe('V');
      // The server went to the winner's slot. Putting the rotation back, it goes on to the map that was next.
      const playing = (slot + 1) % written.length;
      const back = fromTheStart(plan.restore, playing);
      expect(nextAfter(back, playing)).toBe(maps[(slot + 1) % maps.length]);
      // And on round the rest in order.
      expect([...Array(maps.length).keys()].map((i) => back[(playing + 1 + i) % back.length]!.map)).toEqual(plan.restore.map((e) => e.map));
    }
  });

  it('is not done for a rotation that is off or random, an unknown slot, or no maps', () => {
    expect(planInsert(rotation(['A', 'B'], 0, { enabled: false }), 0, voted)).toBeNull();
    expect(planInsert(rotation(['A', 'B'], 0, { mode: 'Random' }), 0, voted)).toBeNull();
    expect(planInsert(rotation(['A', 'B'], 0), null, voted)).toBeNull();
    expect(planInsert(rotation(['A', 'B'], 0), 5, voted)).toBeNull();
    expect(planInsert(rotation([], 0), 0, voted)).toBeNull();
  });
});

describe('stillInserted', () => {
  const insert = { voteId: '1', fromMap: 'B', map: 'V', restore: [], length: 5, at: 0 };

  it('is true while the rotation has the winner in it and is the length that was written', () => {
    expect(stillInserted(rotation(['V', 'C', 'D', 'A', 'B'], 0), insert)).toBe(true);
  });

  it('is false once someone has changed the rotation', () => {
    expect(stillInserted(rotation(['A', 'B', 'C', 'D'], 0), insert)).toBe(false);
    expect(stillInserted(rotation(['X', 'C', 'D', 'A', 'B'], 0), insert)).toBe(false);
  });
});

describe('parseVoteInsert', () => {
  it('reads what was saved, and nothing else', () => {
    const saved = { voteId: '1', fromMap: 'B', map: 'V', restore: [{ map: 'C', lighting: 'X' }], length: 2, at: 5 };
    expect(parseVoteInsert(saved)).toEqual(saved);
    expect(parseVoteInsert({ voteId: 1 })).toBeNull();
    expect(parseVoteInsert(undefined)).toBeNull();
  });
});
