import { phaseFor, type AlertKind, type AlertRules, type Phase } from './alerts.ts';
import type { VipRule } from './config.ts';
import { isBotBan, type BanRecord, type ModAction, type ModEntry } from './moderation.ts';
import type { Flag, GriefAlert, Incident, PlayerGrief } from './griefing.ts';
import type { HeadshotAlert } from './killfeed.ts';
import { BACK_SHARE, unreachableFor, type OutageEvent } from './outages.ts';
import type { Ban, FactionScore, Player, Rotation, ServerStatus, Snapshot } from './rcon.ts';
import type { PlayerRecord } from './staff.ts';
import type { MatchHighlight, RoleAward, Roundup, RoundupPlayer, TeamStanding } from './roundup.ts';
import { WEEKDAYS as ROTATION_DAYS } from './rotations.ts';
import { PRIVATE_NAME } from './privacy.ts';
import type { RecentMatch } from './stats.ts';
import { assess, RISK_LABELS, steamFacts, type Risk, type SteamAlert, type SteamCheck, type SteamLookup } from './steam.ts';
import { topPlayers, type MatchState, type MatchSummary } from './tracking.ts';

export type EmbedField = { name: string; value: string; inline?: boolean };

export type Embed = {
  title: string;
  description?: string;
  // Makes the title a link.
  url?: string;
  color: number;
  fields?: EmbedField[];
  footer?: { text: string };
  // Shown by Discord in the viewer's own time, next to the footer.
  timestamp?: string;
};

export type DiscordMessage = {
  content?: string;
  embeds: Embed[];
  allowed_mentions: { parse: never[]; roles: string[] };
};

type Population = Pick<ServerStatus, 'name' | 'players' | 'maxPlayers'> & Partial<Pick<ServerStatus, 'map'>>;

export type Seeder = { name: string; minutes: number };

type MessageOptions = {
  lowPop: number;
  // The live threshold, to say how many more players the server needs.
  live?: number;
  roleId?: string;
  seeders?: Seeder[];
  vip?: VipRule | null;
  siteUrl?: string;
  serverId?: string;
};

const NO_PINGS = { parse: [], roles: [] };

// Map ids as RCON reports them, and the names players see in game.
// Each map also has its own colour, the same as on the website, so they can be told apart at a glance.
const MAPS: Record<string, { name: string; emoji: string; colour: number }> = {
  Kavkazi: { name: 'Bakurani', emoji: '🟧', colour: 0xe67e22 },
  Europe: { name: 'Ozeti', emoji: '🟦', colour: 0x3498db },
  NorthAmerica: { name: 'Zestafona', emoji: '🟪', colour: 0x9b59b6 },
};

export const mapName = (id: string): string => MAPS[id]?.name ?? id;

// A map by its id, or by the name players see (records keep the name).
const mapStyle = (idOrName: string) => MAPS[idOrName] ?? Object.values(MAPS).find((m) => m.name === idOrName);

// The map's colour square and a space, or nothing for a map without one.
export const mapEmoji = (idOrName: string): string => {
  const style = mapStyle(idOrName);
  return style ? `${style.emoji} ` : '';
};

// "🟦 Ozeti": the map's name as players know it, with its colour.
export const mapTitle = (idOrName: string): string => `${mapEmoji(idOrName)}${mapName(idOrName)}`;

