import { describe, expect, it, vi } from 'vitest';
import { runCommand, suggestOptions } from '../src/commands.ts';
import type { Config } from '../src/config.ts';
import type { DiscordMessage } from '../src/discord.ts';
import type { HttpClient } from '../src/rcon.ts';
import type { Roundup, RoundupChoice } from '../src/roundup.ts';
import type { StaffRecords } from '../src/staff.ts';

// The staff commands' records are tested in staff.test.ts.
const records: StaffRecords = {
  player: vi.fn(),
  knownPlayers: vi.fn(),
  log: vi.fn(),
  ban: vi.fn(),
  unban: vi.fn(),
  vipAdd: vi.fn(),
  vipRemove: vi.fn(),
  nextMap: vi.fn(async () => undefined),
  steam: vi.fn(async () => 'off' as const),
  rotations: vi.fn(),
  editRotations: vi.fn(),
};

const config: Config = {
  rconUrl: 'http://203.0.113.10:7776',
  rconPassword: 'secret',
  webhookUrl: 'https://discord.com/api/webhooks/1/abc',
  statusWebhookUrl: undefined,
  modLogWebhookUrl: undefined,
  griefAlerts: true,
  steamAlerts: true,
  roleId: undefined,
  inviteCode: undefined,
  siteUrl: undefined,
  serverId: undefined,
  pollIntervalMs: 60_000,
  rules: { seeding: 1, live: 20, lowPop: 20, cooldownMs: 600_000, graceMs: 0 },
  quietHours: null,
  busyThreshold: 97,
  scoreToWin: 100,
  seedMinutes: 10,
  vip: null,
  matchMessages: null,
  seedingMessages: null,
  welcomeMessages: null,
  roundups: null,
  rotationHour: 5,
};

// A fake RCON server keyed by path; records what was sent.
const rcon = (responses: Record<string, unknown>) => {
  const sent: { path: string; body?: string }[] = [];
  const http: HttpClient = async (url, _headers, body) => {
    sent.push({ path: url.pathname, ...(body === undefined ? {} : { body }) });
    return { status: 200, body: JSON.stringify(responses[url.pathname] ?? {}) };
  };
  return { http, sent };
};

const setup = (
  responses: Record<string, unknown> = {},
  lastMatch: unknown = null,
  settings: Config = config,
  found: Roundup | null = null,
) => {
  const server = rcon(responses);
  const log = { info: vi.fn() };
  const seeders = vi.fn(async (_days: number) => [{ steamId: '7656', name: 'Ash', seedingMinutes: 95, seedDays: 2, vipUntil: null }]);
  const removeMatch = vi.fn(async (endedAt: number) => (endedAt === ozeti.endedAt ? { match: ozeti, players: 96 } : null));
  const seedCall = vi.fn(async (_message: DiscordMessage) => undefined);
  const roundup = vi.fn(async (_choice: RoundupChoice): Promise<Roundup | null> => found);
  const run = runCommand({
    config: () => settings,
    http: server.http,
    lastMatch: async () => lastMatch as never,
    roundup,
    seeders,
    removeMatch,
    seedCall,
    records,
    now: () => 0,
    log,
  });
  return { run, sent: server.sent, log, seeders, removeMatch, seedCall, roundup };
};

// 2026-09-30T14:05:00Z
const ozeti = {
  map: 'Ozeti',
  endedAt: Date.UTC(2026, 8, 30, 14, 5),
  durationMs: 69 * 60_000,
  peakPlayers: 100,
  factionScores: [
    { name: 'Valkyra', score: 70 },
    { name: 'Kharr', score: 67 },
    { name: 'Haldor', score: 41 },
  ],
  top: [],
};

