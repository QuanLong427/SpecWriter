/** Public ranking snapshots. These collectors never use model knowledge as a fallback. */
export type MarketPlatform = 'fanqie' | 'qidian';
export interface MarketOptions {
  /** Number of visible entries retained per ranking group (1..50). */
  limit?: number;
  /** Per-request deadline, including reading the response body (1..30000 ms). */
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}
export interface MarketEntry {
  group: string;
  ordinal: number;
  title: string;
  bookId: string | null;
  bookUrl: string | null;
  author: string | null;
  category: string | null;
  publisherCategoryRaw: string | null;
  platformGenre: string | number | null;
}
export interface MarketSource {
  sourceId: string;
  title: string;
  kind: 'ranking';
  content: string;
  url: string;
  observedAt: string;
  metadata?: Record<string, string | number | boolean | null>;
}
export interface MarketIssue { source: string; url: string; message: string }
export interface MarketResult {
  platform: MarketPlatform;
  /** ready means the requested samples were collected, never the whole market. */
  status: 'ready' | 'partial' | 'unavailable';
  observedAt: string;
  sources: MarketSource[];
  issues: MarketIssue[];
}

const FANQIE_URL = 'https://api-lf.fanqiesdk.com/api/novel/channel/homepage/rank/rank_list/v2/';
const QIDIAN_URL = 'https://www.qidian.com/rank/';
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_PAYLOAD_ENTRIES = 1_000;
const SAMPLE_NOTICE = 'Public ranking sample only; not a complete ranking or representative market estimate. Rankings may mix work types; do not treat all entries as long-form novel popularity.';
const FANQIE_GROUPS = [
  { sourceId: 'fanqie-hot', title: '番茄热门榜', group: '热门榜', sideType: 10 },
  { sourceId: 'fanqie-darkhorse', title: '番茄黑马榜', group: '黑马榜', sideType: 13 },
] as const;

class MarketRequestError extends Error {}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function clean(value: unknown, max = 240): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? Array.from(text).slice(0, max).join('') : null;
}
function bookId(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === 'string' && /^\d{1,32}$/.test(value) ? value : null;
}
function genre(value: unknown): number | string | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : clean(value, 64);
}
function publicBookUrl(value: unknown, platform: MarketPlatform): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value, platform === 'qidian' ? QIDIAN_URL : 'https://fanqienovel.com/');
    const hosts = platform === 'qidian' ? ['www.qidian.com', 'book.qidian.com'] : ['fanqienovel.com', 'www.fanqienovel.com', 'api.fanqiesdk.com'];
    if (!['https:', 'http:'].includes(url.protocol) || !hosts.includes(url.hostname) || url.username || url.password || url.port) return null;
    if (platform === 'qidian' && !/^\/(?:book|info)\/\d+\/?$/.test(url.pathname)) return null;
    url.protocol = 'https:';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch { return null; }
}

async function readLimited(response: Response, signal: AbortSignal): Promise<string> {
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new MarketRequestError(`Response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new MarketRequestError(`Response exceeds ${MAX_RESPONSE_BYTES} bytes`);
      chunks.push(chunk.value);
    }
    const merged = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(merged);
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

async function request(url: string, options: MarketOptions, timeoutMs: number): Promise<{ text: string; httpStatus: number }> {
  if (options.signal?.aborted) throw new MarketRequestError('Request aborted');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let externalAbort: (() => void) | undefined;
  // Race as well as abort: injected fetch implementations may ignore the signal.
  const stopped = new Promise<never>((_resolve, reject) => {
    externalAbort = () => { controller.abort(); reject(new MarketRequestError('Request aborted')); };
    options.signal?.addEventListener('abort', externalAbort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      reject(new MarketRequestError(`Request timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  const work = async () => {
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      method: 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal,
      headers: { accept: url.includes('fanqiesdk') ? 'application/json' : 'text/html' },
    });
    if (response.redirected || (response.url && new URL(response.url).origin !== new URL(url).origin)) {
      void response.body?.cancel().catch(() => {});
      throw new MarketRequestError('Unexpected redirect or response origin');
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new MarketRequestError(`HTTP ${response.status}`);
    }
    return { text: await readLimited(response, controller.signal), httpStatus: response.status };
  };
  try { return await Promise.race([work(), stopped]); }
  catch (error) {
    if (error instanceof MarketRequestError) throw error;
    throw new MarketRequestError('Public ranking request failed');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (externalAbort) options.signal?.removeEventListener('abort', externalAbort);
  }
}

