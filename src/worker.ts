import { connect } from 'cloudflare:sockets';
import { z } from 'zod';
import { DurableObject } from 'cloudflare:workers';
import { isQuiet, withSeedCall } from './alerts.ts';
import { loadConfig } from './config.ts';
import {
  castVote,
  chooseConditions,
  votePool,
  chooseWinner,
  closeDue,
  isOpen as isOpenVote,
  matchIsOver,
  canBeVoted,
  conditionOptions,
  weatherOptions,
  closeScoreFor,
  deleteVoteMessage,
  editVoteMessage,
  LAST_ZONES_KEY,
  MAP_VOTE_KEY,
  NOTE,
  openVote,
  parseLastZones,
  parseMapVote,
  parseRainRecord,
  parseRecentMaps,
  rainRecordFor,
  RAIN_KEY,
  voteLogLine,
  voteLogMessage,
  voteProblemMessage,
  parseVoteAlerts,
  withVoteAlert,
  VOTE_ALERTS_KEY,
  isRain,
  type RainRecord,
  mapIdOf,
  pickOptions,
  postVoteMessage,
  publicVote,
  outcomeWithZone,
  RECENT_MAPS_KEY,
  VOTE_SETUP_OPTIONS,
  voteLink,
  votingNow,
  voteMessage,
  voteOpenBroadcast,
  voteResultBroadcast,
  withPlayed,
  zoneForTry,
  type MapVote,
  type PublicVote,
  type VoteOutcome,
  type ZoneChoice,
} from './mapvote.ts';
import { planSetup } from './matchsetup.ts';
import { VOTE_OPTIONS_KEY, offMapIds, parseVoteOptions, withMap, withRain, type VoteOptions } from './voteoptions.ts';
import { BLOCKED_CIRCLES_KEY, blockCircle, blockedCircleIds, parseBlockedCircles, unblockCircle, type BlockedCircles } from './circles.ts';
import {
  infantryFromRotation,
  infantryMaps,
  isInfantryOnly,
  parseRestartWatch,
  playingEntry,
  RESTART_WATCH_KEY,
  settled,
  watchRestart,
} from './restartmap.ts';
import { runCommand, suggestOptions } from './commands.ts';
import { nextMap, parseBoardRef, parseReadRotation, parseStagedMap, rotationReadDue, showBoard, type ReadRotation, type StagedMap } from './board.ts';
import {
  ADMIN_DEFAULT_DAYS,
  ADMIN_PERIODS,
  adminStaffIds,
  adminSteamIds,
  buildAdminOverview,
  buildAdminPlayerRecord,
  riskySteamIds,
  staffFor,
  STEAM_ACCOUNTS_LISTED,
  steamPlayers,
  type AdminOverview,
  type AdminPlayerRecord,
  type AdminSteamSources,
} from './admin.ts';
import {
  forget,
  growth,
  linkedSteamIds,
  isMemberNow,
  steamLinks,
  linkWithProof,
  recordSignIn,
  setAlerts,
  setPrivate,
  syncAccounts,
  unlink,
  view as viewAccount,
  type ActionResult,
  type BookDeps,
  type BookStorage,
  type Growth,
  type SignInResult,
} from './accountbook.ts';
import {
  ACCOUNT_PREFIX,
  accountKey,
  LINK_NUDGES_KEY,
  parseAccount,
  RETURN_DAY_KEY,
  RETURN_PER_DAY,
  returnDue,
  returnText,
  type Account,
  nudgesDue,
  parseNudges,
  parseSteamLink,
  readAccountAction,
  readWebVote,
  steamLinkKey,
  withNudged,
  type AccountAction,
  type AccountView,
  type WebVote,
} from './accounts.ts';
import { addMember, isMember as botIsMember, sendDirectMessage, setRole } from './accountsdiscord.ts';
import { DISCORD_CLICKS_KEY, parseClicks, sourceOf, summarise as summariseClicks, withClick, type ClickSummary } from './discordclicks.ts';
import { steamLoginUrl, verifySteamClaim } from './steamopenid.ts';
import {
  ACCOUNT_PAGE,
  adminAuthConfig,
  type AdminAuthConfig,
  type JoinOutcome,
  type LoginState,
  ADMIN_PAGE,
  CALLBACK_PATH,
  CLEAR_LOGIN_COOKIE,
  createPlayerSession,
  createSession,
  createSteamProof,
  finishLogin,
  finishPlayerLogin,
  notSetUpText,
  peekState,
  readPlayerSession,
  readState,
  readSteamProof,
  siteOriginOf,
  readSession,
  returnAddress,
  startLogin,
} from './adminauth.ts';
import {
  buildFeedAlert,
  buildGriefAlert,
  buildHeadshotAlert,
  buildLiveStatus,
  buildModLogMessage,
  buildOutageAlert,
  buildRoundupMessage,
  buildSteamAlerts,
  buildVipMessage,
  luckOdds,
  mapName,
  postWebhook,
} from './discord.ts';
import { FEED_QUIET_MS, FEED_WATCH_KEY, observeFeed, parseFeedWatch } from './feedwatch.ts';
import { MATCH_FEED_KEY, NO_MATCH_FEED, parseMatchFeed, recordMatchFeed, type MatchFeed } from './matchfeed.ts';
import { TEAM_KILL_WARNING, griefDayKey, hasGrief, parseGriefDay, playerGrief, recordGrief, type GriefAlert } from './griefing.ts';
import {
  ADMIN_COMMAND_DEFINITIONS,
  checkOptions,
  deleteOriginalReply,
  editOriginalReply,
  failureText,
  handleInteraction,
  isAdminCommand,
  isCommandName,
  isOptionOf,
  sendPrivateFollowUp,
  type CommandReply,
  type CommandRequest,
  type Choice,
} from './interactions.ts';
import { fetchGuildCounts, fetchInviteCounts } from './invite.ts';
import {
  createSessions,
  JOIN_LOG_KEY,
  parseJoinLog,
  playerSessions,
  pruneSessions,
  recordJoins,
  recordPresence,
  SESSION_DAYS_KEPT,
  SESSIONS_PRUNED_KEY,
  writeSessions,
  type AdminSession,
  type JoinEvent,
  type JoinLog,
} from './joinlog.ts';
import { buildFunnel, type Funnel } from './funnel.ts';
import { createLifetime, dayPlayers, exportTable, firstStayDay, newPlayerDays, rebuildPlayers, readLifetime, readPublicLifetime, removeArchivedMatch, TABLE_NAMES, toCsv, writeDay, writePlayerDays, type DayInput, type Lifetime, type PublicLifetime, type TableName } from './lifetime.ts';
import { buildNewPlayers, type Cohort } from './newplayers.ts';
import { buildRetention, REMOVAL_AFTER_MS, sessionRows, type Removal, type Retention } from './retention.ts';
import type { Config } from './config.ts';
import type { DiscordMessage, SeederRow } from './discord.ts';
import {
  appendMod,
  BAN_LENGTHS,
  banChanges,
  banReason,
  expiredBans,
  isBotBan,
  modLogKey,
  parseBanBook,
  parseServerBans,
  joinWork,
  parseModLog,
  type BanRecord,
  type ModEntry,
  type ServerBan,
  type ServerBans,
} from './moderation.ts';
import {
  dayOfKey,
  leaderboard,
  matchRecord,
  matchRecordKey,
  parseMatchRecord,
  parsePlayerDay,
  playerDayKey,
  rankSeeders,
  recentDayKeys,
  recentSeeders,
  totals,
  recordActivity,
  recordMatchPlayers,
  recordSeed,
  unrecordMatchPlayers,
  withoutStaffSeeding,
  type MatchRecord,
  type PlayerDay,
  type PlayerTotals,
  type RankedPlayer,
  type SeedCredit,
} from './players.ts';
import type { Lines } from './lines.ts';
import {
  buildLinesPage,
  editLines,
  LINES_KEY,
  linesContext,
  parseSavedLines,
  readLinesAction,
  resolveLines,
  type LinesAction,
  type LinesActionResult,
  type LinesPage,
  type SavedLines,
} from './linespage.ts';
import type { OutageEvent } from './outages.ts';
import {
  buildChallengeMessage,
  buildPlayerOfMonthMessage,
  challengeFor,
  DRIVES_KEY,
  mostMvps,
  parseDrives,
  type Holder,
  type RoleOutcome,
  type StaleRole,
} from './drives.ts';
import {
  dueMilestone,
  foldDays,
  LIFETIME_SHARDS,
  LIFETIME_THROUGH_KEY,
  lifetimeKey,
  markTold,
  nearlyTopTen,
  parseShard,
  personalBests,
  shardOf,
  unfoldMatch,
  type LifetimeShard,
  type Milestone,
} from './achievements.ts';
import { feedRecordOf, type EndExtras } from './matchend.ts';
import { createFeedJoins, createJoinCheck, createMatchEndCheck, createPoller, JOIN_CHECK_MS, parseState, type StateStore } from './poller.ts';
import { discordLink, JOIN_WAIT_MS, leaderboardPlaces } from './messages.ts';
import {
  ALERT_LOG_KEY,
  buildReview,
  countAlert,
  logOutage,
  OUTAGE_LOG_KEY,
  parseAlertLog,
  parseOutageLog,
  type Review,
} from './review.ts';
import {
  buildProfile,
  directory,
  importIdKey,
  isIdKey,
  newIdKey,
  parseOnline,
  PLAYER_ID,
  publicId,
  type DayRecords,
  type OnlineNow,
  type OnlineSnapshot,
  type PlayerDirectory,
  type PlayerProfile,
} from './profiles.ts';
import {
  addBan,
  addRotationEntry,
  endMatch,
  fetchBans,
  fetchConfig,
  fetchExperiences,
  fetchLightings,
  fetchMapExperiences,
  fetchMaps,
  fetchPlayers,
  fetchRotation,
  fetchSnapshot,
  fetchRoutes,
  fetchStatus,
  fetchZones,
  isNotInGame,
  kickPlayer,
  messagePlayer,
  moveRotationEntry,
  putConfig,
  queueMap,
  RconError,
  removeBan,
  sendBroadcast,
  validateConfig,
  type HttpClient,
  type Rotation,
  type ServerConfig,
  type ServerStatus,
  type Snapshot,
} from './rcon.ts';
import {
  buildRoundup,
  dueRoundups,
  markPosted,
  parseRoundupsPosted,
  periodDays,
  periodFor,
  type FeedSources,
  type Period,
  type Roundup,
  type RoundupChoice,
} from './roundup.ts';
import {
  buildSeason,
  keptSeason,
  keptSteamIds,
  parseKeptSeason,
  publicSeason,
  SEASON,
  SEASON_KEY,
  SEASON_SETTLE_MS,
  seasonPeriod,
  type SeasonPage,
  type SeasonRoundup,
} from './season.ts';
import { socketHttp } from './socket-http.ts';
import {
  alertDue,
  assess,
  checksDue,
  fetchSteamChecks,
  parseSteamCheck,
  RECHECK_MS,
  RISK_LABELS,
  steamFacts,
  steamKey,
  STEAM_RETRY_MS,
  type SteamAlert,
  type SteamCheck,
  type SteamLookup,
} from './steam.ts';
import {
  fetchDiscordUser,
  LOOKUP_FAILURES_KEY,
  lookupsDue,
  noteStaffName,
  parseLookupFailures,
  parseStaffNames,
  STAFF_NAMES_KEY,
  withFailures,
  type StaffNames,
} from './staffnames.ts';
import {
  makePrivate,
  makePublic,
  parsePrivateProfiles,
  PRIVATE_PROFILES_KEY,
  privateSteamIds,
  publicIdOf,
  publicNames,
  publicNamesBySteamId,
  type PrivateProfiles,
} from './privacy.ts';
import { applyCheck, CHECKED_KEY, checkedToday, readCheckAction, type CheckAction, type Check } from './checked.ts';
import { applyDealt, DEALT_KEY, dealtLately, readDealtAction, type Dealt, type DealtAction } from './dealt.ts';
import {
  linkSteam,
  parseStaffProfiles,
  readProfileAction,
  STAFF_PROFILES_KEY,
  staffBySteam,
  staffSteamIds,
  unlinkSteam,
  type ProfileAction,
} from './staffprofiles.ts';
import {
  banKickReason,
  lookUpPlayer,
  PROFILE_DAYS,
  rulesNote,
  type BanRequest,
  type BanResult,
  type Named,
  type PlayerRecord,
  type StaffRecords,
  type VipAddResult,
  type VipRemoveResult,
} from './staff.ts';
import {
  DEFAULT_ROTATION,
  editRotations as editRotationBook,
  findRotation,
  hasDefault,
  parseRotationBook,
  planToday,
  putRotation,
  rotationDay,
  rotationEntries,
  rotationSlot,
  nextSlot,
  rotationToday,
  seedDefault,
  serverEntries,
  type RotationBook,
  type RotationEdit,
  type RotationEditResult,
  type RotationServer,
  type RotationEntry,
} from './rotations.ts';
import {
  canMoveEntries,
  parseVoteInsert,
  planInsert,
  moveInsert,
  planMove,
  RESTORE_DELAY_MS,
  restoreDue,
  rotationFacts,
  stillInserted,
  VOTE_INSERT_KEY,
  whyNoInsert,
  type InsertPlan,
  type VoteInsert,
} from './voteinsert.ts';
import {
  actionEdit,
  buildCatalog,
  buildRotationsPage,
  readRotationAction,
  type RotationAction,
  type RotationCatalog,
  type RotationsActionResult,
  type RotationsPage,
} from './rotationspage.ts';
import {
  dayOf,
  discordDue,
  namedSteamIds,
  parseStats,
  publicCurrentMatch,
  publicStats,
  recordDiscord,
  recordMatch,
  recordObservation,
  removeRecentMatch,
  type DiscordCounts,
  type Observation,
  type PublicStats,
  type RecentMatch,
  type SiteStats,
  type Thresholds,
} from './stats.ts';
import { teamBoard } from './teams.ts';
import { matchMap, settleWin, summarise, type MatchState } from './tracking.ts';
import {
  addVip,
  parseVipState,
  removeVip,
  reservedListing,
  seederVip,
  staffSpotsDue,
  syncVip,
  vipDue,
  type ReservedListing,
  type VipState,
} from './vip.ts';
import {
  FEED_PATH,
  feedAuthorized,
  feedKillsSince,
  isKill,
  isMatchEvent,
  MAX_FEED_BYTES,
  MIN_FEED_TOKEN,
  parseFeed,
  parsePlayerWeapons,
  parseWeaponDay,
  playerWeaponDays,
  playerWeaponsKey,
  recordPlayerWeapons,
  recordWeaponDay,
  weaponBoard,
  weaponDayKey,
  weaponHolders,
  weaponName,
  type FeedEvent,
  type FeedKill,
  type FeedMatchEvent,
  type FeedPresence,
  type WeaponDay,
} from './weapons.ts';
import {
  buildRulesPage,
  callDetail,
  countSent,
  editRules,
  judgeKills,
  kickText,
  parseRuleBreaks,
  parseRules,
  readRulesAction,
  ruleKills,
  RULE_BREAKS_KEY,
  RULES_KEY,
  warningText,
  type RulesAction,
  type RuleCall,
  type RulesActionResult,
  type RulesContext,
  type RulesPage,
  type WeaponRule,
} from './weaponrules.ts';
import { isCurrent, liveStats, liveSteamIds, parseLiveMatch, phaseOf, recordLive, type LiveMatch, type LiveSnapshot } from './live.ts';
import {
  adminFeed,
  alertedOn,
  buildAdminKills,
  buildPlayerKills,
  createKillDays,
  firstKillDay,
  headshotAlertsDue,
  HEADSHOTS_ALERTED_KEY,
  headshotsOn,
  KILL_DAYS_KEPT,
  KILL_DAYS_STORED,
  KILL_FEED_KEY,
  KILL_LISTS_CLEARED_KEY,
  loadKillDays,
  parseKillFeed,
  playerKillDays,
  pruneKillDays,
  readKillDays,
  recordKillDay,
  recordKillFeed,
  socketSession,
  STAFF_SOCKET_PROTOCOL,
  toStaffKills,
  withKillDays,
  writeKillDays,
  type AdminKills,
  type AdminPlayerKills,
  type HeadshotDay,
  type KillDaySummary,
  type Sql,
  type StaffKill,
  type StaffLiveMessage,
} from './killfeed.ts';

type Env = {
  WATCHER: DurableObjectNamespace<Watcher>;
  [key: string]: unknown;
};

const stringVars = (env: Env): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );

// Player accounts: how often a check gives roles and sends messages, and how long who is linked is remembered.
const ACCOUNTS_EVERY_MS = 5 * 60_000;

const SEEDERS_LISTED = 25;
// Recent matches are the last 10, so their records are among the newest few.
const MATCH_RECORDS_SEARCHED = 50;
// Durable Object storage writes at most 128 keys at once.
const RECORDS_PER_WRITE = 128;
const LEADERBOARD_DAYS = 30;
const LEADERBOARD_SIZE = 10;
// The weapons in /api/stats: the top this many over the leaderboard's days.
const WEAPONS_LISTED = 10;
// Kill feed events already counted, remembered so a batch the game sends again is not counted twice.
const EVENTS_REMEMBERED = 5_000;
// Live pages open at once, at most. Each is one WebSocket to the Durable Object.
const LIVE_VIEWERS = 500;
// The staff page's live kill feed: its sockets are tagged apart from the live page's, and fewer may be open.
const LIVE_TAG = 'live';
const STAFF_TAG = 'staff';
const STAFF_VIEWERS = 50;
// The Worker hands the Durable Object a signed-in staff page's socket at this address, which nothing outside reaches.
const STAFF_SOCKET_PATH = '/staff-socket';
const DAY_MS = 24 * 60 * 60_000;
// How far back staff can pick players who are not online.
const KNOWN_PLAYER_DAYS = 30;
// Suggestions must reach Discord within 3 seconds.
const SUGGEST_TIMEOUT_MS = 2_000;

// What maps can be played with is read again after this long.
const CATALOG_MS = 10 * 60_000;

// A server that stopped answering this recently is most likely slow, not down, so the live status is left as it was.
const OFFLINE_AFTER_MS = 3 * 60_000;

// The server's ban list is read at most this often, to see bans made or lifted outside the bot. Each RCON read can make
// the game server stutter, and those bans are rare. When it was last read is kept in storage ('bansReadAt'), as the
// Durable Object can sleep between checks.
const BAN_WATCH_MS = 10 * 60_000;

const withoutId = ({ steamId: _id, ...rest }: RankedPlayer): PlayerTotals => rest;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// What the Worker hands the Durable Object of a kill feed batch (see parseFeed).
type FeedRecord = { timeline: (FeedEvent | FeedMatchEvent)[]; presence: FeedPresence[] };

// Runs work one at a time, in the order it was asked for. A failure does not hold up what comes after it.
const oneAtATime = () => {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work);
    queue = run.catch(() => undefined);
    return run;
  };
};

// A single Durable Object holds the bot's state, so it survives between cron runs and is never read stale.
// Storage keys: 'state' (alerts, the match in progress and any outage), 'stats' (public, for /api/stats), the private
// player records: 'players:<UTC date>' (each player's totals that day) and 'match:<start time>' (each finished match),
// 'vip' (who the bot put on the whitelist, and until when), 'mod:<Steam ID>' (what staff did to that player through
// the bot), 'bans' (the bans the bot made, and when the timed ones end), 'board' (which Discord message is the live
// status), 'nextMap' (the map staff set to play next), 'playerIdKey' (the key for players' public ids), 'online' (who
// was in game at the last check that reached the server), 'seedCall' (when staff last sent /seednow), 'winsSettled'
// (set once the matches saved before settleWin have been put right), 'roundups' (the first day of the last week and
// month whose roundup went out), 'season:<number>' (the season roundup, kept once the season is over; see season.ts),
// and from the game's kill feed: 'weapons:<UTC date>' (every kill that day by weapon),
// 'playerWeapons:<Steam ID>' (that player's kills by weapon for each of their last 90 days), 'killFeedSince' (the
// UTC date of the first kill the feed sent), 'killFeedHeardAt' (when its last batch came), 'feedWatch' (whether it has
// gone quiet on a live server; see feedwatch.ts), 'live' (the match going on now, for the live page), 'matchFeed' (the
// match's latest state and result, as the game said them; see matchfeed.ts) and 'grief:<UTC date>'
// (team kills and suicides that day, for the staff page), 'serverBans' (the server's ban list at the last reading, to
// notice bans made or lifted outside the bot), 'bansReadAt' (when that was), 'boardRotation' (the server's rotation
// for the live status's next map, and when it was read), 'staffNames' (staff's names on Discord, by user ID, for the
// staff page), 'staffLookupsFailed' (when asking Discord about each of those last failed), 'staffProfiles' (the Steam
// account each staff member linked, by Discord user ID, so staff never count as seeders), 'steam:<Steam ID>' (what
// Steam said about that player's account, for risky accounts), 'rotations' (the saved map rotations, the week's plan
// and the rotation put on the server today), 'lines' (the in-game lines staff put in place of the bot's own, by list),
// 'weaponRules' (the weapons staff don't allow, and what the bot does about them; see weaponrules.ts), 'ruleBreaks'
// (today's kills with them), 'killFeed' (the server's latest kills, for the staff page), 'joinLog' (who joined and left
// the server, for the staff page; see joinlog.ts), 'headshotsAlerted' (who had a headshot alert today), 'checked' (the players staff
// checked today and found nothing to act on; see checked.ts), 'dealt' (the players staff dealt with on the Queue in the
// last 30 days; see dealt.ts), and for the alert review (see review.ts), 'alertLog' (the alerts posted each day) and 'outageLog' (the outages). Each player's
// kills by day, for the staff page and the roundups' awards, are in the SQLite database's kill_days table (see
// killfeed.ts), and each player's times on the server, for their history, in its sessions table.
export class Watcher extends DurableObject<Env> {
  // Live pages keep their WebSocket open with a ping now and then, answered without waking the object.
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // Bans, the whitelist and the map rotation all live in the server's settings file. Changes to them run one at a
  // time, so one never overwrites another, or the VIP state or the saved rotations, with what it read before the other
  // finished. Staff Steam accounts change in turn too, as the VIP updates read them.
  private serial = oneAtATime();
  // The alerts and /seednow run one at a time, so a check never sends the seeding alert while a seeding call is going out.
  private alerting = oneAtATime();
  // A roundup is posted by one check at a time, so two checks close together cannot both post it.
  private roundingUp = oneAtATime();
  // Steam checks, their alerts and /player's lookups run one at a time, so two checks close together cannot both post the
  // same account, and an older answer from Steam is never saved over a newer one.
  private steamChecking = oneAtATime();

  // The player records the website's pages read. Past days and finished matches only change through /removematch,
  // which clears them, so they are kept in memory and each read only fetches the last two days and any new matches.
  // The day before is fetched too, as a check that started before midnight may still be writing to it.
  private dayCache = new Map<string, PlayerDay>();
  private matchCache = new Map<string, MatchRecord>();
  // Steam ID → public id.
  private ids = new Map<string, string>();
  private idKey: Promise<CryptoKey> | null = null;
  // Saves reading 'winsSettled' on every check once it is set.
  private winsSettled = false;
  // Whether this instance has made sure the season roundup is kept (see keepSeason).
  private seasonLooked = false;
  // Kill feed event ids already counted, oldest first.
  private eventsSeen = new Set<string>();
  // Past days' weapons, like dayCache: only today's and yesterday's are read each time.
  private weaponDayCache = new Map<string, WeaponDay>();
  // Steam checks once read, by Steam ID; null for a player with none. Every write goes through saveSteam, so it is never
  // stale.
  private steamChecks = new Map<string, SteamCheck | null>();
  // After Steam fails or refuses, the checks wait until then.
  private steamRetryAt = 0;
  // What maps can be played with, for the staff page's rotations; it only changes with a game update.
  private rotationCatalog: { at: number; catalog: RotationCatalog } | null = null;
  // Staff's in-game lines, once read: every check that can send an in-game message needs them. Every write goes through
  // linesAction, so it is never stale.
  private savedLines: SavedLines | null = null;
  // The weapon rules, once read: every kill feed batch is checked against them. Every write goes through rulesAction, so
  // it is never stale.
  private savedRules: WeaponRule[] | null = null;
  // Kill feed batches are checked against the weapon rules one at a time, so two batches close together never count
  // one offence twice.
  private enforcing = oneAtATime();
  // The staff page's kill days, by UTC day, read once: recordKillDays keeps each day read in step with what it writes,
  // so the checks each minute read none.
  private killDayCache = new Map<string, KillDaySummary[]>();
  // Whether the kill_days table is known to be there, and the UTC day its old rows were last deleted (noted in storage
  // too, see recordKillDays).
  private killTable = false;
  private killsPrunedOn: string | null = null;
  // The same for the sessions table.
  private sessionTable = false;
  private sessionsPrunedOn: string | null = null;
  // The long-term tables are made once, and the UTC day they were last brought up to.
  private lifetimeTables = false;
  private lifetimeRolledOn: string | null = null;
  // When a try was last made, so a day that can't be done yet (no player records, or a failure) is tried hourly, not every check.
  private lifetimeTriedAt: number | null = null;

  private rcon(): { config: Config; http: HttpClient } {
    return { config: loadConfig(stringVars(this.env)), http: socketHttp(connect) };
  }

  // ServerSettings.ini, which holds the whitelist and the map rotation.
  private settingsFile({ config, http }: { config: Config; http: HttpClient }) {
    return {
      fetchConfig: () => fetchConfig(config.rconUrl, config.rconPassword, http),
      validate: (text: string) => validateConfig(config.rconUrl, config.rconPassword, text, http),
      put: (serverConfig: ServerConfig) => putConfig(config.rconUrl, config.rconPassword, serverConfig, http),
    };
  }

  // The Steam accounts staff linked (see staffprofiles.ts). Their time counts as playing, never seeding.
  private async staffSteam(): Promise<Set<string>> {
    return staffSteamIds(parseStaffProfiles(await this.ctx.storage.get(STAFF_PROFILES_KEY)));
  }

  // The players whose profiles are private (see privacy.ts): the public never sees their names.
  private async privateSteam(): Promise<Set<string>> {
    return privateSteamIds(parsePrivateProfiles(await this.ctx.storage.get(PRIVATE_PROFILES_KEY)));
  }

  // Adds to a player's log, and changes their ban (null lifts it), the VIP state or the bot's copy of the server's ban
  // list (`serverBan`: the ban the bot just put on the server, or null for one it lifted) in the same write. The bot's
  // own bans go on that copy as it makes them, so the next check does not take them for bans made outside the bot.
  // Every entry then goes to the moderation log channel, unless `quiet`.
  private async record(
    steamId: string,
    entry: ModEntry | null,
    change: { ban?: BanRecord | null; vip?: VipState; serverBan?: ServerBan | null; quiet?: boolean } = {},
  ): Promise<void> {
    const key = modLogKey(steamId);
    const stored = await this.ctx.storage.get([key, 'bans', 'serverBans']);
    const { [steamId]: _old, ...others } = parseBanBook(stored.get('bans'));
    // Before the first check has read the server's list there is no copy to change.
    const serverBans = change.serverBan === undefined ? null : parseServerBans(stored.get('serverBans'));
    const { [steamId]: _was, ...otherServerBans } = serverBans ?? {};
    await this.ctx.storage.put({
      ...(entry === null ? {} : { [key]: appendMod(parseModLog(stored.get(key)), entry) }),
      ...(change.ban === undefined ? {} : { bans: change.ban === null ? others : { ...others, [steamId]: change.ban } }),
      ...(change.vip === undefined ? {} : { vip: change.vip }),
      ...(serverBans === null || change.serverBan === undefined
        ? {}
        : { serverBans: change.serverBan === null ? otherServerBans : { ...otherServerBans, [steamId]: change.serverBan } }),
    });
    if (entry !== null && change.quiet !== true) this.postModLog(steamId, entry);
  }

  // Where the moderation log goes. A configuration problem only stops the posts: what they report is saved already.
  private posting(): Pick<Config, 'modLogWebhookUrl' | 'griefAlerts' | 'steamAlerts' | 'headshotAlerts' | 'outageAlerts' | 'siteUrl'> {
    try {
      return loadConfig(stringVars(this.env));
    } catch (error) {
      console.error(`Moderation log: ${errorText(error)}`);
      return {
        modLogWebhookUrl: undefined,
        griefAlerts: false,
        steamAlerts: false,
        headshotAlerts: false,
        outageAlerts: false,
        siteUrl: undefined,
      };
    }
  }

  // Counts posts for the review (see review.ts), one at a time so no count is lost. A failure only loses the count.
  private counting = oneAtATime();
  private countAlert(kind: string, at: number, count = 1): Promise<void> {
    return this.counting(async () => {
      const log = parseAlertLog(await this.ctx.storage.get(ALERT_LOG_KEY));
      await this.ctx.storage.put(ALERT_LOG_KEY, countAlert(log, kind, at, count));
    }).catch((error: unknown) => console.error(`Counting a ${kind} alert failed: ${errorText(error)}`));
  }

  // An outage confirmed or over (see outages.ts): logged for the review, and posted to the moderation log channel when
  // OUTAGE_ALERTS is on, in the background, so a slow Discord never holds up the check.
  private async tellOutage(event: OutageEvent): Promise<void> {
    const { outage } = event;
    const log = parseOutageLog(await this.ctx.storage.get(OUTAGE_LOG_KEY));
    await this.ctx.storage.put(OUTAGE_LOG_KEY, logOutage(log, event));
    const what = event.type === 'down' ? 'confirmed' : event.refilled ? 'over' : 'not over after the wait, no longer watched';
    console.info(`Outage ${what}: ${outage.kind} from ${new Date(outage.at).toISOString()}, ${outage.before} players before`);
    const { modLogWebhookUrl, outageAlerts, siteUrl } = this.posting();
    if (modLogWebhookUrl === undefined || !outageAlerts) return;
    this.ctx.waitUntil(
      postWebhook(modLogWebhookUrl, buildOutageAlert(event, siteUrl))
        .then(() => this.countAlert(event.type === 'down' ? 'down' : 'up', event.at))
        .catch((error: unknown) => console.error(`Outage alert failed: ${errorText(error)}`)),
    );
  }

  // Posted in the background, so a slow Discord never holds up a ban or the VIP update queued behind it. A post that
  // fails is logged, not retried: the staff history has the entry either way.
  private postModLog(steamId: string, entry: ModEntry): void {
    const { modLogWebhookUrl, siteUrl } = this.posting();
    if (modLogWebhookUrl === undefined) return;
    this.ctx.waitUntil(
      postWebhook(modLogWebhookUrl, buildModLogMessage(steamId, entry, siteUrl)).catch((error: unknown) =>
        console.error(`Moderation log post failed (${entry.action} ${steamId}): ${errorText(error)}`),
      ),
    );
  }

  // Possible griefing, to the moderation log channel, when GRIEF_ALERTS is on, with the player's Steam account when it is
  // risky. Steam is not asked: the saved check is used, as the bot checks everyone in game. In the background, so a slow
  // read or Discord never holds up the kill feed.
  private postGriefAlerts(alerts: GriefAlert[]): void {
    const { modLogWebhookUrl, griefAlerts, siteUrl } = this.posting();
    for (const alert of alerts) {
      console.info(
        `Possible griefing: ${JSON.stringify(alert.name)} (${alert.steamId}) has ${alert.teamKills} team kills and ` +
          `${alert.vehicleSuicides} vehicle suicides today`,
      );
    }
    if (modLogWebhookUrl === undefined || !griefAlerts) return;
    this.ctx.waitUntil(
      (async () => {
        const steam = await this.savedSteam(alerts.map((a) => a.steamId));
        await Promise.all(
          alerts.map((alert) =>
            postWebhook(modLogWebhookUrl, buildGriefAlert(alert, weaponName, siteUrl, steam.get(alert.steamId) ?? null))
              .then(() => this.countAlert('grief', Date.now()))
              .catch((error: unknown) => console.error(`Griefing alert failed (${alert.steamId}): ${errorText(error)}`)),
          ),
        );
      })(),
    );
  }

