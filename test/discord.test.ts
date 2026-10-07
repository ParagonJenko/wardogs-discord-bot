import { describe, expect, it } from 'vitest';
import { banReason } from '../src/moderation.ts';
import {
  buildGriefAlert,
  buildLastMatchEmbed,
  buildModLogMessage,
  buildPlayerEmbed,
  buildMatchSummary,
  buildMessage,
  buildPlayersEmbed,
  buildRotationEmbed,
  buildRoundupMessage,
  buildSeedCall,
  buildSeedersEmbed,
  buildSteamAlerts,
  buildLiveStatus,
  buildStatusEmbed,
  buildVipMessage,
  factionDot,
  postWebhook,
  type DiscordMessage,
} from '../src/discord.ts';
import type { PlayerGrief } from '../src/griefing.ts';
import type { Roundup } from '../src/roundup.ts';
import type { PlayerRecord } from '../src/staff.ts';
import type { SteamCheck } from '../src/steam.ts';

const server = { name: 'UK Wardogs #1', players: 7, maxPlayers: 64 };
const vip = { seedDays: 3, seedMinutes: 10, windowDays: 7, lengthDays: 7 };
const offer = 'Seed on 3 days in a week and get a reserved slot for a week.';
const rule = "A seed counts when you're on for more than 10 min and the server goes live.";

const serverId = '2615de90-da95-4950-913a-246b1db49237';
const join = '```\n2615de90-da95-4950-913a-246b1db49237\n```\nIn game: Deploy → Server Browser → Join by ID, paste the code, then Lookup.';

const embedOf = (message: DiscordMessage) => message.embeds[0];
const field = (message: DiscordMessage, name: string) => embedOf(message)?.fields?.find((f) => f.name === name)?.value;

describe('buildSeedCall', () => {
  it('is the seeding alert, worded as a call to join now', () => {
    const message = buildSeedCall({ ...server, map: 'Europe' }, { lowPop: 20, live: 20, roleId: '999', vip, siteUrl: 'https://gaminginit.com' });

    expect(message).toMatchObject({ content: '<@&999>', allowed_mentions: { parse: [], roles: ['999'] } });
    expect(embedOf(message)).toMatchObject({
      title: '🌱 Seeding UK Wardogs #1 now',
      description: "**We're going to try to seed now. Come join!**",
      color: 0xf1c40f,
      url: 'https://gaminginit.com',
    });
    expect(field(message, 'Players')).toBe('🟨⬛⬛⬛⬛⬛⬛⬛⬛⬛ **7**/64');
    expect(field(message, 'To go live')).toBe('**13** more');
    expect(field(message, '🎖️ Seeder VIP')).toBe(`${offer}\n${rule}`);
  });

  it("adds staff's note and who called it, and keeps a long server name within Discord's limit", () => {
    const message = buildSeedCall({ ...server, name: 'x'.repeat(500) }, { lowPop: 20, note: 'Alpha squad', calledBy: '42' });

    expect(embedOf(message)?.description).toBe("**We're going to try to seed now. Come join!**\n\nAlpha squad\n\nCalled by <@42>");
    expect(embedOf(message)?.title.length).toBeLessThanOrEqual(256);
    expect(message.allowed_mentions).toEqual({ parse: [], roles: [] });
  });
});

describe('buildMessage', () => {
  it('announces seeding with a population bar, the map and how many more it needs', () => {
    const message = buildMessage('seeding', { ...server, map: 'Europe' }, { lowPop: 20, live: 20 });

    expect(embedOf(message)).toMatchObject({ title: '🌱 UK Wardogs #1 is seeding', description: '**Jump in and help get it live!**', color: 0xf1c40f });
    expect(embedOf(message)?.fields).toEqual([
      { name: 'Players', value: '🟨⬛⬛⬛⬛⬛⬛⬛⬛⬛ **7**/64' },
      { name: 'Map', value: '🟦 Ozeti', inline: true },
      { name: 'To go live', value: '**13** more', inline: true },
    ]);
  });

  it('tells people what seeding earns when automatic VIP is on, only on the seeding alert', () => {
    const seeding = buildMessage('seeding', server, { lowPop: 20, vip });
    const live = buildMessage('live', { ...server, players: 20 }, { lowPop: 20, vip });

    expect(field(seeding, '🎖️ Seeder VIP')).toBe(`${offer}\n${rule}`);
    expect(field(live, '🎖️ Seeder VIP')).toBeUndefined();
  });

  it('announces going live, with a green bar', () => {
    const message = buildMessage('live', { ...server, players: 32 }, { lowPop: 20 });

    expect(embedOf(message)).toMatchObject({ title: '🟢 UK Wardogs #1 is live', color: 0x2ecc71 });
    expect(field(message, 'Players')).toBe('🟩🟩🟩🟩🟩⬛⬛⬛⬛⬛ **32**/64');
  });

  it('announces a drop below the low-pop threshold, with how many it needs to stay live', () => {
    const message = buildMessage('lowPop', { ...server, players: 18 }, { lowPop: 20 });

    expect(embedOf(message)).toMatchObject({ title: '🔻 UK Wardogs #1 dropped below 20 players', color: 0xe74c3c });
    expect(field(message, 'Players')).toBe('🟥🟥🟥⬛⬛⬛⬛⬛⬛⬛ **18**/64');
    expect(field(message, 'To stay live')).toBe('**2** more');
  });

  it('shows at least one square for a single player', () => {
    expect(field(buildMessage('seeding', { ...server, players: 1, maxPlayers: 100 }, { lowPop: 20 }), 'Players')).toBe(
      '🟨⬛⬛⬛⬛⬛⬛⬛⬛⬛ **1**/100',
    );
  });

  it('keeps the title within Discord\'s 256 character limit for long server names', () => {
    const [embed] = buildMessage('lowPop', { ...server, name: 'x'.repeat(500) }, { lowPop: 20 }).embeds;

    expect(embed?.title.length).toBeLessThanOrEqual(256);
  });

  it('credits the top seeders with medals when the server goes live, escaping their names', () => {
    const message = buildMessage('live', { ...server, players: 20 }, {
      lowPop: 20,
      seeders: [
        { name: 'Ash_1', minutes: 42 },
        { name: 'Bo', minutes: 30 },
        { name: 'Cy', minutes: 12 },
      ],
    });

    expect(field(message, 'Top seeders')).toBe('🥇 Ash\\_1 · 42 min\n🥈 Bo · 30 min\n🥉 Cy · 12 min');
  });

  it('shows how to join with the server\'s ID, last, on every alert when there is one', () => {
    for (const kind of ['seeding', 'live', 'lowPop'] as const) {
      const fields = embedOf(buildMessage(kind, server, { lowPop: 20, vip, serverId }))?.fields;
      expect(fields?.at(-1)).toEqual({ name: 'Join the server', value: join });
    }
    expect(field(buildMessage('live', server, { lowPop: 20 }), 'Join the server')).toBeUndefined();
  });

  it('adds no seeder list when nobody seeded', () => {
    expect(field(buildMessage('live', { ...server, players: 20 }, { lowPop: 20, seeders: [] }), 'Top seeders')).toBeUndefined();
  });

  it('links the title to the website and says so in the footer, when there is one', () => {
    const [embed] = buildMessage('seeding', server, { lowPop: 20, siteUrl: 'https://gaminginit.com' }).embeds;
    const [plain] = buildMessage('seeding', server, { lowPop: 20 }).embeds;

    expect(embed).toMatchObject({ url: 'https://gaminginit.com', footer: { text: 'Live stats and leaderboard: gaminginit.com' } });
    expect(plain?.url).toBeUndefined();
    expect(plain?.footer).toBeUndefined();
  });

  it('pings only the configured role, on every kind of alert', () => {
    for (const kind of ['seeding', 'live', 'lowPop'] as const) {
      const message = buildMessage(kind, server, { lowPop: 20, roleId: '999' });

      expect(message.content).toBe('<@&999>');
      expect(message.allowed_mentions).toEqual({ parse: [], roles: ['999'] });
    }
  });

  it('pings nobody when no role is configured, even if the server name contains @everyone', () => {
    const message = buildMessage('live', { ...server, name: '@everyone join' }, { lowPop: 20 });

    expect(message.content).toBeUndefined();
    expect(message.allowed_mentions).toEqual({ parse: [], roles: [] });
  });
});

