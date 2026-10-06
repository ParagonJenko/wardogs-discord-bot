import { z } from 'zod';
import type { DiscordMessage } from './discord.ts';
import type { Rotation } from './rcon.ts';

// The live server status: one message in a channel of its own. The bot posts it through that channel's webhook
// once, then edits the same message on every check. If someone deletes it, the next check posts a new one.

// Which message is the live status, and which webhook posted it (only that webhook can edit it).
export type BoardRef = { webhookId: string; messageId: string };

const BoardRefSchema = z.object({ webhookId: z.string(), messageId: z.string() });

export const parseBoardRef = (raw: unknown): BoardRef | null => {
  const parsed = BoardRefSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

const webhookIdOf = (webhookUrl: string): string => /\/webhooks\/(\d+)\//.exec(webhookUrl)?.[1] ?? webhookUrl;

const PostedSchema = z.object({ id: z.string() });

// Edits the live status message, or posts it when there is none yet, it was deleted, or the webhook changed.
// Returns the message to edit next time.
export const showBoard = async (
  webhookUrl: string,
  message: DiscordMessage,
  ref: BoardRef | null,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<BoardRef> => {
  const webhookId = webhookIdOf(webhookUrl);
  const send = (url: string, method: 'POST' | 'PATCH') =>
    fetchFn(url, {
      signal: AbortSignal.timeout(timeoutMs),
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
    });

  if (ref !== null && ref.webhookId === webhookId) {
    const edited = await send(`${webhookUrl}/messages/${ref.messageId}`, 'PATCH');
    if (edited.ok) return ref;
    // Only a deleted message is replaced. Any other failure is tried again next check, so a Discord hiccup never
    // leaves two status messages in the channel.
    if (edited.status !== 404) throw new Error(`Discord webhook edit failed: ${edited.status} ${await edited.text()}`);
  }
  // `wait=true` makes Discord return the message, for its ID.
  const posted = await send(`${webhookUrl}?wait=true`, 'POST');
  if (!posted.ok) throw new Error(`Discord webhook failed: ${posted.status} ${await posted.text()}`);
  return { webhookId, messageId: PostedSchema.parse(await posted.json()).id };
};

// A map staff picked with /setnextmap or /changemap. The rotation does not show it, so the bot keeps it, with the
// map being played when it was picked.
export type StagedMap = { map: string; fromMap: string; at: number };

const StagedMapSchema = z.object({ map: z.string(), fromMap: z.string(), at: z.number() });

export const parseStagedMap = (raw: unknown): StagedMap | null => {
  const parsed = StagedMapSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

// Longer than any match, so a staged map that was never played (say the server restarted) is forgotten.
const STAGED_FOR_MS = 2 * 60 * 60_000;

// The map after this one: the one staff picked while it is still to come, otherwise the rotation's next.
// A picked map has been played once the server leaves the map it was picked on.
export const nextMap = (currentMap: string, staged: StagedMap | null, rotation: Rotation | null, now: number): string | null => {
  if (staged !== null && staged.fromMap === currentMap && now - staged.at < STAGED_FOR_MS) return staged.map;
  if (rotation === null) return null;
  // With the rotation off, the server plays the same map again.
  if (!rotation.enabled) return currentMap || null;
  return rotation.entries.find((e) => e.status === 'next')?.map ?? null;
};

// The rotation the live status read last, with the map and the rotation's place the server was on then. Kept in
// storage ('boardRotation'), as the Durable Object can sleep between checks.
export type ReadRotation = { map: string; index: number | null; at: number; rotation: Rotation };

const ReadRotationSchema = z.object({
  map: z.string(),
  index: z.number().int().nullable(),
  at: z.number(),
  rotation: z.object({
    enabled: z.boolean(),
    mode: z.string(),
    entries: z.array(
      z.object({
        map: z.string(),
        status: z.string().nullable(),
        experiences: z.array(z.string()).optional(),
        lighting: z.string().optional(),
        zoneAlternator: z.string().optional(),
      }),
    ),
  }),
});

// Null when nothing was saved yet, or it is unrecognisable: the rotation is then read again.
export const parseReadRotation = (raw: unknown): ReadRotation | null => {
  const parsed = ReadRotationSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

// Each RCON read can make the game server stutter, so the live status only reads the rotation again when the map or
// the rotation's place changes, and at least this often, as staff can change the rotation in game.
export const ROTATION_READ_MS = 15 * 60_000;

export const rotationReadDue = (read: ReadRotation | null, map: string, index: number | null, now: number): boolean =>
  read === null || read.map !== map || read.index !== index || now - read.at >= ROTATION_READ_MS;
