import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.ts';
import type { CommandRequest } from '../src/interactions.ts';
import type { HttpClient } from '../src/rcon.ts';
import { editRotations, parseRotationBook, rotationDay, type RotationBook, type RotationEdit, type RotationEditResult } from '../src/rotations.ts';
import type { SteamLookup } from '../src/steam.ts';
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
  busyThreshold: 97,
  scoreToWin: 100,
  seedMinutes: 10,
  vip: null,
  matchMessages: null,
  seedingMessages: null,
  roundups: null,
  rotationHour: 5,
};

const NOW = Date.UTC(2026, 8, 30, 12);
const ASH = '76561198000000001';
const BO = '76561198000000002';
const CY = '76561198000000003';
const OLD = '76561198000000004';

const players = {
  players: [
    { name: 'Ash', steamId: ASH, faction: 'Valkyra', kills: 5, deaths: 2 },
    { name: 'Bo', steamId: BO, faction: 'Manticore', kills: 1, deaths: 1 },
    { name: 'Ashley', steamId: CY, faction: 'Manticore', kills: 0, deaths: 0 },
  ],
};
const status = {
  serverName: 'gaminginit #1',
  players: { current: 3, max: 98 },
  factionScores: [
    { name: 'Valkyra', colorHex: '#3366ff', score: 40 },
    { name: 'Manticore', colorHex: '#ff3333', score: 35 },
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

const emptyRecord: PlayerRecord = { name: null, totals: null, vip: null, vipBlockedUntil: null, staffSpot: false, log: [], ban: null };

const fakeRecords = (): StaffRecords & { [K in keyof StaffRecords]: ReturnType<typeof vi.fn> } => ({
  player: vi.fn(async () => emptyRecord),
  knownPlayers: vi.fn(async () => [{ steamId: OLD, name: 'Oldtimer' }]),
  log: vi.fn(async () => undefined),
  ban: vi.fn(async (): Promise<BanResult> => ({ outcome: 'banned', until: NOW + 86_400_000, byBot: true })),
  unban: vi.fn(async () => true),
  vipAdd: vi.fn(async () => ({ outcome: 'added' as const, until: NOW + 30 * 86_400_000 })),
  vipRemove: vi.fn(async () => ({ outcome: 'removed' as const })),
  nextMap: vi.fn(async () => undefined),
  steam: vi.fn(async (): Promise<SteamLookup> => 'off'),
  rotations: vi.fn(async () => parseRotationBook(undefined)),
  editRotations: vi.fn(async () => ({ problem: 'Not in this test.' })),
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

    expect(sent).toContain(`PATCH /v1/players/${ASH} ${JSON.stringify({ faction: 'Manticore' })}`);
    expect(sent).toContain(`POST /v1/players/${ASH}/kill {}`);
    expect(records.log).toHaveBeenCalledWith(ASH, { action: 'switchteam', at: NOW, by: '42', name: 'Ash', detail: 'Valkyra to Manticore' });
    expect(reply).toEqual({ content: '🔀 Moved **Ash** to 🦂 **Manticore**. They respawn on the new side.' });
  });

  it("/switchteam asks for the team when there are three, and only moves players to one of the game's teams in the match", async () => {
    const three = { ...status, factionScores: [...status.factionScores, { name: 'LONESTAR', colorHex: '#3333ff', score: 1 }] };
    const { run, sent } = setup({ 'GET /v1/status': [200, three] });

    await expect(run('switchteam', { player: ASH })).resolves.toEqual({ content: 'Pick a team: Valkyra, Manticore, LONESTAR.' });
    await expect(run('switchteam', { player: ASH, team: 'Kharr' })).resolves.toEqual({ content: 'Pick Lonestar, Manticore or Valkyra.' });
    await expect(run('switchteam', { player: ASH, team: 'valkyra' })).resolves.toEqual({ content: '**Ash** is already on Valkyra.' });
    await expect(run('switchteam', { player: ASH, team: 'Lonestar' })).resolves.toMatchObject({ content: expect.stringContaining('🤠 **LONESTAR**') });
    expect(sent.filter((s) => s.startsWith('PATCH'))).toEqual([`PATCH /v1/players/${ASH} ${JSON.stringify({ faction: 'LONESTAR' })}`]);
  });

  it('/switchteam refuses a team that is not in the match', async () => {
    const { run, sent } = setup();

    await expect(run('switchteam', { player: ASH, team: 'Lonestar' })).resolves.toEqual({
      content: 'Lonestar is not in this match. Teams now: Valkyra, Manticore.',
    });
    expect(sent.filter((s) => s.startsWith('PATCH'))).toEqual([]);
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

  it('/ban says when the ban waits for the player to join, and does not kick them', async () => {
    const { run, sent, records } = setup();
    const joining = 'the bot bans and kicks them within a minute of them joining';
    records.ban
      .mockResolvedValueOnce({ outcome: 'banned', until: NOW + 86_400_000, byBot: true, waiting: true })
      .mockResolvedValueOnce({ outcome: 'already-banned', until: null, byBot: true, waiting: true });

    await expect(run('ban', { player: 'Bo', duration: '1d', reason: 'Cheating' })).resolves.toEqual({
      content: `🔨 Banned **Bo** for 1 day, until <t:${(NOW + 86_400_000) / 1000}:f>. Reason: Cheating\n⏳ They aren't in game, and the game only bans players who are, so ${joining}.`,
    });
    await expect(run('ban', { player: OLD, duration: '1d', reason: 'x' })).resolves.toEqual({
      content: `**Oldtimer** is already banned permanently. ⏳ They haven't joined since, so ${joining}. Use /unban first to change the ban.`,
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
    expect(records.unban).toHaveBeenCalledWith({ steamId: OLD, name: 'Oldtimer' }, '42', undefined);
  });

  it("keeps the staff member's name in the server with what they did, for the moderation log", async () => {
    const server = rcon();
    const records = fakeRecords();
    const run = runStaffCommand({ config: () => config, http: server.http, records, now: () => NOW, log: { info: vi.fn() } });
    const as = (name: StaffCommand, options: Record<string, string>) => run(name, { name, options, userId: '42', userName: 'Paragon' });

    await as('kick', { player: ASH, reason: 'Teamkilling' });
    await as('ban', { player: ASH, duration: '1d', reason: 'Teamkilling' });
    await as('unban', { steam_id: OLD });
    await as('vip', { subcommand: 'add', steam_id: ASH, reason: 'friend', days: '30' });
    await as('vip', { subcommand: 'remove', steam_id: ASH });

    expect(records.log).toHaveBeenCalledWith(ASH, { action: 'kick', at: NOW, by: '42', byName: 'Paragon', name: 'Ash', reason: 'Teamkilling' });
    expect(records.ban).toHaveBeenCalledWith(expect.objectContaining({ steamId: ASH, by: '42', byName: 'Paragon' }));
    expect(records.unban).toHaveBeenCalledWith({ steamId: OLD, name: 'Oldtimer' }, '42', 'Paragon');
    expect(records.vipAdd).toHaveBeenCalledWith(expect.objectContaining({ steamId: ASH, by: '42', byName: 'Paragon' }));
    expect(records.vipRemove).toHaveBeenCalledWith(expect.objectContaining({ steamId: ASH, by: '42', byName: 'Paragon' }));
  });

  it('/setnextmap queues the map; /changemap also ends the match', async () => {
    const { run, sent, records } = setup();

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
    // For the live status, which cannot see a staged map in the rotation.
    // The server's status has no map here, and the rotation could not be read.
    expect(records.nextMap.mock.calls).toEqual([
      ['Europe', null],
      ['Kavkazi', null],
    ]);
  });

  it('notes the map being played as the server reports it when staff set the next map', async () => {
    const { run, records } = setup({ 'GET /v1/status': [200, { ...status, map: 'NorthAmerica' }] });

    await run('setnextmap', { map: 'Europe' });
    expect(records.nextMap).toHaveBeenCalledWith('Europe', 'NorthAmerica');
  });

  it('/setnextmap still works when the next map cannot be noted for the live status', async () => {
    const { run, records, log } = setup();
    records.nextMap.mockRejectedValueOnce(new Error('storage down'));

    await expect(run('setnextmap', { map: 'Europe' })).resolves.toMatchObject({ content: expect.stringContaining('Next map') });
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('storage down'));
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

    await expect(run('vip', { subcommand: 'add', steam_id: ASH, reason: 'regular', days: '30' })).resolves.toEqual({
      content: `🎖️ Gave **Ash** a reserved slot until <t:${(NOW + 30 * 86_400_000) / 1000}:f>. It starts after the server's next restart.`,
    });
    await expect(run('vip', { subcommand: 'remove', steam_id: BO })).resolves.toEqual({
      content: "🎖️ Took **Bo** off the reserved list. It takes effect after the server's next restart. Automatic VIP will not give it back for 7 days.",
    });
    await expect(run('vip', { subcommand: 'add', steam_id: ASH, reason: 'regular', days: '0' })).resolves.toEqual({
      content: 'Give VIP for 1 to 365 days, or set permanent to True.',
    });
    await expect(run('vip', { subcommand: 'add', steam_id: ASH, reason: 'regular' })).resolves.toEqual({
      content: 'Give VIP for 1 to 365 days, or set permanent to True.',
    });
    await expect(run('vip', { subcommand: 'add', steam_id: ASH, reason: 'regular', days: '30', permanent: 'true' })).resolves.toEqual({
      content: 'Pick a number of days or permanent, not both.',
    });
    expect(records.vipAdd).toHaveBeenCalledTimes(1);
    expect(records.vipAdd).toHaveBeenCalledWith({ steamId: ASH, name: 'Ash', days: 30, reason: 'Regular', by: '42' });
    expect(records.vipRemove).toHaveBeenCalledWith({ steamId: BO, name: 'Bo', by: '42' });
  });

  it('/vip add needs a reason from the list, with a note for Other, and keeps the note with it', async () => {
    const { run, records } = setup();
    const pick = 'Pick why they get VIP: Friend, Regular, Seeder, Paid, Other.';

    await expect(run('vip', { subcommand: 'add', steam_id: ASH, days: '7' })).resolves.toEqual({ content: pick });
    await expect(run('vip', { subcommand: 'add', steam_id: ASH, reason: 'bribe', days: '7' })).resolves.toEqual({ content: pick });
    await expect(run('vip', { subcommand: 'add', steam_id: ASH, reason: 'other', note: '  ', days: '7' })).resolves.toEqual({
      content: 'Say why in note when the reason is Other.',
    });
    expect(records.vipAdd).not.toHaveBeenCalled();

    await run('vip', { subcommand: 'add', steam_id: ASH, reason: 'paid', note: ' Patreon, October ', days: '30' });
    await run('vip', { subcommand: 'add', steam_id: BO, reason: 'other', note: 'Event winner', permanent: 'true' });
    await run('vip', { subcommand: 'add', steam_id: ASH, reason: 'seeder', days: '7' });
    expect(records.vipAdd.mock.calls.map(([request]) => request.reason)).toEqual(['Paid: Patreon, October', 'Other: Event winner', 'Seeder']);
  });

  it('/vip remove keeps a reason when one is given', async () => {
    const { run, records } = setup();

    await run('vip', { subcommand: 'remove', steam_id: BO, reason: ' Payment ended ' });
    await run('vip', { subcommand: 'remove', steam_id: BO, reason: '   ' });
    expect(records.vipRemove.mock.calls).toEqual([
      [{ steamId: BO, name: 'Bo', reason: 'Payment ended', by: '42' }],
      [{ steamId: BO, name: 'Bo', by: '42' }],
    ]);
  });

  it('/vip remove leaves a staff spot, which only unlinking takes away', async () => {
    const { run, records } = setup();
    records.vipRemove.mockResolvedValueOnce({ outcome: 'staff-spot' as const } as never);

    await expect(run('vip', { subcommand: 'remove', steam_id: BO })).resolves.toEqual({
      content: '**Bo** is staff, with a staff spot that stays while their Steam account is linked. To take it away, unlink their Steam account on the staff page.',
    });
  });

  it('/vip add with permanent gives a reserved slot with no end date', async () => {
    const { run, records } = setup();
    records.vipAdd.mockResolvedValueOnce({ outcome: 'added' }).mockResolvedValueOnce({ outcome: 'extended' }).mockResolvedValueOnce({ outcome: 'already-reserved' });

    await expect(run('vip', { subcommand: 'add', steam_id: ASH, reason: 'friend', permanent: 'true' })).resolves.toEqual({
      content: "🎖️ Gave **Ash** a permanent reserved slot, with no end date. It starts after the server's next restart.",
    });
    await expect(run('vip', { subcommand: 'add', steam_id: ASH, reason: 'friend', permanent: 'true' })).resolves.toEqual({
      content: '🎖️ **Ash** keeps their reserved slot, with no end date.',
    });
    await expect(run('vip', { subcommand: 'add', steam_id: ASH, reason: 'friend', permanent: 'true' })).resolves.toEqual({
      content: '**Ash** already has a permanent reserved slot, with no end date. Nothing changed.',
    });
    expect(records.vipAdd).toHaveBeenCalledWith({ steamId: ASH, name: 'Ash', days: null, reason: 'Friend', by: '42' });
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
    expect(embed?.description).toContain('🟢 In game now on 🦂 **Manticore**');
    expect(embed?.fields).toEqual(
      expect.arrayContaining([
        { name: 'Playtime · last 90 days', value: '12 h 10 min', inline: true },
        { name: 'Seeding', value: '2 h 10 min · 4 seed days', inline: true },
        { name: 'VIP', value: '🎖️ Permanent reserved slot, no end date' },
        { name: 'Ban', value: 'Not banned' },
        { name: 'Staff history', value: `1 kick\n<t:${(NOW - 86_400_000) / 1000}:d> **Kick** by <@42>: Teamkilling` },
      ]),
    );
  });

  it('/player shows what Steam says about their account, and still answers without it', async () => {
    const { run, records } = setup();
    const steam = {
      at: NOW,
      found: true,
      vacBans: 0,
      gameBans: 2,
      lastBanAt: NOW - 400 * 86_400_000,
      communityBanned: false,
      tradeBan: 'none' as const,
      public: true,
      setUp: true,
      createdAt: NOW - 2000 * 86_400_000,
    };
    records.steam.mockResolvedValueOnce(steam).mockRejectedValueOnce(new Error('down'));
    const steamField = async () => (await run('player', { player: BO })).embeds?.[0]?.fields?.find((f) => f.name === 'Steam account')?.value;

    expect(await steamField()).toContain('⚠️ **Worth a look** · 3 points\n2 game bans, the last 13 months ago');
    expect(records.steam).toHaveBeenCalledWith(BO);
    expect(await steamField()).toBe("Couldn't reach Steam just now.");
    // Without STEAM_API_KEY there is nothing to say.
    expect(await steamField()).toBeUndefined();
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
      { name: `Ash · 🔴 Valkyra · ${ASH}`, value: ASH },
      { name: `Ashley · 🟢 Manticore · ${CY}`, value: CY },
    ]);
  });

  it("gives a team that isn't one of the game's own the dot nearest its colour in game", async () => {
    const { suggest } = setup({
      'GET /v1/players': [200, { players: [{ name: 'Ash', steamId: ASH, faction: 'Kharr', kills: 0, deaths: 0 }] }],
      'GET /v1/status': [200, { ...status, factionScores: [{ name: 'KHARR', colorHex: '#f4900c', score: 1 }] }],
    });

    await expect(suggest({ name: 'kick', options: { player: 'ash' }, focused: 'player' })).resolves.toEqual([
      { name: `Ash · 🟠 Kharr · ${ASH}`, value: ASH },
    ]);
  });

  it('still offers the players in game when the scores cannot be read', async () => {
    const { suggest } = setup({ 'GET /v1/status': [500, {}] });

    await expect(suggest({ name: 'kick', options: { player: 'bo' }, focused: 'player' })).resolves.toEqual([
      { name: `Bo · 🟢 Manticore · ${BO}`, value: BO },
    ]);
  });

  it('adds players seen lately for /player, /ban and /vip add', async () => {
    const { suggest } = setup();

    await expect(suggest({ name: 'ban', options: { player: 'o' }, focused: 'player' })).resolves.toEqual([
      { name: `Bo · 🟢 Manticore · ${BO}`, value: BO },
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
      { name: `Bo · 🟢 Manticore · ${BO}`, value: BO },
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

describe('/rotations', () => {
  // Wednesday 30 September, the 2026-09-30 rotation day with ROTATION_HOUR 5.
  const catalog: Record<string, [number, unknown]> = {
    'GET /v1/catalog/maps': [
      200,
      { maps: [{ id: 'Kavkazi', displayName: 'Kavkazi' }, { id: 'Europe', displayName: 'Europe' }, { id: 'NorthAmerica', displayName: 'NorthAmerica' }] },
    ],
    'GET /v1/catalog/experiences': [
      200,
      { experiences: [{ id: 'Europe_KOTH_01', displayName: 'King of the Hill' }, { id: 'Kavkazi_KOTH_01', displayName: 'King of the Hill' }] },
    ],
    'GET /v1/catalog/lightings': [200, { lightings: [{ id: 'DayClear', displayName: 'Day, clear' }, { id: 'DayEndClear', displayName: 'Dusk' }] }],
    'GET /v1/catalog/maps/Europe/experiences': [200, { experiences: ['Europe_KOTH_01', 'KOTH_InfantryOnly'] }],
    'GET /v1/catalog/maps/Europe/alternators': [200, { alternators: [] }],
    'GET /v1/catalog/maps/Kavkazi/experiences': [200, { experiences: ['Kavkazi_KOTH_01', 'KOTH_Hardcore'] }],
    'GET /v1/catalog/maps/Kavkazi/alternators': [200, { alternators: [{ tag: 'ZoneAlternator.Bakurani.Default.Circle', displayName: 'Circle' }] }],
  };

  // The saved rotations as the Durable Object keeps them, with a server that takes every rotation put on it, unless
  // `refuse` says why not.
  const withBook = (start: RotationBook = parseRotationBook(undefined), overrides: Record<string, [number, unknown]> = {}, refuse?: string) => {
    const ctx = setup({ ...catalog, ...overrides });
    let book = start;
    ctx.records.rotations.mockImplementation(async () => book);
    ctx.records.editRotations.mockImplementation(async (edit: RotationEdit, by: string, byName?: string): Promise<RotationEditResult> => {
      const result = editRotations(book, edit, { today: rotationDay(NOW, 5), now: NOW, by, ...(byName === undefined ? {} : { byName }) });
      if ('problem' in result) return result;
      const applied = result.book.applied;
      const chose = applied !== book.applied && applied?.pending === true;
      book = chose && refuse === undefined ? { ...result.book, applied: { ...applied, pending: false } } : result.book;
      if (!chose) return { ...result, book };
      return { ...result, book, server: refuse === undefined ? { outcome: 'updated' } : { outcome: 'failed', reason: refuse } };
    });
    const rotations = (options: Record<string, string>) => ctx.run('rotations', options);
    return { ...ctx, rotations, book: () => book };
  };

  const two: RotationBook = {
    rotations: [
      { name: 'Rotation 1', entries: [{ map: 'Kavkazi', experiences: ['Kavkazi_KOTH_01'], lighting: 'DayClear' }, { map: 'Europe' }] },
      { name: 'Weekend', entries: [{ map: 'NorthAmerica' }] },
    ],
    week: ['Rotation 1', 'Rotation 1', 'Rotation 1', 'Rotation 1', 'Rotation 1', 'Weekend', 'Weekend'],
    applied: { name: 'Rotation 1', day: '2026-09-30', at: 0, by: 'schedule', pending: false },
  };

  it('builds a rotation a map at a time, each map as the game plays it unless staff say otherwise', async () => {
    const { rotations, book, sent } = withBook();

    await expect(rotations({ subcommand: 'add', rotation: 'Rotation 1', map: 'Europe', infantry_only: 'true' })).resolves.toEqual({
      content: '➕ Added 🟦 **Ozeti** · King of the Hill · Infantry only to **Rotation 1**, number 1 of 1.',
    });
    await expect(
      rotations({ subcommand: 'add', rotation: 'rotation 1', map: 'Bakurani', lighting: 'dusk', zones: 'Circle', position: '1' }),
    ).resolves.toEqual({ content: '➕ Added 🟧 **Bakurani** · King of the Hill · Dusk · Circle zones to **Rotation 1**, number 1 of 2.' });
    await expect(rotations({ subcommand: 'add', rotation: 'Rotation 1', map: 'Nowhere' })).resolves.toEqual({ content: 'Pick a map from the list.' });

    expect(book().rotations).toEqual([
      {
        name: 'Rotation 1',
        entries: [
          { map: 'Kavkazi', experiences: ['Kavkazi_KOTH_01'], lighting: 'DayEndClear', zoneAlternator: 'ZoneAlternator.Bakurani.Default.Circle' },
          { map: 'Europe', experiences: ['Europe_KOTH_01', 'KOTH_InfantryOnly'] },
        ],
      },
    ]);
    // Nothing on the server changes while a rotation nobody picked is built.
    expect(sent.filter((line) => !line.startsWith('GET'))).toEqual([]);
  });

  it("saves the server's rotation as it is", async () => {
    const { rotations, book } = withBook(parseRotationBook(undefined), {
      'GET /v1/rotation': [
        200,
        { enabled: true, mode: 'ordered', entries: [{ map: 'Kavkazi', status: 'now', experiences: ['Kavkazi_KOTH_01'], lighting: '' }, { map: 'Europe' }] },
      ],
    });

    await expect(rotations({ subcommand: 'save', rotation: 'Rotation 1' })).resolves.toEqual({
      content: "💾 Saved the server's rotation as **Rotation 1** (2 maps).",
    });
    expect(book().rotations).toEqual([{ name: 'Rotation 1', entries: [{ map: 'Kavkazi', experiences: ['Kavkazi_KOTH_01'] }, { map: 'Europe' }] }]);
    await expect(rotations({ subcommand: 'save', rotation: 'ROTATION 1' })).resolves.toEqual({
      content: "💾 Saved the server's rotation as **Rotation 1** (2 maps), in place of the one saved before.",
    });
  });

  it("saves the server's rotation in the order of the one it replaces, as the bot writes it part-way round", async () => {
    const { rotations, book } = withBook(
      { ...parseRotationBook(undefined), rotations: [{ name: 'Rotation 1', entries: [{ map: 'Kavkazi' }, { map: 'Europe' }, { map: 'NorthAmerica' }] }] },
      {
        'GET /v1/rotation': [
          200,
          { enabled: true, mode: 'ordered', entries: [{ map: 'Europe', status: 'now' }, { map: 'NorthAmerica', lighting: 'DayClear' }, { map: 'Kavkazi' }] },
        ],
      },
    );

    await expect(rotations({ subcommand: 'save', rotation: 'Rotation 1' })).resolves.toEqual({
      content: "💾 Saved the server's rotation as **Rotation 1** (3 maps), in place of the one saved before.",
    });
    expect(book().rotations).toEqual([
      { name: 'Rotation 1', entries: [{ map: 'Kavkazi' }, { map: 'Europe' }, { map: 'NorthAmerica', lighting: 'DayClear' }] },
    ]);
  });

  it('plans the week, and puts a rotation planned for today on straight away', async () => {
    const { rotations, book } = withBook({ ...two, week: [null, null, null, null, null, null, null], applied: null });

    await expect(rotations({ subcommand: 'schedule', day: 'weekend', rotation: 'Weekend' })).resolves.toEqual({
      content: '📅 Saturday and Sunday: **Weekend**.',
    });
    await expect(rotations({ subcommand: 'schedule', day: 'wednesday', rotation: 'rotation 1' })).resolves.toEqual({
      content: "📅 Wednesdays: **Rotation 1**. It's Wednesday, so it goes on today. The server has **Rotation 1** now, and plays it from the next map.",
    });
    await expect(rotations({ subcommand: 'schedule', day: 'every-day' })).resolves.toEqual({
      content: '📅 Every day: no rotation, so the server keeps whatever it has.',
    });
    expect(book().week).toEqual([null, null, null, null, null, null, null]);
  });

  it('swaps the rotation for today, until the next day starts', async () => {
    const { rotations, book } = withBook(two);

    await expect(rotations({ subcommand: 'use', rotation: 'weekend' })).resolves.toEqual({
      content:
        "🗺️ Swapped to **Weekend** for today. The server has **Weekend** now, and plays it from the next map. Tomorrow's rotation, **Rotation 1**, goes on <t:" +
        `${Date.UTC(2026, 9, 1, 5) / 1000}:f>.`,
    });
    expect(book().applied).toEqual({ name: 'Weekend', day: '2026-09-30', at: NOW, by: '42', pending: false });
  });

  it('says so when the server could not take the rotation yet', async () => {
    const { rotations, book } = withBook(two, {}, 'the server settings are read-only over RCON');

    await expect(rotations({ subcommand: 'use', rotation: 'Weekend' })).resolves.toMatchObject({
      content: expect.stringContaining("⚠️ Couldn't put it on the server yet (the server settings are read-only over RCON). The bot tries again every minute."),
    });
    expect(book().applied?.pending).toBe(true);
  });

  it("takes a map out by its number or name, and puts today's rotation on again", async () => {
    const { rotations, book } = withBook(two);

    await expect(rotations({ subcommand: 'remove', rotation: 'Rotation 1', map: 'Ozeti' })).resolves.toEqual({
      content: '➖ Took 🟦 **Ozeti** out of **Rotation 1** (1 map left). The server has **Rotation 1** now, and plays it from the next map.',
    });
    await expect(rotations({ subcommand: 'remove', rotation: 'Weekend', map: '1' })).resolves.toEqual({
      content: '➖ Took 🟪 **Zestafona** out of **Weekend** (0 maps left). It has no maps left, so it is not put on the server; the server keeps the maps it has.',
    });
    await expect(rotations({ subcommand: 'remove', rotation: 'Rotation 1', map: '5' })).resolves.toEqual({
      content: "Pick a map from **Rotation 1**'s list.",
    });
    expect(book().rotations.map((r) => r.entries.length)).toEqual([1, 0]);
  });

  it('deletes a rotation, and says which days now keep what the server has', async () => {
    const { rotations, book } = withBook(two);

    await expect(rotations({ subcommand: 'delete', rotation: 'weekend' })).resolves.toEqual({
      content: '🗑️ Deleted **Weekend**. Saturday and Sunday keep whatever the server has.',
    });
    await expect(rotations({ subcommand: 'delete', rotation: 'Weekend' })).resolves.toEqual({
      content: 'There\'s no rotation called "Weekend". Pick one from the list.',
    });
    expect(book().rotations.map((r) => r.name)).toEqual(['Rotation 1']);
  });

  it('shows the rotations and the week, or one rotation map by map', async () => {
    const { rotations } = withBook(two);

    const all = await rotations({ subcommand: 'show' });
    expect(all.embeds?.[0]).toMatchObject({
      title: '🗺️ Map rotations',
      description: 'On the server today: **Rotation 1**, from the schedule.',
      fields: [
        {
          name: '📅 This week',
          value: [
            '▫️ Monday: **Rotation 1**',
            '▫️ Tuesday: **Rotation 1**',
            '▶️ Wednesday: **Rotation 1**',
            '▫️ Thursday: **Rotation 1**',
            '▫️ Friday: **Rotation 1**',
            '▫️ Saturday: **Weekend**',
            '▫️ Sunday: **Weekend**',
          ].join('\n'),
        },
        { name: 'Rotation 1 · 2 maps', value: 'Bakurani → Ozeti' },
        { name: 'Weekend · 1 map', value: 'Zestafona' },
      ],
      footer: { text: "Each day's rotation goes on at 05:00 UTC and plays from the next map." },
    });

    const one = await rotations({ subcommand: 'show', rotation: 'rotation 1' });
    expect(one.embeds?.[0]).toMatchObject({
      title: '🗺️ Rotation 1',
      description: '1. 🟧 **Bakurani** · King of the Hill · Day, clear\n2. 🟦 **Ozeti**',
      footer: { text: 'Planned for Monday, Tuesday, Wednesday, Thursday and Friday · On the server today' },
    });
  });

  it('plays Default on the days without a rotation, which goes back to it when one is deleted', async () => {
    const withDefault: RotationBook = {
      ...two,
      rotations: [{ name: 'Default', entries: [{ map: 'Europe' }] }, ...two.rotations],
      week: [null, null, 'Weekend', null, null, 'Weekend', 'Weekend'],
      applied: { name: 'Weekend', day: '2026-09-30', at: 0, by: 'schedule', pending: false },
    };
    const { rotations, book } = withBook(withDefault);

    await expect(rotations({ subcommand: 'delete', rotation: 'Default' })).resolves.toEqual({
      content: "**Default** can't be deleted: it plays on every day without a rotation of its own. Change its maps instead.",
    });
    await expect(rotations({ subcommand: 'delete', rotation: 'Weekend' })).resolves.toEqual({
      content:
        '🗑️ Deleted **Weekend**. Wednesday, Saturday and Sunday go back to **Default**. The server has **Default** now, and plays it from the next map.',
    });
    await expect(rotations({ subcommand: 'schedule', day: 'friday', rotation: 'Rotation 1' })).resolves.toEqual({
      content: '📅 Fridays: **Rotation 1**.',
    });
    await expect(rotations({ subcommand: 'schedule', day: 'friday' })).resolves.toEqual({ content: '📅 Fridays: **Default**.' });
    expect(book().week).toEqual([null, null, null, null, null, null, null]);
    expect(book().applied).toMatchObject({ name: 'Default', by: '42' });
  });

  it('explains how to start when there are no rotations', async () => {
    const { rotations } = withBook();

    const reply = await rotations({ subcommand: 'show' });
    expect(reply.embeds?.[0]?.description).toMatch(/No saved rotations yet/);
  });

  it('offers the saved rotations, a new name where one starts a rotation, and the maps to take out', async () => {
    const { suggest } = withBook(two);

    await expect(suggest({ name: 'rotations', options: { subcommand: 'use', rotation: '' }, focused: 'rotation' })).resolves.toEqual([
      { name: 'Rotation 1 · 2 maps', value: 'Rotation 1' },
      { name: 'Weekend · 1 map', value: 'Weekend' },
    ]);
    await expect(suggest({ name: 'rotations', options: { subcommand: 'add', rotation: 'Night ' }, focused: 'rotation' })).resolves.toEqual([
      { name: 'New rotation: Night', value: 'Night' },
    ]);
    await expect(suggest({ name: 'rotations', options: { subcommand: 'use', rotation: 'Night' }, focused: 'rotation' })).resolves.toEqual([]);
    await expect(
      suggest({ name: 'rotations', options: { subcommand: 'remove', rotation: 'Rotation 1', map: '' }, focused: 'map' }),
    ).resolves.toEqual([
      { name: '1. 🟧 Bakurani · King of the Hill · Day, clear', value: '1' },
      { name: '2. 🟦 Ozeti', value: '2' },
    ]);
    // Adding a map offers every map, as /setnextmap does.
    await expect(suggest({ name: 'rotations', options: { subcommand: 'add', map: 'zest' }, focused: 'map' })).resolves.toEqual([
      { name: '🟪 Zestafona', value: 'NorthAmerica' },
    ]);
  });
});
