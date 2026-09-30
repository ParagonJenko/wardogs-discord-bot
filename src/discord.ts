import { phaseFor, type AlertKind, type AlertRules, type Phase } from './alerts.ts';
import type { VipRule } from './config.ts';
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

type MessageOptions = { lowPop: number; roleId?: string; seeders?: Seeder[]; vip?: VipRule | null };

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

const span = (days: number): string => (days === 7 ? 'a week' : plural(days, 'day'));

// What seeding earns, for the seeding alert and /seeders.
export const vipOffer = (vip: VipRule): string =>
  `🎖️ Seed on ${plural(vip.seedDays, 'day')} in ${span(vip.windowDays)} and get a reserved slot for ${span(vip.lengthDays)}. ` +
  `A seed counts when you're on for more than ${vip.seedMinutes} min and the server goes live.`;

export const buildMessage = (kind: AlertKind, server: Population, options: MessageOptions): DiscordMessage => {
  const seeders = (options.seeders ?? []).map((s) => `${playerName(s.name)} (${s.minutes} min)`);
  const fields = fieldIf('Top seeders', seeders);
  const offer = kind === 'seeding' && options.vip ? `\n${vipOffer(options.vip)}` : '';
  return {
    ...(options.roleId ? { content: `<@&${options.roleId}>` } : {}),
    embeds: [
      {
        title: title(kind, server, options.lowPop),
        description: `**${server.players}/${server.maxPlayers}** players. ${CALL_TO_ACTION[kind]}${offer}`,
        color: COLORS[kind],
        ...(fields.length > 0 ? { fields } : {}),
      },
    ],
  // Only the configured role may be pinged; a server name containing @everyone must not ping anyone.
    allowed_mentions: { parse: [], roles: options.roleId ? [options.roleId] : [] },
  };
};

const byScore = (scores: FactionScore[]): FactionScore[] => [...scores].sort((a, b) => b.score - a.score);

// `markdown` escapes names and bolds the winner, for embeds; without it the text is plain, for a menu.
const result = (scores: FactionScore[], markdown = true): string[] => {
  const ranked = byScore(scores);
  const [first, second, ...rest] = ranked;
  if (!first || !second) return [];
  const name = (s: FactionScore): string => (markdown ? escapeMarkdown(s.name) : s.name);
  const winner = markdown ? `**${name(first)}**` : name(first);
  const draw = first.score === second.score;
  if (rest.length === 0) {
    return [draw ? `Draw ${first.score} – ${second.score}` : `${winner} won ${first.score} – ${second.score}`];
  }
  // Three or more factions: name them all, so it is clear who came second and third.
  const others = ranked.slice(1).map((s) => `${name(s)} ${s.score}`);
  return [
    draw ? `Draw: ${name(first)} ${first.score}, ${others.join(', ')}` : `${winner} won ${first.score}, ${others.join(', ')}`,
  ];
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
      // The next map can sit earlier in the list than the current one, so pick them in that order.
      const known = ['now', 'next'].flatMap((status) => entries.filter((e) => e.status === status)).map(rotationLine);
      return [...known, '', 'Random order, so only the next map is known.'];
    }
    return fromNow.map((entry) => (entry ? rotationLine(entry) : ''));
  })();
  return { title, description: shown.join('\n'), color: INFO_COLOR };
};

// Discord caps an embed description at 4096 characters; this many names stays well inside it.
const MAX_NAMES_ANNOUNCED = 20;

const nameList = (names: string[]): string => {
  const shown = names.slice(0, MAX_NAMES_ANNOUNCED).map(playerName);
  const more = names.length - shown.length;
  const all = more > 0 ? [...shown, `${more} more`] : shown;
  return all.length > 1 ? `${all.slice(0, -1).join(', ')} and ${all.at(-1)}` : (all[0] ?? '');
};

