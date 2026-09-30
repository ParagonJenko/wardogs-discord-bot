import { z } from 'zod';
import type { Embed } from './discord.ts';

// Discord slash commands arrive as signed HTTP POSTs to the Worker's URL ("Interactions Endpoint URL").

export const COMMANDS = [{ name: 'status', description: 'Show the WARDOGS server status', type: 1 }];

const PING = 1;
const APPLICATION_COMMAND = 2;
const PONG = 1;
const CHANNEL_MESSAGE = 4;
const DEFERRED_CHANNEL_MESSAGE = 5;
const EPHEMERAL = 64;

const InteractionSchema = z.object({
  type: z.number(),
  application_id: z.string(),
  token: z.string().optional(),
  data: z.object({ name: z.string() }).optional(),
});

type Reply = { content?: string; embeds?: Embed[]; allowed_mentions: { parse: never[] } };

type InteractionDeps = {
  publicKey: string;
  getStatusEmbed: () => Promise<Embed>;
  editReply: (applicationId: string, token: string, reply: Reply) => Promise<void>;
  log: { error: (message: string) => void };
};

export type InteractionResult = { status: number; body: unknown; followUp?: () => Promise<void> };

const encoder = new TextEncoder();

const fromHex = (hex: string): Uint8Array<ArrayBuffer> =>
  /^([0-9a-f]{2})+$/i.test(hex) ? Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16)) : new Uint8Array();

const verifySignature = async (publicKey: string, signature: string, timestamp: string, body: string) => {
  try {
    const key = await crypto.subtle.importKey('raw', fromHex(publicKey), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, fromHex(signature), encoder.encode(timestamp + body));
  } catch {
    return false;
  }
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const handleInteraction = async (
  body: string,
  signature: string | null,
  timestamp: string | null,
  deps: InteractionDeps,
): Promise<InteractionResult> => {
  if (!signature || !timestamp || !(await verifySignature(deps.publicKey, signature, timestamp, body))) {
    return { status: 401, body: { error: 'invalid request signature' } };
  }

  const parsed = InteractionSchema.safeParse(JSON.parse(body));
  if (!parsed.success) return { status: 400, body: { error: 'unrecognised interaction' } };
  const interaction = parsed.data;

  if (interaction.type === PING) return { status: 200, body: { type: PONG } };

  if (interaction.type === APPLICATION_COMMAND && interaction.data?.name === 'status' && interaction.token) {
    const token = interaction.token;
    // Discord allows 3 seconds for the first response and RCON can be slower, so defer and edit later.
    const followUp = async (): Promise<void> => {
      const reply: Reply = await deps.getStatusEmbed().then(
        (embed) => ({ embeds: [embed], allowed_mentions: { parse: [] } }),
        (error: unknown) => {
          deps.log.error(`/status failed: ${errorText(error)}`);
          return { content: "Couldn't reach the game server right now. Try again in a minute.", allowed_mentions: { parse: [] } };
        },
      );
      await deps.editReply(interaction.application_id, token, reply);
    };
    return { status: 200, body: { type: DEFERRED_CHANNEL_MESSAGE }, followUp };
  }

  return { status: 200, body: { type: CHANNEL_MESSAGE, data: { content: 'Unknown command.', flags: EPHEMERAL } } };
};

export const editOriginalReply =
  (fetchFn: typeof fetch = fetch) =>
  async (applicationId: string, token: string, reply: unknown): Promise<void> => {
    const response = await fetchFn(`https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reply),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Discord rejected the /status reply: ${response.status}`);
  };
