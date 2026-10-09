// The lines the bot says in game. Each time a message goes out, one is picked at random from its list. Staff can
// replace any list on the staff page's Lines tab (see linespage.ts); a list they have not replaced uses the one here,
// so rewording one here and deploying reaches every list staff left alone. Keep them short, as the game shows a message
// on one line of up to 200 characters with the call to action the bot adds after it.
//
// Placeholders: {team} is the faction's name, {score} its points and {site} the website (SITE_URL, such as
// gaminginit.com). {needed} is how many more players the server needs to go live, such as "5 more players".

// A private message to each player a couple of minutes after they join (see WELCOME_MESSAGE_MINUTES): the basic rules.
// The bot puts the Discord and the website after the line.
export const WELCOME = [
  'Welcome! Rules: no cheating or exploits, no team killing or griefing, no racism or abuse, and listen to admins. Full rules on our Discord.',
];

// Every few minutes while the server seeds. The bot puts what seeding earns after the line. The ones that say why to
// play here mention the leaderboards and player pages, which need the website (SITE_URL) and the bot on Cloudflare.
export const SEEDING = [
  "We're seeding! {needed} and we go live.",
  'Seeding now: {needed} to go live. Stick around and bring a friend.',
  "Quiet, isn't it? {needed} and it won't be.",
  '{needed} until we go live. Every player counts while we seed.',
  'Seeding in progress: {needed} to go live. Get your squad on.',
  "Seeding now: {needed} to go live. Green's got room, for once.",
  '{needed} to go live. Pick any team. Yes, even blue.',
  'Active admins keep it fair here. {needed} to go live.',
  'Cheaters and trolls get dealt with here. {needed} to go live.',
  'Real admins who actually show up. {needed} and we go live.',
  'Kills, K/D, play time and seeding all have a leaderboard here. {needed} to go live.',
  'The leaderboard covers the last 30 days, so anyone can top it. {needed} to go live.',
  'Every match you play is tracked: kills, deaths, wins. {needed} to go live.',
  '{needed} to go live. Your K/D, wins and play time are all on your player page.',
  'We track your stats, match by match. {needed} and we go live.',
  'Active admins, leaderboards and full stats. {needed} to go live.',
  'Season in Review: who carried, who fed and who got roasted. {needed} to go live.',
  'Your season in slides, roast and all, in the Season in Review. {needed} to go live.',
  'The Season in Review counts your seeding too. {needed} to go live.',
];

// 10 minutes after the match goes live. These are the whole message, so they point at the rules and the site.
export const TEN_MINUTES = [
  '10 minutes in and nobody has rage quit yet. Rules are in our Discord, leaderboard at {site}',
  'Still alive? Impressive. Rules are in our Discord, and your K/D is on the leaderboard at {site}',
  'Enjoying the chaos? Read the rules in our Discord, soldier. Leaderboard at {site}',
  'Your squad lead wants you to read the rules. They are in our Discord at {site}',
  '10 minutes down. Rules in our Discord, bragging rights on the leaderboard at {site}',
  '10 minutes in. Blue, park the spawn truck so people can spawn. Rules in our Discord, leaderboard at {site}',
  'Still spamming the green button? We started 10 minutes ago. Rules in our Discord, leaderboard at {site}',
  '10 minutes in. Cash is nice, the zone is nicer. Rules in our Discord, leaderboard at {site}',
  '10 minutes in. Who carried, who fed, who got roasted? Season in Review at {site}/season, rules in our Discord',
  'Still alive? Your whole season in slides, roast included, at {site}/season. Rules in our Discord',
  '10 minutes in. Rules in our Discord, and your season gets roasted at {site}/season',
];

// The faction lines play on the community's running jokes: Lonestar (blue) is the default pick, full of new players,
// spawning in the south between the other two in bright kit, and losing; Manticore (green) is where the sweats queue
// to get in, and wins most; Valkyra (red) is level with green, pushes hard and farms cash.

