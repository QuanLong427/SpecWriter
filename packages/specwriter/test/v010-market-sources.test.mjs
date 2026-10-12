import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMarket } from '../dist/market-sources.js';

// Small representative public payload/markup fixtures; no model or live network calls.
const fanqieBody = (entries = [
  { book_id: '7663152833243401278', book_name: '  海\u0000边\n灯塔  ', author: '舟客', category: '悬疑,推理', genre: '0' },
  { book_id: '7675288927619533886', book_name: '山中回声', category: '', author: '', genre: '205' },
  { book_name: '无编号作品', category_v2: [], type: 42 },
]) => JSON.stringify({ code: 0, data: { has_more: false, result: entries } });
const jsonResponse = body => new Response(body, { headers: { 'content-type': 'application/json' } });
const entriesOf = source => JSON.parse(source.content).entries;
const qidianHtml = `<!DOCTYPE html><html><head><title>起点榜单</title></head><body>
  <nav><a href="/book/9999/">导航书名不能进入榜单</a></nav>
  <div class="rank-list"><h3 class="wrap-title">月票榜<a class="more" href="/rank/yuepiao/">更多</a></h3>
    <div class="book-list"><ul>
      <li class="unfold" data-genre="1"><div class="book-wrap"><div class="book-info"><h3>NO.1</h3>
        <h4><a href="//www.qidian.com/book/1040300001/" data-bid="1040300001">星河 &amp; 长夜</a></h4>
        <p class="author"><a href="//www.qidian.com/all?chanId=1">玄幻</a><a href="https://my.qidian.com/author/123/">河舟</a></p>
      </div><a href="//www.qidian.com/book/1040300001/"><img alt="封面"/></a></div></li>
      <li><div class="num-box"><span class="num2">2</span></div><div class="name-box">
        <a class="name" href="https://book.qidian.com/info/1040300002/">&#x6D77;上灯</a></div></li>
    </ul></div>
  </div>
  <div class="rank-list"><h3><a href="/rank/readIndex/">阅读指数榜</a></h3><div class="book-list"><ul>
    <li><span class="num1">1</span><a class="name" href="/book/1040300003/">雪原来信</a></li>
  </ul></div></div>
  <script>const fake = '<div class="rank-list"><h3>假榜</h3><li><a href="/book/8888/">脚本书名</a></li></div>';</script>
</body></html>`;

test('Fanqie parses real API shape, retains upstream groups/order/type and cleans text', async () => {
  const calls = [];
  const result = await collectMarket('fanqie', { fetch: async (url, init) => {
    calls.push({ url: String(url), init }); return jsonResponse(fanqieBody());
  } });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.issues, []);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => new URL(call.url).searchParams.get('side_type')), ['10', '13']);
  assert.ok(calls.every(call => new URL(call.url).hostname === 'api-lf.fanqiesdk.com' && call.init.redirect === 'error' && call.init.credentials === 'omit'));
  assert.deepEqual(result.sources.map(source => source.sourceId), ['fanqie-hot', 'fanqie-darkhorse']);
  const source = result.sources[0], entries = entriesOf(source);
  assert.equal(source.kind, 'ranking');
  assert.equal(source.observedAt, result.observedAt);
  assert.ok(Number.isFinite(Date.parse(result.observedAt)));
  assert.deepEqual(entries.map(entry => [entry.group, entry.ordinal, entry.title]), [['热门榜', 1, '海 边 灯塔'], ['热门榜', 2, '山中回声'], ['热门榜', 3, '无编号作品']]);
  assert.equal(entries[0].bookId, '7663152833243401278');
  assert.equal(entries[0].publisherCategoryRaw, '悬疑,推理');
  assert.equal(entries[1].platformGenre, '205');
  assert.equal(entries[1].author, null);
  assert.equal(entries[1].category, null);
  assert.equal(entries[2].platformGenre, 42);
  assert.equal(entries[2].bookId, null);
  assert.equal(entries[2].bookUrl, null);
  assert.match(source.metadata.notice, /mix work types/);
  assert.match(source.content, /not a complete ranking/);
  assert.equal(source.metadata.scope, 'visible-top-slice');
});