function source(platform: MarketPlatform, sourceId: string, title: string, group: string, url: string,
  observedAt: string, entries: MarketEntry[], metadata: Record<string, string | number | boolean | null>): MarketSource {
  const details = { group, entryCount: entries.length, scope: 'visible-top-slice', notice: SAMPLE_NOTICE, ...metadata };
  return {
    sourceId, title, kind: 'ranking', url, observedAt,
    content: JSON.stringify({ schemaVersion: 1, platform, group, sourceUrl: url, observedAt, scope: 'visible-top-slice', notice: SAMPLE_NOTICE, entries }, null, 2) + '\n',
    metadata: details,
  };
}

async function fanqie(options: MarketOptions, limit: number, timeoutMs: number, observedAt: string): Promise<{ sources: MarketSource[]; issues: MarketIssue[] }> {
  const results = await Promise.all(FANQIE_GROUPS.map(async group => {
    const url = `${FANQIE_URL}?aid=13&limit=${limit}&offset=0&side_type=${group.sideType}`;
    const issues: MarketIssue[] = [];
    try {
      const response = await request(url, options, timeoutMs);
      let parsed: unknown;
      try { parsed = JSON.parse(response.text); } catch { throw new MarketRequestError('Ranking response is not valid JSON'); }
      const payload = record(parsed), data = record(payload?.data);
      if (payload?.code !== 0) throw new MarketRequestError('Ranking API did not report success');
      if (!Array.isArray(data?.result)) throw new MarketRequestError('Unsupported ranking payload: expected data.result array');
      if (data.result.length > MAX_PAYLOAD_ENTRIES) throw new MarketRequestError(`Ranking payload exceeds ${MAX_PAYLOAD_ENTRIES} entries`);
      const entries: MarketEntry[] = [];
      let invalidEntries = 0;
      for (const [index, value] of data.result.slice(0, limit).entries()) {
        const row = record(value), title = clean(row?.book_name);
        if (!row || !title) { invalidEntries++; continue; }
        const categoryRaw = clean(row.category, 160);
        entries.push({ group: group.group, ordinal: index + 1, title, bookId: bookId(row.book_id),
          bookUrl: publicBookUrl(row.book_url ?? row.url, 'fanqie'), author: clean(row.author, 160),
          category: categoryRaw, publisherCategoryRaw: categoryRaw, platformGenre: genre(row.genre ?? row.type) });
      }
      if (!entries.length) throw new MarketRequestError('Ranking response contains no valid entries');
      if (invalidEntries) issues.push({ source: group.sourceId, url, message: `${invalidEntries} invalid ranking entries omitted; original ordinals retained` });
      return { sources: [source('fanqie', group.sourceId, group.title, group.group, url, observedAt, entries, {
        httpStatus: response.httpStatus, requestedLimit: limit, returnedEntries: data.result.length,
        invalidEntries, hasMore: typeof data.has_more === 'boolean' ? data.has_more : null,
        ordinalBasis: 'upstream-array-order', completeness: invalidEntries ? 'partial-sample' : 'requested-sample',
      })], issues };
    } catch (error) {
      return { sources: [], issues: [{ source: group.sourceId, url, message: error instanceof MarketRequestError ? error.message : 'Cannot parse public ranking response' }] };
    }
  }));
  return { sources: results.flatMap(result => result.sources), issues: results.flatMap(result => result.issues) };
}