describe('buildMatchSummary', () => {
  const summary = {
    map: 'Kavkazi',
    durationMs: 38 * 60_000,
    peakPlayers: 64,
    factionScores: [
      { name: 'Valkyra', score: 250, colorHex: '#3366ff' },
      { name: 'Kharr', score: 300, colorHex: '#ff3333' },
    ],
    top: [
      { name: 'Cy', kills: 12, deaths: 3 },
      { name: '**Ash**', kills: 11, deaths: 1 },
    ],
  };

  it('names the map and winner, in the winner’s colour, with the scores, length and peak', () => {
    const message = buildMatchSummary(summary, 'UK Wardogs #1');

    expect(embedOf(message)).toMatchObject({
      title: '🏁 Match over · 🟧 Bakurani',
      description: '🏆 **Kharr** won',
      color: 0xff3333,
      footer: { text: 'UK Wardogs #1' },
    });
    expect(embedOf(message)?.fields?.slice(0, 3)).toEqual([
      { name: 'Score', value: '🔴 **Kharr 300**\n🐻 Valkyra 250', inline: true },
      { name: 'Length', value: '38 min', inline: true },
      { name: 'Peak', value: '64 players', inline: true },
    ]);
  });

  it('keeps a black winner colour', () => {
    const black = [
      { name: 'Night', score: 100, colorHex: '#000000' },
      { name: 'Day', score: 50, colorHex: '#ffffff' },
    ];

    expect(embedOf(buildMatchSummary({ ...summary, factionScores: black }, 'UK'))?.color).toBe(0);
  });

  it('lists every faction when there are three, and calls a draw a draw', () => {
    const three = [
      { name: 'Kharr', score: 100 },
      { name: 'Valkyra', score: 100 },
      { name: 'Haldor', score: 41 },
    ];
    const message = buildMatchSummary({ ...summary, factionScores: three }, 'UK');

    expect(embedOf(message)).toMatchObject({ description: '🤝 **Draw**', color: 0x5865f2 });
    expect(field(message, 'Score')).toBe('**Kharr 100**\n🐻 Valkyra 100\nHaldor 41');
  });

  it('lists the top players with medals, kills, deaths and K/D, escaping their names', () => {
    expect(field(buildMatchSummary(summary, 'UK'), 'Top players')).toBe(
      '🥇 **Cy** · 12 kills · 3 deaths · 4.00 K/D\n🥈 **\\*\\*Ash\\*\\*** · 11 kills · 1 death · 11.00 K/D',
    );
  });

  it('tags the players after the top three with their rank', () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ name: `P${i + 1}`, kills: 10 - i, deaths: 1 }));

    expect(field(buildMatchSummary({ ...summary, top: five }, 'UK'), 'Top players')?.split('\n').slice(3)).toEqual([
      '`#4` **P4** · 7 kills · 1 death · 7.00 K/D',
      '`#5` **P5** · 6 kills · 1 death · 6.00 K/D',
    ]);
  });

  it('keeps the player list within Discord\'s 1024 character field limit for long names', () => {
    const longNames = Array.from({ length: 5 }, (_, i) => ({ name: `${'_'.repeat(300)}${i}`, kills: 9, deaths: 9 }));
    const value = field(buildMatchSummary({ ...summary, top: longNames }, 'UK'), 'Top players');

    expect(value?.length).toBeLessThanOrEqual(1024);
    expect(value?.split('\n')).toHaveLength(5);
  });

  it('never pings anyone', () => {
    expect(buildMatchSummary(summary, 'UK Wardogs #1').allowed_mentions).toEqual({ parse: [], roles: [] });
  });

  it('falls back to the raw map id and leaves out missing scores and players', () => {
    const message = buildMatchSummary({ ...summary, map: 'NewMap', factionScores: [], top: [] }, 'UK');

    expect(embedOf(message)?.title).toBe('🏁 Match over · NewMap');
    expect(embedOf(message)?.description).toBeUndefined();
    expect(embedOf(message)?.fields?.map((f) => f.name)).toEqual(['Length', 'Peak']);
  });

  it('adds the website to the footer when there is one', () => {
    expect(embedOf(buildMatchSummary(summary, 'UK', 'https://gaminginit.com/'))?.footer).toEqual({
      text: 'UK · Live stats and leaderboard: gaminginit.com',
    });
  });

  it('links the title to the match on the website, whether or not the site address ends in a slash', () => {
    const ended = { ...summary, endedAt: 1_727_690_000_000 };

    expect(embedOf(buildMatchSummary(ended, 'UK', 'https://gaminginit.com'))?.url).toBe(
      'https://gaminginit.com/matches#match-1727690000000',
    );
    expect(embedOf(buildMatchSummary(ended, 'UK', 'https://gaminginit.com/'))).toMatchObject({
      url: 'https://gaminginit.com/matches#match-1727690000000',
      footer: { text: 'UK · Live stats and leaderboard: gaminginit.com' },
    });
  });

  it('links the title to the website alone when it is not known when the match ended', () => {
    expect(embedOf(buildMatchSummary(summary, 'UK', 'https://gaminginit.com/'))?.url).toBe('https://gaminginit.com/');
    expect(embedOf(buildMatchSummary({ ...summary, endedAt: null }, 'UK', 'https://gaminginit.com'))?.url).toBe('https://gaminginit.com');
  });

  it('links nowhere without a website, even when it is known when the match ended', () => {
    expect(embedOf(buildMatchSummary({ ...summary, endedAt: 1_727_690_000_000 }, 'UK'))?.url).toBeUndefined();
  });
});

describe('buildStatusEmbed', () => {
  const rules = { seeding: 1, live: 20, lowPop: 20, cooldownMs: 0, graceMs: 0 };
  const status = {
    name: 'UK Wardogs #1',
    players: 24,
    maxPlayers: 98,
    map: 'Europe',
    rotationIndex: 1,
    factionScores: [
      { name: 'Valkyra', score: 43, colorHex: '#3366ffff' },
      { name: 'Kharr', score: 51, colorHex: '#f4900c' },
      { name: 'Haldor', score: 12 },
    ],
  };

  it('shows the state, a population bar, the map and each faction’s score by colour', () => {
    expect(buildStatusEmbed(status, rules)).toEqual({
      title: 'UK Wardogs #1',
      description: '🟢 **Live**',
      color: 0x2ecc71,
      fields: [
        { name: 'Players', value: '🟩🟩⬛⬛⬛⬛⬛⬛⬛⬛ **24**/98' },
        { name: 'Map', value: '🟦 Ozeti', inline: true },
        { name: 'Score', value: '🟠 **Kharr 51**\n🐻 Valkyra 43\nHaldor 12', inline: true },
      ],
    });
  });

  it('says how many more a seeding server needs, and shows an empty one', () => {
    expect(buildStatusEmbed({ ...status, players: 5, factionScores: [] }, rules)).toMatchObject({
      description: '🌱 **Seeding** · 15 more to go live',
      color: 0xf1c40f,
    });
    expect(buildStatusEmbed({ ...status, players: 0, map: '', factionScores: [] }, rules)).toEqual({
      title: 'UK Wardogs #1',
      description: '⚪ **Empty**',
      color: 0x95a5a6,
      fields: [{ name: 'Players', value: '⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛ **0**/98' }],
    });
  });

  it('links to the website when there is one', () => {
    expect(buildStatusEmbed(status, rules, 'https://gaminginit.com')).toMatchObject({ url: 'https://gaminginit.com' });
  });

  it("shows how to join with the server's ID when there is one", () => {
    expect(buildStatusEmbed(status, rules, undefined, serverId).fields?.at(-1)).toEqual({ name: 'Join the server', value: join });
  });
});

