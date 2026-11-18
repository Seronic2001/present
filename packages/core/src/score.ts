// Score: declarative choreography. Compiled here to absolute tracks, so durations are known
// without a browser and every target is checked before anything runs.
import type { Action, Ease, Loop, Phase, SceneTiming, Spot, Track } from './compiled.ts';
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
  type: { d: 0, e: 'lin', doc: 'Text types out. Keeps tspans and <em>, so coloured code types in colour. Default dur: rate (38) ms a character. For lines one after another, chain: true, gap?' },
  count: { d: 1200, e: 'out', doc: 'The first number in any text counts up; the rest of the text and its tspans stay ("237 s", "14×"). A Stat counts by its id. from: 0' },
  tint: { d: 380, e: 'out', doc: 'Colour moves from a token to its drawn colour. from: token, opacity?: start opacity, prop?: fill|color|stroke' },
  word: { d: 700, e: 'out', doc: 'Headline word rise; added automatically' },
  hot: { d: 950, e: 'lin', doc: 'SIGNAL: adds class hot for its duration. cls?' },
  ripple: { d: 440, e: 'out', doc: 'SIGNAL: expanding ring at the target. tone?, r0?, r1?' },
  pulse: { d: 700, e: 'sine', doc: 'SIGNAL: opacity dip' },
  bump: { d: 420, e: 'lin', doc: 'SIGNAL: small scale nudge. amount?' },
  travel: { d: 800, e: 'inOut', doc: 'SIGNAL: particle along a path. tone?, r?, tail? (0..1 comet), from?, to?' },
  march: { d: 1400, e: 'lin', doc: 'SIGNAL: dashes move along a dashed stroke; use in a loop. cycle?' },
  animate: { d: 600, e: 'inOut', doc: 'Any number in an attribute or style moves. attr: width, r, d... or style: strokeWidth...; from: start value; to?: end value, default the drawing. With no from, it starts where the last animate of that attribute ended, so a marker walks A, B, C with only to: on each step; before its first move it sits at that move\'s from. For a path d, keep the same shape of commands' },
  swap: { d: 420, e: 'out', doc: 'Shows one child of a <Swap> (or any group) in place of the one showing: swap: panels, to: 3 (1-based, or a child id). The first child shows at the start, or from: 0 for none. Only the last one shown stays at rest' },
  build: { d: 0, e: 'out', doc: 'A Diagram comes in by its own structure: boxes nothing points at pop in reading order, then each Link draws, a particle runs it, and its target pops with a ring as it lands, wave after wave. build: diagram-id (or a group). stagger?, tone?' },
  stream: { d: 2400, e: 'lin', doc: 'SIGNAL: many particles flow along a path. n?, life? (0..1 of the run each lives), jitter? (px off the line), r?, tone?, seed?. Safe in a loop' },
};
const SIGNAL = new Set(['hot', 'ripple', 'pulse', 'bump', 'travel', 'march', 'stream', 'track']);
const RESERVED = new Set(['at', 'dur', 'stagger', 'ease', 'each', 'cues', 'target', 'from', 'optional', 'chain', 'gap', 'rate']);
/** What the deck knows of a scene: whether its file exists, and its timing if a browser has measured it. */
export interface SceneInfo { known: boolean; timing?: SceneTiming; steps?: number; }
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
  scene?: (name: string) => SceneInfo;
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
    if (cue.swap != null) { swapCue(cue, base, scope, out, where, path); return; }
    if (cue.build != null) { for (const box of pick(cue.build, scope, !!cue.optional)) buildCue(box, base + (cue.at ?? 0), cue, out, path); return; }
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
    const a: Record<string, any> = {};
    for (const [k, v] of Object.entries(cue)) if (k !== kind && !RESERVED.has(k) && k !== 'along') a[k] = v;
    if (Array.isArray(cue.from)) { a.x = cue.from[0]; a.y = cue.from[1]; } else if (cue.from != null) a.from = cue.from;
    if (isCustom) a.name = cue.track;
    // chain: each target starts when the one before it ends (plus gap), as lines of code type one after another.
    let cursor = base + (cue.at ?? 0);
    targets.forEach((el, k) => {
      let d = cue.dur ?? def.d;
      if (kind === 'type' && !cue.dur) d = Math.max(cue.rate ? 200 : 400, textOf(el).trim().length * (cue.rate ?? 38));
      const s0 = cue.chain ? cursor : base + (cue.at ?? 0) + k * (cue.stagger ?? 0);
      if (cue.chain) cursor = s0 + d + (cue.gap ?? 0);
      const t: Track = {
        k: kind, n: number(el), s: s0, d,
        e: (cue.ease ?? def.e) as Ease, c: path, ...(Object.keys(a).length ? { a: { ...a } } : {}),
      };
      if (kind === 'animate' && cue.from == null) chained.add(t);
      out.push(t);
    });
  }

  const endOf = (ts: Track[]) => ts.reduce((m, t) => Math.max(m, t.s + t.d), 0);
  const chained = new WeakSet<Track>();
  const tags = (e: XNode) => (e.children ?? []).filter(c => c.type === 'tag');

  // swap: which child of each group is showing, carried from step to step in order.
  const swapNow = new Map<XNode, number>(), swapSeen = new Map<XNode, Set<number>>();
  function swapCue(cue: any, base: number, scope: XNode | undefined, out: Track[], where: string, path: string) {
    const [box] = pick(cue.swap, scope);
    if (!box) return;
    const panels = tags(box);
    const to = typeof cue.to === 'string' && !/^\d+$/.test(cue.to) ? panels.findIndex(p => p.attribs?.id === cue.to) : Number(cue.to) - 1;
    if (!(to >= 0 && to < panels.length)) { err('bad-swap', `${where}: swap to ${cue.to} is not one of the ${panels.length} children of ${cue.swap}`, 'to is 1-based, or the id of a child', box.attribs?.id); return; }
    if (!swapNow.has(box)) { const first = cue.from != null ? Number(cue.from) - 1 : 0; swapNow.set(box, first); swapSeen.set(box, new Set(first >= 0 ? [first] : [])); }
    const cur = swapNow.get(box)!, at = base + (cue.at ?? 0), d = cue.dur ?? CUES.swap.d;
    if (cur === to) return;
    if (cur >= 0) out.push({ k: 'leave', n: number(panels[cur]), s: at, d: Math.round(d * .7), e: 'out', c: path, a: { to: [0, -8] } });
    out.push({ k: 'rise', n: number(panels[to]), s: at + (cur >= 0 ? Math.round(d * .4) : 0), d, e: 'out', c: path, a: { x: 0, y: 10 } });
    swapNow.set(box, to);
    swapSeen.get(box)!.add(to);
  }

  // build: a diagram enters by its structure. Boxes nothing points at come first, then each link carries the eye on.
  function buildCue(box: XNode, base: number, cue: any, out: Track[], path: string) {
    const boxes: XNode[] = [], links: XNode[] = [];
    walk(box, e => {
      if (e === box) return;
      if (e.attribs?.['data-box'] != null && !boxes.some(b => inside(b, e))) boxes.push(e);
      if (e.attribs?.['data-from'] && e.attribs?.['data-to']) links.push(e);
    });
    const at = (e: XNode) => { let r: XNode | undefined; walk(e, x => { if (!r && x.name === 'rect') r = x; }); return { x: +(r?.attribs?.x ?? 0), y: +(r?.attribs?.y ?? 0) }; };
    const reading = (list: XNode[]) => [...list].sort((a, b) => { const p = at(a), q = at(b); return Math.abs(p.y - q.y) > 40 ? p.y - q.y : p.x - q.x; });
    const byId = new Map(boxes.filter(b => b.attribs?.id).map(b => [b.attribs!.id, b]));
    const edges = links.map(l => ({ l, from: byId.get(l.attribs!['data-from']), to: byId.get(l.attribs!['data-to']) })).filter(e => e.from && e.to) as { l: XNode; from: XNode; to: XNode }[];
    const into = new Set(edges.map(e => e.to)), landed = new Map<XNode, number>(), gap = cue.stagger ?? 90, tone = cue.tone;
    const pop = (b: XNode, t: number) => { out.push({ k: 'pop', n: number(b), s: base + t, d: 380, e: 'back', c: path, a: { from: .64 } }); landed.set(b, t + 300); };
    let roots = reading(boxes.filter(b => !into.has(b)));
    if (!roots.length && boxes.length) roots = reading(boxes).slice(0, 1);
    roots.forEach((b, k) => pop(b, k * gap));
    const used = new Set<object>();
    for (let guard = 0; guard < 500; guard++) {
      const wave = edges.filter(e => !used.has(e) && landed.has(e.from));
      if (!wave.length) {
        const left = reading(boxes.filter(b => !landed.has(b)));
        if (!left.length) break;
        pop(left[0], Math.max(0, ...landed.values()) + gap);
        continue;
      }
      const order = reading(wave.map(e => e.to));
      wave.sort((p, q) => order.indexOf(p.to) - order.indexOf(q.to));
      const from = new Map(landed);
      wave.forEach((e, k) => {
        used.add(e);
        const t = from.get(e.from)! + k * gap, n = number(e.l), arrive = t + 200 + 460;
        out.push({ k: 'draw', n, s: base + t, d: 420, e: 'inOut', c: path });
        out.push({ k: 'travel', n, s: base + t + 200, d: 460, e: 'inOut', c: path, a: { r: 4, ...(tone ? { tone } : {}) } });
        out.push({ k: 'ripple', n: number(e.to), s: base + arrive, d: 520, e: 'out', c: path, a: { r1: 30, ...(tone ? { tone } : {}) } });
        if (!landed.has(e.to)) pop(e.to, arrive - 60);
        else out.push({ k: 'bump', n: number(e.to), s: base + arrive, d: 420, e: 'lin', c: path, a: { amount: .06 } });
      });
    }
  }

  function phase(name: string, spec: any, path: string, base: Track[] = []): Phase {
    const body = Array.isArray(spec) ? { cues: spec } : spec ?? {};
    const auto = body.auto === true ? 700 : typeof body.auto === 'number' ? body.auto : undefined;
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
    return { name, tracks, loops, end, ...(auto != null ? { auto } : {}) };
  }

  // A scene owns a root: by default the slide's first <svg>, or score.root. It is replayed, so nothing else moves inside it.
  let sceneRoot: XNode | undefined, sceneName = '', sceneInfo: SceneInfo | undefined;
  if (score.scene != null) {
    sceneName = String(score.scene);
    sceneRoot = score.root != null ? all.find(e => e.attribs?.id === String(score.root)) : all.find(e => e.name === 'svg');
    if (!sceneRoot) err('scene-root-missing', score.root != null ? `Scene root "${score.root}" matches nothing` : 'A scene needs a root, and this slide has no <svg> or Diagram', 'Give score.root the id of the element the scene owns', score.root);
    sceneInfo = i.scene?.(sceneName);
    if (sceneInfo && !sceneInfo.known) err('unknown-scene', `No scene "${sceneName}"`, `Write scenes/${sceneName}.ts: export default (ctx) => { ... }. See scenes in the catalog`);
  }

  // Headline words rise in turn, unless the slide opts out.
  const words: Track[] = [];
  if (score.words !== false) {
    let k = 0;
    walk(root, e => { if (classes(e).includes('w') && !(sceneRoot && inside(sceneRoot, e))) words.push({ k: 'word', n: number(e), s: 200 + 60 * k++, d: 700, e: 'out' }); });
  }

  const phases: Phase[] = [phase('intro', score.intro, 'intro', words)];
  (score.steps ?? []).forEach((s: any, n: number) => {
    if (s?.over == null) { phases.push(phase(s?.name ?? `step ${n + 1}`, s, `steps.${n}`)); return; }
    // over: one step for each match, in document order. The loop, if any, plays from the last.
    const { over, name, loop, ...cue } = s, items = pick(over);
    items.forEach((it, k) => phases.push(phase(name ? `${name} ${k + 1}` : `step ${phases.length}`, { cues: [{ ...cue, on: [it] }], loop: k === items.length - 1 ? loop : undefined }, `steps.${n}`)));
  });

  // animate with no from carries on from where the last animate of the same attribute left it.
  const lastTo = new Map<string, any>();
  for (const ph of phases) for (const t of [...ph.tracks].sort((p, q) => p.s - q.s)) {
    if (t.k !== 'animate') continue;
    const key = `${t.n}|${t.a?.attr ?? ''}|${t.a?.style ?? ''}`;
    if (chained.has(t) && lastTo.has(key)) t.a = { ...t.a, from: lastTo.get(key) };
    if (t.a?.to != null) lastTo.set(key, t.a.to); else lastTo.delete(key);
  }
  for (const [box, seen] of swapSeen) {
    const never = tags(box).map((p, k) => (seen.has(k) ? '' : p.attribs?.id ?? `#${k + 1}`)).filter(Boolean);
    if (never.length) err('swap-unused', `${never.join(', ')} in ${box.attribs?.id ?? 'a swap'} never shows, so it sits over the others`, 'Swap to it in some step, or remove it', box.attribs?.id, 'warning');
  }

  // The scene's steps: a phase each, as long as the measured replay. Unmeasured, a guess until a browser times it.
  if (sceneRoot) {
    const tm = sceneInfo?.timing, steps = tm ? tm.durs.length - 1 : Math.max(sceneInfo?.steps ?? 0, phases.length - 1), n = number(sceneRoot);
    for (let k = 0; k <= steps; k++) {
      phases[k] ??= { name: tm?.names[k] ?? `step ${k}`, tracks: [], loops: [], end: 0 };
      const d = tm?.durs[k] ?? 1000;
      phases[k].tracks.push({ k: 'scene', n, s: 0, d, e: 'lin', a: { scene: sceneName, index: k } });
      phases[k].end = Math.max(phases[k].end, d);
    }
  }

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
  if (sceneRoot) {
    const byN = new Map(all.map(e => [Number(e.attribs?.['data-n']), e]));
    const owned = [...phases, ...spots, ...actions].flatMap(ph => ph.tracks).filter(t => t.k !== 'scene' && byN.get(t.n) !== sceneRoot && inside(sceneRoot!, byN.get(t.n)!));
    if (owned.length) err('scene-owns', `${owned.length} cue${owned.length > 1 ? 's' : ''} move parts inside the scene's root`, 'The scene replays its root, so move those parts from the scene, or give score.root a smaller element', byN.get(owned[0].n)?.attribs?.id);
  }
  const scene = sceneRoot ? { name: sceneName, n: number(sceneRoot), measured: !!sceneInfo?.timing } : undefined;
  return { phases, spots, actions, scene, swaps: [...swapSeen.keys()] };
}
