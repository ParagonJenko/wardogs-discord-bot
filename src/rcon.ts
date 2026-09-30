import { z } from 'zod';

// WARDOGS RCON is a plain HTTP/JSON API (default port 7776). Only the fields the bot uses are checked.
const StatusSchema = z.object({
  serverName: z.string(),
  players: z.object({
    current: z.number().int(),
    max: z.number().int(),
  }),
});

export type ServerStatus = {
  name: string;
  players: number;
  maxPlayers: number;
};

export type HttpResponse = { status: number; body: string };
export type HttpGet = (url: URL, headers: Record<string, string>) => Promise<HttpResponse>;

export const fetchStatus = async (rconUrl: string, password: string, get: HttpGet): Promise<ServerStatus> => {
  const response = await get(new URL('/v1/status', rconUrl), {
    Authorization: `Bearer ${password}`,
    Accept: 'application/json',
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error(`RCON rejected the password (${response.status})`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`RCON request failed: ${response.status}`);
  }

  const status = StatusSchema.parse(JSON.parse(response.body));
  return { name: status.serverName, players: status.players.current, maxPlayers: status.players.max };
};

// For Node, where fetch can reach an IP address and any port.
export const fetchGet =
  (timeoutMs = 8_000): HttpGet =>
  async (url, headers) => {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    return { status: response.status, body: await response.text() };
  };