describe('buildLiveStatus', () => {
  const rules = { seeding: 1, live: 20, lowPop: 20, cooldownMs: 0, graceMs: 0 };
  const NOW = Date.UTC(2026, 9, 1, 20, 0);
  const status = {
    name: 'UK Wardogs #1',
    players: 24,
    maxPlayers: 98,
    map: 'Europe',
    rotationIndex: 1,
    factionScores: [
      { name: 'Valkyra', score: 43 },
      { name: 'Lonestar', score: 51 },
    ],
  };
  const player = (name: string, faction: string) => ({ steamId: name, name, kills: 0, deaths: 0, faction });
  const players = [player('Ash', 'Lonestar'), player('Bo', 'Valkyra'), player('Cy', 'Valkyra')];
  const tracked = (name: string, kills: number, deaths: number) => ({ name, kills, deaths, lastKills: kills, lastDeaths: deaths });
  const match = {
    key: 'Europe#1',
    startedAt: NOW - 40 * 60_000,
    lastSeenAt: NOW,
    liveAt: NOW - 25 * 60_000,
    summarisable: true,
    peakPlayers: 30,
    players: { a: tracked('Ash', 12, 3), b: tracked('Bo', 7, 5), c: tracked('Cy', 0, 2), d: tracked('Di', 9, 9) },
    factionScores: status.factionScores,
  };
  const view = { snapshot: { status, players }, lastSeen: null, match, nextMap: 'Kavkazi', now: NOW };

  it('shows a live match: players, map, next map, when it started, the score with team sizes and the top players', () => {
    expect(buildLiveStatus(view, rules, 'https://gaminginit.com')).toEqual({
      embeds: [
        {
          title: 'UK Wardogs #1',
          url: 'https://gaminginit.com',
          description: '🟢 **Live**\nGet in while there are slots!',
          color: 0x2ecc71,
          fields: [
            { name: 'Players', value: '🟩🟩⬛⬛⬛⬛⬛⬛⬛⬛ **24**/98' },
            { name: 'Map', value: '🟦 Ozeti', inline: true },
            { name: 'Next map', value: '🟧 Bakurani', inline: true },
            { name: 'Match started', value: `<t:${(NOW - 25 * 60_000) / 1000}:R>`, inline: true },
            { name: 'Score', value: '🤠 **Lonestar 51** · 1 on\n🐻 Valkyra 43 · 2 on', inline: true },
            { name: 'Top players', value: '🥇 **Ash** · 12 kills\n🥈 **Di** · 9 kills\n🥉 **Bo** · 7 kills', inline: true },
          ],
          footer: { text: 'Updates every minute · Live stats and leaderboard: gaminginit.com' },
          timestamp: '2026-10-01T20:00:00.000Z',
        },
      ],
      allowed_mentions: { parse: [], roles: [] },
    });
  });

  it("shows how to join with the server's ID, but not while the server is offline", () => {
    expect(embedOf(buildLiveStatus(view, rules, undefined, serverId))?.fields?.at(-1)).toEqual({ name: 'Join the server', value: join });
    expect(embedOf(buildLiveStatus({ ...view, snapshot: null }, rules, undefined, serverId))?.fields).toBeUndefined();
  });

  it('does not tell people to get in when the server is full', () => {
    const full = buildLiveStatus({ ...view, snapshot: { status: { ...status, players: 98 }, players } }, rules);

    expect(embedOf(full)?.description).toBe('🟢 **Live**\nFull right now. Keep trying!');
  });

  it('says how many more a seeding server needs, and how long it has been seeding', () => {
    const seeding = buildLiveStatus(
      { ...view, snapshot: { status: { ...status, players: 6, factionScores: [] }, players }, match: { ...match, liveAt: null } },
      rules,
    );

    expect(embedOf(seeding)).toMatchObject({ description: '🌱 **Seeding** · 14 more to go live\nJump in and help get it live!', color: 0xf1c40f });
    expect(field(seeding, 'Seeding since')).toBe(`<t:${(NOW - 40 * 60_000) / 1000}:R>`);
    expect(field(seeding, 'Top players')).toBeUndefined();
    expect(embedOf(seeding)?.footer).toEqual({ text: 'Updates every minute' });
  });

  it('shows an empty server without the last match', () => {
    const empty = buildLiveStatus({ ...view, snapshot: { status: { ...status, players: 0 }, players: [] }, nextMap: null }, rules);

    expect(embedOf(empty)).toMatchObject({ description: '⚪ **Empty**\nBe the first in!', color: 0x95a5a6 });
    expect(embedOf(empty)?.fields?.map((f) => f.name)).toEqual(['Players', 'Map']);
  });

  it('shows the server offline, with when it was last seen', () => {
    const offline = buildLiveStatus({ ...view, snapshot: null, lastSeen: { name: 'UK Wardogs #1', at: NOW - 10 * 60_000 } }, rules);

    expect(embedOf(offline)).toEqual({
      title: 'UK Wardogs #1',
      description: `🔴 **Offline** · Last seen <t:${(NOW - 10 * 60_000) / 1000}:R>`,
      color: 0xe74c3c,
      footer: { text: 'Updates every minute' },
      timestamp: '2026-10-01T20:00:00.000Z',
    });
    expect(embedOf(buildLiveStatus({ ...view, snapshot: null }, rules))).toMatchObject({
      title: 'Server status',
      description: "🔴 **Offline** · Can't reach the server",
    });
  });
});

describe('buildPlayersEmbed', () => {
  const p = (name: string, kills: number | null, deaths: number | null) => ({ steamId: name, name, kills, deaths });

  it('lists players by kills, fewer deaths first on a tie, with medals', () => {
    expect(buildPlayersEmbed([p('Low', 1, 0), p('Top', 9, 4), p('Tie', 9, 2)])).toEqual({
      title: '👥 3 players online',
      description: '🥇 **Tie** · 9 kills · 2 deaths\n🥈 **Top** · 9 kills · 4 deaths\n🥉 **Low** · 1 kill · 0 deaths',
      color: 0x5865f2,
      footer: { text: 'Most kills first' },
    });
  });

  it('shows a dash for counts the server left out', () => {
    expect(buildPlayersEmbed([p('New', null, null)]).description).toBe('🥇 **New** · – kills · – deaths');
  });

  it('lists the top 30 and counts the rest', () => {
    const embed = buildPlayersEmbed(Array.from({ length: 35 }, (_, i) => p(`P${i}`, 35 - i, 0)));

    expect(embed.description?.split('\n')).toHaveLength(30);
    expect(embed.footer?.text).toBe('Most kills first · 5 more not shown');
  });

  it('says when nobody is on', () => {
    expect(buildPlayersEmbed([])).toMatchObject({ title: '👥 Nobody is on the server' });
  });
});

describe('faction emojis', () => {
  it('shows each player with their team, and how many are on each team', () => {
    const embed = buildPlayersEmbed([
      { steamId: '1', name: 'Ash', kills: 5, deaths: 1, faction: 'Manticore' },
      { steamId: '2', name: 'Bo', kills: 3, deaths: 2, faction: 'Lonestar' },
      { steamId: '3', name: 'Cy', kills: 1, deaths: 0, faction: 'Manticore' },
      { steamId: '4', name: 'Di', kills: 0, deaths: 0 },
    ]);

    expect(embed.description?.split('\n')[0]).toBe('🥇 🦂 **Ash** · 5 kills · 1 death');
    expect(embed.description?.split('\n')[3]).toBe('`#4` **Di** · 0 kills · 0 deaths');
    expect(embed.fields).toEqual([
      { name: '🦂 Manticore', value: '2 players', inline: true },
      { name: '🤠 Lonestar', value: '1 player', inline: true },
    ]);
  });

  it('gives Lonestar, Valkyra and Manticore their own emoji in the score and the result', () => {
    const status = {
      name: 'gaminginit #1',
      players: 60,
      maxPlayers: 98,
      map: 'Europe',
      rotationIndex: 0,
      factionScores: [
        { name: 'Lonestar', score: 20, colorHex: '#3366ff' },
        { name: 'Valkyra', score: 52, colorHex: '#ff3333' },
        { name: 'MANTICORE', score: 40, colorHex: '#33ff33' },
      ],
    };
    const summary = buildMatchSummary(
      { map: 'Europe', durationMs: 60_000, peakPlayers: 60, factionScores: status.factionScores, top: [] },
      'gaminginit #1',
    );

    expect(buildStatusEmbed(status, { seeding: 1, live: 20, lowPop: 20, cooldownMs: 0, graceMs: 0 }).fields?.find((f) => f.name === 'Score')?.value).toBe(
      '🐻 **Valkyra 52**\n🦂 MANTICORE 40\n🤠 Lonestar 20',
    );
    expect(embedOf(summary)?.description).toBe('🏆 🐻 **Valkyra** won');
  });

  it('gives each faction a dot in its colour for choices: its own, or the nearest to its colour in game', () => {
    expect(['Lonestar', 'MANTICORE', 'Valkyra'].map((name) => factionDot(name))).toEqual(['🔵 ', '🟢 ', '🔴 ']);
    expect(factionDot('Kharr', '#f4900c')).toBe('🟠 ');
    expect(factionDot('Kharr')).toBe('');
  });

  it("doesn't take a faction called Constructor for one of its own", () => {
    expect(factionDot('Constructor')).toBe('');
    expect(factionDot('toString', '#ff3333')).toBe('🔴 ');
    expect(buildPlayersEmbed([{ steamId: '1', name: 'Ash', kills: 1, deaths: 0, faction: 'Constructor' }]).fields).toEqual([
      { name: 'Constructor', value: '1 player', inline: true },
    ]);
  });
});

describe('buildRotationEmbed', () => {
  const entries = [
    { map: 'Kavkazi', status: null },
    { map: 'Europe', status: 'now' },
    { map: 'NorthAmerica', status: 'next' },
  ];

  it('lists the maps from the current one onwards, wrapping round', () => {
    expect(buildRotationEmbed({ enabled: true, mode: 'ordered', entries }).description).toBe(
      '▶️ 🟦 **Ozeti** · now\n⏭️ 🟪 **Zestafona** · next\n▫️ 🟧 Bakurani',
    );
  });

  it('gives each map its own colour, and the embed the colour of the map being played', () => {
    const colour = (map: string) =>
      buildRotationEmbed({ enabled: true, mode: 'ordered', entries: [{ map, status: 'now' }] }).color;

    expect([colour('Kavkazi'), colour('Europe'), colour('NorthAmerica')]).toEqual([0xe67e22, 0x3498db, 0x9b59b6]);
    expect(colour('SomewhereNew')).toBe(0x5865f2);
    expect(buildRotationEmbed({ enabled: true, mode: 'ordered', entries: [{ map: 'SomewhereNew', status: 'now' }] }).description).toBe(
      '▶️ **SomewhereNew** · now',
    );
  });

  it('only shows the current and next map for a random rotation, and says why', () => {
    expect(buildRotationEmbed({ enabled: true, mode: 'random', entries })).toMatchObject({
      description: '▶️ 🟦 **Ozeti** · now\n⏭️ 🟪 **Zestafona** · next',
      footer: { text: 'Random order, so only the next map is known.' },
    });
  });

  it('puts the current map first in a random rotation even when the next one comes earlier in the list', () => {
    const shuffled = [
      { map: 'NorthAmerica', status: 'next' },
      { map: 'Kavkazi', status: null },
      { map: 'Europe', status: 'now' },
    ];

    expect(buildRotationEmbed({ enabled: true, mode: 'random', entries: shuffled }).description).toBe(
      '▶️ 🟦 **Ozeti** · now\n⏭️ 🟪 **Zestafona** · next',
    );
  });

  it('says when the rotation is off', () => {
    expect(buildRotationEmbed({ enabled: false, mode: 'ordered', entries })).toMatchObject({
      description: '▶️ 🟦 **Ozeti** · now',
      footer: { text: 'Rotation is off, so this map repeats.' },
    });
  });

  it('says when there is no rotation', () => {
    expect(buildRotationEmbed({ enabled: true, mode: 'ordered', entries: [] }).description).toBe('No maps in the rotation.');
  });
});

