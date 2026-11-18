// The library: components saved across projects, in the spirit of shadcn. Adding one copies its source
// into the deck, so the deck owns it and has no dependency. It lives in one plain folder of the
// human's, so it can be read, edited, or kept in git. PRESENT_LIBRARY moves it.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { readDeck, slidePath } from './deck.ts';
import { parseSlide, walk, type XNode } from './parse.ts';
import { PHRASES } from './phrases.ts';
import { CUES } from './score.ts';

export interface LibraryItem {
  name: string; doc: string; useWhen: string;
  macros: string[]; tracks: string[]; phrases: string[]; scenes?: string[];
  slide: boolean; css: boolean;
  code: boolean;          // macros and tracks run: treat an item with them as code
  auto: boolean;          // harvested, not chosen by anyone
  from: string; savedAt: string; hash: string;
}
export interface SaveRequest { name: string; doc: string; useWhen?: string; slide?: string; macros?: string[]; tracks?: string[]; scenes?: string[]; phrases?: string[]; css?: string; }
const CODE_KINDS = ['macros', 'tracks', 'scenes'] as const;

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_FILE = 64 * 1024;   // past this it is a deck's private engine, not a component
export const libraryDir = () => resolve(process.env.PRESENT_LIBRARY ?? join(homedir(), '.present', 'library'));
const itemDir = (name: string) => {
  if (!SAFE_NAME.test(name)) throw new Error(`Bad library name "${name}": use letters, numbers, - and _`);
  return join(libraryDir(), name);
};
const codeFile = (root: string, kind: string, name: string) => ['ts', 'js', 'mjs'].map(e => join(root, kind, `${name}.${e}`)).find(existsSync);

export function listLibrary(): LibraryItem[] {
  const dir = libraryDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => !n.startsWith('.')).flatMap(n => {
    try { return [JSON.parse(readFileSync(join(dir, n, 'item.json'), 'utf8')) as LibraryItem]; } catch { return []; }
  }).sort((a, b) => a.name.localeCompare(b.name));
}
export function readItem(name: string): LibraryItem {
  const f = join(itemDir(name), 'item.json');
  if (!existsSync(f)) throw new Error(`No library item "${name}". In the library: ${listLibrary().map(i => i.name).join(', ') || 'nothing yet'}`);
  return JSON.parse(readFileSync(f, 'utf8'));
}

