import { z } from 'zod';
import type { VipRule } from './config.ts';
import { factionKey } from './discord.ts';
import { ranks, totals, type MatchRecord, type PlayerDay, type PlayerTotals, type Ranks } from './players.ts';
import type { FactionScore, Player } from './rcon.ts';
import { byKills } from './tracking.ts';
import type { VipGrant } from './vip.ts';
import type { PlayerWeaponsPage } from './weapons.ts';

// Player pages for the website: GET /api/player?id=<id> serves one player's page, and GET /api/players the list to
// find them in. Both are public, so players are known by a public id instead of their Steam ID: the first 6 bytes
// of an HMAC of the Steam ID, keyed with random bytes only the bot has. Anyone can open a player's page, but nobody
// can turn an id back into a Steam ID.

export const PLAYER_ID = /^[0-9a-f]{12}$/;

const ID_KEY = /^[0-9a-f]{64}$/;

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

// A new key for the ids, as 64 hex characters. Changing it changes every player's id, so it is made once and stored.
export const newIdKey = (): string => hex(crypto.getRandomValues(new Uint8Array(32)));

export const isIdKey = (value: unknown): value is string => typeof value === 'string' && ID_KEY.test(value);

export const importIdKey = (key: string): Promise<CryptoKey> => {
  const bytes = new Uint8Array(key.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(key.slice(i * 2, i * 2 + 2), 16);
  return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
};

export const publicId = async (key: CryptoKey, steamId: string): Promise<string> => {
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(steamId));
  return hex(new Uint8Array(mac, 0, 6));
};

// Who was in game at the last check that reached the server. It is stored with each check, so player pages still
// know who is online after the Durable Object restarts. `map` is as RCON names it.
export type OnlineSnapshot = { at: number; map: string; players: Player[] };

const OnlineSchema = z.object({
  at: z.number(),
  map: z.string(),
  players: z.array(
    z.object({
      steamId: z.string(),
      name: z.string(),
      kills: z.number().nullable(),
      deaths: z.number().nullable(),
      faction: z.string().optional(),
    }),
  ),
});

