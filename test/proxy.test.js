import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { redact } from '../src/log.js';
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

test('masks credentials in logged URLs', () => {
  assert.equal(
    redact('http://p:80/get.php?username=bob&password=s3cret&type=m3u_plus'),
    'http://p:80/get.php?username=***&password=***&type=m3u_plus',
  );
  assert.equal(redact('http://p/live/bob/s3cret/1.ts'), 'http://p/live/***/***/1.ts');
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

test('emulates the Xtream Codes API with the real login', async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.url);
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/player_api.php' && !url.searchParams.has('action')) {
      return res.end(JSON.stringify({ user_info: { auth: 1 }, server_info: { url: 'provider', port: '80' } }));
    }
    if (url.pathname === '/player_api.php') return res.end(JSON.stringify([{ stream_id: 7, name: 'News' }]));
    if (url.pathname === '/live/real/secret/7.ts') return res.end(packets(20, 7));
    res.writeHead(404).end();
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const providerBase = `http://127.0.0.1:${upstream.address().port}`;

  const proxy = createProxyServer({
    playlistUrl: `${providerBase}/get.php?username=real&password=secret`,
    xtream: { base: providerBase, username: 'real', password: 'secret' },
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

  // The player was configured with ".../playlist.m3u" as host, as seen in the field.
  const proxyBase = `http://127.0.0.1:${proxy.server.address().port}/playlist.m3u`;
  const login = await (await fetch(`${proxyBase}player_api.php?username=tv&password=tv`)).json();
  assert.equal(login.server_info.url, '127.0.0.1');
  assert.equal(login.server_info.port, String(proxy.server.address().port));
  assert.ok(seen.includes('/player_api.php?username=real&password=secret'));

  const live = await (await fetch(`${proxyBase}player_api.php?username=tv&password=tv&action=get_live_streams`)).json();
  assert.equal(live[0].name, 'News');

  const data = await readBytes(`${proxyBase}live/tv/tv/7.ts`, 188 * 20);
  assert.equal(data[1], 7);

  const bare = await readBytes(`${proxyBase}//7`, 188 * 20);
  assert.equal(bare[1], 7);
});
