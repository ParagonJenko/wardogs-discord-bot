import { describe, expect, it } from 'vitest';
import { lesserWeapons, weaponPicks } from '../src/coinweapons.ts';
import { isLockOn, namedWeapons, type WeaponDay } from '../src/weapons.ts';

const totals = (kills: number) => ({ kills, headshots: 0, ranged: 0, distance: 0, longest: null });
const guns = namedWeapons().filter((w) => w.kind === 'weapon' && !isLockOn(w.tags[0] ?? ''));
const day = (...rows: [string | undefined, number][]): WeaponDay => Object.fromEntries(rows.flatMap(([tag, kills]) => (tag === undefined ? [] : [[tag, totals(kills)]])));

describe('lesser-used weapons', () => {
  it('are the hand-held weapons with the fewest kills, adding days up, and only ones someone uses', () => {
    const [a, b, c, d] = guns.map((w) => w.tags[0]);
    const list = lesserWeapons([day([a, 10], [b, 100], [c, 3], [d, 40]), day([a, 10], [b, 100])], 15, 2);

    expect(list.map((w) => w.tag)).toEqual([a, d]);
    expect(list[0]?.name).not.toBe('');
  });

  it('leave out what is not a hand-held weapon', () => {
    expect(lesserWeapons([day(['Id.Vehicle.Something', 500])], 1, 5)).toEqual([]);
  });
});

describe('the day’s and the week’s weapon', () => {
  const list = guns.slice(0, 6).map((w) => ({ tag: w.tags[0] ?? '', name: w.name }));
  const at = Date.parse('2026-10-27T12:00:00Z');

  it('are chosen by the date, so the same all day, and are different', () => {
    const a = weaponPicks(list, at);
    expect(weaponPicks(list, at + 3_600_000)).toEqual(a);
    expect(a?.day.tag).not.toBe(a?.week.tag);
  });

  it('are none when there are too few to choose from', () => {
    expect(weaponPicks(list.slice(0, 2), at)).toBeNull();
  });
});
