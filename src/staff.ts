import type { Config } from './config.ts';
import {
  andList,
  buildPlayerEmbed,
  buildRotationsEmbed,
  buildSavedRotationEmbed,
  factionBadge,
  factionKey,
  mapEmoji,
  mapName,
  playerName,
} from './discord.ts';
import type { Choice, CommandReply, CommandRequest } from './interactions.ts';
import { modesFor, planSetup, setupLabels, type SetupCatalog } from './matchsetup.ts';
import { BAN_LENGTHS, type BanRecord, type ModEntry } from './moderation.ts';
import type { PlayerTotals } from './players.ts';
import {
  endMatch,
  fetchBans,
  fetchConfig,
  fetchExperiences,
  fetchLightings,
  fetchMapExperiences,
  fetchMaps,
  fetchPlayers,
  fetchRotation,
  fetchStatus,
  fetchZones,
  kickPlayer,
  messagePlayer,
  queueMap,
  switchFaction,
  type HttpClient,
  type Player,
} from './rcon.ts';
import {
  DAY_CHOICES,
  DEFAULT_ROTATION,
  findRotation,
  plannedRotation,
  rotationDay,
  rotationEntries,
  rotationToday,
  WEEKDAYS,
  type RotationBook,
  type RotationEdit,
  type RotationEditResult,
  type RotationEntry,
  type RotationServer,
  type SavedRotation,
} from './rotations.ts';
import type { SteamLookup } from './steam.ts';
import { reservedIds, type VipGrant } from './vip.ts';

// Staff commands that act on players, maps and VIP. Players are picked from a list while typing, so the value
// Discord sends is usually a Steam ID; a name typed in full or in part also works when only one player matches.

export type Named = { steamId: string; name: string };

// How far back /player adds up a player's time and matches.
export const PROFILE_DAYS = 90;

// What the bot's records say about one player.
export type PlayerRecord = {
  // The name they used most recently, if the bot has seen them.
  name: string | null;
  totals: PlayerTotals | null;
  // VIP the bot gave (earned by seeding, or added by staff).
  vip: VipGrant | null;
  // Until when automatic VIP must not give them VIP, after staff took it away.
  vipBlockedUntil: number | null;
  log: ModEntry[];
  ban: BanRecord | null;
};

export type BanRequest = Named & { length: string; reason: string; by: string; byName?: string };
// `already-banned`: the player has a ban already, which stays as it is. `byBot` says whether the bot made it, and
// then `until` is when it ends. `waiting`: the server does not have the ban yet, as the player is not in game; the bot
// bans them when it next sees them.
export type BanResult = { outcome: 'banned' | 'already-banned'; until: number | null; byBot: boolean; waiting?: boolean };
export type VipAddResult = { outcome: 'added' | 'extended' | 'already-reserved'; until?: number };
export type VipRemoveResult = { outcome: 'removed' | 'not-reserved' };

// The records, and the actions that change the server's settings file (bans and the reserved list), which the
// Durable Object runs one at a time so they never overwrite each other or the automatic VIP update.
export type StaffRecords = {
  player: (steamId: string) => Promise<PlayerRecord>;
  // Players seen lately, given VIP or banned by the bot, to pick from when they are not online.
  knownPlayers: () => Promise<Named[]>;
  log: (steamId: string, entry: ModEntry) => Promise<void>;
  ban: (request: BanRequest) => Promise<BanResult>;
  unban: (target: Named, by: string, byName?: string) => Promise<boolean>;
  vipAdd: (request: Named & { days: number; by: string }) => Promise<VipAddResult>;
  vipRemove: (request: Named & { by: string }) => Promise<VipRemoveResult>;
  // Notes the map staff set to play next, for the live status: the rotation does not show it. `playing` is the map
  // the server was on when staff set it, or null when that could not be read.
  nextMap: (map: string, playing: string | null) => Promise<void>;
  // What Steam says about their account: the bot's check, made now when it has none or it is a day old.
  steam: (steamId: string) => Promise<SteamLookup>;
  // The saved map rotations, the week's plan, and the rotation on the server today (see rotations.ts).
  rotations: () => Promise<RotationBook>;
  // Changes them as staff asked (`by`, a Discord user ID, with the name they go by), and puts a rotation on the server
  // when the change calls for it.
  editRotations: (edit: RotationEdit, by: string, byName?: string) => Promise<RotationEditResult>;
};

export type StaffDeps = {
  config: () => Config;
  http: HttpClient;
  records: StaffRecords;
  now: () => number;
  log: { info: (message: string) => void };
};