describe('buildLastMatchEmbed', () => {
  it('is the match summary, with when it ended', () => {
    const embed = buildLastMatchEmbed({
      map: 'Bakurani',
      endedAt: 1_727_690_000_000,
      durationMs: 38 * 60_000,
      peakPlayers: 64,
      factionScores: [
        { name: 'Valkyra', score: 100 },
        { name: 'Kharr', score: 80 },
      ],
      top: [{ name: 'Cy', kills: 12, deaths: 3 }],
    });

    expect(embed).toMatchObject({
      title: '🏁 Last match · 🟧 Bakurani',
      description: '🏆 🐻 **Valkyra** won · Ended <t:1727690000:R>',
      timestamp: '2024-09-30T09:53:20.000Z',
    });
    expect(embed.fields?.at(-1)).toEqual({ name: 'Top players', value: '🥇 **Cy** · 12 kills · 3 deaths · 4.00 K/D' });
  });

  it('links its title to the match on the website, and leaves the footer as it was', () => {
    const match = { map: 'Bakurani', endedAt: 1_727_690_000_000, durationMs: 60_000, peakPlayers: 64, factionScores: [], top: [] };

    expect(buildLastMatchEmbed(match, 'https://gaminginit.com/')).toMatchObject({
      url: 'https://gaminginit.com/matches#match-1727690000000',
      footer: { text: 'Live stats and leaderboard: gaminginit.com' },
    });
    expect(buildLastMatchEmbed(match).url).toBeUndefined();
  });
});

