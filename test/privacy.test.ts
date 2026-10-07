import { describe, expect, it } from 'vitest';
import {
  makePrivate,
  makePublic,
  parsePrivateProfiles,
  PRIVATE_NAME,
  privateSteamIds,
  publicIdOf,
  publicNames,
  publicNamesBySteamId,
  publicPlayer,
} from '../src/privacy.ts';

const NOW = Date.UTC(2026, 9, 7, 12);
const ASH = '76561198000000001';
const VEX = '76561198000000002';
const SARGE = '340568148044414976';

describe('private profiles', () => {
  it('reads what was saved, and nothing from anything else', () => {
    const profiles = { [ASH]: { name: 'Ash', at: NOW, by: SARGE, byName: 'Sarge' } };

    expect(parsePrivateProfiles(profiles)).toEqual(profiles);
    expect(parsePrivateProfiles(undefined)).toEqual({});
    expect(parsePrivateProfiles({ [ASH]: { name: 1 } })).toEqual({});
  });

  it('makes a profile private once, and public again', () => {
    const hidden = makePrivate({}, { steamId: ASH, name: 'Ash' }, SARGE, 'Sarge', NOW);

    expect(hidden).toEqual({ [ASH]: { name: 'Ash', at: NOW, by: SARGE, byName: 'Sarge' } });
    if (hidden === null) throw new Error('not private');
    expect([...privateSteamIds(hidden)]).toEqual([ASH]);
    // Already private: it stays as it was.
    expect(makePrivate(hidden, { steamId: ASH, name: 'Ash2' }, 'unknown', undefined, NOW + 1)).toBeNull();
    expect(makePrivate({}, { steamId: VEX, name: 'Vex' }, SARGE, undefined, NOW)).toEqual({ [VEX]: { name: 'Vex', at: NOW, by: SARGE } });

    expect(makePublic(hidden, ASH)).toEqual({});
    expect(makePublic(hidden, VEX)).toBeNull();
  });

  it('names a private profile PRIVATE_NAME, with no id, and everyone else as they are', () => {
    const ids = new Map([
      [ASH, 'aaaaaaaaaaaa'],
      [VEX, 'bbbbbbbbbbbb'],
    ]);
    const idOf = publicIdOf(new Set([ASH]), (steamId) => ids.get(steamId));

    expect(idOf(ASH)).toBeNull();
    expect(idOf(VEX)).toBe('bbbbbbbbbbbb');
    expect(publicPlayer(ASH, 'Ash', idOf)).toEqual({ name: PRIVATE_NAME });
    expect(publicPlayer(VEX, 'Vex', idOf)).toEqual({ name: 'Vex', id: 'bbbbbbbbbbbb' });
    expect(publicPlayer('76561198000000003', 'New', idOf)).toEqual({ name: 'New' });
    // Rows saved before Steam IDs were kept have none to go by.
    expect(publicPlayer(undefined, 'Old', idOf)).toEqual({ name: 'Old' });
  });

  it('renames private profiles in rows for Discord, by Steam ID', () => {
    const hidden = new Set([ASH]);

    expect(publicNames([{ steamId: ASH, name: 'Ash', kills: 3 }, { steamId: VEX, name: 'Vex', kills: 2 }, { name: 'Old', kills: 1 }], hidden)).toEqual([
      { steamId: ASH, name: PRIVATE_NAME, kills: 3 },
      { steamId: VEX, name: 'Vex', kills: 2 },
      { name: 'Old', kills: 1 },
    ]);
    expect(publicNamesBySteamId({ [ASH]: { name: 'Ash', checks: 4 }, [VEX]: { name: 'Vex', checks: 2 } }, hidden)).toEqual({
      [ASH]: { name: PRIVATE_NAME, checks: 4 },
      [VEX]: { name: 'Vex', checks: 2 },
    });
  });
});
