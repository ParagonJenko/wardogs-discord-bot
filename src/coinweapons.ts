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

// The day's weapon and the week's, a different one, chosen by the date so everyone is asked for the same. Null when there are too few.
export const weaponPicks = (list: WeaponPick[], at: number): { day: WeaponPick; week: WeaponPick } | null => {
  if (list.length < LESSER_MIN) return null;
  const day = list[hash(`weapon:${dayOf(at)}`) % list.length] as WeaponPick;
  const others = list.filter((w) => w.tag !== day.tag);
  return { day, week: others[hash(`weapon:${weekOf(at)}`) % others.length] as WeaponPick };
};
