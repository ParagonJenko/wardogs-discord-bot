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
      faction: z.string().nullish(),
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

// kills and deaths are null when a reading leaves them out, so a gap is never mistaken for a reset. faction is the
// faction's name, such as "Valkyra", when the server says.
export type Player = { steamId: string; name: string; kills: number | null; deaths: number | null; faction?: string };

export type Snapshot = { status: ServerStatus; players: Player[] };

const RotationSchema = z.object({
  enabled: z.boolean().nullish(),
  mode: z.string().nullish(),
  entries: z.array(
    z.object({
      map: z.string(),
      status: z.string().nullish(),
      experiences: z.array(z.string()).nullish(),
      lighting: z.string().nullish(),
      zoneAlternator: z.string().nullish(),
    }),
  ),
});

// A match's setup: its game mode and modifiers (`experiences`), lighting and control-zone layout.
export type MatchSetup = { experiences?: string[]; lighting?: string; zoneAlternator?: string };

export type Rotation = {
  enabled: boolean;
  mode: string;
  entries: ({ map: string; status: string | null } & MatchSetup)[];
};

export type HttpResponse = { status: number; body: string };
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// Sends `method`, or a GET without a body and a POST with one. The body is JSON unless the headers set a Content-Type.
export type HttpClient = (
  url: URL,
  headers: Record<string, string>,
  body?: string,
  method?: HttpMethod,
) => Promise<HttpResponse>;

type Write = { method: HttpMethod; body?: string; headers?: Record<string, string> };

// A request the server answered with an error status, such as 404 for a ban that does not exist. `code` is the
// server's own name for the error, such as "ban_not_found", when it gives one.
export class RconError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Errors come as { error: { code, message } }; some are documented without the wrapper, so both are read.
const ErrorBodySchema = z.object({ code: z.string().nullish(), message: z.string().nullish() });
const WrappedErrorSchema = z.object({ error: ErrorBodySchema });

const errorBody = (body: string): { code: string | null; message: string | null } => {
  try {
    const raw: unknown = JSON.parse(body);
    const wrapped = WrappedErrorSchema.safeParse(raw);
    const parsed = ErrorBodySchema.safeParse(wrapped.success ? wrapped.data.error : raw);
    if (!parsed.success) return { code: null, message: null };
    const { code, message } = parsed.data;
    // Kept to one short line: it ends up in logs and in staff replies.
    return { code: code ?? null, message: message ? message.replace(/\s+/g, ' ').trim().slice(0, 200) : null };
  } catch {
    return { code: null, message: null };
  }
};

// The game refuses to act on a player who is not in game, bans included: 404 player_not_found.
export const isNotInGame = (error: unknown): boolean =>
  error instanceof RconError && error.status === 404 && error.code === 'player_not_found';

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
    throw new RconError(`RCON rejected the password (${response.status})`, response.status);
  }
  if (response.status < 200 || response.status >= 300) {
    const { code, message } = errorBody(response.body);
    const said = [code, message].filter((part) => part !== null).join(': ');
    throw new RconError(
      `RCON request failed: ${write?.method ?? 'GET'} ${path} ${response.status}${said ? ` (${said})` : ''}`,
      response.status,
      code,
    );
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
    ...(player.faction ? { faction: player.faction } : {}),
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
    entries: rotation.entries.map((entry) => ({
      map: entry.map,
      status: entry.status ?? null,
      ...(entry.experiences ? { experiences: entry.experiences } : {}),
      ...(entry.lighting ? { lighting: entry.lighting } : {}),
      ...(entry.zoneAlternator ? { zoneAlternator: entry.zoneAlternator } : {}),
    })),
  };
};

export const sendBroadcast = async (rconUrl: string, password: string, message: string, http: HttpClient) => {
  await rconRequest(rconUrl, password, '/v1/broadcast', http, { method: 'POST', body: JSON.stringify({ message }) });
};

// Staff actions on one player. Steam IDs go in the path, so anything else is refused before a request is made.
const STEAM_ID = /^\d{17}$/;

const playerPath = (steamId: string, action = ''): string => {
  if (!STEAM_ID.test(steamId)) throw new Error(`Not a Steam ID: ${steamId}`);
  return `/v1/players/${steamId}${action}`;
};

const json = (method: HttpMethod, body: unknown): Write => ({ method, body: JSON.stringify(body) });

// A private message to one player in game.
export const messagePlayer = async (rconUrl: string, password: string, steamId: string, message: string, http: HttpClient) => {
  await rconRequest(rconUrl, password, playerPath(steamId, '/message'), http, json('POST', { message }));
};

// Removes a player from the server; they can rejoin.
export const kickPlayer = async (rconUrl: string, password: string, steamId: string, reason: string, http: HttpClient) => {
  await rconRequest(rconUrl, password, playerPath(steamId, '/kick'), http, json('POST', { reason }));
};

// Moves a player to the faction with this name. Like the game's own console, the bot then kills the player so they
// respawn on the new side; a kill that fails (no living character) does not matter.
export const switchFaction = async (rconUrl: string, password: string, steamId: string, faction: string, http: HttpClient) => {
  await rconRequest(rconUrl, password, playerPath(steamId), http, json('PATCH', { faction }));
  await rconRequest(rconUrl, password, playerPath(steamId, '/kill'), http, { method: 'POST', body: '{}' }).catch(() => undefined);
};

