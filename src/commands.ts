import type { Config } from './config.ts';
import { buildLastMatchEmbed, buildPlayersEmbed, buildRotationEmbed, buildStatusEmbed } from './discord.ts';
import type { CommandReply, CommandRequest } from './interactions.ts';
import { fetchPlayers, fetchRotation, fetchStatus, sendBroadcast, type HttpClient } from './rcon.ts';
import type { RecentMatch } from './stats.ts';

type CommandDeps = {
  // Read lazily, so Discord's endpoint check works before the RCON secrets are set.
  config: () => Config;
  http: HttpClient;
  lastMatch: () => Promise<RecentMatch | null>;
  log: { info: (message: string) => void };
};

export const runCommand =
  ({ config, http, lastMatch, log }: CommandDeps) =>
  async ({ name, options, userId }: CommandRequest): Promise<CommandReply> => {
    if (name === 'lastmatch') {
      const match = await lastMatch();
      return match ? { embeds: [buildLastMatchEmbed(match)] } : { content: 'No finished matches recorded yet.' };
    }

    const { rconUrl, rconPassword, rules } = config();
    if (name === 'serverstatus') return { embeds: [buildStatusEmbed(await fetchStatus(rconUrl, rconPassword, http), rules)] };
    if (name === 'players') return { embeds: [buildPlayersEmbed(await fetchPlayers(rconUrl, rconPassword, http))] };
    if (name === 'rotation') return { embeds: [buildRotationEmbed(await fetchRotation(rconUrl, rconPassword, http))] };

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