// Player names are free text; escape Discord markdown so a name cannot restyle or break the message.
const escapeMarkdown = (text: string): string => text.replace(/[\\*_~`|>#[\]()-]/g, '\\$&');

// Discord caps an embed field at 1024 characters; five escaped 40-character names stay well inside it.
const MAX_PLAYER_NAME = 40;

export const playerName = (name: string): string =>
  escapeMarkdown(name.length > MAX_PLAYER_NAME ? `${name.slice(0, MAX_PLAYER_NAME - 1)}…` : name);

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

const kd = (kills: number, deaths: number): string => (kills / Math.max(deaths, 1)).toFixed(2);

const COLORS: Record<AlertKind, number> = {
  seeding: 0xf1c40f,
  live: 0x2ecc71,
  lowPop: 0xe74c3c,
  back: 0xf1c40f,
};

const INFO_COLOR = 0x5865f2;
const EMPTY_COLOR = 0x95a5a6;

// Discord rejects embed titles over 256 characters; this leaves room for the longest suffix.
const MAX_NAME_LENGTH = 200;

const shorten = (name: string): string =>
  name.length > MAX_NAME_LENGTH ? `${name.slice(0, MAX_NAME_LENGTH - 1)}…` : name;

// The look shared by every embed: a population bar, medals for the top three, and each faction's colour as a dot.

const BAR_WIDTH = 10;

// Emoji squares look the same in every Discord client: 🟩🟩🟩⬛⬛⬛⬛⬛⬛⬛ **30**/98, in the colour of the state.
const BAR_FILL: Record<Phase | AlertKind, string> = { live: '🟩', seeding: '🟨', back: '🟨', lowPop: '🟥', empty: '⬜' };

const population = (players: number, max: number, state: Phase | AlertKind): string => {
  const filled = max > 0 && players > 0 ? Math.max(1, Math.round(Math.min(players / max, 1) * BAR_WIDTH)) : 0;
  return `${BAR_FILL[state].repeat(filled)}${'⬛'.repeat(BAR_WIDTH - filled)} **${players}**/${max}`;
};

const MEDALS = ['🥇', '🥈', '🥉'];

// Medals for the top three, then a small tag: `#4`. A line starting "4. " would turn into a Discord list.
const ranked = (lines: string[]): string => lines.map((line, i) => `${MEDALS[i] ?? `\`#${i + 1}\``} ${line}`).join('\n');

// The coloured circle emoji nearest to a faction's colour, so scores can be told apart at a glance.
const DOTS: [emoji: string, rgb: [number, number, number]][] = [
  ['🔴', [221, 46, 68]],
  ['🟠', [244, 144, 12]],
  ['🟡', [253, 203, 88]],
  ['🟢', [120, 177, 89]],
  ['🔵', [85, 172, 238]],
  ['🟣', [170, 142, 214]],
  ['🟤', [193, 105, 79]],
  ['⚫', [49, 55, 61]],
  ['⚪', [230, 231, 232]],
];

const rgb = (hex: string | undefined): [number, number, number] | null => {
  const match = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(hex ?? '');
  if (!match?.[1]) return null;
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

const dot = (hex: string | undefined): string => {
  const colour = rgb(hex);
  if (colour === null) return '';
  const distance = ([r, g, b]: [number, number, number]): number =>
    (r - colour[0]) ** 2 + (g - colour[1]) ** 2 + (b - colour[2]) ** 2;
  const [nearest] = [...DOTS].sort((a, b) => distance(a[1]) - distance(b[1]));
  return nearest ? `${nearest[0]} ` : '';
};

const colourOf = (hex: string | undefined): number | null => {
  const colour = rgb(hex);
  return colour === null ? null : (colour[0] << 16) | (colour[1] << 8) | colour[2];
};

const byScore = (scores: FactionScore[]): FactionScore[] => [...scores].sort((a, b) => b.score - a.score);

// Each faction's own emoji: the Lonestar cowboy, the Valkyra bear and the Manticore's scorpion tail.
// A Map, like FACTION_DOT, so a faction the server calls "Constructor" doesn't find Object's own properties.
const FACTION_EMOJI = new Map([
  ['lonestar', '🤠'],
  ['valkyra', '🐻'],
  ['manticore', '🦂'],
]);

// How a faction is looked up, whatever the server calls it: "Lonestar", "LONESTAR" and "Lone Star" are the same.
export const factionKey = (name: string): string => name.toLowerCase().replace(/[^a-z]/g, '');

// A faction's own emoji and a space, or nothing for a faction without one.
const factionEmoji = (name: string): string => {
  const emoji = FACTION_EMOJI.get(factionKey(name));
  return emoji ? `${emoji} ` : '';
};

// The emoji to show before a faction's name: its own, or the dot nearest its colour for any other faction.
export const factionBadge = (name: string, colorHex?: string): string => factionEmoji(name) || dot(colorHex);

// Each faction's colour in game as a dot: Lonestar blue, Manticore green, Valkyra red.
const FACTION_DOT = new Map([
  ['lonestar', '🔵'],
  ['manticore', '🟢'],
  ['valkyra', '🔴'],
]);

// The dot in a faction's colour and a space, for the choices staff pick from, where a colour is quicker to spot than an
// emoji: 🔵 Lonestar. Any other faction gets the dot nearest its colour, or nothing without one.
export const factionDot = (name: string, colorHex?: string): string => {
  const known = FACTION_DOT.get(factionKey(name));
  return known ? `${known} ` : dot(colorHex);
};

// One line per faction, highest first, the leader in bold: 🐻 **Valkyra 100**
const scoreLines = (scores: FactionScore[]): string =>
  byScore(scores)
    .map((s, i) => {
      const text = `${escapeMarkdown(s.name)} ${s.score}`;
      return `${factionBadge(s.name, s.colorHex)}${i === 0 ? `**${text}**` : text}`;
    })
    .join('\n');

// A footer pointing at the website, and the title linking to it, when SITE_URL is set. Given when a match ended, the
// title links to that match on the website's matches page, which names each match by that time.
const site = (siteUrl: string | undefined, matchEndedAt?: number | null): Pick<Embed, 'url' | 'footer'> => {
  if (!siteUrl) return {};
  const host = siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const url = matchEndedAt == null ? siteUrl : `${siteUrl.replace(/\/$/, '')}/matches#match-${matchEndedAt}`;
  return { url, footer: { text: `Live stats and leaderboard: ${host}` } };
};

// How to join from the game, with the server's ID in a code block so it is easy to copy. Nothing without an ID.
const joinField = (serverId: string | undefined): EmbedField[] =>
  serverId
    ? [
        {
          name: 'Join the server',
          value: `\`\`\`\n${serverId}\n\`\`\`\nIn game: Deploy → Server Browser → Join by ID, paste the code, then Lookup.`,
        },
      ]
    : [];

const title = (kind: AlertKind, server: Population, lowPop: number): string => {
  const name = shorten(server.name);
  if (kind === 'seeding') return `🌱 ${name} is seeding`;
  if (kind === 'back') return `🔁 ${name} is back up`;
  if (kind === 'live') return `🟢 ${name} is live`;
  return `🔻 ${name} dropped below ${lowPop} players`;
};

const CALL_TO_ACTION: Record<AlertKind, string> = {
  seeding: 'Jump in and help get it live!',
  live: 'Round is on. Get in while there are slots.',
  lowPop: 'Jump in to keep it going!',
  back: 'It crashed and is back up. Rejoin and help fill it!',
};

const span = (days: number): string => (days === 7 ? 'a week' : plural(days, 'day'));

// What seeding earns: "Seed on 3 days in a week and get a reserved slot for a week."
export const vipOffer = (vip: VipRule): string =>
  `Seed on ${plural(vip.seedDays, 'day')} in ${span(vip.windowDays)} and get a reserved slot for ${span(vip.lengthDays)}.`;

// What counts as a seed.
export const vipRule = (vip: VipRule): string =>
  `A seed counts when you're on for more than ${vip.seedMinutes} min and the server goes live.`;

const needed = (kind: AlertKind, server: Population, options: MessageOptions): EmbedField[] => {
  if ((kind === 'seeding' || kind === 'back') && options.live !== undefined) {
    return [{ name: 'To go live', value: `**${Math.max(0, options.live - server.players)}** more`, inline: true }];
  }
  if (kind === 'lowPop') {
    return [{ name: 'To stay live', value: `**${Math.max(0, options.lowPop - server.players)}** more`, inline: true }];
  }
  return [];
};

export const buildMessage = (kind: AlertKind, server: Population, options: MessageOptions): DiscordMessage => {
  const seeders = (options.seeders ?? []).map((s) => `${playerName(s.name)} · ${s.minutes} min`);
  const fields: EmbedField[] = [
    { name: 'Players', value: population(server.players, server.maxPlayers, kind) },
    ...(server.map ? [{ name: 'Map', value: mapTitle(server.map), inline: true }] : []),
    ...needed(kind, server, options),
    ...(seeders.length > 0 ? [{ name: 'Top seeders', value: ranked(seeders) }] : []),
    ...(kind === 'seeding' && options.vip
      ? [{ name: '🎖️ Seeder VIP', value: `${vipOffer(options.vip)}\n${vipRule(options.vip)}` }]
      : []),
    ...joinField(options.serverId),
  ];
  return {
    ...(options.roleId ? { content: `<@&${options.roleId}>` } : {}),
    embeds: [
      {
        title: title(kind, server, options.lowPop),
        description: `**${CALL_TO_ACTION[kind]}**`,
        color: COLORS[kind],
        fields,
        ...site(options.siteUrl),
      },
    ],
    // Only the configured role may be pinged; a server name containing @everyone must not ping anyone.
    allowed_mentions: { parse: [], roles: options.roleId ? [options.roleId] : [] },
  };
};

// What staff send with /seednow: the seeding alert, worded as a call to join now, with their note and who called it.
// Mentions in an embed never ping, so naming the caller is safe.
export const buildSeedCall = (
  server: Population,
  options: MessageOptions & { note?: string; calledBy?: string | null },
): DiscordMessage => {
  const alert = buildMessage('seeding', server, options);
  const lines = [
    "**We're going to try to seed now. Come join!**",
    options.note,
    options.calledBy ? `Called by <@${options.calledBy}>` : undefined,
  ].filter((line) => line !== undefined && line !== '');
  return {
    ...alert,
    embeds: alert.embeds.map((embed) => ({ ...embed, title: `🌱 Seeding ${shorten(server.name)} now`, description: lines.join('\n\n') })),
  };
};

// `markdown` escapes names and bolds the winner, for embeds; without it the text is plain, for a menu.
// Plain text without markdown is for a choice, so each faction's name has its colour's dot too.
const result = (scores: FactionScore[], markdown = true): string[] => {
  const ranked = byScore(scores);
  const [first, second, ...rest] = ranked;
  if (!first || !second) return [];
  const name = (s: FactionScore): string => (markdown ? escapeMarkdown(s.name) : `${factionDot(s.name, s.colorHex)}${s.name}`);
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

const minutes = (ms: number): string => `${Math.round(ms / 60_000)} min`;

const headline = (scores: FactionScore[]): string | null => {
  const [first, second] = byScore(scores);
  if (!first || !second) return null;
  return first.score === second.score ? '🤝 **Draw**' : `🏆 ${factionEmoji(first.name)}**${escapeMarkdown(first.name)}** won`;
};

// The embed takes the winning faction's colour.
const winnerColour = (scores: FactionScore[]): number => {
  const [first, second] = byScore(scores);
  if (!first || !second || first.score === second.score) return INFO_COLOR;
  // Black (#000000) is 0, so only a missing colour falls back.
  return colourOf(first.colorHex) ?? INFO_COLOR;
};

// `endedAt` is when the match ended, as the bot's stats record it. With it the title links to the match on the website;
// without it (a match the stats never held) the title links to the site.
export const buildMatchSummary = (
  summary: MatchSummary & { endedAt?: number | null },
  serverName: string,
  siteUrl?: string,
): DiscordMessage => {
  const top = summary.top.map(
    (p) => `**${playerName(p.name)}** · ${plural(p.kills, 'kill')} · ${plural(p.deaths, 'death')} · ${kd(p.kills, p.deaths)} K/D`,
  );
  const fields: EmbedField[] = [
    ...(summary.factionScores.length > 0 ? [{ name: 'Score', value: scoreLines(summary.factionScores), inline: true }] : []),
    { name: 'Length', value: minutes(summary.durationMs), inline: true },
    { name: 'Peak', value: plural(summary.peakPlayers, 'player'), inline: true },
    ...(top.length > 0 ? [{ name: 'Top players', value: ranked(top) }] : []),
  ];
  const linked = site(siteUrl, summary.endedAt);
  const description = headline(summary.factionScores);
  return {
    embeds: [
      {
        title: `🏁 Match over · ${mapTitle(summary.map) || 'unknown map'}`,
        ...(description ? { description } : {}),
        color: winnerColour(summary.factionScores),
        fields,
        ...linked,
        ...(serverName ? { footer: { text: [shorten(serverName), linked.footer?.text].filter(Boolean).join(' · ') } } : {}),
      },
    ],
    allowed_mentions: NO_PINGS,
  };
};

const PHASE_LABELS: Record<Phase, { label: string; color: number }> = {
  live: { label: '🟢 **Live**', color: COLORS.live },
  seeding: { label: '🌱 **Seeding**', color: COLORS.seeding },
  empty: { label: '⚪ **Empty**', color: EMPTY_COLOR },
};

export const buildStatusEmbed = (status: ServerStatus, rules: AlertRules, siteUrl?: string, serverId?: string): Embed => {
  const phase = phaseFor(status.players, rules);
  const toGo = phase === 'seeding' ? ` · ${Math.max(0, rules.live - status.players)} more to go live` : '';
  return {
    title: shorten(status.name),
    description: `${PHASE_LABELS[phase].label}${toGo}`,
    color: PHASE_LABELS[phase].color,
    fields: [
      { name: 'Players', value: population(status.players, status.maxPlayers, phase) },
      ...(status.map ? [{ name: 'Map', value: mapTitle(status.map), inline: true }] : []),
      ...(status.factionScores.length > 0 ? [{ name: 'Score', value: scoreLines(status.factionScores), inline: true }] : []),
      ...joinField(serverId),
    ],
    ...site(siteUrl),
  };
};

// The live status message, kept in a channel of its own and edited on every check.
export type LiveView = {
  // Null when the server could not be reached.
  snapshot: Snapshot | null;
  // The server's name and when it was last reached, for when it cannot be reached now.
  lastSeen: { name: string; at: number } | null;
  match: MatchState | null;
  nextMap: string | null;
  now: number;
};

const OFFLINE_COLOR = 0xe74c3c;
const LIVE_TOP_PLAYERS = 3;

const LIVE_HEADLINES: Record<Phase, string> = {
  live: 'Get in while there are slots!',
  seeding: 'Jump in and help get it live!',
  empty: 'Be the first in!',
};

// Each faction's score, with how many of its players are on: 🐻 **Valkyra 45** · 12 on
const scoreWithTeams = (scores: FactionScore[], players: Player[]): string => {
  const counted = players.some((p) => p.faction);
  return byScore(scores)
    .map((s, i) => {
      const text = `${escapeMarkdown(s.name)} ${s.score}`;
      const on = players.filter((p) => p.faction && factionKey(p.faction) === factionKey(s.name)).length;
      return `${factionBadge(s.name, s.colorHex)}${i === 0 ? `**${text}**` : text}${counted ? ` · ${on} on` : ''}`;
    })
    .join('\n');
};

// How to join is left off while the server is offline.
export const buildLiveStatus = (view: LiveView, rules: AlertRules, siteUrl?: string, serverId?: string): DiscordMessage => {
  const linked = site(siteUrl);
  const footer = { text: ['Updates every minute', linked.footer?.text].filter(Boolean).join(' · ') };
  const timestamp = new Date(view.now).toISOString();
  const { snapshot, match } = view;

  if (snapshot === null) {
    const seen = view.lastSeen;
    return {
      embeds: [
        {
          title: shorten(seen?.name ?? 'Server status'),
          description: `🔴 **Offline** · ${seen ? `Last seen ${when(seen.at, 'R')}` : "Can't reach the server"}`,
          color: OFFLINE_COLOR,
          ...(linked.url ? { url: linked.url } : {}),
          footer,
          timestamp,
        },
      ],
      allowed_mentions: NO_PINGS,
    };
  }

  const { status, players } = snapshot;
  const phase = phaseFor(status.players, rules);
  const toGo = phase === 'seeding' ? ` · ${Math.max(0, rules.live - status.players)} more to go live` : '';
  const full = status.maxPlayers > 0 && status.players >= status.maxPlayers;
  // How long this match has been going, or how long the server has been seeding.
  const started = match !== null && match.peakPlayers > 0 && phase !== 'empty' ? (match.liveAt ?? match.startedAt) : null;
  const top = phase === 'live' && match !== null ? topPlayers(match.players, LIVE_TOP_PLAYERS).filter((p) => p.kills > 0) : [];
  const fields: EmbedField[] = [
    { name: 'Players', value: population(status.players, status.maxPlayers, phase) },
    ...(status.map ? [{ name: 'Map', value: mapTitle(status.map), inline: true }] : []),
    ...(view.nextMap ? [{ name: 'Next map', value: mapTitle(view.nextMap), inline: true }] : []),
    ...(started !== null
      ? [{ name: match?.liveAt ? 'Match started' : 'Seeding since', value: when(started, 'R'), inline: true }]
      : []),
    ...(status.factionScores.length > 0 && phase !== 'empty'
      ? [{ name: 'Score', value: scoreWithTeams(status.factionScores, players), inline: true }]
      : []),
    ...(top.length > 0
      ? [{ name: 'Top players', value: ranked(top.map((p) => `**${playerName(p.name)}** · ${plural(p.kills, 'kill')}`)), inline: true }]
      : []),
    ...joinField(serverId),
  ];
  return {
    embeds: [
      {
        title: shorten(status.name),
        description: `${PHASE_LABELS[phase].label}${toGo}\n${full ? 'Full right now. Keep trying!' : LIVE_HEADLINES[phase]}`,
        color: PHASE_LABELS[phase].color,
        fields,
        ...(linked.url ? { url: linked.url } : {}),
        footer,
        timestamp,
      },
    ],
    allowed_mentions: NO_PINGS,
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

const MAX_PLAYERS_LISTED = 30;

const tally = (count: number | null, word: string): string => (count === null ? `– ${word}s` : plural(count, word));

export const buildPlayersEmbed = (players: Player[]): Embed => {
  if (players.length === 0) {
    return { title: '👥 Nobody is on the server', description: 'The server is empty. Be the first in!', color: EMPTY_COLOR };
  }
  const sorted = [...players].sort((a, b) => (b.kills ?? 0) - (a.kills ?? 0) || (a.deaths ?? 0) - (b.deaths ?? 0));
  const lines = sorted
    .slice(0, MAX_PLAYERS_LISTED)
    .map(
      (p) =>
        `${p.faction ? factionBadge(p.faction) : ''}**${playerName(p.name)}** · ${tally(p.kills, 'kill')} · ${tally(p.deaths, 'death')}`,
    );
  const hidden = sorted.length - MAX_PLAYERS_LISTED;
  // How many are on each team, largest first, when the server says who is on which.
  const teams = [...new Set(players.flatMap((p) => (p.faction ? [p.faction] : [])))]
    .map((team) => ({ team, count: players.filter((p) => p.faction === team).length }))
    .sort((a, b) => b.count - a.count);
  return {
    title: `👥 ${plural(players.length, 'player')} online`,
    description: ranked(lines),
    color: INFO_COLOR,
    ...(teams.length > 0
      ? { fields: teams.map(({ team, count }) => ({ name: `${factionBadge(team)}${shorten(team)}`, value: plural(count, 'player'), inline: true })) }
      : {}),
    footer: { text: hidden > 0 ? `Most kills first · ${hidden} more not shown` : 'Most kills first' },
  };
};

const ROTATION_SHOWN = 5;

const rotationLine = (entry: Rotation['entries'][number]): string => {
  const name = mapName(entry.map);
  const colour = mapEmoji(entry.map);
  if (entry.status === 'now') return `▶️ ${colour}**${name}** · now`;
  if (entry.status === 'next') return `⏭️ ${colour}**${name}** · next`;
  return `▫️ ${colour}${name}`;
};

export const buildRotationEmbed = (rotation: Rotation): Embed => {
  const { entries } = rotation;
  const title = '🗺️ Map rotation';
  if (entries.length === 0) return { title, description: 'No maps in the rotation.', color: INFO_COLOR };

  const nowAt = Math.max(0, entries.findIndex((e) => e.status === 'now'));
  const fromNow = Array.from({ length: Math.min(ROTATION_SHOWN, entries.length) }, (_, i) => entries[(nowAt + i) % entries.length]);
  const { lines, note } = ((): { lines: string[]; note?: string } => {
    if (!rotation.enabled) return { lines: fromNow.slice(0, 1).flatMap((e) => (e ? [rotationLine(e)] : [])), note: 'Rotation is off, so this map repeats.' };
    if (rotation.mode === 'random') {
      // The next map can sit earlier in the list than the current one, so pick them in that order.
      const known = ['now', 'next'].flatMap((status) => entries.filter((e) => e.status === status)).map(rotationLine);
      return { lines: known, note: 'Random order, so only the next map is known.' };
    }
    return { lines: fromNow.flatMap((e) => (e ? [rotationLine(e)] : [])) };
  })();
  // In the colour of the map being played.
  const playing = entries.find((e) => e.status === 'now');
  const color = (playing && mapStyle(playing.map)?.colour) ?? INFO_COLOR;
  return { title, description: lines.join('\n'), color, ...(note ? { footer: { text: note } } : {}) };
};

// "Saturday and Sunday", "Monday, Tuesday and Friday".
export const andList = (items: string[]): string =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : (items[0] ?? '');

// /rotations show: the saved rotations with their maps' names in order, the week's plan (Monday first, `weekday` 0 is
// Monday), and the rotation on the server today: who picked it ("schedule" or a Discord user ID), and whether the server
// has it yet. `hour` is when each day's rotation goes on (UTC).
export type RotationsView = {
  rotations: { name: string; maps: string[] }[];
  week: (string | null)[];
  weekday: number;
  today: { name: string; by: string; pending: boolean } | null;
  hour: number;
};

// A rotation's first few maps, so a field stays short.
const ROTATION_MAPS_NAMED = 8;
// Lines of one rotation's maps; at about 80 characters each, this stays inside Discord's 4096.
const ROTATION_LINES_SHOWN = 40;

const twoDigits = (n: number): string => String(n).padStart(2, '0');

export const buildRotationsEmbed = ({ rotations, week, weekday, today, hour }: RotationsView): Embed => {
  const title = '🗺️ Map rotations';
  const footer = { text: `Each day's rotation goes on at ${twoDigits(hour)}:00 UTC and plays from the next map.` };
  if (rotations.length === 0) {
    return {
      title,
      description: "No saved rotations yet. Save the server's rotation with **/rotations save**, or build one with **/rotations add**.",
      color: INFO_COLOR,
      footer,
    };
  }
  const chosen =
    today === null
      ? 'No rotation picked for today, so the server keeps the one it has.'
      : `On the server today: **${today.name}**, ${today.by === 'schedule' ? 'from the schedule' : `picked by <@${today.by}>`}.` +
        (today.pending ? " ⏳ The server doesn't have it yet; the bot tries again every minute." : '');
  const named = (maps: string[]): string => {
    const more = maps.length - ROTATION_MAPS_NAMED;
    return [...maps.slice(0, ROTATION_MAPS_NAMED), ...(more > 0 ? [`${more} more`] : [])].join(' → ');
  };
  return {
    title,
    description: chosen,
    color: INFO_COLOR,
    fields: [
      { name: '📅 This week', value: ROTATION_DAYS.map((day, i) => `${i === weekday ? '▶️' : '▫️'} ${day}: ${week[i] ? `**${week[i]}**` : '–'}`).join('\n') },
      ...rotations.map((r) => ({ name: `${r.name} · ${plural(r.maps.length, 'map')}`, value: r.maps.length === 0 ? 'No maps yet.' : named(r.maps) })),
    ],
    footer,
  };
};

// /rotations show with a rotation picked: its maps in order, one line each, and the days it is planned for.
export const buildSavedRotationEmbed = ({ name, lines, days, onToday }: { name: string; lines: string[]; days: string[]; onToday: boolean }): Embed => {
  const shown = lines.slice(0, ROTATION_LINES_SHOWN).map((line, i) => `${i + 1}. ${line}`);
  const more = lines.length - shown.length;
  return {
    title: `🗺️ ${name}`,
    description: lines.length === 0 ? 'No maps yet. Add some with **/rotations add**.' : [...shown, ...(more > 0 ? [`…and ${more} more`] : [])].join('\n'),
    color: INFO_COLOR,
    footer: { text: [days.length > 0 ? `Planned for ${andList(days)}` : 'Not planned for any day', ...(onToday ? ['On the server today'] : [])].join(' · ') },
  };
};

// Discord caps an embed description at 4096 characters; this many names stays well inside it.
const MAX_NAMES_ANNOUNCED = 20;

const nameList = (names: string[]): string => {
  const shown = names.slice(0, MAX_NAMES_ANNOUNCED).map(playerName);
  const more = names.length - shown.length;
  const all = more > 0 ? [...shown, `${more} more`] : shown;
  return andList(all);
};

// Posted when seeders get a reserved slot, or keep one for another week, so everyone sees what seeding earns.
export const buildVipMessage = (
  added: { name: string }[],
  renewed: { name: string }[],
  vip: VipRule,
  siteUrl?: string,
): DiscordMessage => {
  const linked = site(siteUrl);
  const week = vip.lengthDays === 7 ? 'week' : span(vip.lengthDays);
  const earned =
    added.length > 0
      ? `🎉 **${nameList(added.map((p) => p.name))}** earned ${added.length === 1 ? 'a reserved slot' : 'reserved slots'} ` +
        `for ${span(vip.lengthDays)} by seeding. Thank you!`
      : null;
  return {
    embeds: [
      {
        title: '🎖️ Reserved slots for seeders',
        ...(earned ? { description: earned } : {}),
        color: COLORS.seeding,
        fields: [
          ...(renewed.length > 0 ? [{ name: `Kept for another ${week}`, value: nameList(renewed.map((p) => p.name)) }] : []),
          { name: 'Earn one too', value: `${vipOffer(vip)}\n${vipRule(vip)}` },
        ],
        ...linked,
        footer: { text: ["Reserved slots start after the server's next restart.", linked.footer?.text].filter(Boolean).join(' · ') },
      },
    ],
    allowed_mentions: NO_PINGS,
  };
};

const ROUNDUP_COLOR = 0xf1c40f;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Discord caps a message's embeds at 6000 characters all told, and a field's value at 1024.
const MAX_EMBED = 6000;
const MAX_FIELD = 1024;

// "28 Sep", or "Sat 27 Sep" with the weekday, for a UTC day.
const dayLabel = (at: number, weekday = false): string => {
  const d = new Date(at);
  return `${weekday ? `${WEEKDAYS[d.getUTCDay()]} ` : ''}${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

// "28 Sep – 4 Oct", or "September 2026" for a month.
const periodLabel = (r: Roundup): string => {
  const start = new Date(r.start);
  return r.kind === 'month'
    ? `${MONTH_NAMES[start.getUTCMonth()]} ${start.getUTCFullYear()}`
    : [...new Set([dayLabel(r.start), dayLabel(r.end - 1)])].join(' – ');
};

// "Weekly roundup · 28 Sep – 4 Oct", "Monthly roundup · September 2026", or "This week so far · 28 Sep – 3 Oct".
const roundupTitle = (r: Roundup): string => {
  const name = r.partial ? `This ${r.kind} so far` : r.kind === 'month' ? 'Monthly roundup' : 'Weekly roundup';
  return `🏆 ${name} · ${periodLabel(r)}`;
};

const matchCount = (count: number): string => `${count} ${count === 1 ? 'match' : 'matches'}`;

const percent = (part: number, whole: number): string => `${Math.round((part / Math.max(whole, 1)) * 100)}%`;

// 🐻 **Valkyra** 100 – 23 Lonestar · 🟦 Ozeti
const matchLine = (m: MatchHighlight): string => {
  const [first, second] = byScore(m.factionScores);
  if (!first || !second) return mapTitle(m.map);
  const winner = `${factionBadge(first.name, first.colorHex)}**${escapeMarkdown(first.name)}**`;
  return `${winner} ${first.score} – ${second.score} ${escapeMarkdown(second.name)} · ${mapTitle(m.map)}`;
};

const teamLine = (t: TeamStanding, best: boolean): string => {
  const name = escapeMarkdown(t.name);
  const record = [`${t.wins} W`, `${t.losses} L`, ...(t.draws > 0 ? [`${t.draws} D`] : []), percent(t.wins, t.matches)];
  return `${factionBadge(t.name, t.colorHex)}${best ? `**${name}**` : name} · ${record.join(' · ')}`;
};

const embedLength = (embed: Embed): number =>
  embed.title.length +
  (embed.description?.length ?? 0) +
  (embed.footer?.text.length ?? 0) +
  (embed.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0);

// A player's name in bold, linked to their page when `pages` is the website's address.
const roundupName = (p: RoundupPlayer, pages: string | null): string => {
  const name = playerName(p.name);
  return `**${pages && p.id ? `[${name}](${pages}/player?id=${p.id})` : name}**`;
};

const roundupBoard = <T extends RoundupPlayer>(rows: T[], value: (p: T) => string, pages: string | null): string =>
  rows.length === 0 ? '–' : ranked(rows.map((p) => `${roundupName(p, pages)} · ${value(p)}`));

const buildRoundupEmbed = (r: Roundup, pages: string | null, siteUrl: string | undefined): Embed => {
  const who = (p: RoundupPlayer): string => roundupName(p, pages);
  const board = <T extends RoundupPlayer>(rows: T[], value: (p: T) => string): string => roundupBoard(rows, value, pages);

  // Whole hours, once there is at least one.
  const played = r.playedMs >= 60 * 60_000 ? `${Math.round(r.playedMs / (60 * 60_000))} h` : minutes(r.playedMs);
  const summary =
    r.matches > 0
      ? `**${matchCount(r.matches)}** · **${played}** played · ` +
        `**${plural(r.players, 'player')}**${r.peakPlayers === null ? '' : ` · peak **${r.peakPlayers}**`}`
      : `**${plural(r.players, 'player')}** · no matches went live`;
  const team = r.bestTeam
    ? `🏆 Team of the ${r.kind}: ${factionBadge(r.bestTeam.name, r.bestTeam.colorHex)}**${escapeMarkdown(r.bestTeam.name)}** · ` +
      `won ${r.bestTeam.wins} of ${matchCount(r.bestTeam.matches)} (${percent(r.bestTeam.wins, r.bestTeam.matches)})`
    : null;

  const playtime = (p: { minutes: number }): string => hoursAndMinutes(p.minutes);
  const combat: EmbedField[] =
    r.matches > 0
      ? [
          { name: '🔫 Most kills', value: board(r.kills, (p) => String(p.kills)), inline: true },
          { name: `🎯 Best K/D (${r.kdMinHours}+ hours played)`, value: board(r.kd, (p) => p.kd.toFixed(2)), inline: true },
          { name: '💥 Most kills in a match', value: board(r.bestMatch, (p) => `${p.kills} · ${mapTitle(p.map)}`), inline: true },
          { name: '🏅 Most wins', value: board(r.wins, (p) => `${p.wins} of ${p.played}`), inline: true },
          { name: '⭐ Most MVPs', value: board(r.mvps, (p) => String(p.mvps)), inline: true },
          { name: '⏱️ Most time played', value: board(r.playtime, playtime), inline: true },
        ]
      : r.playtime.length > 0
        ? [{ name: '⏱️ Most time played', value: board(r.playtime, playtime) }]
        : [];
  const highlights = [
    ...(r.biggestWin ? [`💪 Biggest win: ${matchLine(r.biggestWin)}`] : []),
    ...(r.closestMatch ? [`😬 Closest finish: ${matchLine(r.closestMatch)}`] : []),
    ...(r.topMap ? [`🗺️ Most played: ${mapTitle(r.topMap.map)} · ${matchCount(r.topMap.matches)}`] : []),
    ...(r.busiestDay
      ? [`📅 Busiest day: ${dayLabel(Date.parse(`${r.busiestDay.day}T00:00:00Z`), true)} · ${plural(r.busiestDay.players, 'player')}`]
      : []),
  ];
  const linked = site(siteUrl);
  const rules = [
    r.kind === 'week' ? 'Weeks run Monday to Sunday, UTC.' : 'Days are UTC.',
    `MVP: top of a match's scoreboard. Team of the ${r.kind}: best win rate, ${r.teamMinMatches}+ matches.`,
  ];
  return {
    title: roundupTitle(r),
    description: [summary, team].filter((line) => line !== null).join('\n'),
    color: (r.bestTeam && colourOf(r.bestTeam.colorHex)) ?? ROUNDUP_COLOR,
    fields: [
      ...(r.teams.length > 0 ? [{ name: '⚔️ Teams', value: r.teams.map((t) => teamLine(t, t.name === r.bestTeam?.name)).join('\n') }] : []),
      ...combat,
      ...(r.seeding.length > 0
        ? [
            {
              name: '🌱 Top seeders · thanks for getting us live!',
              value: board(r.seeding, (p) => `${plural(p.seedDays, 'seed day')} · ${hoursAndMinutes(p.minutes)}`),
            },
          ]
        : []),
      ...(highlights.length > 0 ? [{ name: '✨ Highlights', value: highlights.join('\n') }] : []),
    ],
    ...(linked.url ? { url: linked.url } : {}),
    footer: { text: [...rules, linked.footer?.text].filter(Boolean).join('\n') },
  };
};

const ROLE_TITLES: Record<RoleAward, string> = {
  assault: '🪖 Best assaulter',
  support: '💣 Best support',
  'machine-gun': '🔥 Best machine gunner',
  marksman: '🔭 Best marksman',
  demolition: '🧨 Best demolitions',
  'vehicle-gun': '🚁 Best vehicle crew',
};

const ROLE_RULES =
  'Assault: assault rifles, SMGs and shotguns. Support: mortars, artillery and emplacements. Machine gunner: LMGs. ' +
  'Marksman: marksman and sniper rifles, and the bow. Demolitions: launchers, grenades, mines and C4. ' +
  'Vehicle crew: vehicle guns.';

// "742 m", and to a tenth under 10 m: "4.5 m".
const metres = (distance: number): string => `${distance < 10 ? Number(distance.toFixed(1)) : Math.round(distance)} m`;

// The awards: the best at each role, from the kill feed, and shout-outs for the rest. Null when there are none.
const buildAwardsEmbed = (r: Roundup, pages: string | null): Embed | null => {
  const a = r.awards;
  const who = (p: RoundupPlayer): string => roundupName(p, pages);
  const shoutOuts = [
    ...(a?.headshots ? [`💀 Headhunter: ${who(a.headshots)} · ${plural(a.headshots.headshots, 'headshot')}`] : []),
    ...(a?.longest ? [`📏 Longest shot: ${who(a.longest)} · ${metres(a.longest.distance)} · ${escapeMarkdown(a.longest.weapon)}`] : []),
    ...(a?.variety ? [`🧰 Jack of all trades: ${who(a.variety)} · kills with ${plural(a.variety.weapons, 'weapon')}`] : []),
    ...(a?.roadKills ? [`🚗 Road rage: ${who(a.roadKills)} · ${a.roadKills.kills} run over or blown up`] : []),
    ...(a?.melee ? [`🔨 Bonk: ${who(a.melee)} · ${plural(a.melee.kills, 'melee kill')}`] : []),
    ...(a?.sidearm ? [`🤠 Quickdraw: ${who(a.sidearm)} · ${plural(a.sidearm.kills, 'pistol kill')}`] : []),
    ...(r.regular ? [`📆 Ever-present: ${who(r.regular)} · on ${r.regular.days} of ${plural(r.regular.of, 'day')}`] : []),
    ...(r.rookie ? [`🐣 Rookie of the ${r.kind}: ${who(r.rookie)} · ${hoursAndMinutes(r.rookie.minutes)} played`] : []),
  ];
  const fields: EmbedField[] = [
    ...(a ? a.roles.map(({ role, top }) => ({ name: ROLE_TITLES[role], value: roundupBoard(top, (p) => String(p.kills), pages), inline: true })) : []),
    ...(shoutOuts.length > 0 ? [{ name: '🌟 Shout-outs', value: shoutOuts.join('\n') }] : []),
  ];
  if (fields.length === 0) return null;
  const from = a === null ? null : Date.parse(`${a.from}T00:00:00Z`);
  const rules = [
    ...(a ? [ROLE_RULES, "Kills from the game's kill feed; team kills don't count."] : []),
    ...(from !== null && from > r.start ? [`The kill feed's awards count from ${dayLabel(from, true)}.`] : []),
    ...(r.rookie ? [`Rookie: first seen this ${r.kind}.`] : []),
  ];
  return {
    title: `🎖️ Awards · ${periodLabel(r)}`,
    color: ROUNDUP_COLOR,
    fields,
    ...(rules.length > 0 ? { footer: { text: rules.join('\n') } } : {}),
  };
};

const fits = (embeds: Embed[]): boolean =>
  embeds.reduce((sum, e) => sum + embedLength(e), 0) <= MAX_EMBED &&
  embeds.every((e) => (e.fields ?? []).every((f) => f.value.length <= MAX_FIELD));

// The best players and team of a week or month, then the awards. Names link to their player pages on the website,
// unless the links would make it too long for Discord, and the awards are left out if it is too long even then.
export const buildRoundupMessage = (roundup: Roundup, siteUrl?: string): DiscordMessage => {
  const pages = siteUrl ? siteUrl.replace(/\/$/, '') : null;
  const build = (links: string | null): Embed[] => {
    const awards = buildAwardsEmbed(roundup, links);
    return [buildRoundupEmbed(roundup, links, siteUrl), ...(awards === null ? [] : [awards])];
  };
  const embeds = [build(pages), build(null)].find(fits) ?? build(null).slice(0, 1);
  return { embeds, allowed_mentions: NO_PINGS };
};

export type SeederRow = { steamId: string; name: string; seedingMinutes: number; seedDays: number; vipUntil: number | null };

// For admins, so it shows Steam IDs; the reply is only visible to the admin who asked.
export const buildSeedersEmbed = (seeders: SeederRow[], days: number, seedMinutes: number, vip: VipRule | null): Embed => {
  const title = `🌱 Top seeders · last ${plural(days, 'day')}`;
  const footer = {
    text: [
      `A seed day: on for more than ${seedMinutes} min while the server seeded, and it then went live. Days are UTC.`,
      ...(vip ? [`VIP: ${vipOffer(vip)}`] : []),
    ].join('\n'),
  };
  if (seeders.length === 0) return { title, description: 'Nobody seeded in that time.', color: COLORS.seeding, footer };
  const lines = seeders.map(
    (s) =>
      `**${playerName(s.name)}** · ${plural(s.seedDays, 'seed day')} · ${s.seedingMinutes} min\n` +
      [`\`${s.steamId.replace(/`/g, '')}\``, ...(s.vipUntil === null ? [] : [`🎖️ VIP until <t:${Math.floor(s.vipUntil / 1000)}:f>`])].join(
        ' · ',
      ),
  );
  return { title, description: ranked(lines), color: COLORS.seeding, footer };
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
    mapTitle(match.map) || 'Unknown map',
    ...result(match.factionScores, false),
    `${Math.round(match.durationMs / 60_000)} min`,
    `ended ${utcTime(match.endedAt)}`,
  ].join(' · ');
  return { name: name.length > MAX_CHOICE_NAME ? `${name.slice(0, MAX_CHOICE_NAME - 1)}…` : name, value: String(match.endedAt) };
};

