import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { debug, errorDetail, tracedFetch } from './log.js';

// Unanchored so a host entered as "http://ip:port/playlist.m3u" in the player still works.
const API_PATH = /(player_api|xmltv|panel_api)\.php$/;
const MEDIA_PATH = /(live|movie|series|timeshift)\/[^/]+\/[^/]+\/(.+)$/;
const SHORT_LIVE_PATH = /^\/[^/]+\/[^/]+\/(\d+(?:\.\w+)?)$/;
const BUFFERED_LIVE_FILE = /^(\d+)(?:\.ts)?$/;

export function xtreamFromPlaylistUrl(playlistUrl) {
  const url = new URL(playlistUrl);
  const username = url.searchParams.get('username');
  const password = url.searchParams.get('password');
  if (!url.pathname.endsWith('get.php') || !username || !password) return null;
  const base = new URL(url.pathname.replace(/get\.php$/, ''), url).href.replace(/\/$/, '');
  return { base, username, password };
}

function splitHost(host) {
  const colon = host.lastIndexOf(':');
  return colon > 0 ? [host.slice(0, colon), host.slice(colon + 1)] : [host, '80'];
}

// Emulates an Xtream Codes server: API calls go to the provider with the real login,
// live streams go through the buffered channels, VOD is redirected to the provider.
export class XtreamApi {
  #names = new Map();
  #warnedHls = false;

  constructor({ base, username, password, channels, log }) {
    Object.assign(this, { base, username, password, channels, log });
  }

  async handle(req, res, url, userAgent) {
    const api = API_PATH.exec(url.pathname);
    if (api) {
      await this.#api(api[1], req, res, url.searchParams, userAgent);
      return true;
    }
    const media = MEDIA_PATH.exec(url.pathname);
    if (media) {
      this.#media(media[1], media[2], req, res, userAgent);
      return true;
    }
    const short = SHORT_LIVE_PATH.exec(url.pathname);
    if (short) {
      this.#media('live', short[1], req, res, userAgent);
      return true;
    }
    return false;
  }

  #providerUrl(kind, file) {
    const user = encodeURIComponent(this.username);
    const pass = encodeURIComponent(this.password);
    return `${this.base}/${kind}/${user}/${pass}/${file}`;
  }

  async #api(name, req, res, query, userAgent) {
    const target = new URL(`${this.base}/${name}.php`);
    for (const [key, value] of query) target.searchParams.append(key, value);
    target.searchParams.set('username', this.username);
    target.searchParams.set('password', this.password);

    const upstream = await tracedFetch(target, {
      headers: { 'User-Agent': userAgent },
      signal: AbortSignal.timeout(60_000),
    });
    const action = query.get('action');
    const label = `${name}.php${action ? ` action=${action}` : ''}`;
    if (!upstream.ok) {
      this.log(`${label}: provider returned HTTP ${upstream.status}${await errorDetail(upstream)}`);
      res.writeHead(upstream.status, { 'Content-Type': 'text/plain' });
      return res.end();
    }

    const contentType = upstream.headers.get('content-type') ?? 'application/json';
    if (name === 'player_api' && (!action || action === 'get_live_streams')) {
      let body = await upstream.text();
      try {
        const json = JSON.parse(body);
        if (action) this.#rememberNames(json);
        else this.#rewriteLogin(json, req.headers.host);
        body = JSON.stringify(json);
      } catch {
        this.log(`${label}: provider did not return JSON`);
        debug(`${label} body starts with ${JSON.stringify(body.slice(0, 200))}`);
      }
      res.writeHead(200, { 'Content-Type': contentType });
      return res.end(body);
    }

    res.writeHead(200, { 'Content-Type': contentType });
    if (!upstream.body) return res.end();
    await pipeline(Readable.fromWeb(upstream.body), res);
  }

  #rewriteLogin(json, host) {
    const user = json?.user_info;
    if (user) {
      const expires = user.exp_date ? new Date(Number(user.exp_date) * 1000).toISOString().slice(0, 10) : 'never';
      this.log(
        `Xtream login: auth=${user.auth} status=${user.status} ` +
          `connections ${user.active_cons}/${user.max_connections} expires ${expires}`,
      );
    }
    if (json?.server_info) {
      const [hostname, port] = splitHost(host);
      Object.assign(json.server_info, { url: hostname, port, https_port: port, server_protocol: 'http' });
    }
  }

  #rememberNames(json) {
    if (!Array.isArray(json)) return;
    for (const stream of json) this.#names.set(String(stream.stream_id), stream.name);
    debug(`remembered ${json.length} live channel names`);
  }

  #media(kind, file, req, res, userAgent) {
    const live = kind === 'live' ? BUFFERED_LIVE_FILE.exec(file) : null;
    if (!live) {
      if (kind === 'live' && !this.#warnedHls) {
        this.#warnedHls = true;
        this.log(`player asked for live/${file}; only .ts streams are buffered. Set stream format to TS (MPEGTS) in the player.`);
      }
      debug(`redirecting ${kind}/${file} to provider`);
      res.writeHead(302, { Location: this.#providerUrl(kind, file) });
      return res.end();
    }

    const id = live[1];
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      return res.end();
    }
    const stream = { id: `xtream-${id}`, name: this.#names.get(id) ?? `stream ${id}`, url: this.#providerUrl('live', `${id}.ts`) };
    this.channels.attach(stream, userAgent, res);
  }
}
