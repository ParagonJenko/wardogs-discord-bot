import { z } from 'zod';
import type { DiscordCounts } from './stats.ts';

// Discord's public invite endpoint gives approximate member and online counts without a bot token.
const InviteSchema = z.object({
  guild: z.object({ name: z.string() }).nullish(),
  approximate_member_count: z.number().int(),
  approximate_presence_count: z.number().int(),
});

export const fetchInviteCounts = async (
  code: string,
  now: number,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<DiscordCounts> => {
  const response = await fetchFn(
    `https://discord.com/api/v10/invites/${encodeURIComponent(code)}?with_counts=true`,
    { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } },
  );
  if (!response.ok) {
    throw new Error(`Discord invite lookup failed: ${response.status}`);
  }
  const invite = InviteSchema.parse(await response.json());
  return {
    name: invite.guild?.name ?? null,
    members: invite.approximate_member_count,
    online: invite.approximate_presence_count,
    fetchedAt: now,
  };
};
