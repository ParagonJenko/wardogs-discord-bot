import { describe, expect, it } from 'vitest';
import type { Rotation } from '../src/rcon.ts';
import { fromTheStart } from '../src/rotations.ts';
import { canMoveEntries, parseVoteInsert, planInsert, planMove, rotationFacts, stillInserted, whyNoInsert } from '../src/voteinsert.ts';

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

  it('writes the winner into the slot after the one being played, the rest where they were', () => {
    for (const slot of [0, 1, 2, 3]) {
      const maps = ['A', 'B', 'C', 'D'];
      const plan = planInsert(rotation(maps, slot), slot, voted)!;
      expect(fromTheStart(plan.staged, slot).map((e) => e.map)).toEqual([...maps.slice(0, slot + 1), 'V', ...maps.slice(slot + 1)]);
    }
  });

  it('is not done for a rotation that is off or random, or has no maps', () => {
    expect(planInsert(rotation(['A', 'B'], 0, { enabled: false }), 0, voted)).toBeNull();
    expect(planInsert(rotation(['A', 'B'], 0, { mode: 'Random' }), 0, voted)).toBeNull();
    expect(planInsert(rotation([], 0), 0, voted)).toBeNull();
  });

  it('puts the winner in every slot when the slot is not known, and the rotation back as it is', () => {
    for (const slot of [null, 5]) {
      const plan = planInsert(rotation(['A', 'B', 'C'], -1), slot, voted)!;
      expect(plan.asIs).toBe(true);
      expect(plan.staged).toEqual([voted, voted, voted]);
      expect(plan.restore.map((e) => e.map)).toEqual(['A', 'B', 'C']);
      // Whichever slot the server is on, it goes to the winner next.
      for (const on of [0, 1, 2]) expect(nextAfter(fromTheStart(plan.staged, null), on)).toBe('V');
    }
  });
});

describe('whyNoInsert', () => {
  it('names what keeps the winner out of the rotation, and is null when it can go in', () => {
    expect(whyNoInsert(rotation(['A', 'B'], 0))).toBeNull();
    expect(whyNoInsert(rotation(['A', 'B'], 0, { enabled: false }))).toMatch(/off/);
    expect(whyNoInsert(rotation(['A', 'B'], 0, { mode: 'Random' }))).toMatch(/random/);
    expect(whyNoInsert(rotation([], 0))).toMatch(/no maps/);
  });
});

describe('planMove', () => {
  const voted = { map: 'V', experiences: ['V_KOTH', 'KOTH_InfantryOnly'], lighting: 'Night' };
  // The moves done one swap at a time, as the server does them; what the rotation then plays after `now`.
  const moved = (maps: string[], plan: { add: boolean; from: number; to: number }): string[] => {
    const list = plan.add ? [...maps, 'V'] : [...maps];
    const step = plan.to < plan.from ? -1 : 1;
    for (let at = plan.from; at !== plan.to; at += step) [list[at], list[at + step]] = [list[at + step] as string, list[at] as string];
    return list;
  };

  it('adds the winner and moves it into the slot after the one playing', () => {
    const plan = planMove(rotation(['A', 'B', 'C', 'D'], 1), 1, voted);
    expect(plan).toEqual({ add: true, from: 4, to: 2 });
    expect(moved(['A', 'B', 'C', 'D'], plan)).toEqual(['A', 'B', 'V', 'C', 'D']);
  });

  it('moves the entry the rotation already has with the same setup, from in front of or behind the one playing', () => {
    const same = { ...voted, experiences: ['KOTH_InfantryOnly', 'V_KOTH'] };
    const behind = rotation(['A', 'B', 'C', 'V'], 0);
    behind.entries[3] = { ...behind.entries[3]!, ...same };
    expect(moved(['A', 'B', 'C', 'V'], planMove(behind, 0, voted))).toEqual(['A', 'V', 'B', 'C']);
    const before = rotation(['V', 'A', 'B', 'C'], 2);
    before.entries[0] = { ...before.entries[0]!, ...same };
    expect(moved(['V', 'A', 'B', 'C'], planMove(before, 2, voted))).toEqual(['A', 'B', 'V', 'C']);
  });

  it('adds one when the same map is in the rotation with another setup', () => {
    expect(planMove(rotation(['A', 'V', 'B'], 0), 0, voted).add).toBe(true);
  });

  it('goes to the top when the one playing is the last, or the slot is not known, as the console does', () => {
    expect(planMove(rotation(['A', 'B', 'C'], 2), 2, voted)).toEqual({ add: true, from: 3, to: 0 });
    expect(planMove(rotation(['A', 'B', 'C'], -1), null, voted)).toEqual({ add: true, from: 3, to: 0 });
  });
});

describe('canMoveEntries', () => {
  it('needs both the add and the move routes', () => {
    expect(canMoveEntries(['GET /v1/rotation', 'POST /v1/rotation/entries', 'POST /v1/rotation/entries/*/move'])).toBe(true);
    expect(canMoveEntries(['GET /v1/rotation', 'PUT /v1/config'])).toBe(false);
    expect(canMoveEntries(['POST /v1/rotation/entries'])).toBe(false);
  });
});

describe('rotationFacts', () => {
  it('says what the server said about its rotation', () => {
    expect(rotationFacts(rotation(['A', 'B', 'C'], 1), { rotationIndex: null, rotationNextIndex: 2 })).toBe(
      'rotation on, mode "ordered", 3 maps, marked now: 1, marked next: none; status nowIndex: none, nextIndex: 2',
    );
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
    expect(parseVoteInsert({ ...saved, asIs: true })).toEqual({ ...saved, asIs: true });
    expect(parseVoteInsert({ voteId: 1 })).toBeNull();
    expect(parseVoteInsert(undefined)).toBeNull();
  });
});
