import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.ts';
import type { CommandRequest } from '../src/interactions.ts';
import type { HttpClient } from '../src/rcon.ts';
import {
  findPlayer,
  runStaffCommand,
  suggestStaff,
  type BanResult,
  type PlayerRecord,
  type StaffCommand,
  type StaffRecords,
} from '../src/staff.ts';

const config: Config = {
  rconUrl: 'http://203.0.113.10:7776',
  rconPassword: 'secret',
  webhookUrl: 'https://discord.com/api/webhooks/1/abc',
  roleId: undefined,
  inviteCode: undefined,
  siteUrl: undefined,
  pollIntervalMs: 60_000,
  rules: { seeding: 1, live: 20, lowPop: 20, cooldownMs: 600_000, graceMs: 0 },
  seedMinutes: 10,
  vip: null,
  matchMessages: null,
};

const NOW = Date.UTC(2026, 8, 30, 12);
const ASH = '76561198000000001';
const BO = '76561198000000002';
const CY = '76561198000000003';
const OLD = '76561198000000004';

const players = {
  players: [
    { name: 'Ash', steamId: ASH, faction: 'Valkyra', kills: 5, deaths: 2 },
    { name: 'Bo', steamId: BO, faction: 'Kharr', kills: 1, deaths: 1 },
    { name: 'Ashley', steamId: CY, faction: 'Kharr', kills: 0, deaths: 0 },
  ],
};
const status = {
  serverName: 'gaminginit #1',
  players: { current: 3, max: 98 },
  factionScores: [
    { name: 'Valkyra', colorHex: '#3366ff', score: 40 },
    { name: 'Kharr', colorHex: '#ff3333', score: 35 },
  ],
};
const settings = `[/Script/WDGame.WDGameSession]\n+DefaultReservedPlayerIds=${BO}\n`;

// A fake RCON server answering by method and path, recording every request.
const rcon = (overrides: Record<string, [number, unknown]> = {}) => {
  const responses: Record<string, [number, unknown]> = {
    'GET /v1/players': [200, players],
    'GET /v1/status': [200, status],
    'GET /v1/bans': [200, { bans: [{ steamId: OLD, reason: 'Cheating', bannedBy: 'config' }] }],
    'GET /v1/config': [200, { revision: '1', writable: true, text: settings }],
    'GET /v1/catalog/maps': [200, { maps: [{ id: 'Kavkazi', displayName: 'Kavkazi' }, { id: 'Europe', displayName: 'Europe' }] }],
    ...overrides,
  };
  const sent: string[] = [];
  const http: HttpClient = async (url, _headers, body, method) => {
    const key = `${method ?? (body === undefined ? 'GET' : 'POST')} ${url.pathname}`;
    sent.push(body === undefined ? key : `${key} ${body}`);
    const [statusCode, reply] = responses[key] ?? [200, {}];
    return { status: statusCode, body: JSON.stringify(reply) };
  };
  return { http, sent };
};

const emptyRecord: PlayerRecord = { name: null, totals: null, vip: null, vipBlockedUntil: null, log: [], ban: null };

const fakeRecords = (): StaffRecords & { [K in keyof StaffRecords]: ReturnType<typeof vi.fn> } => ({
  player: vi.fn(async () => emptyRecord),
  knownPlayers: vi.fn(async () => [{ steamId: OLD, name: 'Oldtimer' }]),
  log: vi.fn(async () => undefined),
  ban: vi.fn(async (): Promise<BanResult> => ({ outcome: 'banned', until: NOW + 86_400_000, byBot: true })),
  unban: vi.fn(async () => true),
  vipAdd: vi.fn(async () => ({ outcome: 'added' as const, until: NOW + 30 * 86_400_000 })),
  vipRemove: vi.fn(async () => ({ outcome: 'removed' as const })),
});

const setup = (overrides: Record<string, [number, unknown]> = {}) => {
  const server = rcon(overrides);
  const records = fakeRecords();
  const log = { info: vi.fn() };
  const run = (name: StaffCommand, options: Record<string, string>) =>
    runStaffCommand({ config: () => config, http: server.http, records, now: () => NOW, log })(name, { name, options, userId: '42' });
  const suggest = (request: Omit<CommandRequest, 'userId'>) =>
    suggestStaff({ config: () => config, http: server.http, records })({ ...request, userId: '42' });
  return { run, suggest, sent: server.sent, records, log };
};