// A team reaches half the winning score. The bot puts "Halfway there!" before the line, and the seeding or Discord
// call to action after it.
export const HALFWAY: Record<string, string[]> = {
  lonestar: [
    'Lonestar leads on {score}! Screenshot it, this never happens.',
    'Lonestar leads on {score}! The default pick is cooking. Yeehaw.',
    "Lonestar leads on {score}! Somebody check the server isn't bugged.",
    "Lonestar leads on {score}! Everything's bigger in Texas, even the score.",
    'Lonestar leads on {score}! Nightmare mode, and blue is winning it.',
    'Lonestar leads on {score}! Somebody finally parked the spawn truck.',
    'Lonestar leads on {score}! Two fronts, bright blue kit, still in front.',
    'Lonestar leads on {score}! Reddit wrote blue off. Reddit was wrong.',
    'Lonestar leads on {score}! Saving this for the Season in Review.',
  ],
  manticore: [
    'Manticore leads on {score}. Green winning? Shocking. Truly.',
    'Manticore leads on {score}. The shadow army doing shadow army things.',
    'Manticore leads on {score}. Green is winning. Water is also wet.',
    "Manticore leads on {score}. Nobody saw them coming. That's the point.",
    'Manticore leads on {score}. Worth all that spamming of the join button.',
    'Manticore leads on {score}. Easy mode, played as intended.',
    'Manticore leads on {score}. Blends into every bush, beats every team.',
    'Manticore leads on {score}. Even the devs say green wins most of the time.',
    'Manticore leads on {score}. The Season in Review saw this coming.',
  ],
  valkyra: [
    'Valkyra leads on {score}. Not my points, OUR points, comrade.',
    'Valkyra leads on {score}. Restoring greatness, one point at a time.',
    'Valkyra leads on {score}. The motherland is pleased. For now.',
    'Valkyra leads on {score}. Red is looking very red today.',
    "Valkyra leads on {score}. Didn't get green? Red's doing just fine, comrade.",
    'Valkyra leads on {score}. Normal mode, abnormal results.',
    'Valkyra leads on {score}. Somebody stopped farming cash and took the zone.',
    'Valkyra leads on {score}. Dark armour: hard to spot, harder to stop.',
    'Valkyra leads on {score}. The Season in Review will remember this, comrade.',
  ],
};

// Halfway, when the top teams are level. These replace "Halfway there!" too.
export const HALFWAY_LEVEL = [
  "Halfway there and it's neck and neck!",
  "Halfway there and nobody's ahead. Sweaty.",
  'Halfway there and dead level. Somebody do something.',
  "Halfway there and level. Nobody's on easy mode this match.",
  'Halfway there and level. Blue, this is your moment.',
  'Halfway there and level. Somebody give the Season in Review a winner.',
];

// The first team to reach 90% of the winning score. The bot puts the leaderboard call to action after the line.
export const NEARLY: Record<string, string[]> = {
  lonestar: [
    'Lonestar has {score}! The default pick is about to win. Clip it.',
    'Lonestar has {score}! Nobody wanted blue, and look at them now. Yeehaw.',
    'Lonestar has {score}! Historians will study this match.',
    "Lonestar has {score}! Saddle up, it's nearly over.",
    'Lonestar has {score}! Nightmare mode, nearly beaten. Somebody tell Reddit.',
    'Lonestar has {score}! The devs said blue gets destroyed. Not this match.',
    'Lonestar has {score}! Fighting from the south on two fronts, and nearly there.',
    'Lonestar has {score}! Bright blue and nearly winning. Who needs camo?',
    'Lonestar has {score}! This is going straight in the Season in Review.',
  ],
  manticore: [
    'Manticore has {score}. Green about to win again. Groundbreaking.',
    'Manticore has {score}. The shadow army is about to do it again.',
    'Manticore has {score}. The scorpion tail is about to sting.',
    'Manticore has {score}. Green diff incoming.',
    'Manticore has {score}. Easy mode nearly complete.',
    'Manticore has {score}. Towers taken, FOBs up, sweat everywhere.',
    'Manticore has {score}. Can somebody else have a go on green next match?',
    'Manticore has {score}. The green queue was worth it, apparently.',
    'Manticore has {score}. The Season in Review already wrote this bit.',
  ],
  valkyra: [
    'Valkyra has {score}! Victory for the motherland is in sight, comrades.',
    'Valkyra has {score}! Greatness nearly restored.',
    'Valkyra has {score}! Almost there. Stay in formation, comrades.',
    'Valkyra has {score}! Start rehearsing the victory parade.',
    'Valkyra has {score}! Green who? Red is about to take it.',
    'Valkyra has {score}! Fairly even with green, said the devs. Red disagrees.',
    'Valkyra has {score}! Less cash farming, more capping. Nearly there, comrades.',
    'Valkyra has {score}! Pushing deep and, for once, playing the objective.',
    'Valkyra has {score}! Glory for the motherland, and a slide in the Season in Review.',
  ],
};

// For a faction with no list above.
export const HALFWAY_OTHER = ['{team} leads on {score}!'];
export const NEARLY_OTHER = ['{team} has {score} points!'];

// Every list, as the bot says them: these, or the ones staff put in their place.
export type Lines = {
  welcome: string[];
  seeding: string[];
  tenMinutes: string[];
  // By faction (see factionKey).
  halfway: Record<string, string[]>;
  halfwayLevel: string[];
  halfwayOther: string[];
  nearly: Record<string, string[]>;
  nearlyOther: string[];
};

export const DEFAULT_LINES: Lines = {
  welcome: WELCOME,
  seeding: SEEDING,
  tenMinutes: TEN_MINUTES,
  halfway: HALFWAY,
  halfwayLevel: HALFWAY_LEVEL,
  halfwayOther: HALFWAY_OTHER,
  nearly: NEARLY,
  nearlyOther: NEARLY_OTHER,
};
