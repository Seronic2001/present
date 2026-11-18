// Ops: the only way a tool changes a deck. A batch runs in memory against the current files, the
// result is compiled, and only then is anything written, atomically. Edits patch source by parser
// position, so untouched text stays byte-for-byte the same and diffs stay small.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { compileSlide } from './compile.ts';
import { annPath, compileDeck, nestSlides, readAnnotations, readDeck, revisionOf, sceneFiles, slidePath, type Annotation } from './deck.ts';
import type { Diagnostic } from './diagnostics.ts';
import { PATTERNS } from './patterns.ts';
import { findById, parseSlide, splitFront, walk, type XNode } from './parse.ts';

export type Op =
  | { op: 'setText'; slide: string; id: string; text: string }
  | { op: 'setAttr'; slide: string; id: string; name: string; value: string | null }
  | { op: 'insertNode'; slide: string; markup: string; parent?: string; after?: string; before?: string }
  | { op: 'removeNode'; slide: string; id: string }
  | { op: 'moveNode'; slide: string; id: string; parent?: string; after?: string; before?: string }
  | { op: 'setScore'; slide: string; score: any }
  | { op: 'setStep'; slide: string; step: number; cues?: any[]; name?: string; loop?: any; auto?: number | boolean | null }
  | { op: 'appendCue'; slide: string; step: number; cue: any }
  | { op: 'setCueTiming'; slide: string; cue: string; at?: number; dur?: number }
  | { op: 'setNotes'; slide: string; notes: string }
  | { op: 'setBrief'; slide: string; brief: string }
  | { op: 'setTitle'; slide: string; title: string }
  | { op: 'setAlign'; slide: string; align: 'top' | 'center' }
  | { op: 'setDeck'; title?: string; mode?: 'auto' | 'steps'; dwell?: number; align?: 'top' | 'center' }
  | { op: 'addSlide'; id: string; source?: string; pattern?: string; after?: string; under?: string }
  | { op: 'moveSlide'; id: string; under?: string | null; after?: string }
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

/** One step of a score, so a change to its motion need not resend the slide. Step 0 is the intro. */
function patchStep(src: string, op: Extract<Op, { op: 'setStep' | 'appendCue' }>): string {
  const { yaml, bodyStart } = splitFront(src);
  const doc = parseDocument(yaml);
  const score: any = doc.get('score', true) ? (doc.toJS() as any).score ?? {} : {};
  if (!Number.isInteger(op.step) || op.step < 0) throw new Error(`step is 0 for the intro, or 1 and up for the steps; got ${op.step}`);
  const steps: any[] = score.steps ?? [];
  if (op.step > steps.length + 1 || (op.op === 'appendCue' && op.step > steps.length)) throw new Error(`This slide has ${steps.length} steps; step ${op.step} would leave a gap`);
  // The intro may be written as a bare list. A step is { name, cues, loop?, auto? }.
  const read = (v: any) => (Array.isArray(v) ? { cues: v } : { ...(v ?? {}) });
  const cur = op.step === 0 ? read(score.intro) : read(steps[op.step - 1] ?? { name: (op.op === 'setStep' && op.name) || `step ${op.step}` });
  if (op.op === 'appendCue') cur.cues = [...(cur.cues ?? []), op.cue];
  else {
    if (op.cues !== undefined) cur.cues = op.cues;
    if (op.name !== undefined) cur.name = op.name;
    if (op.loop !== undefined) { if (op.loop == null) delete cur.loop; else cur.loop = op.loop; }
    if (op.auto !== undefined) { if (op.auto == null) delete cur.auto; else cur.auto = op.auto; }
  }
  if (op.step === 0) doc.setIn(['score', 'intro'], doc.createNode(Object.keys(cur).length === 1 && cur.cues ? cur.cues : cur));
  else if (op.step <= steps.length) doc.setIn(['score', 'steps', op.step - 1], doc.createNode(cur));
  else doc.setIn(['score', 'steps'], doc.createNode([...steps, cur]));
  return `---\n${doc.toString({ lineWidth: 0 }).trimEnd()}\n---\n${src.slice(bodyStart)}`;
}