  // Tells whoever just team killed that it is against the rules and to apologise in team chat, when TEAMKILL_WARNING is
  // on. In the background, once the game has its reply, so a slow server never holds up the feed. One that fails (the
  // player left) is logged, not tried again.
  private warnTeamKillers(killers: { steamId: string; name: string }[]): void {
    this.ctx.waitUntil(
      (async () => {
        const { config, http } = this.rcon();
        if (!config.teamKillWarning) return;
        const text = `${TEAM_KILL_WARNING} | ${rulesNote(config.siteUrl)}`;
        await Promise.all(
          killers.map(async (k) => {
            try {
              await messagePlayer(config.rconUrl, config.rconPassword, k.steamId, text, http);
            } catch (error) {
              console.error(`Team kill warning for ${JSON.stringify(k.name)} (${k.steamId}) failed: ${errorText(error)}`);
              return;
            }
            // In their history like a staff member's /warn, but not posted to the moderation log.
            await this.record(
              k.steamId,
              { action: 'warn', at: Date.now(), by: 'bot', name: k.name, reason: TEAM_KILL_WARNING, detail: 'Team kill' },
              { quiet: true },
            ).catch((error: unknown) => console.error(`Team kill warning log for ${k.steamId} failed: ${errorText(error)}`));
          }),
        );
      })().catch((error: unknown) => console.error(`Team kill warnings failed: ${errorText(error)}`)),
    );
  }

  private stateStore(): StateStore {
    const storage = this.ctx.storage;
    return {
      // A /seednow call is kept apart from 'state', so a check that saves 'state' never overwrites it.
      load: async () => {
        const stored = await storage.get(['state', 'seedCall']);
        const state = parseState(stored.get('state'));
        const calledAt = stored.get('seedCall');
        return state && typeof calledAt === 'number' ? { ...state, alerts: withSeedCall(state.alerts, calledAt) } : state;
      },
      save: (state) => storage.put('state', state),
    };
  }

  // While the server seeds, the seeding message goes out 30 seconds after someone joins. With the kill feed, its joins
  // set an alarm for then (see feedJoined). Without it, an alarm reads who is in game every few seconds between the
  // checks: the check starts them when it finds the server seeding, and they stop themselves once a check finds it is not.
  private async startJoinChecks(config: Config): Promise<void> {
    if (config.seedingMessages === null) return;
    try {
      const storage = this.ctx.storage;
      const state = parseState(await storage.get('state'));
      if (state?.alerts.phase !== 'seeding') return;
      const alarm = await storage.getAlarm();
      if ((await this.matchFeed()) !== null) {
        // A join the check saw, as of the player who starts the seed, which the feed said before the server was seeding.
        const waiting = state.joins?.lastJoinAt ?? null;
        const due = waiting === null ? null : Math.max(waiting + JOIN_WAIT_MS, Date.now() + 1_000);
        if (due !== null && (alarm === null || alarm > due)) await storage.setAlarm(due);
        return;
      }
      if (alarm === null) await storage.setAlarm(Date.now() + JOIN_CHECK_MS);
    } catch (error) {
      console.error(`Starting join checks failed: ${errorText(error)}`);
    }
  }

  // One quick join check. It runs with the alerts, so it never saves the state while a check is part-way through. With the
  // kill feed, the next is only for a seeding message still waiting, when it is due.
  async alarm(): Promise<void> {
    const { config, http } = this.rcon();
    const joinCheck = createJoinCheck({
      config,
      fetchPlayers: () => fetchPlayers(config.rconUrl, config.rconPassword, http),
      broadcast: (message) => sendBroadcast(config.rconUrl, config.rconPassword, message, http),
      now: Date.now,
      log: console,
      store: this.stateStore(),
      lines: () => this.lines(),
    });
    if (!(await this.alerting(joinCheck))) return;
    const storage = this.ctx.storage;
    if ((await this.matchFeed()) === null) {
      await storage.setAlarm(Date.now() + JOIN_CHECK_MS);
      return;
    }
    const waiting = parseState(await storage.get('state'))?.joins?.lastJoinAt ?? null;
    if (waiting !== null) await storage.setAlarm(Math.max(waiting + JOIN_WAIT_MS, Date.now() + 1_000));
  }

