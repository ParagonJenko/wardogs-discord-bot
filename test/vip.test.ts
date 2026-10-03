import { describe, expect, it, vi } from 'vitest';
import type { VipRule } from '../src/config.ts';
import type { PlayerDay, PlayerTotals } from '../src/players.ts';
import type { ConfigResult, ServerConfig } from '../src/rcon.ts';
import {
  addVip,
  editReserved,
  parseVipState,
  planVip,
  qualified,
  removeVip,
  reservedIds,
  reservedListing,
  syncVip,
  vipDue,
  type VipGrant,
} from '../src/vip.ts';

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 8, 30, 12);
const rule: VipRule = { seedDays: 3, seedMinutes: 10, windowDays: 7, lengthDays: 7 };

const ASH = '76561198000000001';
const BO = '76561198000000002';
const ADMIN = '76561198000000009';

const ini = (lines: string[]): string => `${lines.join('\n')}\n`;

const settings = ini([
  '[/Script/WDGame.WDGameSession]',
  'ServerName=gaminginit #1',
  'MaxReservedSlots=2',
  `+DefaultReservedPlayerIds=${ADMIN}`,
  '+DefaultBannedPlayerIds=76561198000000666',
  '',
  '[/Script/Engine.GameSession]',
  'MaxPlayers=100',
]);

const row = (name: string, seedDays: number): PlayerTotals => ({
  name,
  seedingMinutes: seedDays * 20,
  liveMinutes: 0,
  seedDays,
  matches: 0,
  kills: 0,
  deaths: 0,
});

describe('reservedIds', () => {
  it('reads the reserved list from the game session section only', () => {
    const text = ini([...settings.trim().split('\n'), `+DefaultReservedPlayerIds=${BO}`]);

    expect(reservedIds(text)).toEqual([ADMIN]);
    expect(reservedIds('[/Script/Engine.GameSession]\nMaxPlayers=100\n')).toEqual([]);
  });
});

describe('editReserved', () => {
  it('adds after the last reserved player and removes only the ones asked, leaving every other line', () => {
    const text = editReserved(ini([...settings.trim().split('\n').slice(0, 4), `+DefaultReservedPlayerIds=${BO}`, ...settings.trim().split('\n').slice(4)]), [ASH], [BO]);

    expect(text).toBe(
      ini([
        '[/Script/WDGame.WDGameSession]',
        'ServerName=gaminginit #1',
        'MaxReservedSlots=2',
        `+DefaultReservedPlayerIds=${ADMIN}`,
        `+DefaultReservedPlayerIds=${ASH}`,
        '+DefaultBannedPlayerIds=76561198000000666',
        '',
        '[/Script/Engine.GameSession]',
        'MaxPlayers=100',
      ]),
    );
  });

  it('keeps Windows line endings', () => {
    const text = settings.replace(/\n/g, '\r\n');

    expect(editReserved(text, [ASH], [])).toBe(text.replace(`${ADMIN}\r\n`, `${ADMIN}\r\n+DefaultReservedPlayerIds=${ASH}\r\n`));
  });

  it('adds the section when the file has none', () => {
    expect(editReserved('[/Script/Engine.GameSession]\nMaxPlayers=100\n', [ASH], [])).toBe(
      ini(['[/Script/Engine.GameSession]', 'MaxPlayers=100', '', '[/Script/WDGame.WDGameSession]', `+DefaultReservedPlayerIds=${ASH}`]),
    );
  });

  it('refuses anything that is not a Steam ID, and files it cannot read safely', () => {
    expect(() => editReserved(settings, ['7656\n[Evil]'], [])).toThrow(/Steam ID/);
    expect(() => editReserved(ini(['[/Script/WDGame.WDGameSession]', `-DefaultReservedPlayerIds=${ADMIN}`]), [ASH], [])).toThrow(/by hand/);
    expect(() => editReserved(`${settings}[/Script/WDGame.WDGameSession]\n`, [ASH], [])).toThrow(/more than once/);
  });
});

describe('qualified', () => {
  it('is everyone with enough seed days', () => {
    const days: PlayerDay[] = [{ [ASH]: row('Ash', 2), [BO]: row('Bo', 1) }, { [ASH]: row('Ash', 1), [BO]: row('Bo', 1) }];

    expect(qualified(days, rule)).toEqual([{ steamId: ASH, name: 'Ash' }]);
  });
});

