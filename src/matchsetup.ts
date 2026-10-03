import type { CatalogItem, MatchSetup, Rotation } from './rcon.ts';

// What /setnextmap and /changemap stage: the map with a game mode, modifiers (infantry only, hardcore), lighting and
// control-zone layout. Anything staff leave out is what the rotation plays that map with.

// Modifiers are experiences too, played alongside a game mode. Each is a yes/no option.
export const MODIFIERS = [
  { option: 'infantry_only', name: 'Infantry only', pattern: /infantryonly/i, fallback: 'KOTH_InfantryOnly' },
  { option: 'hardcore', name: 'Hardcore', pattern: /hardcore/i, fallback: 'KOTH_Hardcore' },
] as const;

export const isModifier = (id: string): boolean => MODIFIERS.some((m) => m.pattern.test(id));

// What the server's catalogue knows, for checking what staff typed and for names. Null when it could not be read,
// and then what staff typed is sent as it is.
export type SetupCatalog = {
  rotation: Rotation | null;
  // The experience ids this map can be played with.
  mapExperiences: string[] | null;
  experiences: CatalogItem[] | null;
  lightings: CatalogItem[] | null;
  zones: CatalogItem[] | null;
};

export type PlannedSetup = { setup: MatchSetup; labels: string[] };

const nameOf = (id: string, items: CatalogItem[] | null): string => items?.find((i) => i.id === id)?.name ?? id;
// A layout the catalogue does not name goes by the end of its tag: ZoneAlternator.Bakurani.Default.Circle is "Circle".
const zoneName = (id: string, zones: CatalogItem[] | null): string => zones?.find((z) => z.id === id)?.name ?? id.split('.').at(-1) ?? id;

// The id for what staff typed or picked: an id, or a name, ignoring case. A list that could not be read (null) lets
// it through as typed; a list the server gave, even an empty one, is the only thing allowed.
const pick = (typed: string, items: CatalogItem[] | null): string | null => {
  const lower = typed.trim().toLowerCase();
  if (items === null) return typed.trim();
  return items.find((i) => i.id.toLowerCase() === lower || i.name.toLowerCase() === lower)?.id ?? null;
};

// What a setup is called, as names where the catalogue has them: "King of the Hill", "Infantry only", "Day, clear",
// "Circle zones".
export const setupLabels = (setup: MatchSetup, catalog: Pick<SetupCatalog, 'experiences' | 'lightings' | 'zones'>): string[] => {
  const experiences = setup.experiences ?? [];
  const mode = experiences.find((id) => !isModifier(id));
  return [
    ...(mode ? [nameOf(mode, catalog.experiences)] : []),
    ...MODIFIERS.filter((m) => experiences.some((id) => m.pattern.test(id))).map((m) => m.name),
    ...(setup.lighting ? [nameOf(setup.lighting, catalog.lightings)] : []),
    ...(setup.zoneAlternator ? [`${zoneName(setup.zoneAlternator, catalog.zones)} zones`] : []),
  ];
};

// The game modes a map can be played with, named.
export const modesFor = (catalog: Pick<SetupCatalog, 'mapExperiences' | 'experiences'>): CatalogItem[] =>
  (catalog.mapExperiences ?? []).filter((id) => !isModifier(id)).map((id) => ({ id, name: nameOf(id, catalog.experiences) }));

export const planSetup = (
  map: string,
  options: Record<string, string>,
  catalog: SetupCatalog,
): PlannedSetup | { problem: string } => {
  const entry = catalog.rotation?.entries.find((e) => e.map === map);
  const rotationMode = entry?.experiences?.find((id) => !isModifier(id));
  const modes = catalog.mapExperiences === null ? null : modesFor(catalog);

  const typedMode = options['mode']?.trim();
  const mode = typedMode ? pick(typedMode, modes) : (rotationMode ?? modes?.[0]?.id);
  if (mode === null) return { problem: `No game mode "${typedMode}" on this map. Pick one from the list.` };

  // Each modifier: on or off when staff said so, otherwise as the rotation has it.
  const modifiers = MODIFIERS.flatMap((m) => {
    const asked = options[m.option];
    const on = asked === undefined ? (entry?.experiences ?? []).some((id) => m.pattern.test(id)) : asked === 'true';
    if (!on) return [];
    const known = [...(catalog.mapExperiences ?? []), ...(catalog.experiences ?? []).map((e) => e.id)];
    return [known.find((id) => m.pattern.test(id)) ?? m.fallback];
  });

  const typedLighting = options['lighting']?.trim();
  const lighting = typedLighting ? pick(typedLighting, catalog.lightings) : entry?.lighting;
  if (lighting === null) return { problem: `No lighting "${typedLighting}". Pick one from the list.` };

  const typedZones = options['zones']?.trim();
  const zoneAlternator = typedZones ? pick(typedZones, catalog.zones) : entry?.zoneAlternator;
  if (zoneAlternator === null) return { problem: `No zone layout "${typedZones}" on this map. Pick one from the list.` };

  const experiences = [...(mode ? [mode] : []), ...modifiers];
  const setup: MatchSetup = {
    ...(experiences.length > 0 ? { experiences } : {}),
    ...(lighting ? { lighting } : {}),
    ...(zoneAlternator ? { zoneAlternator } : {}),
  };
  return { setup, labels: setupLabels(setup, catalog) };
};