export const STAFF_COMMANDS = ['warn', 'player', 'kick', 'switchteam', 'ban', 'unban', 'setnextmap', 'changemap', 'vip', 'rotations'] as const;
export type StaffCommand = (typeof STAFF_COMMANDS)[number];

export const isStaffCommand = (name: string): name is StaffCommand => STAFF_COMMANDS.some((command) => command === name);

export const VIP_MAX_DAYS = 365;
// The game's three teams. /switchteam only moves players to one of them: "🤠 Lonestar".
export const TEAMS = ['Lonestar', 'Manticore', 'Valkyra'] as const;
export const TEAM_CHOICES = TEAMS.map((team) => ({ name: `${factionBadge(team)}${team}`, value: team }));
// The game shows a private message on one line; "Staff warning: " takes the rest of its 200 characters.
// The game shows a private message on one line of up to 200 characters; the prefix and the rules note take the rest.
export const WARNING_MAX_LENGTH = 140;
const WARNING_PREFIX = 'Staff warning: ';

// Where players find the server rules, added to what staff send them: the rules are in the Discord.
const rulesNote = (siteUrl: string | undefined): string => {
  const host = (siteUrl ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  return host ? `Rules: our Discord at ${host}` : 'Rules are in our Discord';
};

// The reason given with the kick that comes with a ban.
export const banKickReason = (reason: string, siteUrl: string | undefined): string => `Banned: ${reason} | ${rulesNote(siteUrl)}`;

const STEAM_ID = /^\d{17}$/;

const unix = (at: number): number => Math.floor(at / 1000);

const who = (player: Named): string => `**${playerName(player.name)}**`;

// For the logs: JSON quoting keeps line breaks in names and messages from faking extra log lines.
const logged = (player: Named): string => `${JSON.stringify(player.name)} (${player.steamId})`;

// Online players first, so their current name wins, then everyone else once.
const merge = (...lists: Named[][]): Named[] => {
  const seen = new Set<string>();
  return lists.flat().filter((p) => !seen.has(p.steamId) && seen.add(p.steamId));
};

type Found = { player: Named } | { problem: string };

// A Steam ID, or a name that matches exactly one player: exactly, or else as part of their name.
export const findPlayer = (typed: string | undefined, candidates: Named[]): Found => {
  const text = (typed ?? '').trim();
  if (!text) return { problem: 'Pick a player from the list.' };
  if (STEAM_ID.test(text)) return { player: { steamId: text, name: candidates.find((p) => p.steamId === text)?.name ?? text } };
  const lower = text.toLowerCase();
  const exact = candidates.filter((p) => p.name.toLowerCase() === lower);
  const matches = exact.length > 0 ? exact : candidates.filter((p) => p.name.toLowerCase().includes(lower));
  const [only] = matches;
  if (matches.length === 1 && only) return { player: { steamId: only.steamId, name: only.name } };
  if (matches.length === 0) return { problem: `No player matches "${text}". Pick one from the list, or use their Steam ID.` };
  const some = matches.slice(0, 5).map((p) => `${playerName(p.name)} (\`${p.steamId}\`)`);
  return { problem: `More than one player matches "${text}": ${some.join(', ')}. Pick one from the list.` };
};

// Discord caps a choice's name at 100 characters.
const MAX_CHOICE_NAME = 100;
const MAX_CHOICES = 25;

const fit = (text: string): string => (text.length > MAX_CHOICE_NAME ? `${text.slice(0, MAX_CHOICE_NAME - 1)}…` : text);

const playerChoice = (player: Named & { faction?: string | undefined }): Choice => ({
  name: fit([player.name.slice(0, 60), ...(player.faction ? [player.faction] : []), player.steamId].join(' · ')),
  value: player.steamId,
});

const matching = <T extends Named>(players: T[], typed: string): T[] => {
  const lower = typed.trim().toLowerCase();
  return players.filter((p) => p.name.toLowerCase().includes(lower) || p.steamId.includes(lower));
};

type GameMap = { id: string; name: string };

// The name players know a map by, which RCON's catalogue may not use.
const mapLabel = (map: GameMap): string => (mapName(map.id) !== map.id ? mapName(map.id) : map.name);

const findMap = (typed: string | undefined, maps: GameMap[]): GameMap | null => {
  const lower = (typed ?? '').trim().toLowerCase();
  return maps.find((m) => [m.id, m.name, mapLabel(m)].some((name) => name.toLowerCase() === lower)) ?? null;
};

const namedIds = (ids: string[], known: Named[]): Named[] =>
  ids.map((steamId) => known.find((p) => p.steamId === steamId) ?? { steamId, name: steamId });

const optional = async <T>(work: Promise<T>): Promise<T | null> => work.catch(() => null);

// Null when the reserved list cannot be read safely, such as a settings file with the section twice.
const isReserved = (settings: string, steamId: string): boolean | null => {
  try {
    return reservedIds(settings).includes(steamId);
  } catch {
    return null;
  }
};

// A rotation's map in a line: "🟧 Bakurani · King of the Hill · Infantry only · Day, clear". `bold` names the map in bold,
// for Discord; a choice in a list shows no markdown.
const entryName = (entry: RotationEntry, catalog: Pick<SetupCatalog, 'experiences' | 'lightings' | 'zones'>, bold = false): string =>
  [`${mapEmoji(entry.map)}${bold ? `**${mapName(entry.map)}**` : mapName(entry.map)}`, ...setupLabels(entry, catalog)].join(' · ');

// The saved rotations to pick from. Where a new name starts a rotation, what has been typed is offered first as one.
const rotationChoices = (book: RotationBook, typed: string, subcommand: string | undefined): Choice[] => {
  const lower = typed.trim().toLowerCase();
  const saved = book.rotations
    .filter((r) => r.name.toLowerCase().includes(lower))
    .map((r) => ({ name: fit(`${r.name} · ${r.entries.length} map${r.entries.length === 1 ? '' : 's'}`), value: r.name }));
  const fresh = typed.trim() !== '' && (subcommand === 'add' || subcommand === 'save') && findRotation(book, typed) === null;
  return [...(fresh ? [{ name: fit(`New rotation: ${typed.trim()}`), value: typed.trim() }] : []), ...saved];
};

// What the server did with a rotation, for a reply.
const serverNote = (server: RotationServer | undefined, name: string): string => {
  if (server === undefined) return '';
  if ('reason' in server) return ` ⚠️ Couldn't put it on the server yet (${server.reason}). The bot tries again every minute.`;
  return server.outcome === 'updated' ? ` The server has **${name}** now, and plays it from the next map.` : ' The server already had these maps.';
};

// Each day's rotation, Monday first: its own, or Default.
const weekPlan = (book: RotationBook): (string | null)[] => WEEKDAYS.map((_, weekday) => plannedRotation(book, { day: '', weekday })?.name ?? null);

// The days a rotation plays on, by name.
const daysOf = (book: RotationBook, name: string): string[] =>
  WEEKDAYS.filter((_, i) => weekPlan(book)[i]?.toLowerCase() === name.toLowerCase());

// Choices offered while staff type in an option with autocomplete.
export const suggestStaff =
  ({ config, http, records }: Pick<StaffDeps, 'config' | 'http' | 'records'>) =>
  async ({ name, options, focused }: CommandRequest): Promise<Choice[]> => {
    const typed = options[focused ?? ''] ?? '';
    const { rconUrl, rconPassword } = config();
    const online = (): Promise<Player[]> => fetchPlayers(rconUrl, rconPassword, http);
    const players = async (offline: boolean): Promise<Choice[]> => {
      const [live, known] = await Promise.all([online().catch(() => []), offline ? records.knownPlayers() : []]);
      return matching(merge(live, known), typed).map((p) => playerChoice(live.find((l) => l.steamId === p.steamId) ?? p));
    };
    const choices = await (async (): Promise<Choice[]> => {
      if (name === 'rotations' && focused === 'rotation') return rotationChoices(await records.rotations(), typed, options['subcommand']);
      if (name === 'rotations' && options['subcommand'] === 'remove' && focused === 'map') {
        const rotation = findRotation(await records.rotations(), options['rotation'] ?? '');
        if (rotation === null) return [];
        const [experiences, lightings] = await Promise.all([
          optional(fetchExperiences(rconUrl, rconPassword, http)),
          optional(fetchLightings(rconUrl, rconPassword, http)),
        ]);
        const lower = typed.trim().toLowerCase();
        return rotation.entries
          .map((entry, i) => ({ name: fit(`${i + 1}. ${entryName(entry, { experiences, lightings, zones: null })}`), value: String(i + 1) }))
          .filter((c) => c.name.toLowerCase().includes(lower));
      }
      if (focused === 'player' && ['warn', 'kick', 'switchteam'].includes(name)) return players(false);
      if (focused === 'player' && ['player', 'ban'].includes(name)) return players(true);
      if (name === 'vip' && options['subcommand'] === 'add') return players(true);
      if (name === 'vip' && options['subcommand'] === 'remove') {
        const [serverConfig, live, known] = await Promise.all([fetchConfig(rconUrl, rconPassword, http), online().catch(() => []), records.knownPlayers()]);
        return matching(namedIds(reservedIds(serverConfig.text), merge(live, known)), typed).map(playerChoice);
      }
      if (name === 'unban') {
        const [bans, known] = await Promise.all([fetchBans(rconUrl, rconPassword, http), records.knownPlayers()]);
        return matching(namedIds(bans.map((b) => b.steamId), known), typed).map(playerChoice);
      }
      const lower = typed.trim().toLowerCase();
      const named = (items: { id: string; name: string }[]): Choice[] =>
        items
          .filter((i) => i.id.toLowerCase().includes(lower) || i.name.toLowerCase().includes(lower))
          .map((i) => ({ name: fit(i.name), value: i.id }));
      if (focused === 'map') {
        return (await fetchMaps(rconUrl, rconPassword, http))
          .filter((m) => [m.id, m.name, mapLabel(m)].some((label) => label.toLowerCase().includes(lower)))
          .map((m) => ({ name: fit(`${mapEmoji(m.id)}${mapLabel(m)}`), value: m.id }));
      }
      if (focused === 'lighting') return named(await fetchLightings(rconUrl, rconPassword, http));
      // Modes and zone layouts depend on the map, so they are listed once one is picked.
      const map = options['map'] ?? '';
      if (!/^[A-Za-z0-9_]+$/.test(map)) return [];
      if (focused === 'mode') {
        const [mapExperiences, experiences] = await Promise.all([
          fetchMapExperiences(rconUrl, rconPassword, map, http),
          optional(fetchExperiences(rconUrl, rconPassword, http)),
        ]);
        return named(modesFor({ mapExperiences, experiences }));
      }
      if (focused === 'zones') return named(await fetchZones(rconUrl, rconPassword, map, http));
      return [];
    })();
    return choices.slice(0, MAX_CHOICES);
  };

const lengthOf = (value: string | undefined) => BAN_LENGTHS.find((l) => l.value === value) ?? null;

export const runStaffCommand =
  ({ config, http, records, now, log }: StaffDeps) =>
  async (name: StaffCommand, { options, userId, userName }: CommandRequest): Promise<CommandReply> => {
    const { rconUrl, rconPassword, siteUrl } = config();
    const rules = rulesNote(siteUrl);
    const by = userId ?? 'unknown';
    // For the moderation log: who did it, by the name they go by in the server.
    const named = userName === undefined ? {} : { byName: userName };
    const staff = `Discord user ${by}`;
    const online = (): Promise<Player[]> => fetchPlayers(rconUrl, rconPassword, http);
    const text = (key: string): string => (options[key] ?? '').trim();

    // Warnings, kicks and team moves only work on someone in game.
    const onlineTarget = async (): Promise<{ player: Named; online: Player } | { problem: string }> => {
      const live = await online();
      const found = findPlayer(options['player'], live);
      if ('problem' in found) return found;
      const player = live.find((p) => p.steamId === found.player.steamId);
      return player ? { player: found.player, online: player } : { problem: `${who(found.player)} isn't on the server.` };
    };
    // Anyone the bot knows of, or any Steam ID.
    const anyTarget = async (key: string): Promise<{ found: Found; live: Player[] }> => {
      const [live, known] = await Promise.all([online().catch((): Player[] => []), records.knownPlayers()]);
      return { found: findPlayer(options[key], merge(live, known)), live };
    };

    if (name === 'warn') {
      const message = text('message');
      if (!message) return { content: 'Write the warning to send.' };
      const target = await onlineTarget();
      if ('problem' in target) return { content: target.problem };
      const { player } = target;
      log.info(`/warn by ${staff} to ${logged(player)}: ${JSON.stringify(message)}`);
      await messagePlayer(rconUrl, rconPassword, player.steamId, `${WARNING_PREFIX}${message} | ${rules}`, http);
      await records.log(player.steamId, { action: 'warn', at: now(), by, ...named, name: player.name, reason: message });
      return { content: `⚠️ Warned ${who(player)} in game: ${message}` };
    }

    if (name === 'kick') {
      const reason = text('reason');
      if (!reason) return { content: 'A kick needs a reason.' };
      const target = await onlineTarget();
      if ('problem' in target) return { content: target.problem };
      const { player } = target;
      log.info(`/kick by ${staff}: ${logged(player)}: ${JSON.stringify(reason)}`);
      await kickPlayer(rconUrl, rconPassword, player.steamId, `${reason} | ${rules}`, http);
      await records.log(player.steamId, { action: 'kick', at: now(), by, ...named, name: player.name, reason });
      return { content: `👢 Kicked ${who(player)}: ${reason}` };
    }

    if (name === 'switchteam') {
      const [target, status] = await Promise.all([onlineTarget(), fetchStatus(rconUrl, rconPassword, http)]);
      if ('problem' in target) return { content: target.problem };
      const { player } = target;
      const current = target.online.faction;
      const teams = status.factionScores.map((f) => f.name);
      const same = (a: string, b: string | null | undefined): boolean => b != null && factionKey(a) === factionKey(b);
      const others = teams.filter((team) => !same(team, current));
      const asked = text('team');
      const known = TEAMS.find((t) => same(t, asked));
      if (asked && known === undefined) return { content: `Pick ${TEAMS.slice(0, -1).join(', ')} or ${TEAMS.at(-1)}.` };
      // The server's own name for the team, or the one picked when the server does not say which teams are playing.
      const team = known
        ? (teams.find((t) => same(t, known)) ?? (teams.length === 0 ? known : null))
        : current && others.length === 1
          ? (others[0] ?? null)
          : null;
      if (team === null) {
        return { content: known ? `${known} is not in this match. Teams now: ${teams.join(', ')}.` : `Pick a team: ${teams.join(', ') || 'none found'}.` };
      }
      if (same(team, current)) return { content: `${who(player)} is already on ${team}.` };
      log.info(`/switchteam by ${staff}: ${logged(player)} from ${current ?? 'unknown'} to ${team}`);
      await switchFaction(rconUrl, rconPassword, player.steamId, team, http);
      await records.log(player.steamId, {
        action: 'switchteam',
        at: now(),
        by,
        ...named,
        name: player.name,
        detail: current ? `${current} to ${team}` : `to ${team}`,
      });
      return { content: `🔀 Moved ${who(player)} to ${factionBadge(team)}**${team}**. They respawn on the new side.` };
    }

    if (name === 'ban') {
      const reason = text('reason');
      const length = lengthOf(options['duration']);
      if (!reason) return { content: 'A ban needs a reason.' };
      if (length === null) return { content: 'Pick how long the ban lasts from the list.' };
      const { found, live } = await anyTarget('player');
      if ('problem' in found) return { content: found.problem };
      const { player } = found;
      log.info(`/ban by ${staff}: ${logged(player)} for ${length.name}: ${JSON.stringify(reason)}`);
      const result = await records.ban({ ...player, length: length.value, reason, by, ...named });
      const joining = 'the bot bans and kicks them within a minute of them joining';
      if (result.outcome === 'already-banned') {
        const current = !result.byBot
          ? ', not by the bot'
          : result.until === null
            ? ' permanently'
            : ` until <t:${unix(result.until)}:f>`;
        const pending = result.waiting ? ` ⏳ They haven't joined since, so ${joining}.` : '';
        return { content: `${who(player)} is already banned${current}.${pending} Use /unban first to change the ban.` };
      }
      const span = result.until === null ? 'permanently' : `for ${length.name}, until <t:${unix(result.until)}:f>`;
      if (result.waiting) {
        return {
          content: `🔨 Banned ${who(player)} ${span}. Reason: ${reason}\n⏳ They aren't in game, and the game only bans players who are, so ${joining}.`,
        };
      }
      // The ban keeps them out from now on; a kick removes them if they are in game.
      const kicked = live.some((p) => p.steamId === player.steamId)
        ? await kickPlayer(rconUrl, rconPassword, player.steamId, banKickReason(reason, siteUrl), http).then(
            () => ' and kicked them',
            () => ", but couldn't kick them. Use /kick",
          )
        : '';
      return { content: `🔨 Banned ${who(player)} ${span}${kicked}. Reason: ${reason}` };
    }

    if (name === 'unban') {
      const { found } = await anyTarget('steam_id');
      if ('problem' in found) return { content: found.problem };
      const { player } = found;
      log.info(`/unban by ${staff}: ${logged(player)}`);
      return (await records.unban(player, by, userName))
        ? { content: `✅ Unbanned ${who(player)}. They can join again.` }
        : { content: `${who(player)} isn't banned.` };
    }

    if (name === 'setnextmap' || name === 'changemap') {
      const [maps, rotation, experiences, lightings, status] = await Promise.all([
        fetchMaps(rconUrl, rconPassword, http),
        optional(fetchRotation(rconUrl, rconPassword, http)),
        optional(fetchExperiences(rconUrl, rconPassword, http)),
        optional(fetchLightings(rconUrl, rconPassword, http)),
        optional(fetchStatus(rconUrl, rconPassword, http)),
      ]);
      const map = findMap(options['map'], maps);
      if (map === null) return { content: 'Pick a map from the list.' };
      const [mapExperiences, zones] = await Promise.all([
        optional(fetchMapExperiences(rconUrl, rconPassword, map.id, http)),
        optional(fetchZones(rconUrl, rconPassword, map.id, http)),
      ]);
      const planned = planSetup(map.id, options, { rotation, mapExperiences, experiences, lightings, zones });
      if ('problem' in planned) return { content: planned.problem };
      const { setup, labels } = planned;
      log.info(`/${name} by ${staff}: ${map.id} ${JSON.stringify(setup)}`);
      await queueMap(rconUrl, rconPassword, map.id, http, setup);
      // Read now: the bot's own reading can be up to a minute old, from before a map change.
      const playing = status?.map || rotation?.entries.find((e) => e.status === 'now')?.map || null;
      // The map is staged on the server either way; only the live status would miss it.
      await records.nextMap(map.id, playing).catch((error: unknown) => log.info(`Next map not noted for the live status: ${String(error)}`));
      const described = [`${mapEmoji(map.id)}**${mapLabel(map)}**`, ...labels].join(' · ');
      if (name === 'setnextmap') {
        return { content: `🗺️ Next map: ${described}. The server goes there when this match ends; the rotation is unchanged.` };
      }
      await endMatch(rconUrl, rconPassword, http);
      return { content: `🗺️ Ended the match. The server moves to ${described} after the end screen.` };
    }

    if (name === 'rotations') return runRotations({ config, http, records, now, log }, options, by, userName);

    if (name === 'vip') {
      const { found } = await anyTarget('steam_id');
      if ('problem' in found) return { content: found.problem };
      const { player } = found;
      if (options['subcommand'] === 'remove') {
        log.info(`/vip remove by ${staff}: ${logged(player)}`);
        const { outcome } = await records.vipRemove({ ...player, by });
        const blocked = 'Automatic VIP will not give it back for 7 days.';
        return outcome === 'removed'
          ? { content: `🎖️ Took ${who(player)} off the reserved list. It takes effect after the server's next restart. ${blocked}` }
          : { content: `${who(player)} wasn't on the reserved list. ${blocked}` };
      }
      const days = Math.trunc(Number(options['days']));
      if (!Number.isFinite(days) || days < 1 || days > VIP_MAX_DAYS) return { content: `Give VIP for 1 to ${VIP_MAX_DAYS} days.` };
      log.info(`/vip add by ${staff}: ${logged(player)} for ${days} days`);
      const result = await records.vipAdd({ ...player, days, by });
      if (result.outcome === 'already-reserved') {
        return { content: `${who(player)} already has a reserved slot that was added by hand, with no end date. Nothing changed.` };
      }
      const until = result.until === undefined ? '' : ` until <t:${unix(result.until)}:f>`;
      return result.outcome === 'extended'
        ? { content: `🎖️ ${who(player)} keeps their reserved slot${until}.` }
        : { content: `🎖️ Gave ${who(player)} a reserved slot${until}. It starts after the server's next restart.` };
    }

    // /player: what the bot knows, and what the server says now. The server's parts are left out if it cannot be read.
    const { found, live } = await anyTarget('player');
    if ('problem' in found) return { content: found.problem };
    const { player } = found;
    const [record, serverConfig, bans, steam] = await Promise.all([
      records.player(player.steamId),
      optional(fetchConfig(rconUrl, rconPassword, http)),
      optional(fetchBans(rconUrl, rconPassword, http)),
      records.steam(player.steamId).catch((): SteamLookup => 'failed'),
    ]);
    const inGame = live.find((p) => p.steamId === player.steamId) ?? null;
    return {
      embeds: [
        buildPlayerEmbed({
          steamId: player.steamId,
          name: inGame?.name ?? record.name ?? (player.name === player.steamId ? null : player.name),
          record,
          online: inGame,
          reserved: serverConfig === null ? null : isReserved(serverConfig.text, player.steamId),
          serverBan: bans === null ? undefined : (bans.find((b) => b.steamId === player.steamId) ?? null),
          steam,
          days: PROFILE_DAYS,
          now: now(),
        }),
      ],
    };
  };

// /rotations: saved map rotations, the week's plan, and swapping the server's rotation (see rotations.ts).
const runRotations = async (
  { config, http, records, now, log }: StaffDeps,
  options: Record<string, string>,
  by: string,
  byName: string | undefined,
): Promise<CommandReply> => {
  const { rconUrl, rconPassword, rotationHour } = config();
  const staff = `Discord user ${by}`;
  const sub = options['subcommand'] ?? 'show';
  const typed = (options['rotation'] ?? '').trim();
  const edit = async (change: RotationEdit): Promise<RotationEditResult> => {
    log.info(`/rotations ${sub} by ${staff}: ${JSON.stringify(change)}`);
    return records.editRotations(change, by, byName);
  };
  // Names for modes and lighting, and for the zones of each map, when the server gives them.
  const catalogFor = async (entries: RotationEntry[]): Promise<Pick<SetupCatalog, 'experiences' | 'lightings' | 'zones'>> => {
    const maps = [...new Set(entries.flatMap((e) => (e.zoneAlternator ? [e.map] : [])))];
    const [experiences, lightings, zones] = await Promise.all([
      optional(fetchExperiences(rconUrl, rconPassword, http)),
      optional(fetchLightings(rconUrl, rconPassword, http)),
      Promise.all(maps.map((map) => optional(fetchZones(rconUrl, rconPassword, map, http)))),
    ]);
    return { experiences, lightings, zones: zones.flatMap((z) => z ?? []) };
  };

  if (sub === 'show') {
    const book = await records.rotations();
    const today = rotationDay(now(), rotationHour);
    const current = rotationToday(book, today);
    if (typed) {
      const rotation = findRotation(book, typed);
      if (rotation === null) return { content: `There's no rotation called "${typed}". Pick one from the list.` };
      const catalog = await catalogFor(rotation.entries);
      return {
        embeds: [
          buildSavedRotationEmbed({
            name: rotation.name,
            lines: rotation.entries.map((entry) => entryName(entry, catalog, true)),
            days: daysOf(book, rotation.name),
            onToday: current !== null && current.name.toLowerCase() === rotation.name.toLowerCase(),
          }),
        ],
      };
    }
    return {
      embeds: [
        buildRotationsEmbed({
          rotations: book.rotations.map((r) => ({ name: r.name, maps: r.entries.map((e) => mapName(e.map)) })),
          week: weekPlan(book),
          weekday: today.weekday,
          today: current,
          hour: rotationHour,
        }),
      ],
    };
  }

  if (sub === 'add') {
    const [maps, experiences, lightings] = await Promise.all([
      fetchMaps(rconUrl, rconPassword, http),
      optional(fetchExperiences(rconUrl, rconPassword, http)),
      optional(fetchLightings(rconUrl, rconPassword, http)),
    ]);
    const map = findMap(options['map'], maps);
    if (map === null) return { content: 'Pick a map from the list.' };
    const [mapExperiences, zones] = await Promise.all([
      optional(fetchMapExperiences(rconUrl, rconPassword, map.id, http)),
      optional(fetchZones(rconUrl, rconPassword, map.id, http)),
    ]);
    // Not from the server's rotation: what staff leave out is the map's own.
    const planned = planSetup(map.id, options, { rotation: null, mapExperiences, experiences, lightings, zones });
    if ('problem' in planned) return { content: planned.problem };
    const position = options['position'] === undefined ? undefined : Number(options['position']);
    const entry: RotationEntry = { map: map.id, ...planned.setup };
    const result = await edit({ kind: 'add', name: typed, entry, ...(position === undefined ? {} : { position }) });
    if ('problem' in result) return { content: result.problem };
    const rotation = result.rotation as SavedRotation;
    const at = position === undefined ? rotation.entries.length : Math.min(Math.max(1, position), rotation.entries.length);
    const described = [`${mapEmoji(map.id)}**${mapLabel(map)}**`, ...planned.labels].join(' · ');
    return {
      content:
        `➕ Added ${described} to **${rotation.name}**, number ${at} of ${rotation.entries.length}.` +
        serverNote(result.server, rotation.name),
    };
  }

  if (sub === 'remove') {
    const book = await records.rotations();
    const rotation = findRotation(book, typed);
    if (rotation === null) return { content: `There's no rotation called "${typed}". Pick one from the list.` };
    const picked = (options['map'] ?? '').trim();
    // A number from the list, or a map's name when it is in the rotation once.
    const byName = rotation.entries.flatMap((e, i) => ([e.map, mapName(e.map)].some((n) => n.toLowerCase() === picked.toLowerCase()) ? [i + 1] : []));
    const position = /^\d+$/.test(picked) ? Number(picked) : byName.length === 1 ? (byName[0] ?? 0) : 0;
    if (position === 0 && byName.length > 1) return { content: `**${rotation.name}** has ${mapName(picked)} more than once. Pick the one to take out from the list.` };
    const removed = rotation.entries[position - 1];
    const result = await edit({ kind: 'remove', name: rotation.name, position });
    if ('problem' in result) return { content: result.problem };
    const left = result.rotation?.entries.length ?? 0;
    const catalog = removed === undefined ? null : await catalogFor([removed]);
    const what = removed === undefined || catalog === null ? 'the map' : entryName(removed, catalog, true);
    const empty = left === 0 ? ' It has no maps left, so it is not put on the server; the server keeps the maps it has.' : '';
    return {
      content: `➖ Took ${what} out of **${rotation.name}** (${left} map${left === 1 ? '' : 's'} left).${empty}` + serverNote(result.server, rotation.name),
    };
  }

  if (sub === 'save') {
    const entries = rotationEntries(await fetchRotation(rconUrl, rconPassword, http));
    const replaced = findRotation(await records.rotations(), typed) !== null;
    const result = await edit({ kind: 'save', name: typed, entries });
    if ('problem' in result) return { content: result.problem };
    const name = result.rotation?.name ?? typed;
    return {
      content:
        `💾 Saved the server's rotation as **${name}** (${entries.length} map${entries.length === 1 ? '' : 's'})` +
        `${replaced ? ', in place of the one saved before' : ''}.` +
        serverNote(result.server, name),
    };
  }

  if (sub === 'delete') {
    const before = await records.rotations();
    const rotation = findRotation(before, typed);
    const result = await edit({ kind: 'delete', name: typed });
    if ('problem' in result) return { content: result.problem };
    const days = rotation === null ? [] : daysOf(before, rotation.name);
    const fallback = findRotation(result.book, DEFAULT_ROTATION)?.name;
    const back = fallback ? `go back to **${fallback}**` : 'keep whatever the server has';
    const cleared = days.length > 0 ? ` ${andList(days)} ${back}.` : '';
    return { content: `🗑️ Deleted **${rotation?.name ?? typed}**.${cleared}` + serverNote(result.server, result.book.applied?.name ?? '') };
  }

  if (sub === 'use') {
    const result = await edit({ kind: 'use', name: typed });
    if ('problem' in result) return { content: result.problem };
    const name = result.rotation?.name ?? typed;
    const today = rotationDay(now(), rotationHour);
    const tomorrow = weekPlan(result.book)[(today.weekday + 1) % WEEKDAYS.length];
    const next = Math.floor(Date.UTC(...dayParts(today.day, 1), rotationHour) / 1000);
    return {
      content:
        `🗺️ Swapped to **${name}** for today.` +
        serverNote(result.server, name) +
        (tomorrow ? ` Tomorrow's rotation, **${tomorrow}**, goes on <t:${next}:f>.` : ''),
    };
  }

  // schedule
  const choice = DAY_CHOICES.find((c) => c.value === options['day']);
  if (choice === undefined) return { content: 'Pick the day from the list.' };
  const result = await edit({ kind: 'schedule', days: choice.days, name: typed || null });
  if ('problem' in result) return { content: result.problem };
  const days = choice.days.map((d) => WEEKDAYS[d] ?? '');
  const today = rotationDay(now(), rotationHour);
  const when = choice.days.length === 1 ? `${days[0]}s` : choice.value === 'every-day' ? 'Every day' : andList(days);
  const planned = weekPlan(result.book)[choice.days[0] ?? 0];
  if (!planned) return { content: `📅 ${when}: no rotation, so the server keeps whatever it has.` };
  const goesOn = choice.days.includes(today.weekday) ? ` It's ${WEEKDAYS[today.weekday]}, so it goes on today.` : '';
  return { content: `📅 ${when}: **${planned}**.${goesOn}` + serverNote(result.server, planned) };
};

// A day as UTC year, month (from 0) and day, `ahead` days on.
const dayParts = (day: string, ahead: number): [number, number, number] => {
  const date = new Date(Date.parse(`${day}T00:00:00Z`) + ahead * 24 * 60 * 60_000);
  return [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()];
};
