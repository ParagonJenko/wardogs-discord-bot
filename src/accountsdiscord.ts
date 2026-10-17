import { z } from 'zod';
import type { JoinOutcome } from './adminauth.ts';

// What the bot does in the server for a player's account, with its token: adds a player who asked to join, gives and takes
// the roles, checks that someone is a member, and sends the VIP messages. Every call throws on a failure it cannot name,
// and answers the ones it can.

const DISCORD_API = 'https://discord.com/api/v10';
const TIMEOUT_MS = 8_000;
// Discord's code for "Cannot send messages to this user".
const DMS_CLOSED = 50007;

const botCall = (botToken: string, fetchFn: typeof fetch, reason?: string) => (path: string, method: string, body?: unknown) =>
  fetchFn(`${DISCORD_API}${path}`, {
    method,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      authorization: `Bot ${botToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(reason === undefined ? {} : { 'x-audit-log-reason': encodeURIComponent(reason) }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

// Adds someone to the server with the access token they gave when they pressed "Sign in and join" (the `guilds.join`
// scope), and their linked role when there is one. Discord answers 201 for a member added and 204 for one already in. A
// server with membership screening on adds them as pending, until they accept its rules. 403 is a ban, or the bot not
// being allowed to invite.
export const addMember = async (
  botToken: string,
  guildId: string,
  userId: string,
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<JoinOutcome> => {
  const response = await botCall(botToken, fetchFn, 'Joined from the website')(`/guilds/${guildId}/members/${userId}`, 'PUT', {
    access_token: accessToken,
  });
  if (response.status === 201) return 'added';
  if (response.status === 204) return 'already';
  if (response.status === 403) return 'banned';
  throw new Error(`Discord refused to add a member: ${response.status} ${await response.text()}`);
};

// Whether someone is in the server. Null when the bot cannot tell.
export const isMember = async (botToken: string, guildId: string, userId: string, fetchFn: typeof fetch = fetch): Promise<boolean | null> => {
  const response = await botCall(botToken, fetchFn)(`/guilds/${guildId}/members/${userId}`, 'GET');
  if (response.ok) return true;
  if (response.status === 404) return false;
  console.error(`Player account: could not check if ${userId} is in server ${guildId}: ${response.status} ${await response.text()}`);
  return null;
};

// Gives or takes a role. 'gone' when they are not in the server (or the role is not), which is not an error: there is
// nothing to give them.
export const setRole = async (
  botToken: string,
  guildId: string,
  userId: string,
  roleId: string,
  on: boolean,
  fetchFn: typeof fetch = fetch,
): Promise<'done' | 'gone'> => {
  const response = await botCall(botToken, fetchFn, on ? 'Linked their account on the website' : 'No longer applies')(
    `/guilds/${guildId}/members/${userId}/roles/${roleId}`,
    on ? 'PUT' : 'DELETE',
  );
  if (response.ok) return 'done';
  if (response.status === 404) return 'gone';
  throw new Error(`Discord refused to ${on ? 'give' : 'take'} role ${roleId} in server ${guildId}: ${response.status} ${await response.text()}`);
};

// A private message. 'closed' when they do not take messages from the server's members.
export const sendDirectMessage = async (
  botToken: string,
  userId: string,
  content: string,
  fetchFn: typeof fetch = fetch,
): Promise<'sent' | 'closed'> => {
  const call = botCall(botToken, fetchFn);
  const opened = await call('/users/@me/channels', 'POST', { recipient_id: userId });
  if (!opened.ok) throw new Error(`Discord would not open a message to ${userId}: ${opened.status} ${await opened.text()}`);
  const { id } = z.object({ id: z.string() }).parse(await opened.json());
  const sent = await call(`/channels/${id}/messages`, 'POST', { content, allowed_mentions: { parse: [] } });
  if (sent.ok) return 'sent';
  const code = z.object({ code: z.number() }).safeParse(await sent.json().catch(() => null));
  if (sent.status === 403 && code.success && code.data.code === DMS_CLOSED) return 'closed';
  throw new Error(`Discord refused the message to ${userId}: ${sent.status}`);
};
