import { setTimeout as sleep } from 'node:timers/promises';

export function isHlsResponse(res) {
  const type = res.headers.get('content-type') ?? '';
  return /mpegurl/i.test(type) || /\.m3u8$/i.test(new URL(res.url).pathname);
}

function pickVariant(text, base) {
  const lines = text.split(/\r?\n/);
  let best = null;
  let bestBandwidth = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const bandwidth = Number(/[:,]BANDWIDTH=(\d+)/.exec(lines[i])?.[1] ?? 0);
    const uri = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith('#'));
    if (uri && bandwidth > bestBandwidth) {
      best = uri.trim();
      bestBandwidth = bandwidth;
    }
  }
  if (!best) throw new Error('HLS master playlist has no variants');
  return new URL(best, base).href;
}

function parseMediaPlaylist(text, base) {
  let sequence = 0;
  let targetDuration = 6;
  let ended = false;
  const segments = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) sequence = parseInt(line.slice(22), 10) || 0;
    else if (line.startsWith('#EXT-X-TARGETDURATION:')) targetDuration = Number(line.slice(22)) || 6;
    else if (line.startsWith('#EXT-X-ENDLIST')) ended = true;
    else if (line && !line.startsWith('#')) {
      segments.push({ seq: sequence + segments.length, url: new URL(line, base).href });
    }
  }
  return { segments, targetDuration, ended };
}

// Follows a live HLS playlist and emits the segments as one continuous TS stream.
export async function runHls({ url, text, signal, userAgent, onData }) {
  const get = async (target) => {
    const res = await fetch(target, { headers: { 'User-Agent': userAgent }, signal });
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      throw new Error(`HLS HTTP ${res.status}`);
    }
    return res;
  };

  let playlistUrl = url;
  if (text.includes('#EXT-X-STREAM-INF')) {
    playlistUrl = pickVariant(text, url);
    text = null;
  }

  let lastSeq = -1;
  for (;;) {
    if (text === null) {
      const res = await get(playlistUrl);
      playlistUrl = res.url;
      text = await res.text();
    }
    const playlist = parseMediaPlaylist(text, playlistUrl);
    text = null;

    if (playlist.segments.length && playlist.segments.at(-1).seq < lastSeq) lastSeq = -1;
    let todo = playlist.segments.filter((s) => s.seq > lastSeq);
    if (lastSeq < 0 && !playlist.ended) todo = todo.slice(-3);

    for (const segment of todo) {
      const res = await get(segment.url);
      for await (const chunk of res.body) onData(chunk);
      lastSeq = segment.seq;
    }

    if (playlist.ended) return;
    await sleep(Math.max(1000, playlist.targetDuration * 500), undefined, { signal });
  }
}