describe('buildRoundupMessage', () => {
  // Monday 28 Sep to Sunday 4 Oct 2026.
  const week: Roundup = {
    kind: 'week',
    start: Date.UTC(2026, 8, 28),
    end: Date.UTC(2026, 9, 5),
    partial: false,
    matches: 14,
    playedMs: (32 * 60 + 5) * 60_000,
    players: 186,
    peakPlayers: 98,
    busiestDay: { day: '2026-10-03', players: 84 },
    teams: [
      { name: 'Valkyra', colorHex: '#3366ff', matches: 14, wins: 9, losses: 5, draws: 0 },
      { name: 'Lonestar', matches: 10, wins: 4, losses: 5, draws: 1 },
    ],
    bestTeam: { name: 'Valkyra', colorHex: '#3366ff', matches: 14, wins: 9, losses: 5, draws: 0 },
    teamMinMatches: 3,
    kdMinHours: 2,
    kills: [
      { name: 'Ash', id: 'aaaaaaaaaaaa', kills: 54 },
      { name: 'Bo_b', kills: 41 },
    ],
    kd: [{ name: 'Ash', id: 'aaaaaaaaaaaa', kd: 3.2 }],
    playtime: [{ name: 'Cy', id: 'cccccccccccc', minutes: 845 }],
    seeding: [{ name: 'Di', id: 'dddddddddddd', seedDays: 4, minutes: 185 }],
    wins: [{ name: 'Ash', id: 'aaaaaaaaaaaa', wins: 9, played: 12 }],
    mvps: [],
    bestMatch: [{ name: 'Ash', id: 'aaaaaaaaaaaa', kills: 32, deaths: 4, map: 'Ozeti' }],
    biggestWin: {
      map: 'Ozeti',
      endedAt: 0,
      factionScores: [
        { name: 'Lonestar', score: 23 },
        { name: 'Valkyra', score: 100, colorHex: '#3366ff' },
      ],
    },
    closestMatch: { map: 'Bakurani', endedAt: 0, factionScores: [{ name: 'Lonestar', score: 100 }, { name: 'Valkyra', score: 98 }] },
    topMap: { map: 'Ozeti', matches: 8 },
    regular: null,
    rookie: null,
    awards: null,
  };

  const awards: NonNullable<Roundup['awards']> = {
    from: '2026-09-28',
    roles: [
      { role: 'assault', top: [{ name: 'Ash', id: 'aaaaaaaaaaaa', kills: 40 }, { name: 'Bo_b', kills: 12 }] },
      { role: 'support', top: [{ name: 'Cy', id: 'cccccccccccc', kills: 9 }] },
      { role: 'machine-gun', top: [] },
      { role: 'marksman', top: [{ name: 'Di', id: 'dddddddddddd', kills: 7 }] },
      { role: 'demolition', top: [] },
      { role: 'vehicle-gun', top: [] },
    ],
    headshots: { name: 'Di', id: 'dddddddddddd', headshots: 21 },
    longest: { name: 'Di', id: 'dddddddddddd', distance: 742.4, weapon: 'SV98' },
    variety: { name: 'Ash', id: 'aaaaaaaaaaaa', weapons: 9 },
    roadKills: { name: 'Bo_b', kills: 3 },
    melee: { name: 'Cy', id: 'cccccccccccc', kills: 1 },
    sidearm: null,
  };
  const awarded: Roundup = { ...week, awards, regular: { name: 'Cy', id: 'cccccccccccc', days: 7, of: 7 }, rookie: { name: 'Eve', minutes: 380 } };

  it('celebrates the best team and players of the week, linking names to their player pages', () => {
    const message = buildRoundupMessage(week, 'https://gaminginit.com/');

    expect(message.allowed_mentions).toEqual({ parse: [], roles: [] });
    expect(embedOf(message)).toMatchObject({
      title: '🏆 Weekly roundup · 28 Sep – 4 Oct',
      description:
        '**14 matches** · **32 h** played · **186 players** · peak **98**\n' +
        '🏆 Team of the week: 🐻 **Valkyra** · won 9 of 14 matches (64%)',
      color: 0x3366ff,
      url: 'https://gaminginit.com/',
    });
    expect(field(message, '⚔️ Teams')).toBe('🐻 **Valkyra** · 9 W · 5 L · 64%\n🤠 Lonestar · 4 W · 5 L · 1 D · 40%');
    expect(field(message, '🔫 Most kills')).toBe(
      '🥇 **[Ash](https://gaminginit.com/player?id=aaaaaaaaaaaa)** · 54\n🥈 **Bo\\_b** · 41',
    );
    expect(field(message, '🎯 Best K/D (2+ hours played)')).toBe('🥇 **[Ash](https://gaminginit.com/player?id=aaaaaaaaaaaa)** · 3.20');
    expect(field(message, '💥 Most kills in a match')).toBe('🥇 **[Ash](https://gaminginit.com/player?id=aaaaaaaaaaaa)** · 32 · 🟦 Ozeti');
    expect(field(message, '🏅 Most wins')).toBe('🥇 **[Ash](https://gaminginit.com/player?id=aaaaaaaaaaaa)** · 9 of 12');
    expect(field(message, '⭐ Most MVPs')).toBe('–');
    expect(field(message, '⏱️ Most time played')).toBe('🥇 **[Cy](https://gaminginit.com/player?id=cccccccccccc)** · 14 h 5 min');
    expect(field(message, '🌱 Top seeders · thanks for getting us live!')).toBe(
      '🥇 **[Di](https://gaminginit.com/player?id=dddddddddddd)** · 4 seed days · 3 h 5 min',
    );
    expect(field(message, '✨ Highlights')).toBe(
      [
        '💪 Biggest win: 🐻 **Valkyra** 100 – 23 Lonestar · 🟦 Ozeti',
        '😬 Closest finish: 🤠 **Lonestar** 100 – 98 Valkyra · 🟧 Bakurani',
        '🗺️ Most played: 🟦 Ozeti · 8 matches',
        '📅 Busiest day: Sat 3 Oct · 84 players',
      ].join('\n'),
    );
    expect(embedOf(message)?.fields?.filter((f) => f.inline)).toHaveLength(6);
    expect(embedOf(message)?.footer?.text).toBe(
      "Weeks run Monday to Sunday, UTC.\nMVP: top of a match's scoreboard. Team of the week: best win rate, 3+ matches.\n" +
        'Live stats and leaderboard: gaminginit.com',
    );
  });

  it('adds the awards: the best at each role from the kill feed, and shout-outs', () => {
    const message = buildRoundupMessage(awarded, 'https://gaminginit.com/');
    expect(message.embeds).toHaveLength(2);
    const embed = message.embeds[1];
    const link = (name: string, id: string) => `**[${name}](https://gaminginit.com/player?id=${id})**`;
    expect(embed?.title).toBe('🎖️ Awards · 28 Sep – 4 Oct');
    expect(embed?.fields).toEqual([
      { name: '🪖 Best assaulter', value: `🥇 ${link('Ash', 'aaaaaaaaaaaa')} · 40\n🥈 **Bo\\_b** · 12`, inline: true },
      { name: '💣 Best support', value: `🥇 ${link('Cy', 'cccccccccccc')} · 9`, inline: true },
      { name: '🔥 Best machine gunner', value: '–', inline: true },
      { name: '🔭 Best marksman', value: `🥇 ${link('Di', 'dddddddddddd')} · 7`, inline: true },
      { name: '🧨 Best demolitions', value: '–', inline: true },
      { name: '🚁 Best vehicle crew', value: '–', inline: true },
      {
        name: '🌟 Shout-outs',
        value: [
          `💀 Headhunter: ${link('Di', 'dddddddddddd')} · 21 headshots`,
          `📏 Longest shot: ${link('Di', 'dddddddddddd')} · 742 m · SV98`,
          `🧰 Jack of all trades: ${link('Ash', 'aaaaaaaaaaaa')} · kills with 9 weapons`,
          '🚗 Road rage: **Bo\\_b** · 3 run over or blown up',
          `🔨 Bonk: ${link('Cy', 'cccccccccccc')} · 1 melee kill`,
          `📆 Ever-present: ${link('Cy', 'cccccccccccc')} · on 7 of 7 days`,
          '🐣 Rookie of the week: **Eve** · 6 h 20 min played',
        ].join('\n'),
      },
    ]);
    expect(embed?.footer?.text).toBe(
      'Assault: assault rifles, SMGs and shotguns. Support: mortars, artillery and emplacements. Machine gunner: LMGs. ' +
        'Marksman: marksman and sniper rifles, and the bow. Demolitions: launchers, grenades, mines and C4. ' +
        "Vehicle crew: vehicle guns.\nKills from the game's kill feed; team kills don't count.\nRookie: first seen this week.",
    );
  });

  it('says when the kill feed started during the period, and has shout-outs alone without it', () => {
    const later = buildRoundupMessage({ ...awarded, awards: { ...awards, from: '2026-09-30' } }).embeds[1];
    expect(later?.footer?.text).toContain("The kill feed's awards count from Wed 30 Sep.");
    const noFeed = buildRoundupMessage({ ...awarded, awards: null, rookie: null }).embeds[1];
    expect(noFeed?.fields).toEqual([{ name: '🌟 Shout-outs', value: '📆 Ever-present: **Cy** · on 7 of 7 days' }]);
    expect(noFeed).not.toHaveProperty('footer');
    expect(buildRoundupMessage(week).embeds).toHaveLength(1);
  });

  it('names the month, or a week or month still going', () => {
    const title = (r: Partial<Roundup>) => embedOf(buildRoundupMessage({ ...week, ...r }))?.title;
    expect(title({ kind: 'month', start: Date.UTC(2026, 8, 1), end: Date.UTC(2026, 9, 1) })).toBe('🏆 Monthly roundup · September 2026');
    expect(title({ partial: true, end: Date.UTC(2026, 9, 3, 15) })).toBe('🏆 This week so far · 28 Sep – 3 Oct');
    expect(title({ partial: true, end: Date.UTC(2026, 8, 28, 9) })).toBe('🏆 This week so far · 28 Sep');
    expect(title({ kind: 'month', partial: true, start: Date.UTC(2026, 9, 1), end: Date.UTC(2026, 9, 3) })).toBe(
      '🏆 This month so far · October 2026',
    );
  });

  it('leaves the names unlinked without a website, and the team line out without a clear best team', () => {
    const message = buildRoundupMessage({ ...week, bestTeam: null });
    expect(embedOf(message)?.description).toBe('**14 matches** · **32 h** played · **186 players** · peak **98**');
    expect(embedOf(message)?.color).toBe(0xf1c40f);
    expect(field(message, '⚔️ Teams')).toBe('🐻 Valkyra · 9 W · 5 L · 64%\n🤠 Lonestar · 4 W · 5 L · 1 D · 40%');
    expect(field(message, '🔫 Most kills')).toBe('🥇 **Ash** · 54\n🥈 **Bo\\_b** · 41');
    expect(embedOf(message)).not.toHaveProperty('url');
  });

  it('shows time played and seeding for a week without matches', () => {
    const quiet = buildRoundupMessage({
      ...week,
      matches: 0,
      playedMs: 0,
      peakPlayers: null,
      teams: [],
      bestTeam: null,
      kills: [],
      kd: [],
      wins: [],
      bestMatch: [],
      biggestWin: null,
      closestMatch: null,
      topMap: null,
    });
    expect(embedOf(quiet)?.description).toBe('**186 players** · no matches went live');
    expect(embedOf(quiet)?.fields?.map((f) => [f.name, f.inline])).toEqual([
      ['⏱️ Most time played', undefined],
      ['🌱 Top seeders · thanks for getting us live!', undefined],
      ['✨ Highlights', undefined],
    ]);
  });

  it('drops the links rather than go over Discord limits', () => {
    // 40 characters that all need escaping, on every board, with a long website address.
    const name = '_'.repeat(60);
    const three = <T extends object>(row: T) => [1, 2, 3].map(() => ({ name, id: 'aaaaaaaaaaaa', ...row }));
    const longest: Roundup = {
      ...week,
      kills: three({ kills: 999 }),
      kd: three({ kd: 99.99 }),
      playtime: three({ minutes: 99_999 }),
      seeding: three({ seedDays: 7, minutes: 99_999 }),
      wins: three({ wins: 99, played: 99 }),
      mvps: three({ mvps: 99 }),
      bestMatch: three({ kills: 999, deaths: 999, map: 'Zestafona' }),
    };
    const site = `https://gaminginit.com/${'x'.repeat(250)}`;
    const embed = embedOf(buildRoundupMessage(longest, site));
    const length = (e: typeof embed) =>
      (e?.title.length ?? 0) +
      (e?.description?.length ?? 0) +
      (e?.footer?.text.length ?? 0) +
      (e?.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0);
    expect(length(embed)).toBeLessThanOrEqual(6000);
    expect(embed?.fields?.every((f) => f.value.length <= 1024)).toBe(true);
    expect(field(buildRoundupMessage(longest, site), '🔫 Most kills')).not.toContain('player?id=');
    // With a short address the links fit.
    expect(field(buildRoundupMessage(longest, 'https://gaminginit.com'), '🔫 Most kills')).toContain('player?id=');

    // The awards count too: both embeds together stay under the limit.
    const withAwards = (who: string): Roundup => {
      const one = { name: who, id: 'aaaaaaaaaaaa' };
      const top = [1, 2, 3].map(() => ({ ...one, kills: 999 }));
      return {
        ...longest,
        ...Object.fromEntries((['kills', 'kd', 'playtime', 'seeding', 'wins', 'mvps', 'bestMatch'] as const).map((board) => [board, longest[board].map((p) => ({ ...p, name: who }))])),
        awards: {
          ...awards,
          roles: awards.roles.map(({ role }) => ({ role, top })),
          headshots: { ...one, headshots: 999 },
          longest: { ...one, distance: 999, weapon: 'Z20 Lakota miniguns' },
          variety: { ...one, weapons: 99 },
          roadKills: { ...one, kills: 999 },
          melee: { ...one, kills: 999 },
          sidearm: { ...one, kills: 999 },
        },
        regular: { ...one, days: 31, of: 31 },
        rookie: { ...one, minutes: 99_999 },
      };
    };
    const both = buildRoundupMessage(withAwards('A_Long_Player_Name_[WD]'), site).embeds;
    expect(both).toHaveLength(2);
    expect(both.reduce((sum, e) => sum + length(e), 0)).toBeLessThanOrEqual(6000);
    expect(both.every((e) => e.fields?.every((f) => f.value.length <= 1024))).toBe(true);
    expect(both[1]?.fields?.[0]?.value).not.toContain('player?id=');
    // Too long even without links, the awards are left out.
    const tooLong = buildRoundupMessage(withAwards(name), site).embeds;
    expect(tooLong).toHaveLength(1);
    expect(length(tooLong[0])).toBeLessThanOrEqual(6000);
  });
});

describe('buildSeedersEmbed', () => {
  it('lists seeders with medals, seed days, minutes, Steam IDs and VIP, and explains it in the footer', () => {
    const embed = buildSeedersEmbed(
      [
        { steamId: '76561198000000001', name: 'Ash_1', seedingMinutes: 95, seedDays: 3, vipUntil: 1_727_690_000_000 },
        { steamId: '76561198000000002', name: 'Bo', seedingMinutes: 40, seedDays: 1, vipUntil: null },
      ],
      7,
      10,
      vip,
    );

    expect(embed).toEqual({
      title: '🌱 Top seeders · last 7 days',
      description: [
        '🥇 **Ash\\_1** · 3 seed days · 95 min',
        '`76561198000000001` · 🎖️ VIP until <t:1727690000:f>',
        '🥈 **Bo** · 1 seed day · 40 min',
        '`76561198000000002`',
      ].join('\n'),
      color: 0xf1c40f,
      footer: {
        text: `A seed day: on for more than 10 min while the server seeded, and it then went live. Days are UTC.\nVIP: ${offer}`,
      },
    });
  });

  it('says so when nobody seeded', () => {
    expect(buildSeedersEmbed([], 1, 10, null)).toMatchObject({
      title: '🌱 Top seeders · last 1 day',
      description: 'Nobody seeded in that time.',
      footer: { text: 'A seed day: on for more than 10 min while the server seeded, and it then went live. Days are UTC.' },
    });
  });
});

