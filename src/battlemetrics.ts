import { z } from 'zod';

const ServerResponseSchema = z.object({
  data: z.object({
    id: z.string(),
    attributes: z.object({
      name: z.string(),
      players: z.number().int(),
      maxPlayers: z.number().int(),
      status: z.string(),
    }),
  }),
});

export type ServerStatus = {
  id: string;
  name: string;
  players: number;
  maxPlayers: number;
};

export const fetchServer = async (serverId: string, fetchFn: typeof fetch = fetch): Promise<ServerStatus> => {
  const response = await fetchFn(`https://api.battlemetrics.com/servers/${serverId}`);
  if (!response.ok) {
    throw new Error(`BattleMetrics request failed: ${response.status} ${response.statusText}`);
  }

  const { data } = ServerResponseSchema.parse(await response.json());
  return {
    id: data.id,
    name: data.attributes.name,
    // BattleMetrics can keep the last player count for a server that has gone offline.
    players: data.attributes.status === 'online' ? data.attributes.players : 0,
    maxPlayers: data.attributes.maxPlayers,
  };
};