export const removedMatchText = (match: RecentMatch, players: number): string =>
  [
    `🗑️ Removed the ${mapTitle(match.map) || 'unknown map'} match that ended <t:${Math.floor(match.endedAt / 1000)}:f>` +
      ` (${[...result(match.factionScores), `${Math.round(match.durationMs / 60_000)} min`].join(' · ')}).`,
    players > 0
      ? `Its match, kills and deaths came off ${players === 1 ? "1 player's" : `${players} players'`} totals.`
      : 'It had no player records to take off.',
  ].join(' ');

export const buildLastMatchEmbed = (match: RecentMatch, siteUrl?: string): Embed => {
  const [summary] = buildMatchSummary(match, '', siteUrl).embeds;
  const ended = `Ended <t:${Math.floor(match.endedAt / 1000)}:R>`;
  return summary
    ? {
        ...summary,
        title: `🏁 Last match · ${mapTitle(match.map) || 'unknown map'}`,
        description: [summary.description, ended].filter(Boolean).join(' · '),
        timestamp: new Date(match.endedAt).toISOString(),
      }
    : { title: '🏁 Last match', description: ended, color: INFO_COLOR };
};

export type PlayerProfile = {
  steamId: string;
  name: string | null;
  record: PlayerRecord;
  online: Player | null;
  // null when the server could not be read.
  reserved: boolean | null;
  // undefined when the server could not be read; null when it has no ban for them.
  serverBan: Ban | null | undefined;
  // What Steam says about their account. Left out without STEAM_API_KEY.
  steam?: SteamLookup;
  days: number;
  now: number;
  // Names a weapon from the kill feed's cause tag, for their team kills.
  weapon?: (cause: string) => string;
};

