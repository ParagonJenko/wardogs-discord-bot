// The operator's command line for adding communities and looking after them, through the bot's /admin API.
// Put BOT_URL (the Worker's URL) and ADMIN_TOKEN in .env, then: npm run tenant -- <command>
//
//   list                                     every community
//   show <id>                                one community: settings, which secrets are set, whether its server answers
//   add <id> <discord server id> [name...]   add a community; its admins then run /setup in their Discord server
//   update <id> '<json>'                     change one, e.g. '{"status":"suspended"}' or '{"limits":{"joinChecks":false}}'
//   secrets <id> < secrets.json              set secrets from a JSON file on stdin, so they stay out of shell history
//   settings <id> NAME=value NAME=           change settings; NAME= puts one back to its default
//   test <id>                                check the bot can reach the community's game server
//   delete <id> --confirm=<id>               delete a community and every record the bot has for it

const clean = (value: string | undefined): string => (value ?? '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();

const USAGE = 'Commands: list, show <id>, add <id> <discord server id> [name], update <id> <json>, secrets <id> < file.json, settings <id> NAME=value, test <id>, delete <id> --confirm=<id>';

const readStdin = async (): Promise<string> => {
  if (process.stdin.isTTY) throw new Error('Send the secrets as JSON on stdin: npm run tenant -- secrets <id> < secrets.json');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
};

const run = async (): Promise<string | null> => {
  const botUrl = clean(process.env['BOT_URL']).replace(/\/$/, '');
  const token = clean(process.env['ADMIN_TOKEN']);
  if (!botUrl || !token) return 'Set BOT_URL (the Worker URL) and ADMIN_TOKEN in .env.';

  const [command, id, ...rest] = process.argv.slice(2);
  const call = async (method: string, path: string, body?: unknown): Promise<string | null> => {
    const response = await fetch(`${botUrl}/admin/tenants${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    let shown = text;
    try {
      shown = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // Not JSON: shown as it came.
    }
    console.log(shown);
    return response.ok ? null : `The bot answered ${response.status}.`;
  };
  const path = `/${encodeURIComponent(id ?? '')}`;

  if (command === 'list') return call('GET', '');
  if (id === undefined) return USAGE;
  if (command === 'show') return call('GET', path);
  if (command === 'add') {
    const [guildId, ...name] = rest;
    if (guildId === undefined) return 'add needs the community id and its Discord server id.';
    return call('PUT', path, { guildId, ...(name.length > 0 ? { name: name.join(' ') } : {}) });
  }
  if (command === 'update') return call('PUT', path, rest.join(' '));
  if (command === 'secrets') return call('PUT', `${path}/secrets`, await readStdin());
  if (command === 'settings') {
    const changes = Object.fromEntries(
      rest.map((pair) => {
        const at = pair.indexOf('=');
        if (at < 1) throw new Error(`Write settings as NAME=value: ${pair}`);
        const value = pair.slice(at + 1);
        return [pair.slice(0, at), value === '' ? null : value];
      }),
    );
    return call('PATCH', `${path}/settings`, changes);
  }
  if (command === 'test') return call('POST', `${path}/test`);
  if (command === 'delete') {
    const confirm = rest.find((arg) => arg.startsWith('--confirm='))?.slice('--confirm='.length);
    if (confirm !== id) return `Deleting removes every record the bot has for "${id}". To go ahead: delete ${id} --confirm=${id}`;
    return call('DELETE', `${path}?confirm=${encodeURIComponent(confirm)}`);
  }
  return USAGE;
};

// Set the exit code rather than calling process.exit(): exiting straight after fetch crashes Node on Windows.
try {
  const problem = await run();
  if (problem !== null) {
    console.error(problem);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
