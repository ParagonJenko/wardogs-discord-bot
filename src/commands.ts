import type { Config } from './config.ts';
import {
  buildLastMatchEmbed,
  buildPlayersEmbed,
  buildRotationEmbed,
  buildRoundupMessage,
  buildSeedCall,
  buildSeedersEmbed,
  buildStatusEmbed,
  matchChoice,
  removedMatchText,
  type DiscordMessage,
  type SeederRow,
} from './discord.ts';
import {
  SEEDERS_DEFAULT_DAYS,
  SEEDERS_MAX_DAYS,
  type Choice,
  type CommandReply,
  type CommandRequest,
} from './interactions.ts';
import { fetchPlayers, fetchRotation, fetchStatus, sendBroadcast, type HttpClient } from './rcon.ts';
import { ROUNDUP_CHOICES, type Roundup, type RoundupChoice } from './roundup.ts';
import { isStaffCommand, runStaffCommand, suggestStaff, type StaffRecords } from './staff.ts';
import type { RecentMatch } from './stats.ts';

type CommandDeps = {
  // Read lazily, so Discord's endpoint check works before the RCON secrets are set.
  config: () => Config;
  http: HttpClient;
  lastMatch: () => Promise<RecentMatch | null>;
  // The best players and team of a week or month; null when nobody played in it.
  roundup: (choice: RoundupChoice) => Promise<Roundup | null>;
  seeders: (days: number) => Promise<SeederRow[]>;
  // Deletes the recent match that ended at this time, with its records; null if there is none.
  removeMatch: (endedAt: number) => Promise<{ match: RecentMatch; players: number } | null>;
  // Posts a /seednow call to the alerts channel, and holds back the automatic seeding alert for its cooldown.
  seedCall: (message: DiscordMessage) => Promise<void>;
  records: StaffRecords;
  now: () => number;
  log: { info: (message: string) => void };
};

// /lastmatch works without the RCON settings, so settings that fail to load only cost it the website link.
const websiteOf = (config: () => Config): string | undefined => {
  try {
    return config().siteUrl;
  } catch {
    return undefined;
  }
};

const NOBODY: Record<RoundupChoice, string> = {
  week: 'Nobody played on the server last week.',
  month: 'Nobody played on the server last month.',
  'this-week': 'Nobody has played on the server this week yet.',
  'this-month': 'Nobody has played on the server this month yet.',
};

// Discord shows at most 25 choices.
const MAX_CHOICES = 25;

type SuggestDeps = Pick<CommandDeps, 'config' | 'http' | 'records'> & { recentMatches: () => Promise<RecentMatch[]> };

// Choices offered while staff type: in /removematch the recent matches, narrowed to what has been typed; in the other
// staff commands players, teams, maps and bans.
export const suggestOptions =
  ({ recentMatches, ...staff }: SuggestDeps) =>
  async (request: CommandRequest): Promise<Choice[]> => {
    const { name, options } = request;
    if (isStaffCommand(name)) return suggestStaff(staff)(request);
    if (name !== 'removematch') return [];
    const typed = (options['match'] ?? '').trim().toLowerCase();
    return (await recentMatches())
      .map(matchChoice)
      .filter((choice) => choice.name.toLowerCase().includes(typed))
      .slice(0, MAX_CHOICES);
  };

// Discord enforces the option's range; this also covers a missing or odd value.
const dayCount = (value: string | undefined): number => {
  const days = Math.trunc(Number(value ?? SEEDERS_DEFAULT_DAYS));
  return Number.isFinite(days) ? Math.min(SEEDERS_MAX_DAYS, Math.max(1, days)) : SEEDERS_DEFAULT_DAYS;
};

export const runCommand =
  ({ config, http, lastMatch, roundup, seeders, removeMatch, seedCall, records, now, log }: CommandDeps) =>
  async (request: CommandRequest): Promise<CommandReply> => {
    const { name, options, userId } = request;
    if (isStaffCommand(name)) return runStaffCommand({ config, http, records, now, log })(name, request);
    if (name === 'lastmatch') {
      const match = await lastMatch();
      return match ? { embeds: [buildLastMatchEmbed(match, websiteOf(config))] } : { content: 'No finished matches recorded yet.' };
    }
    if (name === 'roundup') {
      const choice = ROUNDUP_CHOICES.find((c) => c === options['period']) ?? 'week';
      const found = await roundup(choice);
      return found ? { embeds: buildRoundupMessage(found, websiteOf(config)).embeds } : { content: NOBODY[choice] };
    }
    if (name === 'removematch') {
      const endedAt = Number(options['match']);
      const removed = Number.isFinite(endedAt) ? await removeMatch(endedAt) : null;
      if (removed === null) return { content: "That isn't one of the recent matches. Pick one from the list." };
      log.info(
        `/removematch by Discord user ${userId ?? 'unknown'}: ${removed.match.map} ended ${new Date(removed.match.endedAt).toISOString()}`,
      );
      return { content: removedMatchText(removed.match, removed.players) };
    }
    if (name === 'seeders') {
      const days = dayCount(options['days']);
      const { seedMinutes, vip } = config();
      return { embeds: [buildSeedersEmbed(await seeders(days), days, seedMinutes, vip)] };
    }

    const { rconUrl, rconPassword, rules, siteUrl, roleId, vip } = config();
    if (name === 'serverstatus') {
      return { embeds: [buildStatusEmbed(await fetchStatus(rconUrl, rconPassword, http), rules, siteUrl)] };
    }
    if (name === 'players') return { embeds: [buildPlayersEmbed(await fetchPlayers(rconUrl, rconPassword, http))] };
    if (name === 'rotation') return { embeds: [buildRotationEmbed(await fetchRotation(rconUrl, rconPassword, http))] };
    if (name === 'seednow') {
      const note = (options['message'] ?? '').trim();
      // Logged before anything can fail, like /broadcast, so every call has a record of who made it.
      log.info(`/seednow requested by Discord user ${userId ?? 'unknown'}${note ? `: ${JSON.stringify(note)}` : ''}`);
      const status = await fetchStatus(rconUrl, rconPassword, http);
      if (status.players >= rules.live) {
        return { content: `The server is already live (${status.players}/${status.maxPlayers} players), so no seeding call was sent.` };
      }
      await seedCall(buildSeedCall(status, { lowPop: rules.lowPop, live: rules.live, roleId, vip, siteUrl, note, calledBy: userId }));
      log.info(`/seednow posted for Discord user ${userId ?? 'unknown'} at ${status.players}/${status.maxPlayers} players`);
      return {
        content: roleId
          ? `🌱 Seeding call posted, pinging <@&${roleId}>.`
          : '🌱 Seeding call posted. No role is set (`DISCORD_ROLE_ID`), so nobody was pinged.',
      };
    }

    const message = (options['message'] ?? '').trim();
    if (!message) return { content: 'Nothing to send.' };
    const sender = `Discord user ${userId ?? 'unknown'}`;
    // Logged before sending, so a send that times out after reaching the server still has a record.
    // JSON quoting keeps line breaks in the message from faking extra log lines.
    log.info(`/broadcast requested by ${sender}: ${JSON.stringify(message)}`);
    await sendBroadcast(rconUrl, rconPassword, message, http);
    log.info(`/broadcast delivered for ${sender}`);
    return { content: `📢 Sent in game: ${message}` };
  };