  // The kill feed's joins and leaves, while the server seeds (see createFeedJoins): the seeding message's alarm is set
  // for 30 seconds after the last join. A failure is only logged: the checks still see who joined.
  private async feedJoined(presence: FeedPresence[], at: number): Promise<void> {
    try {
      const { config } = this.rcon();
      const noteJoins = createFeedJoins({ config, log: console, store: this.stateStore() });
      const due = await this.alerting(() => noteJoins(presence, presence.at(-1)?.players ?? null, at));
      if (due === null) return;
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm > due) await this.ctx.storage.setAlarm(due);
    } catch (error) {
      console.error(`Kill feed joins failed: ${errorText(error)}`);
    }
  }

  // The kill feed's word on the match (see matchfeed.ts) while it is heard from: null without KILL_FEED_TOKEN, or once it
  // has sent nothing for FEED_QUIET_MS, as when it does not reach the bot. The checks then work out matches on their own.
  private async matchFeed(): Promise<MatchFeed | null> {
    const stored = await this.ctx.storage.get([MATCH_FEED_KEY, 'killFeedHeardAt']);
    return this.heardFeed(stored.get(MATCH_FEED_KEY), stored.get('killFeedHeardAt'), Date.now());
  }

  // The same, from what was read of 'matchFeed' and 'killFeedHeardAt'.
  private heardFeed(saved: unknown, heard: unknown, now: number): MatchFeed | null {
    if ((stringVars(this.env)['KILL_FEED_TOKEN']?.trim() ?? '') === '') return null;
    return typeof heard === 'number' && now - heard < FEED_QUIET_MS ? parseMatchFeed(saved) : null;
  }

  // The kill feed says a match ended: its end-of-match messages go out now, while players are still on the scoreboard
  // (see createMatchEndCheck). In the background, so the game has its reply at once, and with the checks, so it never
  // saves the state while one is part-way through.
  async matchEnded(): Promise<void> {
    const { config, http } = this.rcon();
    const endCheck = createMatchEndCheck({
      config,
      fetchSnapshot: () => fetchSnapshot(config.rconUrl, config.rconPassword, http),
      messagePlayer: (steamId, text) => messagePlayer(config.rconUrl, config.rconPassword, steamId, text, http),
      now: Date.now,
      log: console,
      store: this.stateStore(),
      lines: () => this.lines(),
      privateProfiles: () => this.privateSteam(),
      liveMatch: (match) => this.liveMatchOf(match),
      matchFeed: () => this.matchFeed(),
      endExtras: (match) => this.endExtras(match),
      milestonesTold: (told) => this.milestonesTold(told),
    });
    this.ctx.waitUntil(this.alerting(endCheck));
  }

  // The kill feed says the match is over (its end screen, or its result): the map vote's winner is put on the server now,
  // not at the next check, as the end screen only lasts about a minute. In the background, so the game has its reply at once.
  async voteMatchOver(): Promise<void> {
    const { config, http } = this.rcon();
    if (config.mapVote === null) return;
    this.ctx.waitUntil(
      fetchStatus(config.rconUrl, config.rconPassword, http)
        .then((status) => this.updateMapVote(config, { status, players: [] }))
        .catch((error: unknown) => console.error(`Map vote at the end of the match failed: ${errorText(error)}`)),
    );
  }

  // The kill feed's record of a match, for its awards (see feedRecordOf).
  private async liveMatchOf(match: MatchState): Promise<LiveMatch | null> {
    return feedRecordOf(parseLiveMatch(await this.ctx.storage.get('live')), match);
  }

  private async updateStats(change: (stats: SiteStats) => SiteStats): Promise<void> {
    const storage = this.ctx.storage;
    await storage.put('stats', change(parseStats(await storage.get('stats'))));
  }

  // One write for the site's stats, who is online, who joined or left, and today's player totals.
  private async recordCheck(observation: Observation, minutes: number, thresholds: Pick<Thresholds, 'live' | 'busy'>): Promise<void> {
    const dayKey = playerDayKey(observation.at);
    const stored = await this.ctx.storage.get(['stats', dayKey, 'online', JOIN_LOG_KEY]);
    const stats = recordObservation(parseStats(stored.get('stats')), observation, minutes, thresholds);
    const online: OnlineSnapshot = { at: observation.at, map: observation.status.map, players: observation.players };
    const joinLog = parseJoinLog(stored.get(JOIN_LOG_KEY));
    const joins = recordJoins(
      joinLog,
      observation.players,
      observation.status.players,
      observation.at,
      parseOnline(stored.get('online'))?.at ?? null,
    );
    const joined: Record<string, JoinLog> = joins.log === joinLog ? {} : { [JOIN_LOG_KEY]: joins.log };
    if (observation.phase === 'empty' || observation.players.length === 0) {
      await this.ctx.storage.put({ stats, online, ...joined });
    } else {
      const kind = observation.seeding ? 'seeding' : 'live';
      const day = recordActivity(parsePlayerDay(stored.get(dayKey)), observation.players, kind, minutes);
      await this.ctx.storage.put({ stats, online, ...joined, [dayKey]: day });
    }
    // Once the log is saved, so a check that failed before it is noted again by the next, and never twice.
    if (joins.added.length > 0) this.recordSessions(joins.added, observation.at);
  }

  // The SQLite database, with the History tab's sessions table, which is made the first time.
  private sessionSql(): Sql {
    const sql = this.ctx.storage.sql;
    if (!this.sessionTable) {
      createSessions(sql);
      this.sessionTable = true;
    }
    return sql;
  }

  // A row for each player who left, for their history, and once a day the ones no longer kept go. The prune reads
  // every row, and the object is put to sleep whenever it is idle for a few seconds, so the day is noted in storage too,
  // not just in memory. A failure is only logged, as the join log is saved already.
  private recordSessions(added: JoinEvent[], now: number): void {
    try {
      const sql = this.sessionSql();
      const day = dayOf(now);
      const kv = this.ctx.storage.kv;
      const prune = this.sessionsPrunedOn !== day && kv.get(SESSIONS_PRUNED_KEY) !== day;
      this.ctx.storage.transactionSync(() => {
        writeSessions(sql, added);
        if (prune) {
          pruneSessions(sql, Date.parse(dayOf(now - (SESSION_DAYS_KEPT - 1) * DAY_MS)));
          kv.put(SESSIONS_PRUNED_KEY, day);
        }
      });
      this.sessionsPrunedOn = day;
    } catch (error) {
      console.error(`Staff page session records failed: ${errorText(error)}`);
    }
  }

  private async recordSeed(seeders: SeedCredit[], at: number, minMinutes: number): Promise<void> {
    const dayKey = playerDayKey(at);
    await this.ctx.storage.put(dayKey, recordSeed(parsePlayerDay(await this.ctx.storage.get(dayKey)), seeders, minMinutes));
  }

  // The match, the recent matches list and the players' totals are written together, and only once per match. Gives
  // back when the match is recorded as ending, which is what the website names the match by, so a match recorded on an
  // earlier check gives that check's time. Null if what was saved cannot be read.
  private async recordMatchEnd(match: MatchState, at: number): Promise<number | null> {
    const key = matchRecordKey(match.startedAt);
    const dayKey = playerDayKey(at);
    const stored = await this.ctx.storage.get([key, 'stats', dayKey]);
    if (stored.has(key)) return parseMatchRecord(stored.get(key))?.endedAt ?? null;
    await this.ctx.storage.put({
      [key]: matchRecord(match, at),
      stats: recordMatch(parseStats(stored.get('stats')), summarise(match), at),
      [dayKey]: recordMatchPlayers(parsePlayerDay(stored.get(dayKey)), match),
    });
    return at;
  }

  // Matches saved before the bot settled a win the last check saw one point short (see settleWin) are put right once:
  // their records, for the player pages, and the recent matches. Only storage is awaited, so nothing else runs between
  // the reads and the writes. A failure is tried again on the next check.
  private async settleSavedWins(scoreToWin: number): Promise<void> {
    if (this.winsSettled) return;
    const storage = this.ctx.storage;
    try {
      if ((await storage.get('winsSettled')) !== undefined) {
        this.winsSettled = true;
        return;
      }
      let records = 0;
      let after: string | undefined;
      for (;;) {
        const page = await storage.list({
          prefix: 'match:',
          limit: RECORDS_PER_WRITE,
          ...(after === undefined ? {} : { startAfter: after }),
        });
        const settled = [...page].flatMap(([key, value]) => {
          const record = parseMatchRecord(value);
          if (record === null) return [];
          const factionScores = settleWin(record.factionScores, scoreToWin);
          return factionScores === record.factionScores ? [] : [[key, { ...record, factionScores }] as const];
        });
        if (settled.length > 0) await storage.put(Object.fromEntries(settled));
        records += settled.length;
        after = [...page.keys()].at(-1);
        if (page.size < RECORDS_PER_WRITE) break;
      }
      const stats = parseStats(await storage.get('stats'));
      const matches = stats.matches.map((m) => {
        const factionScores = settleWin(m.factionScores, scoreToWin);
        return factionScores === m.factionScores ? m : { ...m, factionScores };
      });
      const recent = matches.filter((m, i) => m !== stats.matches[i]).length;
      await storage.put({ ...(recent > 0 ? { stats: { ...stats, matches } } : {}), winsSettled: true });
      this.matchCache.clear();
      this.winsSettled = true;
      console.info(`Settled wins saved one point short: ${records} match records, ${recent} recent matches`);
    } catch (error) {
      console.error(`Settling saved wins failed: ${errorText(error)}`);
    }
  }

  async check(): Promise<void> {
    // The cron fires every minute whatever POLL_INTERVAL_SECONDS says, and seeding minutes are counted per check.
    const config = { ...loadConfig(stringVars(this.env)), pollIntervalMs: 60_000 };
    await this.settleSavedWins(config.scoreToWin);
    const storage = this.ctx.storage;
    const minutesPerCheck = config.pollIntervalMs / 60_000;
    // What this check read from the server, for the live status.
    const seen: { snapshot: Snapshot | null } = { snapshot: null };
    const poll = createPoller({
      config,
      fetchSnapshot: async () => (seen.snapshot = await fetchSnapshot(config.rconUrl, config.rconPassword, socketHttp(connect))),
      send: (message) => postWebhook(config.webhookUrl, message),
      broadcast: (message) => sendBroadcast(config.rconUrl, config.rconPassword, message, socketHttp(connect)),
      messagePlayer: (steamId, text) => messagePlayer(config.rconUrl, config.rconPassword, steamId, text, socketHttp(connect)),
      now: Date.now,
      log: console,
      store: this.stateStore(),
      lines: () => this.lines(),
      staff: () => this.staffSteam(),
      linked: () => this.linkedSteam(),
      ranks: () => this.leaderboardRanks(),
      nudges: () => this.linkNudges(),
      nudged: (steamIds) => this.linkNudged(steamIds),
      endExtras: (match) => this.endExtras(match),
      milestonesTold: (told) => this.milestonesTold(told),
      privateProfiles: () => this.privateSteam(),
      liveMatch: (match) => this.liveMatchOf(match),
      matchFeed: () => this.matchFeed(),
      voting: async (match) => votingNow(parseMapVote(await storage.get(MAP_VOTE_KEY)), match, Date.now()),
      outage: (event) => this.tellOutage(event),
      stats: {
        check: (observation) =>
          this.recordCheck(observation, minutesPerCheck, { live: config.rules.live, busy: config.busyThreshold }),
        seeded: (seeders, at) => this.recordSeed(seeders, at, config.seedMinutes),
        matchEnded: (match, at) => this.recordMatchEnd(match, at),
        alerted: (kind, at) => this.countAlert(kind, at),
      },
    });
    await this.alerting(poll);
    await this.startJoinChecks(config);
    await this.updateBoard(config, seen.snapshot);
    await this.serial(() => this.expireBans(config));
    await this.serial(() => this.applyWaitingBans(config, seen.snapshot));
    await this.serial(() => this.watchBans(config, seen.snapshot));
    await this.serial(() => this.rollupLifetime(Date.now()));
    await this.serial(() => this.updateVip(config));
    await this.keepAccounts(config);
    await this.askBack(config, seen.snapshot);
    // Before the rotation and the vote change it: they can write another entry into the slot the server is on.
    await this.serial(() => this.updateRestartMap(config, seen.snapshot));
    await this.serial(() => this.updateRotation(config, seen.snapshot));
    await this.updateMapVote(config, seen.snapshot);
    await this.steamChecking(() => this.checkSteam(seen.snapshot));
    await this.checkHeadshots(seen.snapshot);
    await this.watchFeed(config, seen.snapshot);

    const { inviteCode } = config;
    const { botToken } = config.accounts;
    const guildId = stringVars(this.env)['DISCORD_GUILD_ID']?.trim() ?? '';
    const asBot = botToken !== undefined && /^\d+$/.test(guildId);
    if ((asBot || inviteCode) && discordDue(parseStats(await storage.get('stats')), Date.now())) {
      try {
        // The bot's token first: the public invite is rate limited by IP, which a Worker shares, so it is the fallback.
        const counts = await this.discordCounts(asBot ? { botToken, guildId } : null, inviteCode);
        await this.updateStats((stats) => recordDiscord(stats, counts));
      } catch (error) {
        console.error(`Discord member count failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await this.roundingUp(() => this.postRoundups(config));
    await this.keepSeason();
    // Live pages get the new score, players and map.
    await this.broadcastLive();
  }

  private async discordCounts(bot: { botToken: string; guildId: string } | null, inviteCode: string | undefined): Promise<DiscordCounts> {
    if (bot === null) return fetchInviteCounts(inviteCode ?? '', Date.now());
    try {
      return await fetchGuildCounts(bot.botToken, bot.guildId, Date.now());
    } catch (error) {
      if (!inviteCode) throw error;
      console.error(`Discord member count: the server lookup failed, using the invite: ${error instanceof Error ? error.message : String(error)}`);
      return fetchInviteCounts(inviteCode, Date.now());
    }
  }

  // The roundup of the week or month just ended, once, from ROUNDUP_HOUR (UTC) on the first day of the next one. A post
  // that fails is tried again at the next check, until the end of that day.
  private async postRoundups(config: Config): Promise<void> {
    const rule = config.roundups;
    const now = Date.now();
    // Outside the hours a roundup can be due, storage is not read at all.
    if (rule === null || dueRoundups({}, now, rule.hour).length === 0) return;
    const storage = this.ctx.storage;
    try {
      let posted = parseRoundupsPosted(await storage.get('roundups'));
      for (const period of dueRoundups(posted, now, rule.hour)) {
        const label = `${period.kind === 'week' ? 'weekly' : 'monthly'} roundup from ${dayOf(period.start)}`;
        try {
          const roundup = await this.roundupFor(period, now);
          if (roundup !== null) await postWebhook(rule.webhookUrl, buildRoundupMessage(roundup, config.siteUrl));
          posted = markPosted(posted, period);
          await storage.put('roundups', posted);
          console.info(roundup === null ? `No ${label}: nobody played` : `Posted the ${label}`);
          // After the roundup is saved as posted, so a drive that fails never posts the roundup twice. It is not tried again.
          try {
            await this.postDrive(config, period, now, rule.webhookUrl);
          } catch (error) {
            console.error(`The ${period.kind === 'week' ? 'weekly challenge' : 'player of the month'} after the ${label} failed: ${errorText(error)}`);
          }
        } catch (error) {
          console.error(`The ${label} failed, trying again next check: ${errorText(error)}`);
        }
      }
    } catch (error) {
      console.error(`Roundups failed: ${errorText(error)}`);
    }
  }

  // After a roundup (see drives.ts): the player of the month after the monthly one, and the weekly challenge's winner and
  // the next challenge after the weekly one. Each winner's role moves to them.
  private async postDrive(config: Config, period: Period, now: number, webhookUrl: string): Promise<void> {
    const storage = this.ctx.storage;
    const [days, matches, hidden, stored] = await Promise.all([
      this.recentDays(now),
      this.matchRecords(now),
      this.privateSteam(),
      storage.get(DRIVES_KEY),
    ]);
    const covered = new Set(periodDays(period));
    const sources = {
      days: days.filter((d) => covered.has(d.day)).map((d) => d.players),
      matches: matches.filter((m) => m.endedAt >= period.start && m.endedAt < period.end),
    };
    const saved = parseDrives(stored);
    const drives = { ...saved, stale: await this.takeStaleRoles(config, saved.stale) };
    const { playerOfMonthRoleId, challengeRoleId } = config.drives;
    // Who holds a role is saved before the post, so a post that fails never loses track of who has it.
    if (period.kind === 'month') {
      const winner = mostMvps(sources);
      if (winner === null) {
        if (drives.stale.length !== saved.stale.length) await storage.put(DRIVES_KEY, drives);
        return;
      }
      const moved = await this.moveRole(config, playerOfMonthRoleId, drives.month, winner.steamId);
      await storage.put(DRIVES_KEY, { ...drives, month: moved.holder, stale: [...drives.stale, ...moved.stale] });
      await postWebhook(webhookUrl, buildPlayerOfMonthMessage(period.start, winner, hidden, moved.outcome, playerOfMonthRoleId, config.siteUrl));
      console.info(`Posted the player of the month: ${JSON.stringify(winner.name)} (${winner.steamId}), role ${moved.outcome}`);
      return;
    }
    // A winner only for a challenge people were told of.
    const last = drives.announced === dayOf(period.start) ? challengeFor(period.start) : null;
    const winner = last?.winner(sources) ?? null;
    const moved =
      last === null
        ? { holder: drives.challenge, outcome: 'none' as const, stale: [] }
        : await this.moveRole(config, challengeRoleId, drives.challenge, winner?.steamId ?? null);
    const held = { ...drives, challenge: moved.holder, stale: [...drives.stale, ...moved.stale] };
    await storage.put(DRIVES_KEY, held);
    const next = challengeFor(period.end);
    await postWebhook(
      webhookUrl,
      buildChallengeMessage(last === null ? null : { challenge: last, winner }, next, hidden, moved.outcome, challengeRoleId, config.siteUrl),
    );
    // Only once people were told of it, so its winner is named next week.
    await storage.put(DRIVES_KEY, { ...held, announced: dayOf(period.end) });
    console.info(`Posted the weekly challenge: ${next.id}${winner === null ? '' : `, last week's won by ${JSON.stringify(winner.name)} (${winner.steamId})`}`);
  }

  // The bot's token and the server, when it can give roles.
  private roleGiver(config: Config): { botToken: string; guildId: string } | null {
    const guildId = stringVars(this.env)['DISCORD_GUILD_ID']?.trim() ?? '';
    const { botToken } = config.accounts;
    return botToken === undefined || !/^\d+$/.test(guildId) ? null : { botToken, guildId };
  }

  // Tries again to take the roles Discord would not take before. Gives back those it still could not.
  private async takeStaleRoles(config: Config, stale: StaleRole[]): Promise<StaleRole[]> {
    const giver = this.roleGiver(config);
    if (giver === null || stale.length === 0) return stale;
    const left: StaleRole[] = [];
    for (const role of stale) {
      try {
        await setRole(giver.botToken, giver.guildId, role.userId, role.roleId, false);
      } catch (error) {
        console.error(`Taking role ${role.roleId} from ${role.userId} failed again: ${errorText(error)}`);
        left.push(role);
      }
    }
    return left;
  }

  // Moves a drive's role from whoever had it to the winner's linked Discord account (`steamId`; null takes it from them
  // and gives it to nobody). 'unlinked' when the winner has no linked account in the server. Without the bot's token or
  // the role, no role moves. A role Discord would not take is given back as `stale`, to try again.
  private async moveRole(
    config: Config,
    roleId: string | undefined,
    previous: Holder | null,
    steamId: string | null,
  ): Promise<{ holder: Holder | null; outcome: RoleOutcome; stale: StaleRole[] }> {
    const userId = steamId === null ? null : (parseSteamLink(await this.ctx.storage.get(steamLinkKey(steamId)))?.u ?? null);
    const holder = steamId === null ? null : { steamId, userId };
    const giver = this.roleGiver(config);
    if (roleId === undefined || giver === null) return { holder, outcome: 'none', stale: [] };
    const stale: StaleRole[] = [];
    if (previous?.userId != null && previous.userId !== userId) {
      try {
        await setRole(giver.botToken, giver.guildId, previous.userId, roleId, false);
      } catch (error) {
        console.error(`Taking role ${roleId} from ${previous.userId} failed, trying again after the next roundup: ${errorText(error)}`);
        stale.push({ userId: previous.userId, roleId });
      }
    }
    if (steamId === null) return { holder, outcome: 'none', stale };
    if (userId === null) return { holder, outcome: 'unlinked', stale };
    try {
      return { holder, outcome: (await setRole(giver.botToken, giver.guildId, userId, roleId, true)) === 'done' ? 'given' : 'unlinked', stale };
    } catch (error) {
      console.error(`Giving role ${roleId} to ${userId} failed: ${errorText(error)}`);
      return { holder, outcome: 'none', stale };
    }
  }

  // From the same records as the player pages, and the kill feed's for the awards. Null when nobody played in the
  // period.
  private async roundupFor(period: Period, now: number): Promise<Roundup | null> {
    const covered = periodDays(period);
    const [days, matches, hidden] = await Promise.all([this.recentDays(now), this.matchRecords(now), this.privateSteam()]);
    const feed = this.roundupFeed(covered, now);
    const ids = await this.idsFor([
      ...days.flatMap((d) => (covered.includes(d.day) ? Object.keys(d.players) : [])),
      ...(feed?.kills.map((d) => d.steamId) ?? []),
    ]);
    const idOf = publicIdOf(hidden, (steamId) => ids.get(steamId));
    return buildRoundup({ period, days, matches, idOf, ...(feed === null ? {} : { feed }) });
  }

  // The kill feed's records over a period's days. Null before the first kill, or if the database cannot be read, so
  // the roundup goes out without its awards.
  private roundupFeed(covered: string[], now: number): FeedSources | null {
    try {
      const sql = this.killSql();
      const since = firstKillDay(sql);
      if (since === null) return null;
      return { since, kills: [...this.killSummaries(sql, covered, now).values()].flat() };
    } catch (error) {
      console.error(`Roundup awards failed: ${errorText(error)}`);
      return null;
    }
  }

  // For /roundup.
  async roundup(choice: RoundupChoice): Promise<Roundup | null> {
    const now = Date.now();
    return this.roundupFor(periodFor(choice, now), now);
  }

  // The website's season page (see season.ts). The public gets the roundup once the season is over; staff (`early`) get
  // the season so far before that.
  async season(early = false): Promise<SeasonPage> {
    const now = Date.now();
    const open = now >= SEASON.endsAt;
    const page = { number: SEASON.number, name: SEASON.name, endsAt: SEASON.endsAt, open };
    if (!open && !early) return { ...page, roundup: null };
    const roundup = open ? await this.seasonOver(now) : await this.seasonRoundup(now);
    if (roundup === null) return { ...page, roundup: null };
    const ids = await this.idsFor(keptSteamIds(roundup));
    const idOf = publicIdOf(await this.privateSteam(), (steamId) => ids.get(steamId));
    return { ...page, roundup: publicSeason(roundup, idOf) };
  }

  // The roundup of a season that is over: the kept one, or else one built now, which is kept once the season has been
  // over SEASON_SETTLE_MS. Null when nobody played.
  private async seasonOver(now: number): Promise<SeasonRoundup | null> {
    const storage = this.ctx.storage;
    const kept = parseKeptSeason(await storage.get(SEASON_KEY));
    if (kept !== null) return kept;
    const roundup = await this.seasonRoundup(now);
    if (roundup !== null && now >= SEASON.endsAt + SEASON_SETTLE_MS) {
      await storage.put(SEASON_KEY, keptSeason(roundup));
      console.info(`Kept the ${SEASON.name} roundup`);
    }
    return roundup;
  }

  // The checks keep the season roundup once the season has been over SEASON_SETTLE_MS, so it is kept even if nobody
  // opens the season page before the kill feed's records of those days are gone. Each instance looks once it is due,
  // and again after /removematch takes a match out of it. A failure is tried again at the next check.
  private async keepSeason(): Promise<void> {
    const now = Date.now();
    if (this.seasonLooked || now < SEASON.endsAt + SEASON_SETTLE_MS) return;
    try {
      await this.seasonOver(now);
      this.seasonLooked = true;
    } catch (error) {
      console.error(`Keeping the ${SEASON.name} roundup failed: ${errorText(error)}`);
    }
  }

  // From the player records since their first day, the match records, each day's weapons and the kill feed's records.
  // Players are kept by Steam ID (see buildSeason). Null before the records start, or when nobody played.
  private async seasonRoundup(now: number): Promise<SeasonRoundup | null> {
    const storage = this.ctx.storage;
    const [firstKey] = (await storage.list({ prefix: 'players:', limit: 1 })).keys();
    const firstDay = firstKey === undefined ? null : dayOfKey(firstKey);
    const period = firstDay === null ? null : seasonPeriod(firstDay, now);
    if (firstDay === null || period === null) return null;
    const covered = periodDays(period);
    const dayKeys = covered.map((day) => playerDayKey(Date.parse(`${day}T00:00:00Z`)));
    const weaponKeys = covered.map((day) => weaponDayKey(Date.parse(`${day}T00:00:00Z`)));
    const keys = [...dayKeys, ...weaponKeys, 'killFeedSince', STAFF_PROFILES_KEY];
    const stored = new Map<string, unknown>();
    for (let i = 0; i < keys.length; i += RECORDS_PER_WRITE) {
      for (const [key, value] of await storage.get(keys.slice(i, i + RECORDS_PER_WRITE))) stored.set(key, value);
    }
    const records = await storage.list({ prefix: 'match:', start: matchRecordKey(period.start - DAY_MS), end: matchRecordKey(period.end) });
    const staff = staffSteamIds(parseStaffProfiles(stored.get(STAFF_PROFILES_KEY)));
    const since = stored.get('killFeedSince');
    const feed = this.roundupFeed(covered, now);
    return buildSeason({
      firstDay,
      now,
      days: covered.map((day, i) => ({ day, players: withoutStaffSeeding(parsePlayerDay(stored.get(dayKeys[i] ?? '')), staff) })),
      matches: [...records.values()].flatMap((value) => parseMatchRecord(value) ?? []),
      weaponDays: weaponKeys.map((key) => parseWeaponDay(stored.get(key))),
      weaponsSince: typeof since === 'string' ? since : null,
      ...(feed === null ? {} : { feed }),
      scoreToWin: loadConfig(stringVars(this.env)).scoreToWin,
    });
  }

  // Brings the live status message up to date, after the check has saved the match and stats it shows. A failure
  // is logged and tried again next check; it never stops the bans and VIP updates after it.
  private async updateBoard(config: Config, snapshot: Snapshot | null): Promise<void> {
    const webhookUrl = config.statusWebhookUrl;
    if (webhookUrl === undefined) return;
    const storage = this.ctx.storage;
    const now = Date.now();
    try {
      const stored = await storage.get(['board', 'state', 'stats', 'nextMap', 'boardRotation', MAP_VOTE_KEY, PRIVATE_PROFILES_KEY]);
      const server = parseStats(stored.get('stats')).server;
      if (snapshot === null && server !== null && now - server.seenAt < OFFLINE_AFTER_MS) return;
      const hidden = privateSteamIds(parsePrivateProfiles(stored.get(PRIVATE_PROFILES_KEY)));
      const tracked = parseState(stored.get('state'))?.match ?? null;
      const match = tracked === null ? null : { ...tracked, players: publicNamesBySteamId(tracked.players, hidden) };
      const next =
        snapshot === null
          ? null
          : nextMap(
              snapshot.status.map,
              parseStagedMap(stored.get('nextMap')),
              // Without the rotation, the live status just leaves the next map out.
              await this.serverRotation(config, snapshot, parseReadRotation(stored.get('boardRotation')), now),
              now,
            );
      const vote = parseMapVote(stored.get(MAP_VOTE_KEY));
      // Only while people can still vote: a vote is closed by a later step of the check, and the link must not outlive it.
      const voteUrl =
        config.mapVote === null || !votingNow(vote, tracked, now) ? null : voteLink(vote, stringVars(this.env)['DISCORD_GUILD_ID']?.trim(), now);
      const message = buildLiveStatus(
        {
          snapshot,
          lastSeen: server === null ? null : { name: server.name, at: server.seenAt },
          match,
          nextMap: next,
          vote: voteUrl === null || vote === null ? null : { url: voteUrl, closeScore: vote.closeScore },
          now,
        },
        config.rules,
        config.siteUrl,
        config.serverId,
      );
      const ref = parseBoardRef(stored.get('board'));
      const shown = await showBoard(webhookUrl, message, ref);
      if (shown.messageId !== ref?.messageId) {
        await storage.put('board', shown);
        console.info(`Posted the live status (message ${shown.messageId})`);
      }
    } catch (error) {
      console.error(`Live status update failed: ${errorText(error)}`);
    }
  }

  // The server's rotation for the live status: the one `saved`, until rotationReadDue says to read it again. Null if it
  // can't be read; a failed read is not kept, so the next check asks again.
  private async serverRotation(config: Config, snapshot: Snapshot, saved: ReadRotation | null, now: number): Promise<Rotation | null> {
    const { map, rotationIndex } = snapshot.status;
    if (saved !== null && !rotationReadDue(saved, map, rotationIndex, now)) return saved.rotation;
    const rotation = await fetchRotation(config.rconUrl, config.rconPassword, socketHttp(connect)).catch(() => null);
    if (rotation !== null) await this.ctx.storage.put('boardRotation', { map, index: rotationIndex, at: now, rotation } satisfies ReadRotation);
    return rotation;
  }

  // As each day starts, puts that day's planned rotation on the server, and tries again each check until the server has
  // it. Waits while the server is not answering. A failure is logged; it never stops what comes after it.
  private async updateRotation(config: Config, snapshot: Snapshot | null): Promise<void> {
    if (snapshot === null) return;
    const now = Date.now();
    const today = rotationDay(now, config.rotationHour);
    try {
      const saved = await this.ensureDefault(config);
      const book = planToday(saved, today, now);
      if (book !== saved) await this.ctx.storage.put('rotations', book);
      if (rotationToday(book, today)?.pending) await this.sendRotation(book, config);
    } catch (error) {
      console.error(`Map rotation update failed: ${errorText(error)}`);
    }
  }

  // Puts the rotation `applied` names on the server, and notes when the server has it. One that is no longer saved, or
  // has no maps, is dropped: the server keeps the maps it has.
  private async sendRotation(book: RotationBook, config: Config): Promise<{ book: RotationBook; server: RotationServer | null }> {
    const { applied } = book;
    if (applied === null) return { book, server: null };
    const rotation = findRotation(book, applied.name);
    const done = { ...book, applied: { ...applied, pending: false } };
    if (rotation === null || rotation.entries.length === 0) {
      await this.ctx.storage.put('rotations', done);
      return { book: done, server: null };
    }
    const who = applied.by === 'schedule' ? 'the schedule' : `Discord user ${applied.by}`;
    try {
      const { rconUrl, rconPassword } = config;
      const http = socketHttp(connect);
      const put = await putRotation(
        {
          ...this.settingsFile({ config, http }),
          slot: async () =>
            rotationSlot(await fetchRotation(rconUrl, rconPassword, http), await fetchStatus(rconUrl, rconPassword, http)),
        },
        rotation.entries,
      );
      // The live status reads the new rotation at the next check.
      if (put.written) {
        await this.ctx.storage.delete('boardRotation');
        // The whole rotation was replaced, so a vote's winner waiting to be taken out is gone with it, and putting the old
        // rotation back later would undo this one.
        await this.ctx.storage.delete(VOTE_INSERT_KEY);
      }
      await this.ctx.storage.put('rotations', done);
      const next = !put.written
        ? ''
        : put.next === null
          ? ", as it is, as the server didn't say which slot it is on"
          : `, starting with ${put.next.map} at the next map change`;
      console.info(
        put.written
          ? `Map rotation: put ${JSON.stringify(rotation.name)} (${rotation.entries.length} maps) on the server for ${applied.day}, chosen by ${who}${next}`
          : `Map rotation: the server already has ${JSON.stringify(rotation.name)}`,
      );
      return { book: done, server: { outcome: put.written ? 'updated' : 'unchanged' } };
    } catch (error) {
      console.error(`Map rotation: couldn't put ${JSON.stringify(rotation.name)} on the server, trying again next check: ${errorText(error)}`);
      return { book, server: { outcome: 'failed', reason: errorText(error) } };
    }
  }

  // The saved rotations, starting Default as the server's rotation the first time (see seedDefault). Run in `serial`.
  private async ensureDefault(config: Config): Promise<RotationBook> {
    const saved = parseRotationBook(await this.ctx.storage.get('rotations'));
    if (hasDefault(saved)) return saved;
    // A Default staff made before, with maps, only needs its name put right.
    const named = seedDefault(saved, []);
    if (hasDefault(named)) {
      await this.ctx.storage.put('rotations', named);
      return named;
    }
    const http = socketHttp(connect);
    // The settings file as it is, or what the server reports when the file has no rotation of its own.
    const inFile = serverEntries((await fetchConfig(config.rconUrl, config.rconPassword, http)).text);
    const entries = inFile.length > 0 ? inFile : rotationEntries(await fetchRotation(config.rconUrl, config.rconPassword, http));
    const book = seedDefault(named, entries);
    if (book === saved) return saved;
    await this.ctx.storage.put('rotations', book);
    console.info(`Map rotation: saved the server's rotation as ${DEFAULT_ROTATION} (${entries.length} maps)`);
    return book;
  }

  // The next-map vote (see mapvote.ts) takes one step at a time, so a ballot never overwrites the vote closing.
  private voting = oneAtATime();

  // The vote for the website, or null while there is none (or the vote is off), and the Discord channel to vote in.
  async mapVote(): Promise<{ vote: PublicVote | null; discord: string | null }> {
    const vars = stringVars(this.env);
    const rule = loadConfig(vars).mapVote;
    if (rule === null) return { vote: null, discord: null };
    const guild = vars['DISCORD_GUILD_ID']?.trim();
    const discord = guild && rule.channelId ? `https://discord.com/channels/${guild}/${rule.channelId}` : null;
    const vote = parseMapVote(await this.ctx.storage.get(MAP_VOTE_KEY));
    return { vote: vote === null ? null : publicVote(vote, Date.now()), discord };
  }

  // A press of a vote button: counts it and answers with the vote message as it is now, and what to tell the voter.
  async castMapVote(press: {
    poll: string;
    map?: string;
    light?: string;
    weather?: string;
    userId: string;
    userName?: string;
    via?: string;
  }): Promise<{ update: unknown | null; reply: string }> {
    const config = loadConfig(stringVars(this.env));
    return this.voting(async () => {
      const now = Date.now();
      const vote = parseMapVote(await this.ctx.storage.get(MAP_VOTE_KEY));
      if (config.mapVote === null || vote === null || vote.id !== press.poll) {
        return { update: null, reply: 'That vote is over. A new one opens with the next match.' };
      }
      const cast = castVote(
        vote,
        {
          user: press.userId,
          ...(press.map === undefined ? {} : { map: press.map }),
          ...(press.light === undefined ? {} : { light: press.light }),
          ...(press.weather === undefined ? {} : { weather: press.weather }),
        },
        now,
      );
      if (!('vote' in cast)) {
        return { update: null, reply: cast.result === 'closed' ? 'The vote has closed.' : 'That choice is not in this vote.' };
      }
      await this.ctx.storage.put(MAP_VOTE_KEY, cast.vote);
      console.info(voteLogLine(cast.vote, press, vote.ballots.find((b) => b.user === press.userId)));
      const name =
        press.map !== undefined
          ? (cast.vote.options.find((o) => o.map === press.map)?.name ?? mapName(press.map))
          : ((press.weather !== undefined ? cast.vote.weather : cast.vote.conditions).find((c) => c.key === (press.weather ?? press.light))?.label ?? 'that');
      const what = press.map !== undefined ? 'map' : press.weather !== undefined ? 'weather' : 'time of day';
      return {
        update: voteMessage(cast.vote, now, config.siteUrl),
        reply:
          cast.result === 'changed'
            ? `Your ${what} vote is now for **${name}**.`
            : `You voted for **${name}**. Press another ${what} to change it.`,
      };
    });
  }

  // Updates the vote's Discord message to the vote as it is. A failure is logged: the message is only the view of the vote.
  private async showVote(config: Config, rule: NonNullable<Config['mapVote']>, vote: MapVote): Promise<void> {
    if (vote.message === null || !rule.botToken) return;
    try {
      await editVoteMessage(rule.botToken, vote.message.channelId, vote.message.messageId, voteMessage(vote, Date.now(), config.siteUrl));
    } catch (error) {
      console.error(`Map vote: could not update the Discord message: ${errorText(error)}`);
    }
  }

  // Opens a vote when a match goes live, closes it when its time is up or a team is close to winning, and puts the winner
  // on the server as the next map. A failure is logged; it never stops what comes after it.
  private async updateMapVote(config: Config, snapshot: Snapshot | null): Promise<void> {
    const rule = config.mapVote;
    if (snapshot === null || snapshot.status.map === '') return;
    // Whether or not there is a vote now: a winner put in the rotation is taken out once it is playing.
    await this.voting(() => this.restoreVoteInsert(config, snapshot.status.map)).catch((error: unknown) =>
      console.error(`Map vote: restoring the rotation failed: ${errorText(error)}`),
    );
    if (rule === null) return;
    try {
      await this.voting(() => this.stepMapVote(config, rule, snapshot.status.map));
    } catch (error) {
      console.error(`Map vote failed: ${errorText(error)}`);
    }
  }

  private async stepMapVote(config: Config, rule: NonNullable<Config['mapVote']>, playing: string): Promise<void> {
    const storage = this.ctx.storage;
    const now = Date.now();
    const match = parseState(await storage.get('state'))?.match ?? null;
    // Whether this match is in the rain, noted as it begins (see trackRain).
    const rainNow = match === null ? null : await this.trackRain(config, match.startedAt, playing);
    // Every map played is remembered, whether or not it had a vote.
    const played = parseRecentMaps(await storage.get(RECENT_MAPS_KEY));
    const recent = withPlayed(played, playing);
    if (recent.join() !== played.join()) await storage.put(RECENT_MAPS_KEY, recent);
    let vote = parseMapVote(await storage.get(MAP_VOTE_KEY));
    // The last match's vote, whose message goes when this match's vote is posted.
    const previous = vote;
    const save = async (next: MapVote): Promise<MapVote> => {
      await storage.put(MAP_VOTE_KEY, next);
      return next;
    };
    const ended = (v: MapVote, outcome: VoteOutcome): MapVote => ({ ...v, outcome });

    // A vote for an earlier match: too late to put anything on the server. A match that has ended is not: its winner is put
    // on the server while the end screen shows, and applyVoteWinner refuses once the server has moved to another map.
    if (vote !== null && (match === null || match.startedAt !== vote.matchStartedAt)) {
      if (vote.outcome === null || vote.outcome.pending) {
        const lost = vote.outcome?.winner ?? null;
        if (lost !== null) {
          await this.alertVoteProblem(config, vote.id, 'late', "The winner wasn't put on the server in time", [
            `**${mapName(lost)}** won the vote, but the match ended before it could be put on the server, so the rotation carries on as it was.`,
          ]);
        }
        vote = await save(ended(vote, { at: now, winner: null, pending: false, note: NOTE.late }));
        if (lost === null) console.info(`Map vote: the match ended before the vote could be applied`);
        else console.error(`Map vote: the match ended before the vote could be applied, so ${lost} was not put on the server`);
        await this.showVote(config, rule, vote);
      }
      vote = null;
    }

    if (vote !== null && match !== null) {
      const leading = Math.max(0, ...match.factionScores.map((f) => f.score));
      const over = matchIsOver(vote, await this.matchFeed(), leading, config.scoreToWin);
      if (vote.outcome === null) {
        if (!closeDue(vote, now, leading) && !over) return;
        const winner = chooseWinner(vote, Math.random);
        const lighting = chooseConditions(vote, Math.random, vote.rain.all);
        vote = await save(
          ended(
            vote,
            winner === null
              ? { at: now, winner: null, pending: false, note: NOTE.nobody }
              : {
                  at: now,
                  winner,
                  pending: true,
                  ...(lighting === null ? {} : { lighting: lighting.id, lightingName: lighting.name }),
                },
          ),
        );
        console.info(`Map vote closed: ${winner ?? 'no votes'} (${vote.ballots.length} ballots)${vote.rain.all ? ', no rain allowed' : ''}`);
        await this.showVote(config, rule, vote);
        // Every ballot in one message for the moderation log, when the vote had any.
        if (config.modLogWebhookUrl !== undefined && vote.ballots.length > 0) {
          postWebhook(config.modLogWebhookUrl, voteLogMessage(vote)).catch((error: unknown) =>
            console.error(`Map vote: could not post the ballots to the moderation log: ${errorText(error)}`),
          );
        }
      }
      // The queued winner waits for the end of the match: the server ended a match early when it was queued with a team on 95.
      if (vote.outcome?.pending && (rule.staging === 'rotation' || over)) {
        const outcome = await this.applyVoteWinner(config, vote, playing, rule.staging, over);
        const next = await save(ended(vote, outcome));
        // The message changes when the winner is on the server, or when it can't be; a retry still waiting says the same.
        if (!outcome.pending) await this.showVote(config, rule, next);
      }
      return;
    }

    // A match that is live and has no vote yet.
    if (match === null || match.liveAt === null || match.endedAt !== undefined) return;
    if (!rule.botToken || !rule.channelId) {
      console.error('Map vote: MAP_VOTE is on, but DISCORD_BOT_TOKEN and DISCORD_VOTE_CHANNEL_ID are not both set, so no vote opens.');
      return;
    }
    const catalog = await this.catalog(config);
    // A match already at its close score is nearly over: a vote would close at once, so none opens.
    const closeScore = closeScoreFor(config.scoreToWin, rule.closePercent);
    if (Math.max(0, ...match.factionScores.map((f) => f.score)) >= closeScore) return;
    // The status names the map ("Ozeti") where the catalogue has ids ("Europe"): the rules on what to offer go by id.
    const maps = catalog?.maps ?? [];
    const playingId = mapIdOf(maps, playing);
    const recentIds = recent.map((m) => mapIdOf(maps, m));
    // The map that last had rain is not offered (unless that leaves no vote), as the one being played is not.
    const lastRain = rainNow !== null && !rainNow.rain && rainNow.ban !== null ? mapIdOf(maps, rainNow.ban) : null;
    const avoid = lastRain === null ? [] : [lastRain];
    // What staff switched off with /voteoptions: maps are never offered, and rain is never chosen.
    const staffOptions = parseVoteOptions(await storage.get(VOTE_OPTIONS_KEY));
    const off = offMapIds(staffOptions);
    const options = catalog === null ? [] : pickOptions(maps, playingId, recentIds, rule.options, Math.random, avoid, off);
    if (options.length === 0) {
      // Said at most every 10 minutes, so a server that can never offer two maps doesn't fill the logs once a minute.
      if (Date.now() - voteUnavailableLoggedAt >= VOTE_LOG_MS) {
        voteUnavailableLoggedAt = Date.now();
        const maps = catalog?.maps ?? [];
        const withModes = maps.filter((m) => m.modes.length > 0);
        const withInfantry = withModes.filter((m) => m.modifiers.some((x) => x.key === 'infantry_only'));
        console.error(
          `Map vote: no vote opened, as fewer than two maps could be offered. The server lists ${maps.length} maps, ` +
            `${withModes.length} with a game mode, ${withInfantry.length} of those with infantry only (${withInfantry.map((m) => m.id).join(', ') || 'none'}); ` +
            `not offered because they were played lately: ${recent.join(', ')}` +
            `${off.length > 0 ? `; switched off by staff with /voteoptions: ${off.join(', ')}` : ''}.`,
        );
      }
      return;
    }
    // Posted first: a vote nobody can see is not opened, and the next check tries again.
    // The maps a Random map button picks from.
    const pool = votePool(maps, playingId, recentIds, rule.options, avoid, off);
    // No rain when the match being played has it; and the map that last had it, if it was left out, is said.
    const skipped =
      lastRain !== null && !pool.some((m) => m.id === lastRain) && votePool(maps, playingId, recentIds, rule.options, [], off).some((m) => m.id === lastRain) ? lastRain : null;
    const noRain = staffOptions.noRain !== null;
    const rain = { all: (rainNow?.rain ?? false) || noRain, skipped, off: noRain };
    const lightings = catalog?.lightings ?? [];
    const opened = openVote(match, playing, options, rule, now, closeScore, conditionOptions(lightings), weatherOptions(rain.all ? lightings.filter((l) => !isRain(l)) : lightings), {
      pool: pool.map((m) => ({ map: m.id, name: m.name })),
      rain,
    });
    const messageId = await postVoteMessage(rule.botToken, rule.channelId, voteMessage(opened, now, config.siteUrl));
    await storage.put(MAP_VOTE_KEY, { ...opened, message: { channelId: rule.channelId, messageId } });
    console.info(`Map vote opened: ${opened.options.map((o) => o.map).join(', ')}`);
    // Only the current vote is left in the channel. The new one is up first, and a failure here is only logged: the old
    // message is just clutter, and its vote is no longer kept to try again.
    if (previous?.message && previous.message.messageId !== messageId) {
      await deleteVoteMessage(rule.botToken, previous.message.channelId, previous.message.messageId).catch((error: unknown) =>
        console.error(`Map vote: could not delete the last vote's message: ${errorText(error)}`),
      );
    }
    const announcement = voteOpenBroadcast(config.siteUrl, config.inviteCode ? discordLink(config.inviteCode) : null, opened.closeScore, rule.minutes);
    if (announcement !== null) {
      await sendBroadcast(config.rconUrl, config.rconPassword, announcement, socketHttp(connect)).catch((error: unknown) =>
        console.error(`Map vote announcement failed: ${errorText(error)}`),
      );
    }
  }

  // Notes, as a match begins, whether it is being played in the rain, from the lighting of the rotation's entry for the map being
  // played (read before the rotation is put back, which changes that entry), and which map last had rain before it. The vote
  // allows no rain after rain (see RainRule). Read once a match; null when the server cannot say, and then the vote has no rule.
  private async trackRain(config: Config, matchStartedAt: number, playing: string): Promise<RainRecord | null> {
    const storage = this.ctx.storage;
    const previous = parseRainRecord(await storage.get(RAIN_KEY));
    if (previous?.matchStartedAt === matchStartedAt) return previous;
    if (playing === '') return null;
    try {
      const { rconUrl, rconPassword } = config;
      const http = socketHttp(connect);
      const [rotation, status] = await Promise.all([fetchRotation(rconUrl, rconPassword, http), fetchStatus(rconUrl, rconPassword, http)]);
      const slot = rotationSlot(rotation, status);
      const record = rainRecordFor(previous, matchStartedAt, playing, (slot === null ? undefined : rotation.entries[slot]?.lighting) ?? undefined);
      await storage.put(RAIN_KEY, record);
      return record;
    } catch (error) {
      console.error(`Map vote: could not tell if ${playing} is in the rain: ${errorText(error)}`);
      return null;
    }
  }

  // When the server comes back after not answering, it has restarted and starts from the first map of its rotation. The
  // server is meant to play infantry only after a restart, so if it is on a map that is not, it is changed at once to an
  // infantry only one (see restartmap.ts): the next one in the rotation that is, or else a map the catalogue lists with infantry
  // only. Tried again each check for a few minutes if the server can't say. A failure is logged; it never stops what comes after it.
  private async updateRestartMap(config: Config, snapshot: Snapshot | null): Promise<void> {
    const storage = this.ctx.storage;
    try {
      const before = parseRestartWatch(await storage.get(RESTART_WATCH_KEY));
      const { watch, due } = watchRestart(before, snapshot !== null, Date.now());
      if (watch.downSince !== before.downSince || watch.pendingSince !== before.pendingSince) await storage.put(RESTART_WATCH_KEY, watch);
      if (!due || snapshot === null) return;
      const { rconUrl, rconPassword } = config;
      const http = socketHttp(connect);
      const [rotation, status] = await Promise.all([fetchRotation(rconUrl, rconPassword, http), fetchStatus(rconUrl, rconPassword, http)]);
      const slot = rotationSlot(rotation, status);
      const entry = playingEntry(rotation, slot);
      if (slot === null || entry === null) {
        console.error(`Restart: the server is back on ${status.map}, but its rotation does not say which map is playing yet, so it is not checked for infantry only (tried again next check)`);
        return;
      }
      if (isInfantryOnly(entry.experiences)) {
        console.info(`Restart: the server is back on ${entry.map}, infantry only`);
        await storage.put(RESTART_WATCH_KEY, settled(watch));
        return;
      }
      const playing = status.map || entry.map;
      let target = infantryFromRotation(rotation, slot);
      if (target === null) {
        const catalog = await this.catalog(config);
        const choices = catalog === null ? [] : infantryMaps(catalog.maps, playing);
        const choice = choices[Math.floor(Math.random() * choices.length)];
        if (catalog === null || choice === undefined) throw new Error('no map is known that can be played infantry only');
        const planned = planSetup(choice.id, VOTE_SETUP_OPTIONS, {
          rotation,
          mapExperiences: [...choice.modes.map((m) => m.id), ...choice.modifiers.map((m) => m.id)],
          experiences: catalog.experiences,
          lightings: catalog.lightings,
          zones: choice.zones,
        });
        if ('problem' in planned) throw new Error(planned.problem);
        target = { map: choice.id, setup: planned.setup };
      }
      console.info(`Restart: the server is back on ${playing}, which is not infantry only; changing to ${target.map} ${JSON.stringify(target.setup)}`);
      await queueMap(rconUrl, rconPassword, target.map, http, target.setup);
      await this.stageNextMap(target.map, playing);
      await endMatch(rconUrl, rconPassword, http);
      await storage.put(RESTART_WATCH_KEY, settled(watch));
      await sendBroadcast(rconUrl, rconPassword, `Server restarted. Switching to ${mapName(target.map)}, infantry only. Hang tight!`, http).catch((error: unknown) =>
        console.error(`Restart announcement failed: ${errorText(error)}`),
      );
    } catch (error) {
      console.error(`Restart: could not check the map for infantry only, trying again next check: ${errorText(error)}`);
    }
  }

  // Tells staff, in the moderation log, of a problem putting a vote's winner on the server: once for each kind of problem in each
  // vote. A failure to post is only logged.
  private async alertVoteProblem(config: Config, voteId: string, kind: string, title: string, lines: string[]): Promise<void> {
    const url = config.modLogWebhookUrl;
    if (url === undefined) return;
    try {
      const next = withVoteAlert(parseVoteAlerts(await this.ctx.storage.get(VOTE_ALERTS_KEY)), voteId, kind);
      if (next === null) return;
      await this.ctx.storage.put(VOTE_ALERTS_KEY, next);
      postWebhook(url, voteProblemMessage(voteId, title, lines, Date.now())).catch((error: unknown) =>
        console.error(`Map vote: could not post the problem to the moderation log: ${errorText(error)}`),
      );
    } catch (error) {
      console.error(`Map vote: could not note the problem for the moderation log: ${errorText(error)}`);
    }
  }

  // Puts the winner on the server, infantry only. With staging "rotation" it goes into the server's rotation as the next map
  // (see insertVoteWinner), which can be done as soon as the vote closes; "queue" stages it as /setnextmap does, which waits
  // for `over` (the match is over). A failure keeps the outcome pending, and the next
  // check tries again until the match ends.
  private async applyVoteWinner(config: Config, vote: MapVote, playing: string, staging: 'rotation' | 'queue', over: boolean): Promise<VoteOutcome> {
    const at = Date.now();
    const winner = vote.outcome?.winner ?? null;
    if (winner === null) return { at, winner: null, pending: false, note: NOTE.failed };
    if (playing !== vote.fromMap) {
      await this.alertVoteProblem(config, vote.id, 'late', "The winner wasn't put on the server in time", [
        `**${mapName(winner)}** won the vote, but the match ended before it could be put on the server, so the rotation carries on as it was.`,
      ]);
      return { at, winner: null, pending: false, note: NOTE.late };
    }
    // The circles drawn for the winner: undefined until decided, then a layout or null (the map has no choice). The outcome
    // always says the layout that is (or will be) put on, so a retry reuses it and a vote saved before this reports none it
    // did not apply.
    let picked: ZoneChoice | null | undefined;
    const outcomeOf = (pending: boolean, at: number): VoteOutcome =>
      outcomeWithZone({ ...(vote.outcome ?? { at, winner }), at, winner, pending }, picked);
    try {
      // An earlier vote's winner still waiting to be taken out (see restoreVoteInsert) goes now: this winner is planned from the
      // rotation as it is, which must not have the old one in it.
      const earlier = parseVoteInsert(await this.ctx.storage.get(VOTE_INSERT_KEY));
      if (staging === 'rotation' && earlier !== null && earlier.voteId !== vote.id) {
        await this.putBackRotation(config, earlier, playing);
        if (parseVoteInsert(await this.ctx.storage.get(VOTE_INSERT_KEY)) !== null) throw new Error('the last vote\'s winner is still in the rotation');
      }
      const { rconUrl, rconPassword } = config;
      const http = socketHttp(connect);
      let rotationProblem = 'the server\'s rotation could not be read';
      const [catalog, rotation] = await Promise.all([
        this.catalog(config),
        fetchRotation(rconUrl, rconPassword, http).catch((error: unknown) => {
          rotationProblem = `the server's rotation could not be read (${errorText(error)})`;
          return null;
        }),
      ]);
      const choice = catalog?.maps.find((m) => m.id === winner);
      // Nothing is sent that the server's own catalogue does not confirm for this map: its game modes and its infantry only
      // modifier. Otherwise the vote waits (and is retried) rather than sending an id guessed from another map.
      if (choice === undefined || choice.modes.length === 0 || !choice.modifiers.some((m) => m.key === 'infantry_only')) {
        throw new Error(`the server's catalogue does not list ${winner} with infantry only`);
      }
      const lighting = vote.outcome?.lighting;
      // The circles are not voted on: a layout of this map by chance, never the one a vote last gave it (nothing when the map
      // has one layout only). A layout drawn by an earlier try of this vote is kept, so the server, the history and what is
      // announced agree. The history is only updated once the winner is on the server.
      const lastZones = parseLastZones(await this.ctx.storage.get(LAST_ZONES_KEY));
      picked = zoneForTry(vote.outcome, choice.zones, lastZones[winner], Math.random, blockedCircleIds(await this.blockedCircles()));
      const zones = picked?.id;
      const planned = planSetup(winner, { ...VOTE_SETUP_OPTIONS, ...(lighting ? { lighting } : {}), ...(zones ? { zones } : {}) }, {
        rotation,
        mapExperiences: [...choice.modes.map((m) => m.id), ...choice.modifiers.map((m) => m.id)],
        experiences: catalog?.experiences ?? null,
        lightings: catalog?.lightings ?? null,
        zones: choice.zones,
      });
      if ('problem' in planned) throw new Error(planned.problem);
      // Checked as late as possible, right before the server is told, so a pick staff made while the catalogue was being
      // read still stands. Staff commands don't run through this queue, so this leaves only the moments between this read
      // and the request.
      const staged = parseStagedMap(await this.ctx.storage.get('nextMap'));
      if (staged !== null && staged.at > vote.openedAt && staged.fromMap === vote.fromMap) {
        return { at, winner: null, pending: false, note: NOTE.staff };
      }
      const inserted = staging === 'rotation' ? await this.insertVoteWinner(config, vote, { map: winner, ...planned.setup }, rotation, rotationProblem) : null;
      if (inserted !== true) {
        // The queue is only for staging "queue": a rotation that cannot take the winner is retried, never queued instead.
        if (staging === 'rotation') throw new Error(`the rotation cannot take it: ${inserted}`);
        // Not before the match is over: the server ended a match early when this was sent with a team on 95.
        if (!over) return outcomeOf(true, vote.outcome?.at ?? at);
        await queueMap(rconUrl, rconPassword, winner, http, planned.setup);
      }
      await this.stageNextMap(winner, playing);
      if (picked !== null) await this.ctx.storage.put(LAST_ZONES_KEY, { ...lastZones, [winner]: picked.id });
      console.info(`Map vote: ${winner} staged as the next map ${inserted === true ? 'in the rotation' : 'in the queue'}, ${JSON.stringify(planned.setup)}`);
      const name = vote.options.find((o) => o.map === winner)?.name ?? mapName(winner);
      const votes = vote.ballots.filter((b) => b.map === winner).length;
      const setup = [vote.outcome?.lightingName, picked ? `${picked.name} zones` : null].filter((x): x is string => Boolean(x));
      await sendBroadcast(rconUrl, rconPassword, voteResultBroadcast(name, setup, votes), http).catch((error: unknown) =>
        console.error(`Map vote result announcement failed: ${errorText(error)}`),
      );
      return outcomeOf(false, at);
    } catch (error) {
      console.error(`Map vote: could not stage ${winner}, trying again next check: ${errorText(error)}`);
      await this.alertVoteProblem(config, vote.id, 'failed', "The winner couldn't be put on the server", [
        `**${mapName(winner)}** won the vote, but putting it on the server failed. The bot tries again every minute until the match ends.`,
        `\`${errorText(error)}\``,
      ]);
      return outcomeOf(true, vote.outcome?.at ?? at);
    }
  }

  // Puts the winner into the server's rotation as the next map. The reason, as text, when the rotation can't take it: it
  // was not read, or is off or random. A build with the live edit routes moves (or adds) it into the slot after the one
  // playing, as "Set as next map" in the server's own console does, and is taken out again once it has played (see
  // restoreVoteInsert). Other builds get it through the config document (see writeVoteWinner). The server keeps playing the
  // match on now.
  private async insertVoteWinner(config: Config, vote: MapVote, winner: RotationEntry, rotation: Rotation | null, notRead: string): Promise<true | string> {
    if (rotation === null) return notRead;
    const { rconUrl, rconPassword } = config;
    const http = socketHttp(connect);
    const status = await fetchStatus(rconUrl, rconPassword, http);
    const slot = rotationSlot(rotation, status);
    const problem = whyNoInsert(rotation);
    if (problem !== null) return `${problem} (${rotationFacts(rotation, status)})`;
    const routes = await fetchRoutes(rconUrl, rconPassword, http).catch((error: unknown) => {
      console.error(`Map vote: could not read the server's routes, so the rotation goes through the config document: ${errorText(error)}`);
      return [];
    });
    if (!canMoveEntries(routes)) return this.writeVoteWinner(config, vote, winner, rotation, status, slot);
    // Done again from the rotation as it is, a retry finds the winner already in it and moves it no further than needed.
    const move = planMove(rotation, slot, winner);
    const { map, ...setup } = winner;
    if (move.add) {
      // Kept first, as in writeVoteWinner: if the add goes through and this check then fails, the entry is still taken out
      // once it has played. A retry finds the entry in the rotation and keeps what was kept.
      const written = parseVoteInsert(await this.ctx.storage.get(VOTE_INSERT_KEY));
      const insert = written?.voteId === vote.id ? null : moveInsert(vote, rotation, slot, winner, Date.now());
      if (insert !== null) await this.ctx.storage.put(VOTE_INSERT_KEY, insert);
      await addRotationEntry(rconUrl, rconPassword, map, http, setup);
    }
    const step = move.to < move.from ? -1 : 1;
    for (let at = move.from; at !== move.to; at += step) await moveRotationEntry(rconUrl, rconPassword, at, step < 0 ? 'up' : 'down', http);
    // The live status reads the new rotation at the next check.
    await this.ctx.storage.delete('boardRotation');
    console.info(`Map vote: ${winner.map} ${move.add ? 'added to' : 'moved in'} the rotation, into slot ${move.to} (${rotationFacts(rotation, status)})`);
    return true;
  }

  // Writes the winner into the rotation in the config document, and remembers how to take it out (see voteinsert.ts). When
  // the server does not say which slot it is on, the winner goes in every slot. A write re-anchors the server's place in
  // the rotation, so where it goes next is read back: when the server says, and it is not the winner, the winner goes in
  // every slot after all.
  private async writeVoteWinner(
    config: Config,
    vote: MapVote,
    winner: RotationEntry,
    rotation: Rotation,
    status: ServerStatus,
    slot: number | null,
  ): Promise<true | string> {
    const { rconUrl, rconPassword } = config;
    const http = socketHttp(connect);
    const storage = this.ctx.storage;
    // Written already, by an earlier check that went on to fail: not written twice.
    const written = parseVoteInsert(await storage.get(VOTE_INSERT_KEY));
    if (written !== null && written.voteId === vote.id && stillInserted(rotation, written)) return true;
    const write = async (plan: InsertPlan): Promise<void> => {
      const insert: VoteInsert = {
        voteId: vote.id,
        fromMap: vote.fromMap,
        map: winner.map,
        restore: plan.restore,
        length: plan.staged.length,
        at: Date.now(),
        ...(plan.asIs ? { asIs: true } : {}),
      };
      // Kept first: if the write goes through and this check then fails, the rotation is still put back.
      await storage.put(VOTE_INSERT_KEY, insert);
      await putRotation({ ...this.settingsFile({ config, http }), slot: async () => (plan.asIs ? null : slot) }, plan.staged);
      // The live status reads the new rotation at the next check.
      await storage.delete('boardRotation');
    };
    const plan = planInsert(rotation, slot, winner);
    if (plan === null) return `${whyNoInsert(rotation) ?? 'it cannot be planned'} (${rotationFacts(rotation, status)})`;
    await write(plan);
    if (plan.asIs) {
      // An error in the Worker's logs, not info, so it stands out there and can be alerted on.
      console.error(`Map vote: the server did not say which rotation slot it is on, so ${winner.map} is in every slot (${rotationFacts(rotation, status)})`);
      await this.alertVoteProblem(config, vote.id, 'every-slot', "The server didn't say which rotation slot it is on", [
        `**${mapName(winner.map)}** won the vote, but without the slot the server is on the bot can't put it after the map being played. It is in **every** slot of the rotation, so it plays next, and the map that would have come after it is skipped once.`,
        `The rotation is put back about ${RESTORE_MINUTES} minutes into the next match.`,
        `\`${rotationFacts(rotation, status)}\``,
      ]);
      return true;
    }
    const [after, afterStatus] = await Promise.all([fetchRotation(rconUrl, rconPassword, http), fetchStatus(rconUrl, rconPassword, http)]);
    const next = nextSlot(after, afterStatus);
    if (next === null || after.entries[next]?.map === winner.map) return true;
    const every = planInsert(rotation, null, winner);
    if (every === null) return 'it cannot be planned';
    await write(every);
    console.error(
      `Map vote: after the write the server goes to ${after.entries[next]?.map ?? 'another map'} next, not ${winner.map}, so ${winner.map} is in every slot (${rotationFacts(after, afterStatus)})`,
    );
    await this.alertVoteProblem(config, vote.id, 'every-slot', 'The server went to the wrong slot after the rotation was written', [
      `**${mapName(winner.map)}** won the vote. After the write the server goes to **${mapName(after.entries[next]?.map ?? 'another map')}** next, so the winner is in **every** slot of the rotation instead, and the map that would have come after it is skipped once.`,
      `The rotation is put back about ${RESTORE_MINUTES} minutes into the next match.`,
      `\`${rotationFacts(after, afterStatus)}\``,
    ]);
    return true;
  }

  // Once the match after the vote's has run RESTORE_DELAY_MS, the rotation is written back as it was, from the
  // map that would have come next, if it is still the one that was written (staff or the daily rotation may have changed it
  // since). Not sooner: a write as the map loads changed the lighting the server played.
  private async restoreVoteInsert(config: Config, playing: string): Promise<void> {
    const storage = this.ctx.storage;
    const insert = parseVoteInsert(await storage.get(VOTE_INSERT_KEY));
    if (insert === null) return;
    const match = parseState(await storage.get('state'))?.match ?? null;
    if (restoreDue(insert, playing, match?.startedAt ?? null, Date.now())) await this.putBackRotation(config, insert, playing);
  }

  private async putBackRotation(config: Config, insert: VoteInsert, playing: string): Promise<void> {
    const storage = this.ctx.storage;
    try {
      const { rconUrl, rconPassword } = config;
      const http = socketHttp(connect);
      const [rotation, status] = await Promise.all([fetchRotation(rconUrl, rconPassword, http), fetchStatus(rconUrl, rconPassword, http)]);
      if (stillInserted(rotation, insert)) {
        const slot = insert.asIs ? null : rotationSlot(rotation, status);
        await putRotation({ ...this.settingsFile({ config, http }), slot: async () => slot }, insert.restore);
        await storage.delete('boardRotation');
        console.info(`Map vote: the server is on ${playing}; the rotation is back as it was, from ${insert.restore[0]?.map ?? 'its start'}`);
      } else {
        console.info(`Map vote: the rotation has changed since ${insert.map} was put in it, so it is left as it is`);
      }
      await storage.delete(VOTE_INSERT_KEY);
    } catch (error) {
      console.error(`Map vote: could not put the rotation back, trying again next check: ${errorText(error)}`);
      await this.alertVoteProblem(config, insert.voteId, 'restore', "The rotation couldn't be put back", [
        `**${mapName(insert.map)}**, which won the vote, is still in the rotation. The bot tries again every minute.`,
        `\`${errorText(error)}\``,
      ]);
    }
  }

  // The saved rotations, for /rotations.
  async rotationBook(): Promise<RotationBook> {
    return parseRotationBook(await this.ctx.storage.get('rotations'));
  }

  // What maps can be played with, read from the server at most every CATALOG_MS.
  private async catalog(config: Config): Promise<RotationCatalog | null> {
    const now = Date.now();
    if (this.rotationCatalog !== null && now - this.rotationCatalog.at < CATALOG_MS) return this.rotationCatalog.catalog;
    const http = socketHttp(connect);
    const { rconUrl, rconPassword } = config;
    const optional = <T>(work: Promise<T>): Promise<T | null> => work.catch(() => null);
    const [maps, experiences, lightings] = await Promise.all([
      fetchMaps(rconUrl, rconPassword, http),
      optional(fetchExperiences(rconUrl, rconPassword, http)),
      optional(fetchLightings(rconUrl, rconPassword, http)),
    ]);
    const perMap = new Map(
      await Promise.all(
        maps.map(async (map) => {
          const [own, zones] = await Promise.all([
            optional(fetchMapExperiences(rconUrl, rconPassword, map.id, http)),
            optional(fetchZones(rconUrl, rconPassword, map.id, http)),
          ]);
          return [map.id, { experiences: own, zones }] as const;
        }),
      ),
    );
    const catalog = buildCatalog({ maps, experiences, lightings, perMap });
    // Only a full answer is kept, so a slow server is asked again next time.
    if (experiences !== null && lightings !== null && [...perMap.values()].every((m) => m.experiences !== null && m.zones !== null)) {
      this.rotationCatalog = { at: now, catalog };
    }
    return catalog;
  }

  // The staff page's Rotations tab. Without the server, the saved rotations and the week still show.
  async rotationsPage(): Promise<RotationsPage> {
    const config = loadConfig(stringVars(this.env));
    const book = await this.serial(() => this.ensureDefault(config)).catch(async (error: unknown) => {
      console.error(`Map rotation: Default could not be set up: ${errorText(error)}`);
      return parseRotationBook(await this.ctx.storage.get('rotations'));
    });
    const [server, catalog] = await Promise.all([
      fetchRotation(config.rconUrl, config.rconPassword, socketHttp(connect)).catch(() => null),
      this.catalog(config).catch((error: unknown) => {
        console.error(`Staff page: the maps could not be read: ${errorText(error)}`);
        return null;
      }),
    ]);
    return buildRotationsPage({ book, today: rotationDay(Date.now(), config.rotationHour), hour: config.rotationHour, server, catalog });
  }

  // A change from the staff page's Rotations tab, and the tab as it is after it.
  async rotationsAction(action: RotationAction, by: string, byName: string): Promise<RotationsActionResult> {
    const result = await this.editRotations(actionEdit(action), by, byName);
    if ('problem' in result) return { problem: result.problem };
    return { ...(await this.rotationsPage()), ...(result.server === undefined ? {} : { outcome: result.server }) };
  }

  // Changes the saved rotations as staff asked, and when that changes what should be on the server today, puts it there.
  async editRotations(edit: RotationEdit, by: string, byName?: string): Promise<RotationEditResult> {
    return this.serial(async () => {
      const config = loadConfig(stringVars(this.env));
      const now = Date.now();
      const saved = parseRotationBook(await this.ctx.storage.get('rotations'));
      const named = byName === undefined ? {} : { byName };
      const edited = editRotationBook(saved, edit, { today: rotationDay(now, config.rotationHour), now, by, ...named });
      if ('problem' in edited) return edited;
      await this.ctx.storage.put('rotations', edited.book);
      // Only when this edit chose it, so a reply never reports on a rotation staff did not touch.
      if (edited.book.applied === saved.applied || !edited.book.applied?.pending) return edited;
      const { book, server } = await this.sendRotation(edited.book, config);
      return { ...edited, book, ...(server === null ? {} : { server }) };
    });
  }

  private async lineBook(): Promise<SavedLines> {
    this.savedLines ??= parseSavedLines(await this.ctx.storage.get(LINES_KEY));
    return this.savedLines;
  }

  // The lines the bot says in game: staff's, or its own (see linespage.ts).
  async lines(): Promise<Lines> {
    return resolveLines(await this.lineBook());
  }

  // The staff page's Lines tab.
  async linesPage(): Promise<LinesPage> {
    return buildLinesPage(await this.lineBook(), linesContext(loadConfig(stringVars(this.env))));
  }

  // A change from the Lines tab, and the tab as it is after it. The copy in memory changes before the write, so a second
  // change that comes in while this one is being written starts from it.
  async linesAction(action: LinesAction, by: string, byName: string): Promise<LinesActionResult> {
    const context = linesContext(loadConfig(stringVars(this.env)));
    const edited = editLines(await this.lineBook(), action, context, { by, byName, now: Date.now() });
    if ('problem' in edited) return edited;
    this.savedLines = edited.saved;
    try {
      await this.ctx.storage.put(LINES_KEY, edited.saved);
    } catch (error) {
      this.savedLines = null;
      throw error;
    }
    return buildLinesPage(edited.saved, context);
  }

  private async ruleBook(): Promise<WeaponRule[]> {
    this.savedRules ??= parseRules(await this.ctx.storage.get(RULES_KEY));
    return this.savedRules;
  }

  private rulesContext(): RulesContext {
    const vars = stringVars(this.env);
    return { rulesNote: rulesNote(loadConfig(vars).siteUrl), feed: (vars['KILL_FEED_TOKEN']?.trim() ?? '') !== '' };
  }

  // The staff page's Weapon rules tab, with what the bot did about each rule today.
  async rulesPage(): Promise<RulesPage> {
    return buildRulesPage(await this.ruleBook(), parseRuleBreaks(await this.ctx.storage.get(RULE_BREAKS_KEY), Date.now()), this.rulesContext());
  }

  // A change from the Weapon rules tab, and the tab as it is after it. As with the lines, the copy in memory changes
  // before the write.
  async rulesAction(action: RulesAction, by: string, byName: string): Promise<RulesActionResult> {
    const context = this.rulesContext();
    const edited = editRules(await this.ruleBook(), action, context, { by, byName, now: Date.now(), newId: () => crypto.randomUUID().slice(0, 8) });
    if ('problem' in edited) return edited;
    this.savedRules = edited.rules;
    try {
      await this.ctx.storage.put(RULES_KEY, edited.rules);
    } catch (error) {
      this.savedRules = null;
      throw error;
    }
    return this.rulesPage();
  }

  // A batch's kills against the weapon rules (see weaponrules.ts): the bot warns or kicks whoever broke one, as staff set
  // it, and it goes in their history and the moderation log like a staff member's /warn or /kick. In the background,
  // once the game has its reply, so a slow server never holds up the feed. One that fails is logged, not tried again:
  // the offence still counts, but the tab's totals only count what went out.
  private enforceRules(kills: FeedKill[], now: number): void {
    this.ctx.waitUntil(
      this.enforcing(async () => {
        const rules = await this.ruleBook();
        const broken = ruleKills(rules, kills);
        if (broken.length === 0) return;
        const judged = judgeKills(parseRuleBreaks(await this.ctx.storage.get(RULE_BREAKS_KEY), now), rules, broken, now);
        if (judged === null) return;
        await this.ctx.storage.put(RULE_BREAKS_KEY, judged.breaks);
        const { config, http } = this.rcon();
        const context = { rulesNote: rulesNote(config.siteUrl) };
        const sent: RuleCall[] = [];
        for (const call of judged.calls) {
          const detail = callDetail(call);
          const player = `${JSON.stringify(call.name)} (${call.steamId})`;
          try {
            if (call.act === 'kick') await kickPlayer(config.rconUrl, config.rconPassword, call.steamId, kickText(call.rule, context), http);
            else await messagePlayer(config.rconUrl, config.rconPassword, call.steamId, warningText(call.rule, call.offence, context), http);
            console.info(`Weapon rule: ${call.act === 'kick' ? 'kicked' : 'warned'} ${player}. ${detail}`);
            sent.push(call);
            const reason = call.act === 'kick' ? call.rule.kick : call.rule.warning;
            await this.record(call.steamId, { action: call.act, at: now, by: 'bot', name: call.name, reason, detail });
          } catch (error) {
            console.error(`Weapon rule ${call.act} for ${player} failed: ${errorText(error)}. ${detail}`);
          }
        }
        // Batches are judged one at a time, so nothing else wrote the offences meanwhile.
        if (sent.length > 0) await this.ctx.storage.put(RULE_BREAKS_KEY, countSent(judged.breaks, sent));
      }).catch((error: unknown) => console.error(`Weapon rules failed: ${errorText(error)}`)),
    );
  }

  // Lifts timed bans whose time is up, if the ban on the server is still the bot's. One that fails is tried again at
  // the next check.
  private async expireBans(config: Config): Promise<void> {
    const now = Date.now();
    const book = parseBanBook(await this.ctx.storage.get('bans'));
    const due = expiredBans(book, now);
    if (due.length === 0) return;
    const http = socketHttp(connect);
    try {
      const onServer = await fetchBans(config.rconUrl, config.rconPassword, http);
      for (const steamId of due) {
        const ban = book[steamId];
        if (ban === undefined) continue;
        const current = onServer.find((b) => b.steamId === steamId);
        const label = `${JSON.stringify(ban.name)} (${steamId})`;
        if (current === undefined || !isBotBan(current.reason, ban)) {
          // Lifted already, or lifted and banned again some other way: that ban is not the bot's to lift. A ban still
          // waiting for the player to join was never on the server.
          await this.record(steamId, null, { ban: null });
          const why = current !== undefined ? 'has a newer ban, left alone' : ban.waiting ? 'ran out before they joined' : 'was already unbanned';
          console.info(`Ban ended: ${label} ${why}`);
          continue;
        }
        await removeBan(config.rconUrl, config.rconPassword, steamId, http);
        await this.record(
          steamId,
          { action: 'unban', at: now, by: 'bot', name: ban.name, reason: 'The ban ran out' },
          { ban: null, serverBan: null },
        );
        console.info(`Ban ended: ${label}`);
      }
    } catch (error) {
      console.error(`Lifting ended bans failed: ${errorText(error)}`);
    }
  }

  // Bans staff made while the player was not in game, which the game refuses: they go on the server, with a kick, at
  // the first check that sees the player. A ban or kick that fails is tried again at the next check, and a kick until
  // the player has gone.
  private async applyWaitingBans(config: Config, snapshot: Snapshot | null): Promise<void> {
    if (snapshot === null) return;
    try {
      const book = parseBanBook(await this.ctx.storage.get('bans'));
      const work = joinWork(book, snapshot.players.map((p) => p.steamId), Date.now());
      const http = socketHttp(connect);
      const label = (steamId: string): string => `${JSON.stringify(book[steamId]?.name ?? '')} (${steamId})`;
      // Saves the ban as on the server, with a kick still owed or not. `banned` is set when it has just gone on the server.
      const applied = async (steamId: string, kicking: boolean, banned = false): Promise<void> => {
        const old = book[steamId];
        if (old === undefined) return;
        const { waiting: _waiting, kicking: _kicking, ...ban } = old;
        book[steamId] = kicking ? { ...ban, kicking } : ban;
        await this.record(steamId, null, { ban: book[steamId], ...(banned ? { serverBan: { reason: ban.serverReason, bannedBy: null } } : {}) });
      };
      for (const steamId of work.gone) await applied(steamId, false);
      const kick = [...work.kick];
      for (const steamId of work.ban) {
        const ban = book[steamId];
        if (ban === undefined) continue;
        try {
          await addBan(config.rconUrl, config.rconPassword, steamId, ban.serverReason, http);
        } catch (error) {
          // Left again before the ban went in: it waits for the next time they join.
          if (!isNotInGame(error)) console.error(`Waiting ban on ${label(steamId)} failed: ${errorText(error)}`);
          continue;
        }
        await applied(steamId, true, true);
        console.info(`Ban put on the server as they joined: ${label(steamId)}`);
        kick.push(steamId);
      }
      for (const steamId of kick) {
        const ban = book[steamId];
        if (ban === undefined) continue;
        try {
          await kickPlayer(config.rconUrl, config.rconPassword, steamId, banKickReason(ban.reason, config.siteUrl), http);
        } catch (error) {
          // Not in game any more is as good as kicked: the ban keeps them out.
          if (!isNotInGame(error)) {
            console.error(`Kick after the waiting ban on ${label(steamId)} failed, trying again next check: ${errorText(error)}`);
            continue;
          }
        }
        await applied(steamId, false);
      }
    } catch (error) {
      console.error(`Waiting bans failed: ${errorText(error)}`);
    }
  }

  // Bans made or lifted outside the bot (in game, in ServerSettings.ini, or by another tool) go in the player's staff
  // history and to the moderation log. The first reading is only saved, so a deploy does not post every ban there is.
  // It runs one at a time with the bot's own ban changes, which keep the saved list up to date as they make them. Skipped
  // while the server is not answering, and until BAN_WATCH_MS after the last reading; a failure waits as long.
  private async watchBans(config: Config, snapshot: Snapshot | null): Promise<void> {
    if (snapshot === null) return;
    const now = Date.now();
    const storage = this.ctx.storage;
    try {
      const readAt = await storage.get('bansReadAt');
      if (typeof readAt === 'number' && now - readAt < BAN_WATCH_MS) return;
      await storage.put('bansReadAt', now);
      const onServer = await fetchBans(config.rconUrl, config.rconPassword, socketHttp(connect));
      const stored = await storage.get(['serverBans', 'bans']);
      const saved = parseServerBans(stored.get('serverBans'));
      const current: ServerBans = Object.fromEntries(onServer.map(({ steamId, reason, bannedBy }) => [steamId, { reason, bannedBy }]));
      if (saved === null) {
        await storage.put('serverBans', current);
        console.info(`Watching the server's ban list: ${onServer.length} bans`);
        return;
      }
      const { added, lifted } = banChanges(saved, onServer);
      if (added.length === 0 && lifted.length === 0) return;
      const book = parseBanBook(stored.get('bans'));
      const names = await this.namesFor([...added, ...lifted].map((b) => b.steamId), snapshot);
      const by = (ban: ServerBan) => (ban.bannedBy ? { detail: `By ${ban.bannedBy}` } : {});
      for (const { steamId, ban } of added) {
        // One of the bot's own that the saved list missed, such as a ban that timed out but went through.
        const ours = book[steamId];
        if (ours !== undefined && isBotBan(ban.reason, ours)) continue;
        const name = names.get(steamId) ?? steamId;
        await this.record(steamId, { action: 'ban', at: now, by: 'server', name, ...(ban.reason ? { reason: ban.reason } : {}), ...by(ban) });
        console.info(`Ban made outside the bot: ${JSON.stringify(name)} (${steamId}): ${JSON.stringify(ban.reason ?? '')}`);
      }
      for (const { steamId, ban } of lifted) {
        const name = names.get(steamId) ?? steamId;
        // One of the bot's own bans, lifted some other way: the bot forgets it too, so it no longer counts as banned.
        const ours = book[steamId];
        const theirs = ours !== undefined && isBotBan(ban.reason, ours);
        await this.record(
          steamId,
          { action: 'unban', at: now, by: 'server', name, ...(ban.reason ? { reason: `Was banned for: ${ban.reason}` } : {}) },
          theirs ? { ban: null } : {},
        );
        console.info(`Ban lifted outside the bot: ${JSON.stringify(name)} (${steamId})`);
      }
      await storage.put('serverBans', current);
    } catch (error) {
      console.error(`Watching the ban list failed: ${errorText(error)}`);
    }
  }

  // The best name the bot has for each Steam ID: in game now, then the newest of the last 90 days' records, its bans and
  // staff history.
  private async namesFor(steamIds: string[], snapshot: Snapshot | null): Promise<Map<string, string>> {
    const wanted = new Set(steamIds);
    const names = new Map<string, string>();
    const stored = await this.ctx.storage.get(['bans', ...steamIds.map(modLogKey)]);
    for (const steamId of wanted) {
      const logged = parseModLog(stored.get(modLogKey(steamId))).findLast((e) => e.name !== undefined && e.name !== steamId)?.name;
      if (logged !== undefined) names.set(steamId, logged);
    }
    for (const [steamId, ban] of Object.entries(parseBanBook(stored.get('bans')))) if (wanted.has(steamId)) names.set(steamId, ban.name);
    for (const day of await this.recentDays(Date.now())) {
      for (const [steamId, t] of Object.entries(day.players)) if (wanted.has(steamId)) names.set(steamId, t.name);
    }
    for (const p of snapshot?.players ?? []) if (wanted.has(p.steamId)) names.set(p.steamId, p.name);
    return names;
  }

  // STEAM_API_KEY, the key for the Steam Web API, or null when it is not set: then nobody is checked.
  private steamApiKey(): string | null {
    return stringVars(this.env)['STEAM_API_KEY']?.trim() || null;
  }

  // The Steam checks for these players, read from storage once and then kept in memory.
  private async loadSteam(steamIds: string[]): Promise<Map<string, SteamCheck | null>> {
    const missing = [...new Set(steamIds)].filter((steamId) => !this.steamChecks.has(steamId));
    // Reads take as many keys at once as writes.
    for (let i = 0; i < missing.length; i += RECORDS_PER_WRITE) {
      const part = missing.slice(i, i + RECORDS_PER_WRITE);
      const stored = await this.ctx.storage.get(part.map(steamKey));
      // One saved while this was being read is newer.
      for (const steamId of part) if (!this.steamChecks.has(steamId)) this.steamChecks.set(steamId, parseSteamCheck(stored.get(steamKey(steamId))));
    }
    return this.steamChecks;
  }

  // The saved Steam checks for these players, for a post: none without STEAM_API_KEY, or when storage cannot be read, so
  // the post still goes out.
  private async savedSteam(steamIds: string[]): Promise<Map<string, SteamCheck | null>> {
    if (this.steamApiKey() === null) return new Map();
    try {
      return await this.loadSteam(steamIds);
    } catch (error) {
      console.error(`Reading Steam checks failed: ${errorText(error)}`);
      return new Map();
    }
  }

  // Keeps the highest score posted so far, so a check saved from an earlier reading never makes an alert go out again,
  // and never saves a check over a newer one.
  private async saveSteam(checks: [string, SteamCheck][]): Promise<void> {
    for (let i = 0; i < checks.length; i += RECORDS_PER_WRITE) {
      const part = checks.slice(i, i + RECORDS_PER_WRITE).map(([steamId, check]): [string, SteamCheck] => {
        const saved = this.steamChecks.get(steamId) ?? null;
        const latest = saved !== null && saved.at > check.at ? saved : check;
        const alerted = Math.max(check.alerted ?? 0, saved?.alerted ?? 0);
        return [steamId, alerted > 0 ? { ...latest, alerted } : latest];
      });
      await this.ctx.storage.put(Object.fromEntries(part.map(([steamId, check]) => [steamKey(steamId), check])));
      for (const [steamId, check] of part) this.steamChecks.set(steamId, check);
    }
  }

  // Asks Steam about the players in game it has not checked, or not for a day, up to 100 at a check, and posts those with
  // an account at the alert mark (RISK.alert) to the moderation log channel: once, and again only if it gets riskier.
  // High-risk accounts below it are only logged, listed on the staff page and shown on griefing posts. After Steam fails
  // or refuses, it waits STEAM_RETRY_MS before asking again. A failure never stops the rest of the check.
  private async checkSteam(snapshot: Snapshot | null): Promise<void> {
    const apiKey = this.steamApiKey();
    if (apiKey === null || snapshot === null || snapshot.players.length === 0) return;
    const now = Date.now();
    try {
      const names = new Map(snapshot.players.map((p) => [p.steamId, p.name]));
      const inGame = [...names.keys()];
      const known = await this.loadSteam(inGame);
      const due = now >= this.steamRetryAt ? checksDue(inGame, known, now) : [];
      const changed = new Map<string, SteamCheck>();
      if (due.length > 0) {
        try {
          for (const [steamId, check] of await fetchSteamChecks(apiKey, due, now)) {
            // The score last posted is kept, so a check that finds nothing new posts nothing.
            const alerted = known.get(steamId)?.alerted;
            changed.set(steamId, alerted === undefined ? check : { ...check, alerted });
          }
        } catch (error) {
          this.steamRetryAt = now + STEAM_RETRY_MS;
          console.error(`Steam checks failed, trying again in ${STEAM_RETRY_MS / 60_000} minutes: ${errorText(error)}`);
        }
      }
      const checked = [...changed];
      const { modLogWebhookUrl, steamAlerts, siteUrl } = this.posting();
      const alerts =
        modLogWebhookUrl === undefined || !steamAlerts
          ? []
          : inGame.flatMap((steamId): SteamAlert[] => {
              const check = changed.get(steamId) ?? known.get(steamId) ?? null;
              if (check === null || !alertDue(check, now)) return [];
              return [{ steamId, name: names.get(steamId) || steamId, check: { ...check, alerted: assess(check, now).score } }];
            });
      // Marked as posted in the same write, before posting: a post that fails is logged, not retried.
      for (const alert of alerts) changed.set(alert.steamId, alert.check);
      if (changed.size === 0) return;
      await this.saveSteam([...changed]);
      for (const [steamId, check] of checked) {
        const { risk, score } = assess(check, now);
        if (risk === 'low') continue;
        console.info(
          `Risky Steam account: ${JSON.stringify(names.get(steamId) ?? '')} (${steamId}): ${RISK_LABELS[risk]}, ${score} points: ` +
            steamFacts(check, now).join(', '),
        );
      }
      if (checked.length > 0) console.info(`Steam checks: ${checked.length} players`);
      if (modLogWebhookUrl === undefined || alerts.length === 0) return;
      const messages = buildSteamAlerts(alerts, now, siteUrl);
      // In order, in the background, so a slow Discord never holds up the check.
      this.ctx.waitUntil(
        (async () => {
          for (const message of messages) {
            await postWebhook(modLogWebhookUrl, message)
              .then(() => this.countAlert('steam', now, message.embeds.length))
              .catch((error: unknown) => console.error(`Risky Steam account alert failed: ${errorText(error)}`));
          }
        })(),
      );
    } catch (error) {
      console.error(`Steam checks failed: ${errorText(error)}`);
    }
  }

  // A player's Steam check for /player: the saved one, or one made now when there is none or it is a day old. Staff
  // asked, so it does not wait out a failure, and it is not posted to the moderation log.
  async steamLookup(steamId: string): Promise<SteamLookup> {
    const apiKey = this.steamApiKey();
    if (apiKey === null) return 'off';
    return this.steamChecking(async (): Promise<SteamLookup> => {
      const now = Date.now();
      const saved = (await this.loadSteam([steamId])).get(steamId) ?? null;
      if (saved !== null && now - saved.at < RECHECK_MS) return saved;
      try {
        const check = (await fetchSteamChecks(apiKey, [steamId], now)).get(steamId);
        if (check === undefined) return saved ?? 'failed';
        await this.saveSteam([[steamId, check]]);
        return this.steamChecks.get(steamId) ?? check;
      } catch (error) {
        console.error(`Steam check for /player failed (${steamId}): ${errorText(error)}`);
        return saved ?? 'failed';
      }
    });
  }

  // The staff page's Steam checks: everyone seen in the period or in game now, and the kill feed's kills and headshots
  // over the period for the risky ones. Null without STEAM_API_KEY.
  private async steamSources(playerDays: PlayerDay[], online: OnlineSnapshot | null, now: number, days: number): Promise<AdminSteamSources | null> {
    if (this.steamApiKey() === null) return null;
    const inGame = new Set(online?.players.map((p) => p.steamId) ?? []);
    const seen = steamPlayers(playerDays, inGame);
    const checks = await this.loadSteam(seen);
    const risky = riskySteamIds(seen, checks, now, inGame).slice(0, STEAM_ACCOUNTS_LISTED);
    const stored = risky.length === 0 ? new Map<string, unknown>() : await this.ctx.storage.get(risky.map(playerWeaponsKey));
    const oldest = dayOf(now - (days - 1) * DAY_MS);
    const feed = new Map(risky.map((steamId) => [steamId, feedKillsSince(parsePlayerWeapons(stored.get(playerWeaponsKey(steamId))), oldest)]));
    return { checks, inGame, feed };
  }

  // Every 10 minutes: gives VIP to players who have earned it, and takes it back when their time is up, and keeps a
  // staff spot on the whitelist for each staff member who linked their Steam account. A staff member who linked
  // or unlinked since the last update is seen to at the next check. VIP staff gave ends on time even when automatic
  // VIP is off.
  private async updateVip(config: Config): Promise<void> {
    const rule = config.vip;
    const storage = this.ctx.storage;
    const now = Date.now();
    const keys = rule === null ? [] : recentDayKeys(now, rule.windowDays);
    const stored = await storage.get(['vip', STAFF_PROFILES_KEY, PRIVATE_PROFILES_KEY]);
    const state = parseVipState(stored.get('vip'));
    const staff = staffBySteam(parseStaffProfiles(stored.get(STAFF_PROFILES_KEY)));
    const hidden = privateSteamIds(parsePrivateProfiles(stored.get(PRIVATE_PROFILES_KEY)));
    const idle = Object.keys(state.granted).length === 0 && staff.size === 0 && Object.keys(state.staffSpots).length === 0;
    if (rule === null && idle) return;
    if (!vipDue(state, now) && !staffSpotsDue(state, staff.keys())) return;
    const days = await storage.get(keys);
    const staffIds = new Set(staff.keys());
    try {
      const next = await syncVip({
        rule,
        days: keys.map((key) => withoutStaffSeeding(parsePlayerDay(days.get(key)), staffIds)),
        state,
        now,
        staff,
        rcon: this.settingsFile({ config, http: socketHttp(connect) }),
        log: console,
      });
      await storage.put('vip', next.state);
      // Posted once, after the list is saved: a failed post is logged, not retried, so nobody is announced twice.
      if (rule !== null && (next.added.length > 0 || next.renewed.length > 0)) {
        const message = buildVipMessage(publicNames(next.added, hidden), publicNames(next.renewed, hidden), rule, config.siteUrl);
        await postWebhook(config.webhookUrl, message).catch((error: unknown) =>
          console.error(`VIP announcement failed: ${errorText(error)}`),
        );
      }
    } catch (error) {
      console.error(`VIP update failed: ${errorText(error)}`);
      // Try again at the next 10-minute mark rather than on every check.
      await storage.put('vip', { ...state, checkedAt: now });
    }
  }

  // A batch from the game's kill feed: the day's weapon totals, each killer's, the live match, the match's state and
  // result, and the join log, in one write. Only storage is awaited, so no other batch is counted part-way through.
  // Answers how many events were new, and whether a new one was a match's result.
  async recordFeed({ timeline, presence }: FeedRecord): Promise<{ accepted: number; ended: boolean; over: boolean }> {
    const unseen = <T extends { eventId: string }>(list: T[]): T[] =>
      list.filter((e, i) => !this.eventsSeen.has(e.eventId) && list.findIndex((o) => o.eventId === e.eventId) === i);
    const happened = unseen(timeline);
    const came = unseen(presence);
    const fresh = [...happened, ...came];
    if (fresh.length === 0) return { accepted: 0, ended: false, over: false };
    const now = Date.now();
    const day = dayOf(now);
    const dayKey = weaponDayKey(now);
    const events = happened.filter((e): e is FeedEvent => !isMatchEvent(e));
    const matchEvents = happened.filter(isMatchEvent);
    const ended = matchEvents.some((e) => e.type === 'result');
    // The match is over for the map vote at its end screen, or at its result if that comes first.
    const over = matchEvents.some((e) => e.type === 'result' || e.state.startsWith('MatchState.PostMatch'));
    const kills = events.filter(isKill);
    const killers = [...new Set(kills.map((k) => k.killerSteamId))];
    const griefKey = griefDayKey(now);
    const stored = await this.ctx.storage.get([
      dayKey,
      griefKey,
      'killFeedSince',
      'live',
      'online',
      'state',
      KILL_FEED_KEY,
      MATCH_FEED_KEY,
      JOIN_LOG_KEY,
      ...killers.map(playerWeaponsKey),
    ]);
    const oldest = dayOf(now - (PROFILE_DAYS - 1) * DAY_MS);
    const first = events.length > 0 && typeof stored.get('killFeedSince') !== 'string';
    // The feed does not say who is on which side: the bot's last check does.
    const online = parseOnline(stored.get('online'));
    const tracked = parseState(stored.get('state'))?.match?.players ?? {};
    const factionOf = (steamId: string): string | null =>
      online?.players.find((p) => p.steamId === steamId)?.faction ?? tracked[steamId]?.faction ?? null;
    const grief = hasGrief(events, factionOf) ? recordGrief(parseGriefDay(stored.get(griefKey)), events, now, factionOf) : null;
    const staffKills = toStaffKills(kills, now, factionOf);
    const before = parseMatchFeed(stored.get(MATCH_FEED_KEY));
    const matchFeed = matchEvents.length === 0 ? before : recordMatchFeed(before, matchEvents, now);
    const live = events.length > 0 || ended ? recordLive(parseLiveMatch(stored.get('live')), happened, now, factionOf, before) : null;
    const joins = came.length === 0 ? null : recordPresence(parseJoinLog(stored.get(JOIN_LOG_KEY)), came, now);
    const write = this.ctx.storage.put({
      killFeedHeardAt: now,
      ...(live === null ? {} : { live }),
      ...(matchFeed === before ? {} : { [MATCH_FEED_KEY]: matchFeed }),
      ...(joins === null || joins.log === null || joins.added.length === 0 ? {} : { [JOIN_LOG_KEY]: joins.log }),
      ...(grief === null ? {} : { [griefKey]: grief.day }),
      ...(first ? { killFeedSince: day } : {}),
      ...(kills.length === 0
        ? {}
        : {
            [dayKey]: recordWeaponDay(parseWeaponDay(stored.get(dayKey)), kills),
            [KILL_FEED_KEY]: recordKillFeed(parseKillFeed(stored.get(KILL_FEED_KEY)), staffKills),
          }),
      ...Object.fromEntries(
        killers.map((steamId) => {
          const key = playerWeaponsKey(steamId);
          const theirs = kills.filter((k) => k.killerSteamId === steamId);
          return [key, recordPlayerWeapons(parsePlayerWeapons(stored.get(key)), theirs, day, oldest)];
        }),
      ),
    });
    // Remembered as the write goes out, so a copy of this batch arriving now is not counted again.
    for (const e of fresh) this.eventsSeen.add(e.eventId);
    for (const id of this.eventsSeen) {
      if (this.eventsSeen.size <= EVENTS_REMEMBERED) break;
      this.eventsSeen.delete(id);
    }
    try {
      await write;
    } catch (error) {
      for (const e of fresh) this.eventsSeen.delete(e.eventId);
      throw error;
    }
    // Once the batch is counted, so a batch sent again after a failed write is not added twice.
    if (staffKills.length > 0) this.recordKillDays(day, now, staffKills);
    if (joins !== null && joins.added.length > 0) this.recordSessions(joins.added, now);
    if (first) console.info(`Kill feed: first kills received. Weapon stats start today (${day}, UTC).`);
    if (grief !== null && grief.alerts.length > 0) this.postGriefAlerts(grief.alerts);
    if (grief !== null && grief.teamKillers.length > 0) this.warnTeamKillers(grief.teamKillers);
    if (kills.length > 0) this.enforceRules(kills, now);
    if (staffKills.length > 0) this.broadcastStaff({ type: 'kills', kills: adminFeed(staffKills) });
    // The game waits for the reply, and the seeding message and the live pages are not part of it: they are seen to once
    // it has gone.
    if (came.length > 0) this.ctx.waitUntil(this.feedJoined(came, now));
    this.ctx.waitUntil(this.broadcastLive());
    return { accepted: fresh.length, ended, over };
  }

  // The SQLite database, with the staff page's kill_days table, which is made the first time.
  private killSql(): Sql {
    const sql = this.ctx.storage.sql;
    if (!this.killTable) {
      createKillDays(sql);
      this.killTable = true;
    }
    return sql;
  }

  // A batch's kills for the staff page: each killer's day, in one transaction, and once a day the days no longer kept
  // go, and the kills of those past KILL_DAYS_KEPT. The day is noted in storage too (see recordSessions), with the day
  // the kills were cleared to, so a prune reads only the rows of the days since the last. A failure is only logged, as
  // the batch's other records are saved already.
  private recordKillDays(day: string, now: number, kills: StaffKill[]): void {
    try {
      const sql = this.killSql();
      const killers = [...new Set(kills.map((k) => k.killer))];
      const kv = this.ctx.storage.kv;
      const listedFrom = dayOf(now - (KILL_DAYS_KEPT - 1) * DAY_MS);
      const cleared = this.killsPrunedOn === day ? listedFrom : kv.get(KILL_LISTS_CLEARED_KEY);
      const written = this.ctx.storage.transactionSync(() => {
        const known = readKillDays(sql, day, killers);
        const days = killers.map((steamId) =>
          recordKillDay(known.get(steamId) ?? null, steamId, day, kills.filter((k) => k.killer === steamId)),
        );
        writeKillDays(sql, days);
        if (cleared !== listedFrom) {
          pruneKillDays(sql, dayOf(now - (KILL_DAYS_STORED - 1) * DAY_MS), listedFrom, typeof cleared === 'string' ? cleared : '');
          kv.put(KILL_LISTS_CLEARED_KEY, listedFrom);
        }
        return days;
      });
      this.killsPrunedOn = day;
      const cached = this.killDayCache.get(day);
      if (cached !== undefined) this.killDayCache.set(day, withKillDays(cached, written));
    } catch (error) {
      console.error(`Staff page kill records failed: ${errorText(error)}`);
    }
  }

  // Everyone's kill days over the KILL_DAYS_KEPT UTC days to `now`, oldest first.
  private keptKillDays(sql: Sql, now: number): KillDaySummary[] {
    const days = Array.from({ length: KILL_DAYS_KEPT }, (_, i) => dayOf(now - (KILL_DAYS_KEPT - 1 - i) * DAY_MS));
    for (const day of this.killDayCache.keys()) if (!days.includes(day)) this.killDayCache.delete(day);
    const missing = days.filter((day) => !this.killDayCache.has(day));
    if (missing.length > 0) for (const [day, list] of this.killSummaries(sql, missing, now)) this.killDayCache.set(day, list);
    return days.flatMap((day) => this.killDayCache.get(day) ?? []);
  }

  // The kill days of `days`, by day, from the summaries saved for the days that are done (see loadKillDays).
  private killSummaries(sql: Sql, days: string[], now: number): Map<string, KillDaySummary[]> {
    return loadKillDays(sql, days, now, (write) => {
      try {
        this.ctx.storage.transactionSync(write);
      } catch (error) {
        console.error(`Saving kill summaries failed: ${errorText(error)}`);
      }
    });
  }

  // The staff page's Kill feed tab: the server's latest kills, and who gets the most headshots over the last `days` UTC
  // days.
  async adminKills(days: number): Promise<AdminKills> {
    const now = Date.now();
    const stored = await this.ctx.storage.get([KILL_FEED_KEY, 'online']);
    const sql = this.killSql();
    return buildAdminKills({
      now,
      days,
      since: firstKillDay(sql),
      from: dayOf(now - (days - 1) * DAY_MS),
      kept: this.keptKillDays(sql, now),
      inGame: new Set(this.onlineNow(now, stored.get('online'))?.players.map((p) => p.steamId)),
      feed: parseKillFeed(stored.get(KILL_FEED_KEY)),
    });
  }

  // Today's headshots of those in game, for the staff page's server list. A failure only leaves them out.
  private headshotsToday(now: number, steamIds: string[]): Map<string, HeadshotDay> {
    if (steamIds.length === 0) return new Map();
    try {
      return headshotsOn(this.keptKillDays(this.killSql(), now), dayOf(now), steamIds);
    } catch (error) {
      console.error(`Staff page: today's headshots could not be read: ${errorText(error)}`);
      return new Map();
    }
  }

  // Days of unlikely headshots (see killfeed.ts) of players in game, to the moderation log channel when HEADSHOT_ALERTS
  // is on: each player once a UTC day, with their Steam account when it is risky. Marked as posted before posting, so a
  // post that fails is logged, not retried. A failure never stops the rest of the check.
  private async checkHeadshots(snapshot: Snapshot | null): Promise<void> {
    const { modLogWebhookUrl, headshotAlerts, siteUrl } = this.posting();
    if (modLogWebhookUrl === undefined || !headshotAlerts || snapshot === null || snapshot.players.length === 0) return;
    const now = Date.now();
    const day = dayOf(now);
    try {
      const alerted = alertedOn(await this.ctx.storage.get(HEADSHOTS_ALERTED_KEY), day);
      const names = new Map(snapshot.players.map((p) => [p.steamId, p.name]));
      const due = headshotAlertsDue(this.keptKillDays(this.killSql(), now), day, names.keys(), alerted).map((a) => ({
        ...a,
        name: names.get(a.steamId) || a.name,
      }));
      if (due.length === 0) return;
      await this.ctx.storage.put(HEADSHOTS_ALERTED_KEY, { day, steamIds: [...alerted, ...due.map((a) => a.steamId)] });
      for (const a of due) {
        console.info(
          `Unlikely headshots: ${JSON.stringify(a.name)} (${a.steamId}): ${a.headshots} in ${a.kills} kills, ${luckOdds(a.chance)}, ` +
            `flagged on ${a.flaggedDays} days`,
        );
      }
      const steam = await this.savedSteam(due.map((a) => a.steamId));
      this.ctx.waitUntil(
        (async () => {
          for (const alert of due) {
            await postWebhook(modLogWebhookUrl, buildHeadshotAlert(alert, now, siteUrl, steam.get(alert.steamId) ?? null))
              .then(() => this.countAlert('headshot', now))
              .catch((error: unknown) => console.error(`Headshot alert failed (${alert.steamId}): ${errorText(error)}`));
          }
        })(),
      );
    } catch (error) {
      console.error(`Headshot alerts failed: ${errorText(error)}`);
    }
  }

  // The kill feed going quiet while the server is live, and events arriving again after (see feedwatch.ts), to the
  // moderation log channel when FEED_ALERTS is on. Watched once the bot has had the feed, while KILL_FEED_TOKEN is set.
  // A failure never stops the rest of the check.
  private async watchFeed(config: Config, snapshot: Snapshot | null): Promise<void> {
    if ((stringVars(this.env)['KILL_FEED_TOKEN']?.trim() ?? '') === '') return;
    try {
      const stored = await this.ctx.storage.get([FEED_WATCH_KEY, 'killFeedHeardAt', 'killFeedSince']);
      if (typeof stored.get('killFeedSince') !== 'string') return;
      const heard = stored.get('killFeedHeardAt');
      const before = parseFeedWatch(stored.get(FEED_WATCH_KEY));
      const { watch, event } = observeFeed(before, {
        at: Date.now(),
        players: snapshot?.status.players ?? null,
        live: config.rules.live,
        heardAt: typeof heard === 'number' ? heard : null,
      });
      if (watch !== before) await this.ctx.storage.put(FEED_WATCH_KEY, watch);
      if (event === null) return;
      console.info(
        event.type === 'quiet'
          ? `Kill feed quiet: no batch for ${Math.round((event.at - event.quietFrom) / 60_000)} minutes with ${event.players} players on`
          : `Kill feed back: events arriving again after ${Math.round((event.heardAt - event.quietFrom) / 60_000)} minutes quiet`,
      );
      const { modLogWebhookUrl, feedAlerts, siteUrl } = config;
      if (modLogWebhookUrl === undefined || !feedAlerts) return;
      this.ctx.waitUntil(
        postWebhook(modLogWebhookUrl, buildFeedAlert(event, siteUrl))
          .then(() => this.countAlert(event.type === 'quiet' ? 'feedQuiet' : 'feedBack', event.at))
          .catch((error: unknown) => console.error(`Kill feed alert failed: ${errorText(error)}`)),
      );
    } catch (error) {
      console.error(`Kill feed watch failed: ${errorText(error)}`);
    }
  }

  // The alert review (see review.ts) over the last `days` UTC days.
  async review(days: number): Promise<Review> {
    const now = Date.now();
    const config = loadConfig(stringVars(this.env));
    const griefKeys = Array.from({ length: days }, (_, i) => griefDayKey(now - (days - 1 - i) * DAY_MS));
    const [stored, recent] = await Promise.all([
      this.ctx.storage.get([...griefKeys, ALERT_LOG_KEY, OUTAGE_LOG_KEY, 'state']),
      this.recentDays(now),
    ]);
    const seen = steamPlayers(
      recent.slice(-days).map((d) => d.players),
      [],
    );
    const checks = this.steamApiKey() === null ? null : await this.loadSteam(seen);
    return buildReview({
      now,
      days,
      rules: config.rules,
      quietHours: config.quietHours,
      posts: {
        modLog: config.modLogWebhookUrl !== undefined,
        grief: config.griefAlerts,
        steam: config.steamAlerts,
        headshot: config.headshotAlerts,
        outage: config.outageAlerts,
      },
      alertLog: parseAlertLog(stored.get(ALERT_LOG_KEY)),
      outageLog: parseOutageLog(stored.get(OUTAGE_LOG_KEY)),
      outage: parseState(stored.get('state'))?.outage ?? null,
      grief: griefKeys.map((key) => parseGriefDay(stored.get(key))),
      kept: this.keptKillDays(this.killSql(), now),
      steam: checks === null ? null : seen.flatMap((steamId) => checks.get(steamId) ?? []),
    });
  }

  // One player's kills and times on the server over the last `days` UTC days, for the History tab.
  async adminPlayerKills(steamId: string, days: number): Promise<AdminPlayerKills & { sessions: AdminSession[] }> {
    const now = Date.now();
    const [stored, ids] = await Promise.all([this.ctx.storage.get(['online', JOIN_LOG_KEY]), this.idsFor([steamId])]);
    const online = this.onlineNow(now, stored.get('online'));
    const sql = this.killSql();
    const from = dayOf(now - (days - 1) * DAY_MS);
    // Their times on the server in the period, and the one they are on now while the server is answering.
    const onNow = online?.players.some((p) => p.steamId === steamId) ? (parseJoinLog(stored.get(JOIN_LOG_KEY))?.inGame[steamId] ?? null) : null;
    const sessions = playerSessions(this.sessionSql(), steamId, Date.parse(from), onNow, online?.at ?? now);
    const kills = buildPlayerKills({
      now,
      days,
      since: firstKillDay(sql),
      from,
      kept: this.keptKillDays(sql, now),
      inGame: new Set(online?.players.map((p) => p.steamId)),
      steamId,
      rows: playerKillDays(sql, steamId, from),
      name: online?.players.find((p) => p.steamId === steamId)?.name,
      idOf: (id) => ids.get(id),
    });
    return { ...kills, sessions };
  }

  // The live page: the server and its match from the last check, and the kill feed's match while it is the one on now.
  async live(): Promise<LiveSnapshot> {
    const now = Date.now();
    const stored = await this.ctx.storage.get(['stats', 'live', 'killFeedSince', 'killFeedHeardAt', MATCH_FEED_KEY, PRIVATE_PROFILES_KEY]);
    const stats = parseStats(stored.get('stats'));
    const server = stats.server !== null && now - stats.server.seenAt < OFFLINE_AFTER_MS ? stats.server : null;
    const onServer = server === null ? null : stats.currentMatch;
    // While the feed is quiet, what it last said may be out of date: the match is then judged on the checks alone.
    const heard = this.heardFeed(stored.get(MATCH_FEED_KEY), stored.get('killFeedHeardAt'), now);
    const feed = heard ?? NO_MATCH_FEED;
    const saved = parseLiveMatch(stored.get('live'));
    const match = saved !== null && isCurrent(saved, feed, onServer, now) ? saved : null;
    const phase = server === null || feed.state === null || feed.stateAt === null ? null : phaseOf(feed.state);
    const ids = await this.idsFor([
      ...liveSteamIds(match),
      ...(onServer?.top.flatMap((p) => (p.steamId === undefined ? [] : [p.steamId])) ?? []),
    ]);
    const idOf = publicIdOf(privateSteamIds(parsePrivateProfiles(stored.get(PRIVATE_PROFILES_KEY))), (steamId) => ids.get(steamId));
    return {
      generatedAt: now,
      feed: typeof stored.get('killFeedSince') === 'string',
      server: stats.server,
      currentMatch: publicCurrentMatch(onServer, idOf),
      phase: phase === null || feed.stateAt === null ? null : { phase, since: feed.stateAt },
      match: match === null ? null : liveStats(match, idOf),
    };
  }

  // Sends every open live page what it shows now. A page that has gone is skipped; the runtime closes it.
  private async broadcastLive(): Promise<void> {
    const sockets = this.ctx.getWebSockets(LIVE_TAG);
    if (sockets.length === 0) return;
    try {
      const message = JSON.stringify(await this.live());
      for (const socket of sockets) {
        try {
          socket.send(message);
        } catch {
          // Closing already.
        }
      }
    } catch (error) {
      console.error(`Live page update failed: ${errorText(error)}`);
    }
  }

  // A live page's WebSocket. It gets what the page shows straight away, then again after every kill feed batch and
  // every check. The object can sleep between them; the sockets stay open.
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const url = new URL(request.url);
    if (url.pathname === STAFF_SOCKET_PATH) return this.staffSocket(Number(url.searchParams.get('until')));
    if (this.ctx.getWebSockets(LIVE_TAG).length >= LIVE_VIEWERS) return new Response('Too many live pages open', { status: 503 });
    const snapshot = JSON.stringify(await this.live());
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [LIVE_TAG]);
    server.send(snapshot);
    return new Response(null, { status: 101, webSocket: client });
  }

  // A signed-in staff page's live kill feed (see staffSocket below), open until its session runs out (`until`). It gets
  // the latest kills straight away, then each batch's as it comes in.
  private async staffSocket(until: number): Promise<Response> {
    if (this.ctx.getWebSockets(STAFF_TAG).length >= STAFF_VIEWERS) return new Response('Too many staff pages open', { status: 503 });
    const feed = parseKillFeed(await this.ctx.storage.get(KILL_FEED_KEY));
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [STAFF_TAG]);
    server.serializeAttachment({ until });
    server.send(JSON.stringify({ type: 'feed', feed: adminFeed(feed) } satisfies StaffLiveMessage));
    return new Response(null, { status: 101, webSocket: client, headers: { 'sec-websocket-protocol': STAFF_SOCKET_PROTOCOL } });
  }

  // Sends every open staff page a batch's kills. One whose session has run out is closed instead, with 4401: the page
  // then asks its user to sign in again.
  private broadcastStaff(message: StaffLiveMessage): void {
    const sockets = this.ctx.getWebSockets(STAFF_TAG);
    if (sockets.length === 0) return;
    const now = Date.now();
    const text = JSON.stringify(message);
    for (const socket of sockets) {
      const until = z.object({ until: z.number() }).safeParse(socket.deserializeAttachment()).data?.until ?? 0;
      try {
        if (until > now) socket.send(text);
        else socket.close(4401, 'Sign in again');
      } catch {
        // Closing already.
      }
    }
  }

  // Pages only send pings, which the auto-response answers.
  async webSocketMessage(): Promise<void> {}

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    try {
      socket.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  // The weapons of the last `count` UTC days, oldest first, today last.
  private async recentWeaponDays(now: number, count: number): Promise<WeaponDay[]> {
    const keys = Array.from({ length: count }, (_, i) => weaponDayKey(now - (count - 1 - i) * DAY_MS));
    const fresh = keys.slice(-2);
    const read = keys.filter((key) => fresh.includes(key) || !this.weaponDayCache.has(key));
    const stored = await this.ctx.storage.get(read);
    for (const key of this.weaponDayCache.keys()) if (!keys.includes(key)) this.weaponDayCache.delete(key);
    for (const key of read) if (!fresh.includes(key)) this.weaponDayCache.set(key, parseWeaponDay(stored.get(key)));
    return keys.map((key) => (fresh.includes(key) ? parseWeaponDay(stored.get(key)) : (this.weaponDayCache.get(key) ?? {})));
  }

  async stats(): Promise<PublicStats> {
    const config = loadConfig(stringVars(this.env));
    const now = Date.now();
    const [stored, days, weaponDays, records] = await Promise.all([
      this.ctx.storage.get(['stats', 'killFeedSince', 'vip', STAFF_PROFILES_KEY, PRIVATE_PROFILES_KEY]),
      this.recentDays(now),
      this.recentWeaponDays(now, LEADERBOARD_DAYS),
      this.matchRecords(now),
    ]);
    const stats = parseStats(stored.get('stats'));
    const since = stored.get('killFeedSince');
    const board = leaderboard(days.slice(-LEADERBOARD_DAYS).map((d) => d.players), LEADERBOARD_DAYS, LEADERBOARD_SIZE);
    const staff = staffSteamIds(parseStaffProfiles(stored.get(STAFF_PROFILES_KEY)));
    const recent = recentSeeders(days.map((d) => d.players), SEEDERS_LISTED);
    const seeders = config.vip === null ? null : seederVip(parseVipState(stored.get('vip')), now, staff);
    const ids = await this.idsFor([
      ...namedSteamIds(stats, board, recent),
      ...weaponHolders(weaponDays),
      ...(seeders ?? []).map((p) => p.steamId),
    ]);
    const idOf = publicIdOf(privateSteamIds(parsePrivateProfiles(stored.get(PRIVATE_PROFILES_KEY))), (steamId) => ids.get(steamId));
    const weapons = typeof since === 'string' ? weaponBoard(weaponDays, LEADERBOARD_DAYS, since, WEAPONS_LISTED, idOf) : null;
    const { seeding, live } = config.rules;
    const extras = { leaderboard: board, recentSeeders: recent, vip: config.vip, seederVip: seeders, weapons, teams: teamBoard(records, LEADERBOARD_DAYS, now) };
    return publicStats(stats, { seeding, live, busy: config.busyThreshold }, now, extras, idOf);
  }

  // The key for players' public ids, made the first time it is needed. Changing it would change every id, and break
  // every link to a player page, so it is stored with the records.
  private publicIdKey(): Promise<CryptoKey> {
    this.idKey ??= (async () => {
      const stored = await this.ctx.storage.get('playerIdKey');
      const key = isIdKey(stored) ? stored : newIdKey();
      if (key !== stored) await this.ctx.storage.put('playerIdKey', key);
      return importIdKey(key);
    })().catch((error: unknown) => {
      this.idKey = null;
      throw error;
    });
    return this.idKey;
  }

  // Works out the public ids it does not know yet, and returns every id it knows, by Steam ID.
  private async idsFor(steamIds: Iterable<string>): Promise<Map<string, string>> {
    const missing = [...new Set(steamIds)].filter((steamId) => !this.ids.has(steamId));
    if (missing.length > 0) {
      const key = await this.publicIdKey();
      const made = await Promise.all(missing.map(async (steamId) => [steamId, await publicId(key, steamId)] as const));
      for (const [steamId, id] of made) this.ids.set(steamId, id);
    }
    return this.ids;
  }

  // Each player's totals for every UTC day of the player pages, oldest first, today last. Staff's time counts as
  // playing, never seeding (see withoutStaffSeeding); the cache keeps the records as they are.
  private async recentDays(now: number): Promise<DayRecords[]> {
    const keys = recentDayKeys(now, PROFILE_DAYS);
    const fresh = keys.slice(-2);
    const read = keys.filter((key) => fresh.includes(key) || !this.dayCache.has(key));
    const stored = await this.ctx.storage.get([...read, STAFF_PROFILES_KEY]);
    const staff = staffSteamIds(parseStaffProfiles(stored.get(STAFF_PROFILES_KEY)));
    for (const key of this.dayCache.keys()) if (!keys.includes(key)) this.dayCache.delete(key);
    for (const key of read) if (!fresh.includes(key)) this.dayCache.set(key, parsePlayerDay(stored.get(key)));
    return keys.map((key) => ({
      day: dayOfKey(key),
      players: withoutStaffSeeding(fresh.includes(key) ? parsePlayerDay(stored.get(key)) : (this.dayCache.get(key) ?? {}), staff),
    }));
  }

  // The records of the matches that ended in the same UTC days, as a match counts on the day it ended. Records are
  // keyed by when the match started, so they are read from a day earlier, for a match that ran past midnight.
  private async matchRecords(now: number): Promise<MatchRecord[]> {
    const first = Date.parse(`${dayOf(now - (PROFILE_DAYS - 1) * DAY_MS)}T00:00:00Z`);
    const start = matchRecordKey(first - DAY_MS);
    const last = [...this.matchCache.keys()].at(-1);
    const stored = await this.ctx.storage.list({ prefix: 'match:', ...(last === undefined ? { start } : { startAfter: last }) });
    for (const [key, value] of stored) {
      const record = parseMatchRecord(value);
      if (record !== null) this.matchCache.set(key, record);
    }
    for (const key of this.matchCache.keys()) if (key < start) this.matchCache.delete(key);
    return [...this.matchCache.values()].filter((record) => record.endedAt >= first);
  }

  // Who was in game at the last check, unless the server has stopped answering since.
  private onlineNow(now: number, raw: unknown): OnlineSnapshot | null {
    const online = parseOnline(raw);
    return online !== null && now - online.at < OFFLINE_AFTER_MS ? online : null;
  }

  // Everyone seen in the last PROFILE_DAYS days, to find a player page in.
  async players(): Promise<PlayerDirectory> {
    const now = Date.now();
    const [days, stored] = await Promise.all([this.recentDays(now), this.ctx.storage.get(['online', PRIVATE_PROFILES_KEY])]);
    const ids = await this.idsFor(days.flatMap((d) => Object.keys(d.players)));
    const online = new Set(this.onlineNow(now, stored.get('online'))?.players.map((p) => p.steamId));
    const idOf = publicIdOf(privateSteamIds(parsePrivateProfiles(stored.get(PRIVATE_PROFILES_KEY))), (steamId) => ids.get(steamId));
    return directory(days, idOf, online, now);
  }

  // One player's page, by public id. Null when nobody seen in the last PROFILE_DAYS days has that id, or their profile
  // is private, so a private profile cannot be told from nobody.
  async profile(id: string): Promise<PlayerProfile | null> {
    const now = Date.now();
    const [days, hidden] = await Promise.all([this.recentDays(now), this.privateSteam()]);
    const ids = await this.idsFor(days.flatMap((d) => Object.keys(d.players)));
    const steamId = [...ids].find(([, known]) => known === id)?.[0];
    if (steamId === undefined || hidden.has(steamId)) return null;
    const [matches, stored, staff] = await Promise.all([
      this.matchRecords(now),
      this.ctx.storage.get(['state', 'vip', 'online', 'killFeedSince', playerWeaponsKey(steamId)]),
      this.staffSteam(),
    ]);
    const snapshot = this.onlineNow(now, stored.get('online'));
    const inGame = snapshot?.players.find((p) => p.steamId === steamId);
    const tracked = parseState(stored.get('state'))?.match?.players[steamId];
    const online: OnlineNow | null =
      snapshot === null || inGame === undefined
        ? null
        : {
            map: mapName(snapshot.map),
            faction: inGame.faction ?? tracked?.faction ?? null,
            kills: tracked?.kills ?? inGame.kills ?? 0,
            deaths: tracked?.deaths ?? inGame.deaths ?? 0,
          };
    const config = loadConfig(stringVars(this.env));
    const since = stored.get('killFeedSince');
    return buildProfile({
      steamId,
      id,
      now,
      days,
      matches,
      rankDays: LEADERBOARD_DAYS,
      online,
      vip: parseVipState(stored.get('vip')).granted[steamId] ?? null,
      // Staff cannot earn seeder VIP, so their page does not count them towards it.
      rule: staff.has(steamId) ? null : config.vip,
      weapons:
        typeof since === 'string'
          ? { since, used: playerWeaponDays(parsePlayerWeapons(stored.get(playerWeaponsKey(steamId))), days[0]?.day ?? since) }
          : null,
    });
  }

  // The staff page: who is in game now, possible griefers and their incidents over the last `days` UTC days, risky Steam
  // accounts, what staff did in them, and the bans on the server now. The ban list is read from the server; without it
  // the rest still shows.
  async adminOverview(days: number): Promise<AdminOverview> {
    const now = Date.now();
    const griefKeys = Array.from({ length: days }, (_, i) => griefDayKey(now - (days - 1 - i) * DAY_MS));
    const { config } = this.rcon();
    const http = socketHttp(connect, SUGGEST_TIMEOUT_MS);
    const [stored, recent, logs, serverBans, serverConfig] = await Promise.all([
      this.ctx.storage.get([
        ...griefKeys,
        'killFeedSince',
        'bans',
        'vip',
        'online',
        'state',
        'stats',
        JOIN_LOG_KEY,
        STAFF_NAMES_KEY,
        STAFF_PROFILES_KEY,
        CHECKED_KEY,
        DEALT_KEY,
      ]),
      this.recentDays(now),
      this.ctx.storage.list({ prefix: 'mod:' }),
      fetchBans(config.rconUrl, config.rconPassword, http).catch((error: unknown) => {
        console.error(`Staff page: the ban list could not be read: ${errorText(error)}`);
        return null;
      }),
      fetchConfig(config.rconUrl, config.rconPassword, http).catch((error: unknown) => {
        console.error(`Staff page: ServerSettings.ini could not be read: ${errorText(error)}`);
        return null;
      }),
    ]);
    const reserved = ((): ReservedListing | null => {
      if (serverConfig === null) return null;
      try {
        return reservedListing(serverConfig.text);
      } catch (error) {
        console.error(`Staff page: the whitelist could not be read: ${errorText(error)}`);
        return null;
      }
    })();
    const vip = parseVipState(stored.get('vip'));
    const grief = griefKeys.map((key) => parseGriefDay(stored.get(key)));
    const modLogs = new Map([...logs].map(([key, value]) => [key.slice('mod:'.length), parseModLog(value)]));
    const banBook = parseBanBook(stored.get('bans'));
    const online = this.onlineNow(now, stored.get('online'));
    const joins = parseJoinLog(stored.get(JOIN_LOG_KEY))?.events ?? [];
    const playerDays = recent.slice(-days).map((d) => d.players);
    const steam = await this.steamSources(playerDays, online, now, days);
    const staffProfiles = parseStaffProfiles(stored.get(STAFF_PROFILES_KEY));
    const steamIds = [
      ...adminSteamIds(grief, modLogs, serverBans, banBook, reserved?.ids ?? []),
      ...staffSteamIds(staffProfiles),
      ...(online?.players.map((p) => p.steamId) ?? []),
      ...joins.map((e) => e.steamId),
      ...(steam === null ? [] : riskySteamIds(steamPlayers(playerDays, steam.inGame), steam.checks, now, steam.inGame).slice(0, STEAM_ACCOUNTS_LISTED)),
    ];
    const names = new Map<string, string>();
    for (const [steamId, log] of modLogs) {
      const logged = log.findLast((e) => e.name !== undefined && e.name !== steamId)?.name;
      if (logged !== undefined) names.set(steamId, logged);
    }
    for (const [steamId, ban] of Object.entries(banBook)) names.set(steamId, ban.name);
    for (const [steamId, grant] of Object.entries(vip.granted)) names.set(steamId, grant.name);
    for (const day of grief) for (const [steamId, t] of Object.entries(day.players)) if (t.name !== '') names.set(steamId, t.name);
    for (const day of recent) for (const [steamId, t] of Object.entries(day.players)) names.set(steamId, t.name);
    for (const p of online?.players ?? []) names.set(p.steamId, p.name);
    const ids = await this.idsFor(steamIds);
    const since = stored.get('killFeedSince');
    const staffNames = parseStaffNames(stored.get(STAFF_NAMES_KEY));
    const overview = buildAdminOverview({
      now,
      days,
      feedSince: typeof since === 'string' ? since : null,
      grief,
      playerDays,
      modLogs,
      serverBans,
      banBook,
      nameOf: (steamId) => names.get(steamId),
      idOf: (steamId) => ids.get(steamId),
      staffNames,
      staffProfiles,
      reserved,
      vip,
      steam,
      server: parseStats(stored.get('stats')).server,
      online,
      match: parseState(stored.get('state'))?.match?.players ?? {},
      history: recent,
      headshots: this.headshotsToday(now, online?.players.map((p) => p.steamId) ?? []),
      joins,
      checked: checkedToday(stored.get(CHECKED_KEY), now),
      dealt: dealtLately(stored.get(DEALT_KEY), now),
    });
    const staffIds = adminStaffIds(overview);
    const found = await this.lookUpStaff(staffIds, staffNames, now);
    return found === null ? overview : { ...overview, staff: staffFor(staffIds, found, modLogs) };
  }

  // With DISCORD_BOT_TOKEN, asks Discord who the staff are that the bot has not seen sign in or use a staff command, a
  // few at a time, and remembers them. Null when there was nobody to ask about, or no token.
  private async lookUpStaff(ids: string[], known: StaffNames, now: number): Promise<StaffNames | null> {
    const token = stringVars(this.env)['DISCORD_BOT_TOKEN']?.trim();
    if (!token) return null;
    const failures = parseLookupFailures(await this.ctx.storage.get(LOOKUP_FAILURES_KEY));
    const due = lookupsDue(known, ids, now, failures);
    if (due.length === 0) return null;
    const learned: [string, { name: string; username: string }][] = [];
    const failed: string[] = [];
    for (const id of due) {
      try {
        const user = await fetchDiscordUser(token, id);
        if (user === null) failed.push(id);
        else learned.push([id, user]);
      } catch (error) {
        // A refused token or a rate limit: the rest wait for a later load.
        failed.push(id);
        console.error(`Staff names: ${errorText(error)}`);
        break;
      }
    }
    // Read again, so a name noted while Discord was being asked is not lost.
    const latest = parseStaffNames(await this.ctx.storage.get(STAFF_NAMES_KEY));
    const merged = { ...latest, ...Object.fromEntries(learned.map(([id, user]) => [id, { ...user, at: now }])) };
    await this.ctx.storage.put({
      ...(learned.length === 0 ? {} : { [STAFF_NAMES_KEY]: merged }),
      [LOOKUP_FAILURES_KEY]: withFailures(failures, failed, now),
    });
    if (learned.length > 0) console.info(`Staff names: looked up ${learned.length} on Discord`);
    return learned.length === 0 ? null : merged;
  }

  // Links the signed-in staff member's Steam account, or unlinks theirs or another staff member's (see staffprofiles.ts).
  // `player` is the name that account last had in game, when the bot has seen it, so the page can say whose it is.
  async staffProfile(
    action: ProfileAction,
    user: { id: string; name: string },
  ): Promise<{ steamId: string | null; player: string | null } | { problem: string }> {
    // One at a time with the VIP updates: one that read the staff before this change and is still writing the whitelist
    // would otherwise save VIP for an account linked meanwhile. Waiting for it makes it come before the link.
    const changed = await this.serial(async (): Promise<{ steamId: string | null } | { problem: string }> => {
      const storage = this.ctx.storage;
      const profiles = parseStaffProfiles(await storage.get(STAFF_PROFILES_KEY));
      if (action.action === 'unlink') {
        const target = action.userId ?? user.id;
        const was = profiles[target];
        if (was === undefined) return { steamId: null };
        await storage.put(STAFF_PROFILES_KEY, unlinkSteam(profiles, target));
        console.info(`Staff page: ${JSON.stringify(user.name)} unlinked Steam account ${was.steamId} from Discord user ${target}`);
        return { steamId: null };
      }
      const linked = linkSteam(profiles, user, action.steamId, Date.now());
      if ('problem' in linked) return linked;
      // A player who proved the Steam account is theirs (see accounts.ts) has it; staff only typed it in.
      const player = parseSteamLink(await storage.get(steamLinkKey(linked.steamId)));
      if (player !== null && player.u !== user.id) {
        return { problem: 'That Steam account is linked to a player, who proved it with their Discord profile or Steam. Check the ID.' };
      }
      await storage.put(STAFF_PROFILES_KEY, linked.profiles);
      console.info(`Staff page: ${JSON.stringify(user.name)} (Discord user ${user.id}) linked Steam account ${linked.steamId}`);
      return { steamId: linked.steamId };
    });
    if ('problem' in changed) return changed;
    const { steamId } = changed;
    if (steamId === null) return { steamId, player: null };
    const seen = (await this.recentDays(Date.now())).findLast((d) => d.players[steamId] !== undefined);
    return { steamId, player: seen?.players[steamId]?.name ?? null };
  }

  // ---- Player accounts (see accounts.ts and accountbook.ts) ----

  // Account changes and the passes that give roles and send messages run one at a time.
  private accounting = oneAtATime();
  private accountsSyncedAt = 0;
  // Steam accounts of players in the server who linked, for the welcome message: read now and then, not at every welcome.
  private linkedCache: { at: number; links: { members: Set<string>; all: Set<string> } } | null = null;

  private bookStorage(): BookStorage {
    const storage = this.ctx.storage;
    return {
      get: (keys) => storage.get(keys),
      put: (entries) => storage.put(entries),
      delete: (keys) => storage.delete(keys),
      list: (options) => storage.list(options),
    };
  }

  // What the bot may do for accounts. Without DISCORD_BOT_TOKEN and DISCORD_GUILD_ID it can sign players in and link them,
  // but it gives no roles, sends no messages and checks nobody's membership.
  private accountDeps(config: Config): BookDeps {
    const guildId = stringVars(this.env)['DISCORD_GUILD_ID']?.trim() ?? '';
    const { botToken, linkedRoleId, vipRoleId } = config.accounts;
    const acting = botToken !== undefined && /^\d+$/.test(guildId);
    return {
      storage: this.bookStorage(),
      now: Date.now(),
      rule: {
        roles: { ...(linkedRoleId === undefined ? {} : { linked: linkedRoleId }), ...(vipRoleId === undefined ? {} : { vip: vipRoleId }) },
        messages: acting,
        siteUrl: config.siteUrl,
        vip: config.vip,
      },
      discord: acting
        ? {
            isMember: (userId) => botIsMember(botToken, guildId, userId),
            setRole: (userId, roleId, on) => setRole(botToken, guildId, userId, roleId, on),
            direct: (userId, text) => sendDirectMessage(botToken, userId, text),
          }
        : null,
      log: { info: (message) => console.info(message), error: (message) => console.error(message) },
    };
  }

  // The public id of a player's page, when they have been seen lately and can be found there.
  private async playerPageId(steamId: string): Promise<string | null> {
    if (!(await this.recentDays(Date.now())).some((d) => d.players[steamId] !== undefined)) return null;
    return (await this.idsFor([steamId])).get(steamId) ?? null;
  }

  private async lastNameOf(steamId: string): Promise<string | null> {
    return (await this.recentDays(Date.now())).findLast((d) => d.players[steamId] !== undefined)?.players[steamId]?.name ?? null;
  }

  // One pass of roles and messages. After a sign-in or a change it runs at once; the checks run it every few minutes.
  private async syncAccountsNow(config: Config, force: boolean): Promise<void> {
    await syncAccounts(this.accountDeps(config), parseVipState(await this.ctx.storage.get('vip')), force);
  }

  private async keepAccounts(config: Config): Promise<void> {
    const now = Date.now();
    if (now - this.accountsSyncedAt < ACCOUNTS_EVERY_MS) return;
    this.accountsSyncedAt = now;
    try {
      await this.accounting(() => this.syncAccountsNow(config, false));
    } catch (error) {
      console.error(`Player accounts: the pass failed: ${errorText(error)}`);
    }
  }

  private syncSoon(config: Config): void {
    this.linkedCache = null;
    this.ctx.waitUntil(
      this.accounting(() => this.syncAccountsNow(config, true)).catch((error: unknown) => console.error(`Player accounts: the pass failed: ${errorText(error)}`)),
    );
  }

  // With ASK_BACK on, asks linked players who have been away back, by Discord message, the first time each day the server
  // seeds outside the quiet hours (see returnDue). The day is saved before any goes out, so a batch that fails part-way is not sent twice.
  private async askBack(config: Config, snapshot: Snapshot | null): Promise<void> {
    const { botToken } = config.accounts;
    const guildId = stringVars(this.env)['DISCORD_GUILD_ID']?.trim() ?? '';
    if (!config.askBack || botToken === undefined || !/^\d+$/.test(guildId) || snapshot === null) return;
    const now = Date.now();
    const players = snapshot.status.players;
    if (players < config.rules.seeding || players >= config.rules.live || isQuiet(now, config.quietHours)) return;
    const storage = this.ctx.storage;
    const today = dayOf(now);
    try {
      // The phase this check saw, as the website has it: a server below the live mark can still be live (in its grace
      // time after a drop, or above the low-pop mark).
      const got = await storage.get([RETURN_DAY_KEY, 'stats']);
      if (got.get(RETURN_DAY_KEY) === today || parseStats(got.get('stats')).server?.phase !== 'seeding') return;
      await storage.put(RETURN_DAY_KEY, today);
      await this.accounting(async () => {
        const [days, all] = await Promise.all([this.recentDays(now), storage.list({ prefix: ACCOUNT_PREFIX, limit: 20_000 })]);
        const lastSeen = new Map<string, string>();
        for (const d of days) for (const steamId of Object.keys(d.players)) lastSeen.set(steamId, d.day);
        const due = [...all]
          .flatMap(([key, raw]) => {
            const account = parseAccount(raw);
            const seen = account?.steamId == null ? null : (lastSeen.get(account.steamId) ?? null);
            return account !== null && seen !== null && returnDue(account, seen, now)
              ? [{ userId: key.slice(ACCOUNT_PREFIX.length), account, seen }]
              : [];
          })
          .sort((a, b) => b.seen.localeCompare(a.seen))
          .slice(0, RETURN_PER_DAY);
        const rule = { siteUrl: config.siteUrl, vip: config.vip, serverId: config.serverId };
        for (const { userId, account } of due) {
          let next: Account = { ...account, returnedAt: now };
          try {
            const result = await sendDirectMessage(botToken, userId, returnText(account.name, players, rule));
            if (result === 'closed') next = { ...next, dmClosed: true };
            console.info(`Player account: ${result === 'sent' ? 'asked' : 'could not message'} ${userId} back to seed`);
          } catch (error) {
            console.error(`Player account: asking ${userId} back failed: ${errorText(error)}`);
          }
          await storage.put(accountKey(userId), next);
        }
      });
    } catch (error) {
      console.error(`Asking players back failed: ${errorText(error)}`);
    }
  }

  // A player signed in with Discord on the website. `login.steamId` is the Steam account on their Discord profile.
  async accountSignIn(
    user: { id: string; name: string },
    login: { member: boolean; joined: boolean; steamId: string | null; roles: string[] | null },
  ): Promise<SignInResult> {
    const config = loadConfig(stringVars(this.env));
    const result = await this.accounting(async () =>
      recordSignIn(this.accountDeps(config), user, login, parseVipState(await this.ctx.storage.get('vip'))),
    );
    this.syncSoon(config);
    return result;
  }

  // What the account page shows. Null when they have no account.
  async accountView(userId: string): Promise<AccountView | null> {
    const config = loadConfig(stringVars(this.env));
    return this.accounting(async () => {
      const deps = this.accountDeps(config);
      return viewAccount(
        {
          ...deps,
          canJoin: deps.discord !== null,
          playerPage: (steamId) => this.playerPageId(steamId),
          ballotOf: async (id) => {
            const vote = parseMapVote(await this.ctx.storage.get(MAP_VOTE_KEY));
            const ballot = vote === null || !isOpenVote(vote, Date.now()) ? undefined : vote.ballots.find((b) => b.user === id);
            return vote === null || ballot === undefined ? null : { poll: vote.id, map: ballot.map, light: ballot.light, weather: ballot.weather };
          },
        },
        userId,
        parseVipState(await this.ctx.storage.get('vip')),
      );
    });
  }

  // Links the Steam account Steam's sign-in vouched for (`steamId`, from a proof the Worker checked) to the signed-in player.
  async accountLinkSteam(userId: string, steamId: string): Promise<{ steamId: string } | { problem: string }> {
    const config = loadConfig(stringVars(this.env));
    const result = await this.accounting(async () =>
      linkWithProof(this.accountDeps(config), userId, steamId, parseVipState(await this.ctx.storage.get('vip'))),
    );
    if ('problem' in result) {
      return {
        problem:
          result.problem === 'steam-taken'
            ? 'That Steam account was linked by a staff member. Ask staff in the Discord to sort it out.'
            : result.problem === 'no-account'
              ? 'Sign in again.'
              : 'That is not a Steam account.',
      };
    }
    this.syncSoon(config);
    return result;
  }

  async accountAct(userId: string, action: Exclude<AccountAction, { action: 'steam' }>): Promise<ActionResult> {
    const config = loadConfig(stringVars(this.env));
    const result = await this.accounting(async () => {
      const deps = this.accountDeps(config);
      switch (action.action) {
        case 'unlink':
          return unlink(deps, userId);
        case 'alerts':
          return setAlerts(deps, userId, action.on);
        case 'private':
          return setPrivate(deps, userId, action.on, (steamId) => this.lastNameOf(steamId));
        case 'forget':
          return forget(deps, userId);
      }
    });
    if (action.action === 'unlink') this.syncSoon(config);
    this.linkedCache = null;
    return result;
  }

  // Whether this player is in the server now, for voting on the website.
  async accountIsMember(userId: string): Promise<boolean> {
    const config = loadConfig(stringVars(this.env));
    return this.accounting(() => isMemberNow(this.accountDeps(config), userId));
  }

  // A vote cast on the website by a signed-in member: counted as the button in Discord is, and the Discord message updated.
  async castWebVote(
    userId: string,
    vote: WebVote,
  ): Promise<{ ok: boolean; reply: string; mine: { map: string | null; light: string | null; weather: string | null }; vote: PublicVote | null }> {
    const result = await this.castMapVote({
      poll: vote.poll,
      userId,
      via: 'website',
      ...(vote.map === undefined ? {} : { map: vote.map }),
      ...(vote.light === undefined ? {} : { light: vote.light }),
      ...(vote.weather === undefined ? {} : { weather: vote.weather }),
    });
    const config = loadConfig(stringVars(this.env));
    const saved = parseMapVote(await this.ctx.storage.get(MAP_VOTE_KEY));
    if (result.update !== null && saved !== null && config.mapVote !== null) await this.showVote(config, config.mapVote, saved);
    const ballot = saved?.ballots.find((b) => b.user === userId);
    return {
      ok: result.update !== null,
      reply: result.reply.replace(/\*\*/g, ''),
      mine: { map: ballot?.map ?? null, light: ballot?.light ?? null, weather: ballot?.weather ?? null },
      vote: saved === null ? null : publicVote(saved, Date.now()),
    };
  }

  // Each player's best place on the website's leaderboard ("3rd for kills"), for the welcome back. Not private profiles,
  // which the leaderboard doesn't name.
  private async leaderboardRanks(): Promise<Map<string, string>> {
    const [days, hidden] = await Promise.all([this.recentDays(Date.now()), this.privateSteam()]);
    const places = leaderboardPlaces(leaderboard(days.slice(-LEADERBOARD_DAYS).map((d) => d.players), LEADERBOARD_DAYS, LEADERBOARD_SIZE));
    for (const steamId of hidden) places.delete(steamId);
    return places;
  }

  // ---- Milestones, personal bests and the leaderboard at the end of a match (see achievements.ts) ----

  // Adds the days that closed since the last fold to everyone's lifetime totals. The first fold adds every day the bot has,
  // and counts what players did earlier today as told too, leaving out `ending` (the match ending now, when it is
  // recorded today already).
  private async foldLifetime(now: number, ending: MatchRecord | null): Promise<void> {
    const storage = this.ctx.storage;
    const today = dayOf(now);
    const through = await storage.get(LIFETIME_THROUGH_KEY);
    if (through === today) return;
    const first = typeof through !== 'string';
    const listed = await storage.list({ prefix: 'players:', ...(first ? {} : { start: `players:${String(through)}` }), end: `players:${today}` });
    const keys = Array.from({ length: LIFETIME_SHARDS }, (_, i) => lifetimeKey(i));
    const stored = await storage.get([...keys, playerDayKey(now)]);
    const todaySoFar = parsePlayerDay(stored.get(playerDayKey(now)));
    const shards = foldDays(
      keys.map((key) => parseShard(stored.get(key))),
      [...listed.values()].map(parsePlayerDay),
      first,
      [ending !== null && dayOf(ending.endedAt) === today ? unrecordMatchPlayers(todaySoFar, ending.players) : todaySoFar],
    );
    await storage.put({ ...Object.fromEntries(keys.map((key, i) => [key, shards[i] ?? {}])), [LIFETIME_THROUGH_KEY]: today });
    console.info(`Lifetime totals: added ${listed.size} day${listed.size === 1 ? '' : 's'}`);
  }

  // What the records say about the players of a match ending: the milestone each has passed and not been told of, their
  // best match lately, and how close they are to the leaderboard's top 10 for kills. The match itself counts, once, whether
  // or not it has been recorded yet.
  private async endExtras(match: MatchState): Promise<EndExtras> {
    const now = Date.now();
    const recordKey = matchRecordKey(match.startedAt);
    await this.foldLifetime(now, parseMatchRecord(await this.ctx.storage.get(recordKey)));
    const ids = Object.keys(match.players);
    const [stored, days, records] = await Promise.all([
      this.ctx.storage.get([...new Set(ids.map((id) => lifetimeKey(shardOf(id)))), recordKey]),
      this.recentDays(now),
      this.matchRecords(now),
    ]);
    const recorded = stored.has(recordKey);
    const thisMatch = recorded ? [] : [recordMatchPlayers({}, match)];
    const today = days.at(-1)?.players ?? {};
    const shards = new Map<number, LifetimeShard>();
    const shard = (steamId: string): LifetimeShard => {
      const index = shardOf(steamId);
      const known = shards.get(index) ?? parseShard(stored.get(lifetimeKey(index)));
      shards.set(index, known);
      return known;
    };
    const milestones = new Map<string, Milestone>();
    for (const [steamId, p] of Object.entries(match.players)) {
      const entry = shard(steamId)[steamId];
      const day = today[steamId];
      const due = dueMilestone(
        {
          matches: (entry?.matches ?? 0) + (day?.matches ?? 0) + (recorded ? 0 : 1),
          kills: (entry?.kills ?? 0) + (day?.kills ?? 0) + (recorded ? 0 : p.kills),
          minutes: (entry?.minutes ?? 0) + (day?.seedingMinutes ?? 0) + (day?.liveMinutes ?? 0),
        },
        entry?.told ?? {},
      );
      if (due !== null) milestones.set(steamId, due);
    }
    return {
      bests: personalBests(records, match.startedAt),
      milestones,
      nearly: nearlyTopTen(totals([...days.slice(-LEADERBOARD_DAYS).map((d) => d.players), ...thisMatch])),
    };
  }

  private async milestonesTold(told: ReadonlyMap<string, Milestone>): Promise<void> {
    const storage = this.ctx.storage;
    const indexes = [...new Set([...told.keys()].map(shardOf))];
    const stored = await storage.get(indexes.map(lifetimeKey));
    const shards = markTold(new Map(indexes.map((i) => [i, parseShard(stored.get(lifetimeKey(i)))])), told);
    await storage.put(Object.fromEntries([...shards].map(([i, s]) => [lifetimeKey(i), s])));
  }

  // Linked Steam accounts, and those of players in the server, read now and then, not at every welcome.
  private async steamLinked(): Promise<{ members: Set<string>; all: Set<string> }> {
    const now = Date.now();
    if (this.linkedCache !== null && now - this.linkedCache.at < ACCOUNTS_EVERY_MS) return this.linkedCache.links;
    const links = await steamLinks(this.bookStorage());
    this.linkedCache = { at: now, links };
    return links;
  }

  // Players in the server who linked their Steam account: their welcome in game leaves the invite out.
  private async linkedSteam(): Promise<Set<string>> {
    return (await this.steamLinked()).members;
  }

  // Regulars who have not linked their account and were not asked to in the last week: their welcome asks them to. None
  // while players cannot sign in on the website.
  private async linkNudges(): Promise<Set<string>> {
    if ('missing' in adminAuthConfig(stringVars(this.env))) return new Set();
    const now = Date.now();
    const [days, links, staff, asked] = await Promise.all([
      this.recentDays(now),
      this.steamLinked(),
      this.staffSteam(),
      this.ctx.storage.get(LINK_NUDGES_KEY),
    ]);
    const matches = new Map(totals(days.slice(-LEADERBOARD_DAYS).map((d) => d.players)).map((p) => [p.steamId, p.matches]));
    return nudgesDue(matches, links.all, staff, parseNudges(asked), now);
  }

  private async linkNudged(steamIds: string[]): Promise<void> {
    const storage = this.ctx.storage;
    await storage.put(LINK_NUDGES_KEY, withNudged(parseNudges(await storage.get(LINK_NUDGES_KEY)), steamIds, Date.now()));
  }

  // A click on the Discord invite (see discordclicks.ts).
  async discordClick(src: string): Promise<void> {
    await this.ctx.storage.put(DISCORD_CLICKS_KEY, withClick(parseClicks(await this.ctx.storage.get(DISCORD_CLICKS_KEY)), sourceOf(src), dayOf(Date.now())));
  }

  // The SQLite database's long-term tables (see lifetime.ts), made the first time.
  private lifetimeSql(): Sql {
    const sql = this.ctx.storage.sql;
    if (!this.lifetimeTables) {
      createLifetime(sql);
      this.lifetimeTables = true;
    }
    return sql;
  }

  // Sums up each UTC day that is over, once, for good (see lifetime.ts): the first check after midnight does yesterday, and
  // the first time ever it does every day the player records go back to. The days not done yet are read from the player
  // records, the match records and the stays in one go. A failure is only logged, and tried again at the next check.
  private async rollupLifetime(now: number): Promise<void> {
    const yesterday = dayOf(now - DAY_MS);
    if (this.lifetimeRolledOn === yesterday) return;
    if (this.lifetimeTriedAt !== null && now - this.lifetimeTriedAt < LIFETIME_RETRY_MS) return;
    this.lifetimeTriedAt = now;
    try {
      const kv = this.ctx.storage.kv;
      const through = kv.get<string>(LIFETIME_ROLLED_KEY);
      if (through === yesterday) {
        this.lifetimeRolledOn = yesterday;
        return;
      }
      // A match running across midnight has not ended, so the day's last match and the leaves in it can't be placed yet:
      // wait for it, for up to LIFETIME_WAIT_MS, trying again at the next check.
      const live = await this.ctx.storage.get(['online', 'state', JOIN_LOG_KEY]);
      const current = parseState(live.get('state'))?.match ?? null;
      const dayEnd = Date.parse(`${yesterday}T00:00:00Z`) + DAY_MS;
      const running = current !== null && current.endedAt === undefined && current.startedAt < dayEnd ? current : null;
      if (running !== null && now - dayEnd < LIFETIME_WAIT_MS) {
        this.lifetimeTriedAt = null;
        return;
      }
      const [kept, records, stored] = await Promise.all([this.recentDays(now), this.matchRecords(now), this.ctx.storage.list({ prefix: 'mod:' })]);
      const bans = parseBanBook(await this.ctx.storage.get('bans'));
      const clicks = parseClicks(await this.ctx.storage.get(DISCORD_CLICKS_KEY));
      // The first time, from the first day anyone played; after that, every day since the last, even empty ones.
      const firstWithPlayers = kept.find((d) => Object.keys(d.players).length > 0)?.day;
      if (through === undefined && firstWithPlayers === undefined) return;
      const todo = kept.filter((d) => d.day <= yesterday && (through === undefined ? d.day >= (firstWithPlayers ?? yesterday) : d.day > through));
      if (todo.length === 0) {
        kv.put(LIFETIME_ROLLED_KEY, yesterday);
        this.lifetimeRolledOn = yesterday;
        return;
      }
      const sql = this.lifetimeSql();
      const from = Date.parse(`${todo[0]?.day ?? yesterday}T00:00:00Z`) - DAY_MS;
      const sessions = sessionRows(this.sessionSql(), from);
      const staysFrom = firstStayDay(this.sessionSql());
      const matches = records.map((r) => ({ map: r.map, startedAt: r.startedAt, liveAt: r.liveAt, endedAt: r.endedAt, scores: r.factionScores.map((f) => f.score) }));
      const removed: Removal[] = [
        ...[...stored].flatMap(([key, value]) => parseModLog(value).flatMap((e) => (e.action === 'kick' || e.action === 'ban' ? [{ steamId: key.slice('mod:'.length), at: e.at }] : []))),
        ...Object.entries(bans).map(([steamId, ban]): Removal => ({ steamId, at: ban.at, until: ban.until })),
      ];
      // Players still in game are stays that are not over: they were there for the matches they were in.
      const online = this.onlineNow(now, live.get('online'));
      const inGame = online === null ? {} : (parseJoinLog(live.get(JOIN_LOG_KEY))?.inGame ?? {});
      const ongoing = Object.entries(inGame).map(([steamId, entry]) => ({ steamId, since: entry.since }));
      const liveMatch = running === null || records.some((r) => r.startedAt === running.startedAt) ? null : { startedAt: running.startedAt, liveAt: running.liveAt };
      const snapshot = await this.accountCounts();
      this.ctx.storage.transactionSync(() => {
        for (const d of todo) writePlayerDays(sql, d.day, dayPlayers(d.players));
        rebuildPlayers(sql);
        // Who is new, now the players are known, for new players' short stays.
        const newOn = newPlayerDays(sql);
        for (const d of todo) {
          const start = Date.parse(`${d.day}T00:00:00Z`);
          const end = start + DAY_MS;
          const retention =
            staysFrom !== null && d.day >= staysFrom
              ? buildRetention({ now: end - 1, days: 1, until: end, sessions, matches, ongoing, live: liveMatch, removed, newOn, clampHeat: false })
              : null;
          const input: DayInput = {
            day: d.day,
            stays:
              retention === null
                ? null
                : {
                    sessions: retention.sessions,
                    averageMinutes: retention.averageMinutes,
                    medianMinutes: retention.medianMinutes,
                    bounce: retention.bounce,
                    leaves: { timing: retention.leaves.timing, finale: retention.leaves.finale },
                    excluded: retention.excluded,
                    detail: retention.detail,
                    heat: retention.heat,
                  },
            matches: records.filter((r) => r.endedAt >= start && r.endedAt < end).map((r) => ({ startedAt: r.startedAt, map: r.map, liveAt: r.liveAt, endedAt: r.endedAt, peakPlayers: r.peakPlayers, scores: r.factionScores.map((f) => f.score) })),
            discord: {
              clicks: Object.values(clicks[d.day] ?? {}).reduce((a, b) => a + b, 0) || (d.day in clicks ? 0 : null),
              // The counts are as of now, so only the latest day gets them.
              accounts: d.day === yesterday ? snapshot.accounts : null,
              linked: d.day === yesterday ? snapshot.linked : null,
            },
          };
          writeDay(sql, input);
        }
        kv.put(LIFETIME_ROLLED_KEY, yesterday);
      });
      this.lifetimeRolledOn = yesterday;
      console.info(`Long-term records: ${todo.length} day${todo.length === 1 ? '' : 's'} added, up to ${yesterday}`);
    } catch (error) {
      console.error(`Long-term records failed: ${errorText(error)}`);
    }
  }

  // How many players have accounts and linked Steam, for the day's row.
  private async accountCounts(): Promise<{ accounts: number | null; linked: number | null }> {
    try {
      const counts = await growth(this.bookStorage());
      return { accounts: counts.accounts, linked: counts.linked };
    } catch {
      return { accounts: null, linked: null };
    }
  }

  // The Lifetime view: everything kept for good, up to yesterday.
  adminLifetime(): Lifetime {
    return readLifetime(this.lifetimeSql(), dayOf(Date.now()));
  }

  // What the public website shows of the long-term records (see readPublicLifetime).
  publicLifetime(): PublicLifetime {
    return readPublicLifetime(this.lifetimeSql(), dayOf(Date.now()));
  }

  // One of the long-term tables as CSV, for analysis.
  adminLifetimeCsv(table: TableName): string {
    return toCsv(exportTable(this.lifetimeSql(), dayOf(Date.now()), table));
  }

  // The Play time tab: how long players stay each day and when in a match they leave, over the last `days` UTC days.
  async adminRetention(days: number): Promise<Omit<Retention, 'detail'> & { newPlayers: { lookbackDays: number; cohorts: Cohort[] } }> {
    const now = Date.now();
    const first = Date.parse(dayOf(now - (days - 1) * DAY_MS));
    const [records, stored, kept, logs] = await Promise.all([
      this.matchRecords(now),
      this.ctx.storage.get(['online', 'state', 'bans', JOIN_LOG_KEY]),
      this.recentDays(now),
      this.ctx.storage.list({ prefix: 'mod:' }),
    ]);
    const matches = records.map((r) => ({
      map: r.map,
      startedAt: r.startedAt,
      liveAt: r.liveAt,
      endedAt: r.endedAt,
      scores: r.factionScores.map((f) => f.score),
    }));
    // Sessions from when the earliest match in the period went live, for those who left early from one that began before it.
    const from = Math.min(first, ...matches.filter((m) => m.endedAt >= first).map((m) => m.startedAt));
    const online = this.onlineNow(now, stored.get('online'));
    const inGame = online === null ? {} : (parseJoinLog(stored.get(JOIN_LOG_KEY))?.inGame ?? {});
    const current = parseState(stored.get('state'))?.match ?? null;
    // Kicks and bans: the player did not choose to leave. Events up to REMOVAL_AFTER_MS before the period can still end a
    // stay in it. A ban on the book holds until it ends, as one made while the player was away goes on when they next join.
    const removed: Removal[] = [
      ...[...logs].flatMap(([key, value]) =>
        parseModLog(value).flatMap((e) => (e.at >= from - REMOVAL_AFTER_MS && (e.action === 'kick' || e.action === 'ban') ? [{ steamId: key.slice('mod:'.length), at: e.at }] : [])),
      ),
      ...Object.entries(parseBanBook(stored.get('bans'))).map(([steamId, ban]): Removal => ({ steamId, at: ban.at, until: ban.until })),
    ];
    const newPlayers = buildNewPlayers(kept, dayOf(now));
    const retention = buildRetention({
      now,
      days,
      sessions: sessionRows(this.sessionSql(), from),
      matches,
      ongoing: Object.entries(inGame).map(([steamId, entry]) => ({ steamId, since: entry.since })),
      live: current !== null && current.endedAt === undefined && !matches.some((m) => m.startedAt === current.startedAt) ? { startedAt: current.startedAt, liveAt: current.liveAt } : null,
      removed,
      newOn: newPlayers.firstSeen,
    });
    const { detail: _detail, ...shown } = retention;
    return { ...shown, newPlayers: { lookbackDays: newPlayers.lookbackDays, cohorts: newPlayers.cohorts } };
  }

  // For the staff page: clicks on the invite by place, and how many players have accounts.
  async discordGrowth(): Promise<{ clicks: ClickSummary; accounts: Growth; members: number | null; funnel: Funnel }> {
    const [stored, kept, linked] = await Promise.all([
      this.ctx.storage.get([DISCORD_CLICKS_KEY, 'stats']),
      this.recentDays(Date.now()),
      linkedSteamIds(this.bookStorage()),
    ]);
    return {
      clicks: summariseClicks(parseClicks(stored.get(DISCORD_CLICKS_KEY)), dayOf(Date.now()), 30),
      accounts: await growth(this.bookStorage()),
      members: parseStats(stored.get('stats')).discord?.members ?? null,
      funnel: buildFunnel(linked, kept),
    };
  }

  // "Checked, they're fine" on a player, or taking it back, for the rest of the UTC day (see checked.ts). The check as it
  // is now, or null after taking it back.
  async checkPlayer(action: CheckAction, user: { id: string; name: string }): Promise<{ checked: Check | null }> {
    const now = Date.now();
    const next = applyCheck(await this.ctx.storage.get(CHECKED_KEY), action, user, now);
    await this.ctx.storage.put(CHECKED_KEY, next);
    return { checked: next.players[action.steamId] ?? null };
  }

  // "Dealt with" on a player on the Queue, or undoing it, for the next 30 days (see dealt.ts). What is kept now, or null
  // after undoing it.
  async dealWith(action: DealtAction, user: { id: string; name: string }): Promise<{ dealt: Dealt | null }> {
    const next = applyDealt(await this.ctx.storage.get(DEALT_KEY), action, user, Date.now());
    await this.ctx.storage.put(DEALT_KEY, next);
    return { dealt: next[action.steamId] ?? null };
  }

  // A staff member's name, as seen when they sign in to the staff page or use a staff command. Only written when it
  // changed, or has not been seen for a while.
  async noteStaff(id: string, name: string, username: string | null): Promise<void> {
    const next = noteStaffName(parseStaffNames(await this.ctx.storage.get(STAFF_NAMES_KEY)), id, name, username, Date.now());
    if (next !== null) await this.ctx.storage.put(STAFF_NAMES_KEY, next);
  }

  // Recent matches, newest first, to pick from in /removematch.
  async recentMatches(): Promise<RecentMatch[]> {
    return parseStats(await this.ctx.storage.get('stats')).matches;
  }

  // Deletes a match recorded by mistake: from the recent matches, its private record, and its players' totals for
  // the day it was credited to. Returns null if no recent match ended at that time.
  async removeMatch(endedAt: number): Promise<{ match: RecentMatch; players: number } | null> {
    const storage = this.ctx.storage;
    const { stats, removed } = removeRecentMatch(parseStats(await storage.get('stats')), endedAt);
    if (removed === null) return null;
    const records = await storage.list({ prefix: 'match:', reverse: true, limit: MATCH_RECORDS_SEARCHED });
    const found = [...records].find(([, value]) => parseMatchRecord(value)?.endedAt === endedAt);
    const record = found === undefined ? null : parseMatchRecord(found[1]);
    if (found === undefined || record === null) {
      await storage.put('stats', stats);
      return { match: removed, players: 0 };
    }
    const dayKey = playerDayKey(endedAt);
    const indexes = [...new Set(record.players.map((p) => shardOf(p.steamId)))];
    const got = await storage.get([dayKey, LIFETIME_THROUGH_KEY, ...indexes.map(lifetimeKey)]);
    const day = unrecordMatchPlayers(parsePlayerDay(got.get(dayKey)), record.players);
    // Its day is in the lifetime totals already: they lose it too.
    const through = got.get(LIFETIME_THROUGH_KEY);
    const unfolded =
      typeof through === 'string' && dayOf(endedAt) < through
        ? Object.fromEntries(
            [...unfoldMatch(new Map(indexes.map((i) => [i, parseShard(got.get(lifetimeKey(i)))])), record.players)].map(([i, s]) => [lifetimeKey(i), s]),
          )
        : {};
    // A match of a season that is over leaves its kept roundup, which is built again without it.
    const gone = endedAt < SEASON.endsAt ? [found[0], SEASON_KEY] : [found[0]];
    // Issued together with no await in between, so they are written at once: a failure cannot leave it half removed.
    await Promise.all([storage.put({ stats, [dayKey]: day, ...unfolded }), storage.delete(gone)]);
    // The player pages read the records again, without it, and the next check keeps the season roundup again.
    this.dayCache.clear();
    this.matchCache.clear();
    this.seasonLooked = false;
    // The long-term records lose it too (a failure is only logged, as the match is removed already).
    try {
      removeArchivedMatch(this.lifetimeSql(), endedAt, record.players.map((p) => p.steamId));
    } catch (error) {
      console.error(`Long-term records could not drop the removed match: ${errorText(error)}`);
    }
    return { match: removed, players: record.players.length };
  }

  // What the bot knows about one player, for /player.
  async playerRecord(steamId: string): Promise<PlayerRecord> {
    const now = Date.now();
    const keys = recentDayKeys(now, PROFILE_DAYS);
    const key = modLogKey(steamId);
    const griefKey = griefDayKey(now);
    const stored = await this.ctx.storage.get([...keys, key, 'vip', 'bans', STAFF_PROFILES_KEY, PRIVATE_PROFILES_KEY, griefKey, 'killFeedSince']);
    const staff = staffSteamIds(parseStaffProfiles(stored.get(STAFF_PROFILES_KEY)));
    const found = totals(keys.map((k) => withoutStaffSeeding(parsePlayerDay(stored.get(k)), staff))).find((p) => p.steamId === steamId);
    const vip = parseVipState(stored.get('vip'));
    const log = parseModLog(stored.get(key));
    const ban = parseBanBook(stored.get('bans'))[steamId] ?? null;
    return {
      name: found?.name ?? vip.granted[steamId]?.name ?? ban?.name ?? log.findLast((e) => e.name !== undefined)?.name ?? null,
      totals: found === undefined ? null : withoutId(found),
      vip: vip.granted[steamId] ?? null,
      vipBlockedUntil: vip.revoked[steamId] ?? null,
      staffSpot: staff.has(steamId),
      privateProfile: parsePrivateProfiles(stored.get(PRIVATE_PROFILES_KEY))[steamId] !== undefined,
      log,
      ban,
      grief: typeof stored.get('killFeedSince') === 'string' ? playerGrief(parseGriefDay(stored.get(griefKey)), steamId) : null,
    };
  }

  // Players seen in the last 30 days, with VIP from the bot or banned by it, newest name first.
  async knownPlayers(): Promise<Named[]> {
    const keys = recentDayKeys(Date.now(), KNOWN_PLAYER_DAYS);
    const stored = await this.ctx.storage.get([...keys, 'vip', 'bans']);
    const seen = totals(keys.map((k) => parsePlayerDay(stored.get(k))));
    const vip = Object.entries(parseVipState(stored.get('vip')).granted);
    const bans = Object.entries(parseBanBook(stored.get('bans')));
    const all = [...seen, ...[...vip, ...bans].map(([steamId, { name }]) => ({ steamId, name }))];
    const ids = new Set<string>();
    return all.filter((p) => !ids.has(p.steamId) && ids.add(p.steamId)).map(({ steamId, name }) => ({ steamId, name }));
  }

  async logAction(steamId: string, entry: ModEntry): Promise<void> {
    await this.record(steamId, entry);
  }

  // Bans a player on the server, and remembers when a timed ban ends so the bot can lift it. A player who is already
  // banned is left as they are, so no ban is ever lifted to change it: staff /unban first. The game only bans players
  // who are in game, so for anyone else the ban waits, and the check that next sees them puts it on the server.
  async ban({ steamId, name, length, reason, by, byName }: BanRequest): Promise<BanResult> {
    const option = BAN_LENGTHS.find((l) => l.value === length);
    if (option === undefined) throw new Error(`Unknown ban length: ${length}`);
    const named = byName === undefined ? {} : { byName };
    return this.serial(async () => {
      const { config, http } = this.rcon();
      const at = Date.now();
      const until = option.ms === null ? null : at + option.ms;
      const current = (await fetchBans(config.rconUrl, config.rconPassword, http)).find((b) => b.steamId === steamId);
      const ours = parseBanBook(await this.ctx.storage.get('bans'))[steamId];
      if (current !== undefined) {
        const byBot = ours !== undefined && isBotBan(current.reason, ours);
        return { outcome: 'already-banned', until: byBot ? ours.until : null, byBot };
      }
      if (ours?.waiting && (ours.until === null || ours.until > at)) {
        return { outcome: 'already-banned', until: ours.until, byBot: true, waiting: true };
      }
      // Remembered before the server is asked, so a ban that goes through but times out still ends on time. If the
      // server refuses, it is forgotten again; the bot also forgets it at its end if the server never had it.
      const ban: BanRecord = { name, until, reason, serverReason: banReason(reason, until), by, at };
      await this.record(steamId, null, { ban });
      try {
        await addBan(config.rconUrl, config.rconPassword, steamId, ban.serverReason, http);
      } catch (error) {
        if (isNotInGame(error)) {
          const detail = `${option.name}, waits for them to join`;
          await this.record(steamId, { action: 'ban', at, by, ...named, name, reason, detail }, { ban: { ...ban, waiting: true } });
          return { outcome: 'banned', until, byBot: true, waiting: true };
        }
        if (error instanceof RconError) await this.record(steamId, null, { ban: null });
        throw error;
      }
      await this.record(
        steamId,
        { action: 'ban', at, by, ...named, name, reason, detail: option.name },
        { serverBan: { reason: ban.serverReason, bannedBy: null } },
      );
      return { outcome: 'banned', until, byBot: true };
    });
  }

  // False when they had no ban: none on the server, and none waiting for them to join. The bot forgets its own record
  // of the ban either way.
  async unban({ steamId, name }: Named, by: string, byName?: string): Promise<boolean> {
    return this.serial(async () => {
      const { config, http } = this.rcon();
      const waiting = parseBanBook(await this.ctx.storage.get('bans'))[steamId]?.waiting === true;
      const removed = (await removeBan(config.rconUrl, config.rconPassword, steamId, http)) || waiting;
      const entry: ModEntry = { action: 'unban', at: Date.now(), by, ...(byName === undefined ? {} : { byName }), name };
      await this.record(steamId, removed ? entry : null, { ban: null, serverBan: null });
      return removed;
    });
  }

  async vipAdd({ steamId, name, days, reason, by, byName }: Named & { days: number | null; reason: string; by: string; byName?: string }): Promise<VipAddResult> {
    return this.serial(async () => {
      const now = Date.now();
      const state = parseVipState(await this.ctx.storage.get('vip'));
      const change = await addVip({ steamId, name, days, now, state, rcon: this.settingsFile(this.rcon()) });
      if (change.outcome === 'already-reserved') {
        // Nothing given, but any block from /vip remove is lifted.
        await this.record(steamId, null, { vip: change.state });
        return { outcome: change.outcome };
      }
      const outcome = change.outcome === 'extended' ? 'extended' : 'added';
      const length = days === null ? 'permanent' : `${days} day${days === 1 ? '' : 's'}`;
      const entry: ModEntry = {
        action: 'vip-add',
        at: now,
        by,
        ...(byName === undefined ? {} : { byName }),
        name,
        reason,
        detail: outcome === 'extended' ? `${length} (already had VIP)` : length,
      };
      await this.record(steamId, entry, { vip: change.state });
      return { outcome, ...(change.until === undefined ? {} : { until: change.until }) };
    });
  }

  async vipRemove({ steamId, name, reason, by, byName }: Named & { reason?: string; by: string; byName?: string }): Promise<VipRemoveResult> {
    return this.serial(async () => {
      // A staff spot follows the staff member's linked Steam account: the next check would only put it back.
      if (await this.staffSteam().then((staff) => staff.has(steamId))) return { outcome: 'staff-spot' };
      const now = Date.now();
      const state = parseVipState(await this.ctx.storage.get('vip'));
      const change = await removeVip({ steamId, now, state, rcon: this.settingsFile(this.rcon()) });
      const outcome = change.outcome === 'removed' ? 'removed' : 'not-reserved';
      const entry: ModEntry = {
        action: 'vip-remove',
        at: now,
        by,
        ...(byName === undefined ? {} : { byName }),
        name,
        ...(reason === undefined ? {} : { reason }),
        // Still logged: automatic VIP skips them for 7 days either way.
        detail: outcome === 'removed' ? 'automatic VIP off for 7 days' : "wasn't on the whitelist; automatic VIP off for 7 days",
      };
      await this.record(steamId, entry, { vip: change.state });
      return { outcome };
    });
  }

  // Notes the map staff set to play next, and the map being played now: once the server leaves that, it has been played.
  // The map being played comes from the server when staff set it, or else from the last check.
  async stageNextMap(map: string, playing: string | null): Promise<void> {
    const match = playing ? null : (parseState(await this.ctx.storage.get('state'))?.match ?? null);
    const fromMap = playing || (match === null ? '' : matchMap(match));
    if (fromMap === '') return;
    const staged: StagedMap = { map, fromMap, at: Date.now() };
    await this.ctx.storage.put('nextMap', staged);
  }

  // The private profiles (see privacy.ts), for /private.
  async privateProfiles(): Promise<PrivateProfiles> {
    return parsePrivateProfiles(await this.ctx.storage.get(PRIVATE_PROFILES_KEY));
  }

  // Makes a player's profile private, or public again. False when it already was. The public pages show it once their
  // cache runs out, within a minute.
  async setProfilePrivate(player: Named, by: string, byName?: string): Promise<boolean> {
    const next = makePrivate(await this.privateProfiles(), player, by, byName, Date.now());
    if (next !== null) await this.ctx.storage.put(PRIVATE_PROFILES_KEY, next);
    return next !== null;
  }

  // The circles staff blocked (see circles.ts), and blocking or unblocking one. False when it already was (or was not).
  async blockedCircles(): Promise<BlockedCircles> {
    return parseBlockedCircles(await this.ctx.storage.get(BLOCKED_CIRCLES_KEY));
  }

  async setCircleBlocked(circle: { id: string; map: string; name: string }, by: string, byName?: string): Promise<boolean> {
    const next = blockCircle(await this.blockedCircles(), circle, by, byName, Date.now());
    if (next !== null) await this.ctx.storage.put(BLOCKED_CIRCLES_KEY, next);
    return next !== null;
  }

  async setCircleUnblocked(id: string): Promise<boolean> {
    const next = unblockCircle(await this.blockedCircles(), id);
    if (next !== null) await this.ctx.storage.put(BLOCKED_CIRCLES_KEY, next);
    return next !== null;
  }

  // What staff switched off for map votes (see voteoptions.ts), and switching rain or a map off or on. False when it already was.
  // A map's reply also says how many maps a vote can offer now (null when the server's maps could not be read).
  async voteOptions(): Promise<VoteOptions> {
    return parseVoteOptions(await this.ctx.storage.get(VOTE_OPTIONS_KEY));
  }

  async setVoteRain(on: boolean, by: string, byName?: string): Promise<boolean> {
    const next = withRain(await this.voteOptions(), on, by, byName, Date.now());
    if (next !== null) await this.ctx.storage.put(VOTE_OPTIONS_KEY, next);
    return next !== null;
  }

  async setVoteMap(map: string, on: boolean, by: string, byName?: string): Promise<{ changed: boolean; votable: number | null }> {
    const current = await this.voteOptions();
    const next = withMap(current, map, on, by, byName, Date.now());
    if (next !== null) await this.ctx.storage.put(VOTE_OPTIONS_KEY, next);
    const catalog = await this.catalog(loadConfig(stringVars(this.env))).catch(() => null);
    const off = offMapIds(next ?? current);
    return { changed: next !== null, votable: catalog === null ? null : catalog.maps.filter((m) => canBeVoted(m) && !off.includes(m.id)).length };
  }

  async setProfilePublic(steamId: string): Promise<boolean> {
    const next = makePublic(await this.privateProfiles(), steamId);
    if (next !== null) await this.ctx.storage.put(PRIVATE_PROFILES_KEY, next);
    return next !== null;
  }

  // Posts a /seednow call. Its time is saved first, so the automatic seeding alert holds back even when the post times
  // out after Discord took it.
  async seedCall(message: DiscordMessage): Promise<void> {
    const { webhookUrl } = loadConfig(stringVars(this.env));
    await this.alerting(async () => {
      await this.ctx.storage.put('seedCall', Date.now());
      await postWebhook(webhookUrl, message);
    });
  }

  // The top seeders over the last `days` UTC days, including today, and who has VIP from the bot.
  async seeders(days: number): Promise<SeederRow[]> {
    const keys = recentDayKeys(Date.now(), days);
    const stored = await this.ctx.storage.get([...keys, 'vip', STAFF_PROFILES_KEY]);
    const { granted } = parseVipState(stored.get('vip'));
    const staff = staffSteamIds(parseStaffProfiles(stored.get(STAFF_PROFILES_KEY)));
    return rankSeeders(keys.map((key) => withoutStaffSeeding(parsePlayerDay(stored.get(key)), staff)), SEEDERS_LISTED).map((p) => ({
      steamId: p.steamId,
      name: p.name,
      seedingMinutes: p.seedingMinutes,
      seedDays: p.seedDays,
      vipUntil: granted[p.steamId]?.expiresAt ?? null,
    }));
  }
}

