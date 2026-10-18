import { describe, expect, it } from 'vitest';
import type { Rotation } from '../src/rcon.ts';
import {
  infantryFromRotation,
  infantryMaps,
  justStarted,
  isInfantryOnly,
  NO_RESTART,
  parseRestartWatch,
  RESTART_WINDOW_MS,
  settled,
  watchRestart,
} from '../src/restartmap.ts';

const INFANTRY = ['A_KOTH_01', 'KOTH_InfantryOnly'];

const rotation = (entries: { map: string; experiences?: string[]; lighting?: string }[], now: number): Rotation => ({
  enabled: true,
  mode: 'ordered',
  entries: entries.map((e, i) => ({ ...e, status: i === now ? 'now' : null })),
});

describe('watchRestart', () => {
  it('notes when the server stops answering, and keeps the first time', () => {
    const down = watchRestart(NO_RESTART, false, 1000);
    expect(down).toEqual({ watch: { downSince: 1000, pendingSince: null }, due: false });
    expect(watchRestart(down.watch, false, 2000).watch.downSince).toBe(1000);
  });

  it('is due when the server answers again after not answering', () => {
    const { watch } = watchRestart(NO_RESTART, false, 1000);
    expect(watchRestart(watch, true, 61_000)).toEqual({ watch: { downSince: null, pendingSince: 61_000 }, due: true });
  });

  it('is not due while the server keeps answering', () => {
    expect(watchRestart(NO_RESTART, true, 1000)).toEqual({ watch: NO_RESTART, due: false });
  });

  it('stays due on later checks until settled, and gives up after the window', () => {
    const back = { downSince: null, pendingSince: 1000 };
    expect(watchRestart(back, true, 1000 + 60_000).due).toBe(true);
    expect(watchRestart(back, true, 1000 + RESTART_WINDOW_MS + 1)).toEqual({ watch: NO_RESTART, due: false });
    expect(watchRestart(settled(back), true, 1000 + 60_000).due).toBe(false);
  });

  it('starts again when the server falls again before it was checked', () => {
    const down = watchRestart({ downSince: null, pendingSince: 1000 }, false, 2000);
    expect(down.watch).toEqual({ downSince: 2000, pendingSince: 1000 });
    expect(watchRestart(down.watch, true, 9000).watch.pendingSince).toBe(9000);
  });
});

describe('parseRestartWatch', () => {
  it('reads what was saved, and nothing saved or damaged is no restart', () => {
    expect(parseRestartWatch({ downSince: 1, pendingSince: null })).toEqual({ downSince: 1, pendingSince: null });
    expect(parseRestartWatch(undefined)).toEqual(NO_RESTART);
    expect(parseRestartWatch({ downSince: 'x' })).toEqual(NO_RESTART);
  });
});

describe('isInfantryOnly', () => {
  it('finds the infantry only modifier among the experiences', () => {
    expect(isInfantryOnly(INFANTRY)).toBe(true);
    expect(isInfantryOnly(['A_KOTH_01', 'KOTH_Hardcore'])).toBe(false);
    expect(isInfantryOnly(['A_KOTH_01'])).toBe(false);
    expect(isInfantryOnly(undefined)).toBe(false);
  });
});

describe('infantryFromRotation', () => {
  it('takes the first infantry only entry, with its setup', () => {
    const r = rotation(
      [
        { map: 'A' },
        { map: 'B', experiences: ['B_KOTH_01', 'KOTH_InfantryOnly'], lighting: 'DayClear' },
        { map: 'C', experiences: INFANTRY, lighting: 'Night' },
      ],
      0,
    );
    expect(infantryFromRotation(r)).toEqual({ map: 'B', setup: { experiences: ['B_KOTH_01', 'KOTH_InfantryOnly'], lighting: 'DayClear' } });
  });

  it('can start part-way and go round', () => {
    const r = rotation([{ map: 'A', experiences: INFANTRY }, { map: 'B' }, { map: 'C', experiences: INFANTRY }], 0);
    expect(infantryFromRotation(r, 1)?.map).toBe('C');
    expect(infantryFromRotation(r, 2)?.map).toBe('C');
    expect(infantryFromRotation(r, 3)?.map).toBe('A');
  });

  it('writes a retired experience as its replacement', () => {
    const r = rotation([{ map: 'Bakurani', experiences: ['Bakurani_KOTH_01', 'KOTH_InfantryOnly'] }], 0);
    expect(infantryFromRotation(r)?.setup.experiences).toEqual(['Bakurani_KOTH_02', 'KOTH_InfantryOnly']);
  });

  it('is null when the rotation has no infantry only map', () => {
    expect(infantryFromRotation(rotation([{ map: 'A' }, { map: 'B' }], 0))).toBeNull();
    expect(infantryFromRotation(rotation([], 0))).toBeNull();
  });
});

describe('justStarted', () => {
  it('is a match where no side has a point', () => {
    expect(justStarted([{ score: 0 }, { score: 0 }])).toBe(true);
    expect(justStarted([{ score: 0 }, { score: 3 }])).toBe(false);
  });

  it('is not a match the server gave no scores for', () => {
    expect(justStarted([])).toBe(false);
  });
});

describe('infantryMaps', () => {
  const choice = (id: string, modifiers: string[], modes = 1) => ({
    id,
    name: id,
    modes: Array.from({ length: modes }, (_, i) => ({ id: `${id}_${i}`, name: 'm' })),
    modifiers: modifiers.map((key) => ({ key, name: key, id: key })),
    zones: [],
  });

  it('keeps maps with a game mode and their own infantry only, other than the one playing', () => {
    const maps = [choice('A', ['infantry_only']), choice('B', ['hardcore']), choice('C', ['infantry_only'], 0), choice('D', ['infantry_only'])];
    expect(infantryMaps(maps, 'A').map((m) => m.id)).toEqual(['D']);
  });

  it('allows the playing map when no other map can be played infantry only', () => {
    const maps = [choice('A', ['infantry_only']), choice('B', ['hardcore'])];
    expect(infantryMaps(maps, 'A').map((m) => m.id)).toEqual(['A']);
    expect(infantryMaps(maps, 'B').map((m) => m.id)).toEqual(['A']);
  });
});