const ACTION_NAMES: Record<ModAction, string> = {
  warn: 'Warning',
  kick: 'Kick',
  ban: 'Ban',
  unban: 'Unban',
  switchteam: 'Team move',
  'vip-add': 'VIP added',
  'vip-remove': 'VIP removed',
};

const HISTORY_SHOWN = 5;
const MAX_REASON_SHOWN = 100;

const hoursAndMinutes = (total: number): string => {
  const hours = Math.floor(total / 60);
  return hours > 0 ? `${hours} h ${total % 60} min` : `${total} min`;
};

// Discord shows these in each viewer's own time, and keeps "5 minutes ago" up to date by itself.
const when = (at: number, style: 'f' | 'd' | 'R'): string => `<t:${Math.floor(at / 1000)}:${style}>`;

const cut = (text: string): string => (text.length > MAX_REASON_SHOWN ? `${text.slice(0, MAX_REASON_SHOWN - 1)}…` : text);

const vipText = ({ record, reserved, now }: PlayerProfile): string => {
  // The reserved list is the truth when it can be read; otherwise the bot's record is shown as only that.
  const lines = [
    reserved === null
      ? record.staffSpot
        ? "🎖️ Staff spot: a reserved slot while they are staff, by the bot's records\n(Couldn't check the reserved list.)"
        : record.vip === null
          ? "Couldn't read the reserved list"
          : `🎖️ Reserved slot until ${when(record.vip.expiresAt, 'f')}, by the bot's records\n(Couldn't check the reserved list.)`
      : record.staffSpot
        ? reserved
          ? '🎖️ Staff spot: a reserved slot while they are staff'
          : '🎖️ Staff spot: on the reserved list from the next check'
        : record.vip !== null && reserved
          ? `🎖️ Reserved slot until ${when(record.vip.expiresAt, 'f')}`
          : reserved
            ? '🎖️ Permanent reserved slot, no end date'
            : 'None',
    ...(record.vipBlockedUntil !== null && record.vipBlockedUntil > now
      ? [`Staff removed VIP: automatic VIP is off for them until ${when(record.vipBlockedUntil, 'f')}`]
      : []),
  ];
  return lines.join('\n');
};