// Null when nothing was saved yet, or it is unrecognisable.
export const parseOnline = (raw: unknown): OnlineSnapshot | null => {
  const parsed = OnlineSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

export type MatchResult = 'won' | 'lost' | 'draw';

// One match a player played, from the match's record.
export type PlayerMatch = {
  map: string;
  endedAt: number;
  durationMs: number;
  kills: number;
  deaths: number;
  // Their place on the scoreboard (most kills, then fewest deaths; players level on both share a place), out of
  // everyone seen in the match.
  place: number;
  players: number;
  // The side they ended the match on, and how it did. Null for matches recorded before sides were kept, and for a
  // side the scores do not name.
  faction: string | null;
  result: MatchResult | null;
  factionScores: FactionScore[];
};

// A UTC day the player was on the server: their totals for it, without the name.
export type ActiveDay = Omit<PlayerTotals, 'name'> & { day: string };

// What they are doing in the match on now. Kills and deaths are their totals for the match so far.
export type OnlineNow = { map: string; faction: string | null; kills: number; deaths: number };

export type PlayerProfile = {
  generatedAt: number;
  id: string;
  name: string;
  // How many UTC days back, today included, the activity and matches go.
  days: number;
  // Oldest first, only days they were on.
  activity: ActiveDay[];
  // Newest first.
  matches: PlayerMatch[];
  ranks: Ranks;
  online: OnlineNow | null;
  // A reserved slot from the bot, earned by seeding or given by staff, and until when.
  vip: { until: number } | null;
  // How close they are to earning seeder VIP: seed days in the bot's window. Null when automatic VIP is off.
  seeding: { rule: VipRule; seedDays: number } | null;
  // Their kills by weapon each day, from the game's kill feed. Null when the bot has never had the feed.
  weapons: PlayerWeaponsPage | null;
};

export type DayRecords = { day: string; players: PlayerDay };

// A player's matches go out newest first, at most this many.
export const PROFILE_MATCHES = 500;

const resultFor = (faction: string | null, scores: FactionScore[]): MatchResult | null => {
  const [first, second] = [...scores].sort((a, b) => b.score - a.score);
  const mine = faction === null ? undefined : scores.find((s) => factionKey(s.name) === factionKey(faction));
  if (first === undefined || second === undefined || mine === undefined) return null;
  if (first.score === second.score) return mine.score === first.score ? 'draw' : 'lost';
  return mine === first ? 'won' : 'lost';
};

export const playerMatch = (record: MatchRecord, steamId: string): PlayerMatch | null => {
  const me = record.players.find((p) => p.steamId === steamId);
  if (me === undefined) return null;
  const faction = me.faction ?? null;
  return {
    map: record.map,
    endedAt: record.endedAt,
    durationMs: record.durationMs,
    kills: me.kills,
    deaths: me.deaths,
    place: 1 + record.players.filter((p) => byKills(p, me) < 0).length,
    players: record.players.length,
    faction,
    result: resultFor(faction, record.factionScores),
    factionScores: record.factionScores,
  };
};

export type ProfileSources = {
  steamId: string;
  id: string;
  now: number;
  // Every UTC day the page covers, oldest first, today last.
  days: DayRecords[];
  // The match records over the same days, in any order.
  matches: MatchRecord[];
  // How many of the latest days the ranks cover, as on the leaderboard.
  rankDays: number;
  online: OnlineNow | null;
  vip: VipGrant | null;
  rule: VipRule | null;
  weapons: PlayerWeaponsPage | null;
};

// Null when the bot has nothing on them in those days.
export const buildProfile = ({ steamId, id, now, days, matches, rankDays, online, vip, rule, weapons }: ProfileSources): PlayerProfile | null => {
  const mine = (d: DayRecords): PlayerTotals | undefined => d.players[steamId];
  // Everyone in a match is credited with it on the day it ended, so anyone with a match has a day too.
  const name = days.map(mine).findLast((t) => t !== undefined)?.name;
  if (name === undefined) return null;
  const activity = days.flatMap((d) => {
    const day = mine(d);
    if (day === undefined) return [];
    const { name: _name, ...totals } = day;
    return [{ day: d.day, ...totals }];
  });
  const seedDays = (window: number): number => days.slice(-window).reduce((sum, d) => sum + (mine(d)?.seedDays ?? 0), 0);
  return {
    generatedAt: now,
    id,
    name,
    days: days.length,
    activity,
    matches: matches
      .flatMap((record) => playerMatch(record, steamId) ?? [])
      .sort((a, b) => b.endedAt - a.endedAt)
      .slice(0, PROFILE_MATCHES),
    ranks: ranks(totals(days.slice(-rankDays).map((d) => d.players)), steamId, rankDays),
    online,
    vip: vip === null || vip.expiresAt <= now ? null : { until: vip.expiresAt },
    seeding: rule === null ? null : { rule, seedDays: seedDays(rule.windowDays) },
    weapons,
  };
};

export type DirectoryEntry = { id: string; name: string; minutes: number; lastSeen: string; online: boolean };

// Everyone seen in the last `days` UTC days, most time played first.
export type PlayerDirectory = { generatedAt: number; days: number; players: DirectoryEntry[] };

export const directory = (
  days: DayRecords[],
  idOf: (steamId: string) => string | undefined,
  online: Set<string>,
  now: number,
): PlayerDirectory => {
  const lastSeen = new Map<string, string>();
  for (const { day, players } of days) for (const steamId of Object.keys(players)) lastSeen.set(steamId, day);
  return {
    generatedAt: now,
    days: days.length,
    players: totals(days.map((d) => d.players))
      .flatMap((p) => {
        const id = idOf(p.steamId);
        const seen = lastSeen.get(p.steamId);
        if (id === undefined || seen === undefined) return [];
        return [{ id, name: p.name, minutes: p.seedingMinutes + p.liveMinutes, lastSeen: seen, online: online.has(p.steamId) }];
      })
      .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name)),
  };
};