describe('findPlayer', () => {
  const list = players.players;

  it('takes a Steam ID, an exact name, or a unique part of a name', () => {
    expect(findPlayer(BO, list)).toEqual({ player: { steamId: BO, name: 'Bo' } });
    expect(findPlayer('76561198000000099', list)).toEqual({ player: { steamId: '76561198000000099', name: '76561198000000099' } });
    expect(findPlayer('ash', list)).toEqual({ player: { steamId: ASH, name: 'Ash' } });
    expect(findPlayer('ley', list)).toEqual({ player: { steamId: CY, name: 'Ashley' } });
  });

  it('asks staff to pick when a name matches nobody, or more than one player', () => {
    expect(findPlayer('zed', list)).toEqual({ problem: expect.stringMatching(/No player matches "zed"/) });
    expect(findPlayer('a', list)).toEqual({ problem: expect.stringMatching(/More than one player matches "a": Ash .*Ashley/) });
    expect(findPlayer(' ', list)).toEqual({ problem: 'Pick a player from the list.' });
  });
});

describe('runStaffCommand', () => {
  it('/warn sends a private message and records it', async () => {
    const { run, sent, records } = setup();

    const reply = await run('warn', { player: BO, message: 'No spawn camping' });

    expect(sent).toContain(
      `POST /v1/players/${BO}/message ${JSON.stringify({ message: 'Staff warning: No spawn camping | Rules are in our Discord' })}`,
    );
    expect(records.log).toHaveBeenCalledWith(BO, { action: 'warn', at: NOW, by: '42', name: 'Bo', reason: 'No spawn camping' });
    expect(reply).toEqual({ content: '⚠️ Warned **Bo** in game: No spawn camping' });
  });

  it('points warned and kicked players at the rules in the Discord, on the website when there is one', async () => {
    const server = rcon();
    const records = fakeRecords();
    const run = runStaffCommand({
      config: () => ({ ...config, siteUrl: 'https://gaminginit.com/' }),
      http: server.http,
      records,
      now: () => NOW,
      log: { info: vi.fn() },
    });

    await run('warn', { name: 'warn', options: { player: BO, message: 'Language' }, userId: '42' });
    await run('kick', { name: 'kick', options: { player: BO, reason: 'Spam' }, userId: '42' });

    expect(server.sent.filter((s) => s.startsWith('POST'))).toEqual([
      `POST /v1/players/${BO}/message ${JSON.stringify({ message: 'Staff warning: Language | Rules: our Discord at gaminginit.com' })}`,
      `POST /v1/players/${BO}/kick ${JSON.stringify({ reason: 'Spam | Rules: our Discord at gaminginit.com' })}`,
    ]);
  });

  it('only warns, kicks or moves players who are in game', async () => {
    const { run, sent, records } = setup();

    await expect(run('kick', { player: OLD, reason: 'x' })).resolves.toEqual({ content: `**${OLD}** isn't on the server.` });
    expect(sent.some((s) => s.startsWith('POST'))).toBe(false);
    expect(records.log).not.toHaveBeenCalled();
  });

  it('/kick needs a reason, and passes it on', async () => {
    const { run, sent, records } = setup();

    await expect(run('kick', { player: ASH, reason: '  ' })).resolves.toEqual({ content: 'A kick needs a reason.' });
    await expect(run('kick', { player: ASH, reason: 'Teamkilling' })).resolves.toEqual({ content: '👢 Kicked **Ash**: Teamkilling' });
    expect(sent).toContain(`POST /v1/players/${ASH}/kick ${JSON.stringify({ reason: 'Teamkilling | Rules are in our Discord' })}`);
    expect(records.log).toHaveBeenCalledWith(ASH, { action: 'kick', at: NOW, by: '42', name: 'Ash', reason: 'Teamkilling' });
  });

  it('/switchteam moves a player to the other team when there are two, and respawns them', async () => {
    const { run, sent, records } = setup();

    const reply = await run('switchteam', { player: ASH });

    expect(sent).toContain(`PATCH /v1/players/${ASH} ${JSON.stringify({ faction: 'Kharr' })}`);
    expect(sent).toContain(`POST /v1/players/${ASH}/kill {}`);
    expect(records.log).toHaveBeenCalledWith(ASH, { action: 'switchteam', at: NOW, by: '42', name: 'Ash', detail: 'Valkyra to Kharr' });
    expect(reply).toEqual({ content: '🔀 Moved **Ash** to **Kharr**. They respawn on the new side.' });
  });

  it('/switchteam asks for the team when there are three, and refuses a team not playing', async () => {
    const three = { ...status, factionScores: [...status.factionScores, { name: 'Haldor', colorHex: '#33ff33', score: 1 }] };
    const { run, sent } = setup({ 'GET /v1/status': [200, three] });

    await expect(run('switchteam', { player: ASH })).resolves.toEqual({ content: 'Pick a team: Valkyra, Kharr, Haldor.' });
    await expect(run('switchteam', { player: ASH, team: 'Nobody' })).resolves.toEqual({
      content: 'No team called "Nobody". Teams now: Valkyra, Kharr, Haldor.',
    });
    await expect(run('switchteam', { player: ASH, team: 'valkyra' })).resolves.toEqual({ content: '**Ash** is already on Valkyra.' });
    await expect(run('switchteam', { player: ASH, team: 'haldor' })).resolves.toMatchObject({ content: expect.stringContaining('**Haldor**') });
    expect(sent.filter((s) => s.startsWith('PATCH'))).toEqual([`PATCH /v1/players/${ASH} ${JSON.stringify({ faction: 'Haldor' })}`]);
  });

  it('/ban bans through the records, then kicks the player if they are in game', async () => {
    const { run, sent, records } = setup();

    const reply = await run('ban', { player: 'Bo', duration: '1d', reason: 'Cheating' });

    expect(records.ban).toHaveBeenCalledWith({ steamId: BO, name: 'Bo', length: '1d', reason: 'Cheating', by: '42' });
    expect(sent).toContain(`POST /v1/players/${BO}/kick ${JSON.stringify({ reason: 'Banned: Cheating | Rules are in our Discord' })}`);
    expect(reply).toEqual({
      content: `🔨 Banned **Bo** for 1 day, until <t:${(NOW + 86_400_000) / 1000}:f> and kicked them. Reason: Cheating`,
    });
  });

  it('/ban works on players who are not online, and leaves a player who is already banned as they are', async () => {
    const { run, sent, records } = setup();
    records.ban
      .mockResolvedValueOnce({ outcome: 'banned', until: null, byBot: true })
      .mockResolvedValueOnce({ outcome: 'already-banned', until: null, byBot: false })
      .mockResolvedValueOnce({ outcome: 'already-banned', until: NOW + 3_600_000, byBot: true });

    await expect(run('ban', { player: 'oldtimer', duration: 'permanent', reason: 'Cheating' })).resolves.toEqual({
      content: '🔨 Banned **Oldtimer** permanently. Reason: Cheating',
    });
    await expect(run('ban', { player: OLD, duration: '1h', reason: 'x' })).resolves.toEqual({
      content: '**Oldtimer** is already banned, not by the bot. Use /unban first to change the ban.',
    });
    await expect(run('ban', { player: OLD, duration: '1d', reason: 'x' })).resolves.toEqual({
      content: `**Oldtimer** is already banned until <t:${(NOW + 3_600_000) / 1000}:f>. Use /unban first to change the ban.`,
    });
    expect(sent.some((s) => s.includes('/kick'))).toBe(false);
  });

  it('/ban needs a reason and a length from the list', async () => {
    const { run, records } = setup();

    await expect(run('ban', { player: BO, duration: '1d', reason: '' })).resolves.toEqual({ content: 'A ban needs a reason.' });
    await expect(run('ban', { player: BO, duration: '2y', reason: 'x' })).resolves.toEqual({ content: 'Pick how long the ban lasts from the list.' });
    expect(records.ban).not.toHaveBeenCalled();
  });

  it('/unban lifts a ban, or says there was none', async () => {
    const { run, records } = setup();
    records.unban.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(run('unban', { steam_id: OLD })).resolves.toEqual({ content: '✅ Unbanned **Oldtimer**. They can join again.' });
    await expect(run('unban', { steam_id: BO })).resolves.toEqual({ content: "**Bo** isn't banned." });
    expect(records.unban).toHaveBeenCalledWith({ steamId: OLD, name: 'Oldtimer' }, '42');
  });

  it('/setnextmap queues the map; /changemap also ends the match', async () => {
    const { run, sent } = setup();

    await expect(run('setnextmap', { map: 'Europe' })).resolves.toEqual({
      content: '🗺️ Next map: 🟦 **Ozeti**. The server goes there when this match ends; the rotation is unchanged.',
    });
    await expect(run('changemap', { map: 'bakurani' })).resolves.toEqual({
      content: '🗺️ Ended the match. The server moves to 🟧 **Bakurani** after the end screen.',
    });
    await expect(run('changemap', { map: 'Moon' })).resolves.toEqual({ content: 'Pick a map from the list.' });
    expect(sent.filter((s) => s.startsWith('POST'))).toEqual([
      `POST /v1/match/map ${JSON.stringify({ map: 'Europe' })}`,
      `POST /v1/match/map ${JSON.stringify({ map: 'Kavkazi' })}`,
      'POST /v1/match/end {}',
    ]);
  });

  it('/setnextmap plays the map as the rotation does, changing only what staff asked', async () => {
    const { run, sent } = setup({
      'GET /v1/rotation': [
        200,
        { enabled: true, mode: 'ordered', entries: [{ map: 'Europe', status: 'next', experiences: ['Europe_KOTH_01'], lighting: 'DayClear' }] },
      ],
      'GET /v1/catalog/experiences': [200, { experiences: [{ id: 'Europe_KOTH_01', displayName: 'King of the Hill' }] }],
      'GET /v1/catalog/lightings': [200, { lightings: [{ id: 'DayClear', displayName: 'Day, clear' }, { id: 'DayEarlyFog', displayName: 'Early fog' }] }],
      'GET /v1/catalog/maps/Europe/experiences': [200, { experiences: ['Europe_KOTH_01', 'KOTH_InfantryOnly'] }],
      'GET /v1/catalog/maps/Europe/alternators': [200, { alternators: [] }],
    });

    await expect(run('setnextmap', { map: 'Europe', infantry_only: 'true', lighting: 'early fog' })).resolves.toEqual({
      content:
        '🗺️ Next map: 🟦 **Ozeti** · King of the Hill · Infantry only · Early fog. The server goes there when this match ends; the rotation is unchanged.',
    });
    await expect(run('setnextmap', { map: 'Europe', mode: 'Capture' })).resolves.toEqual({
      content: 'No game mode "Capture" on this map. Pick one from the list.',
    });
    expect(sent.filter((s) => s.startsWith('POST'))).toEqual([
      `POST /v1/match/map ${JSON.stringify({ map: 'Europe', experiences: ['Europe_KOTH_01', 'KOTH_InfantryOnly'], lighting: 'DayEarlyFog' })}`,
    ]);
  });

  it('/changemap queues the map with its setup, then ends the match', async () => {
    const { run, sent } = setup({
      'GET /v1/rotation': [200, { enabled: true, mode: 'ordered', entries: [{ map: 'Kavkazi', experiences: ['Kavkazi_KOTH_01'] }] }],
      'GET /v1/catalog/maps/Kavkazi/experiences': [200, { experiences: ['Kavkazi_KOTH_01', 'KOTH_InfantryOnly', 'KOTH_Hardcore'] }],
      'GET /v1/catalog/maps/Kavkazi/alternators': [200, { alternators: [{ tag: 'ZoneAlternator.Bakurani.Default.Circle', displayName: 'Circle' }] }],
    });

    await expect(run('changemap', { map: 'Kavkazi', infantry_only: 'true', hardcore: 'true', zones: 'circle' })).resolves.toEqual({
      content: '🗺️ Ended the match. The server moves to 🟧 **Bakurani** · Kavkazi_KOTH_01 · Infantry only · Hardcore · Circle zones after the end screen.',
    });
    expect(sent.filter((s) => s.startsWith('POST'))).toEqual([
      `POST /v1/match/map ${JSON.stringify({
        map: 'Kavkazi',
        experiences: ['Kavkazi_KOTH_01', 'KOTH_InfantryOnly', 'KOTH_Hardcore'],
        zoneAlternator: 'ZoneAlternator.Bakurani.Default.Circle',
      })}`,
      'POST /v1/match/end {}',
    ]);
  });

  it('/vip add and /vip remove go through the records', async () => {
    const { run, records } = setup();

    await expect(run('vip', { subcommand: 'add', steam_id: ASH, days: '30' })).resolves.toEqual({
      content: `🎖️ Gave **Ash** a reserved slot until <t:${(NOW + 30 * 86_400_000) / 1000}:f>. It starts after the server's next restart.`,
    });
    await expect(run('vip', { subcommand: 'remove', steam_id: BO })).resolves.toEqual({
      content: "🎖️ Took **Bo** off the reserved list. It takes effect after the server's next restart. Automatic VIP will not give it back for 7 days.",
    });
    await expect(run('vip', { subcommand: 'add', steam_id: ASH, days: '0' })).resolves.toEqual({ content: 'Give VIP for 1 to 365 days.' });
    expect(records.vipAdd).toHaveBeenCalledTimes(1);
    expect(records.vipAdd).toHaveBeenCalledWith({ steamId: ASH, name: 'Ash', days: 30, by: '42' });
    expect(records.vipRemove).toHaveBeenCalledWith({ steamId: BO, name: 'Bo', by: '42' });
  });

  it('/player shows the records with what the server says now', async () => {
    const { run, records } = setup();
    records.player.mockResolvedValueOnce({
      ...emptyRecord,
      name: 'Bo',
      totals: { name: 'Bo', seedingMinutes: 130, liveMinutes: 600, seedDays: 4, matches: 9, kills: 50, deaths: 25 },
      log: [{ action: 'kick', at: NOW - 86_400_000, by: '42', name: 'Bo', reason: 'Teamkilling' }],
    });

    const reply = await run('player', { player: BO });
    const embed = reply.embeds?.[0];

    expect(records.player).toHaveBeenCalledWith(BO);
    expect(embed?.title).toBe('👤 Bo');
    expect(embed?.description).toContain(`\`${BO}\``);
    expect(embed?.description).toContain('🟢 In game now on **Kharr**');
    expect(embed?.fields).toEqual(
      expect.arrayContaining([
        { name: 'Playtime · last 90 days', value: '12 h 10 min', inline: true },
        { name: 'Seeding', value: '2 h 10 min · 4 seed days', inline: true },
        { name: 'VIP', value: '🎖️ Reserved slot added by hand, no end date' },
        { name: 'Ban', value: 'Not banned' },
        { name: 'Staff history', value: `1 kick\n<t:${(NOW - 86_400_000) / 1000}:d> **Kick** by <@42>: Teamkilling` },
      ]),
    );
  });

  it('/player still answers when the reserved list cannot be read safely', async () => {
    const twice = `${settings}[/Script/WDGame.WDGameSession]\nMaxReservedSlots=2\n`;
    const { run } = setup({ 'GET /v1/config': [200, { revision: '1', writable: true, text: twice }] });

    const embed = (await run('player', { player: BO })).embeds?.[0];

    expect(embed?.fields).toEqual(expect.arrayContaining([{ name: 'VIP', value: "Couldn't read the reserved list" }]));
  });

  it('/player still answers when the server cannot be reached', async () => {
    const { run } = setup({
      'GET /v1/players': [500, {}],
      'GET /v1/config': [500, {}],
      'GET /v1/bans': [500, {}],
    });

    const embed = (await run('player', { player: OLD })).embeds?.[0];

    expect(embed?.title).toBe('👤 Oldtimer');
    expect(embed?.fields).toEqual(
      expect.arrayContaining([
        { name: 'VIP', value: "Couldn't read the reserved list" },
        { name: 'Ban', value: "Couldn't read the ban list" },
      ]),
    );
  });
});