const BansSchema = z.object({
  bans: z.array(z.object({ steamId: z.string(), reason: z.string().nullish(), bannedBy: z.string().nullish() })),
});

export type Ban = { steamId: string; reason: string | null; bannedBy: string | null };

export const fetchBans = async (rconUrl: string, password: string, http: HttpClient): Promise<Ban[]> =>
  BansSchema.parse(await rconRequest(rconUrl, password, '/v1/bans', http)).bans.map((b) => ({
    steamId: b.steamId,
    reason: b.reason ?? null,
    bannedBy: b.bannedBy ?? null,
  }));

// Bans are permanent on the server (they go into ServerSettings.ini); the bot lifts timed ones itself. The game only
// bans a player who is in game: anyone else is refused with 404 player_not_found (see isNotInGame).
export const addBan = async (rconUrl: string, password: string, steamId: string, reason: string, http: HttpClient) => {
  if (!STEAM_ID.test(steamId)) throw new Error(`Not a Steam ID: ${steamId}`);
  await rconRequest(rconUrl, password, '/v1/bans', http, json('POST', { steamId, reason }));
};

// False when the player was not banned.
export const removeBan = async (rconUrl: string, password: string, steamId: string, http: HttpClient): Promise<boolean> => {
  if (!STEAM_ID.test(steamId)) throw new Error(`Not a Steam ID: ${steamId}`);
  try {
    await rconRequest(rconUrl, password, `/v1/bans/${steamId}`, http, { method: 'DELETE' });
    return true;
  } catch (error) {
    if (error instanceof RconError && error.status === 404) return false;
    throw error;
  }
};

// Something from the server's catalogue: its id, and the name to show.
export type CatalogItem = { id: string; name: string };

const catalog = (key: string) => z.object({ [key]: z.array(z.object({ id: z.string(), displayName: z.string().nullish() })) });

const fetchCatalog = async (rconUrl: string, password: string, path: string, key: string, http: HttpClient): Promise<CatalogItem[]> =>
  (catalog(key).parse(await rconRequest(rconUrl, password, path, http))[key] ?? []).map((item) => ({
    id: item.id,
    name: item.displayName ?? item.id,
  }));

export const fetchMaps = (rconUrl: string, password: string, http: HttpClient): Promise<CatalogItem[]> =>
  fetchCatalog(rconUrl, password, '/v1/catalog/maps', 'maps', http);

// Game modes (such as Kavkazi_KOTH_01) and modifiers (such as KOTH_InfantryOnly), with their names.
export const fetchExperiences = (rconUrl: string, password: string, http: HttpClient): Promise<CatalogItem[]> =>
  fetchCatalog(rconUrl, password, '/v1/catalog/experiences', 'experiences', http);

// Times of day and weather, such as DayClear.
export const fetchLightings = (rconUrl: string, password: string, http: HttpClient): Promise<CatalogItem[]> =>
  fetchCatalog(rconUrl, password, '/v1/catalog/lightings', 'lightings', http);

// Map ids go in the path, so anything else is refused before a request is made.
const mapPath = (map: string, what: string): string => {
  if (!/^[A-Za-z0-9_]+$/.test(map)) throw new Error(`Not a map id: ${map}`);
  return `/v1/catalog/maps/${map}/${what}`;
};

const MapExperiencesSchema = z.object({ experiences: z.array(z.string()) });

// The experience ids a map can be played with.
export const fetchMapExperiences = async (rconUrl: string, password: string, map: string, http: HttpClient): Promise<string[]> =>
  MapExperiencesSchema.parse(await rconRequest(rconUrl, password, mapPath(map, 'experiences'), http)).experiences;

const ZonesSchema = z.object({ alternators: z.array(z.object({ tag: z.string(), displayName: z.string().nullish() })) });

// A map's control-zone layouts, by tag (such as ZoneAlternator.Bakurani.Default.Circle).
export const fetchZones = async (rconUrl: string, password: string, map: string, http: HttpClient): Promise<CatalogItem[]> =>
  ZonesSchema.parse(await rconRequest(rconUrl, password, mapPath(map, 'alternators'), http)).alternators.map((z) => ({
    id: z.tag,
    name: z.displayName ?? z.tag,
  }));

// Stages the map the server travels to when the current match ends, with its setup. The rotation is not changed.
export const queueMap = async (rconUrl: string, password: string, map: string, http: HttpClient, setup: MatchSetup = {}) => {
  await rconRequest(rconUrl, password, '/v1/match/map', http, json('POST', { map, ...setup }));
};

// Ends the current match now; the server travels to the staged map, or the next in the rotation.
export const endMatch = async (rconUrl: string, password: string, http: HttpClient) => {
  await rconRequest(rconUrl, password, '/v1/match/end', http, { method: 'POST', body: '{}' });
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
        ? { method: method ?? 'GET', headers }
        : { method: method ?? 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body }),
    });
    return { status: response.status, body: await response.text() };
  };
