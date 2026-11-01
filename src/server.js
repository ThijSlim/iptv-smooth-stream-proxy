import http from 'node:http';
import { ChannelManager } from './channel.js';
import { debug, describeError, log as defaultLog, redact } from './log.js';
import { PlaylistStore } from './playlist.js';
import { XtreamApi } from './xtream.js';

export const DEFAULT_USER_AGENT = 'VLC/3.0.20 LibVLC/3.0.20';
const STREAM_PATH = /^\/stream\/([0-9a-f]{16})(?:\.ts)?$/;

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

export function createProxyServer({ playlistUrl, xtream, userAgent, bufferBytes, log = defaultLog, channel = {} }) {
  const playlist = new PlaylistStore({ url: playlistUrl, log });
  const channels = new ChannelManager({ log, bufferBytes, ...channel });
  const xtreamApi = xtream ? new XtreamApi({ ...xtream, channels, log }) : null;
  const userAgentFor = (req) => userAgent || req.headers['user-agent'] || DEFAULT_USER_AGENT;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    const started = Date.now();
    const bytesBefore = req.socket.bytesWritten;
    const client = `${req.socket.remoteAddress} ua=${JSON.stringify(req.headers['user-agent'] ?? '')}`;
    debug(`player => ${req.method} ${req.url} from ${client}`);
    debug(`player    headers ${JSON.stringify(req.headers)}`);
    res.on('close', () => {
      const aborted = res.writableFinished ? '' : ', closed by player';
      debug(
        `player <= ${res.statusCode} ${req.method} ${pathname} ${Date.now() - started}ms, ` +
          `${req.socket.bytesWritten - bytesBefore} bytes${aborted}`,
      );
    });

    try {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (!req.headers.host) return send(res, 400, 'Missing Host header\n');

      if (pathname === '/playlist.m3u' || pathname.endsWith('get.php')) {
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

      if (xtreamApi && (await xtreamApi.handle(req, res, url, userAgentFor(req)))) return;

      if (pathname === '/') return send(res, 200, statusPage(channels));
      log(`NOT HANDLED: ${req.method} ${redact(req.url)} from ${client}`);
      send(res, 404, 'Not found\n');
    } catch (err) {
      log(`${req.method} ${redact(req.url)} failed: ${describeError(err)}`);
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
