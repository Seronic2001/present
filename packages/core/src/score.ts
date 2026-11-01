// Score: declarative choreography. Compiled here to absolute tracks, so durations are known
// without a browser and every target is checked before anything runs.
import type { Action, Ease, Loop, Phase, Spot, Track } from './compiled.ts';
import type { Diagnostic } from './diagnostics.ts';
import { classes, textOf, walk, type XNode } from './parse.ts';
import { PHRASES, type Phrase } from './phrases.ts';

interface Default { d: number; e: Ease; doc: string; }
export const CUES: Record<string, Default> = {
  fade: { d: 600, e: 'out', doc: 'Fade in. from?: starting fraction (0.43 for a dimmed start)' },
  leave: { d: 420, e: 'out', doc: 'Fade out and stay gone: show something, then take it away. to?: [x, y] drift. A part that ends gone is not checked at rest, so what replaces it can share its place' },
  state: { d: 0, e: 'lin', doc: 'Class cls is held until this cue fires, then removed. For styled before and after states' },
  rise: { d: 600, e: 'out', doc: 'Fade in rising. from: [x, y]; hold?: stop at this opacity until a later fade' },
  slide: { d: 340, e: 'out', doc: 'Fade in sliding. from: [x, y]' },
  pop: { d: 320, e: 'back', doc: 'Scale in with a small overshoot' },
  grow: { d: 700, e: 'out', doc: 'Grow a bar. axis: x|y' },
  draw: { d: 600, e: 'inOut', doc: 'Stroke draws itself' },
  wipe: { d: 360, e: 'inOut', doc: 'Stroke draws outward from its middle' },
  type: { d: 0, e: 'lin', doc: 'Text types out (plain text element)' },
  count: { d: 1200, e: 'out', doc: 'Number counts up to its final text. from: 0' },
  tint: { d: 380, e: 'out', doc: 'Colour moves from a token to its drawn colour. from: token, opacity?: start opacity, prop?: fill|color|stroke' },
  word: { d: 700, e: 'out', doc: 'Headline word rise; added automatically' },
  hot: { d: 950, e: 'lin', doc: 'SIGNAL: adds class hot for its duration. cls?' },
  ripple: { d: 440, e: 'out', doc: 'SIGNAL: expanding ring at the target. tone?, r0?, r1?' },
  pulse: { d: 700, e: 'sine', doc: 'SIGNAL: opacity dip' },
  bump: { d: 420, e: 'lin', doc: 'SIGNAL: small scale nudge. amount?' },
  travel: { d: 800, e: 'inOut', doc: 'SIGNAL: particle along a path. tone?, r?, tail? (0..1 comet), from?, to?' },
  march: { d: 1400, e: 'lin', doc: 'SIGNAL: dashes move along a dashed stroke; use in a loop. cycle?' },
  animate: { d: 600, e: 'inOut', doc: 'Any number in an attribute or style moves. attr: width, r, d... or style: strokeWidth...; from: start value; to?: end value, default the drawing. For a path d, keep the same shape of commands' },
  stream: { d: 2400, e: 'lin', doc: 'SIGNAL: many particles flow along a path. n?, life? (0..1 of the run each lives), jitter? (px off the line), r?, tone?, seed?. Safe in a loop' },
};
const SIGNAL = new Set(['hot', 'ripple', 'pulse', 'bump', 'travel', 'march', 'stream', 'track']);
const RESERVED = new Set(['at', 'dur', 'stagger', 'ease', 'each', 'cues', 'target', 'from', 'optional']);
/** A cue of a phrase takes {name} from the cue that used the phrase. */
const fill = (v: any, params: Record<string, any>): any => {
  if (typeof v === 'string') { const m = /^\{(\w+)\}$/.exec(v); return m ? params[m[1]] : v; }
  if (Array.isArray(v)) return v.map(x => fill(x, params));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, params)]));
  return v;
};

export interface ScoreInput {
  root: XNode;                // expanded drawing
  score: any;
  slide: string;
  diags: Diagnostic[];
  stepLimit: number;
  phrases?: Record<string, Phrase>;   // the deck's own, which win over the built-in ones
}