describe('buildVipMessage', () => {
  it('thanks who earned a reserved slot, and says how to earn one', () => {
    const message = buildVipMessage([{ name: 'Ash_1' }], [], vip, 'https://gaminginit.com');

    expect(embedOf(message)).toEqual({
      title: '🎖️ Reserved slots for seeders',
      description: '🎉 **Ash\\_1** earned a reserved slot for a week by seeding. Thank you!',
      color: 0xf1c40f,
      fields: [{ name: 'Earn one too', value: `${offer}\n${rule}` }],
      url: 'https://gaminginit.com',
      footer: { text: "Reserved slots start after the server's next restart. · Live stats and leaderboard: gaminginit.com" },
    });
    expect(message.allowed_mentions).toEqual({ parse: [], roles: [] });
  });

  it('keeps the website in the footer next to the restart note', () => {
    expect(embedOf(buildVipMessage([{ name: 'Ash' }], [], vip, 'https://gaminginit.com'))?.footer).toEqual({
      text: "Reserved slots start after the server's next restart. · Live stats and leaderboard: gaminginit.com",
    });
  });

  it('lists several players, and who kept theirs for another week', () => {
    const message = buildVipMessage([{ name: 'Ash' }, { name: 'Bo' }, { name: 'Cy' }], [{ name: 'Dee' }], vip);

    expect(embedOf(message)?.description).toBe('🎉 **Ash, Bo and Cy** earned reserved slots for a week by seeding. Thank you!');
    expect(field(message, 'Kept for another week')).toBe('Dee');
  });

  it('works for renewals alone, and keeps a long list short', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ name: `P${i}` }));

    expect(embedOf(buildVipMessage([], [{ name: 'Dee' }], vip))?.description).toBeUndefined();
    expect(embedOf(buildVipMessage(many, [], vip))?.description).toContain('P19 and 5 more** earned');
  });
});

