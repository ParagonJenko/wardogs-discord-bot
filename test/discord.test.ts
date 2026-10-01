import { describe, expect, it } from 'vitest';
import { banReason } from '../src/moderation.ts';
import {
  buildLastMatchEmbed,
  buildPlayerEmbed,
  buildMatchSummary,
  buildMessage,
  buildPlayersEmbed,
  buildRotationEmbed,
  buildSeedersEmbed,
  buildLiveStatus,
  buildStatusEmbed,
  buildVipMessage,
  postWebhook,
  type DiscordMessage,
} from '../src/discord.ts';

const server = { name: 'UK Wardogs #1', players: 7, maxPlayers: 64 };
const vip = { seedDays: 3, seedMinutes: 10, windowDays: 7, lengthDays: 7 };
const offer = 'Seed on 3 days in a week and get a reserved slot for a week.';
const rule = "A seed counts when you're on for more than 10 min and the server goes live.";

const embedOf = (message: DiscordMessage) => message.embeds[0];
const field = (message: DiscordMessage, name: string) => embedOf(message)?.fields?.find((f) => f.name === name)?.value;

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
  const record = { name: 'Ash', totals: null, vip: null, vipBlockedUntil: null, log: [], ban: null };
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

  it('shows VIP from the bot, and when staff blocked automatic VIP', () => {
    const vip = { name: 'Ash', grantedAt: NOW, expiresAt: NOW + 7 * DAY };

    expect(field(buildPlayerEmbed({ ...profile, reserved: true, record: { ...record, vip } }), 'VIP')).toBe(
      `🎖️ Reserved slot until ${t(NOW + 7 * DAY, 'f')}`,
    );
    expect(field(buildPlayerEmbed({ ...profile, reserved: null, record: { ...record, vip } }), 'VIP')).toBe(
      `🎖️ Reserved slot until ${t(NOW + 7 * DAY, 'f')}, by the bot's records\n(Couldn't check the reserved list.)`,
    );
    expect(field(buildPlayerEmbed({ ...profile, reserved: null }), 'VIP')).toBe("Couldn't read the reserved list");
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
