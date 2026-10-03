import { describe, expect, it } from 'vitest';
import {
  linkSteam,
  NOT_A_STEAM_ID,
  parseStaffProfiles,
  readProfileAction,
  readSteamId,
  staffSteamIds,
  unlinkSteam,
} from '../src/staffprofiles.ts';

const NOW = Date.UTC(2026, 9, 3, 12);
const SARGE = '340568148044414976';
const KESTREL = '100000000000000002';
const STEAM = '76561198000000001';
const OTHER = '76561198000000002';

describe('staff profiles', () => {
  it('reads what was saved, and nothing from anything else', () => {
    const profiles = { [SARGE]: { steamId: STEAM, name: 'Sarge', at: NOW } };

    expect(parseStaffProfiles(profiles)).toEqual(profiles);
    expect(parseStaffProfiles(undefined)).toEqual({});
    expect(parseStaffProfiles({ [SARGE]: { steamId: 1 } })).toEqual({});
  });

  it('reads a Steam64 ID, or the profile link it is in', () => {
    expect(readSteamId(` ${STEAM} `)).toBe(STEAM);
    expect(readSteamId(`https://steamcommunity.com/profiles/${STEAM}/`)).toBe(STEAM);
    expect(readSteamId(`steamcommunity.com/profiles/${STEAM}`)).toBe(STEAM);
    expect(readSteamId(`https://steamcommunity.com/profiles/${STEAM}/?l=english`)).toBe(STEAM);
    // A custom link, a Steam ID in another format, a friend code, and too few digits.
    expect(readSteamId('https://steamcommunity.com/id/sarge')).toBeNull();
    expect(readSteamId('STEAM_0:1:19999')).toBeNull();
    expect(readSteamId('39999')).toBeNull();
    expect(readSteamId('7656119800000000')).toBeNull();
    expect(readSteamId(`https://example.com/profiles/${STEAM}`)).toBeNull();
  });

  it('links a staff member, changes their link, and lists every linked Steam ID', () => {
    const linked = linkSteam({}, { id: SARGE, name: 'Sarge' }, STEAM, NOW);

    expect(linked).toEqual({ steamId: STEAM, profiles: { [SARGE]: { steamId: STEAM, name: 'Sarge', at: NOW } } });
    if (!('profiles' in linked)) throw new Error('not linked');
    const changed = linkSteam(linked.profiles, { id: SARGE, name: 'Sarge' }, `https://steamcommunity.com/profiles/${OTHER}`, NOW + 1);
    expect(changed).toEqual({ steamId: OTHER, profiles: { [SARGE]: { steamId: OTHER, name: 'Sarge', at: NOW + 1 } } });
    if (!('profiles' in changed)) throw new Error('not changed');
    expect([...staffSteamIds(changed.profiles)]).toEqual([OTHER]);
  });

  it('refuses what is not a Steam ID, and an account another staff member linked', () => {
    const profiles = { [SARGE]: { steamId: STEAM, name: 'Sarge', at: NOW } };

    expect(linkSteam(profiles, { id: KESTREL, name: 'Kestrel' }, 'sarge', NOW)).toEqual({ problem: NOT_A_STEAM_ID });
    expect(linkSteam(profiles, { id: KESTREL, name: 'Kestrel' }, STEAM, NOW)).toEqual({
      problem: 'That Steam account is already linked to Sarge. They can unlink it on the staff page.',
    });
    // Linking the same account again is fine.
    expect(linkSteam(profiles, { id: SARGE, name: 'Sarge' }, STEAM, NOW + 1)).toMatchObject({ steamId: STEAM });
  });

  it('unlinks one staff member, leaving the rest', () => {
    const profiles = {
      [SARGE]: { steamId: STEAM, name: 'Sarge', at: NOW },
      [KESTREL]: { steamId: OTHER, name: 'Kestrel', at: NOW },
    };

    expect(unlinkSteam(profiles, SARGE)).toEqual({ [KESTREL]: profiles[KESTREL] });
    expect(unlinkSteam(profiles, '1')).toEqual(profiles);
  });
});

describe('readProfileAction', () => {
  const request = (body: string, headers: Record<string, string> = {}) =>
    new Request('https://bot.example/api/admin/profile', { method: 'POST', body, headers });

  it('reads a link, and an unlink of their own or another staff member', async () => {
    expect(await readProfileAction(request(JSON.stringify({ action: 'link', steamId: STEAM })))).toEqual({ action: 'link', steamId: STEAM });
    expect(await readProfileAction(request(JSON.stringify({ action: 'unlink' })))).toEqual({ action: 'unlink' });
    expect(await readProfileAction(request(JSON.stringify({ action: 'unlink', userId: KESTREL })))).toEqual({
      action: 'unlink',
      userId: KESTREL,
    });
  });

  it('refuses anything else', async () => {
    expect(await readProfileAction(request('not json'))).toBeNull();
    expect(await readProfileAction(request(JSON.stringify({ action: 'delete' })))).toBeNull();
    expect(await readProfileAction(request(JSON.stringify({ action: 'unlink', userId: 'bot' })))).toBeNull();
    expect(await readProfileAction(request(JSON.stringify({ action: 'link', steamId: 'x'.repeat(2_000) })))).toBeNull();
  });
});