/** What a piece of slide or phrase text needs from its deck. Built-ins are not dependencies. */
function needs(root: string, text: string, deckPhrases: Record<string, any>, out = { macros: new Set<string>(), tracks: new Set<string>(), scenes: new Set<string>(), phrases: new Set<string>() }) {
  for (const m of text.matchAll(/<([A-Z]\w*)/g)) if (codeFile(root, 'macros', m[1])) out.macros.add(m[1]);
  for (const m of text.matchAll(/"?track"?:\s*["']?([\w-]+)/g)) if (codeFile(root, 'tracks', m[1])) out.tracks.add(m[1]);
  for (const m of text.matchAll(/"?scene"?:\s*["']?([\w-]+)/g)) if (codeFile(root, 'scenes', m[1])) out.scenes.add(m[1]);
  for (const m of text.matchAll(/"?use"?:\s*["']?([\w-]+)/g)) {
    if (deckPhrases[m[1]] && !out.phrases.has(m[1])) { out.phrases.add(m[1]); needs(root, JSON.stringify(deckPhrases[m[1]].cues ?? []), deckPhrases, out); }
  }
  return out;
}

/** Saves a component with everything it depends on. Replacing one keeps the old under .replaced/. */
export function saveToLibrary(dir: string, r: SaveRequest, auto = false): LibraryItem {
  const root = resolve(dir), target = itemDir(r.name), deckPhrases = readDeck(root).meta.phrases ?? {};
  const slide = r.slide ? readFileSync(slidePath(root, r.slide), 'utf8') : null;
  if (r.slide && slide == null) throw new Error(`No slide "${r.slide}"`);
  const found = needs(root, slide ?? '', deckPhrases);
  for (const k of r.macros ?? []) found.macros.add(k);
  for (const k of r.tracks ?? []) found.tracks.add(k);
  for (const k of r.scenes ?? []) found.scenes.add(k);
  for (const k of r.phrases ?? []) { found.phrases.add(k); needs(root, JSON.stringify(deckPhrases[k]?.cues ?? []), deckPhrases, found); }
  for (const k of found.macros) if (!codeFile(root, 'macros', k)) throw new Error(`This deck has no macros/${k}`);
  for (const k of found.tracks) if (!codeFile(root, 'tracks', k)) throw new Error(`This deck has no tracks/${k}`);
  for (const k of found.scenes) if (!codeFile(root, 'scenes', k)) throw new Error(`This deck has no scenes/${k}`);
  for (const k of found.phrases) if (!deckPhrases[k]) throw new Error(`This deck has no phrase "${k}"${PHRASES[k] ? ': it is built in, and needs no saving' : ''}`);
  if (!slide && !found.macros.size && !found.tracks.size && !found.scenes.size && !found.phrases.size && !r.css) throw new Error('Nothing to save: give a slide, macros, tracks, scenes, phrases or css');

  const tmp = `${target}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const hash = createHash('sha256');
  const put = (rel: string, text: string) => { const p = join(tmp, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); hash.update(rel).update(text); };
  for (const kind of CODE_KINDS) for (const k of found[kind]) { const f = codeFile(root, kind, k)!; put(`${kind}/${basename(f)}`, readFileSync(f, 'utf8')); }
  const phrases = Object.fromEntries([...found.phrases].sort().map(k => [k, deckPhrases[k]]));
  if (found.phrases.size) put('phrases.json', JSON.stringify(phrases, null, 2));
  if (slide) put('slide.slide', slide);
  if (r.css) put('style.css', r.css);
  const item: LibraryItem = {
    name: r.name, doc: r.doc, useWhen: r.useWhen ?? '', macros: [...found.macros].sort(), tracks: [...found.tracks].sort(), scenes: [...found.scenes].sort(), phrases: Object.keys(phrases),
    slide: !!slide, css: !!r.css, code: found.macros.size + found.tracks.size + found.scenes.size > 0, auto, from: root, savedAt: new Date().toISOString(), hash: hash.digest('hex').slice(0, 16),
  };
  writeFileSync(join(tmp, 'item.json'), JSON.stringify(item, null, 2));
  if (existsSync(target)) {
    const old = join(libraryDir(), '.replaced');
    mkdirSync(old, { recursive: true });
    renameSync(target, join(old, `${r.name}-${Date.now()}`));
  }
  renameSync(tmp, target);
  return item;
}

/** Saves what a deck defined for itself, so nothing good is lost with the project. Whole slides are not
 *  taken: they hold the deck's content, and saving one is a judgement left to the agent. */
export function harvest(dir: string): LibraryItem[] {
  const root = resolve(dir), { meta } = readDeck(root);
  if (meta.library === false) return [];
  const known = new Map(listLibrary().map(i => [i.name, i]));
  const label = basename(root).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'deck';
  const saved: LibraryItem[] = [];
  const take = (name: string, doc: string, part: Partial<SaveRequest>, fingerprint: string) => {
    if (!SAFE_NAME.test(name)) return;
    const same = (i?: LibraryItem) => i && i.auto && i.from === root;
    // A name another deck or a person holds is theirs. This one takes a name of its own.
    const key = !known.has(name) || same(known.get(name)) ? name : `${name}-${label}`;
    if (known.get(key)?.hash && !same(known.get(key)) && key !== name) return;
    const seen = join(itemDir(key), '.source');
    if (existsSync(seen) && readFileSync(seen, 'utf8') === fingerprint) return;
    const item = saveToLibrary(root, { name: key, doc, ...part }, true);
    writeFileSync(seen, fingerprint);
    saved.push(item);
  };
  const header = (f: string) => /^\/\/\s*(.+)$/m.exec(readFileSync(f, 'utf8'))?.[1] ?? /doc:\s*['"`]([^'"`]+)/.exec(readFileSync(f, 'utf8'))?.[1];
  for (const [name, p] of Object.entries<any>(meta.phrases ?? {})) if (p?.cues) take(name, p.doc ?? `Motion from ${label}`, { phrases: [name] }, JSON.stringify(p));
  for (const kind of CODE_KINDS) {
    const d = join(root, kind);
    for (const f of existsSync(d) ? readdirSync(d).filter(x => /\.(ts|js|mjs)$/.test(x)) : []) {
      const p = join(d, f);
      if (statSync(p).size > MAX_FILE) continue;
      const name = f.replace(/\.\w+$/, '');
      take(name, header(p) ?? `${{ macros: 'Macro', tracks: 'Track', scenes: 'Scene' }[kind]} from ${label}`, { [kind]: [name] }, readFileSync(p, 'utf8'));
    }
  }
  return saved;
}

/** Copies a component into a deck. Files that differ are refused, so nobody's edits are overwritten. */
export function addFromLibrary(dir: string, name: string, o: { overwrite?: boolean } = {}) {
  const root = resolve(dir), item = readItem(name), src = itemDir(name);
  const copies = CODE_KINDS.flatMap(kind => {
    const d = join(src, kind);
    return existsSync(d) ? readdirSync(d).map(f => ({ from: join(d, f), to: join(root, kind, f), rel: `${kind}/${f}` })) : [];
  });
  const phrases: Record<string, any> = existsSync(join(src, 'phrases.json')) ? JSON.parse(readFileSync(join(src, 'phrases.json'), 'utf8')) : {};
  const have = readDeck(root).meta.phrases ?? {};
  const clash = [
    ...copies.filter(c => existsSync(c.to) && readFileSync(c.to, 'utf8') !== readFileSync(c.from, 'utf8')).map(c => c.rel),
    ...Object.keys(phrases).filter(k => have[k] && JSON.stringify(have[k]) !== JSON.stringify(phrases[k])).map(k => `phrase ${k}`),
  ];
  if (clash.length && !o.overwrite) throw new Error(`This deck has its own version of: ${clash.join(', ')}. Nothing was changed. Pass overwrite to replace them.`);

  const added: string[] = [];
  for (const c of copies) {
    if (existsSync(c.to) && readFileSync(c.to, 'utf8') === readFileSync(c.from, 'utf8')) continue;
    mkdirSync(join(c.to, '..'), { recursive: true });
    cpSync(c.from, c.to);
    added.push(c.rel);
  }
  const fresh = Object.keys(phrases).filter(k => JSON.stringify(have[k]) !== JSON.stringify(phrases[k]));
  if (fresh.length) {
    const f = join(root, 'deck.yaml'), doc = parseDocument(readFileSync(f, 'utf8'));
    for (const k of fresh) doc.setIn(['phrases', k], doc.createNode(phrases[k]));
    writeFileSync(f, doc.toString());
    added.push(...fresh.map(k => `phrase ${k}`));
  }
  if (item.css) {
    const f = join(root, 'theme.css'), mark = `/* library: ${name} */`, css = existsSync(f) ? readFileSync(f, 'utf8') : '';
    if (!css.includes(mark)) { writeFileSync(f, `${css}${css ? '\n' : ''}${mark}\n${readFileSync(join(src, 'style.css'), 'utf8')}\n`); added.push('theme.css'); }
  }
  return { added, slide: item.slide ? readFileSync(join(src, 'slide.slide'), 'utf8') : null, code: item.code };
}

/** Items by what they are for: every word of the query is looked for in the name, doc, useWhen and parts. */
export function searchLibrary(query: string, limit = 8) {
  const stem = (w: string) => w.toLowerCase().replace(/(ing|ed|es|s)$/, '');
  const words = query.split(/[^A-Za-z0-9]+/).filter(w => w.length > 2).map(stem);
  const scored = listLibrary().map(i => {
    const name = i.name.split(/(?=[A-Z])|[-_]/).map(stem), text = `${i.doc} ${i.useWhen} ${[...i.macros, ...i.tracks, ...(i.scenes ?? []), ...i.phrases].join(' ')}`.split(/[^A-Za-z0-9]+/).map(stem);
    const score = words.reduce((n, w) => n + (name.includes(w) ? 3 : 0) + (text.includes(w) ? 1 : 0) + (text.some(t => t.length > 3 && w.length > 3 && (t.startsWith(w) || w.startsWith(t))) ? .5 : 0), 0);
    return { score, i };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.i.name.localeCompare(b.i.name));
  return scored.slice(0, limit).map(({ i, score }) => ({ name: i.name, doc: i.doc, useWhen: i.useWhen, kinds: [i.macros.length && 'macro', i.tracks.length && 'track', i.scenes?.length && 'scene', i.phrases.length && 'phrase', i.slide && 'slide'].filter(Boolean), code: i.code, score: +score.toFixed(1) }));
}

export function removeFromLibrary(name: string) {
  readItem(name);
  rmSync(itemDir(name), { recursive: true, force: true });
}

const MIN_PARTS = 6, MIN_CUES = 3, MOTION_SLIDES = 3, MAX_HINTS = 5, MIN_SLIDES_TO_SAVE = 5;
/** The tree of a drawing, with its text and values gone: two graphs with different labels are one drawing. */
const shapeOf = (n: XNode): string => `${n.name}(${(n.children ?? []).filter(c => c.type === 'tag').map(shapeOf).join(',')})`;

/** What this deck could give the library: suggestions for the agent, not faults in the deck. */
export function reuseReport(dir: string) {
  const root = resolve(dir), { meta, order } = readDeck(root);
  const drawings = new Map<string, { slides: Set<string>; parts: number; tags: string[] }>();
  const motion = new Map<string, Set<string>>();
  for (const id of order) {
    const p = slidePath(root, id);
    if (!existsSync(p)) continue;
    const { root: tree, front } = parseSlide(readFileSync(p, 'utf8').replace(/\r\n/g, '\n'));
    walk(tree, d => {
      if (d.name !== 'Diagram' && d.name !== 'svg') return;
      walk(d, e => {
        const shape = shapeOf(e), names = [...shape.matchAll(/([\w-]+)\(/g)].map(m => m[1]), tags = [...new Set(names)].filter(t => !['Diagram', 'svg', 'g'].includes(t));
        if (names.length < MIN_PARTS || tags.length < 2) return;
        const hit = drawings.get(shape) ?? { slides: new Set<string>(), parts: names.length, tags };
        drawings.set(shape, hit.slides.add(id) && hit);
      });
    });
    for (const step of [front.score?.intro, ...(front.score?.steps ?? [])]) {
      const cues = Array.isArray(step) ? step : step?.cues;
      const kinds = (cues ?? []).map((c: any) => Object.keys(c ?? {}).find(k => k in CUES));
      if (kinds.length >= MIN_CUES && kinds.every(Boolean)) motion.set(kinds.join(' + '), (motion.get(kinds.join(' + ')) ?? new Set<string>()).add(id));
    }
  }
  // Largest first, and a part of a drawing already named is not named again.
  const repeated = [...drawings.values()].filter(d => d.slides.size > 1).sort((a, b) => b.parts - a.parts);
  const outer = repeated.filter((d, i) => !repeated.slice(0, i).some(o => [...d.slides].every(s => o.slides.has(s))));
  const saved = listLibrary().filter(i => i.from === root).map(i => i.name);
  const off = meta.library === false;
  return {
    saved,
    macroCandidates: off ? [] : outer.slice(0, MAX_HINTS).map(d => ({ slides: [...d.slides], parts: d.parts, tags: d.tags, suggest: 'The same drawing on several slides: make it a macro. See writingMacros in the catalog.' })),
    phraseCandidates: off ? [] : [...motion].filter(([, s]) => s.size >= MOTION_SLIDES).slice(0, MAX_HINTS).map(([cues, s]) => ({ cues, slides: [...s], suggest: 'The same beat on several slides: name it under phrases: in deck.yaml.' })),
    ...(!off && !saved.length && order.length >= MIN_SLIDES_TO_SAVE ? { nothingSaved: `${order.length} slides, and nothing from this deck is in the library. Save the slides whose structure would suit another talk with library_save, with their content replaced by placeholder text first.` } : {}),
  };
}
