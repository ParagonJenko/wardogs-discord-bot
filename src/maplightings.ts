// Lightings a map can only be played with, by lower-case map id. The server's catalogue lists every lighting, not the ones
// each map has, so this is kept here. Sabatulo (Russia) has these four, from season 3 (12 November 2026). A map that is not
// here can be played with any lighting. A Map, so an id such as "constructor" finds nothing rather than what every object has.
const ONLY = new Map([['russia', ['DayClear', 'DayLateClear', 'DayLateGray', 'DayLateRain']]]);

// Whether a map can be played with a lighting (ids compared ignoring case).
export const lightingAllowed = (map: string, lighting: string): boolean => {
  const allowed = ONLY.get(map.toLowerCase());
  return allowed === undefined || allowed.some((id) => id.toLowerCase() === lighting.toLowerCase());
};

// The lightings a map can be played with, from a list of them.
export const lightingsFor = <T extends { id: string }>(map: string, lightings: readonly T[]): T[] => lightings.filter((l) => lightingAllowed(map, l.id));
