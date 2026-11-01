// The Studio app's backend: frames for screenshots, the reference library, and the agent chat.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { addReference, compileDeck, imageMime, listReferences, readReference, referenceFile, removeReference } from '@present/core';
import { fontCss, Renderer } from '@present/render';
import { AGENT_LABEL, AGENTS, Chat, onPath, type AgentId, type Invocation } from './agents.ts';

const here = dirname(fileURLToPath(import.meta.url));
const MAX_UPLOAD = 200e6;

export interface StudioOptions { resolveCmd?: (agent: AgentId, session?: string) => Invocation; available?: AgentId[]; }

function rawBody(req: IncomingMessage) {
  return new Promise<Buffer>((ok, no) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', d => {
      size += d.length;
      if (size > MAX_UPLOAD) { no(new Error('File is over 200 MB')); req.destroy(); return; }
      parts.push(d);
    });
    req.on('end', () => ok(Buffer.concat(parts)));
    req.on('error', no);
  });
}

export function studioApi(root: string, broadcast: (event: string, data: unknown) => void, opts: StudioOptions = {}) {
  const renderer = new Renderer(root);
  const cli = resolve(here, '../../cli/src/bin.ts');
  const chat = new Chat(root, { command: process.execPath, args: [cli, 'mcp', root] }, s => broadcast('chat', s), opts.resolveCmd);
  const available = opts.available ?? AGENTS.filter(a => onPath(a));

  // One headless page, so frames take turns. Slides that did not change keep their picture.
  let queue: Promise<unknown> = Promise.resolve();
  const frames = new Map<string, Buffer>();
  const frame = (slide: number, step?: number, t?: number) => {
    const { deck } = compileDeck(root, { sourceMap: true });
    const s = deck.slides[slide - 1];
    if (!s) throw new Error(`No slide ${slide}`);
    const key = createHash('sha256').update(JSON.stringify([s, deck.css, step, t])).digest('hex');
    const known = frames.get(key);
    if (known) return Promise.resolve(known);
    const run = queue.then(async () => {
      const { png } = await renderer.frame({ slide, step, t });
      if (frames.size > 200) frames.clear();
      frames.set(key, png);
      return png;
    });
    queue = run.catch(() => {});
    return run;
  };

  const json = (res: ServerResponse, code: number, v: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(v));
  };

  /** Answers a request if it is Studio's. Runs after the token and origin checks. */
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, body: () => Promise<any>): Promise<boolean> {
    const p = url.pathname, get = req.method === 'GET', post = req.method === 'POST', q = url.searchParams;
    const num = (k: string) => (q.has(k) ? +q.get(k)! : undefined);

    if (get && p === '/api/frame') {
      const png = await frame(num('slide') ?? 1, num('step'), num('t'));
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' });
      res.end(png);
      return true;
    }
    if (p === '/api/references') {
      if (get) json(res, 200, listReferences(root));
      else if (post) { json(res, 200, addReference(root, q.get('name') ?? 'file', await rawBody(req), q.get('folder') ?? '')); broadcast('refs', 1); }
      else if (req.method === 'DELETE') { json(res, 200, removeReference(root, q.get('path') ?? '')); broadcast('refs', 1); }
      else return false;
      return true;
    }
    if (get && p === '/api/reference-file') {
      // Uploads are untrusted. Only raster images display; anything else downloads, and nothing here can script this origin.
      const path = q.get('path') ?? '', mime = imageMime(path);
      res.writeHead(200, { 'content-type': mime ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'", ...(mime ? {} : { 'content-disposition': 'attachment' }) });
      res.end(readFileSync(referenceFile(root, path)));
      return true;
    }
    if (get && p === '/api/reference-text') { json(res, 200, await readReference(root, q.get('path') ?? '', { offset: num('offset'), limit: num('limit') })); return true; }
    if (get && p === '/api/agents') { json(res, 200, AGENTS.map(id => ({ id, label: AGENT_LABEL[id], available: available.includes(id) }))); return true; }
    if (get && p === '/api/chat') { json(res, 200, chat.state); return true; }
    if (post && p === '/api/chat') {
      const b = await body();
      if (!available.includes(b.agent)) throw new Error(`${AGENT_LABEL[b.agent as AgentId] ?? b.agent} is not installed`);
      chat.send(b.agent, String(b.text ?? ''), b.context ?? [], b.viewing);
      json(res, 200, { ok: true });
      return true;
    }
    if (post && p === '/api/chat/stop') { chat.stop(); json(res, 200, { ok: true }); return true; }
    if (post && p === '/api/chat/reset') { chat.reset(); json(res, 200, { ok: true }); return true; }
    return false;
  }

  async function page(token: string, title: string) {
    const r = await esbuild.build({
      entryPoints: [join(here, 'shell.tsx')], bundle: true, format: 'iife', minify: true, write: false,
      jsx: 'automatic', jsxImportSource: 'preact', logLevel: 'silent',
    });
    const esc = title.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc} · Present Studio</title><style>${fontCss()}</style></head>
<body><script>window.__PRESENT_DEV=${JSON.stringify({ token })}</script><script>${r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
  }

  return { handle, page, close: async () => { chat.stop(); await renderer.close(); } };
}