describe('planVip', () => {
  const grant = (at: number, name = 'Ash'): VipGrant => ({ name, grantedAt: at, expiresAt: at + 7 * DAY });

  it('gives a week of VIP to players who earned it, leaving an admin’s VIPs alone', () => {
    const plan = planVip([{ steamId: ASH, name: 'Ash' }, { steamId: ADMIN, name: 'Admin' }], [ADMIN], {}, NOW, rule);

    expect(plan).toEqual({ add: [{ steamId: ASH, name: 'Ash' }], remove: [], renewed: [], granted: { [ASH]: grant(NOW) } });
  });

  it('keeps VIP for the week even if the player stops seeding', () => {
    const granted = { [ASH]: grant(NOW - 6 * DAY) };

    expect(planVip([], [ASH], granted, NOW, rule)).toEqual({ add: [], remove: [], renewed: [], granted });
  });

  it('takes VIP away when the week is up, unless it was earned again', () => {
    const granted = { [ASH]: grant(NOW - 7 * DAY), [BO]: grant(NOW - 7 * DAY, 'Bo') };

    expect(planVip([{ steamId: BO, name: 'Bo' }], [ASH, BO], granted, NOW, rule)).toEqual({
      add: [],
      remove: [ASH],
      renewed: [{ steamId: BO, name: 'Bo' }],
      granted: { [BO]: grant(NOW, 'Bo') },
    });
  });

  it('forgets a player an admin took off the list, and adds them again only if they earned it', () => {
    const granted = { [ASH]: grant(NOW - DAY), [BO]: grant(NOW - DAY, 'Bo') };

    expect(planVip([{ steamId: BO, name: 'Bo' }], [], granted, NOW, rule)).toEqual({
      add: [{ steamId: BO, name: 'Bo' }],
      remove: [],
      renewed: [],
      granted: { [BO]: grant(NOW, 'Bo') },
    });
  });

  it('ignores anything that is not a Steam ID', () => {
    expect(planVip([{ steamId: 'bot-1', name: 'Bot' }], [], {}, NOW, rule).add).toEqual([]);
  });

  it('does not give VIP back to a player staff took it from until their block runs out', () => {
    const earned = [{ steamId: ASH, name: 'Ash' }];

    expect(planVip(earned, [], {}, NOW, rule, { [ASH]: NOW + DAY }).add).toEqual([]);
    expect(planVip(earned, [], {}, NOW, rule, { [ASH]: NOW }).add).toEqual(earned);
  });
});

describe('vipDue and parseVipState', () => {
  it('checks every 10 minutes, starting straight away', () => {
    const state = parseVipState(undefined);

    expect(state).toEqual({ granted: {}, checkedAt: 0, revoked: {} });
    expect(parseVipState({ granted: {}, checkedAt: 5 })).toEqual({ granted: {}, checkedAt: 5, revoked: {} });
    expect(vipDue(state, NOW)).toBe(true);
    expect(vipDue({ ...state, checkedAt: NOW - 9 * 60_000 }, NOW)).toBe(false);
  });
});