// The stats only change once a minute. Each Worker instance keeps its last answers for a short while so a busy page
// does not wake the Durable Object on every request. Requests that arrive while a refresh is in flight wait for that
// one instead of starting their own. The live page's answer changes with every kill, so it is kept for less; the page
// mostly gets it over its WebSocket instead.
const CACHE_MS = 30_000;
const LIVE_CACHE_MS = 5_000;
const LIFETIME_CACHE_MS = 10 * 60_000;
// One answer per player page; past this many, the oldest are dropped.
const CACHE_ENTRIES = 200;
const cache = new Map<string, { body: Promise<string | null>; at: number }>();

// Public, read-only numbers, so any site may show them.
const PUBLIC_HEADERS = { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=30' };

// `load` answers null when there is no such thing, which is a 404.
const serveJson = async (key: string, load: () => Promise<unknown>, ctx: ExecutionContext, keepMs = CACHE_MS): Promise<Response> => {
  const now = Date.now();
  let entry = cache.get(key);
  if (entry === undefined || now - entry.at >= keepMs) {
    const fresh = { body: load().then((value) => (value === null ? null : JSON.stringify(value))), at: now };
    entry = fresh;
    // Re-added, so the oldest answers are always first.
    cache.delete(key);
    cache.set(key, fresh);
    for (const old of cache.keys()) {
      if (cache.size <= CACHE_ENTRIES) break;
      cache.delete(old);
    }
    // Other requests may be waiting on this refresh, so it must finish even if this request is cancelled.
    // A failed refresh is dropped so the next request tries again.
    ctx.waitUntil(
      fresh.body.catch(() => {
        if (cache.get(key) === fresh) cache.delete(key);
      }),
    );
  }
  const body = await entry.body;
  const headers = { ...PUBLIC_HEADERS, 'cache-control': `public, max-age=${Math.round(keepMs / 1000)}` };
  if (body === null) return Response.json({ error: 'Not found' }, { status: 404, headers });
  return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
};

// The website's JSON: the server's stats, the live match, everyone to find a player page for, the season roundup, and one
// player's page.
const publicRoute = (
  url: URL,
  watcher: () => DurableObjectStub<Watcher>,
): { key: string; load: () => Promise<unknown>; keepMs?: number } | null => {
  if (url.pathname === '/api/stats') return { key: 'stats', load: () => watcher().stats() };
  if (url.pathname === '/api/live') return { key: 'live', load: () => watcher().live(), keepMs: LIVE_CACHE_MS };
  if (url.pathname === '/api/players') return { key: 'players', load: () => watcher().players() };
  if (url.pathname === '/api/vote') return { key: 'vote', load: () => watcher().mapVote(), keepMs: LIVE_CACHE_MS };
  if (url.pathname === '/api/season') return { key: 'season', load: () => watcher().season() };
  // Added once a day, so kept for longer.
  if (url.pathname === '/api/lifetime') return { key: 'lifetime', load: () => watcher().publicLifetime(), keepMs: LIFETIME_CACHE_MS };
  const id = url.searchParams.get('id') ?? '';
  if (url.pathname === '/api/player' && PLAYER_ID.test(id)) return { key: `player:${id}`, load: () => watcher().profile(id) };
  return null;
};

// The staff page's sign-in (see adminauth.ts): Discord sends the browser back to CALLBACK_PATH on this Worker, which must
// be listed under OAuth2 → Redirects in the Discord Developer Portal.
const callbackUrl = (request: Request): string => `${new URL(request.url).origin}${CALLBACK_PATH}`;

// Logged each time, so the reason the staff page cannot load is in the Worker logs, not only on the page.
const notSetUp = (missing: string[]): Response => {
  console.error(notSetUpText(missing));
  return new Response(notSetUpText(missing), { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
};

const staffLogin = async (request: Request, vars: Record<string, string>): Promise<Response> => {
  const config = adminAuthConfig(vars);
  if ('missing' in config) return notSetUp(config.missing);
  const returnTo = returnAddress(new URL(request.url).searchParams.get('return'), config.siteOrigin);
  const { location, cookie } = await startLogin(config, callbackUrl(request), returnTo, Date.now());
  return new Response(null, { status: 302, headers: { location, 'set-cookie': cookie, 'cache-control': 'no-store' } });
};

// Back to a page on the website, with a session or what went wrong after the #, which no server sees.
const backToSite = (returnTo: string, fragment: string): Response =>
  new Response(null, {
    status: 302,
    headers: {
      location: `${returnTo}#${fragment}`,
      'set-cookie': CLEAR_LOGIN_COOKIE,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });

// Staff and players both come back here from Discord: the state they left with says which sign-in it was.
const staffCallback = async (request: Request, vars: Record<string, string>, watcher: () => DurableObjectStub<Watcher>): Promise<Response> => {
  const config = adminAuthConfig(vars);
  if ('missing' in config) return notSetUp(config.missing);
  const url = new URL(request.url);
  const state = await readState(config.clientSecret, url.searchParams.get('state'), request.headers.get('cookie'), Date.now());
  if (state === null) {
    // Not this browser's sign-in, or too late: the page that asked, if the state at least names it, learns that.
    const peeked = await peekState(config.clientSecret, url.searchParams.get('state'), Date.now());
    const page = peeked?.flow === 'player' ? ACCOUNT_PAGE : ADMIN_PAGE;
    return backToSite(`${config.siteOrigin}${page}`, 'error=expired');
  }
  if (state.flow === 'player') return playerCallback(request, vars, config, state, watcher);
  const { returnTo } = state;
  const back = (fragment: string): Response => backToSite(returnTo, fragment);
  const code = url.searchParams.get('code');
  if (code === null) return back(`error=${url.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'failed'}`);
  try {
    const result = await finishLogin(config, code, callbackUrl(request));
    if ('problem' in result) {
      console.info(`Staff sign-in refused: ${result.problem}`);
      return back(`error=${result.problem}`);
    }
    console.info(`Staff signed in: ${JSON.stringify(result.user.name)} (Discord user ${result.user.id})`);
    const { id, name, username } = result.user;
    await watcher()
      .noteStaff(id, name, username)
      .catch((error: unknown) => console.error(`Noting a staff name failed: ${errorText(error)}`));
    return back(`session=${await createSession(config.clientSecret, result.user, Date.now())}`);
  } catch (error) {
    console.error(`Staff sign-in failed: ${errorText(error)}`);
    return back('error=failed');
  }
};

// A player's sign-in (see accounts.ts): the same Discord callback as staff, a different session. The page is told after the
// #: the session, whether they are in the server (`member`), what the "join" button did (`join`: added, already, banned or
// unavailable), and what was found of their Steam account (`steam`: linked, none or taken).
const playerCallback = async (
  request: Request,
  vars: Record<string, string>,
  config: AdminAuthConfig,
  state: LoginState,
  watcher: () => DurableObjectStub<Watcher>,
): Promise<Response> => {
  const { returnTo } = state;
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (code === null) return backToSite(returnTo, `error=${url.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'failed'}`);
  const botToken = vars['DISCORD_BOT_TOKEN']?.trim();
  try {
    // Adding someone is the bot's, with the access token they gave. A failure is not a failed sign-in: they are told.
    const join = async (userId: string, accessToken: string): Promise<JoinOutcome> => {
      if (!botToken) return 'unavailable';
      try {
        return await addMember(botToken, config.guildId, userId, accessToken);
      } catch (error) {
        console.error(`Player sign-in: adding ${userId} to the server failed: ${errorText(error)}`);
        return 'unavailable';
      }
    };
    const login = await finishPlayerLogin(config, code, callbackUrl(request), state.join, join);
    const { user } = login;
    const result = await watcher().accountSignIn(
      { id: user.id, name: user.name },
      { member: login.member, joined: login.join === 'added', steamId: login.steamId, roles: login.roles },
    );
    console.info(`Player signed in: Discord user ${user.id} (member ${login.member}, join ${login.join ?? 'not asked'}, steam ${result.steam})`);
    const session = await createPlayerSession(config.clientSecret, user, Date.now());
    return backToSite(returnTo, `session=${session}&member=${login.member ? 1 : 0}&join=${login.join ?? 'no'}&steam=${result.steam}`);
  } catch (error) {
    console.error(`Player sign-in failed: ${errorText(error)}`);
    return backToSite(returnTo, 'error=failed');
  }
};

// GET /auth/player/login: a player signs in with Discord. `join=1` also asks Discord to let the bot add them to the server.
const playerLogin = async (request: Request, vars: Record<string, string>): Promise<Response> => {
  const config = adminAuthConfig(vars);
  if ('missing' in config) return notSetUp(config.missing);
  const params = new URL(request.url).searchParams;
  const returnTo = returnAddress(params.get('return'), config.siteOrigin, ACCOUNT_PAGE);
  const { location, cookie } = await startLogin(config, callbackUrl(request), returnTo, Date.now(), { flow: 'player', join: params.get('join') === '1' });
  return new Response(null, { status: 302, headers: { location, 'set-cookie': cookie, 'cache-control': 'no-store' } });
};

const STEAM_CALLBACK_PATH = '/auth/steam/callback';

// The cookie that ties a Steam sign-in to the browser that started it, as the Discord sign-in's does (LOGIN_COOKIE): its value is
// in the address Steam sends the browser back to (`n`, which Steam signs), and only the browser with the cookie is taken.
const STEAM_COOKIE = 'wardogs_steam';
const STEAM_COOKIE_SECONDS = 10 * 60;

// GET /auth/steam: sends the browser to Steam to sign in, to prove which Steam account is theirs.
const steamLogin = (request: Request, vars: Record<string, string>): Response => {
  const origin = siteOriginOf(vars);
  if (origin === null) return notSetUp(['SITE_URL']);
  const returnTo = returnAddress(new URL(request.url).searchParams.get('return'), origin, ACCOUNT_PAGE);
  const mark = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const callback = new URL(STEAM_CALLBACK_PATH, request.url);
  callback.searchParams.set('return', returnTo);
  callback.searchParams.set('n', mark);
  return new Response(null, {
    status: 302,
    headers: {
      location: steamLoginUrl(callback.href, new URL(request.url).origin),
      'set-cookie': `${STEAM_COOKIE}=${mark}; Path=/auth; Max-Age=${STEAM_COOKIE_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
      'cache-control': 'no-store',
    },
  });
};

const CLEAR_STEAM_COOKIE = `${STEAM_COOKIE}=; Path=/auth; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

// GET /auth/steam/callback: Steam sends the browser back. What Steam vouches for goes to the website as a proof, which the
// player's own session turns into a link (the proof names no Discord user, so it is no use to anyone else). Only for the
// browser that went to Steam: an address someone else got Steam to make cannot be used to link an account for a visitor.
const steamCallback = async (request: Request, vars: Record<string, string>): Promise<Response> => {
  const config = adminAuthConfig(vars);
  if ('missing' in config) return notSetUp(config.missing);
  const params = new URL(request.url).searchParams;
  const returnTo = returnAddress(params.get('return'), config.siteOrigin, ACCOUNT_PAGE);
  const to = (fragment: string): Response =>
    new Response(null, {
      status: 302,
      headers: { location: `${returnTo}#${fragment}`, 'set-cookie': CLEAR_STEAM_COOKIE, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
    });
  const cookie = /(?:^|;\s*)wardogs_steam=([0-9a-f]{32})(?:;|$)/.exec(request.headers.get('cookie') ?? '')?.[1];
  const mark = params.get('n');
  if (cookie === undefined || mark === null || cookie !== mark) return to('error=expired');
  try {
    const steamId = await verifySteamClaim(request.url);
    if (steamId === null) return to('error=steam');
    return to(`steamproof=${await createSteamProof(config.clientSecret, steamId, Date.now())}`);
  } catch (error) {
    console.error(`Steam sign-in failed: ${errorText(error)}`);
    return to('error=steam');
  }
};

// The account page's data and the website vote, for a signed-in player only. Like the staff page's: only the website may
// read it from a browser, and nothing keeps a copy.
const accountApi = async (request: Request, vars: Record<string, string>, watcher: () => DurableObjectStub<Watcher>): Promise<Response> => {
  const config = adminAuthConfig(vars);
  const headers = {
    'access-control-allow-origin': siteOriginOf(vars) ?? 'null',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '600',
    'cache-control': 'no-store',
    vary: 'origin',
  };
  if ('missing' in config) console.error(notSetUpText(config.missing));
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if ('missing' in config) return Response.json({ error: 'Sign-in is not set up yet.' }, { status: 503, headers });
  const session = await readPlayerSession(config.clientSecret, request.headers.get('authorization'), Date.now());
  if (session === null) return Response.json({ error: 'Sign in again' }, { status: 401, headers });
  const route = `${request.method} ${new URL(request.url).pathname}`;
  const unavailable = (what: string, error: unknown): Response => {
    console.error(`Player account ${what} failed: ${errorText(error)}`);
    return Response.json({ error: "Couldn't do that just now. Try again in a minute." }, { status: 503, headers });
  };
  if (route === 'GET /api/account') {
    try {
      const account = await watcher().accountView(session.userId);
      // Forgotten (or never saved): their session means nothing now.
      return account === null ? Response.json({ error: 'Sign in again' }, { status: 401, headers }) : Response.json(account, { headers });
    } catch (error) {
      return unavailable('page', error);
    }
  }
  if (route === 'POST /api/account') {
    const action = await readAccountAction(request);
    if (action === null) return Response.json({ error: 'Not an account request' }, { status: 400, headers });
    try {
      if (action.action === 'steam') {
        const steamId = await readSteamProof(config.clientSecret, action.proof, Date.now());
        if (steamId === null) return Response.json({ error: 'That Steam sign-in has run out. Try again.' }, { status: 400, headers });
        const linked = await watcher().accountLinkSteam(session.userId, steamId);
        return 'problem' in linked ? Response.json({ error: linked.problem }, { status: 400, headers }) : Response.json({ ok: true }, { headers });
      }
      const result = await watcher().accountAct(session.userId, action);
      return 'problem' in result ? Response.json({ error: result.problem }, { status: 400, headers }) : Response.json({ ok: true }, { headers });
    } catch (error) {
      return unavailable(action.action, error);
    }
  }
  if (route === 'POST /api/account/vote') {
    const vote = await readWebVote(request);
    if (vote === null) return Response.json({ error: 'Not a vote' }, { status: 400, headers });
    try {
      if (!(await watcher().accountIsMember(session.userId))) {
        return Response.json({ error: 'Join the Discord server to vote.', code: 'not-member' }, { status: 403, headers });
      }
      return Response.json(await watcher().castWebVote(session.userId, vote), { headers });
    } catch (error) {
      return unavailable('vote', error);
    }
  }
  return Response.json({ error: 'Not found' }, { status: 404, headers });
};

// GET /go/discord?src=<place>: counts the click (see discordclicks.ts) and sends the browser to the invite. The count runs in
// the background, so the redirect is not held up by it.
const goDiscord = (request: Request, vars: Record<string, string>, watcher: () => DurableObjectStub<Watcher>, ctx: ExecutionContext): Response => {
  const code = loadConfigQuiet(vars)?.inviteCode;
  if (code === undefined) return new Response('Not found', { status: 404 });
  ctx.waitUntil(
    watcher()
      .discordClick(sourceOf(new URL(request.url).searchParams.get('src')))
      .catch((error: unknown) => console.error(`Counting a Discord click failed: ${errorText(error)}`)),
  );
  return new Response(null, {
    status: 302,
    headers: { location: `https://discord.gg/${code}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  });
};

// The settings, or nothing when they are wrong: a bad setting elsewhere must not stop the invite working.
const loadConfigQuiet = (vars: Record<string, string>): Config | null => {
  try {
    return loadConfig(vars);
  } catch {
    return null;
  }
};

// The slash commands, run and suggested for in the same way from Discord and from the staff page.
const commandTools = (
  vars: Record<string, string>,
  watcher: () => DurableObjectStub<Watcher>,
): {
  run: (request: CommandRequest) => Promise<CommandReply>;
  suggest: (request: CommandRequest) => Promise<Choice[]>;
  record: (steamId: string) => Promise<AdminPlayerRecord>;
} => {
  const records: StaffRecords = {
    player: (steamId) => watcher().playerRecord(steamId),
    knownPlayers: () => watcher().knownPlayers(),
    log: (steamId, entry) => watcher().logAction(steamId, entry),
    ban: (ban) => watcher().ban(ban),
    unban: (target, by, byName) => watcher().unban(target, by, byName),
    vipAdd: (grant) => watcher().vipAdd(grant),
    vipRemove: (target) => watcher().vipRemove(target),
    nextMap: (map, playing) => watcher().stageNextMap(map, playing),
    steam: (steamId) => watcher().steamLookup(steamId),
    rotations: () => watcher().rotationBook(),
    editRotations: (edit, by, byName) => watcher().editRotations(edit, by, byName),
    privateProfiles: () => watcher().privateProfiles(),
    makePrivate: (player, by, byName) => watcher().setProfilePrivate(player, by, byName),
    makePublic: (steamId) => watcher().setProfilePublic(steamId),
    blockedCircles: () => watcher().blockedCircles(),
    blockCircle: (circle, by, byName) => watcher().setCircleBlocked(circle, by, byName),
    unblockCircle: (id) => watcher().setCircleUnblocked(id),
    voteOptions: () => watcher().voteOptions(),
    setVoteRain: (on, by, byName) => watcher().setVoteRain(on, by, byName),
    setVoteMap: (map, on, by, byName) => watcher().setVoteMap(map, on, by, byName),
  };
  return {
    run: runCommand({
      config: () => loadConfig(vars),
      http: socketHttp(connect),
      lastMatch: async () => (await watcher().recentMatches())[0] ?? null,
      privateProfiles: async () => privateSteamIds(await watcher().privateProfiles()),
      roundup: (choice) => watcher().roundup(choice),
      seeders: (days) => watcher().seeders(days),
      removeMatch: (endedAt) => watcher().removeMatch(endedAt),
      seedCall: (message) => watcher().seedCall(message),
      records,
      now: Date.now,
      log: console,
    }),
    suggest: suggestOptions({
      recentMatches: () => watcher().recentMatches(),
      config: () => loadConfig(vars),
      http: socketHttp(connect, SUGGEST_TIMEOUT_MS),
      records,
    }),
    // The staff page's player record: what /player shows.
    record: async (steamId) =>
      buildAdminPlayerRecord(await lookUpPlayer({ config: () => loadConfig(vars), http: socketHttp(connect), records, now: Date.now })(steamId)),
  };
};

// A staff page request to run a staff command, or for suggestions while staff fill one in. Far smaller than this.
const STAFF_BODY_BYTES = 8_192;
const StaffBodySchema = z.object({
  name: z.string().max(40),
  options: z.record(z.string().max(40), z.union([z.string().max(1_000), z.number(), z.boolean()])).default({}),
  focused: z.string().max(40).optional(),
});

const readStaffBody = async (request: Request): Promise<z.infer<typeof StaffBodySchema> | null> => {
  if (Number(request.headers.get('content-length') ?? 0) > STAFF_BODY_BYTES) return null;
  const body = await request.arrayBuffer();
  if (body.byteLength > STAFF_BODY_BYTES) return null;
  try {
    const parsed = StaffBodySchema.safeParse(JSON.parse(new TextDecoder().decode(body)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

// The staff page's live kill feed (see killfeed.ts), for a signed-in session from the website only. Sockets are not
// bound by CORS, so the Origin is checked here. The Durable Object keeps the socket, until the session runs out.
const staffSocket = async (
  request: Request,
  secret: string,
  siteOrigin: string | null,
  watcher: () => DurableObjectStub<Watcher>,
): Promise<Response> => {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
  if (siteOrigin === null || request.headers.get('origin') !== siteOrigin) return new Response('Not the staff page', { status: 403 });
  const token = socketSession(request.headers.get('sec-websocket-protocol'));
  const session = token === null ? null : await readSession(secret, `Bearer ${token}`, Date.now());
  if (session === null) return new Response('Sign in again', { status: 401 });
  const url = new URL(STAFF_SOCKET_PATH, request.url);
  url.searchParams.set('until', String(session.expiresAt));
  return watcher().fetch(new Request(url, request));
};

// The staff page's data, for a signed-in session only. Only the website may read it from a browser, and nothing keeps a
// copy.
const staffApi = async (request: Request, vars: Record<string, string>, watcher: () => DurableObjectStub<Watcher>): Promise<Response> => {
  const config = adminAuthConfig(vars);
  // The website may read even a refusal, so the page can say why. Without SITE_URL no site may.
  const headers = {
    'access-control-allow-origin': siteOriginOf(vars) ?? 'null',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '600',
    'cache-control': 'no-store',
    vary: 'origin',
  };
  // Logged on the browser's preflight too: without SITE_URL the browser stops there and never sends the request.
  if ('missing' in config) console.error(notSetUpText(config.missing));
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if ('missing' in config) return Response.json({ error: notSetUpText(config.missing) }, { status: 503, headers });
  if (request.method === 'GET' && new URL(request.url).pathname === '/api/admin/live') {
    return staffSocket(request, config.clientSecret, siteOriginOf(vars), watcher);
  }
  const session = await readSession(config.clientSecret, request.headers.get('authorization'), Date.now());
  if (session === null) return Response.json({ error: 'Sign in again' }, { status: 401, headers });
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;
  if (route === 'GET /api/admin/commands') return Response.json({ commands: ADMIN_COMMAND_DEFINITIONS }, { headers });
  if (route === 'POST /api/admin/command' || route === 'POST /api/admin/suggest') {
    const body = await readStaffBody(request);
    if (body === null) return Response.json({ error: 'Not a staff page request' }, { status: 400, headers });
    const { name } = body;
    if (!isCommandName(name) || !isAdminCommand(name)) return Response.json({ error: `/${name} is not a staff command` }, { status: 400, headers });
    const tools = commandTools(vars, watcher);
    if (route === 'POST /api/admin/suggest') {
      const options = Object.fromEntries(Object.entries(body.options).map(([key, value]) => [key, String(value)]));
      const focused = body.focused ?? '';
      if (!isOptionOf(name, focused, options['subcommand'])) return Response.json({ choices: [] }, { headers });
      const choices = await tools.suggest({ name, options, userId: session.userId, focused }).catch((error: unknown) => {
        console.error(`/${name} suggestions for the staff page failed: ${errorText(error)}`);
        return [];
      });
      return Response.json({ choices }, { headers });
    }
    // Checked as Discord checks a slash command, then run by the same code, as the signed-in staff member.
    const checked = checkOptions(name, body.options);
    if ('problem' in checked) return Response.json({ error: checked.problem }, { status: 400, headers });
    console.info(`Staff page: /${name} by ${JSON.stringify(session.name)} (Discord user ${session.userId})`);
    try {
      const reply = await tools.run({ name, options: checked.options, userId: session.userId, userName: session.name });
      return Response.json(reply, { headers });
    } catch (error) {
      console.error(`/${name} from the staff page failed: ${errorText(error)}`);
      return Response.json({ error: failureText(name, error) }, { status: 502, headers });
    }
  }
  // The Rotations tab: what it shows, and a change to the saved rotations.
  if (route === 'GET /api/admin/rotations' || route === 'POST /api/admin/rotations') {
    try {
      if (route === 'GET /api/admin/rotations') return Response.json(await watcher().rotationsPage(), { headers });
      const action = await readRotationAction(request);
      if (action === null) return Response.json({ error: 'Not a rotations request' }, { status: 400, headers });
      const what = 'entries' in action ? ` (${action.entries.length} maps)` : 'days' in action ? ` for days ${action.days.join(',')}` : '';
      console.info(
        `Staff page: rotations ${action.action} ${JSON.stringify(action.name)}${what} by ${JSON.stringify(session.name)} (Discord user ${session.userId})`,
      );
      const result = await watcher().rotationsAction(action, session.userId, session.name);
      if ('problem' in result) return Response.json({ error: result.problem }, { status: 400, headers });
      return Response.json(result, { headers });
    } catch (error) {
      console.error(`Staff page rotations failed: ${errorText(error)}`);
      return Response.json({ error: "Couldn't reach the rotations right now. If it was a change, check before trying again." }, { status: 503, headers });
    }
  }
  // The Lines tab: the lines the bot says in game, and a change to them.
  if (route === 'GET /api/admin/lines' || route === 'POST /api/admin/lines') {
    try {
      if (route === 'GET /api/admin/lines') return Response.json(await watcher().linesPage(), { headers });
      const action = await readLinesAction(request);
      if (action === null) return Response.json({ error: 'Not a lines request' }, { status: 400, headers });
      const what = action.action === 'save' ? ` (${action.lines.length} lines)` : '';
      console.info(
        `Staff page: lines ${action.action} ${JSON.stringify(action.list)}${what} by ${JSON.stringify(session.name)} (Discord user ${session.userId})`,
      );
      const result = await watcher().linesAction(action, session.userId, session.name);
      if ('problem' in result) return Response.json({ error: result.problem }, { status: 400, headers });
      return Response.json(result, { headers });
    } catch (error) {
      console.error(`Staff page lines failed: ${errorText(error)}`);
      return Response.json({ error: "Couldn't reach the lines right now. If it was a change, check before trying again." }, { status: 503, headers });
    }
  }
  // The Weapon rules tab: the weapons staff don't allow and what the bot does about them, and a change to them.
  if (route === 'GET /api/admin/rules' || route === 'POST /api/admin/rules') {
    try {
      if (route === 'GET /api/admin/rules') return Response.json(await watcher().rulesPage(), { headers });
      const action = await readRulesAction(request);
      if (action === null) return Response.json({ error: 'Not a weapon rules request' }, { status: 400, headers });
      const what = action.action === 'save' ? ` ${JSON.stringify(action.name)} (${action.mode}, ${action.weapons.length} weapons)` : ` ${JSON.stringify(action.id)}`;
      console.info(`Staff page: weapon rule ${action.action}${what} by ${JSON.stringify(session.name)} (Discord user ${session.userId})`);
      const result = await watcher().rulesAction(action, session.userId, session.name);
      if ('problem' in result) return Response.json({ error: result.problem }, { status: 400, headers });
      return Response.json(result, { headers });
    } catch (error) {
      console.error(`Staff page weapon rules failed: ${errorText(error)}`);
      return Response.json({ error: "Couldn't reach the weapon rules right now. If it was a change, check before trying again." }, { status: 503, headers });
    }
  }
  // The season page's roundup before the season is over, so staff can check it before the public sees it.
  if (route === 'GET /api/admin/season') {
    try {
      return Response.json(await watcher().season(true), { headers });
    } catch (error) {
      console.error(`Staff page season roundup failed: ${errorText(error)}`);
      return Response.json({ error: "Couldn't build the season roundup right now." }, { status: 503, headers });
    }
  }
  // A staff member links their Steam account, so the bot never counts them as a seeder, or unlinks one.
  if (route === 'POST /api/admin/profile') {
    const action = await readProfileAction(request);
    if (action === null) return Response.json({ error: 'Not a staff profile request' }, { status: 400, headers });
    try {
      const result = await watcher().staffProfile(action, { id: session.userId, name: session.name });
      if ('problem' in result) return Response.json({ error: result.problem }, { status: 400, headers });
      return Response.json(result, { headers });
    } catch (error) {
      console.error(`Staff profile change failed: ${errorText(error)}`);
      return Response.json({ error: "Couldn't save that just now. Try again in a minute." }, { status: 503, headers });
    }
  }
  // "Checked, they're fine" on a player worth a look, or taking it back.
  if (route === 'POST /api/admin/check') {
    const action = await readCheckAction(request);
    if (action === null) return Response.json({ error: 'Not a check request' }, { status: 400, headers });
    try {
      const result = await watcher().checkPlayer(action, { id: session.userId, name: session.name });
      const what = action.action === 'check' ? `checked ${action.steamId} (${action.reasons.join(', ') || 'no flags'})` : `took back the check on ${action.steamId}`;
      console.info(`Staff page: ${JSON.stringify(session.name)} (Discord user ${session.userId}) ${what}`);
      return Response.json(result, { headers });
    } catch (error) {
      console.error(`Staff page check failed: ${errorText(error)}`);
      return Response.json({ error: "Couldn't save that just now. Try again in a minute." }, { status: 503, headers });
    }
  }
  // A player's record, as /player gives it, as facts for the page to lay out.
  if (route === 'GET /api/admin/player') {
    const player = url.searchParams.get('player') ?? '';
    if (!/^\d{17}$/.test(player)) return Response.json({ error: 'Not a Steam ID' }, { status: 400, headers });
    try {
      return Response.json(await commandTools(vars, watcher).record(player), { headers });
    } catch (error) {
      console.error(`Staff page player record failed: ${errorText(error)}`);
      return Response.json({ error: "Couldn't load their record just now." }, { status: 503, headers });
    }
  }
  // "Dealt with" on a player on the Queue, or undoing it.
  if (route === 'POST /api/admin/dealt') {
    const action = await readDealtAction(request);
    if (action === null) return Response.json({ error: 'Not a dealt-with request' }, { status: 400, headers });
    try {
      const result = await watcher().dealWith(action, { id: session.userId, name: session.name });
      const what = action.action === 'deal' ? `dealt with ${action.steamId} (${action.reasons.join(', ') || 'no flags'})` : `undid dealing with ${action.steamId}`;
      console.info(`Staff page: ${JSON.stringify(session.name)} (Discord user ${session.userId}) ${what}`);
      return Response.json(result, { headers });
    } catch (error) {
      console.error(`Staff page dealt-with failed: ${errorText(error)}`);
      return Response.json({ error: "Couldn't save that just now. Try again in a minute." }, { status: 503, headers });
    }
  }
  // The Lifetime view, and its tables as CSV.
  if (route === 'GET /api/admin/lifetime') {
    try {
      return Response.json(await watcher().adminLifetime(), { headers });
    } catch (error) {
      console.error(`Staff page lifetime failed: ${errorText(error)}`);
      return Response.json({ error: "Couldn't load the numbers just now." }, { status: 503, headers });
    }
  }
  if (route === 'GET /api/admin/lifetime.csv') {
    const table = TABLE_NAMES.find((t) => t === url.searchParams.get('table'));
    if (table === undefined) return Response.json({ error: 'Not a table' }, { status: 400, headers });
    try {
      const csv = await watcher().adminLifetimeCsv(table);
      return new Response(csv, { headers: { ...headers, 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="wardogs-${table}.csv"` } });
    } catch (error) {
      console.error(`Staff page lifetime export failed: ${errorText(error)}`);
      return Response.json({ error: "Couldn't load the numbers just now." }, { status: 503, headers });
    }
  }
  const asked = Number(url.searchParams.get('days'));
  const days = ADMIN_PERIODS.find((d) => d === asked) ?? ADMIN_DEFAULT_DAYS;
  // The Kill feed tab: the latest kills and the headshots list, or one player's kills.
  if (route === 'GET /api/admin/kills') {
    const player = url.searchParams.get('player');
    if (player !== null && !/^\d{17}$/.test(player)) return Response.json({ error: 'Not a Steam ID' }, { status: 400, headers });
    try {
      const page = player === null ? await watcher().adminKills(days) : await watcher().adminPlayerKills(player, days);
      return Response.json(page, { headers });
    } catch (error) {
      console.error(`Staff page kills failed: ${errorText(error)}`);
      return Response.json({ error: 'The kill feed is unavailable' }, { status: 503, headers });
    }
  }
  // The Play time tab: how long players stay each day, and when they leave.
  if (route === 'GET /api/admin/retention') {
    try {
      return Response.json(await watcher().adminRetention(days), { headers });
    } catch (error) {
      console.error(`Staff page play time failed: ${errorText(error)}`);
      return Response.json({ error: "Couldn't load the numbers just now." }, { status: 503, headers });
    }
  }
  // The Discord growth card: clicks on the invite by place, and how many players have accounts.
  if (route === 'GET /api/admin/growth') {
    try {
      return Response.json(await watcher().discordGrowth(), { headers });
    } catch (error) {
      console.error(`Staff page Discord growth failed: ${errorText(error)}`);
      return Response.json({ error: "Couldn't load the numbers just now." }, { status: 503, headers });
    }
  }
  if (route !== 'GET /api/admin/overview') return Response.json({ error: 'Not found' }, { status: 404, headers });
  try {
    const overview = await watcher().adminOverview(days);
    return Response.json({ ...overview, user: { id: session.userId, name: session.name } }, { headers });
  } catch (error) {
    console.error(`Staff page failed: ${errorText(error)}`);
    return Response.json({ error: 'The staff page is unavailable' }, { status: 503, headers });
  }
};

// The UTC day the long-term records (lifetime.ts) are done up to.
const LIFETIME_ROLLED_KEY = 'lifetimeRolled';
const LIFETIME_RETRY_MS = 60 * 60_000;
// How long after midnight a match still running across it is waited for before the day is added anyway.
const LIFETIME_WAIT_MS = 3 * 60 * 60_000;

// The alert review's longest period, and its usual one.
const REVIEW_PERIOD_DAYS = 30;

// GET /api/review (see review.ts), for whoever tunes the alerts' marks: only with the REVIEW_TOKEN secret as the
// bearer; without the secret, the route is not there. ?days= picks the period, 1 to 30 UTC days.
const reviewApi = async (request: Request, vars: Record<string, string>, watcher: () => DurableObjectStub<Watcher>): Promise<Response> => {
  const token = vars['REVIEW_TOKEN']?.trim() ?? '';
  if (token === '') return new Response('Not found', { status: 404 });
  const headers = { 'cache-control': 'no-store' };
  if (token.length < MIN_FEED_TOKEN) {
    console.error(`Alert review refused: REVIEW_TOKEN must be at least ${MIN_FEED_TOKEN} characters`);
    return Response.json({ error: 'REVIEW_TOKEN is too short' }, { status: 500, headers });
  }
  if (!(await feedAuthorized(request.headers.get('authorization'), token))) {
    return Response.json({ error: 'Unknown review token' }, { status: 401, headers });
  }
  const asked = Number(new URL(request.url).searchParams.get('days') ?? REVIEW_PERIOD_DAYS);
  const days = Number.isInteger(asked) ? Math.min(Math.max(asked, 1), REVIEW_PERIOD_DAYS) : REVIEW_PERIOD_DAYS;
  try {
    return Response.json(await watcher().review(days), { headers });
  } catch (error) {
    console.error(`Alert review failed: ${errorText(error)}`);
    return Response.json({ error: 'The review is unavailable' }, { status: 503, headers });
  }
};

// A refused kill feed post is logged at most this often, so a wrong token does not fill the logs every two seconds. The
// same for a batch with none of its events read.
const REFUSAL_LOG_MS = 10 * 60_000;
let refusalLoggedAt = 0;
// The next-map vote's "no maps to offer" note is logged at most this often.
const VOTE_LOG_MS = 10 * 60_000;
// How long into the match after a vote's the rotation is put back, in minutes, for the moderation log.
const RESTORE_MINUTES = RESTORE_DELAY_MS / 60_000;
let voteUnavailableLoggedAt = 0;
let unreadLoggedAt = 0;

// The game's kill feed (see weapons.ts). It is only taken with the KILL_FEED_TOKEN secret as the bearer; without the
// secret, the route is not there.
const ingestKills = async (request: Request, vars: Record<string, string>, watcher: () => DurableObjectStub<Watcher>): Promise<Response> => {
  const token = vars['KILL_FEED_TOKEN']?.trim() ?? '';
  if (token === '') return new Response('Not found', { status: 404 });
  if (token.length < MIN_FEED_TOKEN) {
    console.error(`Kill feed refused: KILL_FEED_TOKEN must be at least ${MIN_FEED_TOKEN} characters`);
    return Response.json({ error: 'KILL_FEED_TOKEN is too short' }, { status: 500 });
  }
  if (!(await feedAuthorized(request.headers.get('authorization'), token))) {
    if (Date.now() - refusalLoggedAt >= REFUSAL_LOG_MS) {
      refusalLoggedAt = Date.now();
      console.error(
        'Kill feed refused: the token does not match KILL_FEED_TOKEN. Check the Token in the EventFeedEndpoints line in ServerSettings.ini.',
      );
    }
    return Response.json({ error: 'Unknown kill feed token' }, { status: 401 });
  }
  if (Number(request.headers.get('content-length') ?? 0) > MAX_FEED_BYTES) return Response.json({ error: 'Batch too large' }, { status: 413 });
  // Measured in bytes, as a body sent in chunks has no length up front.
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_FEED_BYTES) return Response.json({ error: 'Batch too large' }, { status: 413 });
  let batch: ReturnType<typeof parseFeed> = null;
  try {
    batch = parseFeed(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    // Not JSON: refused below.
  }
  if (batch === null) return Response.json({ error: 'Not a kill feed batch' }, { status: 400 });
  const { timeline, presence, unread } = batch;
  // After a game update, this is how a feed sent in a new form shows: batches come, and nothing in them is read.
  if (timeline.length + presence.length === 0 && unread > 0 && Date.now() - unreadLoggedAt >= REFUSAL_LOG_MS) {
    unreadLoggedAt = Date.now();
    console.error(`Kill feed: a batch came with ${unread} events, and none could be read. The game may send them in a new form.`);
  }
  try {
    const { accepted, ended, over } =
      timeline.length + presence.length === 0 ? { accepted: 0, ended: false, over: false } : await watcher().recordFeed({ timeline, presence });
    // Once the batch's last kills are counted, so the awards have them.
    if (ended) await watcher().matchEnded();
    // Once the state is saved, as the vote reads it.
    if (over) await watcher().voteMatchOver();
    return Response.json({ ok: true, accepted, skipped: unread });
  } catch (error) {
    console.error(`Kill feed batch failed: ${errorText(error)}`);
    return Response.json({ error: 'Could not record the kills' }, { status: 503 });
  }
};

export default {
  async scheduled(_controller, env) {
    await env.WATCHER.get(env.WATCHER.idFromName('watcher')).check();
  },

  // GET /api/stats, /api/players and /api/player feed the community website. The game POSTs its kill feed to
  // /api/ingest/events, after whatever path its Url has. Staff sign in to the website's staff page through /auth/login
  // and read its data from /api/admin/. Slash commands: Discord POSTs signed interactions to this Worker's URL.
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const watcher = () => env.WATCHER.get(env.WATCHER.idFromName('watcher'));
    if (request.method === 'POST' && url.pathname.endsWith(FEED_PATH)) return ingestKills(request, stringVars(env), watcher);
    if (request.method === 'GET' && url.pathname === '/auth/login') return staffLogin(request, stringVars(env));
    if (request.method === 'GET' && url.pathname === '/auth/player/login') return playerLogin(request, stringVars(env));
    if (request.method === 'GET' && url.pathname === CALLBACK_PATH) return staffCallback(request, stringVars(env), watcher);
    if (request.method === 'GET' && url.pathname === '/auth/steam') return steamLogin(request, stringVars(env));
    if (request.method === 'GET' && url.pathname === STEAM_CALLBACK_PATH) return steamCallback(request, stringVars(env));
    if (request.method === 'GET' && url.pathname === '/go/discord') return goDiscord(request, stringVars(env), watcher, ctx);
    if (url.pathname === '/api/account' || url.pathname === '/api/account/vote') return accountApi(request, stringVars(env), watcher);
    if (url.pathname.startsWith('/api/admin/')) return staffApi(request, stringVars(env), watcher);
    if (request.method === 'GET' && url.pathname === '/api/review') return reviewApi(request, stringVars(env), watcher);
    // The live page's WebSocket goes straight to the Durable Object, which keeps it.
    if (request.method === 'GET' && url.pathname === '/api/live/socket') return watcher().fetch(request);
    if (request.method === 'GET' && url.pathname.startsWith('/api/')) {
      const route = publicRoute(url, watcher);
      if (route === null) return Response.json({ error: 'Not found' }, { status: 404, headers: PUBLIC_HEADERS });
      try {
        return await serveJson(route.key, route.load, ctx, route.keepMs);
      } catch (error) {
        console.error(`${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`);
        return Response.json({ error: 'Stats are unavailable' }, { status: 503, headers: { 'access-control-allow-origin': '*' } });
      }
    }
    if (request.method !== 'POST') return new Response('Not found', { status: 404 });
    const vars = stringVars(env);
    const publicKey = vars['DISCORD_PUBLIC_KEY'];
    if (!publicKey) return new Response('DISCORD_PUBLIC_KEY is not set', { status: 500 });
    const { run, suggest } = commandTools(vars, watcher);
    const result = await handleInteraction(
      await request.text(),
      request.headers.get('x-signature-ed25519'),
      request.headers.get('x-signature-timestamp'),
      {
        publicKey,
        // Each staff command also tells the staff page who that Discord user is.
        runCommand: async (request) => {
          const { userId, userName, userHandle } = request;
          const noted =
            isAdminCommand(request.name) && userId && userName
              ? watcher()
                  .noteStaff(userId, userName, userHandle ?? null)
                  .catch((error: unknown) => console.error(`Noting a staff name failed: ${errorText(error)}`))
              : Promise.resolve();
          try {
            return await run(request);
          } finally {
            await noted;
          }
        },
        suggest,
        editReply: editOriginalReply(),
        deleteReply: deleteOriginalReply(),
        privateFollowUp: sendPrivateFollowUp(),
        log: console,
        now: Date.now,
        adminGuildId: vars['DISCORD_GUILD_ID']?.trim() || undefined,
        voteGuildId: vars['DISCORD_GUILD_ID']?.trim() || undefined,
        castVote: (press) => watcher().castMapVote(press),
        adminRoleIds: (vars['DISCORD_ADMIN_ROLE_IDS'] ?? '')
          .split(',')
          .map((id) => id.trim())
          .filter((id) => /^\d+$/.test(id)),
      },
    );
    if (result.followUp) {
      ctx.waitUntil(result.followUp().catch((error: unknown) => console.error(`Command reply failed: ${String(error)}`)));
    }
    return Response.json(result.body, { status: result.status });
  },
} satisfies ExportedHandler<Env>;