const banText = ({ record, serverBan }: PlayerProfile): string => {
  const ban = record.ban;
  const bots = (b: BanRecord): string => {
    const until = b.until === null ? 'permanently' : `until ${when(b.until, 'f')} (${when(b.until, 'R')})`;
    return `🔨 Banned ${until} by <@${b.by}>: ${cut(b.reason)}`;
  };
  // The game only bans players in game, so a ban made while they were away is not on the server until they join.
  if (ban?.waiting && serverBan === null) return `${bots(ban)}\n(Not on the server yet: the bot bans them when they next join.)`;
  // The server is the truth when it can be read: a ban lifted by hand is gone even if the bot still has a record, and
  // a ban made some other way since is not described as the bot's.
  if (serverBan === null) return 'Not banned';
  if (serverBan === undefined) return ban === null ? "Couldn't read the ban list" : `${bots(ban)}\n(Couldn't check the server's ban list.)`;
  if (ban !== null && isBotBan(serverBan.reason, ban)) return bots(ban);
  return `🔨 Banned on the server${serverBan.reason ? `: ${cut(serverBan.reason)}` : ''}`;
};

// Red while the player is banned, as far as can be told.
const isBanned = ({ record, serverBan }: PlayerProfile): boolean =>
  serverBan === undefined ? record.ban !== null : serverBan !== null || record.ban?.waiting === true;

