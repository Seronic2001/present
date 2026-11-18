// A deck is a folder. This is the only module that touches it for reading.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { CompiledDeck, SceneTiming } from './compiled.ts';
import { parseSlide } from './parse.ts';
import { compileSlide } from './compile.ts';
import { slideLabels } from './compiled.ts';
import type { Diagnostic } from './diagnostics.ts';

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif' };

export interface DeckFiles { dir: string; meta: any; order: string[]; parents: Record<string, string>; }

/** slides: in deck.yaml is a tree. An entry is an id, or { id, deep: [...] }. This is it depth first. */
function walkSlides(list: any[], order: string[], parents: Record<string, string>, parent?: string) {
  for (const e of list ?? []) {
    const id = String(typeof e === 'object' && e ? e.id : e).replace(/\.slide$/, '');
    order.push(id);
    if (parent) parents[id] = parent;
    if (typeof e === 'object' && e?.deep) walkSlides(e.deep, order, parents, id);
  }
}
/** The tree again, for deck.yaml. Siblings keep their relative order. */
export function nestSlides(order: string[], parents: Record<string, string>): any[] {
  const known = new Set(order), kids = new Map<string, string[]>();
  for (const id of order) { const p = parents[id] && known.has(parents[id]) ? parents[id] : ''; kids.set(p, [...(kids.get(p) ?? []), id]); }
  const tree = (id: string): any => (kids.get(id)?.length ? { id, deep: kids.get(id)!.map(tree) } : id);
  return (kids.get('') ?? []).map(tree);
}
export const flattenSlides = (tree: any[]) => { const order: string[] = []; walkSlides(tree, order, {}); return order; };

export function readDeck(dir: string): DeckFiles {
  const root = resolve(dir);
  const metaPath = join(root, 'deck.yaml');
  if (!existsSync(metaPath)) throw new Error(`No deck.yaml in ${root}. Start one with deck_create, or present init.`);
  const meta = (parseYaml(readFileSync(metaPath, 'utf8')) as any) ?? {};
  const slidesDir = join(root, 'slides');
  const onDisk = existsSync(slidesDir) ? readdirSync(slidesDir).filter(f => f.endsWith('.slide')).sort().map(f => f.replace(/\.slide$/, '')) : [];
  const order: string[] = [], parents: Record<string, string> = {};
  walkSlides(meta.slides ?? onDisk, order, parents);
  return { dir: root, meta, order, parents };
}

const SKIP = new Set(['node_modules', 'dist', 'build', 'release', 'target', 'vendor']);
/** Decks in or under a folder, and any the folder sits inside: where a server started in the wrong place should be. */
export function findDecks(dir: string, depth = 3): string[] {
  const out: string[] = [], root = resolve(dir);
  const down = (d: string, left: number) => {
    let names: string[];
    try { names = readdirSync(d); } catch { return; }
    if (d !== root && names.includes('deck.yaml')) { out.push(d); return; }
    if (left) for (const n of names) {
      if (n.startsWith('.') || SKIP.has(n)) continue;
      const p = join(d, n);
      try { if (statSync(p).isDirectory()) down(p, left - 1); } catch { /* gone, or not ours to read */ }
    }
  };
  down(root, depth);
  for (let p = dirname(root), n = 0; n < 3 && p !== dirname(p); p = dirname(p), n++) if (existsSync(join(p, 'deck.yaml'))) out.push(p);
  return out;
}

export const slidePath = (dir: string, id: string) => join(resolve(dir), 'slides', `${id}.slide`);

/** Paths from outside must stay in the deck. */
export function confine(dir: string, rel: string): string {
  const root = resolve(dir), p = resolve(root, rel);
  if (p !== root && !p.startsWith(root + sep)) throw new Error(`Path escapes the deck: ${rel}`);
  return p;
}

export function revisionOf(dir: string): string {
  const { order } = readDeck(dir);
  const h = createHash('sha256');
  const files = ['deck.yaml', 'theme.yaml', 'theme.css', ...order.map(id => join('slides', `${id}.slide`))];
  for (const f of files) {
    const p = join(resolve(dir), f);
    h.update(f.replaceAll(sep, '/'));
    if (existsSync(p)) h.update(readFileSync(p));
  }
  return h.digest('hex').slice(0, 16);
}

export function themeCss(dir: string): string {
  const root = resolve(dir);
  let css = '';
  const t = join(root, 'theme.yaml');
  if (existsSync(t)) {
    const v = (parseYaml(readFileSync(t, 'utf8')) as any) ?? {};
    css += `:root{${Object.entries(v).map(([k, x]) => `--${k}:${x};`).join('')}}\n`;
  }
  const c = join(root, 'theme.css');
  if (existsSync(c)) css += readFileSync(c, 'utf8');
  return css;
}