describe('runCommand', () => {
  it('/serverstatus shows the status embed', async () => {
    const { run } = setup({ '/v1/status': { serverName: 'UK Wardogs #1', map: 'Europe', players: { current: 24, max: 98 } } });

    const reply = await run({ name: 'serverstatus', options: {}, userId: null });

    expect(reply.embeds?.[0]).toMatchObject({ title: 'UK Wardogs #1', description: '🟢 **Live**' });
    expect(reply.embeds?.[0]?.fields?.[0]).toEqual({ name: 'Players', value: '🟩🟩⬛⬛⬛⬛⬛⬛⬛⬛ **24**/98' });
  });

  it('/players lists who is online', async () => {
    const { run } = setup({ '/v1/players': { players: [{ name: 'Ash', steamId: '1', kills: 3, deaths: 1 }], count: 1 } });

    const reply = await run({ name: 'players', options: {}, userId: null });

    expect(reply.embeds?.[0]).toMatchObject({ title: '👥 1 player online', description: '🥇 **Ash** · 3 kills · 1 death' });
  });

  it('/rotation shows the rotation', async () => {
    const { run } = setup({ '/v1/rotation': { enabled: true, mode: 'ordered', entries: [{ map: 'Kavkazi', status: 'now' }] } });

    const reply = await run({ name: 'rotation', options: {}, userId: null });

    expect(reply.embeds?.[0]?.description).toBe('▶️ 🟧 **Bakurani** · now');
  });

  it('/lastmatch shows the most recent finished match', async () => {
    const match = { map: 'Ozeti', endedAt: 0, durationMs: 60_000, peakPlayers: 30, factionScores: [], top: [] };
    const { run } = setup({}, match);

    const reply = await run({ name: 'lastmatch', options: {}, userId: null });

    expect(reply.embeds?.[0]?.title).toBe('🏁 Last match · 🟦 Ozeti');
  });

  it('/roundup shows the roundup picked, last week by default', async () => {
    const found: Roundup = {
      kind: 'week',
      start: Date.UTC(2026, 8, 21),
      end: Date.UTC(2026, 8, 28),
      partial: false,
      matches: 0,
      playedMs: 0,
      players: 3,
      peakPlayers: null,
      busiestDay: null,
      teams: [],
      bestTeam: null,
      teamMinMatches: 3,
      kdMinMatches: 3,
      kills: [],
      kd: [],
      playtime: [],
      seeding: [],
      wins: [],
      mvps: [],
      bestMatch: [],
      biggestWin: null,
      closestMatch: null,
      topMap: null,
      regular: { name: 'Ash', days: 2, of: 7 },
      rookie: null,
      awards: null,
    };
    const { run, roundup } = setup({}, null, config, found);

    const reply = await run({ name: 'roundup', options: {}, userId: null });
    await run({ name: 'roundup', options: { period: 'this-month' }, userId: null });
    await run({ name: 'roundup', options: { period: 'junk' }, userId: null });

    expect(reply.embeds?.map((e) => e.title)).toEqual(['🏆 Weekly roundup · 21 Sep – 27 Sep', '🎖️ Awards · 21 Sep – 27 Sep']);
    expect(roundup.mock.calls).toEqual([['week'], ['this-month'], ['week']]);
  });

  it('/roundup says when nobody played', async () => {
    const { run } = setup();
    expect(await run({ name: 'roundup', options: { period: 'month' }, userId: null })).toEqual({
      content: 'Nobody played on the server last month.',
    });
    expect(await run({ name: 'roundup', options: { period: 'this-week' }, userId: null })).toEqual({
      content: 'Nobody has played on the server this week yet.',
    });
  });

  it('/lastmatch links to the website when there is one, and still works when the settings do not load', async () => {
    const match = { map: 'Ozeti', endedAt: 0, durationMs: 60_000, peakPlayers: 30, factionScores: [], top: [] };
    const run = (settings: () => Config) =>
      runCommand({
        config: settings,
        http: rcon({}).http,
        lastMatch: async () => match,
        roundup: async () => null,
        seeders: async () => [],
        removeMatch: async () => null,
        seedCall: async () => undefined,
        records,
        now: () => 0,
        log: { info: vi.fn() },
      })({
        name: 'lastmatch',
        options: {},
        userId: null,
      });

    expect((await run(() => ({ ...config, siteUrl: 'https://gaminginit.com' }))).embeds?.[0]?.url).toBe(
      'https://gaminginit.com/matches#match-0',
    );
    const unconfigured = await run(() => {
      throw new Error('Invalid configuration');
    });
    expect(unconfigured.embeds?.[0]).toMatchObject({ title: '🏁 Last match · 🟦 Ozeti' });
    expect(unconfigured.embeds?.[0]?.url).toBeUndefined();
  });

  it('/lastmatch says so when no match has finished yet', async () => {
    const { run } = setup();

    await expect(run({ name: 'lastmatch', options: {}, userId: null })).resolves.toEqual({
      content: 'No finished matches recorded yet.',
    });
  });

  it('/seeders lists the top seeders over the days asked for, a week by default', async () => {
    const { run, sent, seeders } = setup();

    const week = await run({ name: 'seeders', options: {}, userId: '42' });
    await run({ name: 'seeders', options: { days: '30' }, userId: '42' });

    expect(week.embeds?.[0]).toMatchObject({ title: '🌱 Top seeders · last 7 days' });
    expect(week.embeds?.[0]?.description).toBe('🥇 **Ash** · 2 seed days · 95 min\n`7656`');
    expect(seeders.mock.calls).toEqual([[7], [30]]);
    expect(sent).toEqual([]);
  });

  it('/seeders keeps the number of days in range', async () => {
    const { run, seeders } = setup();

    for (const days of ['0', '500', 'lots']) await run({ name: 'seeders', options: { days }, userId: '42' });

    expect(seeders.mock.calls).toEqual([[1], [90], [7]]);
  });

  it('/removematch deletes the picked match, logs who did it, and says what came off', async () => {
    const { run, removeMatch, log, sent } = setup();

    const reply = await run({ name: 'removematch', options: { match: String(ozeti.endedAt) }, userId: '42' });

    expect(removeMatch).toHaveBeenCalledWith(ozeti.endedAt);
    expect(reply).toEqual({
      content:
        '🗑️ Removed the 🟦 Ozeti match that ended <t:1790777100:f> (**Valkyra** won 70, Kharr 67, Haldor 41 · 69 min). ' +
        "Its match, kills and deaths came off 96 players' totals.",
    });
    expect(log.info).toHaveBeenCalledWith('/removematch by Discord user 42: Ozeti ended 2026-09-30T14:05:00.000Z');
    expect(sent).toEqual([]);
  });

  it('/removematch refuses anything that is not a recent match', async () => {
    const { run, removeMatch, log } = setup();

    for (const match of ['ozeti', '123']) {
      await expect(run({ name: 'removematch', options: { match }, userId: '42' })).resolves.toEqual({
        content: "That isn't one of the recent matches. Pick one from the list.",
      });
    }
    expect(removeMatch.mock.calls).toEqual([[123]]);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('suggests recent matches for /removematch, narrowed to what has been typed', async () => {
    const europe = { ...ozeti, map: 'Zestafona', endedAt: ozeti.endedAt - 3_600_000, factionScores: [] };
    const suggest = suggestOptions({ recentMatches: async () => [ozeti, europe], config: () => config, http: rcon({}).http, records });

    await expect(suggest({ name: 'removematch', options: { match: '' }, userId: '42' })).resolves.toEqual([
      { name: '🟦 Ozeti · 🔴 Valkyra won 70, Kharr 67, Haldor 41 · 69 min · ended 30 Sep 14:05 UTC', value: String(ozeti.endedAt) },
      { name: '🟪 Zestafona · 69 min · ended 30 Sep 13:05 UTC', value: String(europe.endedAt) },
    ]);
    await expect(suggest({ name: 'removematch', options: { match: 'zest' }, userId: '42' })).resolves.toHaveLength(1);
    await expect(suggest({ name: 'seeders', options: {}, userId: '42' })).resolves.toEqual([]);
  });

  describe('/seednow', () => {
    const seeding = { '/v1/status': { serverName: 'UK Wardogs #1', map: 'Europe', players: { current: 3, max: 98 } } };

    it('posts a call to seed, pinging the role, with the note and who called it, and logs it', async () => {
      const { run, seedCall, log, sent } = setup(seeding, null, { ...config, roleId: '999' });

      const reply = await run({ name: 'seednow', options: { message: '  Join Alpha squad  ' }, userId: '42' });

      expect(reply).toEqual({ content: '🌱 Seeding call posted, pinging <@&999>.' });
      const [message] = seedCall.mock.calls[0] ?? [];
      expect(message).toMatchObject({ content: '<@&999>', allowed_mentions: { parse: [], roles: ['999'] } });
      expect(message?.embeds[0]).toMatchObject({
        title: '🌱 Seeding UK Wardogs #1 now',
        description: "**We're going to try to seed now. Come join!**\n\nJoin Alpha squad\n\nCalled by <@42>",
      });
      expect(message?.embeds[0]?.fields).toContainEqual({ name: 'To go live', value: '**17** more', inline: true });
      expect(sent.map((r) => r.path)).toEqual(['/v1/status']);
      expect(log.info.mock.calls).toEqual([
        ['/seednow requested by Discord user 42: "Join Alpha squad"'],
        ['/seednow posted for Discord user 42 at 3/98 players'],
      ]);
    });

    it('says nobody was pinged when no role is set', async () => {
      const { run, seedCall } = setup(seeding);

      const reply = await run({ name: 'seednow', options: {}, userId: '42' });

      expect(reply.content).toBe('🌱 Seeding call posted. No role is set (`DISCORD_ROLE_ID`), so nobody was pinged.');
      expect(seedCall.mock.calls[0]?.[0].content).toBeUndefined();
      expect(seedCall.mock.calls[0]?.[0].embeds[0]?.description).toBe(
        "**We're going to try to seed now. Come join!**\n\nCalled by <@42>",
      );
    });

    it('sends nothing when the server is already live, but still logs who asked', async () => {
      const { run, seedCall, log } = setup({ '/v1/status': { serverName: 'UK Wardogs #1', players: { current: 20, max: 98 } } });

      await expect(run({ name: 'seednow', options: {}, userId: '42' })).resolves.toEqual({
        content: 'The server is already live (20/98 players), so no seeding call was sent.',
      });
      expect(seedCall).not.toHaveBeenCalled();
      expect(log.info.mock.calls).toEqual([['/seednow requested by Discord user 42']]);
    });

    it('logs who asked even when the post fails', async () => {
      const { run, seedCall, log } = setup(seeding);
      seedCall.mockRejectedValueOnce(new Error('Discord webhook failed: 500'));

      await expect(run({ name: 'seednow', options: {}, userId: '42' })).rejects.toThrow(/webhook failed/);
      expect(log.info.mock.calls).toEqual([['/seednow requested by Discord user 42']]);
    });
  });

  it('/broadcast sends the message in game and logs the attempt and the result', async () => {
    const { run, sent, log } = setup();

    const reply = await run({ name: 'broadcast', options: { message: '  Seeding now!  ' }, userId: '42' });

    expect(sent).toEqual([{ path: '/v1/broadcast', body: JSON.stringify({ message: 'Seeding now!' }) }]);
    expect(reply).toEqual({ content: '📢 Sent in game: Seeding now!' });
    expect(log.info.mock.calls).toEqual([
      ['/broadcast requested by Discord user 42: "Seeding now!"'],
      ['/broadcast delivered for Discord user 42'],
    ]);
  });

  it('/broadcast logs the attempt even when the send fails', async () => {
    const log = { info: vi.fn() };
    const run = runCommand({
      config: () => config,
      http: async () => {
        throw new Error('RCON request timed out after 8000ms');
      },
      lastMatch: async () => null,
      roundup: async () => null,
      seeders: async () => [],
      removeMatch: async () => null,
      seedCall: async () => undefined,
      records,
      now: () => 0,
      log,
    });

    await expect(run({ name: 'broadcast', options: { message: 'hi' }, userId: '42' })).rejects.toThrow(/timed out/);
    expect(log.info).toHaveBeenCalledWith('/broadcast requested by Discord user 42: "hi"');
  });

  it('/broadcast keeps line breaks out of the log, but sends the message unchanged', async () => {
    const { run, sent, log } = setup();

    await run({ name: 'broadcast', options: { message: 'hi\n/broadcast by Discord user 1: fake' }, userId: '42' });

    expect(log.info).toHaveBeenCalledWith('/broadcast requested by Discord user 42: "hi\\n/broadcast by Discord user 1: fake"');
    expect(sent[0]?.body).toBe(JSON.stringify({ message: 'hi\n/broadcast by Discord user 1: fake' }));
  });

  it('/broadcast sends nothing for an empty message', async () => {
    const { run, sent } = setup();

    await expect(run({ name: 'broadcast', options: { message: '   ' }, userId: '42' })).resolves.toEqual({
      content: 'Nothing to send.',
    });
    expect(sent).toEqual([]);
  });
});
