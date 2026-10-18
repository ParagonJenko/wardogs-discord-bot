import { describe, expect, it } from 'vitest';
import type { Rotation } from '../src/rcon.ts';
import {
  infantryFromRotation,
  infantryMaps,
  isInfantryOnly,
  NO_RESTART,
  parseRestartWatch,
  playingEntry,
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

describe('playingEntry', () => {
  it('is the entry at the slot, or null without one', () => {
    const r = rotation([{ map: 'A' }, { map: 'B' }], 1);
    expect(playingEntry(r, 1)?.map).toBe('B');
    expect(playingEntry(r, null)).toBeNull();
    expect(playingEntry(r, 5)).toBeNull();
  });
});

describe('infantryFromRotation', () => {
  it('takes the next infantry only map after the slot, going round, with its setup', () => {
    const r = rotation(
      [
        { map: 'A', experiences: INFANTRY, lighting: 'Night' },
        { map: 'B' },
        { map: 'C', experiences: ['C_KOTH_01'] },
        { map: 'D', experiences: ['D_KOTH_01', 'KOTH_InfantryOnly'], lighting: 'DayClear' },
      ],
      1,
    );
    expect(infantryFromRotation(r, 1, 'B')).toEqual({ map: 'D', setup: { experiences: ['D_KOTH_01', 'KOTH_InfantryOnly'], lighting: 'DayClear' } });
    expect(infantryFromRotation(r, 3, 'D')).toEqual({ map: 'A', setup: { experiences: INFANTRY, lighting: 'Night' } });
  });

  it('does not pick the map that is playing', () => {
    const r = rotation([{ map: 'A' }, { map: 'B', experiences: INFANTRY }], 0);
    expect(infantryFromRotation(r, 0, 'B')).toBeNull();
  });

  it('is null when the rotation has no infantry only map', () => {
    expect(infantryFromRotation(rotation([{ map: 'A' }, { map: 'B' }], 0), 0, 'A')).toBeNull();
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
});