// Who did something: a staff member as a Discord mention (which never pings with NO_PINGS), the bot, or someone outside
// the bot, whose change the bot found on the server.
const staffName = (by: string): string => (by === 'bot' ? 'the bot' : by === 'server' ? 'someone outside the bot' : `<@${by}>`);

const historyText = (record: PlayerRecord): string => {
  if (record.log.length === 0) return 'Nothing through the bot yet.';
  const count = (action: ModAction, word: string): string[] => {
    const n = record.log.filter((e) => e.action === action).length;
    return n > 0 ? [plural(n, word)] : [];
  };
  const counts = [...count('warn', 'warning'), ...count('kick', 'kick'), ...count('ban', 'ban')];
  const entries = [...record.log]
    .reverse()
    .slice(0, HISTORY_SHOWN)
    .map((e) => {
      const by = staffName(e.by);
      const detail = e.detail ? ` (${escapeMarkdown(e.detail)})` : '';
      return `${when(e.at, 'd')} **${ACTION_NAMES[e.action]}**${detail} by ${by}${e.reason ? `: ${cut(e.reason)}` : ''}`;
    });
  return [...(counts.length > 0 ? [counts.join(' · ')] : []), ...entries].join('\n');
};

const RISK_EMOJI: Record<Risk, string> = { high: '🚩', medium: '⚠️', low: '✅' };

// "🚩 **High risk** · 5 points".
const riskLine = (check: SteamCheck, now: number): string => {
  const { risk, score } = assess(check, now);
  return `${RISK_EMOJI[risk]} **${RISK_LABELS[risk]}**${risk === 'low' ? '' : ` · ${plural(score, 'point')}`}`;
};

const steamText = (lookup: SteamCheck | 'failed', now: number): string => {
  if (lookup === 'failed') return "Couldn't reach Steam just now.";
  if (!lookup.found) return `Steam has no account with this ID. Checked ${when(lookup.at, 'R')}`;
  return [riskLine(lookup, now), steamFacts(lookup, now).join(' · '), `Checked ${when(lookup.at, 'R')}`].join('\n');
};

