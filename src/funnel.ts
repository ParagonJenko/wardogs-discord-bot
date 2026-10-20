import type { PlayerDay } from './players.ts';

// The staff page's Discord growth card, one step further: of the players who signed in on the website and linked a Steam
// account, how many have played a match, and how many play regularly. Counts only. The Steam IDs are the accounts' and
// are matched against the days' players here, and never leave the bot.

// A player who has played this many matches in the days kept is a regular.
export const REGULAR_MATCHES = 5;

export type Funnel = { linked: number; played: number; regulars: number };

// `linked` are the linked Steam IDs, `days` the days kept.
export const buildFunnel = (linked: string[], days: { players: PlayerDay }[]): Funnel => {
  const matches = new Map<string, number>();
  for (const d of days) for (const [steamId, totals] of Object.entries(d.players)) matches.set(steamId, (matches.get(steamId) ?? 0) + totals.matches);
  const ids = new Set(linked);
  let played = 0;
  let regulars = 0;
  for (const steamId of ids) {
    const n = matches.get(steamId) ?? 0;
    if (n >= 1) played += 1;
    if (n >= REGULAR_MATCHES) regulars += 1;
  }
  return { linked: ids.size, played, regulars };
};
