// Ops: the only way a tool changes a deck. A batch runs in memory against the current files, the
// result is compiled, and only then is anything written, atomically. Edits patch source by parser
// position, so untouched text stays byte-for-byte the same and diffs stay small.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { compileSlide } from './compile.ts';
import { annPath, compileDeck, readAnnotations, readDeck, revisionOf, slidePath, type Annotation } from './deck.ts';
import type { Diagnostic } from './diagnostics.ts';
import { findById, parseSlide, splitFront, walk, type XNode } from './parse.ts';

export type Op =
  | { op: 'setText'; slide: string; id: string; text: string }
  | { op: 'setAttr'; slide: string; id: string; name: string; value: string | null }
  | { op: 'insertNode'; slide: string; markup: string; parent?: string; after?: string; before?: string }
  | { op: 'removeNode'; slide: string; id: string }
  | { op: 'moveNode'; slide: string; id: string; parent?: string; after?: string; before?: string }
  | { op: 'setScore'; slide: string; score: any }
  | { op: 'setCueTiming'; slide: string; cue: string; at?: number; dur?: number }
  | { op: 'setNotes'; slide: string; notes: string }
  | { op: 'setBrief'; slide: string; brief: string }
  | { op: 'setTitle'; slide: string; title: string }
  | { op: 'setDeck'; title?: string; mode?: 'auto' | 'steps'; dwell?: number }
  | { op: 'addSlide'; id: string; source: string; after?: string }
  | { op: 'removeSlide'; id: string }
  | { op: 'reorderSlides'; order: string[] }
  | { op: 'replaceSlide'; id: string; source: string };