describe('buildPlayerEmbed', () => {
  const NOW = Date.UTC(2026, 8, 30, 12);
  const DAY = 86_400_000;
  const ID = '76561198000000001';
  const record: PlayerRecord = { name: 'Ash', totals: null, vip: null, vipBlockedUntil: null, staffSpot: false, privateProfile: false, log: [], ban: null, grief: null };
  const profile = { steamId: ID, name: 'Ash_*', record, online: null, reserved: false, serverBan: null, days: 90, now: NOW };
  const field = (embed: ReturnType<typeof buildPlayerEmbed>, name: string) => embed.fields?.find((f) => f.name === name)?.value;
  const t = (at: number, style: string) => `<t:${at / 1000}:${style}>`;

  it('shows the Steam ID with a profile link, and says when the bot has not seen them', () => {
    const embed = buildPlayerEmbed(profile);

    expect(embed.title).toBe('👤 Ash\\_\\*');
    expect(embed.description).toBe(`\`${ID}\` · [Steam profile](https://steamcommunity.com/profiles/${ID})\n⚫ Not in game`);
    expect(field(embed, 'Time · last 90 days')).toBe('Not seen on the server.');
    expect(field(embed, 'Staff history')).toBe('Nothing through the bot yet.');
  });

  it('says when their profile is private', () => {
    const embed = buildPlayerEmbed({ ...profile, record: { ...record, privateProfile: true } });

    expect(embed.description).toBe(
      `\`${ID}\` · [Steam profile](https://steamcommunity.com/profiles/${ID})\n⚫ Not in game\n🔒 Private profile: the public sees them as \\[private profile\\]`,
    );
  });

  it('shows a ban the bot made, and trusts the server when the ban was lifted or replaced by hand', () => {
    const ban = { name: 'Ash', until: NOW + DAY, reason: 'Cheating', serverReason: banReason('Cheating', NOW + DAY), by: '42', at: NOW };
    const botBan = { steamId: ID, reason: banReason('Cheating', NOW + DAY), bannedBy: 'rcon' };
    const banned = buildPlayerEmbed({ ...profile, record: { ...record, ban }, serverBan: botBan });
    const bots = `🔨 Banned until ${t(NOW + DAY, 'f')} (${t(NOW + DAY, 'R')}) by <@42>: Cheating`;

    expect(field(banned, 'Ban')).toBe(bots);
    expect(banned.color).toBe(0xe74c3c);
    expect(field(buildPlayerEmbed({ ...profile, record: { ...record, ban } }), 'Ban')).toBe('Not banned');
    expect(
      field(buildPlayerEmbed({ ...profile, record: { ...record, ban }, serverBan: { steamId: ID, reason: 'Abuse', bannedBy: 'console' } }), 'Ban'),
    ).toBe('🔨 Banned on the server: Abuse');
    expect(field(buildPlayerEmbed({ ...profile, record: { ...record, ban }, serverBan: undefined }), 'Ban')).toBe(
      `${bots}\n(Couldn't check the server's ban list.)`,
    );
    expect(field(buildPlayerEmbed({ ...profile, serverBan: { steamId: ID, reason: null, bannedBy: 'config' } }), 'Ban')).toBe(
      '🔨 Banned on the server',
    );
  });

  it('shows what Steam says about their account, unless the bot has no Steam key', () => {
    const steam = {
      at: NOW - 3_600_000,
      found: true,
      vacBans: 1,
      gameBans: 0,
      lastBanAt: NOW - 40 * DAY,
      communityBanned: false,
      tradeBan: 'none' as const,
      public: false,
      setUp: true,
      createdAt: null,
    };
    const checked = `Checked ${t(NOW - 3_600_000, 'R')}`;

    expect(field(buildPlayerEmbed(profile), 'Steam account')).toBeUndefined();
    expect(field(buildPlayerEmbed({ ...profile, steam: 'off' }), 'Steam account')).toBeUndefined();
    expect(field(buildPlayerEmbed({ ...profile, steam: 'failed' }), 'Steam account')).toBe("Couldn't reach Steam just now.");
    expect(field(buildPlayerEmbed({ ...profile, steam }), 'Steam account')).toBe(
      `🚩 **High risk** · 5 points\n1 VAC ban, 40 days ago · Account age hidden · Private profile\n${checked}`,
    );
    expect(field(buildPlayerEmbed({ ...profile, steam: { ...steam, vacBans: 0, lastBanAt: null, public: true, createdAt: NOW - 4000 * DAY } }), 'Steam account')).toBe(
      `✅ **Nothing risky**\nNo VAC or game bans · Account made 10 years ago · Public profile\n${checked}`,
    );
    expect(field(buildPlayerEmbed({ ...profile, steam: { ...steam, found: false } }), 'Steam account')).toBe(`Steam has no account with this ID. ${checked}`);
  });

  it('shows a ban waiting for the player to join, until the server has it', () => {
    const ban = { name: 'Ash', until: null, reason: 'Cheating', serverReason: 'Cheating', by: '42', at: NOW, waiting: true };
    const waiting = buildPlayerEmbed({ ...profile, record: { ...record, ban } });

    expect(field(waiting, 'Ban')).toBe('🔨 Banned permanently by <@42>: Cheating\n(Not on the server yet: the bot bans them when they next join.)');
    expect(waiting.color).toBe(0xe74c3c);
    expect(field(buildPlayerEmbed({ ...profile, record: { ...record, ban }, serverBan: { steamId: ID, reason: 'Cheating', bannedBy: 'rcon' } }), 'Ban')).toBe(
      '🔨 Banned permanently by <@42>: Cheating',
    );
  });

  it('shows VIP from the bot, and when staff blocked automatic VIP', () => {
    const vip = { name: 'Ash', grantedAt: NOW, expiresAt: NOW + 7 * DAY };

    expect(field(buildPlayerEmbed({ ...profile, reserved: true, record: { ...record, vip } }), 'VIP')).toBe(
      `🎖️ Reserved slot until ${t(NOW + 7 * DAY, 'f')}`,
    );
    expect(field(buildPlayerEmbed({ ...profile, reserved: null, record: { ...record, vip } }), 'VIP')).toBe(
      `🎖️ Reserved slot until ${t(NOW + 7 * DAY, 'f')}, by the bot's records\n(Couldn't check the reserved list.)`,
    );
    expect(field(buildPlayerEmbed({ ...profile, reserved: null }), 'VIP')).toBe("Couldn't read the reserved list");
    expect(field(buildPlayerEmbed({ ...profile, reserved: true, record: { ...record, staffSpot: true } }), 'VIP')).toBe(
      '🎖️ Staff spot: a reserved slot while they are staff',
    );
    expect(field(buildPlayerEmbed({ ...profile, reserved: false, record: { ...record, staffSpot: true } }), 'VIP')).toBe(
      '🎖️ Staff spot: on the reserved list from the next check',
    );
    expect(field(buildPlayerEmbed({ ...profile, reserved: null, record: { ...record, staffSpot: true } }), 'VIP')).toBe(
      "🎖️ Staff spot: a reserved slot while they are staff, by the bot's records\n(Couldn't check the reserved list.)",
    );
    expect(field(buildPlayerEmbed({ ...profile, reserved: false, record: { ...record, vip } }), 'VIP')).toBe('None');
    expect(field(buildPlayerEmbed({ ...profile, record: { ...record, vipBlockedUntil: NOW + DAY } }), 'VIP')).toBe(
      `None\nStaff removed VIP: automatic VIP is off for them until ${t(NOW + DAY, 'f')}`,
    );
  });

  it('lists the newest staff actions first, with counts', () => {
    const log = [
      { action: 'warn' as const, at: NOW - 2 * DAY, by: '42', reason: 'Language' },
      { action: 'switchteam' as const, at: NOW - DAY, by: '43', detail: 'Valkyra to Kharr' },
      { action: 'unban' as const, at: NOW, by: 'bot', reason: 'The ban ran out' },
    ];

    expect(field(buildPlayerEmbed({ ...profile, record: { ...record, log } }), 'Staff history')).toBe(
      [
        '1 warning',
        `${t(NOW, 'd')} **Unban** by the bot: The ban ran out`,
        `${t(NOW - DAY, 'd')} **Team move** (Valkyra to Kharr) by <@43>`,
        `${t(NOW - 2 * DAY, 'd')} **Warning** by <@42>: Language`,
      ].join('\n'),
    );
  });

  it("shows today's team kills only once the bot has the kill feed, with whom, how and who killed them", () => {
    const BO = '76561198000000002';
    const CY = '76561198000000003';
    const base = { at: NOW - 600_000, map: 'Kavkazi', faction: 'Kharr', distance: 12.4, tags: [] };
    const none: PlayerGrief = {
      teamKills: 0,
      vehicleTeamKills: 0,
      crashTeamKills: 0,
      teamKilled: 0,
      suicides: 0,
      vehicleSuicides: 0,
      flags: [],
      victims: [],
      incidents: [],
    };
    const grief: PlayerGrief = {
      teamKills: 3,
      vehicleTeamKills: 1,
      crashTeamKills: 0,
      teamKilled: 1,
      suicides: 2,
      vehicleSuicides: 1,
      flags: ['teamKills', 'sameTeammate'],
      victims: [
        { steamId: BO, name: 'Bo_*', kills: 2 },
        { steamId: CY, name: 'Cy', kills: 1 },
      ],
      incidents: [
        { ...base, kind: 'team-kill', steamId: ID, name: 'Ash', victimSteamId: BO, victimName: 'Bo_*', cause: 'Id.Item.AK74M' },
        { ...base, kind: 'team-kill', steamId: CY, name: 'Cy', victimSteamId: ID, victimName: 'Ash', cause: 'Id.Item.AK74M', distance: null },
        { ...base, kind: 'vehicle-suicide', steamId: ID, name: 'Ash', cause: null, distance: null, map: '' },
      ],
    };
    const weapon = (cause: string) => (cause === 'Id.Item.AK74M' ? 'AK74' : cause);
    const ago = t(NOW - 600_000, 'R');

    const without = buildPlayerEmbed(profile);
    expect(field(without, 'Team kills · today (UTC)')).toBeUndefined();
    expect(without.footer?.text).toBe('Staff history only covers what staff did through the bot.');

    const quiet = buildPlayerEmbed({ ...profile, record: { ...record, grief: none } });
    expect(field(quiet, 'Team kills · today (UTC)')).toBe('No team kills or suicides today.');
    expect(quiet.footer?.text).toContain('sides from the last check, up to a minute old');

    expect(field(buildPlayerEmbed({ ...profile, record: { ...record, grief }, weapon }), 'Team kills · today (UTC)')).toBe(
      [
        '🚩 Flagged: team kills, same teammate',
        '**3 team kills** (1 with a vehicle) · killed by a teammate 1 time · 2 suicides (1 in a vehicle)',
        'Teammates killed: **Bo\\_\\*** ×2, **Cy**',
        `${ago} Killed teammate **Bo\\_\\*** with AK74 from 12 m on Bakurani`,
        `${ago} Killed by teammate **Cy** with AK74 on Bakurani`,
        `${ago} Killed themselves in a vehicle`,
      ].join('\n'),
    );
  });

  it('says how many of the team kills were with a vehicle and in a helicopter crash', () => {
    const grief: PlayerGrief = {
      teamKills: 5,
      vehicleTeamKills: 4,
      crashTeamKills: 3,
      teamKilled: 0,
      suicides: 1,
      vehicleSuicides: 1,
      flags: [],
      victims: [],
      incidents: [],
    };

    expect(field(buildPlayerEmbed({ ...profile, record: { ...record, grief } }), 'Team kills · today (UTC)')).toBe(
      '**5 team kills** (4 with a vehicle, 3 in a helicopter crash) · 1 suicide (1 in a vehicle)',
    );
  });

  it('names a teammate the kill feed sent no name for by their Steam ID', () => {
    const BO = '76561198000000002';
    const base = { at: NOW, map: '', faction: null, cause: null, distance: null, tags: [] };
    const grief: PlayerGrief = {
      teamKills: 1,
      vehicleTeamKills: 0,
      crashTeamKills: 0,
      teamKilled: 1,
      suicides: 0,
      vehicleSuicides: 0,
      flags: [],
      victims: [{ steamId: BO, name: BO, kills: 1 }],
      incidents: [
        { ...base, kind: 'team-kill', steamId: ID, name: 'Ash', victimSteamId: BO, victimName: '' },
        { ...base, kind: 'team-kill', steamId: BO, name: '', victimSteamId: ID, victimName: 'Ash' },
      ],
    };

    expect(field(buildPlayerEmbed({ ...profile, record: { ...record, grief } }), 'Team kills · today (UTC)')).toBe(
      [
        '**1 team kill** · killed by a teammate 1 time',
        `Teammates killed: **${BO}**`,
        `${t(NOW, 'R')} Killed teammate **${BO}**`,
        `${t(NOW, 'R')} Killed by teammate **${BO}**`,
      ].join('\n'),
    );
  });

  it("keeps today's team kills inside Discord's limit for a field, keeping the newest incidents", () => {
    const long = 'Id.Item.' + 'X'.repeat(400);
    const incidents = Array.from({ length: 5 }, (_, i) => ({
      at: NOW - (5 - i) * 60_000,
      kind: 'team-kill' as const,
      map: 'Kavkazi',
      steamId: ID,
      name: 'Ash',
      faction: 'Kharr',
      victimSteamId: '76561198000000002',
      victimName: `Victim${i}`,
      cause: long,
      distance: null,
      tags: [],
    }));
    const grief: PlayerGrief = {
      teamKills: 5,
      vehicleTeamKills: 0,
      crashTeamKills: 0,
      teamKilled: 0,
      suicides: 0,
      vehicleSuicides: 0,
      flags: ['teamKills'],
      victims: Array.from({ length: 7 }, (_, i) => ({ steamId: `7656119800000001${i}`, name: `Victim${i}`, kills: 1 })),
      incidents,
    };

    const value = field(buildPlayerEmbed({ ...profile, record: { ...record, grief } }), 'Team kills · today (UTC)') ?? '';

    expect(value.length).toBeLessThanOrEqual(1024);
    expect(value).toContain('**Victim4** and 2 more');
    expect(value).toContain('Killed teammate **Victim4**');
    expect(value).not.toContain('Killed teammate **Victim0**');
  });

  it('says when a ban was made or lifted outside the bot', () => {
    const log = [{ action: 'ban' as const, at: NOW, by: 'server', reason: 'Cheating', detail: 'By Admin' }];

    expect(field(buildPlayerEmbed({ ...profile, record: { ...record, log } }), 'Staff history')).toBe(
      ['1 ban', `${t(NOW, 'd')} **Ban** (By Admin) by someone outside the bot: Cheating`].join('\n'),
    );
  });
});

