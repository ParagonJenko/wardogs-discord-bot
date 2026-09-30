// Registers the bot's slash commands with Discord. Run once, and again whenever the commands change:
//   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... npm run register
import { COMMANDS } from '../src/interactions.ts';

const applicationId = process.env['DISCORD_APPLICATION_ID'];
const botToken = process.env['DISCORD_BOT_TOKEN'];
if (!applicationId || !botToken) {
  console.error('Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN (Discord Developer Portal → your app).');
  process.exit(1);
}

const response = await fetch(`https://discord.com/api/v10/applications/${applicationId}/commands`, {
  method: 'PUT',
  headers: { Authorization: `Bot ${botToken}`, 'content-type': 'application/json' },
  body: JSON.stringify(COMMANDS),
});
if (!response.ok) {
  console.error(`Discord refused the commands: ${response.status} ${await response.text()}`);
  process.exit(1);
}
console.log(`Registered: ${COMMANDS.map((c) => `/${c.name}`).join(', ')}. They can take a minute to appear.`);