interface HtmlNode { tag: string; attrs: Record<string, string>; children: (HtmlNode | string)[] }
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
function decodeHtml(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (original, entity: string) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? original;
    const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
  });
}
/** A bounded, non-executing HTML tree for static public ranking markup. */
function parseHtml(text: string): HtmlNode {
  const root: HtmlNode = { tag: 'root', attrs: {}, children: [] }, stack = [root];
  const tokens = text.match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z][a-z\d:-]*(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/gi) ?? [];
  let nodes = 0;
  for (const token of tokens) {
    if (++nodes > 30_000) throw new MarketRequestError('Ranking HTML exceeds parser complexity limit');
    if (token.startsWith('<!')) continue;
    if (!token.startsWith('<')) { stack[stack.length - 1]!.children.push(decodeHtml(token)); continue; }
    const closing = /^<\/\s*([\w:-]+)/.exec(token);
    if (closing) {
      const tag = closing[1]!.toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) if (stack[i]!.tag === tag) { stack.length = i; break; }
      continue;
    }
    const opening = /^<([\w:-]+)/.exec(token);
    if (!opening) continue;
    const node: HtmlNode = { tag: opening[1]!.toLowerCase(), attrs: {}, children: [] };
    const attrText = token.slice(opening[0].length, -1);
    for (const match of attrText.matchAll(/([^\s=/'">]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      node.attrs[match[1]!.toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
    }
    stack[stack.length - 1]!.children.push(node);
    if (!VOID_TAGS.has(node.tag) && !/\/\s*>$/.test(token)) {
      if (stack.length > 128) throw new MarketRequestError('Ranking HTML exceeds nesting limit');
      stack.push(node);
    }
  }
  return root;
}
function descendants(node: HtmlNode, predicate: (child: HtmlNode) => boolean): HtmlNode[] {
  const matches: HtmlNode[] = [];
  for (const child of node.children) if (typeof child !== 'string' && !['script', 'style', 'noscript'].includes(child.tag)) {
    if (predicate(child)) matches.push(child);
    matches.push(...descendants(child, predicate));
  }
  return matches;
}
function textOf(node: HtmlNode): string {
  if (['script', 'style', 'noscript'].includes(node.tag)) return '';
  return node.children.map(child => typeof child === 'string' ? child : textOf(child)).join(' ');
}
function hasClass(node: HtmlNode, name: string): boolean { return (node.attrs.class ?? '').split(/\s+/).includes(name); }
function qidianGroupKey(node: HtmlNode, index: number): string {
  for (const link of descendants(node, node => node.tag === 'a')) {
    try {
      const url = new URL(link.attrs.href ?? '', QIDIAN_URL);
      if (url.origin !== new URL(QIDIAN_URL).origin) continue;
      const slug = /^\/rank\/([a-z][a-z\d-]{0,40})\/?$/.exec(url.pathname)?.[1];
      if (slug) return slug;
    } catch { /* A malformed link is not a ranking group identifier. */ }
  }
  return index === 0 ? 'general' : `general-${index + 1}`;
}
function parseQidian(text: string, limit: number, observedAt: string, httpStatus: number): { sources: MarketSource[]; issues: MarketIssue[] } {
  const tree = parseHtml(text);
  let groups = descendants(tree, node => hasClass(node, 'rank-list'));
  if (!groups.length) groups = descendants(tree, node => hasClass(node, 'rank-view-list'));
  const sources: MarketSource[] = [], issues: MarketIssue[] = [], usedIds = new Set<string>();
  if (groups.length > 50) throw new MarketRequestError('Ranking page exceeds 50 groups');
  for (const [index, groupNode] of groups.entries()) {
    const heading = descendants(groupNode, node => /^h[1-4]$/.test(node.tag)).find(node =>
      !/^NO\.?\s*\d+$/i.test(textOf(node).trim()) && !descendants(node, child => child.tag === 'a' && !!publicBookUrl(child.attrs.href, 'qidian')).length);
    // Read heading text without the "more" link label.
    const group = clean(heading ? heading.children.filter(child => typeof child === 'string' || child.tag !== 'a' ||
      (!hasClass(child, 'more') && !/^(?:更多|more)$/i.test(textOf(child).trim()))).map(child => typeof child === 'string' ? child : textOf(child)).join(' ') : null, 120);
    if (!group) { issues.push({ source: 'qidian', url: QIDIAN_URL, message: `Ranking group ${index + 1} has no identifiable heading; omitted` }); continue; }
    let sourceId = `qidian-${qidianGroupKey(groupNode, index)}`;
    if (usedIds.has(sourceId)) sourceId += `-${index + 1}`;
    usedIds.add(sourceId);
    const rows = descendants(groupNode, node => node.tag === 'li');
    if (rows.length > MAX_PAYLOAD_ENTRIES) throw new MarketRequestError(`Ranking payload exceeds ${MAX_PAYLOAD_ENTRIES} entries`);
    const entries: MarketEntry[] = [];
    let invalidEntries = 0;
    for (const [rowIndex, row] of rows.slice(0, limit).entries()) {
      const links = descendants(row, node => node.tag === 'a');
      const candidates = links.filter(link => publicBookUrl(link.attrs.href, 'qidian') && clean(textOf(link)));
      const link = candidates.find(link => hasClass(link, 'name') || hasClass(link, 'book-name')) ?? candidates[0];
      const title = link ? clean(textOf(link)) : null;
      if (!link || !title) { invalidEntries++; continue; }
      const bookUrl = publicBookUrl(link.attrs.href, 'qidian');
      const id = bookId(link.attrs['data-bid']) ?? bookId(bookUrl ? /\/(?:book|info)\/(\d+)/.exec(bookUrl)?.[1] : undefined);
      const numberNode = descendants(row, node => hasClass(node, 'num-box') || /(?:^|\s)num\d*(?:\s|$)/.test(node.attrs.class ?? '') || (node.tag === 'h3' && /^NO\.?\s*\d+$/i.test(textOf(node).trim())))[0];
      const explicit = numberNode ? /^(?:NO\.?\s*)?(\d+)$/i.exec(textOf(numberNode).trim())?.[1] : undefined;
      const ordinal = explicit && Number(explicit) > 0 && Number(explicit) <= 10000 ? Number(explicit) : rowIndex + 1;
      const authorLink = links.find(link => { try { const url = new URL(link.attrs.href ?? '', QIDIAN_URL); return ['www.qidian.com', 'my.qidian.com'].includes(url.hostname) && /^\/(?:author|authorinfo)\//.test(url.pathname); } catch { return false; } });
      const categoryLink = links.find(link => { try { const url = new URL(link.attrs.href ?? '', QIDIAN_URL); return url.hostname === 'www.qidian.com' && /^\/(?:all|category)(?:\/|$)/.test(url.pathname); } catch { return false; } });
      const category = categoryLink ? clean(textOf(categoryLink), 160) : null;
      entries.push({ group, ordinal, title, bookId: id, bookUrl, author: authorLink ? clean(textOf(authorLink), 160) : null,
        category, publisherCategoryRaw: category, platformGenre: genre(row.attrs['data-genre'] ?? row.attrs['data-type']) });
    }
    if (!entries.length) { issues.push({ source: sourceId, url: QIDIAN_URL, message: `Ranking group ${group} contains no valid entries` }); continue; }
    if (invalidEntries) issues.push({ source: sourceId, url: QIDIAN_URL, message: `${invalidEntries} invalid ranking entries omitted; original ordinals retained` });
    sources.push(source('qidian', sourceId, `起点${group}`, group, QIDIAN_URL, observedAt, entries, {
      httpStatus, requestedLimit: limit, returnedEntries: rows.length, invalidEntries,
      ordinalBasis: 'explicit-rank-or-visible-list-order', completeness: invalidEntries ? 'partial-sample' : 'requested-sample',
    }));
  }
  if (!sources.length && !issues.length) issues.push({ source: 'qidian', url: QIDIAN_URL, message: `No static ranking groups found (HTTP ${httpStatus}); page may be a challenge or unsupported markup` });
  return { sources, issues };
}

/** Collect fixed public endpoints only: two Fanqie requests or one Qidian request. */
export async function collectMarket(platform: MarketPlatform, options: MarketOptions = {}): Promise<MarketResult> {
  const observedAt = new Date().toISOString();
  const result: MarketResult = { platform, status: 'unavailable', observedAt, sources: [], issues: [] };
  const url = platform === 'fanqie' ? FANQIE_URL : QIDIAN_URL;
  if (!['fanqie', 'qidian'].includes(platform)) {
    result.issues.push({ source: 'market', url: '', message: 'Unsupported market platform' }); return result;
  }
  const limit = options.limit ?? 15, timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    result.issues.push({ source: platform, url, message: 'limit must be an integer in 1..50 and timeoutMs an integer in 1..30000' }); return result;
  }
  if (options.signal?.aborted) { result.issues.push({ source: platform, url, message: 'Request aborted' }); return result; }
  try {
    const collected = platform === 'fanqie' ? await fanqie(options, limit, timeoutMs, observedAt)
      : await request(QIDIAN_URL, options, timeoutMs).then(response => parseQidian(response.text, limit, observedAt, response.httpStatus));
    result.sources = collected.sources;
    result.issues = collected.issues;
    result.status = result.sources.length ? (result.issues.length ? 'partial' : 'ready') : 'unavailable';
  } catch (error) {
    result.issues.push({ source: platform, url, message: error instanceof MarketRequestError ? error.message : 'Cannot parse public ranking response' });
  }
  return result;
}
