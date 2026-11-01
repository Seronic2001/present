// A deck is a folder. This is the only module that touches it for reading.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { CompiledDeck } from './compiled.ts';
import { compileSlide } from './compile.ts';
import type { Diagnostic } from './diagnostics.ts';

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif' };

export interface DeckFiles { dir: string; meta: any; order: string[]; }

export function readDeck(dir: string): DeckFiles {
  const root = resolve(dir);
  const metaPath = join(root, 'deck.yaml');
  if (!existsSync(metaPath)) throw new Error(`No deck.yaml in ${root}`);
  const meta = (parseYaml(readFileSync(metaPath, 'utf8')) as any) ?? {};
  const slidesDir = join(root, 'slides');
  const onDisk = existsSync(slidesDir) ? readdirSync(slidesDir).filter(f => f.endsWith('.slide')).sort().map(f => f.replace(/\.slide$/, '')) : [];
  const order: string[] = (meta.slides ?? onDisk).map((s: string) => String(s).replace(/\.slide$/, ''));
  return { dir: root, meta, order };
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

export function compileDeck(dir: string, opts: { macros?: Record<string, any>; sourceMap?: boolean } = {}): { deck: CompiledDeck; diagnostics: Diagnostic[] } {
  const { dir: root, meta, order } = readDeck(dir);
  const images = (src: string) => {
    try {
      const p = confine(root, src);
      if (!existsSync(p) || !statSync(p).isFile()) return null;
      return `data:${MIME[extname(p).toLowerCase()] ?? 'application/octet-stream'};base64,${readFileSync(p).toString('base64')}`;
    } catch { return null; }
  };
  const diagnostics: Diagnostic[] = [];
  const slides = [];
  for (const id of order) {
    const p = slidePath(root, id);
    if (!existsSync(p)) {
      diagnostics.push({ code: 'missing-slide', severity: 'error', slide: id, message: `slides/${id}.slide does not exist`, fix: 'Create it or remove it from deck.yaml' });
      continue;
    }
    const r = compileSlide(readFileSync(p, 'utf8').replace(/\r\n/g, '\n'), { id, images, macros: opts.macros, stepLimit: meta.stepLimit, sourceMap: opts.sourceMap });
    slides.push(r.slide);
    diagnostics.push(...r.diagnostics);
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
  return {
    title: deck.title, revision: deck.revision,
    runningTimeMs: deck.slides.reduce((m, s) => m + s.phases.reduce((n, p) => n + p.end + deck.dwell, 0), 0),
    slides: deck.slides.map(s => ({
      id: s.id, title: s.title, brief: s.brief, steps: s.phases.length - 1,
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
