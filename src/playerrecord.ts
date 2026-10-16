import type { PlayerProfile } from './discord.ts';
import { isBotBan, type BanRecord } from './moderation.ts';

// What a player's VIP and ban are, from the bot's records and what the server says now, for /player and the staff page's
// player record. The server is the truth when it can be read; otherwise the bot's records are shown as only that.

// Their whitelist slot: a staff spot (`pending` until the next check puts it on the whitelist), VIP the bot gave until
// `until`, a permanent slot added by hand, none, or 'unknown' when the whitelist could not be read and the bot has no
// record. `checked` is false when the whitelist could not be read. `blockedUntil`: staff took VIP away, so automatic VIP
// is off for them until then; null when it is not.
export type PlayerVip = (
  | { kind: 'staff'; pending: boolean }
  | { kind: 'bot'; until: number }
  | { kind: 'permanent' | 'none' | 'unknown' }
) & { checked: boolean; blockedUntil: number | null };

export const playerVip = ({ record, reserved, now }: PlayerProfile): PlayerVip => {
  const blockedUntil = record.vipBlockedUntil !== null && record.vipBlockedUntil > now ? record.vipBlockedUntil : null;
  if (reserved === null) {
    if (record.staffSpot) return { kind: 'staff', pending: false, checked: false, blockedUntil };
    if (record.vip !== null) return { kind: 'bot', until: record.vip.expiresAt, checked: false, blockedUntil };
    return { kind: 'unknown', checked: false, blockedUntil };
  }
  if (record.staffSpot) return { kind: 'staff', pending: !reserved, checked: true, blockedUntil };
  if (record.vip !== null && reserved) return { kind: 'bot', until: record.vip.expiresAt, checked: true, blockedUntil };
  return { kind: reserved ? 'permanent' : 'none', checked: true, blockedUntil };
};

// Their ban: the bot's (who, when, why and until when, null for good), one made outside the bot with the server's reason,
// none, or 'unknown' when the ban list could not be read and the bot has none. A bot's ban is `waiting` when the server
// does not have it yet: the game only bans players in game, so the bot bans them when they next join. `checked` is false
// when the ban list could not be read.
export type PlayerBan =
  | { kind: 'bot'; reason: string; by: string; at: number; until: number | null; waiting: boolean; checked: boolean }
  | { kind: 'server'; reason: string | null; checked: true }
  | { kind: 'none'; checked: true }
  | { kind: 'unknown'; checked: false };

export const playerBan = ({ record, serverBan }: PlayerProfile): PlayerBan => {
  const ban = record.ban;
  const bots = (b: BanRecord, waiting: boolean, checked: boolean): PlayerBan => ({
    kind: 'bot',
    reason: b.reason,
    by: b.by,
    at: b.at,
    until: b.until,
    waiting,
    checked,
  });
  if (ban?.waiting && serverBan === null) return bots(ban, true, true);
  // A ban lifted by hand is gone even if the bot still has a record, and a ban made some other way since is not the
  // bot's.
  if (serverBan === null) return { kind: 'none', checked: true };
  if (serverBan === undefined) return ban === null ? { kind: 'unknown', checked: false } : bots(ban, false, false);
  if (ban !== null && isBotBan(serverBan.reason, ban)) return bots(ban, false, true);
  return { kind: 'server', reason: serverBan.reason || null, checked: true };
};

// Whether they are banned, as far as can be told.
export const isBanned = (profile: PlayerProfile): boolean => {
  const { kind } = playerBan(profile);
  return kind === 'bot' || kind === 'server';
};
