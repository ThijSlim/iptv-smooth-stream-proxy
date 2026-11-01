import http from 'node:http';
import { ChannelManager } from './channel.js';
import { PlaylistStore } from './playlist.js';

export const DEFAULT_USER_AGENT = 'VLC/3.0.20 LibVLC/3.0.20';
const STREAM_PATH = /^\/stream\/([0-9a-f]{16})(?:\.ts)?$/;

const defaultLog = (message) => console.log(`${new Date().toISOString()} ${message}`);

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function statusPage(channels) {
  const active = channels.active;
  return [
    'IPTV proxy is running.',
    'Playlist: /playlist.m3u',
    `Active channels: ${active.length}`,
    ...active.map((c) => `  ${c.name} (${c.clients.size} watching)`),
    '',
  ].join('\n');
}

export function createProxyServer({ playlistUrl, userAgent, bufferBytes, log = defaultLog, channel = {} }) {
  const playlist = new PlaylistStore({ url: playlistUrl, log });
  const channels = new ChannelManager({ log, bufferBytes, ...channel });
  const userAgentFor = (req) => userAgent || req.headers['user-agent'] || DEFAULT_USER_AGENT;

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      if (!req.headers.host) return send(res, 400, 'Missing Host header\n');

      if (pathname === '/playlist.m3u') {
        const text = await playlist.render(`http://${req.headers.host}`, userAgentFor(req));
        res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl; charset=utf-8' });
        return res.end(text);
      }

      const match = STREAM_PATH.exec(pathname);
      if (match) {
        const stream = await playlist.lookup(match[1], userAgentFor(req));
        if (!stream) return send(res, 404, 'Unknown stream\n');
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': 'video/mp2t' });
          return res.end();
        }
        return channels.attach(stream, userAgentFor(req), res);
      }

      if (pathname === '/') return send(res, 200, statusPage(channels));
      send(res, 404, 'Not found\n');
    } catch (err) {
      log(`${pathname} failed: ${err.message}`);
      if (res.headersSent) res.destroy();
      else send(res, 502, 'Upstream error\n');
    }
  });

  return {
    server,
    close() {
      channels.stopAll();
      server.close();
      server.closeAllConnections();
    },
  };
}
