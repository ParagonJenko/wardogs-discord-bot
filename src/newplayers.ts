import type { PlayerDay } from './players.ts';

// The staff page's new players: how many came back. A player is new on the first UTC day the bot has them, if it had
// any days before it to look back over; the days the bot keeps (PROFILE_DAYS) are all it can see, so before it has
// kept that many, someone who played a while ago and not since is counted as new. `lookbackDays` is how many days of play
// records it has, up to today.
//
// A cohort is the new players of one week (UTC, Monday first). Someone came back within `n` days when they were seen on
// any of the n days after their first. A return is only counted once those days are over, so a cohort has fewer
// players counted for the longer windows than for the shorter.

export const RETURN_WINDOWS = [1, 7, 30] as const;
export const COHORTS_LISTED = 8;

export type Cohort = {
  // The Monday the week began.
  week: string;
  newPlayers: number;
  // For each window: the new players whose window is over, and how many of them came back.
  windows: { days: number; eligible: number; returned: number }[];
};

export type NewPlayers = {
  lookbackDays: number;
  cohorts: Cohort[];
  // Everyone new in the days kept, by the UTC day they were first seen.
  firstSeen: Map<string, string>;
};

const DAY_MS = 86_400_000;
const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);

// The Monday of the week `day` is in.
export const weekOf = (day: string): string => {
  const ms = dayMs(day);
  return new Date(ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
};

// `days` are the days kept, oldest first, each with its players; `today` is the UTC day now, whose return days are not over.
export const buildNewPlayers = (days: { day: string; players: PlayerDay }[], today: string): NewPlayers => {
  const withPlayers = days.filter((d) => Object.keys(d.players).length > 0);
  const [firstDay] = withPlayers;
  if (firstDay === undefined) return { lookbackDays: 0, cohorts: [], firstSeen: new Map() };
  const seen = new Map<string, string[]>();
  for (const d of withPlayers) for (const steamId of Object.keys(d.players)) seen.set(steamId, [...(seen.get(steamId) ?? []), d.day]);
  // The first day's players could have played before it, so are not new.
  const firstSeen = new Map<string, string>();
  for (const [steamId, on] of seen) {
    const [day] = on;
    if (day !== undefined && day > firstDay.day) firstSeen.set(steamId, day);
  }
  const weeks = new Map<string, Cohort>();
  for (const [steamId, day] of firstSeen) {
    const week = weekOf(day);
    const cohort = weeks.get(week) ?? { week, newPlayers: 0, windows: RETURN_WINDOWS.map((n) => ({ days: n, eligible: 0, returned: 0 })) };
    cohort.newPlayers += 1;
    const first = dayMs(day);
    for (const w of cohort.windows) {
      // Over once the last of its days is before today.
      if (first + w.days * DAY_MS >= dayMs(today)) continue;
      w.eligible += 1;
      if ((seen.get(steamId) ?? []).some((d) => dayMs(d) > first && dayMs(d) <= first + w.days * DAY_MS)) w.returned += 1;
    }
    weeks.set(week, cohort);
  }
  const cohorts = [...weeks.values()].sort((a, b) => (a.week < b.week ? 1 : -1)).slice(0, COHORTS_LISTED);
  return { lookbackDays: Math.round((dayMs(today) - dayMs(firstDay.day)) / DAY_MS), cohorts, firstSeen };
};