// Posted when seeders get a reserved slot, or keep one for another week, so everyone sees what seeding earns.
export const buildVipMessage = (added: { name: string }[], renewed: { name: string }[], vip: VipRule): DiscordMessage => {
  const lines = [
    ...(added.length > 0
      ? [
          `**${nameList(added.map((p) => p.name))}** earned ${added.length === 1 ? 'a reserved slot' : 'reserved slots'} ` +
            `for ${span(vip.lengthDays)} by seeding.`,
        ]
      : []),
    ...(renewed.length > 0 ? [`Kept for another ${vip.lengthDays === 7 ? 'week' : span(vip.lengthDays)}: ${nameList(renewed.map((p) => p.name))}.`] : []),
    "It starts after the server's next restart.",
    '',
    vipOffer(vip),
  ];
  return {
    embeds: [{ title: '🎖️ Reserved slots for seeders', description: lines.join('\n'), color: COLORS.seeding }],
    allowed_mentions: NO_PINGS,
  };
};

export type SeederRow = { steamId: string; name: string; seedingMinutes: number; seedDays: number; vipUntil: number | null };

// For admins, so it shows Steam IDs; the reply is only visible to the admin who asked.
export const buildSeedersEmbed = (seeders: SeederRow[], days: number, seedMinutes: number, vip: VipRule | null): Embed => {
  const title = `🌱 Top seeders, last ${plural(days, 'day')}`;
  const notes = [
    `A seed day: on for more than ${seedMinutes} min while the server seeded, and it then went live. Days are UTC.`,
    ...(vip ? [vipOffer(vip)] : []),
  ];
  if (seeders.length === 0) {
    return { title, description: ['Nobody seeded in that time.', '', ...notes].join('\n'), color: COLORS.seeding };
  }
  const lines = seeders.map((s) =>
    [
      `${playerName(s.name)}: ${plural(s.seedDays, 'seed day')}, ${s.seedingMinutes} min`,
      `\`${s.steamId.replace(/`/g, '')}\``,
      ...(s.vipUntil === null ? [] : [`🎖️ VIP until <t:${Math.floor(s.vipUntil / 1000)}:f>`]),
    ].join(' · '),
  );
  return { title, description: [numbered(lines), '', ...notes].join('\n'), color: COLORS.seeding };
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const utcTime = (at: number): string => {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
};

// Discord caps a menu choice's name at 100 characters.
const MAX_CHOICE_NAME = 100;

// A recent match as a choice in /removematch. The value is when it ended, which identifies it.
export const matchChoice = (match: RecentMatch): { name: string; value: string } => {
  const name = [
    mapName(match.map) || 'Unknown map',
    ...result(match.factionScores, false),
    `${Math.round(match.durationMs / 60_000)} min`,
    `ended ${utcTime(match.endedAt)}`,
  ].join(' · ');
  return { name: name.length > MAX_CHOICE_NAME ? `${name.slice(0, MAX_CHOICE_NAME - 1)}…` : name, value: String(match.endedAt) };
};

export const removedMatchText = (match: RecentMatch, players: number): string =>
  [
    `🗑️ Removed the ${mapName(match.map) || 'unknown map'} match that ended <t:${Math.floor(match.endedAt / 1000)}:f>` +
      ` (${[...result(match.factionScores), `${Math.round(match.durationMs / 60_000)} min`].join(' · ')}).`,
    players > 0
      ? `Its match, kills and deaths came off ${players === 1 ? "1 player's" : `${players} players'`} totals.`
      : 'It had no player records to take off.',
  ].join(' ');

export const buildLastMatchEmbed = (match: RecentMatch): Embed => {
  const [summary] = buildMatchSummary(match, '').embeds;
  const ended = `ended <t:${Math.floor(match.endedAt / 1000)}:R>`;
  return summary
    ? { ...summary, description: `${summary.description} · ${ended}` }
    : { title: '🏁 Last match', description: ended, color: INFO_COLOR };
};
