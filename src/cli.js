#!/usr/bin/env node
import os from 'node:os';
import { parseArgs } from 'node:util';
import { createProxyServer } from './server.js';

const HELP = `Usage: iptv-proxy [options]

Provider (use a playlist URL, or Xtream Codes login):
  --playlist <url>      M3U playlist URL                 env IPTV_PLAYLIST
  --xtream <url>        Xtream server, e.g. http://host:8080   env IPTV_XTREAM
  --username <name>     Xtream username                  env IPTV_USERNAME
  --password <pass>     Xtream password                  env IPTV_PASSWORD

Options:
  --port <n>            Port to listen on (default 34400)        env PORT
  --buffer-mb <n>       Buffer per channel in MB (default 4)     env BUFFER_MB
  --user-agent <ua>     User-Agent sent to the provider          env IPTV_USER_AGENT
                        (default: the player's own User-Agent)
  -h, --help            Show this help

Prefer environment variables for credentials; command-line arguments are visible to other users via ps.
`;

function fail(message) {
  console.error(`${message}\n\n${HELP}`);
  process.exit(1);
}

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      playlist: { type: 'string' },
      xtream: { type: 'string' },
      username: { type: 'string' },
      password: { type: 'string' },
      port: { type: 'string' },
      'buffer-mb': { type: 'string' },
      'user-agent': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (err) {
  fail(err.message);
}

if (args.help) {
  console.log(HELP);
  process.exit(0);
}

const option = (name, envName) => args[name] ?? process.env[envName];

function resolvePlaylistUrl() {
  const direct = option('playlist', 'IPTV_PLAYLIST');
  if (direct) return direct;

  const server = option('xtream', 'IPTV_XTREAM');
  const username = option('username', 'IPTV_USERNAME');
  const password = option('password', 'IPTV_PASSWORD');
  if (!server) return null;
  if (!username || !password) fail('Xtream login needs --username and --password.');

  const url = new URL('get.php', server.endsWith('/') ? server : `${server}/`);
  url.search = new URLSearchParams({ username, password, type: 'm3u_plus', output: 'ts' }).toString();
  return url.href;
}

const playlistUrl = resolvePlaylistUrl();
if (!playlistUrl) fail('No provider configured.');
try {
  if (!/^https?:$/.test(new URL(playlistUrl).protocol)) throw new Error();
} catch {
  fail('The playlist URL must start with http:// or https://');
}

const port = Number(option('port', 'PORT') ?? 34400);
const bufferMb = Number(option('buffer-mb', 'BUFFER_MB') ?? 4);
if (!Number.isInteger(port) || port < 1 || port > 65535) fail('Invalid --port.');
if (!(bufferMb > 0 && bufferMb <= 256)) fail('--buffer-mb must be between 0 and 256.');

const proxy = createProxyServer({
  playlistUrl,
  userAgent: option('user-agent', 'IPTV_USER_AGENT'),
  bufferBytes: Math.round(bufferMb * 1024 * 1024),
});

proxy.server.on('error', (err) => {
  console.error(`Cannot start server: ${err.message}`);
  process.exit(1);
});

proxy.server.listen(port, '0.0.0.0', () => {
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
  console.log(`IPTV proxy listening on port ${port}.`);
  console.log('Use this playlist URL in IBO Player:');
  for (const address of addresses.length ? addresses : ['localhost']) {
    console.log(`  http://${address}:${port}/playlist.m3u`);
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    proxy.close();
    process.exit(0);
  });
}
