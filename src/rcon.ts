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

// kills and deaths are null when a reading leaves them out, so a gap is never mistaken for a reset.
export type Player = { steamId: string; name: string; kills: number | null; deaths: number | null };

export type Snapshot = { status: ServerStatus; players: Player[] };

const RotationSchema = z.object({
  enabled: z.boolean().nullish(),
  mode: z.string().nullish(),
  entries: z.array(z.object({ map: z.string(), status: z.string().nullish() })),
});

export type Rotation = {
  enabled: boolean;
  mode: string;
  entries: { map: string; status: string | null }[];
};

export type HttpResponse = { status: number; body: string };
// Sends a GET, or a POST with a JSON body when `body` is given.
export type HttpClient = (url: URL, headers: Record<string, string>, body?: string) => Promise<HttpResponse>;

const rconRequest = async (
  rconUrl: string,
  password: string,
  path: string,
  http: HttpClient,
  body?: unknown,
): Promise<unknown> => {
  const response = await http(
    new URL(path, rconUrl),
    { Authorization: `Bearer ${password}`, Accept: 'application/json' },
    body === undefined ? undefined : JSON.stringify(body),
  );
  if (response.status === 401 || response.status === 403) {
    throw new Error(`RCON rejected the password (${response.status})`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`RCON request failed: ${path} ${response.status}`);
  }
  // A write may succeed with an empty body (e.g. 204); reads still fail their schema check on null.
  return response.body.trim() === '' ? null : JSON.parse(response.body);
};

export const fetchStatus = async (rconUrl: string, password: string, get: HttpClient): Promise<ServerStatus> => {
  const status = StatusSchema.parse(await rconRequest(rconUrl, password, '/v1/status', get));
  return {
    name: status.serverName,
    players: status.players.current,
    maxPlayers: status.players.max,
    map: status.map ?? '',
    rotationIndex: status.rotation?.nowIndex ?? null,
    factionScores: status.factionScores ?? [],
  };
};

export const fetchPlayers = async (rconUrl: string, password: string, get: HttpClient): Promise<Player[]> => {
  const { players } = PlayersSchema.parse(await rconRequest(rconUrl, password, '/v1/players', get));
  return players.map((player) => ({
    steamId: player.steamId,
    name: player.name,
    kills: player.kills ?? null,
    deaths: player.deaths ?? null,
  }));
};

export const fetchSnapshot = async (rconUrl: string, password: string, get: HttpClient): Promise<Snapshot> => ({
  status: await fetchStatus(rconUrl, password, get),
  players: await fetchPlayers(rconUrl, password, get),
});

export const fetchRotation = async (rconUrl: string, password: string, http: HttpClient): Promise<Rotation> => {
  const rotation = RotationSchema.parse(await rconRequest(rconUrl, password, '/v1/rotation', http));
  return {
    enabled: rotation.enabled ?? true,
    mode: rotation.mode ?? 'ordered',
    entries: rotation.entries.map((entry) => ({ map: entry.map, status: entry.status ?? null })),
  };
};

export const sendBroadcast = async (rconUrl: string, password: string, message: string, http: HttpClient) => {
  await rconRequest(rconUrl, password, '/v1/broadcast', http, { message });
};

// For Node, where fetch can reach an IP address and any port.
export const fetchHttp =
  (timeoutMs = 8_000): HttpClient =>
  async (url, headers, body) => {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      ...(body === undefined
        ? { headers }
        : { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body }),
    });
    return { status: response.status, body: await response.text() };
  };