test('Qidian parses ranking containers, first unfolded book, groups, original ordinals and entities', async () => {
  let calls = 0;
  const result = await collectMarket('qidian', { fetch: async url => {
    calls++; assert.equal(String(url), 'https://www.qidian.com/rank/'); return new Response(qidianHtml);
  } });
  assert.equal(calls, 1);
  assert.equal(result.status, 'ready');
  assert.equal(result.sources.length, 2);
  assert.deepEqual(result.sources.map(source => source.sourceId), ['qidian-yuepiao', 'qidian-general-2']);
  const entries = entriesOf(result.sources[0]);
  assert.deepEqual(entries.map(entry => [entry.ordinal, entry.title]), [[1, '星河 & 长夜'], [2, '海上灯']]);
  assert.equal(entries[0].author, '河舟');
  assert.equal(entries[0].category, '玄幻');
  assert.equal(entries[0].platformGenre, '1');
  assert.equal(entries[1].author, null);
  assert.equal(entries[1].bookId, '1040300002');
  assert.equal(entries[1].bookUrl, 'https://book.qidian.com/info/1040300002/');
  assert.ok(!JSON.stringify(result).includes('导航书名'));
  assert.ok(!JSON.stringify(result).includes('脚本书名'));
});

test('one Fanqie group failing produces partial with provenance, never invented fallback entries', async () => {
  const result = await collectMarket('fanqie', { fetch: async url => new URL(url).searchParams.get('side_type') === '10'
    ? jsonResponse(fanqieBody()) : new Response('blocked', { status: 403 }) });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.sources.map(source => source.sourceId), ['fanqie-hot']);
  assert.equal(result.issues[0].source, 'fanqie-darkhorse');
  assert.match(result.issues[0].message, /HTTP 403/);
  assert.match(result.issues[0].url, /side_type=13/);
});

test('malformed entries keep their original ordinal gaps and mark the sample partial', async () => {
  const result = await collectMarket('fanqie', { fetch: async () => jsonResponse(fanqieBody([
    { book_name: '第一', book_id: '123' }, {}, { book_name: '第三', book_id: '789' },
  ])) });
  assert.equal(result.status, 'partial');
  assert.deepEqual(entriesOf(result.sources[0]).map(entry => entry.ordinal), [1, 3]);
  assert.equal(result.sources[0].metadata.completeness, 'partial-sample');
  assert.match(result.issues[0].message, /invalid ranking entries/);
});

test('Qidian damaged group or book item is partial and does not renumber explicit ranks', async () => {
  const html = `<div class="rank-list"><h3>月票榜</h3><ul>
    <li><span class="num1">1</span><a href="/book/123/">第一</a></li>
    <li><span class="num2">2</span><a href="http://127.0.0.1/book/456/">内网链接</a></li>
    <li><span class="num3">3</span><a href="/book/789/">第三</a></li>
  </ul></div><div class="rank-list"><h3>推荐榜</h3><ul></ul></div>`;
  const result = await collectMarket('qidian', { fetch: async () => new Response(html) });
  assert.equal(result.status, 'partial');
  assert.deepEqual(entriesOf(result.sources[0]).map(entry => entry.ordinal), [1, 3]);
  assert.equal(result.sources.length, 1);
  assert.equal(result.issues.length, 2);
  assert.ok(!JSON.stringify(result.sources).includes('127.0.0.1'));
});

test('search pages, challenge pages and empty rankings are unavailable rather than ranking evidence', async () => {
  const cases = [
    ['qidian', '<div class="search-list"><li><a href="/book/123/">搜索结果</a></li></div>', 200],
    ['qidian', '<html><script src="/C2WF946J0/probe.js"></script><body></body></html>', 202],
    ['qidian', '<div class="rank-list"><h3>月票榜</h3><ul></ul></div>', 200],
    ['fanqie', fanqieBody([]), 200],
    ['fanqie', fanqieBody([null, {}, { book_name: '\u0000\u0001' }]), 200],
  ];
  for (const [platform, body, status] of cases) {
    const result = await collectMarket(platform, { fetch: async () => new Response(body, { status }) });
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.sources, []);
    assert.ok(result.issues.length > 0);
  }
});

test('unsupported API shape, error codes and malformed JSON fail explicitly', async () => {
  for (const body of ['{bad-json', '{"code":7,"data":{"result":[]}}', '{"code":0,"data":{"search_results":[{"book_name":"搜索"}]}}']) {
    const result = await collectMarket('fanqie', { fetch: async () => jsonResponse(body) });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.sources.length, 0);
    assert.equal(result.issues.length, 2);
    assert.match(result.issues[0].message, /JSON|success|payload/);
  }
});

test('HTTP and network failures are unavailable and do not expose injected error details', async () => {
  const network = await collectMarket('fanqie', { fetch: async () => { throw new Error('fixture-secret-token'); } });
  assert.equal(network.status, 'unavailable');
  assert.ok(!JSON.stringify(network).includes('fixture-secret-token'));
  const http = await collectMarket('qidian', { fetch: async () => new Response('error', { status: 503 }) });
  assert.equal(http.status, 'unavailable');
  assert.match(http.issues[0].message, /HTTP 503/);
});