const INCIDENTS_LISTED = 5;

// `steamId`, when given, is whose incidents they are: a team kill on them says who killed them.
const incidentLine = (i: Incident, weapon: (cause: string) => string, steamId?: string): string => {
  const how = i.cause === null ? '' : ` with ${escapeMarkdown(weapon(i.cause))}`;
  const far = i.distance === null ? '' : ` from ${Math.round(i.distance)} m`;
  const what =
    i.kind === 'vehicle-suicide'
      ? 'Killed themselves in a vehicle'
      : steamId !== undefined && i.victimSteamId === steamId && i.steamId !== steamId
        ? `Killed by teammate **${playerName(i.name || i.steamId)}**`
        : `Killed teammate **${playerName(i.victimName || i.victimSteamId || 'unknown')}**`;
  return `${when(i.at, 'R')} ${what}${how}${far}${i.map ? ` on ${mapName(i.map)}` : ''}`;
};

// The newest lines that fit in `room` characters together, oldest first: a weapon or map the bot has no name for is
// named from its tag, which can be long.
const newestThatFit = (lines: string[], room: number): string[] =>
  lines.reduceRight<string[]>((kept, line) => ([line, ...kept].join('\n').length <= room ? [line, ...kept] : kept), []);

const FLAG_NAMES: Record<Flag, string> = {
  teamKills: 'team kills',
  sameTeammate: 'same teammate',
  vehicleSuicides: 'vehicle suicides',
  suicides: 'suicides',
};

const VICTIMS_NAMED = 5;

// "(2 with a vehicle, 1 in a helicopter crash)" after a count of team kills, or nothing when none were either.
const teamKillDetail = (vehicle: number, crash: number): string => {
  const parts = [
    ...(vehicle > 0 ? [`${vehicle} with a vehicle`] : []),
    ...(crash > 0 ? [`${crash} in a helicopter crash`] : []),
  ];
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
};

// For /player: their team kills and suicides today, whom they team killed, and the latest team kills and vehicle
// suicides by them or team kills on them.
const griefText = (grief: PlayerGrief, weapon: (cause: string) => string, steamId: string): string => {
  if (grief.teamKills + grief.teamKilled + grief.suicides === 0) return 'No team kills or suicides today.';
  const counts = [
    `**${plural(grief.teamKills, 'team kill')}**${teamKillDetail(grief.vehicleTeamKills, grief.crashTeamKills)}`,
    ...(grief.teamKilled > 0 ? [`killed by a teammate ${plural(grief.teamKilled, 'time')}`] : []),
    ...(grief.suicides > 0
      ? [`${plural(grief.suicides, 'suicide')}${grief.vehicleSuicides > 0 ? ` (${grief.vehicleSuicides} in a vehicle)` : ''}`]
      : []),
  ];
  const named = grief.victims.slice(0, VICTIMS_NAMED).map((v) => `**${playerName(v.name)}**${v.kills > 1 ? ` ×${v.kills}` : ''}`);
  const more = grief.victims.length - named.length;
  const head = [
    ...(grief.flags.length > 0 ? [`🚩 Flagged: ${grief.flags.map((f) => FLAG_NAMES[f]).join(', ')}`] : []),
    counts.join(' · '),
    ...(named.length > 0 ? [`Teammates killed: ${named.join(', ')}${more > 0 ? ` and ${more} more` : ''}`] : []),
  ].join('\n');
  const latest = newestThatFit(
    grief.incidents.slice(-INCIDENTS_LISTED).map((i) => incidentLine(i, weapon, steamId).slice(0, MAX_FIELD)),
    MAX_FIELD - head.length - 1,
  );
  return [head, ...latest].join('\n');
};

// For staff: who a player is, their time on the server, their Steam account, VIP, bans and what staff did through the bot.
export const buildPlayerEmbed = (profile: PlayerProfile): Embed => {
  const { steamId, name, record, online, days, steam } = profile;
  const t = record.totals;
  const period = `last ${days} days`;
  const here = online
    ? `🟢 In game now${online.faction ? ` on ${factionBadge(online.faction)}**${escapeMarkdown(online.faction)}**` : ''}` +
      (online.kills === null ? '' : ` · ${tally(online.kills, 'kill')} · ${tally(online.deaths, 'death')}`)
    : '⚫ Not in game';
  return {
    title: `👤 ${name === null ? 'Unknown player' : playerName(name)}`,
    description: [
      `\`${steamId}\` · [Steam profile](https://steamcommunity.com/profiles/${steamId})`,
      here,
      ...(record.privateProfile ? [`🔒 Private profile: the public sees them as ${escapeMarkdown(PRIVATE_NAME)}`] : []),
    ].join('\n'),
    color: isBanned(profile) ? COLORS.lowPop : INFO_COLOR,
    fields: [
      ...(t === null
        ? [{ name: `Time · ${period}`, value: 'Not seen on the server.' }]
        : [
            { name: `Playtime · ${period}`, value: hoursAndMinutes(t.seedingMinutes + t.liveMinutes), inline: true },
            { name: 'Seeding', value: `${hoursAndMinutes(t.seedingMinutes)} · ${plural(t.seedDays, 'seed day')}`, inline: true },
            { name: 'Matches', value: `${t.matches} · ${plural(t.kills, 'kill')} · ${kd(t.kills, t.deaths)} K/D`, inline: true },
          ]),
      ...(record.grief === null
        ? []
        : [{ name: 'Team kills · today (UTC)', value: griefText(record.grief, profile.weapon ?? ((cause) => cause), steamId) }]),
      ...(steam === undefined || steam === 'off' ? [] : [{ name: 'Steam account', value: steamText(steam, profile.now) }]),
      { name: 'VIP', value: vipText(profile) },
      { name: 'Ban', value: banText(profile) },
      { name: 'Staff history', value: historyText(record) },
    ],
    footer: {
      text:
        'Staff history only covers what staff did through the bot.' +
        (record.grief === null ? '' : ' Team kills are from the kill feed, with sides from the last check, up to a minute old.'),
    },
  };
};

// The moderation log channel: every warning, kick, ban, unban, team move and VIP added or removed, by staff through the
// bot, by the bot itself (a timed ban ending), or found on the server's ban list (a ban made or lifted in game or in
// ServerSettings.ini).
const MOD_STYLE: Record<ModAction, { emoji: string; color: number }> = {
  warn: { emoji: '⚠️', color: 0xf1c40f },
  kick: { emoji: '👢', color: 0xe67e22 },
  ban: { emoji: '🔨', color: 0xe74c3c },
  unban: { emoji: '✅', color: 0x2ecc71 },
  switchteam: { emoji: '🔀', color: INFO_COLOR },
  'vip-add': { emoji: '🎖️', color: INFO_COLOR },
  'vip-remove': { emoji: '🎖️', color: INFO_COLOR },
};

// The staff page on the website, when SITE_URL is set.
const staffPage = (siteUrl: string | undefined): Pick<Embed, 'url'> => (siteUrl ? { url: `${siteUrl.replace(/\/$/, '')}/admin` } : {});

const MAX_LOGGED_REASON = 1000;

const steamLine = (steamId: string): string => `\`${steamId}\` · [Steam profile](https://steamcommunity.com/profiles/${steamId})`;

export const buildModLogMessage = (steamId: string, entry: ModEntry, siteUrl?: string): DiscordMessage => {
  const style = MOD_STYLE[entry.action];
  const name = entry.name ? playerName(entry.name) : 'Unknown player';
  const reason = entry.reason ? escapeMarkdown(entry.reason.slice(0, MAX_LOGGED_REASON)) : null;
  return {
    embeds: [
      {
        title: `${style.emoji} ${ACTION_NAMES[entry.action]} · ${name}`,
        ...staffPage(siteUrl),
        description: [steamLine(steamId), ...(reason === null ? [] : [`**Reason:** ${reason}`])].join('\n'),
        color: style.color,
        fields: [
          { name: 'By', value: entry.by === 'server' ? 'Outside the bot (in game, or in ServerSettings.ini)' : staffName(entry.by), inline: true },
          // Escaping at most doubles it, so it stays inside Discord's limit for a field.
          ...(entry.detail ? [{ name: 'Details', value: escapeMarkdown(entry.detail.slice(0, MAX_FIELD / 2)), inline: true }] : []),
        ],
        timestamp: new Date(entry.at).toISOString(),
      },
    ],
    allowed_mentions: NO_PINGS,
  };
};

