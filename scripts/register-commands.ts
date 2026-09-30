// Registers the bot's slash commands with Discord. Run once, and again whenever the commands change.
// Put DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN in .env (or the environment), then: npm run register
import { COMMANDS } from '../src/interactions.ts';

// Values pasted into .env or a Windows shell often keep their quotes or stray spaces.
const clean = (value: string | undefined): string => (value ?? '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();

const register = async (): Promise<string | null> => {
  const applicationId = clean(process.env['DISCORD_APPLICATION_ID']);
  const botToken = clean(process.env['DISCORD_BOT_TOKEN']);
  if (!applicationId || !botToken) {
    return 'Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN in .env (Discord Developer Portal → your app).';
  }

  const response = await fetch(`https://discord.com/api/v10/applications/${applicationId}/commands`, {
    method: 'PUT',
    headers: { Authorization: `Bot ${botToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(COMMANDS),
  });
  if (response.status === 401) {
    return 'Discord rejected DISCORD_BOT_TOKEN (401). Use the token from the Bot page → Reset Token, not the Public Key or Client Secret.';
  }
  if (!response.ok) {
    return `Discord refused the commands: ${response.status} ${await response.text()}`;
  }
  console.log(`Registered: ${COMMANDS.map((c) => `/${c.name}`).join(', ')}. They can take a minute to appear.`);
  return null;
};

// Set the exit code rather than calling process.exit(): exiting straight after fetch crashes Node on Windows.
const problem = await register();
if (problem !== null) {
  console.error(problem);
  process.exitCode = 1;
}
