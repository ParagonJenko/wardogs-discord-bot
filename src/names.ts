// Names for what the server lists by id only. A catalogue item without a display name (or one that is just its id) is shown
// by one of these instead of by its id, so DayStartClear reads "Dawn, clear" and ZoneAlternator.Bakurani.Default.Circle
// reads "Circle". A name the server does give is always kept.

const words = (text: string): string[] =>
  text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_]+/)
    .filter((w) => w !== '');

const capital = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

// The time of day each part after the leading Day stands for.
const TIME_PARTS: Record<string, string> = { start: 'Dawn', early: 'Morning', late: 'Afternoon', end: 'Dusk' };
const WEATHER_PARTS: Record<string, string> = { gray: 'overcast', grey: 'overcast' };

// "DayStartClear" is "Dawn, clear", "DayLateGrayFog" "Afternoon, overcast, fog" and "DayClear" "Day, clear". An id that does
// not begin with Day goes by its words ("NightStorm" is "Night, storm").
export const lightingName = (id: string): string => {
  const [first, ...rest] = words(id);
  if (first === undefined) return id;
  const isDay = first.toLowerCase() === 'day';
  const time = isDay && rest.length > 0 ? TIME_PARTS[rest[0]!.toLowerCase()] : undefined;
  const weather = (time === undefined ? rest : rest.slice(1)).map((w) => WEATHER_PARTS[w.toLowerCase()] ?? w.toLowerCase());
  return [time ?? capital(first), ...weather].join(', ');
};

// "ZoneAlternator.Bakurani.Default.Circle" is "Circle"; a layout in a variant that is not Default keeps it
// ("ZoneAlternator.Bakurani.Night.NorthSouthLine" is "Night North South Line").
export const zoneLayoutName = (tag: string): string => {
  const parts = tag.split('.');
  const layout = parts[0] === 'ZoneAlternator' && parts.length >= 4 ? parts.slice(2) : parts.slice(-1);
  const name = layout
    .filter((p) => p.toLowerCase() !== 'default')
    .flatMap(words)
    .map(capital)
    .join(' ');
  return name === '' ? (parts.at(-1) ?? tag) : name;
};
