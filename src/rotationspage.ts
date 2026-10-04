import { z } from 'zod';
import { mapName } from './discord.ts';
import { isModifier, MODIFIERS, modesFor } from './matchsetup.ts';
import type { CatalogItem, Rotation } from './rcon.ts';
import {
  DEFAULT_ROTATION,
  inSavedOrder,
  lastPutOnFirst,
  MAX_ROTATION_MAPS,
  MAX_ROTATIONS,
  plannedRotation,
  ROTATION_NAME_MAX,
  rotationToday,
  WEEKDAYS,
  type AppliedRotation,
  type RotationBook,
  type RotationDay,
  type RotationEdit,
  type RotationEntry,
  type RotationServer,
  type SavedRotation,
} from './rotations.ts';

// The staff page's Rotations tab: the saved rotations, the week, what is on the server now, and what maps can be played
// with, to build rotations from. Staff change them through the same edits as /rotations (see rotations.ts).

// A map, by the name players know it, with what it can be played with: its game modes, the modifiers it has (infantry
// only, hardcore) with the experience that turns each on, and its control-zone layouts.
export type MapChoice = {
  id: string;
  name: string;
  modes: CatalogItem[];
  modifiers: { key: string; name: string; id: string }[];
  zones: CatalogItem[];
};

// `experiences` names every mode and modifier the server knows, for entries the maps' lists leave out.
export type RotationCatalog = { maps: MapChoice[]; lightings: CatalogItem[]; experiences: CatalogItem[] };

// What the server's catalogue gave: per map, the experiences it can be played with and its zone layouts, each null when
// it could not be read.
export type CatalogParts = {
  maps: CatalogItem[];
  experiences: CatalogItem[] | null;
  lightings: CatalogItem[] | null;
  perMap: Map<string, { experiences: string[] | null; zones: CatalogItem[] | null }>;
};

export const buildCatalog = ({ maps, experiences, lightings, perMap }: CatalogParts): RotationCatalog => ({
  maps: maps.map((map) => {
    const own = perMap.get(map.id) ?? { experiences: null, zones: null };
    // A map whose list could not be read is offered every modifier.
    const known = own.experiences ?? [];
    return {
      id: map.id,
      name: mapName(map.id) !== map.id ? mapName(map.id) : map.name,
      modes: modesFor({ mapExperiences: own.experiences, experiences }),
      modifiers: MODIFIERS.flatMap((m) => {
        const id = own.experiences === null ? m.fallback : known.find((e) => m.pattern.test(e));
        return id === undefined ? [] : [{ key: m.option, name: m.name, id }];
      }),
      zones: own.zones ?? [],
    };
  }),
  lightings: lightings ?? [],
  experiences: experiences ?? [],
});

export type RotationsPage = {
  defaultName: string;
  // The hour (UTC) each day's rotation starts.
  hour: number;
  limits: { rotations: number; maps: number; name: number };
  today: RotationDay;
  weekdays: readonly string[];
  // Default first.
  rotations: SavedRotation[];
  // Each day's own rotation, Monday first; null plays Default.
  week: (string | null)[];
  // What each day plays: its own rotation, or Default. Null when there is neither.
  plan: (string | null)[];
  // The rotation the bot put on the server today, and whether the server has it yet.
  current: AppliedRotation | null;
  // The server's rotation as it reports it now, with the map being played and the next, in the order of the saved
  // rotation it is (the one the bot put on last, or else another); the bot writes it starting part-way round. Null
  // when it could not be read.
  server: { enabled: boolean; mode: string; entries: (RotationEntry & { status: string | null })[] } | null;
  catalog: RotationCatalog | null;
};

export const buildRotationsPage = ({
  book,
  today,
  hour,
  server,
  catalog,
}: {
  book: RotationBook;
  today: RotationDay;
  hour: number;
  server: Rotation | null;
  catalog: RotationCatalog | null;
}): RotationsPage => ({
  defaultName: DEFAULT_ROTATION,
  hour,
  limits: { rotations: MAX_ROTATIONS, maps: MAX_ROTATION_MAPS, name: ROTATION_NAME_MAX },
  today,
  weekdays: WEEKDAYS,
  rotations: [...book.rotations].sort((a, b) => Number(b.name === DEFAULT_ROTATION) - Number(a.name === DEFAULT_ROTATION)),
  week: book.week,
  plan: WEEKDAYS.map((_, weekday) => plannedRotation(book, { day: today.day, weekday })?.name ?? null),
  current: rotationToday(book, today),
  server:
    server === null
      ? null
      : {
          enabled: server.enabled,
          mode: server.mode,
          entries: inSavedOrder(
            server.entries.map(({ status, ...entry }) => ({ ...entry, status })),
            lastPutOnFirst(book),
          ),
        },
  catalog,
});

// What the page sends. Empty settings are left out, as the map's own.
const text = (max: number) => z.string().trim().max(max);
const EntryBody = z
  .object({
    map: text(64),
    experiences: z.array(text(128)).max(8).optional(),
    lighting: text(128).optional(),
    zoneAlternator: text(200).optional(),
  })
  .transform(({ map, experiences, lighting, zoneAlternator }): RotationEntry => {
    const ids = (experiences ?? []).filter((id) => id !== '');
    // The game mode first, as the server lists it, then the modifiers.
    const ordered = [...ids.filter((id) => !isModifier(id)), ...ids.filter(isModifier)];
    return {
      map,
      ...(ordered.length > 0 ? { experiences: ordered } : {}),
      ...(lighting ? { lighting } : {}),
      ...(zoneAlternator ? { zoneAlternator } : {}),
    };
  });

const name = text(64);

export const RotationActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), name, from: name.optional(), entries: z.array(EntryBody).max(MAX_ROTATION_MAPS) }),
  z.object({ action: z.literal('use'), name }),
  z.object({ action: z.literal('schedule'), days: z.array(z.number().int().min(0).max(6)).min(1).max(7), name: name.nullable() }),
  z.object({ action: z.literal('delete'), name }),
]);

export type RotationAction = z.infer<typeof RotationActionSchema>;

export const actionEdit = (action: RotationAction): RotationEdit => {
  if (action.action === 'save') {
    return { kind: 'save', name: action.name, entries: action.entries, ...(action.from === undefined ? {} : { from: action.from }) };
  }
  if (action.action === 'schedule') return { kind: 'schedule', days: [...new Set(action.days)], name: action.name };
  return { kind: action.action, name: action.name };
};

// The page after a change, with what the server did when the change put a rotation on it.
export type RotationsActionResult = { problem: string } | (RotationsPage & { outcome?: RotationServer });

// A rotation of 100 maps is about 15 KB.
export const ROTATIONS_BODY_BYTES = 65_536;

// A change from the page, or null when it is not one. The body is read a chunk at a time and dropped once past the
// limit, so one sent without a length is never held whole.
export const readRotationAction = async (request: Request, limit = ROTATIONS_BODY_BYTES): Promise<RotationAction | null> => {
  if (Number(request.headers.get('content-length') ?? 0) > limit) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  for (;;) {
    const read = reader === undefined ? { done: true as const } : await reader.read();
    if (read.done) break;
    size += read.value.byteLength;
    if (size > limit) {
      await reader?.cancel();
      return null;
    }
    chunks.push(read.value);
  }
  const body = new Uint8Array(size);
  chunks.reduce((at, chunk) => (body.set(chunk, at), at + chunk.byteLength), 0);
  try {
    const parsed = RotationActionSchema.safeParse(JSON.parse(new TextDecoder().decode(body)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};