// A player passing a griefing flag's mark today. `weapon` names a cause tag. `steam` is the player's saved Steam check:
// an account worth a look or high risk is shown, as griefing on one is more telling.
export const buildGriefAlert = (
  alert: GriefAlert,
  weapon: (cause: string) => string,
  siteUrl?: string,
  steam: SteamCheck | null = null,
): DiscordMessage => {
  const at = alert.incidents.at(-1)?.at ?? Date.now();
  const reasons = [
    ...(alert.sameTeammate === null
      ? []
      : [`Killed teammate **${playerName(alert.sameTeammate.name)}** ${plural(alert.sameTeammate.kills, 'time')} today`]),
    ...(alert.teamKills > 0 ? [`${plural(alert.teamKills, 'team kill')} today${teamKillDetail(0, alert.crashTeamKills)}`] : []),
    ...(alert.vehicleSuicides > 0 ? [`${plural(alert.vehicleSuicides, 'vehicle suicide')} today`] : []),
  ];
  // The newest that fit in one field.
  const latest = newestThatFit(
    alert.incidents.slice(-INCIDENTS_LISTED).map((i) => incidentLine(i, weapon).slice(0, MAX_FIELD)),
    MAX_FIELD,
  );
  return {
    embeds: [
      {
        title: `🚩 Possible griefing · ${playerName(alert.name)}`,
        ...staffPage(siteUrl),
        description: [steamLine(alert.steamId), reasons.join(' · ')].join('\n'),
        color: 0xe67e22,
        fields: [
          ...(latest.length === 0 ? [] : [{ name: 'Latest', value: latest.join('\n') }]),
          ...(steam === null || assess(steam, at).risk === 'low' ? [] : [{ name: 'Steam account', value: steamText(steam, at) }]),
        ],
        footer: { text: 'From the kill feed. Sides come from the last check, up to a minute old: check before acting.' },
        timestamp: new Date(at).toISOString(),
      },
    ],
    allowed_mentions: NO_PINGS,
  };
};

// Discord takes up to 10 embeds in one message.
const EMBEDS_PER_MESSAGE = 10;

// Players in game with a Steam account at the alert mark, one embed each, in as few messages as Discord allows.
export const buildSteamAlerts = (alerts: SteamAlert[], now: number, siteUrl?: string): DiscordMessage[] => {
  const embeds = alerts.map(
    ({ steamId, name, check }): Embed => ({
      title: `🕵️ Risky Steam account · ${playerName(name)}`,
      ...staffPage(siteUrl),
      description: [steamLine(steamId), `${riskLine(check, now)} · in game now`].join('\n'),
      color: COLORS.lowPop,
      fields: [{ name: 'Steam says', value: [...steamFacts(check, now), `Checked ${when(check.at, 'R')}`].join('\n') }],
      footer: { text: 'From Steam. A reason to look, not proof: check before acting.' },
      timestamp: new Date(now).toISOString(),
    }),
  );
  return Array.from({ length: Math.ceil(embeds.length / EMBEDS_PER_MESSAGE) }, (_, i) => ({
    embeds: embeds.slice(i * EMBEDS_PER_MESSAGE, (i + 1) * EMBEDS_PER_MESSAGE),
    allowed_mentions: NO_PINGS,
  }));
};

// "45 min", "1 h 10 min".
const lasted = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 60_000));
  if (total < 60) return `${total} min`;
  const rest = total % 60;
  return `${Math.floor(total / 60)} h${rest > 0 ? ` ${rest} min` : ''}`;
};

// A crash that left this many players or fewer is a crash, not a crowd leaving.
const CRASH_LEFT = 2;

// An outage confirmed (down) or over (back), for the moderation log channel (see outages.ts).
export const buildOutageAlert = (event: OutageEvent, siteUrl?: string): DiscordMessage => {
  const { outage } = event;
  const lowest = outage.lowest ?? 0;
  const mapChange = event.map !== null && outage.map !== '' && event.map !== outage.map;
  const where = outage.map === '' ? '' : ` on ${escapeMarkdown(mapName(outage.map))}`;
  const away = unreachableFor(outage, event.at);
  if (event.type === 'down') {
    const crash = outage.kind === 'crash';
    const title = !crash
      ? "🔴 Can't reach the server"
      : lowest <= CRASH_LEFT
        ? '🔴 Server crashed'
        : `📉 ${outage.before - lowest} players dropped at once`;
    const lines = crash
      ? [
          `**${outage.before} → ${lowest}** players${where}${mapChange ? ` at a map change (now ${escapeMarkdown(mapName(event.map ?? ''))})` : ''}, ${when(outage.at, 'R')}.`,
          event.players === null ? "The bot can't reach it now." : `**${event.players}** now.`,
        ]
      : [
          `The bot has not reached it for **${lasted(event.at - outage.at)}**. It had **${outage.before}** players${where}.`,
          "It may still be running with RCON down: check the host's panel before restarting it.",
        ];
    return {
      embeds: [
        {
          title,
          ...staffPage(siteUrl),
          description: lines.join('\n'),
          color: COLORS.lowPop,
          footer: { text: `From the bot's checks, every minute. It posts again when ${Math.ceil(outage.before * BACK_SHARE)} players are back.` },
          timestamp: new Date(outage.at).toISOString(),
        },
      ],
      allowed_mentions: NO_PINGS,
    };
  }
  const what = outage.kind === 'crash' ? 'it crashed' : 'the bot lost it';
  const facts = [
    `${outage.before} before`,
    ...(outage.kind === 'crash' && outage.lowest !== null ? [`lowest ${outage.lowest}`] : []),
    ...(away >= 60_000 ? [`unreachable for ${lasted(away)}`] : []),
  ];
  return {
    embeds: [
      {
        title: event.refilled
          ? `🟢 Server back to ${event.players} players`
          : `⚪ Server not back to ${Math.ceil(outage.before * BACK_SHARE)} players`,
        ...staffPage(siteUrl),
        description: [
          event.refilled
            ? `**${lasted(event.at - outage.at)}** after ${what}.`
            : `**${lasted(event.at - outage.at)}** after ${what}, it has **${event.players}**. The bot has stopped watching this one.`,
          facts.join(' · '),
        ].join('\n'),
        color: event.refilled ? COLORS.live : EMPTY_COLOR,
        timestamp: new Date(event.at).toISOString(),
      },
    ],
    allowed_mentions: NO_PINGS,
  };
};

// The chance of that many headshots by luck, as the staff page says it: "1 in 4,800", "1 in 2.3 million".
export const luckOdds = (chance: number): string => {
  const n = 1 / Math.max(chance, Number.MIN_VALUE);
  if (n >= 1e9) return 'under 1 in a billion';
  if (n >= 1e6) return `1 in ${Number((n / 1e6).toPrecision(2))} million`;
  return `1 in ${Number(n.toPrecision(2)).toLocaleString('en-GB')}`;
};

// A player in game passing the headshot flag today (see killfeed.ts). Red when it is not their first flagged day in the
// last 30, or their Steam account is high risk or worth a look; orange otherwise.
export const buildHeadshotAlert = (alert: HeadshotAlert, now: number, siteUrl?: string, steam: SteamCheck | null = null): DiscordMessage => {
  const risky = steam !== null && assess(steam, now).risk !== 'low';
  const again = alert.flaggedDays > 1;
  const usual = alert.expected === null ? '' : ` · about ${Math.round(alert.expected)} usual for their weapons`;
  return {
    embeds: [
      {
        title: `🎯 Unlikely headshots${again ? ' again' : ''} · ${playerName(alert.name)}`,
        ...staffPage(siteUrl),
        description: [
          steamLine(alert.steamId),
          `**${alert.headshots} headshots in ${alert.kills} kills** today${usual}`,
          `Chance by luck: **${luckOdds(alert.chance)}**${alert.weapon === null ? '' : ` · most kills with ${escapeMarkdown(alert.weapon)}`}`,
          again ? `Flagged on **${alert.flaggedDays} days** in the last 30` : 'Their first flagged day in the last 30',
        ].join('\n'),
        color: again || risky ? COLORS.lowPop : 0xe67e22,
        fields: risky && steam !== null ? [{ name: 'Steam account', value: steamText(steam, now) }] : [],
        footer: { text: 'From the kill feed. A reason to look, not proof: watch them play and check their kills first.' },
        timestamp: new Date(now).toISOString(),
      },
    ],
    allowed_mentions: NO_PINGS,
  };
};