describe('syncVip', () => {
  const server = (text = settings, overrides: Partial<ServerConfig> = {}) => {
    const accepted: ConfigResult = { ok: true, errors: [], ignored: [] };
    return {
      fetchConfig: vi.fn(async (): Promise<ServerConfig> => ({ revision: '4', writable: true, text, ...overrides })),
      validate: vi.fn(async (_text: string) => accepted),
      put: vi.fn(async (_config: ServerConfig) => accepted),
    };
  };
  const earned: PlayerDay[] = [{ [ASH]: row('Ash', 3) }];
  const log = { info: vi.fn() };

  it('checks the result, then writes the new list against the revision it read', async () => {
    const rcon = server();

    const result = await syncVip({ rule, days: earned, state: parseVipState(undefined), now: NOW, rcon, log });

    expect(result).toEqual({
      state: { granted: { [ASH]: { name: 'Ash', grantedAt: NOW, expiresAt: NOW + 7 * DAY } }, checkedAt: NOW, revoked: {} },
      added: [{ steamId: ASH, name: 'Ash' }],
      renewed: [],
    });
    const written = editReserved(settings, [ASH], []);
    expect(rcon.validate).toHaveBeenCalledWith(written);
    expect(rcon.put).toHaveBeenCalledWith({ revision: '4', writable: true, text: written });
    expect(log.info).toHaveBeenCalledWith(
      `VIP added: Ash (${ASH}). The server uses the new reserved list after its next restart.`,
    );
  });

  it('takes a player off the list once their week is up, if they did not earn it again', async () => {
    const onList = editReserved(settings, [ASH], []);
    const rcon = server(onList);
    const state = { granted: { [ASH]: { name: 'Ash', grantedAt: NOW - 7 * DAY, expiresAt: NOW - 60_000 } }, checkedAt: NOW - 600_000, revoked: {} };

    const result = await syncVip({ rule, days: [{ [ASH]: row('Ash', 2) }], state, now: NOW, rcon, log });

    expect(rcon.put).toHaveBeenCalledWith({ revision: '4', writable: true, text: settings });
    expect(result).toEqual({ state: { granted: {}, checkedAt: NOW, revoked: {} }, added: [], renewed: [] });
    expect(log.info).toHaveBeenCalledWith(`VIP ended: Ash (${ASH}). The server uses the new reserved list after its next restart.`);
  });

  it('keeps a player on the list for another week if they earned it again, without writing', async () => {
    const rcon = server(editReserved(settings, [ASH], []));
    const state = { granted: { [ASH]: { name: 'Ash', grantedAt: NOW - 7 * DAY, expiresAt: NOW - 60_000 } }, checkedAt: 0, revoked: {} };

    const result = await syncVip({ rule, days: earned, state, now: NOW, rcon, log });

    expect(rcon.put).not.toHaveBeenCalled();
    expect(result.renewed).toEqual([{ steamId: ASH, name: 'Ash' }]);
    expect(result.state.granted[ASH]).toEqual({ name: 'Ash', grantedAt: NOW, expiresAt: NOW + 7 * DAY });
  });

  it('forgets blocks that have run out', async () => {
    const state = { ...parseVipState(undefined), revoked: { [ASH]: NOW - 1, [BO]: NOW + DAY } };

    const result = await syncVip({ rule, days: [], state, now: NOW, rcon: server(), log });

    expect(result.state.revoked).toEqual({ [BO]: NOW + DAY });
  });

  it('ends VIP staff gave on time even when automatic VIP is off', async () => {
    const rcon = server(editReserved(settings, [ASH], []));
    const state = { granted: { [ASH]: { name: 'Ash', grantedAt: NOW - 30 * DAY, expiresAt: NOW - 1 } }, checkedAt: 0, revoked: {} };

    const result = await syncVip({ rule: null, days: [{ [ASH]: row('Ash', 7) }], state, now: NOW, rcon, log });

    expect(rcon.put).toHaveBeenCalledWith({ revision: '4', writable: true, text: settings });
    expect(result).toEqual({ state: { granted: {}, checkedAt: NOW, revoked: {} }, added: [], renewed: [] });
  });

  it('writes nothing when nothing changed', async () => {
    const rcon = server();

    await syncVip({ rule, days: [], state: parseVipState(undefined), now: NOW, rcon, log });

    expect(rcon.validate).not.toHaveBeenCalled();
    expect(rcon.put).not.toHaveBeenCalled();
  });

  it('writes nothing when the server would refuse or ignore the change', async () => {
    const refusing = server();
    refusing.validate.mockResolvedValueOnce({ ok: false, errors: ['bad value'], ignored: [] });
    const ignoring = server();
    ignoring.validate.mockResolvedValueOnce({ ok: true, errors: [], ignored: ['DefaultReservedPlayerIds (launch argument)'] });
    const readOnly = server(settings, { writable: false });

    for (const [rcon, message] of [
      [refusing, /refused the change: bad value/],
      [ignoring, /ignores DefaultReservedPlayerIds/],
      [readOnly, /read-only/],
    ] as const) {
      await expect(syncVip({ rule, days: earned, state: parseVipState(undefined), now: NOW, rcon, log })).rejects.toThrow(message);
      expect(rcon.put).not.toHaveBeenCalled();
    }
  });
});

