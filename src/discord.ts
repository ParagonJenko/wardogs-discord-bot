import type { AlertKind } from './alerts.ts';
import type { ServerStatus } from './battlemetrics.ts';

export type DiscordMessage = {
  content?: string;
  embeds: { title: string; description: string; url: string; color: number }[];
  allowed_mentions: { parse: never[]; roles: string[] };
};

type MessageOptions = { lowPop: number; roleId?: string };

const COLORS: Record<AlertKind, number> = {
  seeding: 0xf1c40f,
  live: 0x2ecc71,
  lowPop: 0xe74c3c,
};

// Discord rejects embed titles over 256 characters; this leaves room for the longest suffix.
const MAX_NAME_LENGTH = 200;

const shorten = (name: string): string =>
  name.length > MAX_NAME_LENGTH ? `${name.slice(0, MAX_NAME_LENGTH - 1)}…` : name;

const title = (kind: AlertKind, server: ServerStatus, lowPop: number): string => {
  const name = shorten(server.name);
  if (kind === 'seeding') return `🌱 ${name} is seeding`;
  if (kind === 'live') return `🟢 ${name} is live`;
  return `🔻 ${name} dropped below ${lowPop} players`;
};

const CALL_TO_ACTION: Record<AlertKind, string> = {
  seeding: 'Jump in and help get it live!',
  live: 'Round is on. Get in while there are slots.',
  lowPop: 'Jump in to keep it going!',
};

export const buildMessage = (kind: AlertKind, server: ServerStatus, options: MessageOptions): DiscordMessage => ({
  ...(options.roleId ? { content: `<@&${options.roleId}>` } : {}),
  embeds: [
    {
      title: title(kind, server, options.lowPop),
      description: `**${server.players}/${server.maxPlayers}** players. ${CALL_TO_ACTION[kind]}`,
      url: `https://www.battlemetrics.com/servers/wardogs/${server.id}`,
      color: COLORS[kind],
    },
  ],
  // Only the configured role may be pinged; a server name containing @everyone must not ping anyone.
  allowed_mentions: { parse: [], roles: options.roleId ? [options.roleId] : [] },
});

export const postWebhook = async (
  webhookUrl: string,
  message: DiscordMessage,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<void> => {
  const response = await fetchFn(webhookUrl, {
    signal: AbortSignal.timeout(timeoutMs),
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  });
  if (!response.ok) {
    throw new Error(`Discord webhook failed: ${response.status} ${await response.text()}`);
  }
};