describe('suggestStaff', () => {
  it('offers players in game for /warn, /kick and /switchteam, narrowed to what was typed', async () => {
    const { suggest } = setup();

    await expect(suggest({ name: 'kick', options: { player: 'ash' }, focused: 'player' })).resolves.toEqual([
      { name: `Ash · Valkyra · ${ASH}`, value: ASH },
      { name: `Ashley · Kharr · ${CY}`, value: CY },
    ]);
  });

  it('adds players seen lately for /player, /ban and /vip add', async () => {
    const { suggest } = setup();

    await expect(suggest({ name: 'ban', options: { player: 'o' }, focused: 'player' })).resolves.toEqual([
      { name: `Bo · Kharr · ${BO}`, value: BO },
      { name: `Oldtimer · ${OLD}`, value: OLD },
    ]);
    await expect(suggest({ name: 'vip', options: { subcommand: 'add', steam_id: 'old' }, focused: 'steam_id' })).resolves.toHaveLength(1);
  });

  it('offers the banned players for /unban and the reserved list for /vip remove', async () => {
    const { suggest } = setup();

    await expect(suggest({ name: 'unban', options: { steam_id: '' }, focused: 'steam_id' })).resolves.toEqual([
      { name: `Oldtimer · ${OLD}`, value: OLD },
    ]);
    await expect(suggest({ name: 'vip', options: { subcommand: 'remove', steam_id: '' }, focused: 'steam_id' })).resolves.toEqual([
      { name: `Bo · Kharr · ${BO}`, value: BO },
    ]);
  });

  it('offers the other teams in the match for /switchteam, with how many are on each', async () => {
    const { suggest } = setup();

    await expect(suggest({ name: 'switchteam', options: { player: BO, team: '' }, focused: 'team' })).resolves.toEqual([
      { name: '🐻 Valkyra · 1 player · 40 points', value: 'Valkyra' },
    ]);
    await expect(suggest({ name: 'switchteam', options: { team: 'k' }, focused: 'team' })).resolves.toEqual([
      { name: '🐻 Valkyra · 1 player · 40 points', value: 'Valkyra' },
      { name: '🔴 Kharr · 2 players · 35 points', value: 'Kharr' },
    ]);
  });

  it('offers the modes and zone layouts of the map picked, and every lighting', async () => {
    const { suggest } = setup({
      'GET /v1/catalog/experiences': [200, { experiences: [{ id: 'Europe_KOTH_01', displayName: 'King of the Hill' }] }],
      'GET /v1/catalog/maps/Europe/experiences': [200, { experiences: ['Europe_KOTH_01', 'KOTH_InfantryOnly'] }],
      'GET /v1/catalog/maps/Europe/alternators': [200, { alternators: [{ tag: 'ZoneAlternator.Ozeti.Default.Line', displayName: 'Line' }] }],
      'GET /v1/catalog/lightings': [200, { lightings: [{ id: 'DayClear', displayName: 'Day, clear' }] }],
    });

    await expect(suggest({ name: 'setnextmap', options: { map: 'Europe', mode: '' }, focused: 'mode' })).resolves.toEqual([
      { name: 'King of the Hill', value: 'Europe_KOTH_01' },
    ]);
    await expect(suggest({ name: 'changemap', options: { map: 'Europe', zones: 'li' }, focused: 'zones' })).resolves.toEqual([
      { name: 'Line', value: 'ZoneAlternator.Ozeti.Default.Line' },
    ]);
    await expect(suggest({ name: 'setnextmap', options: { lighting: '' }, focused: 'lighting' })).resolves.toEqual([
      { name: 'Day, clear', value: 'DayClear' },
    ]);
    await expect(suggest({ name: 'setnextmap', options: { mode: '' }, focused: 'mode' })).resolves.toEqual([]);
  });

  it('offers maps by the names players know', async () => {
    const { suggest } = setup();

    await expect(suggest({ name: 'changemap', options: { map: '' }, focused: 'map' })).resolves.toEqual([
      { name: '🟧 Bakurani', value: 'Kavkazi' },
      { name: '🟦 Ozeti', value: 'Europe' },
    ]);
    await expect(suggest({ name: 'setnextmap', options: { map: 'oze' }, focused: 'map' })).resolves.toEqual([{ name: '🟦 Ozeti', value: 'Europe' }]);
  });
});
