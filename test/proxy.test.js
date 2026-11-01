import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { rewritePlaylist } from '../src/playlist.js';
import { createProxyServer } from '../src/server.js';
import { TsPacketizer } from '../src/ts.js';

function packets(count, marker) {
  const buf = Buffer.alloc(188 * count, marker);
  for (let i = 0; i < count; i++) buf[i * 188] = 0x47;
  return buf;
}

async function readBytes(url, size) {
  const res = await new Promise((resolve) => http.get(url, resolve));
  const chunks = [];
  let total = 0;
  for await (const chunk of res) {
    chunks.push(chunk);
    total += chunk.length;
    if (total >= size) break;
  }
  return Buffer.concat(chunks);
}

test('rewrites live entries and leaves VOD untouched', () => {
  const source = [
    '#EXTM3U url-tvg="http://p/epg.xml"',
    '#EXTINF:-1 tvg-id="news",News',
    'http://p/live/u/p/1.ts',
    '#EXTINF:-1,Film',
    'http://p/movie/u/p/2.mkv',
  ].join('\n');
  const { text, streams } = rewritePlaylist(source, 'http://10.0.0.2:34400');
  assert.equal(streams.size, 1);
  const [stream] = streams.values();
  assert.equal(stream.name, 'News');
  assert.ok(text.includes(`http://10.0.0.2:34400/stream/${stream.id}.ts`));
  assert.ok(text.includes('http://p/movie/u/p/2.mkv'));
  assert.ok(text.startsWith('#EXTM3U url-tvg="http://p/epg.xml"'));
});

test('packetizer finds sync and emits whole packets', () => {
  const input = Buffer.concat([Buffer.from([1, 2, 3]), packets(10, 1)]);
  const packetizer = new TsPacketizer();
  const out = [];
  for (let i = 0; i < input.length; i += 100) {
    const data = packetizer.push(input.subarray(i, i + 100));
    if (data) out.push(Buffer.from(data));
  }
  assert.deepEqual(Buffer.concat(out), packets(10, 1));
});

test('keeps the player connected across upstream drops, for TS and HLS', async (t) => {
  let tsHits = 0;
  const upstream = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${upstream.address().port}`;
    switch (req.url) {
      case '/list.m3u':
        return res.end(`#EXTM3U\n#EXTINF:-1,TS\n${base}/live/1.ts\n#EXTINF:-1,HLS\n${base}/live/2.m3u8\n`);
      case '/live/1.ts':
        tsHits++;
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        return res.end(packets(50, tsHits)); // ends the connection, like a provider drop
      case '/live/2.m3u8':
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:5\n#EXTINF:2,\nseg5.ts\n#EXTINF:2,\nseg6.ts\n');
      case '/live/seg5.ts':
        return res.end(packets(10, 5));
      case '/live/seg6.ts':
        return res.end(packets(10, 6));
      default:
        res.writeHead(404).end();
    }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const proxy = createProxyServer({
    playlistUrl: `http://127.0.0.1:${upstream.address().port}/list.m3u`,
    log: () => {},
    channel: { maxBackoffMs: 20, tickMs: 50, keepaliveMs: 60_000 },
  });
  proxy.server.listen(0, '127.0.0.1');
  await once(proxy.server, 'listening');
  t.after(() => {
    proxy.close();
    upstream.close();
    upstream.closeAllConnections();
  });

  const res = await fetch(`http://127.0.0.1:${proxy.server.address().port}/playlist.m3u`);
  const [tsUrl, hlsUrl] = (await res.text()).split('\n').filter((l) => l.includes('/stream/'));

  const ts = await readBytes(tsUrl, 188 * 100);
  assert.equal(ts[1], 1, 'first upstream connection');
  assert.equal(ts[188 * 50 + 1], 2, 'continues from the reconnected upstream');

  const hls = await readBytes(hlsUrl, 188 * 20);
  assert.equal(hls[1], 5);
  assert.equal(hls[188 * 10 + 1], 6);
});