export interface ApplyResult { ok: boolean; revision: string; diagnostics: Diagnostic[]; error?: string; changed: string[]; }

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function tagEnd(body: string, start: number): number {
  let quote = '';
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (quote) { if (c === quote) quote = ''; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  throw new Error('Unterminated tag');
}
const need = (root: XNode, id: string): XNode => {
  const n = findById(root, id);
  if (!n) throw new Error(`No node with id "${id}"`);
  return n;
};
const closeStart = (body: string, n: XNode) => body.lastIndexOf('</', n.endIndex! + 1);
const selfClosed = (body: string, n: XNode) => body[tagEnd(body, n.startIndex!) - 1] === '/';

function setAttrIn(body: string, n: XNode, name: string, value: string | null): string {
  const s = n.startIndex!, e = tagEnd(body, s);
  const open = body.slice(s, e);
  const re = new RegExp(`\\s${name.replace(/[-:]/g, '\\$&')}(="[^"]*"|='[^']*')?(?=[\\s/]|$)`);
  const m = open.match(re);
  const val = value == null ? '' : ` ${name}="${value.replace(/"/g, '&quot;')}"`;
  if (m) return body.slice(0, s + m.index!) + val + body.slice(s + m.index! + m[0].length);
  if (value == null) return body;
  const at = open.endsWith('/') ? e - 1 : e;
  return body.slice(0, at).replace(/\s+$/, '') + val + (open.endsWith('/') ? ' ' : '') + body.slice(at);
}

function place(body: string, root: XNode, markup: string, o: { parent?: string; after?: string; before?: string }): string {
  if (o.after) { const n = need(root, o.after); return body.slice(0, n.endIndex! + 1) + '\n' + markup + body.slice(n.endIndex! + 1); }
  if (o.before) { const n = need(root, o.before); return body.slice(0, n.startIndex!) + markup + '\n' + body.slice(n.startIndex!); }
  if (o.parent) {
    const n = need(root, o.parent);
    if (selfClosed(body, n)) {
      const e = tagEnd(body, n.startIndex!);
      return body.slice(0, e - 1).replace(/\s+$/, '') + `>\n${markup}\n</${n.name}>` + body.slice(e + 1);
    }
    const c = closeStart(body, n);
    return body.slice(0, c) + markup + '\n' + body.slice(c);
  }
  return body.replace(/\s*$/, '') + '\n' + markup + '\n';
}

function cut(body: string, n: XNode): string {
  let s = n.startIndex!, e = n.endIndex! + 1;
  while (s > 0 && (body[s - 1] === ' ' || body[s - 1] === '\t')) s--;
  if (body[e] === '\n') e++;
  return body.slice(0, s) + body.slice(e);
}

function setFront(src: string, key: string, value: any): string {
  const { yaml, bodyStart } = splitFront(src);
  const doc = parseDocument(yaml);
  doc.set(key, value);
  return `---\n${doc.toString({ lineWidth: 0 }).trimEnd()}\n---\n${src.slice(bodyStart)}`;
}

export function patchSlide(src: string, op: Op): string {
  if (op.op === 'setScore') return setFront(src, 'score', op.score);
  if (op.op === 'setCueTiming') {
    const { yaml, bodyStart } = splitFront(src);
    const doc = parseDocument(yaml);
    const path = ['score', ...op.cue.split('.').map(x => (/^d+$/.test(x) ? +x : x))];
    if (!doc.hasIn(path)) throw new Error(`No cue at ${op.cue}`);
    if (op.at != null) doc.setIn([...path, 'at'], op.at);
    if (op.dur != null) doc.setIn([...path, 'dur'], op.dur);
    return `---
${doc.toString({ lineWidth: 0 }).trimEnd()}
---
${src.slice(bodyStart)}`;
  }
  if (op.op === 'setNotes') return setFront(src, 'notes', op.notes);
  if (op.op === 'setBrief') return setFront(src, 'brief', op.brief);
  if (op.op === 'setTitle') return setFront(src, 'title', op.title);
  const p = parseSlide(src), body = p.body, head = src.slice(0, p.frontEnd);
  switch (op.op) {
    case 'setText': {
      const n = need(p.root, op.id);
      const text = op.text.replace(/&(?!\w+;)/g, '&amp;').replace(/</g, '&lt;');
      if (selfClosed(body, n)) {
        const e = tagEnd(body, n.startIndex!);
        return head + body.slice(0, e - 1).replace(/\s+$/, '') + `>${text}</${n.name}>` + body.slice(e + 1);
      }
      return head + body.slice(0, tagEnd(body, n.startIndex!) + 1) + text + body.slice(closeStart(body, n));
    }
    case 'setAttr': return head + setAttrIn(body, need(p.root, op.id), op.name, op.value);
    case 'insertNode': return head + place(body, p.root, op.markup, op);
    case 'removeNode': return head + cut(body, need(p.root, op.id));
    case 'moveNode': {
      const n = need(p.root, op.id);
      const markup = body.slice(n.startIndex!, n.endIndex! + 1);
      const without = cut(body, n);
      return head + place(without, parseSlide(without).root, markup, op);
    }
    default: throw new Error(`Not a slide op: ${(op as Op).op}`);
  }
}

/** Run a batch. Nothing touches the disk unless the whole batch compiles without errors. */
export function applyOps(dir: string, ops: Op[], baseRevision: string): ApplyResult {
  const root = resolve(dir);
  const current = revisionOf(root);
  const refuse = (error: string, diagnostics: Diagnostic[] = []): ApplyResult => ({ ok: false, revision: current, diagnostics, error, changed: [] });
  if (baseRevision !== current) return refuse(`Stale revision: deck is at ${current}, you read ${baseRevision}. Read it again and reapply.`);

  const { meta } = readDeck(root);
  const files = new Map<string, string | null>();   // slide id → new source, null to delete
  let order = [...readDeck(root).order], orderChanged = false;
  const deckFields: Record<string, unknown> = {};
  const read = (id: string) => {
    if (files.has(id)) { const v = files.get(id); if (v == null) throw new Error(`Slide ${id} was removed`); return v; }
    const p = slidePath(root, id);
    if (!existsSync(p)) throw new Error(`No slide "${id}"`);
    return readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  };
  try {
    for (const op of ops) {
      if (op.op === 'setDeck') {
        for (const k of ['title', 'mode', 'dwell'] as const) if (op[k] !== undefined) deckFields[k] = op[k];
      } else if (op.op === 'addSlide') {
        if (!SAFE_ID.test(op.id)) throw new Error(`Bad slide id "${op.id}"`);
        if (order.includes(op.id)) throw new Error(`Slide ${op.id} already exists`);
        files.set(op.id, op.source);
        const at = op.after ? order.indexOf(op.after) + 1 : order.length;
        order.splice(at, 0, op.id);
        orderChanged = true;
      } else if (op.op === 'removeSlide') {
        read(op.id);
        files.set(op.id, null);
        order = order.filter(x => x !== op.id);
        orderChanged = true;
      } else if (op.op === 'reorderSlides') {
        if ([...op.order].sort().join() !== [...order].sort().join()) throw new Error('reorderSlides must list every slide exactly once');
        order = [...op.order];
        orderChanged = true;
      } else if (op.op === 'replaceSlide') {
        read(op.id);
        files.set(op.id, op.source);
      } else {
        files.set(op.slide, patchSlide(read(op.slide), op));
      }
    }
  } catch (e: any) { return refuse(e.message); }

  const diagnostics: Diagnostic[] = [];
  for (const [id, src] of files) if (src != null) diagnostics.push(...compileSlide(src, { id, images: () => 'data:,', stepLimit: meta.stepLimit }).diagnostics);
  if (diagnostics.some(d => d.severity === 'error')) return { ...refuse('Batch rejected: it would leave errors in the deck. Nothing was written.', diagnostics) };

  // Journal the old state, then write each file through a temp name.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(2).toString('hex');
  const hist = join(root, '.present', 'history');
  mkdirSync(hist, { recursive: true });
  const before: Record<string, string | null> = {};
  for (const id of files.keys()) { const p = slidePath(root, id); before[id] = existsSync(p) ? readFileSync(p, 'utf8') : null; }
  const deckYaml = join(root, 'deck.yaml');
  writeFileSync(join(hist, `${stamp}.json`), JSON.stringify({ ops, before, deckYaml: readFileSync(deckYaml, 'utf8'), revision: current }));
  for (const [id, src] of files) {
    const p = slidePath(root, id);
    if (src == null) { rmSync(p, { force: true }); continue; }
    atomic(p, src);
  }
  if (orderChanged || Object.keys(deckFields).length) {
    const doc = parseDocument(readFileSync(deckYaml, 'utf8'));
    if (orderChanged) doc.set('slides', order);
    for (const [k, v] of Object.entries(deckFields)) doc.set(k, v);
    atomic(deckYaml, doc.toString());
  }
  return { ok: true, revision: revisionOf(root), diagnostics: compileDeck(root).diagnostics, changed: [...files.keys()] };
}

function atomic(p: string, content: string) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, p);
}

