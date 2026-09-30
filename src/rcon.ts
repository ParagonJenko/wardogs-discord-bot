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
  factionScores: z.array(z.object({ name: z.string(), score: z.number(), colorHex: z.string().nullish() })).nullish(),
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

// colorHex is the faction's colour in game (e.g. "#3366ff"), when the server reports it.
export type FactionScore = { name: string; score: number; colorHex?: string };

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
// Sends a GET, or a POST (or `method`) with `body` when given. The body is JSON unless the headers set a Content-Type.
export type HttpClient = (
  url: URL,
  headers: Record<string, string>,
  body?: string,
  method?: 'POST' | 'PUT',
) => Promise<HttpResponse>;

type Write = { method: 'POST' | 'PUT'; body: string; headers?: Record<string, string> };

const rconRequest = async (
  rconUrl: string,
  password: string,
  path: string,
  http: HttpClient,
  write?: Write,
): Promise<unknown> => {
  const response = await http(
    new URL(path, rconUrl),
    { Authorization: `Bearer ${password}`, Accept: 'application/json', ...write?.headers },
    write?.body,
    write?.method,
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
    factionScores: (status.factionScores ?? []).map(({ name, score, colorHex }) => ({ name, score, ...(colorHex ? { colorHex } : {}) })),
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
  await rconRequest(rconUrl, password, '/v1/broadcast', http, { method: 'POST', body: JSON.stringify({ message }) });
};

// ServerSettings.ini, as the server's config document. Live builds only change reserved slots through it.
const ConfigSchema = z.object({
  revision: z.union([z.string(), z.number()]),
  writable: z.boolean().nullish(),
  text: z.string(),
});

const ApplySchema = z.object({
  ok: z.boolean(),
  errors: z.array(z.unknown()).nullish(),
  stripped: z.array(z.unknown()).nullish(),
  shadowed: z.array(z.unknown()).nullish(),
});

export type ServerConfig = { revision: string; writable: boolean; text: string };

// `ignored` lists what the server would leave out: keys it strips, or keys pinned by launch arguments.
export type ConfigResult = { ok: boolean; errors: string[]; ignored: string[] };

const describe = (item: unknown): string => (typeof item === 'string' ? item : JSON.stringify(item));

const configResult = (raw: unknown): ConfigResult => {
  const result = ApplySchema.parse(raw);
  return {
    ok: result.ok,
    errors: (result.errors ?? []).map(describe),
    ignored: [...(result.stripped ?? []), ...(result.shadowed ?? [])].map(describe),
  };
};

const iniText = (text: string, headers: Record<string, string> = {}): Write => ({
  method: 'PUT',
  body: text,
  headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers },
});

export const fetchConfig = async (rconUrl: string, password: string, http: HttpClient): Promise<ServerConfig> => {
  const config = ConfigSchema.parse(await rconRequest(rconUrl, password, '/v1/config', http));
  return { revision: String(config.revision), writable: config.writable ?? true, text: config.text };
};

// A dry run: what the server would do with this ServerSettings.ini, without changing anything.
export const validateConfig = async (rconUrl: string, password: string, text: string, http: HttpClient) =>
  configResult(await rconRequest(rconUrl, password, '/v1/config/validate', http, { ...iniText(text), method: 'POST' }));

// Replaces ServerSettings.ini. If-Match makes the server refuse (412) if someone changed it since it was read,
// so an admin's edit is never overwritten.
export const putConfig = async (rconUrl: string, password: string, config: ServerConfig, http: HttpClient) => {
  const ifMatch = config.revision.startsWith('"') ? config.revision : `"${config.revision}"`;
  return configResult(await rconRequest(rconUrl, password, '/v1/config', http, iniText(config.text, { 'If-Match': ifMatch })));
};

// For Node, where fetch can reach an IP address and any port.
export const fetchHttp =
  (timeoutMs = 8_000): HttpClient =>
  async (url, headers, body, method) => {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      ...(body === undefined
        ? { headers }
        : { method: method ?? 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body }),
    });
    return { status: response.status, body: await response.text() };
  };
