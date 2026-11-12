import { describe, expect, it } from 'vitest';
import { currentExperience, isModifier, modesFor, planSetup, setupLabels, type SetupCatalog } from '../src/matchsetup.ts';

const catalog: SetupCatalog = {
  rotation: {
    enabled: true,
    mode: 'ordered',
    entries: [
      {
        map: 'Kavkazi',
        status: 'now',
        experiences: ['Kavkazi_KOTH_01', 'KOTH_InfantryOnly'],
        lighting: 'DayClear',
        zoneAlternator: 'ZoneAlternator.Bakurani.Default.Circle',
      },
      { map: 'Europe', status: 'next', experiences: ['Europe_KOTH_01'], lighting: 'DayEarlyFog' },
    ],
  },
  mapExperiences: ['Kavkazi_KOTH_01', 'Kavkazi_KOTH_02', 'KOTH_InfantryOnly', 'KOTH_Hardcore', 'KOTH_LimitedGear'],
  experiences: [
    { id: 'Kavkazi_KOTH_01', name: 'King of the Hill' },
    { id: 'Kavkazi_KOTH_02', name: 'King of the Hill (small)' },
    { id: 'KOTH_InfantryOnly', name: 'Infantry only' },
    { id: 'KOTH_Hardcore', name: 'Hardcore' },
    { id: 'KOTH_LimitedGear', name: 'Limited gear' },
  ],
  lightings: [
    { id: 'DayClear', name: 'Day, clear' },
    { id: 'DayEarlyFog', name: 'Early, fog' },
  ],
  zones: [
    { id: 'ZoneAlternator.Bakurani.Default.Circle', name: 'Circle' },
    { id: 'ZoneAlternator.Bakurani.Default.Line', name: 'Line' },
  ],
};

describe('planSetup', () => {
  it('plays the map as the rotation does when nothing else is asked', () => {
    expect(planSetup('Kavkazi', { map: 'Kavkazi' }, catalog)).toEqual({
      setup: {
        experiences: ['Kavkazi_KOTH_01', 'KOTH_InfantryOnly'],
        lighting: 'DayClear',
        zoneAlternator: 'ZoneAlternator.Bakurani.Default.Circle',
      },
      labels: ['King of the Hill', 'Infantry only', 'Day, clear', 'Circle zones'],
    });
  });

  it('changes what staff asked, by id or name, and keeps the rest', () => {
    const planned = planSetup('Kavkazi', { mode: 'king of the hill (small)', infantry_only: 'false', hardcore: 'true', zones: 'Line' }, catalog);

    expect(planned).toEqual({
      setup: {
        experiences: ['Kavkazi_KOTH_02', 'KOTH_Hardcore'],
        lighting: 'DayClear',
        zoneAlternator: 'ZoneAlternator.Bakurani.Default.Line',
      },
      labels: ['King of the Hill (small)', 'Hardcore', 'Day, clear', 'Line zones'],
    });
  });

  it("uses the map's first mode for a map the rotation does not have", () => {
    const planned = planSetup('Kavkazi', { infantry_only: 'true' }, { ...catalog, rotation: null });

    expect(planned).toEqual({ setup: { experiences: ['Kavkazi_KOTH_01', 'KOTH_InfantryOnly'] }, labels: ['King of the Hill', 'Infantry only'] });
  });

  it('keeps limited gear from the rotation, and turns it on or off when asked', () => {
    const entry = { map: 'Kavkazi', status: 'now' as const, experiences: ['Kavkazi_KOTH_01', 'KOTH_InfantryOnly', 'KOTH_LimitedGear'] };
    const withGear: SetupCatalog = { ...catalog, rotation: { enabled: true, mode: 'ordered', entries: [entry] } };

    expect(planSetup('Kavkazi', {}, withGear)).toMatchObject({
      setup: { experiences: ['Kavkazi_KOTH_01', 'KOTH_InfantryOnly', 'KOTH_LimitedGear'] },
      labels: ['King of the Hill', 'Infantry only', 'Limited gear'],
    });
    expect(planSetup('Kavkazi', { limited_gear: 'false' }, withGear)).toMatchObject({ setup: { experiences: ['Kavkazi_KOTH_01', 'KOTH_InfantryOnly'] } });
    expect(planSetup('Kavkazi', { limited_gear: 'true' }, { ...catalog, rotation: null })).toMatchObject({
      setup: { experiences: ['Kavkazi_KOTH_01', 'KOTH_LimitedGear'] },
    });
  });

  it('refuses a mode, lighting or zone layout the server does not have', () => {
    expect(planSetup('Kavkazi', { mode: 'Capture the flag' }, catalog)).toEqual({
      problem: 'No game mode "Capture the flag" on this map. Pick one from the list.',
    });
    expect(planSetup('Kavkazi', { lighting: 'Night' }, catalog)).toEqual({ problem: 'No lighting "Night". Pick one from the list.' });
    expect(planSetup('Kavkazi', { zones: 'Square' }, catalog)).toEqual({
      problem: 'No zone layout "Square" on this map. Pick one from the list.',
    });
  });

  it("refuses a lighting the map can't be played with, but lets the rotation's own through", () => {
    const sabatulo: SetupCatalog = {
      ...catalog,
      rotation: { enabled: true, mode: 'ordered', entries: [{ map: 'Russia', status: 'next', lighting: 'DayEarlyFog' }] },
      lightings: [...(catalog.lightings ?? []), { id: 'DayLateRain', name: 'Afternoon, rain' }],
    };

    expect(planSetup('Russia', { lighting: 'Early, fog' }, sabatulo)).toEqual({ problem: "Early, fog can't be played on this map. Pick one from the list." });
    expect(planSetup('Russia', { lighting: 'daylaterain' }, sabatulo)).toMatchObject({ setup: { lighting: 'DayLateRain' } });
    expect(planSetup('Kavkazi', { lighting: 'DayEarlyFog' }, sabatulo)).toMatchObject({ setup: { lighting: 'DayEarlyFog' } });
  });

  it('refuses what staff typed when the server lists nothing for it, unlike when it could not be read', () => {
    const empty: SetupCatalog = { ...catalog, rotation: null, mapExperiences: [], lightings: [], zones: [] };

    expect(planSetup('Kavkazi', { zones: 'Circle' }, empty)).toEqual({
      problem: 'No zone layout "Circle" on this map. Pick one from the list.',
    });
    expect(planSetup('Kavkazi', { mode: 'Kavkazi_KOTH_01' }, empty)).toEqual({
      problem: 'No game mode "Kavkazi_KOTH_01" on this map. Pick one from the list.',
    });
    expect(planSetup('Kavkazi', { lighting: 'DayClear' }, empty)).toEqual({ problem: 'No lighting "DayClear". Pick one from the list.' });
    expect(planSetup('Kavkazi', {}, empty)).toEqual({ setup: {}, labels: [] });
  });

  it('sends what staff typed as it is when the catalogue could not be read', () => {
    const unknown: SetupCatalog = { rotation: null, mapExperiences: null, experiences: null, lightings: null, zones: null };

    expect(planSetup('Europe', { mode: 'Europe_KOTH_01', lighting: 'DayClear', hardcore: 'true' }, unknown)).toEqual({
      setup: { experiences: ['Europe_KOTH_01', 'KOTH_Hardcore'], lighting: 'DayClear' },
      labels: ['Europe_KOTH_01', 'Hardcore', 'Day, clear'],
    });
    expect(planSetup('Europe', {}, unknown)).toEqual({ setup: {}, labels: [] });
  });
});

