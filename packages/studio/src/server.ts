// The dev server. It can write to the deck, so it listens on loopback only and refuses any request
// without the session token or from another origin: otherwise any open web page could post edits.
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, watch } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { addAnnotation, applyOps, compileDeck, deckOutline, planProgress, readAnnotations, resolveAnnotations, reviewPlan, undo } from '@present/core';
import { deckHtml, loadProjectMacros } from '@present/render';
import { studioApi, type StudioOptions } from './studio.ts';

const here = dirname(fileURLToPath(import.meta.url));

async function clientBundle() {
  const r = await esbuild.build({
    entryPoints: [join(here, 'client.tsx')], bundle: true, format: 'iife', minify: true, write: false,
    jsx: 'automatic', jsxImportSource: 'preact', logLevel: 'silent',
  });
  return r.outputFiles[0].text;
}

export async function startDev(dir: string, port = 4173, options: StudioOptions = {}) {
  const root = resolve(dir);
  await loadProjectMacros(root);
  const token = randomBytes(18).toString('hex');
  const clients = new Set<ServerResponse>();
  const compile = () => compileDeck(root, { sourceMap: true });
  const broadcast = (event: string, data: unknown) => { for (const c of clients) c.write(`event: ${event}
data: ${JSON.stringify(data)}

`); };
  const studio = studioApi(root, broadcast, options);

  const page = async () => {
    const { deck } = compile();
    const tag = `<script>window.__PRESENT_DEV=${JSON.stringify({ token })}</script>`;
    return deckHtml(deck, root, '', `${tag}<script>${(await clientBundle()).replace(/<\/script/gi, '<\\/script')}</script>`);
  };

  let timer: NodeJS.Timeout | undefined, refsTimer: NodeJS.Timeout | undefined, planTimer: NodeJS.Timeout | undefined;
  // Every slide changed in one burst, so a change to many is not reported as a change to whichever was saved last.
  // A slide counts only if its text changed: Windows also reports a file that was touched, or saved unchanged.
  const edited = new Set<string>(), seen = new Map<string, string>();
  const read = (rel: string) => { try { return readFileSync(join(root, rel), 'utf8'); } catch { return null; } };
  try { for (const n of readdirSync(join(root, 'slides'))) if (n.endsWith('.slide')) seen.set(join('slides', n), read(join('slides', n)) ?? ''); } catch {}
  const changed = (rel: string) => {
    const key = join(rel), text = read(rel), was = seen.get(key);
    if (text == null) seen.delete(key); else seen.set(key, text);
    return text !== was;
  };
  const watcher = watch(root, { recursive: true }, (_e, f) => {
    if (!f || String(f).startsWith('.present') || String(f).endsWith('.tmp')) return;
    if (String(f) === 'plan.yaml') {
      clearTimeout(planTimer);
      planTimer = setTimeout(() => broadcast('plan', 1), 120);
      return;
    }
    if (/^references([\\/]|$)/.test(String(f))) {
      clearTimeout(refsTimer);
      refsTimer = setTimeout(() => broadcast('refs', 1), 150);
      return;
    }
    const full = /^(tracks|macros)[\\/]/.test(String(f));
    const slide = /^slides[\\/](.+)\.slide$/.exec(String(f))?.[1];
    if (slide && !changed(String(f))) return;
    if (slide) edited.add(slide);
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (full) await loadProjectMacros(root).catch(() => {});   // a macro an agent just added or changed
      for (const c of clients) c.write(`data: ${full ? 'reload' : 'deck'}\n\n`);
      if (edited.size) broadcast('edited', [...edited]);
      edited.clear();
    }, 80);
  });

  const body = (req: IncomingMessage) => new Promise<any>((ok, no) => {
    let s = '';
    req.on('data', d => { s += d; if (s.length > 5e6) { no(new Error('Too large')); req.destroy(); } });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { no(e); } });
  });
  const json = (res: ServerResponse, code: number, v: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(v));
  };

  const server = createServer(async (req, res) => {
    try {
      const addr = server.address() as { port: number };
      const url = new URL(req.url!, `http://127.0.0.1:${addr.port}`);
      // Pages carry the token, so a rebound DNS name must not be able to read them.
      if (![`127.0.0.1:${addr.port}`, `localhost:${addr.port}`].includes(req.headers.host ?? '')) { json(res, 403, { error: 'Foreign host' }); return; }
      if ((url.pathname === '/' || url.pathname === '/studio') && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'SAMEORIGIN' });
        res.end(url.pathname === '/' ? await page() : await studio.page(token, compile().deck.title));
        return;
      }
      if (!url.pathname.startsWith('/api/')) { json(res, 404, { error: 'Not found' }); return; }
      const origin = req.headers.origin;
      const allowed = [`http://127.0.0.1:${addr.port}`, `http://localhost:${addr.port}`];
      if (origin && !allowed.includes(origin)) { json(res, 403, { error: 'Foreign origin' }); return; }
      if ((req.headers['x-present-token'] ?? url.searchParams.get('token')) !== token) { json(res, 403, { error: 'Bad token' }); return; }

      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        res.write('\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (await studio.handle(req, res, url, () => body(req))) return;
      if (req.method === 'GET') {
        if (url.pathname === '/api/deck') { const c = compile(); json(res, 200, c); return; }
        if (url.pathname === '/api/annotations') { json(res, 200, readAnnotations(root)); return; }
        if (url.pathname === '/api/outline') { json(res, 200, deckOutline(root)); return; }
        if (url.pathname === '/api/plan') { json(res, 200, planProgress(root)); return; }
        if (url.pathname === '/api/problems') { json(res, 200, compile().diagnostics); return; }
      }
      if (req.method === 'POST') {
        const b = await body(req);
        if (url.pathname === '/api/ops') {
          await loadProjectMacros(root);   // an agent may have just added one, and the watcher can lag
          json(res, 200, applyOps(root, b.ops, b.baseRevision));
          return;
        }
        if (url.pathname === '/api/plan') { reviewPlan(root, b.status, b.comment); json(res, 200, planProgress(root)); return; }
        if (url.pathname === '/api/undo') { json(res, 200, undo(root)); return; }
        if (url.pathname === '/api/annotate') { json(res, 200, addAnnotation(root, b)); return; }
        if (url.pathname === '/api/resolve') { json(res, 200, { resolved: resolveAnnotations(root, b.ids) }); return; }
      }
      json(res, 404, { error: 'Not found' });
    } catch (e: any) {
      // A failure after the headers went out can only end the response. It must not end the server.
      if (res.headersSent) res.end(); else json(res, 400, { error: e.message });
    }
  });
  await new Promise<void>(ok => server.listen(port, '127.0.0.1', ok));
  const actual = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${actual}/`, token,
    close: async () => { watcher.close(); await studio.close(); for (const c of clients) c.end(); server.closeAllConnections(); await new Promise(ok => server.close(ok)); },
  };
}
