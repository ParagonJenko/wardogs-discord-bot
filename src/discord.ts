import { phaseFor, type AlertKind, type AlertRules, type Phase } from './alerts.ts';
import type { VipRule } from './config.ts';
import type { FactionScore, Player, Rotation, ServerStatus } from './rcon.ts';
import type { RecentMatch } from './stats.ts';
import type { MatchSummary } from './tracking.ts';

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
};

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

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

const kd = (kills: number, deaths: number): string => (kills / Math.max(deaths, 1)).toFixed(2);

const COLORS: Record<AlertKind, number> = {
  seeding: 0xf1c40f,
  live: 0x2ecc71,
  lowPop: 0xe74c3c,
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
const BAR_FILL: Record<Phase | AlertKind, string> = { live: '🟩', seeding: '🟨', lowPop: '🟥', empty: '⬜' };

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

// One line per faction, highest first, the leader in bold: 🔵 **Valkyra 100**
const scoreLines = (scores: FactionScore[]): string =>
  byScore(scores)
    .map((s, i) => {
      const text = `${escapeMarkdown(s.name)} ${s.score}`;
      return `${dot(s.colorHex)}${i === 0 ? `**${text}**` : text}`;
    })
    .join('\n');

// A footer pointing at the website, and the title linking to it, when SITE_URL is set.
const site = (siteUrl: string | undefined): Pick<Embed, 'url' | 'footer'> => {
  if (!siteUrl) return {};
  const host = siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return { url: siteUrl, footer: { text: `Live stats and leaderboard: ${host}` } };
};

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

// What seeding earns: "Seed on 3 days in a week and get a reserved slot for a week."
export const vipOffer = (vip: VipRule): string =>
  `Seed on ${plural(vip.seedDays, 'day')} in ${span(vip.windowDays)} and get a reserved slot for ${span(vip.lengthDays)}.`;

// What counts as a seed.
export const vipRule = (vip: VipRule): string =>
  `A seed counts when you're on for more than ${vip.seedMinutes} min and the server goes live.`;

const needed = (kind: AlertKind, server: Population, options: MessageOptions): EmbedField[] => {
  if (kind === 'seeding' && options.live !== undefined) {
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
    ...(server.map ? [{ name: 'Map', value: mapName(server.map), inline: true }] : []),
    ...needed(kind, server, options),
    ...(seeders.length > 0 ? [{ name: 'Top seeders', value: ranked(seeders) }] : []),
    ...(kind === 'seeding' && options.vip
      ? [{ name: '🎖️ Seeder VIP', value: `${vipOffer(options.vip)}\n${vipRule(options.vip)}` }]
      : []),
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

const minutes = (ms: number): string => `${Math.round(ms / 60_000)} min`;

const headline = (scores: FactionScore[]): string | null => {
  const [first, second] = byScore(scores);
  if (!first || !second) return null;
  return first.score === second.score ? '🤝 **Draw**' : `🏆 **${escapeMarkdown(first.name)}** won`;
};

// The embed takes the winning faction's colour.
const winnerColour = (scores: FactionScore[]): number => {
  const [first, second] = byScore(scores);
  if (!first || !second || first.score === second.score) return INFO_COLOR;
  // Black (#000000) is 0, so only a missing colour falls back.
  return colourOf(first.colorHex) ?? INFO_COLOR;
};

export const buildMatchSummary = (summary: MatchSummary, serverName: string, siteUrl?: string): DiscordMessage => {
  const top = summary.top.map(
    (p) => `**${playerName(p.name)}** · ${plural(p.kills, 'kill')} · ${plural(p.deaths, 'death')} · ${kd(p.kills, p.deaths)} K/D`,
  );
  const fields: EmbedField[] = [
    ...(summary.factionScores.length > 0 ? [{ name: 'Score', value: scoreLines(summary.factionScores), inline: true }] : []),
    { name: 'Length', value: minutes(summary.durationMs), inline: true },
    { name: 'Peak', value: plural(summary.peakPlayers, 'player'), inline: true },
    ...(top.length > 0 ? [{ name: 'Top players', value: ranked(top) }] : []),
  ];
  const linked = site(siteUrl);
  const description = headline(summary.factionScores);
  return {
    embeds: [
      {
        title: `🏁 Match over · ${mapName(summary.map) || 'unknown map'}`,
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

export const buildStatusEmbed = (status: ServerStatus, rules: AlertRules, siteUrl?: string): Embed => {
  const phase = phaseFor(status.players, rules);
  const toGo = phase === 'seeding' ? ` · ${Math.max(0, rules.live - status.players)} more to go live` : '';
  return {
    title: shorten(status.name),
    description: `${PHASE_LABELS[phase].label}${toGo}`,
    color: PHASE_LABELS[phase].color,
    fields: [
      { name: 'Players', value: population(status.players, status.maxPlayers, phase) },
      ...(status.map ? [{ name: 'Map', value: mapName(status.map), inline: true }] : []),
      ...(status.factionScores.length > 0 ? [{ name: 'Score', value: scoreLines(status.factionScores), inline: true }] : []),
    ],
    ...site(siteUrl),
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
    .map((p) => `**${playerName(p.name)}** · ${tally(p.kills, 'kill')} · ${tally(p.deaths, 'death')}`);
  const hidden = sorted.length - MAX_PLAYERS_LISTED;
  return {
    title: `👥 ${plural(players.length, 'player')} online`,
    description: ranked(lines),
    color: INFO_COLOR,
    footer: { text: hidden > 0 ? `Most kills first · ${hidden} more not shown` : 'Most kills first' },
  };
};

const ROTATION_SHOWN = 5;

const rotationLine = (entry: Rotation['entries'][number]): string => {
  const name = mapName(entry.map);
  if (entry.status === 'now') return `▶️ **${name}** · now`;
  if (entry.status === 'next') return `⏭️ **${name}** · next`;
  return `▫️ ${name}`;
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
  return { title, description: lines.join('\n'), color: INFO_COLOR, ...(note ? { footer: { text: note } } : {}) };
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

export const buildLastMatchEmbed = (match: RecentMatch, siteUrl?: string): Embed => {
  const [summary] = buildMatchSummary(match, '', siteUrl).embeds;
  const ended = `Ended <t:${Math.floor(match.endedAt / 1000)}:R>`;
  return summary
    ? {
        ...summary,
        title: `🏁 Last match · ${mapName(match.map) || 'unknown map'}`,
        description: [summary.description, ended].filter(Boolean).join(' · '),
        timestamp: new Date(match.endedAt).toISOString(),
      }
    : { title: '🏁 Last match', description: ended, color: INFO_COLOR };
};
