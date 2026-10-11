import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetsRoot, positiveInteger } from './files.js';
import { NovelReader, escapeHtml, type ReaderScope } from './reader.js';
import type { Project } from './project.js';

export async function startReader(project: Project, options: ReaderScope & { port?: number } = {}) {
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Reader port must be 0–65535');
  const reader = new NovelReader(project);
  const initial = reader.catalog(options);
  const token = randomBytes(32).toString('hex');
  let origin = '';
  const json = (response: ServerResponse, value: unknown, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value));
  };
  async function body(request: IncomingMessage) {
    if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('Expected application/json');
    let length = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 65536) throw new Error('Feedback request is too large');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin) || request.headers['sec-fetch-site'] === 'cross-site') {
      json(response, { error: 'Reader is available only from its local origin' }, 403); return;
    }
    try {
      const url = new URL(request.url ?? '/', origin);
      const path = url.pathname;
      if (path.startsWith('/api/') && request.headers['x-reader-token'] !== token) { json(response, { error: 'Refresh the reader to obtain its session token' }, 403); return; }
      if (request.method === 'GET') {
        if (path === '/api/book') { json(response, reader.catalog({ draft: url.searchParams.get('scope') === 'draft', work: url.searchParams.get('work') ?? undefined })); return; }
        if (path === '/api/chapter') { json(response, reader.chapter(url.searchParams.get('key') ?? '')); return; }
        if (path === '/api/versions') { json(response, reader.versions(positiveInteger(url.searchParams.get('chapter'), 'chapter'))); return; }
        if (path === '/api/version') { json(response, reader.version(positiveInteger(url.searchParams.get('chapter'), 'chapter'), positiveInteger(url.searchParams.get('revision'), 'revision'))); return; }
        if (path === '/api/feedback') { json(response, reader.feedback(url.searchParams.get('key') ?? undefined)); return; }
        if (path === '/api/request') { json(response, { text: reader.revisionRequest(url.searchParams.get('key') ?? undefined) }); return; }
        if (path === '/api/export') {
          const exported = reader.export(url.searchParams.get('format') as 'txt' | 'md' | 'html');
          response.writeHead(200, { 'Content-Type': exported.contentType, 'Content-Disposition': `attachment; filename="${exported.filename}"` }); response.end(exported.content); return;
        }
        const files: Record<string, { name: string; type: string }> = {
          '/': { name: 'index.html', type: 'text/html' }, '/reader.css': { name: 'reader.css', type: 'text/css' },
          '/tokens.css': { name: 'tokens.css', type: 'text/css' }, '/reader.js': { name: 'reader.js', type: 'text/javascript' }
        };
        const file = files[path];
        if (file) {
          let content = readFileSync(join(assetsRoot, 'reader', file.name), 'utf8');
          if (path === '/') content = content.replace('READER_TOKEN', token).replace('READER_SCOPE', initial.scope).replace('READER_WORK', escapeHtml(initial.workId ?? '')).replace('READER_BOOK_NAME', escapeHtml(initial.name));
          response.writeHead(200, { 'Content-Type': `${file.type}; charset=utf-8` }); response.end(content); return;
        }
      } else if (request.method === 'POST') {
        if (path === '/api/export') {
          const input = await body(request);
          if (!input || typeof input.format !== 'string' || Object.keys(input).some(key => key !== 'format')) throw new Error('Invalid export fields');
          json(response, reader.writeExport(input.format as 'txt' | 'md' | 'html')); return;
        }
        if (path === '/api/feedback') { json(response, reader.addFeedback(await body(request)), 201); return; }
        if (path === '/api/feedback/resolve') {
          const input = await body(request);
          if (!input || typeof input.id !== 'string' || Object.keys(input).some(key => !['id', 'resolved'].includes(key))) throw new Error('Invalid resolution fields');
          json(response, reader.resolveFeedback(input.id, input.resolved)); return;
        }
      }
      json(response, { error: 'Reader route not found' }, 404);
    } catch (error) { json(response, { error: (error as Error).message }, 400); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Reader did not bind a TCP port');
  origin = `http://127.0.0.1:${address.port}`;
  return { url: origin, server, close: () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeIdleConnections();
  }) };
}
