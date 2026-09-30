import { phaseFor, type AlertKind, type AlertRules, type Phase } from './alerts.ts';
import type { FactionScore, Player, Rotation, ServerStatus } from './rcon.ts';
import type { RecentMatch } from './stats.ts';
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

export const mapName = (id: string): string => MAP_NAMES[id] ?? id;

// Player names are free text; escape Discord markdown so a name cannot restyle or break the message.
const escapeMarkdown = (text: string): string => text.replace(/[\\*_~`|>#[\]()-]/g, '\\$&');

// Discord caps an embed field at 1024 characters; five escaped 40-character names stay well inside it.
const MAX_PLAYER_NAME = 40;

const playerName = (name: string): string =>
  escapeMarkdown(name.length > MAX_PLAYER_NAME ? `${name.slice(0, MAX_PLAYER_NAME - 1)}…` : name);

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
  const seeders = (options.seeders ?? []).map((s) => `${playerName(s.name)} (${s.minutes} min)`);
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
      (p) => `${playerName(p.name)}: ${plural(p.kills, 'kill')}, ${plural(p.deaths, 'death')} (${kd(p.kills, p.deaths)} K/D)`,
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

const INFO_COLOR = 0x5865f2;
const MAX_PLAYERS_LISTED = 30;

const tally = (count: number | null, word: string): string => (count === null ? `– ${word}s` : plural(count, word));

export const buildPlayersEmbed = (players: Player[]): Embed => {
  if (players.length === 0) {
    return { title: '👥 Nobody is on the server', description: 'The server is empty.', color: PHASE_LABELS.empty.color };
  }
  const ranked = [...players].sort((a, b) => (b.kills ?? 0) - (a.kills ?? 0) || (a.deaths ?? 0) - (b.deaths ?? 0));
  const lines = ranked
    .slice(0, MAX_PLAYERS_LISTED)
    .map((p, i) => `${i + 1}. ${playerName(p.name)}: ${tally(p.kills, 'kill')}, ${tally(p.deaths, 'death')}`);
  const more = ranked.length > MAX_PLAYERS_LISTED ? [`…and ${ranked.length - MAX_PLAYERS_LISTED} more`] : [];
  return { title: `👥 ${plural(players.length, 'player')} online`, description: [...lines, ...more].join('\n'), color: INFO_COLOR };
};

const ROTATION_SHOWN = 5;

const rotationLine = (entry: Rotation['entries'][number]): string => {
  const name = mapName(entry.map);
  if (entry.status === 'now') return `▶ **${name}** (now)`;
  if (entry.status === 'next') return `${name} (next)`;
  return name;
};

export const buildRotationEmbed = (rotation: Rotation): Embed => {
  const { entries } = rotation;
  const title = '🗺️ Map rotation';
  if (entries.length === 0) return { title, description: 'No maps in the rotation.', color: INFO_COLOR };

  const nowAt = Math.max(0, entries.findIndex((e) => e.status === 'now'));
  const fromNow = Array.from({ length: Math.min(ROTATION_SHOWN, entries.length) }, (_, i) => entries[(nowAt + i) % entries.length]);
  const shown = (() => {
    if (!rotation.enabled) return [...fromNow.slice(0, 1).map(rotationLine), '', 'Rotation is off, so this map repeats.'];
    if (rotation.mode === 'random') {
      const now = entries.filter((e) => e.status === 'now' || e.status === 'next').map(rotationLine);
      return [...now, '', 'Random order, so only the next map is known.'];
    }
    return fromNow.map((entry) => (entry ? rotationLine(entry) : ''));
  })();
  return { title, description: shown.join('\n'), color: INFO_COLOR };
};

export const buildLastMatchEmbed = (match: RecentMatch): Embed => {
  const [summary] = buildMatchSummary(match, '').embeds;
  const ended = `ended <t:${Math.floor(match.endedAt / 1000)}:R>`;
  return summary
    ? { ...summary, description: `${summary.description} · ${ended}` }
    : { title: '🏁 Last match', description: ended, color: INFO_COLOR };
};
