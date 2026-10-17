import { describe, expect, it } from 'vitest';
import { lightingName, zoneLayoutName } from '../src/names.ts';

describe('lightingName', () => {
  it("names the server's own lightings", () => {
    const names = Object.fromEntries(
      ['DayStartClear', 'DayEarlyClear', 'DayEarlyFog', 'DayClear', 'DayLateClear', 'DayLateGray', 'DayLateGrayFog', 'DayLateRain', 'DayEndClear'].map((id) => [id, lightingName(id)]),
    );
    expect(names).toEqual({
      DayStartClear: 'Dawn, clear',
      DayEarlyClear: 'Morning, clear',
      DayEarlyFog: 'Morning, fog',
      DayClear: 'Day, clear',
      DayLateClear: 'Afternoon, clear',
      DayLateGray: 'Afternoon, overcast',
      DayLateGrayFog: 'Afternoon, overcast, fog',
      DayLateRain: 'Afternoon, rain',
      DayEndClear: 'Dusk, clear',
    });
  });

  it('goes by the words of an id that does not begin with Day', () => {
    expect(lightingName('NightStorm')).toBe('Night, storm');
    expect(lightingName('DayRain')).toBe('Day, rain');
    expect(lightingName('Sunny')).toBe('Sunny');
    expect(lightingName('Dusk')).toBe('Dusk');
    expect(lightingName('')).toBe('');
  });
});

describe('zoneLayoutName', () => {
  it('names a layout by its end', () => {
    expect(zoneLayoutName('ZoneAlternator.Bakurani.Default.Circle')).toBe('Circle');
    expect(zoneLayoutName('ZoneAlternator.Ozeti.Default.NorthSouthLine')).toBe('North South Line');
    expect(zoneLayoutName('ZoneAlternator.Zestafona.Default.Circle_02')).toBe('Circle 02');
  });

  it('keeps a variant that is not Default', () => {
    expect(zoneLayoutName('ZoneAlternator.Bakurani.Night.Circle')).toBe('Night Circle');
  });

  it('copes with a tag of another shape', () => {
    expect(zoneLayoutName('Circle')).toBe('Circle');
    expect(zoneLayoutName('Maps.Default')).toBe('Default');
    expect(zoneLayoutName('ZoneAlternator.Bakurani.Default')).toBe('Default');
  });
});
