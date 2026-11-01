import { setTimeout as sleep } from 'node:timers/promises';
import { isHlsResponse, runHls } from './hls.js';
import { debug, describeError, errorDetail, isDebug, tracedFetch } from './log.js';
import { NULL_BURST, TsPacketizer } from './ts.js';

const DEFAULTS = {
  bufferBytes: 4 * 1024 * 1024,
  stallMs: 15_000,
  giveUpMs: 60_000,
  keepaliveMs: 1_000,
  idleGraceMs: 10_000,
  maxBackoffMs: 5_000,
  tickMs: 1_000,
  statsMs: 10_000,
};

// One upstream connection per channel, shared by every player watching it.
// The upstream is reconnected on drops/stalls while players stay connected.
export class Channel {
  clients = new Set();
  #backlog = [];
  #backlogBytes = 0;
  #packetizer = new TsPacketizer();
  #running = false;
  #attempt = null;
  #attemptStartedAt = 0;
  #lastDataAt = 0;
  #timer = null;
  #stopTimer = null;
  #bytesIn = 0;
  #statsAt = 0;

  constructor({ id, name, url, userAgent, log, onStop, ...opts }) {
    Object.assign(this, { id, name, url, userAgent, log, onStop });
    const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
    this.opts = { ...DEFAULTS, ...given };
  }

  addClient(res) {
    clearTimeout(this.#stopTimer);
    // Match Xtream servers: raw body until close. TV players often stall on chunked live TS.
    res.useChunkedEncodingByDefault = false;
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store', Connection: 'close' });
    if (this.#backlogBytes) res.write(Buffer.concat(this.#backlog));
    debug(`[${this.name}] sent ${this.#backlogBytes} buffered bytes to new player`);
    this.clients.add(res);
    res.on('close', () => this.#removeClient(res));
    this.log(`[${this.name}] player connected (${this.clients.size} watching)`);
    if (!this.#running) this.#start();
  }

  stop(reason) {
    if (!this.#running) return;
    this.#running = false;
    clearInterval(this.#timer);
    clearTimeout(this.#stopTimer);
    this.#attempt?.abort();
    for (const res of this.clients) res.end();
    this.clients.clear();
    this.#backlog = [];
    this.#backlogBytes = 0;
    this.log(`[${this.name}] stopped: ${reason}`);
    this.onStop?.();
  }

  #removeClient(res) {
    if (!this.clients.delete(res)) return;
    this.log(`[${this.name}] player disconnected (${this.clients.size} watching)`);
    if (this.clients.size === 0 && this.#running) {
      this.#stopTimer = setTimeout(() => this.stop('no players left'), this.opts.idleGraceMs);
    }
  }

  #start() {
    this.#running = true;
    this.#lastDataAt = Date.now();
    this.#timer = setInterval(() => this.#tick(), this.opts.tickMs);
    this.#run().catch((err) => this.stop(`unexpected error: ${err.message}`));
  }

  async #run() {
    let failures = 0;
    while (this.#running) {
      const attempt = new AbortController();
      this.#attempt = attempt;
      this.#attemptStartedAt = Date.now();
      this.#packetizer.reset();
      try {
        await this.#connect(attempt.signal);
        if (this.#running) this.log(`[${this.name}] upstream closed, reconnecting`);
      } catch (err) {
        if (!this.#running) return;
        if (!attempt.signal.aborted) this.log(`[${this.name}] upstream error: ${describeError(err)}, reconnecting`);
      }
      if (!this.#running) return;
      failures = Date.now() - this.#attemptStartedAt > 30_000 ? 0 : failures + 1;
      await sleep(Math.min(250 * 2 ** failures, this.opts.maxBackoffMs));
    }
  }

  async #connect(signal) {
    const res = await tracedFetch(this.url, { headers: { 'User-Agent': this.userAgent }, signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}${await errorDetail(res)}`);
    if (isHlsResponse(res)) {
      debug(`[${this.name}] upstream is HLS`);
      const text = await res.text();
      return runHls({ url: res.url, text, signal, userAgent: this.userAgent, onData: (c) => this.#push(c) });
    }
    for await (const chunk of res.body) this.#push(chunk);
  }

  #push(chunk) {
    this.#bytesIn += chunk.byteLength;
    const data = this.#packetizer.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    if (!data) return;
    this.#lastDataAt = Date.now();
    this.#backlog.push(data);
    this.#backlogBytes += data.length;
    while (this.#backlog.length > 1 && this.#backlogBytes - this.#backlog[0].length >= this.opts.bufferBytes) {
      this.#backlogBytes -= this.#backlog.shift().length;
    }
    this.#broadcast(data);
  }

  #broadcast(data) {
    for (const res of this.clients) {
      if (res.writableLength > this.opts.bufferBytes * 4) {
        this.log(`[${this.name}] player is not reading, dropping it`);
        res.destroy();
        continue;
      }
      res.write(data);
    }
  }

  #tick() {
    const now = Date.now();
    const quiet = now - this.#lastDataAt;
    if (quiet >= this.opts.giveUpMs) {
      this.stop(`no data for ${Math.round(quiet / 1000)}s`);
      return;
    }
    if (now - Math.max(this.#lastDataAt, this.#attemptStartedAt) >= this.opts.stallMs && !this.#attempt.signal.aborted) {
      this.log(`[${this.name}] upstream stalled, reconnecting`);
      this.#attempt.abort();
    }
    // Keep the player's socket busy while the upstream is reconnecting.
    if (quiet >= this.opts.keepaliveMs && this.#packetizer.isTs) this.#broadcast(NULL_BURST);

    if (isDebug() && now - this.#statsAt >= this.opts.statsMs) {
      const seconds = (now - (this.#statsAt || now)) / 1000 || 1;
      const format = this.#packetizer.passthrough ? 'not TS, passthrough' : this.#packetizer.isTs ? 'TS' : 'waiting for TS sync';
      debug(
        `[${this.name}] ${Math.round((this.#bytesIn * 8) / seconds / 1000)} kbit/s in, ` +
          `buffer ${Math.round(this.#backlogBytes / 1024)} KB, ${this.clients.size} players, ` +
          `last data ${Math.round(quiet / 1000)}s ago, ${format}`,
      );
      this.#bytesIn = 0;
      this.#statsAt = now;
    }
  }
}

export class ChannelManager {
  #channels = new Map();

  constructor(opts) {
    this.opts = opts;
  }

  attach(stream, userAgent, res) {
    let channel = this.#channels.get(stream.id);
    if (!channel) {
      // Providers often allow a single connection, so free idle ones before opening another.
      for (const other of this.#channels.values()) {
        if (other.clients.size === 0) other.stop('player switched channel');
      }
      channel = new Channel({
        ...this.opts,
        ...stream,
        userAgent,
        onStop: () => this.#channels.delete(stream.id),
      });
      this.#channels.set(stream.id, channel);
    }
    channel.addClient(res);
  }

  get active() {
    return [...this.#channels.values()];
  }

  stopAll() {
    for (const channel of this.#channels.values()) channel.stop('shutting down');
  }
}
