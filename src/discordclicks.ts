import { z } from 'zod';

// Clicks on the Discord invite, by where on the website (or in game) they were made. The links go through the bot's
// /go/discord?src=<place>, which counts the click and sends the browser on to the invite, so the website needs no
// analytics of its own. A click is not a join: it is as close as the bot can see, and the staff page sets it beside the
// members that joined. Kept by UTC day: 'discordClicks' → { "2026-10-17": { hero: 12, game: 40 } }.

export const DISCORD_CLICKS_KEY = 'discordClicks';

// Days kept, and places counted in a day: more are lumped in 'other', so a stranger's links cannot fill the record.
export const CLICK_DAYS_KEPT = 45;
export const SOURCES_PER_DAY = 30;
export const SOURCE_NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;

export type Clicks = Record<string, Record<string, number>>;

const ClicksSchema = z.record(z.string(), z.record(z.string(), z.number()));

export const parseClicks = (raw: unknown): Clicks => {
  const parsed = ClicksSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
};

// The place a click came from, as written in the link: lowercase letters, digits and dashes. Anything else is 'other'.
export const sourceOf = (asked: string | null): string => (asked !== null && SOURCE_NAME.test(asked) ? asked : 'other');

export const withClick = (clicks: Clicks, src: string, day: string): Clicks => {
  const today = clicks[day] ?? {};
  const known = Object.hasOwn(today, src) || Object.keys(today).length < SOURCES_PER_DAY;
  const place = known ? src : 'other';
  const kept = Object.keys(clicks)
    .concat(day)
    .filter((d, i, all) => all.indexOf(d) === i)
    .sort()
    .slice(-CLICK_DAYS_KEPT);
  return Object.fromEntries(kept.map((d) => [d, d === day ? { ...today, [place]: (Object.hasOwn(today, place) ? (today[place] ?? 0) : 0) + 1 } : (clicks[d] ?? {})]));
};

export type ClickSummary = { days: number; total: number; places: { src: string; clicks: number }[] };

// The last `days` UTC days (ending `today`), most clicked place first.
export const summarise = (clicks: Clicks, today: string, days: number): ClickSummary => {
  const first = new Date(`${today}T00:00:00Z`).getTime() - (days - 1) * 86_400_000;
  const totals = new Map<string, number>();
  for (const [day, places] of Object.entries(clicks)) {
    if (new Date(`${day}T00:00:00Z`).getTime() < first || day > today) continue;
    for (const [src, n] of Object.entries(places)) totals.set(src, (totals.get(src) ?? 0) + n);
  }
  const places = [...totals].map(([src, clicks]) => ({ src, clicks })).sort((a, b) => b.clicks - a.clicks || a.src.localeCompare(b.src));
  return { days, total: places.reduce((sum, p) => sum + p.clicks, 0), places };
};