// ---- scenes: scenes/<name>.ts in the deck, each default-exporting (ctx) => { ... }
const SCENE_FILE = /\.(ts|js|mjs)$/;
/** The deck's scenes, by name, with their source. */
export function sceneFiles(dir: string): Map<string, string> {
  const d = join(resolve(dir), 'scenes'), out = new Map<string, string>();
  for (const f of existsSync(d) ? readdirSync(d).filter(x => SCENE_FILE.test(x)) : []) out.set(f.replace(SCENE_FILE, ''), readFileSync(join(d, f), 'utf8'));
  return out;
}
const timingsPath = (dir: string) => join(resolve(dir), '.present', 'scenes.json');
/** A measurement holds while neither the scene nor the slide has changed. */
export const sceneKey = (scene: string, slide: string) => createHash('sha256').update(scene).update('\0').update(slide.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
export function readSceneTimings(dir: string): Record<string, SceneTiming & { key: string }> {
  try { return JSON.parse(readFileSync(timingsPath(dir), 'utf8')); } catch { return {}; }
}
/** Records what a browser measured, so the compiler knows each scene step's length without one. */
export function writeSceneTimings(dir: string, measured: Record<string, SceneTiming>) {
  const root = resolve(dir), scenes = sceneFiles(root), all = readSceneTimings(root);
  for (const [id, t] of Object.entries(measured)) {
    const p = slidePath(root, id);
    if (!existsSync(p)) continue;
    const src = readFileSync(p, 'utf8'), name = String(parseSlide(src).front.score?.scene ?? '');
    if (!scenes.has(name)) continue;
    all[id] = { key: sceneKey(scenes.get(name)!, src), durs: t.durs, rests: t.rests, builds: t.builds, names: t.names };
  }
  mkdirSync(join(root, '.present'), { recursive: true });
  writeFileSync(timingsPath(root), JSON.stringify(all, null, 1));
  return all;
}

/** The phrases a deck defines for itself, under phrases: in deck.yaml. */
export const deckPhrases = (dir: string): Record<string, any> => readDeck(dir).meta.phrases ?? {};

export function compileDeck(dir: string, opts: { macros?: Record<string, any>; sourceMap?: boolean } = {}): { deck: CompiledDeck; diagnostics: Diagnostic[] } {
  const { dir: root, meta, order, parents } = readDeck(dir);
  const images = (src: string) => {
    try {
      const p = confine(root, src);
      if (!existsSync(p) || !statSync(p).isFile()) return null;
      return `data:${MIME[extname(p).toLowerCase()] ?? 'application/octet-stream'};base64,${readFileSync(p).toString('base64')}`;
    } catch { return null; }
  };
  const read = (src: string) => {
    try {
      const p = confine(root, src);
      return /\.html?$/i.test(p) && existsSync(p) && statSync(p).isFile() ? readFileSync(p, 'utf8') : null;
    } catch { return null; }
  };
  const diagnostics: Diagnostic[] = [];
  const slides = [];
  const scenes = sceneFiles(root), timings = scenes.size ? readSceneTimings(root) : {};
  for (const id of order) {
    const p = slidePath(root, id);
    if (!existsSync(p)) {
      diagnostics.push({ code: 'missing-slide', severity: 'error', slide: id, message: `slides/${id}.slide does not exist`, fix: 'Create it or remove it from deck.yaml' });
      continue;
    }
    const src = readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    const scene = (name: string) => {
      const code = scenes.get(name), t = timings[id];
      if (code == null) return { known: false };
      // Unmeasured, the number of ctx.step calls is a fair guess at the number of steps.
      return { known: true, timing: t && t.key === sceneKey(code, src) ? t : undefined, steps: (code.match(/\.step\s*\(/g) ?? []).length };
    };
    const r = compileSlide(src, { id, images, read, align: meta.align, macros: opts.macros, stepLimit: meta.stepLimit, sourceMap: opts.sourceMap, phrases: meta.phrases, scene });
    let depth = 0;
    for (let p = parents[id]; p; p = parents[p]) depth++;
    slides.push({ ...r.slide, depth, ...(parents[id] ? { parent: parents[id] } : {}) });
    diagnostics.push(...r.diagnostics);
  }
  for (const s of slides) for (const m of s.html.matchAll(/data-goto="([^"]*)"/g)) {
    if (!order.includes(m[1])) diagnostics.push({ code: 'bad-goto', severity: 'error', slide: s.id, message: `goto "${m[1]}" is not a slide`, fix: 'Use the id of a slide in this deck' });
  }
  return {
    deck: {
      title: String(meta.title ?? 'Untitled'), mode: meta.mode === 'steps' ? 'steps' : 'auto',
      motion: meta.motion === 'on' ? 'on' : 'auto', dwell: Number(meta.dwell ?? 700),
      css: themeCss(root), slides, revision: revisionOf(root),
    },
    diagnostics,
  };
}

export function deckOutline(dir: string) {
  const { deck, diagnostics } = compileDeck(dir);
  const annotations = readAnnotations(dir).filter(a => a.status === 'open');
  const labels = slideLabels(deck.slides);
  const time = (list: typeof deck.slides) => list.reduce((m, s) => m + s.phases.reduce((n, p) => n + p.end + deck.dwell, 0), 0);
  return {
    title: deck.title, revision: deck.revision,
    runningTimeMs: time(deck.slides.filter(s => !s.parent)),     // the main path: deep dives are optional
    deepDiveMs: time(deck.slides.filter(s => s.parent)),
    slides: deck.slides.map(s => ({
      id: s.id, label: labels.get(s.id), parent: s.parent, depth: s.depth ?? 0, title: s.title, brief: s.brief, steps: s.phases.length - 1,
      phaseMs: s.phases.map(p => p.end), spots: s.spots.map(x => x.id),
      errors: diagnostics.filter(d => d.slide === s.id && d.severity === 'error').length,
      warnings: diagnostics.filter(d => d.slide === s.id && d.severity === 'warning').length,
      annotations: annotations.filter(a => a.slide === s.id).length,
    })),
  };
}

export interface Annotation { id: string; slide: string; node: string; step: number; comment: string; status: 'open' | 'resolved'; created: string; resolution?: string; }
const annPath = (dir: string) => join(resolve(dir), '.present', 'annotations.json');
export function readAnnotations(dir: string): Annotation[] {
  const p = annPath(dir);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
}
export { annPath, relative };
