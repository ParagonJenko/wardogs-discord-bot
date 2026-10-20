// The lines the bot says in game. Each time a message goes out, one is picked at random from its list, passing over the ones it used lately. Staff can
// replace any list on the staff page's Lines tab (see linespage.ts); a list they have not replaced uses the one here,
// so rewording one here and deploying reaches every list staff left alone. Keep them short, as the game shows a message
// on one line of up to 200 characters with the call to action the bot adds after it.
//
// Placeholders: {team} is the faction's name, {score} its points and {site} the website (SITE_URL, such as
// gaminginit.com). {needed} is how many more players the server needs to go live, such as "5 more players". {earned} is
// what a player earned in a match, such as "2nd on the scoreboard (23 kills) and best demolitions (8 kills)". In the
// private messages, {name} is the player's name in game, cut short at NAME_LONGEST (see messages.ts), and {rank} their best
// place on the website's leaderboard, such as "3rd for kills". The end-of-match lists below say what else each fills in.

// A private message to each player a couple of minutes after they join (see WELCOME_MESSAGE_MINUTES): the basic rules.
// The bot puts the Discord and the website after the line.
export const WELCOME = [
  'Welcome, {name}! Play fair: no cheats, exploits, team kills, griefing, racism or abuse. Admins have the final say.',
  'Welcome in, {name}! House rules: no cheats, exploits, TKs, griefing, racism or abuse. Listen to admins.',
  'Boots on the ground, {name}! No cheats, exploits, team kills, griefing, racism or abuse. Admins have the final say.',
];

// The welcome for a player on the website's leaderboard (the top 10 of any board over 30 days), in place of the one above.
// {rank} is their best place, such as "3rd for kills". The bot puts the Discord and the website after the line.
export const WELCOME_BACK = [
  'Welcome back, {name}! {rank} on the leaderboard. Defend it. No cheats, no TKs, listen to admins.',
  '{name} is back! {rank} on the leaderboard. Keep it clean: no cheats, no TKs, listen to admins.',
  "Welcome back, {name}. You're {rank} and everyone's gunning for your spot. No cheats, no TKs.",
];

// Every few minutes while the server seeds. The bot puts what seeding earns after the line. The ones that say why to
// play here mention the leaderboards and player pages, which need the website (SITE_URL) and the bot on Cloudflare.
export const SEEDING = [
  "Seeding! {needed} and we're live.",
  '{needed} to go live. Stick around and bring your squad.',
  "Quiet, isn't it? {needed} and it won't be.",
  '{needed} to go live. Every player counts.',
  "{needed} to go live. Green's got room, for once.",
  '{needed} to go live. Pick any team. Yes, even blue.',
  '{needed} to go live. Active admins keep it fair here.',
  '{needed} to go live. Cheaters and trolls get dealt with here.',
  '{needed} to go live. Real admins who actually show up.',
  '{needed} to go live. Kills, K/D, play time and seeding all have a leaderboard.',
  '{needed} to go live. The leaderboard covers 30 days, so anyone can top it.',
  '{needed} to go live. Every match is tracked: kills, deaths, wins.',
  '{needed} to go live. Your K/D, wins and play time are on your player page.',
  "{needed} to go live. Season 2 is on and the leaderboard's wide open.",
  '{needed} to go live. Season 1 in Review is out: who carried, who got roasted?',
  '{needed} to go live. Did your seeding make the Season 1 slides?',
];

// 10 minutes after the match goes live. These are the whole message, so each ends on one link to type: the website, a
// page on it, or the rules in the Discord through the website's short link ({site}/discord, see DISCORD_SHORT_LINK).
export const TEN_MINUTES = [
  "10 minutes in and nobody's rage quit yet. See where your K/D ranks: {site}",
  'Still alive? Impressive. Your K/D is on the leaderboard: {site}',
  'Enjoying the chaos, soldier? Rules are in our Discord: {site}/discord',
  'Your squad lead wants you to read the rules. They are in our Discord: {site}/discord',
  '10 minutes down. Bragging rights live on the leaderboard: {site}',
  '10 minutes in. Blue, park the spawn truck so people can spawn. Rules: {site}/discord',
  'Still spamming the green join button? We started 10 minutes ago. Stats: {site}',
  '10 minutes in. Cash is nice, the zone is nicer. Leaderboard: {site}',
  '10 minutes in. Play fair: the rules are in our Discord at {site}/discord',
  '10 minutes in. Watch the kill feed and streaks live: {site}/live',
  '10 minutes in. Who carried Season 1? Who got roasted? Find out: {site}/season',
  'Still alive? Your Season 1 in slides, roast included: {site}/season',
];

// In place of the welcome, at most once a week, for a regular (5 or more matches in 30 days) who has not linked their
// account on the website. {site} is the website. The bot puts the Discord after the line.
export const LINK_NUDGE = [
  "{name}, you're a regular! Link your account at {site}/account for a Discord role and VIP alerts.",
  'Welcome back, {name}! Link Steam and Discord at {site}/account: get a role and VIP alerts. Play fair.',
  'Good to see you, {name}. Link your account at {site}/account for a Discord role and VIP alerts.',
];

// A private message to each seeder still in game the moment the server goes live. {minutes} is how long they seeded,
// such as "25 minutes". The line is the whole message.
export const SEEDER_THANKS = [
  "We're live, {name}! Your {minutes} of seeding made it happen. o7",
  '{name}, you helped get us live with {minutes} of seeding. Legend.',
  'Live! Thanks for seeding, {name}. {minutes} well spent. o7',
];