describe('currentExperience', () => {
  it('swaps an experience Season 2 retired for its replacement, and leaves the rest', () => {
    expect(currentExperience('Bakurani_KOTH_01')).toBe('Bakurani_KOTH_02');
    expect(currentExperience('bakurani_koth_01')).toBe('Bakurani_KOTH_02');
    expect(currentExperience('Bakurani_KOTH_02')).toBe('Bakurani_KOTH_02');
    expect(currentExperience('Madrid_KOTH_01')).toBe('Madrid_KOTH_01');
    expect(currentExperience('constructor')).toBe('constructor');
    expect(currentExperience('__proto__')).toBe('__proto__');
  });

  it('plays a map the rotation still has with a retired mode with its replacement', () => {
    const unread: SetupCatalog = {
      rotation: { enabled: true, mode: 'ordered', entries: [{ map: 'Kavkazi', status: 'next', experiences: ['Bakurani_KOTH_01'] }] },
      mapExperiences: null,
      experiences: null,
      lightings: null,
      zones: null,
    };
    expect(planSetup('Kavkazi', {}, unread)).toEqual({ setup: { experiences: ['Bakurani_KOTH_02'] }, labels: ['Bakurani_KOTH_02'] });
  });
});

describe('modesFor', () => {
  it('lists the game modes of a map, not the modifiers', () => {
    expect(isModifier('KOTH_InfantryOnly')).toBe(true);
    expect(isModifier('KOTH_LimitedGear')).toBe(true);
    expect(isModifier('Kavkazi_KOTH_01')).toBe(false);
    expect(modesFor(catalog)).toEqual([
      { id: 'Kavkazi_KOTH_01', name: 'King of the Hill' },
      { id: 'Kavkazi_KOTH_02', name: 'King of the Hill (small)' },
    ]);
  });
});

describe('setupLabels', () => {
  it('names a setup from the catalogue, and a zone layout it does not know by the end of its tag', () => {
    const setup = { experiences: ['Kavkazi_KOTH_01', 'KOTH_Hardcore'], lighting: 'DayClear', zoneAlternator: 'ZoneAlternator.Bakurani.Default.Circle' };
    expect(setupLabels(setup, { experiences: [{ id: 'Kavkazi_KOTH_01', name: 'King of the Hill' }], lightings: null, zones: null })).toEqual([
      'King of the Hill',
      'Hardcore',
      'Day, clear',
      'Circle zones',
    ]);
    expect(setupLabels({}, { experiences: null, lightings: null, zones: null })).toEqual([]);
  });
});