/** Roll back the most recent batch. */
export function undo(dir: string): ApplyResult {
  const root = resolve(dir), hist = join(root, '.present', 'history');
  const list = existsSync(hist) ? readdirSync(hist).filter(f => f.endsWith('.json')).sort() : [];
  if (!list.length) return { ok: false, revision: revisionOf(root), diagnostics: [], error: 'Nothing to undo', changed: [] };
  const file = join(hist, list[list.length - 1]);
  const e = JSON.parse(readFileSync(file, 'utf8'));
  for (const [id, src] of Object.entries<string | null>(e.before)) {
    if (src == null) rmSync(slidePath(root, id), { force: true }); else atomic(slidePath(root, id), src);
  }
  atomic(join(root, 'deck.yaml'), e.deckYaml);
  rmSync(file);
  return { ok: true, revision: revisionOf(root), diagnostics: compileDeck(root).diagnostics, changed: Object.keys(e.before) };
}

// ---- annotations
function saveAnnotations(dir: string, list: Annotation[]) { atomic(annPath(dir), JSON.stringify(list, null, 2)); }

/** Attach a comment to a node. If the node has no explicit id, one is written into its source. */
export function addAnnotation(dir: string, a: { slide: string; node?: string; path?: number[]; step: number; comment: string }): Annotation {
  let node = a.node;
  if (!node && a.path) {
    const p = slidePath(dir, a.slide), src = readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    const parsed = parseSlide(src);
    const els: XNode[] = [];
    walk(parsed.root, e => els.push(e));
    const target = els[a.path[0]];
    if (!target) throw new Error('Cannot locate that part in the source');
    if (target.attribs?.id) node = target.attribs.id;
    else {
      node = `n-${randomBytes(2).toString('hex')}`;
      atomic(p, src.slice(0, parsed.frontEnd) + setAttrIn(parsed.body, target, 'id', node));
    }
  }
  const list = readAnnotations(dir);
  const ann: Annotation = { id: randomBytes(4).toString('hex'), slide: a.slide, node: node ?? '', step: a.step, comment: a.comment, status: 'open', created: new Date().toISOString() };
  list.push(ann);
  saveAnnotations(dir, list);
  return ann;
}
export function resolveAnnotations(dir: string, ids: string[], resolution?: string) {
  const list = readAnnotations(dir);
  let n = 0;
  for (const a of list) if (ids.includes(a.id) && a.status === 'open') { a.status = 'resolved'; a.resolution = resolution; n++; }
  saveAnnotations(dir, list);
  return n;
}