export function compileScore(i: ScoreInput) {
  const { root, slide, diags } = i;
  const score = i.score ?? {};
  const err = (code: string, message: string, fix: string, id?: string, severity: 'error' | 'warning' = 'error') =>
    diags.push({ code, severity, slide, id, message, fix });

  const all: XNode[] = [];
  walk(root, e => all.push(e));
  const nOf = new Map<XNode, number>();
  const number = (e: XNode) => {
    let n = nOf.get(e);
    if (n == null) { n = nOf.size + 1; nOf.set(e, n); (e.attribs ??= {})['data-n'] = String(n); }
    return n;
  };
  const inside = (scope: XNode, e: XNode) => { for (let p: XNode | null | undefined = e; p; p = p.parent) if (p === scope) return true; return false; };

  function pick(sel: any, scope?: XNode, optional = false): XNode[] {
    const list = Array.isArray(sel) ? sel : [sel];
    const out: XNode[] = [];
    for (const raw of list) {
      if (raw && typeof raw === 'object') { out.push(raw); continue; }   // already resolved: a step made by over
      let s = String(raw).trim(), within: XNode | undefined;
      if (s === '$') { if (scope) out.push(scope); continue; }
      if (s.startsWith('$ ')) { s = s.slice(2).trim(); within = scope; }
      const pool = within ? all.filter(e => inside(within!, e)) : all;
      const hit = s.startsWith('.') ? pool.filter(e => classes(e).includes(s.slice(1))) : pool.filter(e => e.attribs?.id === s);
      if (!hit.length && !optional) err('cue-target-missing', `Cue target "${raw}" matches nothing`, 'Use an id or .class that exists in the drawing', s);
      out.push(...hit);
    }
    return out;
  }

  function cueTracks(cue: any, base: number, scope: XNode | undefined, out: Track[], where: string, path: string, depth = 0) {
    if (!cue || typeof cue !== 'object') { err('bad-cue', `${where}: cue is not an object`, 'Each cue looks like `- rise: id`'); return; }
    if (cue.use) {
      const known = { ...PHRASES, ...i.phrases }, ph = known[cue.use];
      if (!ph) { err('unknown-phrase', `${where}: no phrase "${cue.use}"`, `Phrases: ${Object.keys(known).join(', ')}`); return; }
      if (depth > 8) { err('phrase-cycle', `${where}: phrase "${cue.use}" uses itself`, 'A phrase may use others, but not in a circle'); return; }
      const { use, on, at, stagger, ...params } = cue;
      const cues = fill(ph.cues, params);
      if (on != null) cueTracks({ each: on, at, stagger, cues }, base, scope, out, where, path, depth + 1);
      else cues.forEach((c: any) => cueTracks(c, base + (at ?? 0), scope, out, where, path, depth + 1));
      return;
    }
    if (cue.each) {
      const items = pick(cue.each, scope), gap = cue.stagger ?? 0;
      items.forEach((it, k) => { (cue.cues ?? []).forEach((c: any, m: number) => cueTracks(c, base + (cue.at ?? 0) + k * gap, it, out, where, `${path}.cues.${m}`, depth)); });
      return;
    }
    const isCustom = 'track' in cue;
    const kind = isCustom ? 'track' : Object.keys(cue).find(k => k in CUES);
    if (!kind) { err('unknown-cue', `${where}: no known cue in {${Object.keys(cue).join(', ')}}`, `Cues: ${Object.keys(CUES).join(', ')}, track`); return; }
    const def = CUES[kind] ?? { d: 800, e: 'lin' as Ease };
    const sel = isCustom ? cue.target : kind === 'travel' ? (cue.along ?? cue.travel) : cue[kind];
    let targets = pick(sel, scope, !!cue.optional);
    if (kind === 'animate' && !cue.attr && !cue.style) err('animate-needs-prop', `${where}: animate needs attr or style`, 'Name what moves, e.g. attr: width');
    if (kind === 'count') targets = targets.map(el => {
      if (!classes(el).includes('p-stat')) return el;
      let v: XNode | undefined;
      walk(el, e => { if (!v && classes(e).includes('p-stat-v')) v = e; });
      return v ?? el;
    });
    if (kind === 'count' || kind === 'type') for (const el of targets) if ((el.children ?? []).some(c => c.type === 'tag')) err(`${kind}-needs-text`, `${kind} would overwrite the children of its target`, 'Target an element holding only text', el.attribs?.id);
    const a: Record<string, any> = {};
    for (const [k, v] of Object.entries(cue)) if (k !== kind && !RESERVED.has(k) && k !== 'along') a[k] = v;
    if (Array.isArray(cue.from)) { a.x = cue.from[0]; a.y = cue.from[1]; } else if (cue.from != null) a.from = cue.from;
    if (isCustom) a.name = cue.track;
    targets.forEach((el, k) => {
      let d = cue.dur ?? def.d;
      if (kind === 'type' && !cue.dur) d = Math.max(400, textOf(el).trim().length * 38);
      out.push({
        k: kind, n: number(el), s: base + (cue.at ?? 0) + k * (cue.stagger ?? 0), d,
        e: (cue.ease ?? def.e) as Ease, c: path, ...(Object.keys(a).length ? { a } : {}),
      });
    });
  }

  const endOf = (ts: Track[]) => ts.reduce((m, t) => Math.max(m, t.s + t.d), 0);

  function phase(name: string, spec: any, path: string, base: Track[] = []): Phase {
    const body = Array.isArray(spec) ? { cues: spec } : spec ?? {};
    const tracks = [...base];
    const cuePath = Array.isArray(spec) ? path : `${path}.cues`;
    if (body.each) cueTracks({ each: body.each, stagger: body.stagger, cues: body.cues }, 0, undefined, tracks, name, path);
    else (body.cues ?? []).forEach((c: any, m: number) => cueTracks(c, 0, undefined, tracks, name, `${cuePath}.${m}`));
    const loops: Loop[] = [];
    for (const l of [body.loop].flat().filter(Boolean)) {
      const lt: Track[] = [];
      (l.cues ?? []).forEach((c: any, m: number) => cueTracks(c, 0, undefined, lt, `${name} loop`, `${path}.loop.cues.${m}`));
      const len = endOf(lt), every = l.every ?? 6000;
      if (len > every) err('loop-overlap', `${name}: loop runs ${len}ms but repeats every ${every}ms`, 'Raise every, or shorten the cues');
      for (const t of lt) {
        if (!SIGNAL.has(t.k)) err('loop-not-signal', `${name}: "${t.k}" in a loop would not return to the drawing`, `Use a signal cue: ${[...SIGNAL].join(', ')}`);
      }
      loops.push({ every, after: l.after ?? 800, len, tracks: lt });
    }
    const end = endOf(tracks);
    if (end > i.stepLimit) err('step-too-long', `${name} takes ${end}ms`, `Keep a build under ${i.stepLimit}ms; split it into steps`, undefined, 'warning');
    return { name, tracks, loops, end };
  }

  // Headline words rise in turn, unless the slide opts out.
  const words: Track[] = [];
  if (score.words !== false) {
    let k = 0;
    walk(root, e => { if (classes(e).includes('w')) words.push({ k: 'word', n: number(e), s: 200 + 60 * k++, d: 700, e: 'out' }); });
  }

  const phases: Phase[] = [phase('intro', score.intro, 'intro', words)];
  (score.steps ?? []).forEach((s: any, n: number) => {
    if (s?.over == null) { phases.push(phase(s?.name ?? `step ${n + 1}`, s, `steps.${n}`)); return; }
    // over: one step for each match, in document order. The loop, if any, plays from the last.
    const { over, name, loop, ...cue } = s, items = pick(over);
    items.forEach((it, k) => phases.push(phase(name ? `${name} ${k + 1}` : `step ${phases.length}`, { cues: [{ ...cue, on: [it] }], loop: k === items.length - 1 ? loop : undefined }, `steps.${n}`)));
  });

  const spots: Spot[] = [];
  for (const [id, spec] of Object.entries(score.spots ?? {})) {
    const el = all.find(e => e.attribs?.id === id);
    if (!el) { err('cue-target-missing', `Spot "${id}" matches nothing`, 'Spots are keyed by the id of a part with spot set', id); continue; }
    if (el.attribs?.['data-spot'] == null) err('spot-unmarked', `"${id}" has spot motion but no spot attribute`, 'Add spot to the part', id);
    const ph = phase(`spot ${id}`, spec, `spots.${id}`);
    spots.push({ id, n: number(el), tracks: ph.tracks, end: ph.end });
  }
  // Actions: cues a click plays. The finished drawing has them played, except the later choices of a group.
  const actions: Action[] = [], groups = new Set<string>();
  const moved = new Set(phases.flatMap(ph => ph.tracks.filter(t => !SIGNAL.has(t.k)).map(t => t.n)));
  for (const [id, spec] of Object.entries<any>(score.actions ?? {})) {
    const ph = phase(`action ${id}`, spec, `actions.${id}`), group = Array.isArray(spec) ? undefined : spec?.group;
    for (const t of ph.tracks) if (!SIGNAL.has(t.k) && moved.has(t.n)) err('action-clash', `Action ${id} moves a part the steps also move`, 'Give the action a part of its own: a click can come before or after any step');
    const alt = !!group && groups.has(group);
    if (group) groups.add(group);
    actions.push({ id, tracks: ph.tracks, end: ph.end, ...(spec?.toggle ? { toggle: true } : {}), ...(group ? { group: String(group) } : {}), ...(alt ? { alt: true } : {}) });
  }
  for (const a of actions) if (a.alt) for (const t of a.tracks) all.find(e => e.attribs?.['data-n'] === String(t.n))!.attribs!['data-leaves'] = '';

  // What ends the slide gone is not part of the finished picture, so the rendered checks skip it.
  const last = new Map<number, string>();
  for (const ph of [...phases, ...actions]) for (const t of [...ph.tracks].sort((p, q) => p.s - q.s)) if (!SIGNAL.has(t.k)) last.set(t.n, t.k);
  for (const e of all) if (last.get(Number(e.attribs?.['data-n'])) === 'leave') e.attribs!['data-leaves'] = '';
  return { phases, spots, actions };
}
