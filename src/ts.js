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