describe('addVip and removeVip', () => {
  const server = (text = settings) => {
    const accepted: ConfigResult = { ok: true, errors: [], ignored: [] };
    return {
      fetchConfig: vi.fn(async (): Promise<ServerConfig> => ({ revision: '4', writable: true, text })),
      validate: vi.fn(async (_text: string) => accepted),
      put: vi.fn(async (_config: ServerConfig) => accepted),
    };
  };
  const empty = parseVipState(undefined);

  it('adds a player for the days asked, lifting any block', async () => {
    const rcon = server();
    const state = { ...empty, revoked: { [ASH]: NOW + DAY } };

    const result = await addVip({ steamId: ASH, name: 'Ash', days: 30, now: NOW, state, rcon });

    expect(rcon.put).toHaveBeenCalledWith({ revision: '4', writable: true, text: editReserved(settings, [ASH], []) });
    expect(result).toEqual({
      state: { ...empty, granted: { [ASH]: { name: 'Ash', grantedAt: NOW, expiresAt: NOW + 30 * DAY } } },
      outcome: 'added',
      until: NOW + 30 * DAY,
    });
  });

  it('extends a player the bot already gave VIP, never shortening it', async () => {
    const rcon = server(editReserved(settings, [ASH], []));
    const state = { ...empty, granted: { [ASH]: { name: 'Ash', grantedAt: NOW - DAY, expiresAt: NOW + 6 * DAY } } };

    const longer = await addVip({ steamId: ASH, name: 'Ash', days: 30, now: NOW, state, rcon });
    const shorter = await addVip({ steamId: ASH, name: 'Ash', days: 1, now: NOW, state, rcon });

    expect(rcon.put).not.toHaveBeenCalled();
    expect(longer).toMatchObject({ outcome: 'extended', until: NOW + 30 * DAY });
    expect(longer.state.granted[ASH]).toEqual({ name: 'Ash', grantedAt: NOW - DAY, expiresAt: NOW + 30 * DAY });
    expect(shorter).toMatchObject({ outcome: 'extended', until: NOW + 6 * DAY });
  });

  it('leaves a player an admin reserved by hand alone, but lifts a block from /vip remove', async () => {
    const rcon = server();
    const blocked = { ...empty, revoked: { [ADMIN]: NOW + DAY } };

    expect(await addVip({ steamId: ADMIN, name: 'Admin', days: 7, now: NOW, state: empty, rcon })).toEqual({
      state: empty,
      outcome: 'already-reserved',
    });
    expect(await addVip({ steamId: ADMIN, name: 'Admin', days: 7, now: NOW, state: blocked, rcon })).toEqual({
      state: empty,
      outcome: 'already-reserved',
    });
    expect(rcon.put).not.toHaveBeenCalled();
  });

  it('removes a player from the list and blocks automatic VIP for a week', async () => {
    const rcon = server(editReserved(settings, [ASH], []));
    const state = { ...empty, granted: { [ASH]: { name: 'Ash', grantedAt: NOW, expiresAt: NOW + 7 * DAY } } };

    const result = await removeVip({ steamId: ASH, now: NOW, state, rcon });

    expect(rcon.put).toHaveBeenCalledWith({ revision: '4', writable: true, text: settings });
    expect(result).toEqual({ state: { ...empty, revoked: { [ASH]: NOW + 7 * DAY } }, outcome: 'removed' });
  });

  it('removes an admin’s VIP too, and still blocks a player who was not on the list', async () => {
    const admin = server();
    const nobody = server();

    expect((await removeVip({ steamId: ADMIN, now: NOW, state: empty, rcon: admin })).outcome).toBe('removed');
    expect(admin.put).toHaveBeenCalledWith({ revision: '4', writable: true, text: settings.replace(`+DefaultReservedPlayerIds=${ADMIN}\n`, '') });
    const result = await removeVip({ steamId: BO, now: NOW, state: empty, rcon: nobody });
    expect(result).toEqual({ state: { ...empty, revoked: { [BO]: NOW + 7 * DAY } }, outcome: 'not-reserved' });
    expect(nobody.put).not.toHaveBeenCalled();
  });

  it('changes nothing when the server refuses the write', async () => {
    const rcon = server();
    rcon.validate.mockResolvedValueOnce({ ok: false, errors: ['bad value'], ignored: [] });

    await expect(addVip({ steamId: ASH, name: 'Ash', days: 7, now: NOW, state: empty, rcon })).rejects.toThrow(/refused/);
    expect(rcon.put).not.toHaveBeenCalled();
  });
});

describe('reservedListing', () => {
  it('lists everyone on the reserved list, the lines removing players, and the slots held back, whatever the file holds', () => {
    const text = [
      '[/Script/WDGame.WDGameSession]',
      'MaxReservedSlots=2',
      '+DefaultReservedPlayerIds=76561198000000001',
      'DefaultReservedPlayerIds="76561198000000002"',
      '-DefaultReservedPlayerIds=76561198000000003',
      '+DefaultReservedPlayerIds=76561198000000001',
      '[/Script/Other]',
      '+DefaultReservedPlayerIds=76561198000000009',
    ].join('\r\n');

    expect(reservedListing(text)).toEqual({
      ids: ['76561198000000001', '76561198000000002'],
      removals: ['-DefaultReservedPlayerIds=76561198000000003'],
      maxSlots: 2,
    });
    expect(() => reservedIds(text)).toThrow();
    expect(reservedListing('')).toEqual({ ids: [], removals: [], maxSlots: null });
  });
});
