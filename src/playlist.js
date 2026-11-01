import crypto from 'node:crypto';

// Movies and series need seeking (Range requests), so they bypass the proxy.
const VOD = /\.(mp4|mkv|avi|mov|m4v|webm|flv|wmv|mpg|mpeg)$|\/(movie|series)\//i;
const FORCE_RELOAD_AFTER_MS = 60_000;

export function isLiveUrl(line) {
  try {
    const url = new URL(line);
    return /^https?:$/.test(url.protocol) && !VOD.test(url.pathname);
  } catch {
    return false;
  }
}

export const streamId = (url) => crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);

export function rewritePlaylist(text, baseUrl) {
  const streams = new Map();
  let name = null;
  const lines = text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#EXTINF')) {
      name = trimmed.slice(trimmed.lastIndexOf(',') + 1).trim() || null;
      return line;
    }
    if (!trimmed || trimmed.startsWith('#')) return line;

    const title = name;
    name = null;
    if (!isLiveUrl(trimmed)) return line;
    const id = streamId(trimmed);
    streams.set(id, { id, url: trimmed, name: title ?? id });
    return `${baseUrl}/stream/${id}.ts`;
  });
  return { text: lines.join('\n'), streams };
}

export class PlaylistStore {
  #raw = null;
  #streams = new Map();
  #loadedAt = 0;
  #loading = null;

  constructor({ url, log, ttlMs = 10 * 60_000 }) {
    this.url = url;
    this.log = log;
    this.ttlMs = ttlMs;
  }

  async render(baseUrl, userAgent) {
    return rewritePlaylist(await this.#text(userAgent), baseUrl).text;
  }

  async lookup(id, userAgent) {
    if (!this.#streams.has(id) && Date.now() - this.#loadedAt > FORCE_RELOAD_AFTER_MS) {
      await this.#text(userAgent, true);
    }
    return this.#streams.get(id);
  }

  async #text(userAgent, force = false) {
    if (this.#raw && !force && Date.now() - this.#loadedAt < this.ttlMs) return this.#raw;
    this.#loading ??= this.#load(userAgent).finally(() => {
      this.#loading = null;
    });
    try {
      await this.#loading;
    } catch (err) {
      if (!this.#raw) throw err;
      this.log(`playlist refresh failed (${err.message}), using cached copy`);
    }
    return this.#raw;
  }

  async #load(userAgent) {
    const res = await fetch(this.url, {
      headers: { 'User-Agent': userAgent },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`playlist HTTP ${res.status}`);
    const text = await res.text();
    if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('provider did not return an M3U playlist');
    this.#raw = text;
    this.#loadedAt = Date.now();
    this.#streams = rewritePlaylist(text, '').streams;
    this.log(`playlist loaded: ${this.#streams.size} live channels`);
  }
}
