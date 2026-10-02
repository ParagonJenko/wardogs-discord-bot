// The lines the bot says in game. Add, remove or reword any of them: each time a message goes out, one is picked at
// random from its list. Keep them short, as the game shows a message on one line of up to 200 characters with the
// call to action the bot adds after it.
//
// Placeholders: {team} is the faction's name, {score} its points and {site} the website (SITE_URL, such as
// gaminginit.com). {needed} is how many more players the server needs to go live, such as "5 more players".

// Every few minutes while the server seeds. The bot puts what seeding earns after the line.
export const SEEDING = [
  "We're seeding! {needed} and we go live.",
  'Seeding now: {needed} to go live. Stick around and bring a friend.',
  "Quiet, isn't it? {needed} and it won't be.",
  '{needed} until we go live. Every player counts while we seed.',
  'Seeding in progress: {needed} to go live. Get your squad on.',
];

// 10 minutes after the match goes live. These are the whole message, so they point at the rules and the site.
export const TEN_MINUTES = [
  '10 minutes in and nobody has rage quit yet. Rules are in our Discord, leaderboard at {site}',
  'Still alive? Impressive. Rules are in our Discord, and your K/D is on the leaderboard at {site}',
  'Enjoying the chaos? Read the rules in our Discord, soldier. Leaderboard at {site}',
  'Your squad lead wants you to read the rules. They are in our Discord at {site}',
  '10 minutes down. Rules in our Discord, bragging rights on the leaderboard at {site}',
];

// A team reaches half the winning score. The bot puts "Halfway there!" before the line, and the seeding or Discord
// call to action after it.
export const HALFWAY: Record<string, string[]> = {
  lonestar: [
    'Lonestar leads on {score}! Screenshot it, this never happens.',
    'Lonestar leads on {score}! The default pick is cooking. Yeehaw.',
    "Lonestar leads on {score}! Somebody check the server isn't bugged.",
    "Lonestar leads on {score}! Everything's bigger in Texas, even the score.",
  ],
  manticore: [
    'Manticore leads on {score}. Green winning? Shocking. Truly.',
    'Manticore leads on {score}. The shadow army doing shadow army things.',
    'Manticore leads on {score}. Green is winning. Water is also wet.',
    "Manticore leads on {score}. Nobody saw them coming. That's the point.",
  ],
  valkyra: [
    'Valkyra leads on {score}. Not my points, OUR points, comrade.',
    'Valkyra leads on {score}. Restoring greatness, one point at a time.',
    'Valkyra leads on {score}. The motherland is pleased. For now.',
    'Valkyra leads on {score}. Red is looking very red today.',
  ],
};

// Halfway, when the top teams are level. These replace "Halfway there!" too.
export const HALFWAY_LEVEL = [
  "Halfway there and it's neck and neck!",
  "Halfway there and nobody's ahead. Sweaty.",
  'Halfway there and dead level. Somebody do something.',
];

// The first team to reach 90% of the winning score. The bot puts the leaderboard call to action after the line.
export const NEARLY: Record<string, string[]> = {
  lonestar: [
    'Lonestar has {score}! The default pick is about to win. Clip it.',
    'Lonestar has {score}! Nobody wanted blue, and look at them now. Yeehaw.',
    'Lonestar has {score}! Historians will study this match.',
    "Lonestar has {score}! Saddle up, it's nearly over.",
  ],
  manticore: [
    'Manticore has {score}. Green about to win again. Groundbreaking.',
    'Manticore has {score}. The shadow army is about to do it again.',
    'Manticore has {score}. The scorpion tail is about to sting.',
    'Manticore has {score}. Green diff incoming.',
  ],
  valkyra: [
    'Valkyra has {score}! Victory for the motherland is in sight, comrades.',
    'Valkyra has {score}! Greatness nearly restored.',
    'Valkyra has {score}! Almost there. Stay in formation, comrades.',
    'Valkyra has {score}! Start rehearsing the victory parade.',
  ],
};

// For a faction with no list above.
export const HALFWAY_OTHER = ['{team} leads on {score}!'];
export const NEARLY_OTHER = ['{team} has {score} points!'];