describe('buildModLogMessage', () => {
  const NOW = Date.UTC(2026, 8, 30, 12);
  const ID = '76561198000000001';

  it('posts who did what to whom and why, mentioning staff without pinging them, linked to the staff page', () => {
    const message = buildModLogMessage(
      ID,
      { action: 'ban', at: NOW, by: '42', byName: 'Paragon', name: 'Ash_*', reason: 'Team killing', detail: '7 days' },
      'https://gaminginit.com/',
    );

    expect(message).toEqual({
      embeds: [
        {
          title: '🔨 Ban · Ash\\_\\*',
          url: 'https://gaminginit.com/admin',
          description: `\`${ID}\` · [Steam profile](https://steamcommunity.com/profiles/${ID})\n**Reason:** Team killing`,
          color: 0xe74c3c,
          fields: [
            { name: 'By', value: '<@42>', inline: true },
            { name: 'Details', value: '7 days', inline: true },
          ],
          timestamp: new Date(NOW).toISOString(),
        },
      ],
      allowed_mentions: { parse: [], roles: [] },
    });
  });

  it('posts VIP added and removed with the reason staff gave', () => {
    const added = buildModLogMessage(ID, { action: 'vip-add', at: NOW, by: '42', name: 'Ash', reason: 'Paid: Patreon', detail: '30 days' }).embeds[0];
    const removed = buildModLogMessage(ID, { action: 'vip-remove', at: NOW, by: '42', name: 'Ash', detail: 'automatic VIP off for 7 days' }).embeds[0];

    expect(added).toMatchObject({
      title: '🎖️ VIP added · Ash',
      description: `\`${ID}\` · [Steam profile](https://steamcommunity.com/profiles/${ID})\n**Reason:** Paid: Patreon`,
      fields: [
        { name: 'By', value: '<@42>', inline: true },
        { name: 'Details', value: '30 days', inline: true },
      ],
    });
    expect(removed).toMatchObject({
      title: '🎖️ VIP removed · Ash',
      description: `\`${ID}\` · [Steam profile](https://steamcommunity.com/profiles/${ID})`,
      fields: [
        { name: 'By', value: '<@42>', inline: true },
        { name: 'Details', value: 'automatic VIP off for 7 days', inline: true },
      ],
    });
  });

  it('says when the bot did it, or when it was done outside the bot', () => {
    const by = (entry: Parameters<typeof buildModLogMessage>[1]) => buildModLogMessage(ID, entry).embeds[0]?.fields?.[0]?.value;

    expect(by({ action: 'unban', at: NOW, by: 'bot', name: 'Ash', reason: 'The ban ran out' })).toBe('the bot');
    expect(by({ action: 'ban', at: NOW, by: 'server', name: 'Ash' })).toBe('Outside the bot (in game, or in ServerSettings.ini)');
    expect(buildModLogMessage(ID, { action: 'kick', at: NOW, by: '42' }).embeds[0]?.title).toBe('👢 Kick · Unknown player');
  });

  it("keeps a long detail from the server inside Discord's limit for a field", () => {
    const message = buildModLogMessage(ID, { action: 'ban', at: NOW, by: 'server', detail: `By ${'_'.repeat(3000)}` });

    expect(message.embeds[0]?.fields?.[1]?.value.length).toBeLessThanOrEqual(1024);
  });
});

describe('buildGriefAlert', () => {
  const NOW = Date.UTC(2026, 8, 30, 12);
  const t = (at: number, style: string) => `<t:${at / 1000}:${style}>`;
  const ASH = '76561198000000001';
  const BO = '76561198000000002';

  it('says what the player did today and lists the latest incidents, without pinging anyone', () => {
    const message = buildGriefAlert(
      {
        steamId: ASH,
        name: 'Ash',
        teamKills: 3,
        crashTeamKills: 0,
        vehicleSuicides: 0,
        sameTeammate: { steamId: BO, name: 'Bo', kills: 2 },
        incidents: [
          {
            at: NOW,
            kind: 'team-kill',
            map: 'Europe',
            steamId: ASH,
            name: 'Ash',
            faction: 'Valkyra',
            victimSteamId: BO,
            victimName: 'Bo',
            cause: 'Id.Item.AK74M',
            distance: 12.6,
            tags: [],
          },
        ],
      },
      () => 'AK74',
      'https://gaminginit.com',
    );

    expect(message.allowed_mentions).toEqual({ parse: [], roles: [] });
    expect(message.embeds[0]).toMatchObject({
      title: '🚩 Possible griefing · Ash',
      url: 'https://gaminginit.com/admin',
      description: `\`${ASH}\` · [Steam profile](https://steamcommunity.com/profiles/${ASH})\nKilled teammate **Bo** 2 times today · 3 team kills today`,
      fields: [{ name: 'Latest', value: `${t(NOW, 'R')} Killed teammate **Bo** with AK74 from 13 m on Ozeti` }],
    });
  });

  it('says how many of the team kills were in a helicopter crash', () => {
    const message = buildGriefAlert(
      { steamId: ASH, name: 'Ash', teamKills: 7, crashTeamKills: 4, vehicleSuicides: 0, sameTeammate: null, incidents: [] },
      () => 'w',
    );

    expect(message.embeds[0]?.description).toBe(
      `\`${ASH}\` · [Steam profile](https://steamcommunity.com/profiles/${ASH})\n7 team kills today (4 in a helicopter crash)`,
    );
  });

  it("lists only the newest incidents that fit in Discord's limit for a field, when weapons and maps have long tags", () => {
    const incident = (at: number) => ({
      at,
      kind: 'vehicle-suicide' as const,
      map: `Map_${'x'.repeat(196)}`,
      steamId: ASH,
      name: 'Ash',
      faction: 'Valkyra',
      cause: 'Id.Item.Long',
      distance: null,
      tags: [],
    });
    const incidents = [1, 2, 3, 4, 5].map((n) => incident(NOW + n * 1000));

    const message = buildGriefAlert(
      { steamId: ASH, name: 'Ash', teamKills: 0, crashTeamKills: 0, vehicleSuicides: 6, sameTeammate: null, incidents },
      () => 'w'.repeat(200),
    );
    const value = message.embeds[0]?.fields?.[0]?.value ?? '';

    expect(value.length).toBeLessThanOrEqual(1024);
    expect(value.split('\n').length).toBeLessThan(5);
    expect(value.endsWith(`Map_${'x'.repeat(196)}`)).toBe(true);
    expect(value).toContain(t(NOW + 5000, 'R'));
  });

  it("shows the player's Steam account when it is risky, and nothing about it when it is not", () => {
    const DAY = 86_400_000;
    const incident = { at: NOW, kind: 'vehicle-suicide' as const, map: '', steamId: ASH, name: 'Ash', faction: null, cause: null, distance: null, tags: [] };
    const alert = { steamId: ASH, name: 'Ash', teamKills: 0, crashTeamKills: 0, vehicleSuicides: 2, sameTeammate: null, incidents: [incident] };
    const check: SteamCheck = {
      at: NOW - DAY,
      found: true,
      vacBans: 1,
      gameBans: 0,
      lastBanAt: NOW - 10 * DAY,
      communityBanned: false,
      tradeBan: 'none',
      public: true,
      setUp: true,
      createdAt: NOW - 9 * 365 * DAY,
    };
    const fields = (steam: SteamCheck | null) => buildGriefAlert(alert, () => 'w', undefined, steam).embeds[0]?.fields;

    expect(fields(check)).toEqual([
      { name: 'Latest', value: `${t(NOW, 'R')} Killed themselves in a vehicle` },
      {
        name: 'Steam account',
        value: `🚩 **High risk** · 4 points\n1 VAC ban, 10 days ago · Account made 9 years ago · Public profile\nChecked ${t(NOW - DAY, 'R')}`,
      },
    ]);
    expect(fields({ ...check, vacBans: 0, lastBanAt: null })?.map((f) => f.name)).toEqual(['Latest']);
    expect(fields(null)?.map((f) => f.name)).toEqual(['Latest']);
  });
});

describe('postWebhook', () => {
  const message = buildMessage('seeding', server, { lowPop: 20 });

  it('posts the message as JSON to the webhook', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    };

    await postWebhook('https://discord.com/api/webhooks/1/abc', message, fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://discord.com/api/webhooks/1/abc');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(message);
  });

  it('throws when Discord rejects the message', async () => {
    const fetchFn = async () => new Response('{"message":"Unknown Webhook"}', { status: 404 });

    await expect(postWebhook('https://discord.com/api/webhooks/1/abc', message, fetchFn)).rejects.toThrow(
      /404/,
    );
  });

  it('gives up on a request that stalls', async () => {
    const stalled = (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });

    await expect(postWebhook('https://discord.com/api/webhooks/1/abc', message, stalled, 10)).rejects.toThrow();
  });
});

describe('buildSteamAlerts', () => {
  const NOW = Date.UTC(2026, 9, 3, 20);
  const DAY = 86_400_000;
  const check = {
    at: NOW,
    found: true,
    vacBans: 0,
    gameBans: 0,
    lastBanAt: null,
    communityBanned: false,
    tradeBan: 'none' as const,
    public: true,
    setUp: false,
    createdAt: NOW - 5 * DAY,
    alerted: 4,
  };
  const alert = (i: number) => ({ steamId: `7656119800000${String(i).padStart(4, '0')}`, name: `P_${i}`, check });

  it('posts each player with their risk and what Steam says, linking the staff page, pinging nobody', () => {
    const [message] = buildSteamAlerts([alert(1)], NOW, 'https://gaminginit.com');
    const embed = message?.embeds[0];

    expect(embed?.title).toBe('🕵️ Risky Steam account · P\\_1');
    expect(embed?.url).toBe('https://gaminginit.com/admin');
    expect(embed?.description).toBe(
      '`76561198000000001` · [Steam profile](https://steamcommunity.com/profiles/76561198000000001)\n🚩 **High risk** · 4 points · in game now',
    );
    expect(embed?.fields).toEqual([
      { name: 'Steam says', value: `No VAC or game bans\nAccount made 5 days ago\nProfile never set up\nChecked <t:${NOW / 1000}:R>` },
    ]);
    expect(message?.allowed_mentions).toEqual({ parse: [], roles: [] });
  });

  it('puts up to 10 players in a message', () => {
    const messages = buildSteamAlerts(Array.from({ length: 12 }, (_, i) => alert(i)), NOW);

    expect(messages.map((m) => m.embeds.length)).toEqual([10, 2]);
    expect(messages[0]?.embeds[0]?.url).toBeUndefined();
    expect(buildSteamAlerts([], NOW)).toEqual([]);
  });
});
