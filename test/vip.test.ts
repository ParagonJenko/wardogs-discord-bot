import { describe, expect, it, vi } from 'vitest';
import type { VipRule } from '../src/config.ts';
import type { PlayerDay, PlayerTotals } from '../src/players.ts';
import type { ConfigResult, ServerConfig } from '../src/rcon.ts';
import { editReserved, parseVipState, planVip, qualified, reservedIds, syncVip, vipDue, type VipGrant } from '../src/vip.ts';

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

    expect(plan).toEqual({ add: [{ steamId: ASH, name: 'Ash' }], remove: [], granted: { [ASH]: grant(NOW) } });
  });

  it('keeps VIP for the week even if the player stops seeding', () => {
    const granted = { [ASH]: grant(NOW - 6 * DAY) };

    expect(planVip([], [ASH], granted, NOW, rule)).toEqual({ add: [], remove: [], granted });
  });

  it('takes VIP away when the week is up, unless it was earned again', () => {
    const granted = { [ASH]: grant(NOW - 7 * DAY), [BO]: grant(NOW - 7 * DAY, 'Bo') };

    expect(planVip([{ steamId: BO, name: 'Bo' }], [ASH, BO], granted, NOW, rule)).toEqual({
      add: [],
      remove: [ASH],
      granted: { [BO]: grant(NOW, 'Bo') },
    });
  });

  it('forgets a player an admin took off the list, and adds them again only if they earned it', () => {
    const granted = { [ASH]: grant(NOW - DAY), [BO]: grant(NOW - DAY, 'Bo') };

    expect(planVip([{ steamId: BO, name: 'Bo' }], [], granted, NOW, rule)).toEqual({
      add: [{ steamId: BO, name: 'Bo' }],
      remove: [],
      granted: { [BO]: grant(NOW, 'Bo') },
    });
  });

  it('ignores anything that is not a Steam ID', () => {
    expect(planVip([{ steamId: 'bot-1', name: 'Bot' }], [], {}, NOW, rule).add).toEqual([]);
  });
});

describe('vipDue and parseVipState', () => {
  it('checks every 10 minutes, starting straight away', () => {
    const state = parseVipState(undefined);

    expect(state).toEqual({ granted: {}, checkedAt: 0 });
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

    const state = await syncVip({ rule, days: earned, state: parseVipState(undefined), now: NOW, rcon, log });

    expect(state).toEqual({ granted: { [ASH]: { name: 'Ash', grantedAt: NOW, expiresAt: NOW + 7 * DAY } }, checkedAt: NOW });
    const written = editReserved(settings, [ASH], []);
    expect(rcon.validate).toHaveBeenCalledWith(written);
    expect(rcon.put).toHaveBeenCalledWith({ revision: '4', writable: true, text: written });
    expect(log.info).toHaveBeenCalledWith(
      `VIP added: Ash (${ASH}). The server uses the new reserved list after its next restart.`,
    );
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
