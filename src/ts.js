const PACKET = 188;
const SYNC = 0x47;
const MAX_SYNC_SEARCH = 1024 * 1024;
const EMPTY = Buffer.alloc(0);

function nullPacket() {
  const packet = Buffer.alloc(PACKET, 0xff);
  packet[0] = SYNC;
  packet[1] = 0x1f; // PID 0x1FFF: null packet, players discard it
  packet[2] = 0xff;
  packet[3] = 0x10;
  return packet;
}

export const NULL_BURST = Buffer.concat(Array.from({ length: 7 }, nullPacket));

function findSync(buf) {
  for (let i = 0; i + 2 * PACKET < buf.length; i++) {
    if (buf[i] === SYNC && buf[i + PACKET] === SYNC && buf[i + 2 * PACKET] === SYNC) return i;
  }
  return -1;
}

// Re-cuts an MPEG-TS byte stream into whole 188-byte packets, so data from
// different upstream connections (and keepalive packets) can be spliced safely.
export class TsPacketizer {
  isTs = false;
  passthrough = false;
  #rest = EMPTY;
  #synced = false;

  reset() {
    this.#rest = EMPTY;
    this.#synced = false;
  }

  push(chunk) {
    if (this.passthrough) return chunk;
    let buf = this.#rest.length ? Buffer.concat([this.#rest, chunk]) : chunk;

    if (!this.#synced) {
      const at = findSync(buf);
      if (at < 0) {
        if (buf.length > MAX_SYNC_SEARCH) {
          this.passthrough = true;
          this.#rest = EMPTY;
          return buf;
        }
        this.#rest = buf;
        return null;
      }
      buf = buf.subarray(at);
      this.#synced = true;
      this.isTs = true;
    }

    const whole = buf.length - (buf.length % PACKET);
    this.#rest = Buffer.from(buf.subarray(whole));
    return whole ? buf.subarray(0, whole) : null;
  }
}

const PTS_CLOCK = 90_000;
const MAX_OVERLAP = 60 * PTS_CLOCK;
const MAX_SKIP_BYTES = 32 * 1024 * 1024;

// PTS of a packet that starts an audio/video PES, otherwise null.
export function pesPts(p) {
  if (!(p[1] & 0x40) || !(p[3] & 0x10)) return null;
  let o = 4;
  if (p[3] & 0x20) o += 1 + p[4];
  if (o + 14 > PACKET || p[o] !== 0 || p[o + 1] !== 0 || p[o + 2] !== 1) return null;
  const streamId = p[o + 3];
  if (streamId !== 0xbd && (streamId < 0xc0 || streamId > 0xef)) return null;
  if (!(p[o + 7] & 0x80)) return null;
  const b = o + 9;
  return (
    ((p[b] >> 1) & 7) * 2 ** 30 + ((p[b + 1] << 7) | (p[b + 2] >> 1)) * 2 ** 15 + ((p[b + 3] << 7) | (p[b + 4] >> 1))
  );
}

// Providers start a new connection with seconds of already-sent video. After a reconnect this
// drops, per PID, everything up to the last timestamp the player already got.
export class TsOverlapFilter {
  #lastPts = new Map();
  #catchingUp = null;
  #skipped = 0;

  constructor(onCaughtUp = () => {}) {
    this.onCaughtUp = onCaughtUp;
  }

  reconnected() {
    this.#catchingUp = this.#lastPts.size ? new Set(this.#lastPts.keys()) : null;
    this.#skipped = 0;
  }

  filter(buf) {
    const keep = [];
    let dropped = false;
    for (let off = 0; off < buf.length; off += PACKET) {
      const packet = buf.subarray(off, off + PACKET);
      const pid = ((packet[1] & 0x1f) << 8) | packet[2];
      const pts = pesPts(packet);

      if (this.#catchingUp?.has(pid)) {
        const behind = pts === null ? 0 : this.#lastPts.get(pid) - pts;
        if (pts === null || (behind >= 0 && behind < MAX_OVERLAP)) {
          dropped = true;
          this.#skipped += PACKET;
          if (this.#skipped < MAX_SKIP_BYTES) continue;
          this.#finish();
        } else {
          this.#catchingUp.delete(pid);
          if (!this.#catchingUp.size) this.#finish();
        }
      }
      if (pts !== null) this.#lastPts.set(pid, pts);
      keep.push(packet);
    }
    return dropped ? Buffer.concat(keep) : buf;
  }

  #finish() {
    this.#catchingUp = null;
    this.onCaughtUp(this.#skipped);
  }
}