test('response byte bounds apply to content-length and streaming bodies', async () => {
  for (const response of [
    () => new Response('small', { headers: { 'content-length': '1048577' } }),
    () => new Response('x'.repeat(1048577)),
  ]) {
    const result = await collectMarket('qidian', { fetch: async () => response() });
    assert.equal(result.status, 'unavailable');
    assert.match(result.issues[0].message, /exceeds 1048576 bytes/);
  }
});

test('timeout is bounded even if fetch ignores AbortSignal', async () => {
  let calls = 0;
  const started = Date.now();
  const result = await collectMarket('fanqie', { timeoutMs: 15, fetch: async () => { calls++; return new Promise(() => {}); } });
  assert.equal(calls, 2);
  assert.equal(result.status, 'unavailable');
  assert.ok(result.issues.every(issue => /timed out/.test(issue.message)));
  assert.ok(Date.now() - started < 1000);
});

test('request deadline also covers a hanging response body and cancels the reader', async () => {
  let cancelled = false;
  const result = await collectMarket('qidian', { timeoutMs: 15, fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('<html>')); }, cancel() { cancelled = true; },
  })) });
  assert.equal(result.status, 'unavailable');
  assert.match(result.issues[0].message, /timed out/);
  assert.equal(cancelled, true);
});

test('pre-abort sends zero requests and in-flight abort settles ignored signals', async () => {
  const pre = new AbortController(); pre.abort();
  let calls = 0;
  const aborted = await collectMarket('fanqie', { signal: pre.signal, fetch: async () => { calls++; return jsonResponse(fanqieBody()); } });
  assert.equal(calls, 0);
  assert.equal(aborted.status, 'unavailable');
  assert.match(aborted.issues[0].message, /aborted/);
  const active = new AbortController();
  const promise = collectMarket('qidian', { signal: active.signal, fetch: async () => new Promise(() => {}) });
  active.abort();
  const result = await promise;
  assert.equal(result.status, 'unavailable');
  assert.match(result.issues[0].message, /aborted/);
});

test('invalid input limits and unsupported platforms cannot issue network requests', async () => {
  let calls = 0;
  const fetch = async () => { calls++; return jsonResponse(fanqieBody()); };
  for (const options of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { limit: NaN }, { timeoutMs: 0 }, { timeoutMs: 30001 }, { timeoutMs: Infinity }]) {
    const result = await collectMarket('fanqie', { ...options, fetch });
    assert.equal(result.status, 'unavailable');
    assert.match(result.issues[0].message, /integer/);
  }
  assert.equal((await collectMarket('https://127.0.0.1/', { fetch })).status, 'unavailable');
  assert.equal(calls, 0);
});

test('per-group limit bounds output and upstream URL, and oversized payload arrays fail', async () => {
  const urls = [];
  const limited = await collectMarket('fanqie', { limit: 1, fetch: async url => { urls.push(String(url)); return jsonResponse(fanqieBody()); } });
  assert.equal(limited.status, 'ready');
  assert.ok(limited.sources.every(source => entriesOf(source).length === 1));
  assert.ok(urls.every(url => new URL(url).searchParams.get('limit') === '1'));
  assert.equal(limited.sources[0].metadata.returnedEntries, 3);
  const oversized = await collectMarket('fanqie', { fetch: async () => jsonResponse(fanqieBody(Array.from({ length: 1001 }, () => ({ book_name: '条目' })))) });
  assert.equal(oversized.status, 'unavailable');
  assert.match(oversized.issues[0].message, /exceeds 1000 entries/);
});

test('redirected or off-origin responses are rejected, and captured links stay on platform hosts', async () => {
  const response = new Response(qidianHtml);
  Object.defineProperty(response, 'url', { value: 'http://127.0.0.1/private' });
  const result = await collectMarket('qidian', { fetch: async () => response });
  assert.equal(result.status, 'unavailable');
  assert.match(result.issues[0].message, /origin/);
  const fanqie = await collectMarket('fanqie', { fetch: async () => jsonResponse(fanqieBody([
    { book_name: '外部链接', book_id: 9007199254740992, url: 'http://169.254.169.254/latest/' },
    { book_name: '平台链接', book_url: 'https://fanqienovel.com/page/123?secret=x#hash' },
  ])) });
  const entries = entriesOf(fanqie.sources[0]);
  assert.equal(entries[0].bookId, null);
  assert.equal(entries[0].bookUrl, null);
  assert.equal(entries[1].bookUrl, 'https://fanqienovel.com/page/123');
});
