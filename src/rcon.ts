import { z } from 'zod';

// WARDOGS RCON is a plain HTTP/JSON API (default port 7776). Only the fields the bot uses are checked;
// fields that live builds have been seen to omit are optional.
const StatusSchema = z.object({
  serverName: z.string(),
  map: z.string().nullish(),
  players: z.object({
    current: z.number().int(),
    max: z.number().int(),
  }),
  factionScores: z.array(z.object({ name: z.string(), score: z.number() })).nullish(),
  rotation: z.object({ nowIndex: z.number().int().nullish() }).nullish(),
});

const PlayersSchema = z.object({
  players: z.array(
    z.object({
      name: z.string(),
      steamId: z.string(),
      kills: z.number().int().nullish(),
      deaths: z.number().int().nullish(),
    }),
  ),
});

export type FactionScore = { name: string; score: number };

export type ServerStatus = {
  name: string;
  players: number;
  maxPlayers: number;
  map: string;
  rotationIndex: number | null;
  factionScores: FactionScore[];
};

export type Player = { steamId: string; name: string; kills: number; deaths: number };

export type Snapshot = { status: ServerStatus; players: Player[] };

export type HttpResponse = { status: number; body: string };
export type HttpGet = (url: URL, headers: Record<string, string>) => Promise<HttpResponse>;

const rconGet = async (rconUrl: string, password: string, path: string, get: HttpGet): Promise<unknown> => {
  const response = await get(new URL(path, rconUrl), {
    Authorization: `Bearer ${password}`,
    Accept: 'application/json',
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error(`RCON rejected the password (${response.status})`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`RCON request failed: ${path} ${response.status}`);
  }
  return JSON.parse(response.body);
};

export const fetchStatus = async (rconUrl: string, password: string, get: HttpGet): Promise<ServerStatus> => {
  const status = StatusSchema.parse(await rconGet(rconUrl, password, '/v1/status', get));
  return {
    name: status.serverName,
    players: status.players.current,
    maxPlayers: status.players.max,
    map: status.map ?? '',
    rotationIndex: status.rotation?.nowIndex ?? null,
    factionScores: status.factionScores ?? [],
  };
};

export const fetchPlayers = async (rconUrl: string, password: string, get: HttpGet): Promise<Player[]> => {
  const { players } = PlayersSchema.parse(await rconGet(rconUrl, password, '/v1/players', get));
  return players.map((player) => ({
    steamId: player.steamId,
    name: player.name,
    kills: player.kills ?? 0,
    deaths: player.deaths ?? 0,
  }));
};

export const fetchSnapshot = async (rconUrl: string, password: string, get: HttpGet): Promise<Snapshot> => ({
  status: await fetchStatus(rconUrl, password, get),
  players: await fetchPlayers(rconUrl, password, get),
});

// For Node, where fetch can reach an IP address and any port.
export const fetchGet =
  (timeoutMs = 8_000): HttpGet =>
  async (url, headers) => {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    return { status: response.status, body: await response.text() };
  };
