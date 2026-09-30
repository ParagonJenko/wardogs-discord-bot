import type { Config } from './config.ts';
import { buildPlayerEmbed, factionBadge, mapName, playerName } from './discord.ts';
import type { Choice, CommandReply, CommandRequest } from './interactions.ts';
import { modesFor, planSetup } from './matchsetup.ts';
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

export type BanRequest = Named & { length: string; reason: string; by: string };
// `already-banned`: the player has a ban already, which stays as it is. `byBot` says whether the bot made it, and
// then `until` is when it ends.
export type BanResult = { outcome: 'banned' | 'already-banned'; until: number | null; byBot: boolean };
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
  unban: (target: Named, by: string) => Promise<boolean>;
  vipAdd: (request: Named & { days: number; by: string }) => Promise<VipAddResult>;
  vipRemove: (request: Named & { by: string }) => Promise<VipRemoveResult>;
};

export type StaffDeps = {
  config: () => Config;
  http: HttpClient;
  records: StaffRecords;
  now: () => number;
  log: { info: (message: string) => void };
};

export const STAFF_COMMANDS = ['warn', 'player', 'kick', 'switchteam', 'ban', 'unban', 'setnextmap', 'changemap', 'vip'] as const;
export type StaffCommand = (typeof STAFF_COMMANDS)[number];

export const isStaffCommand = (name: string): name is StaffCommand => STAFF_COMMANDS.some((command) => command === name);

export const VIP_MAX_DAYS = 365;
// The game shows a private message on one line; "Staff warning: " takes the rest of its 200 characters.
// The game shows a private message on one line of up to 200 characters; the prefix and the rules note take the rest.
export const WARNING_MAX_LENGTH = 140;
const WARNING_PREFIX = 'Staff warning: ';

// Where players find the server rules, added to what staff send them: the rules are in the Discord.
const rulesNote = (siteUrl: string | undefined): string => {
  const host = (siteUrl ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  return host ? `Rules: our Discord at ${host}` : 'Rules are in our Discord';
};

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
      if (name === 'switchteam' && focused === 'team') {
        const [status, live] = await Promise.all([fetchStatus(rconUrl, rconPassword, http), online().catch(() => [])]);
        // The player being moved is already on their own team, so it is left out.
        const current = live.find((p) => p.steamId === options['player'])?.faction;
        const lower = typed.trim().toLowerCase();
        return status.factionScores
          .filter((f) => f.name !== current && f.name.toLowerCase().includes(lower))
          .map((f) => {
            const count = live.filter((p) => p.faction === f.name).length;
            return {
              name: fit(`${factionBadge(f.name, f.colorHex)}${f.name} · ${count} player${count === 1 ? '' : 's'} · ${f.score} points`),
              value: f.name,
            };
          });
      }
      const lower = typed.trim().toLowerCase();
      const named = (items: { id: string; name: string }[]): Choice[] =>
        items
          .filter((i) => i.id.toLowerCase().includes(lower) || i.name.toLowerCase().includes(lower))
          .map((i) => ({ name: fit(i.name), value: i.id }));
      if (focused === 'map') {
        return (await fetchMaps(rconUrl, rconPassword, http))
          .filter((m) => [m.id, m.name, mapLabel(m)].some((label) => label.toLowerCase().includes(lower)))
          .map((m) => ({ name: fit(mapLabel(m)), value: m.id }));
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
  async (name: StaffCommand, { options, userId }: CommandRequest): Promise<CommandReply> => {
    const { rconUrl, rconPassword, siteUrl } = config();
    const rules = rulesNote(siteUrl);
    const by = userId ?? 'unknown';
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
      await records.log(player.steamId, { action: 'warn', at: now(), by, name: player.name, reason: message });
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
      await records.log(player.steamId, { action: 'kick', at: now(), by, name: player.name, reason });
      return { content: `👢 Kicked ${who(player)}: ${reason}` };
    }

    if (name === 'switchteam') {
      const [target, status] = await Promise.all([onlineTarget(), fetchStatus(rconUrl, rconPassword, http)]);
      if ('problem' in target) return { content: target.problem };
      const { player } = target;
      const current = target.online.faction;
      const teams = status.factionScores.map((f) => f.name);
      const others = teams.filter((team) => team !== current);
      const asked = text('team');
      const team = asked
        ? (teams.find((t) => t.toLowerCase() === asked.toLowerCase()) ?? (teams.length === 0 ? asked : null))
        : current && others.length === 1
          ? (others[0] ?? null)
          : null;
      if (team === null) {
        return { content: asked ? `No team called "${asked}". Teams now: ${teams.join(', ')}.` : `Pick a team: ${teams.join(', ') || 'none found'}.` };
      }
      if (team === current) return { content: `${who(player)} is already on ${team}.` };
      log.info(`/switchteam by ${staff}: ${logged(player)} from ${current ?? 'unknown'} to ${team}`);
      await switchFaction(rconUrl, rconPassword, player.steamId, team, http);
      await records.log(player.steamId, {
        action: 'switchteam',
        at: now(),
        by,
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
      const result = await records.ban({ ...player, length: length.value, reason, by });
      if (result.outcome === 'already-banned') {
        const current = !result.byBot
          ? ', not by the bot'
          : result.until === null
            ? ' permanently'
            : ` until <t:${unix(result.until)}:f>`;
        return { content: `${who(player)} is already banned${current}. Use /unban first to change the ban.` };
      }
      // The ban keeps them out from now on; a kick removes them if they are in game.
      const kicked = live.some((p) => p.steamId === player.steamId)
        ? await kickPlayer(rconUrl, rconPassword, player.steamId, `Banned: ${reason} | ${rules}`, http).then(
            () => ' and kicked them',
            () => ", but couldn't kick them. Use /kick",
          )
        : '';
      const span = result.until === null ? 'permanently' : `for ${length.name}, until <t:${unix(result.until)}:f>`;
      return { content: `🔨 Banned ${who(player)} ${span}${kicked}. Reason: ${reason}` };
    }

    if (name === 'unban') {
      const { found } = await anyTarget('steam_id');
      if ('problem' in found) return { content: found.problem };
      const { player } = found;
      log.info(`/unban by ${staff}: ${logged(player)}`);
      return (await records.unban(player, by))
        ? { content: `✅ Unbanned ${who(player)}. They can join again.` }
        : { content: `${who(player)} isn't banned.` };
    }

    if (name === 'setnextmap' || name === 'changemap') {
      const [maps, rotation, experiences, lightings] = await Promise.all([
        fetchMaps(rconUrl, rconPassword, http),
        optional(fetchRotation(rconUrl, rconPassword, http)),
        optional(fetchExperiences(rconUrl, rconPassword, http)),
        optional(fetchLightings(rconUrl, rconPassword, http)),
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
      const described = [`**${mapLabel(map)}**`, ...labels].join(' · ');
      if (name === 'setnextmap') {
        return { content: `🗺️ Next map: ${described}. The server goes there when this match ends; the rotation is unchanged.` };
      }
      await endMatch(rconUrl, rconPassword, http);
      return { content: `🗺️ Ended the match. The server moves to ${described} after the end screen.` };
    }

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
    const [record, serverConfig, bans] = await Promise.all([
      records.player(player.steamId),
      optional(fetchConfig(rconUrl, rconPassword, http)),
      optional(fetchBans(rconUrl, rconPassword, http)),
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
          days: PROFILE_DAYS,
          now: now(),
        }),
      ],
    };
  };