// A private message to each of a match's best players the moment a team wins it (see matchend.ts): {earned} names their
// place on the scoreboard and their awards. These are the whole message, so they point at the website.
export const MATCH_END = [
  'GG {name}! {earned}. Full stats: {site}',
  'GG {name}! You got {earned}. See where you rank: {site}',
  'Nice match, {name}: {earned}. Your K/D and wins: {site}',
  'Bragging rights, {name}: {earned}. Proof at {site}',
];

// In place of the one above, to the match's MVP: the top of the scoreboard (most kills, then fewest deaths; players level
// share it). Their {earned} starts with their kills, such as "31 kills and best demolitions (8 kills)", not their place.
export const MVP = [
  'GG {name}, MVP of the match! {earned}. Full stats: {site}',
  'MVP: {name}, with {earned}. See where you rank: {site}',
  '{name} carried. MVP with {earned}. Your player page: {site}',
  'Top of the scoreboard, {name}! MVP with {earned}. Proof at {site}',
];

// For a player who earned nothing above, the first they have of these, at the end of the match (see matchend.ts). Each
// line is the whole message.
// A milestone: {milestone} is "your 100th match", "your 1,000th kill" or "100 hours played".
export const MILESTONE = [
  "{name}, that's {milestone} on our server! Thanks for playing. Stats: {site}",
  'Milestone unlocked, {name}: {milestone} here. Thanks for sticking with us. Stats: {site}',
  'Big one, {name}: {milestone} on our server. GG and thanks! Stats: {site}',
];

// Their most kills in a match lately (5 matches or more, 10 kills or more): {kills} is "42 kills".
export const PERSONAL_BEST = [
  'New personal best, {name}: {kills} in one match! Stats: {site}',
  "{name}, that's your best match lately: {kills}. See where you rank: {site}",
  'PB, {name}! {kills} this match. Your player page: {site}',
];

// Close to the leaderboard's top 10 for kills: {short} is how many more kills would put them in it, such as "3 kills".
export const NEARLY_TOP = [
  "{name}, you're {short} off the top 10 for kills. One more match? Leaderboard: {site}",
  'So close, {name}: {short} away from the top 10 for kills. Leaderboard: {site}',
  '{short} from the leaderboard, {name}. One more match? Top 10 for kills at {site}',
];

// The player who killed them most in the match, 4 times or more: {nemesis} is their name, {count} how many, such as
// "6 times".
export const NEMESIS = [
  '{nemesis} got you {count} this match, {name}. Payback next round?',
  '{name}, {nemesis} killed you {count} this match. Time for revenge?',
  "Your nemesis this match: {nemesis}, {count}. Next round, {name}, it's personal.",
  '{nemesis} has your number, {name}: {count} this match. Run it back?',
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
    'Lonestar leads on {score}! New season, new blue. Who knew?',
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
    'Manticore leads on {score}. New season, same green.',
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
    'Valkyra leads on {score}. A new season for the motherland, comrade.',
  ],
};

// Halfway, when the top teams are level. These replace "Halfway there!" too.
export const HALFWAY_LEVEL = [
  "Halfway there and it's neck and neck!",
  "Halfway there and nobody's ahead. Sweaty.",
  'Halfway there and dead level. Somebody do something.',
  "Halfway there and level. Nobody's on easy mode this match.",
  'Halfway there and level. Blue, this is your moment.',
  'Halfway there and level. Somebody give Season 2 a winner.',
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
    'Lonestar has {score}! Season 2 blue is built different.',
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
    'Manticore has {score}. Season 1 in Review called it. Season 2 agrees.',
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
    'Valkyra has {score}! Glory for the motherland, and a fine start to Season 2.',
  ],
};

// For a faction with no list above.
export const HALFWAY_OTHER = ['{team} leads on {score}!'];
export const NEARLY_OTHER = ['{team} has {score}! Nearly over.'];

// Every list, as the bot says them: these, or the ones staff put in their place.
export type Lines = {
  welcome: string[];
  welcomeBack: string[];
  linkNudge: string[];
  seederThanks: string[];
  seeding: string[];
  tenMinutes: string[];
  // By faction (see factionKey).
  halfway: Record<string, string[]>;
  halfwayLevel: string[];
  halfwayOther: string[];
  nearly: Record<string, string[]>;
  nearlyOther: string[];
  matchEnd: string[];
  mvp: string[];
  milestone: string[];
  personalBest: string[];
  nearlyTop: string[];
  nemesis: string[];
};

export const DEFAULT_LINES: Lines = {
  welcome: WELCOME,
  welcomeBack: WELCOME_BACK,
  linkNudge: LINK_NUDGE,
  seederThanks: SEEDER_THANKS,
  seeding: SEEDING,
  tenMinutes: TEN_MINUTES,
  halfway: HALFWAY,
  halfwayLevel: HALFWAY_LEVEL,
  halfwayOther: HALFWAY_OTHER,
  nearly: NEARLY,
  nearlyOther: NEARLY_OTHER,
  matchEnd: MATCH_END,
  mvp: MVP,
  milestone: MILESTONE,
  personalBest: PERSONAL_BEST,
  nearlyTop: NEARLY_TOP,
  nemesis: NEMESIS,
};