/** Prose with ": " in it breaks YAML unless quoted, and a brief is prose. Quote what would not parse. */
export function quoteProse(src: string): string {
  const { yaml, bodyStart } = splitFront(src);
  if (!yaml || !parseDocument(yaml).errors.length) return src;
  const fixed = yaml.replace(/^(title|brief|notes|aside):[ \t]+(?!["'|>])(.*\S)[ \t]*$/gm, (_, k, v) => `${k}: ${JSON.stringify(v)}`);
  return parseDocument(fixed).errors.length ? src : `---\n${fixed}\n---\n${src.slice(bodyStart)}`;
}

export function patchSlide(src: string, op: Op): string {
  if (op.op === 'setScore') return setFront(src, 'score', op.score);
  if (op.op === 'setStep' || op.op === 'appendCue') return patchStep(src, op);
  if (op.op === 'setCueTiming') {
    const { yaml, bodyStart } = splitFront(src);
    const doc = parseDocument(yaml);
    const path = ['score', ...op.cue.split('.').map(x => (/^\d+$/.test(x) ? +x : x))];
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
  if (op.op === 'setAlign') return setFront(src, 'align', op.align);
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

// ---- edits made outside the tools: a script, an editor, a person. Each becomes a step of its own in the
// history, so deck_undo can reverse it, and a later batch cannot silently absorb it.
const seenPath = (root: string) => join(root, '.present', 'seen.json');
function snapshot(root: string) {
  const dir = join(root, 'slides'), files: Record<string, string> = {};
  for (const f of existsSync(dir) ? readdirSync(dir).filter(x => x.endsWith('.slide')) : []) files[f.replace(/\.slide$/, '')] = readFileSync(join(dir, f), 'utf8');
  return { deckYaml: readFileSync(join(root, 'deck.yaml'), 'utf8'), files };
}
const remember = (root: string) => atomic(seenPath(root), JSON.stringify(snapshot(root)));
const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(2).toString('hex');

/** Compares the deck with the last state the tools saw. True if something else changed it. */
export function noteOutsideEdits(dir: string): boolean {
  const root = resolve(dir);
  if (!existsSync(join(root, 'deck.yaml'))) return false;
  if (!existsSync(seenPath(root))) { remember(root); return false; }
  const old = JSON.parse(readFileSync(seenPath(root), 'utf8')) as ReturnType<typeof snapshot>, now = snapshot(root);
  const before: Record<string, string | null> = {};
  for (const id of new Set([...Object.keys(old.files), ...Object.keys(now.files)])) if (old.files[id] !== now.files[id]) before[id] = old.files[id] ?? null;
  if (!Object.keys(before).length && old.deckYaml === now.deckYaml) return false;
  const hist = join(root, '.present', 'history');
  mkdirSync(hist, { recursive: true });
  writeFileSync(join(hist, `${stampNow()}.json`), JSON.stringify({ ops: [{ op: 'outside' }], before, deckYaml: old.deckYaml }));
  remember(root);
  return true;
}

/** Run a batch. Nothing touches the disk unless the whole batch compiles without errors. */
export function applyOps(dir: string, ops: Op[], baseRevision: string): ApplyResult {
  const root = resolve(dir);
  noteOutsideEdits(root);
  const current = revisionOf(root);
  const refuse = (error: string, diagnostics: Diagnostic[] = []): ApplyResult => ({ ok: false, revision: current, diagnostics, error, changed: [] });
  if (baseRevision !== current) return refuse(`Stale revision: deck is at ${current}, you read ${baseRevision}. Read it again and reapply.`);

  const { meta } = readDeck(root);
  const files = new Map<string, string | null>();   // slide id → new source, null to delete
  let order = [...readDeck(root).order], orderChanged = false;
  const parents = { ...readDeck(root).parents };
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
        for (const k of ['title', 'mode', 'dwell', 'align'] as const) if (op[k] !== undefined) deckFields[k] = op[k];
      } else if (op.op === 'addSlide') {
        if (!SAFE_ID.test(op.id)) throw new Error(`Bad slide id "${op.id}"`);
        if (order.includes(op.id)) throw new Error(`Slide ${op.id} already exists`);
        const start = op.pattern == null ? op.source : PATTERNS[op.pattern]?.source;
        if (start == null) throw new Error(op.pattern == null ? 'addSlide needs source or pattern' : `No pattern "${op.pattern}". Patterns: ${Object.keys(PATTERNS).join(', ')}`);
        files.set(op.id, quoteProse(start));
        if (op.under != null && !order.includes(op.under)) throw new Error(`No slide "${op.under}" to go under`);
        if (op.under != null) parents[op.id] = op.under;
        const at = op.after ? order.indexOf(op.after) + 1 : order.length;
        order.splice(at, 0, op.id);
        orderChanged = true;
      } else if (op.op === 'moveSlide') {
        if (!order.includes(op.id)) throw new Error(`No slide "${op.id}"`);
        if (op.under !== undefined) {
          if (op.under != null && !order.includes(op.under)) throw new Error(`No slide "${op.under}" to go under`);
          for (let p: string | null | undefined = op.under; p; p = parents[p]) if (p === op.id) throw new Error(`${op.id} cannot go under itself or its own deep dive`);
          if (op.under == null) delete parents[op.id]; else parents[op.id] = op.under;
        }
        if (op.after != null) {
          if (!order.includes(op.after)) throw new Error(`No slide "${op.after}"`);
          order = order.filter(x => x !== op.id);
          order.splice(order.indexOf(op.after) + 1, 0, op.id);
        }
        orderChanged = true;
      } else if (op.op === 'removeSlide') {
        read(op.id);
        files.set(op.id, null);
        order = order.filter(x => x !== op.id);
        // Its deep dives survive it, one level up.
        for (const [kid, p] of Object.entries(parents)) if (p === op.id) { if (parents[op.id]) parents[kid] = parents[op.id]; else delete parents[kid]; }
        delete parents[op.id];
        orderChanged = true;
      } else if (op.op === 'reorderSlides') {
        // Any subset: the slides named take each other's places, in the order given. Listing the main
        // path reorders the talk, and each deep dive stays under its slide.
        const unknown = op.order.filter(id => !order.includes(id)), twice = op.order.filter((id, k) => op.order.indexOf(id) !== k);
        if (unknown.length) throw new Error(`reorderSlides: no slide ${unknown.join(', ')}`);
        if (twice.length) throw new Error(`reorderSlides lists ${[...new Set(twice)].join(', ')} more than once`);
        const named = new Set(op.order), next = [...op.order];
        order = order.map(id => (named.has(id) ? next.shift()! : id));
        orderChanged = true;
      } else if (op.op === 'replaceSlide') {
        read(op.id);
        files.set(op.id, quoteProse(op.source));
      } else {
        files.set(op.slide, patchSlide(read(op.slide), op));
      }
    }
  } catch (e: any) { return refuse(e.message); }

  const diagnostics: Diagnostic[] = [];
  const scenes = sceneFiles(root);
  for (const [id, src] of files) if (src != null) diagnostics.push(...compileSlide(src, { id, images: () => 'data:,', stepLimit: meta.stepLimit, phrases: meta.phrases, scene: name => ({ known: scenes.has(name) }) }).diagnostics);
  if (diagnostics.some(d => d.severity === 'error')) return { ...refuse('Batch rejected: it would leave errors in the deck. Nothing was written.', diagnostics) };

  // Journal the old state, then write each file through a temp name.
  const stamp = stampNow();
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
    if (orderChanged) doc.set('slides', nestSlides(order, parents));
    for (const [k, v] of Object.entries(deckFields)) doc.set(k, v);
    atomic(deckYaml, doc.toString());
  }
  remember(root);
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
  noteOutsideEdits(root);
  const list = existsSync(hist) ? readdirSync(hist).filter(f => f.endsWith('.json')).sort() : [];
  if (!list.length) return { ok: false, revision: revisionOf(root), diagnostics: [], error: 'Nothing to undo', changed: [] };
  const file = join(hist, list[list.length - 1]);
  const e = JSON.parse(readFileSync(file, 'utf8'));
  for (const [id, src] of Object.entries<string | null>(e.before)) {
    if (src == null) rmSync(slidePath(root, id), { force: true }); else atomic(slidePath(root, id), src);
  }
  atomic(join(root, 'deck.yaml'), e.deckYaml);
  rmSync(file);
  remember(root);
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
