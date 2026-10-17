import { z } from 'zod';
import type { FactionScore } from './rcon.ts';
import { isPlaying, type FeedMatchEvent } from './weapons.ts';

// The match as the game tells it through the kill feed since Season 2: its state as it changes, and each match's result
// the moment a side wins. The bot's own checks see the server once a minute, and have to work out from the map changing
// that a match ended, and from the last scores they saw who won; with this they have the game's word for both. Kept in
// storage ('matchFeed'), written with each batch that has a state or a result.

export const MATCH_FEED_KEY = 'matchFeed';

// A match's result as the game sent it, and when the bot got it. `winner` is the side the game named, null when it named
// none; `factionScores` are each side's final scores.
export type MatchResult = {
  at: number;
  map: string;
  matchId: string;
  winner: string | null;
  factionScores: FactionScore[];
  players: number | null;
};

export type MatchFeed = {
  // The latest state, such as MatchState.Playing.KOTH, and when the bot got it.
  state: string | null;
  stateAt: number | null;
  // When the bot got the state that started the latest match being played: the first Playing state after one that is not.
  playingAt: number | null;
  result: MatchResult | null;
};

export const NO_MATCH_FEED: MatchFeed = { state: null, stateAt: null, playingAt: null, result: null };

const time = z.number().nullable();

const MatchFeedSchema = z.object({
  state: z.string().nullable(),
  stateAt: time,
  playingAt: time,
  result: z
    .object({
      at: z.number(),
      map: z.string(),
      matchId: z.string(),
      winner: z.string().nullable(),
      factionScores: z.array(z.object({ name: z.string(), score: z.number(), colorHex: z.string().optional() })),
      players: z.number().nullable(),
    })
    .nullable(),
});

// Nothing saved yet, or anything unrecognisable, is a feed that has said nothing.
export const parseMatchFeed = (raw: unknown): MatchFeed => {
  const parsed = MatchFeedSchema.safeParse(raw);
  return parsed.success ? parsed.data : NO_MATCH_FEED;
};

// A batch's states and results, in the order the game sent them, all got at `at`.
export const recordMatchFeed = (feed: MatchFeed, events: FeedMatchEvent[], at: number): MatchFeed =>
  events.reduce<MatchFeed>((f, e) => {
    if (e.type === 'result') {
      const { map, matchId, winner, factionScores, players } = e;
      return { ...f, result: { at, map, matchId, winner, factionScores, players } };
    }
    const started = isPlaying(e.state) && (f.state === null || !isPlaying(f.state));
    return { ...f, state: e.state, stateAt: at, playingAt: started ? at : f.playingAt };
  }, feed);

// The same side, however the game and RCON write its name.
const sideKey = (name: string): string => name.toLowerCase().replace(/[^a-z]/g, '');

// A result's scores, in the game's order, with each side's colour from the scores the bot's checks saw (`seen`).
export const resultScores = (result: MatchResult, seen: FactionScore[]): FactionScore[] =>
  result.factionScores.map((s) => {
    const colorHex = s.colorHex ?? seen.find((o) => sideKey(o.name) === sideKey(s.name))?.colorHex;
    return { name: s.name, score: s.score, ...(colorHex ? { colorHex } : {}) };
  });

// Whether two maps, as RCON and the feed name them, could be the same: either may be missing.
export const sameMap = (a: string, b: string): boolean => a === '' || b === '' || a === b;
