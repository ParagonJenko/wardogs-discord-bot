import { hash, weekOf, type WeaponPick } from './coins.ts';
import { dayOf } from './stats.ts';
import { isLockOn, isNamed, weaponKind, weaponName, type WeaponDay } from './weapons.ts';

// The weapons the weapon missions ask for: the lesser-used hand-held weapons, from the kill feed's totals over the last days. A weapon
// has to have at least LEAST kills in them, so there is somebody using it, and it is one of the COUNT with the fewest.
export const LESSER_LEAST = 15;
export const LESSER_COUNT = 12;
// Fewer than this many to choose from, and there are no weapon missions.
export const LESSER_MIN = 3;

export const lesserWeapons = (days: WeaponDay[], least = LESSER_LEAST, count = LESSER_COUNT): WeaponPick[] => {
  const kills = new Map<string, { tag: string; kills: number }>();
  for (const day of days) {
    for (const [cause, w] of Object.entries(day)) {
      if (weaponKind(cause) !== 'weapon' || !isNamed(cause) || isLockOn(cause)) continue;
      const key = cause.toLowerCase();
      kills.set(key, { tag: kills.get(key)?.tag ?? cause, kills: (kills.get(key)?.kills ?? 0) + w.kills });
    }
  }
  return [...kills.values()]
    .filter((w) => w.kills >= least)
    .sort((a, b) => a.kills - b.kills || a.tag.localeCompare(b.tag))
    .slice(0, count)
    .map((w) => ({ tag: w.tag, name: weaponName(w.tag) }));
};

// The week's weapon: chosen by the week's date so everyone is asked for the same, and kept for the week by the caller.
export const weekPick = (list: WeaponPick[], at: number): WeaponPick | null =>
  list.length < LESSER_MIN ? null : (list[hash(`weapon:${weekOf(at)}`) % list.length] as WeaponPick);

// The day's weapon, a different one from the week's, chosen by the date.
export const dayPick = (list: WeaponPick[], at: number, week: WeaponPick): WeaponPick | null => {
  const others = list.filter((w) => w.tag.toLowerCase() !== week.tag.toLowerCase());
  return others.length === 0 ? null : (others[hash(`weapon:${dayOf(at)}`) % others.length] as WeaponPick);
};
