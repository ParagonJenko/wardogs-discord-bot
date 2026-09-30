import { phaseFor, type AlertKind, type AlertRules, type Phase } from './alerts.ts';
import type { FactionScore, ServerStatus } from './rcon.ts';
import type { MatchSummary } from './tracking.ts';

export type EmbedField = { name: string; value: string; inline?: boolean };

export type Embed = { title: string; description: string; color: number; fields?: EmbedField[] };

export type DiscordMessage = {
  content?: string;
  embeds: Embed[];
  allowed_mentions: { parse: never[]; roles: string[] };
};

type Population = Pick<ServerStatus, 'name' | 'players' | 'maxPlayers'>;

export type Seeder = { name: string; minutes: number };

type MessageOptions = { lowPop: number; roleId?: string; seeders?: Seeder[] };

const NO_PINGS = { parse: [], roles: [] };

// Map ids as RCON reports them, and the names players see in game.
const MAP_NAMES: Record<string, string> = { Kavkazi: 'Bakurani', Europe: 'Ozeti', NorthAmerica: 'Zestafona' };

const mapName = (id: string): string => MAP_NAMES[id] ?? id;

// Player names are free text; escape Discord markdown so a name cannot restyle or break the message.
const escapeMarkdown = (text: string): string => text.replace(/[\\*_~`|>#[\]()-]/g, '\\$&');

const numbered = (lines: string[]): string => lines.map((line, i) => `${i + 1}. ${line}`).join('\n');

const fieldIf = (name: string, lines: string[]): EmbedField[] =>
  lines.length > 0 ? [{ name, value: numbered(lines) }] : [];

const COLORS: Record<AlertKind, number> = {
  seeding: 0xf1c40f,
  live: 0x2ecc71,
  lowPop: 0xe74c3c,
};

// Discord rejects embed titles over 256 characters; this leaves room for the longest suffix.
const MAX_NAME_LENGTH = 200;

const shorten = (name: string): string =>
  name.length > MAX_NAME_LENGTH ? `${name.slice(0, MAX_NAME_LENGTH - 1)}…` : name;

const title = (kind: AlertKind, server: Population, lowPop: number): string => {
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

export const buildMessage = (kind: AlertKind, server: Population, options: MessageOptions): DiscordMessage => {
  const seeders = (options.seeders ?? []).map((s) => `${escapeMarkdown(s.name)} (${s.minutes} min)`);
  const fields = fieldIf('Top seeders', seeders);
  return {
    ...(options.roleId ? { content: `<@&${options.roleId}>` } : {}),
    embeds: [
      {
        title: title(kind, server, options.lowPop),
        description: `**${server.players}/${server.maxPlayers}** players. ${CALL_TO_ACTION[kind]}`,
        color: COLORS[kind],
        ...(fields.length > 0 ? { fields } : {}),
      },
    ],
  // Only the configured role may be pinged; a server name containing @everyone must not ping anyone.
    allowed_mentions: { parse: [], roles: options.roleId ? [options.roleId] : [] },
  };
};

const byScore = (scores: FactionScore[]): FactionScore[] => [...scores].sort((a, b) => b.score - a.score);

const result = (scores: FactionScore[]): string[] => {
  const [first, second] = byScore(scores);
  if (!first || !second) return [];
  if (first.score === second.score) return [`Draw ${first.score} – ${second.score}`];
  return [`**${escapeMarkdown(first.name)}** won ${first.score} – ${second.score}`];
};

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

const kd = (kills: number, deaths: number): string => (kills / Math.max(deaths, 1)).toFixed(2);

export const buildMatchSummary = (summary: MatchSummary, serverName: string): DiscordMessage => {
  const fields = fieldIf(
    'Top players',
    summary.top.map(
      (p) => `${escapeMarkdown(p.name)}: ${plural(p.kills, 'kill')}, ${plural(p.deaths, 'death')} (${kd(p.kills, p.deaths)} K/D)`,
    ),
  );
  return {
    embeds: [
      {
        title: `🏁 Match over on ${mapName(summary.map)}`,
        description: [
          ...result(summary.factionScores),
          `${Math.round(summary.durationMs / 60_000)} min`,
          `peak ${summary.peakPlayers} players`,
        ].join(' · '),
        color: 0x5865f2,
        ...(fields.length > 0 ? { fields } : {}),
      },
    ],
    allowed_mentions: NO_PINGS,
  };
};

const PHASE_LABELS: Record<Phase, { label: string; color: number }> = {
  live: { label: '🟢 **Live**', color: COLORS.live },
  seeding: { label: '🌱 **Seeding**', color: COLORS.seeding },
  empty: { label: '⚪ **Empty**', color: 0x95a5a6 },
};

const scoreLine = (scores: FactionScore[]): string => {
  const [a, b] = scores;
  if (scores.length === 2 && a && b) return `${a.name} ${a.score} – ${b.score} ${b.name}`;
  return scores.map((s) => `${s.name} ${s.score}`).join(' · ');
};

export const buildStatusEmbed = (status: ServerStatus, rules: AlertRules): Embed => {
  const phase = PHASE_LABELS[phaseFor(status.players, rules)];
  return {
    title: shorten(status.name),
    description: `${phase.label} · **${status.players}/${status.maxPlayers}** players`,
    color: phase.color,
    fields: [
      ...(status.map ? [{ name: 'Map', value: mapName(status.map), inline: true }] : []),
      ...(status.factionScores.length > 0 ? [{ name: 'Score', value: escapeMarkdown(scoreLine(status.factionScores)), inline: true }] : []),
    ],
  };
};

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
