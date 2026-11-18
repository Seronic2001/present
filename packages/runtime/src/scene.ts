// Scenes: choreography written as code, for what cues cannot say. A scene is imperative (it schedules
// tweens, timers and loops), so it is made a function of time by replay: it runs on a virtual clock,
// and going back restores the drawing and runs it again up to that moment. Nothing reads a real clock,
// so any frame can be reproduced, and the same replay measures how long each step takes.
import { ease as EASES } from './ease.ts';

const NS = 'http://www.w3.org/2000/svg';
const FRAME = 1000 / 60, TAIL = 4000, GUARD = 400000;
type El = Element & { style: CSSStyleDeclaration };
export type SceneFn = (ctx: SceneCtx) => void;
export interface SceneTiming { durs: number[]; rests: (number | null)[]; builds: number[]; names: string[]; errors: string[]; }
interface Timer { t: number; fn: () => void; ph: Ph; n: number; }
interface Tween { start: number; dur: number; fn: (p: number) => void; ease: (p: number) => number; done?: () => void; ph: Ph; n: number; }
type Ph = 'build' | 'loop';
type EaseName = keyof typeof EASES;
interface TweenOpts { delay?: number; ease?: EaseName | ((p: number) => number); done?: () => void; }

const scenes: Record<string, SceneFn> = {};
export const registerScene = (name: string, fn: SceneFn) => { scenes[name] = fn; };
export const hasScene = (name: string) => name in scenes;

const many = (t: any): Element[] => (t == null ? [] : t instanceof Element ? [t] : [...t].filter(Boolean));
const fmt = (v: number) => (+v.toFixed(2)).toString();

/** Everything a scene can do. Times are ms from the moment of the call; nothing here reads a real clock. */
export interface SceneCtx {
  root: Element; svg: SVGSVGElement | null; ease: typeof EASES;
  readonly resting: boolean;
  $(sel: string): any; $$(sel: string): any[];
  step(name: string | (() => void), fn?: () => void): void;
  onRest(fn: () => void): void;
  at(ms: number, fn: () => void): void;
  every(ms: number, fn: (n: number) => void, first?: number): void;
  frame(fn: (t: number, dt: number) => void): () => void;
  tween(dur: number, fn: (p: number) => void, o?: TweenOpts): void;
  hide(t: any): void;
  reveal(t: any, o?: TweenOpts & { dur?: number; y?: number }): void;
  pop(t: any, o?: TweenOpts & { dur?: number; from?: number }): void;
  draw(t: any, o?: TweenOpts & { dur?: number; spark?: boolean | string }): void;
  type(el: any, o?: TweenOpts & { dur?: number }): void;
  count(el: any, o?: TweenOpts & { dur?: number; from?: number }): void;
  hot(el: any, ms?: number, cls?: string): void;
  el(tag: string, attrs?: Record<string, any>, parent?: Element | null): any;
  layer(parent?: Element | null): SVGGElement;
  dot(layer: Element, x: number, y: number, r?: number, fill?: string): SVGCircleElement;
  along(path: any, p: number): { x: number; y: number };
  center(el: Element): { x: number; y: number };
  travel(el: Element, path: any, o?: TweenOpts & { dur?: number; from?: number; to?: number }): void;
  ripple(layer: Element, x: number, y: number, o?: TweenOpts & { dur?: number; r0?: number; r1?: number; color?: string; width?: number }): void;
  rand(seed?: number): () => number;
}

export class Sim {
  root: Element; name: string; window: number;
  pristine: string;
  timing: SceneTiming | null = null;
  now = 0; seq = 0; started = false; resting = false; ph: Ph = 'build';
  timers: Timer[] = []; tweens = new Set<Tween>(); loops = new Set<{ dead: boolean }>(); frames = new Set<{ dead: boolean }>();
  steps: { name: string; fn: () => void }[] = []; restFns: (() => void)[] = []; stepIndex = 0;
  errors: string[] = [];
  ctx!: SceneCtx;

  constructor(root: Element, name: string, window: number) {
    this.root = root; this.name = name; this.window = window;
    this.pristine = root.innerHTML;
  }

  private run<T>(ph: Ph, fn: (...a: any[]) => T, ...args: any[]): T | undefined {
    const prev = this.ph;
    this.ph = ph;
    try { return fn(...args); } catch (e: any) {
      const m = String(e?.message ?? e);
      if (!this.errors.includes(m)) { this.errors.push(m); console.error(`present: scene ${this.name}:`, e); }
    } finally { this.ph = prev; }
  }
  private start(k: number) { let s = 0; for (let i = 0; i < k; i++) s += this.timing!.durs[i]; return s; }
  private add(t: number, fn: () => void, ph: Ph) { this.timers.push({ t, fn, ph, n: this.seq++ }); }

  /** Back to the drawing, with the scene body run again and, when timed, its steps scheduled. */
  reset(schedule = true) {
    this.root.innerHTML = this.pristine;
    Object.assign(this, { now: 0, seq: 0, timers: [], tweens: new Set(), loops: new Set(), frames: new Set(), steps: [], restFns: [], stepIndex: 0, resting: false, ph: 'build', started: true });
    this.ctx = this.context();
    const fn = scenes[this.name];
    if (!fn) { if (!this.errors.length) this.errors.push(`No scene "${this.name}": add scenes/${this.name}.ts`); return; }
    this.run('build', fn, this.ctx);
    if (!schedule || !this.timing) return;
    this.timing.durs.forEach((_, k) => {
      if (k) this.add(this.start(k), () => this.runStep(), 'build');
      const r = this.timing!.rests[k];
      if (r != null) this.add(this.start(k) + r, () => this.rest(), 'loop');
    });
  }
  private runStep() {
    this.resting = false;
    const s = this.steps[this.stepIndex++];
    if (s) this.run('build', s.fn);
  }
  private rest() {
    this.resting = true;
    for (const l of this.loops) l.dead = true;
    for (const f of this.frames) f.dead = true;
    this.loops.clear(); this.frames.clear();
    for (const fn of this.restFns) this.run('loop', fn);
  }

  private context(): SceneCtx {
    const sim = this, root = this.root;
    const svg = (root instanceof SVGSVGElement ? root : root.querySelector('svg')) as SVGSVGElement | null;
    const easeOf = (e: TweenOpts['ease'], d: EaseName) => {
      const f = typeof e === 'function' ? e : EASES[e ?? d] ?? EASES[d];
      return (p: number) => (p <= 0 ? 0 : p >= 1 ? 1 : f(p));
    };
    const keep = new WeakMap<Element, { op: string; end: number; tf: string | null }>();
    const remember = (el: El) => {
      if (!keep.has(el)) {
        const op = parseFloat(getComputedStyle(el).opacity);
        keep.set(el, { op: el.style.opacity, end: isNaN(op) ? 1 : op, tf: el.getAttribute('transform') });
      }
      return keep.get(el)!;
    };
    const c: SceneCtx = {
      root, svg, ease: EASES,
      get resting() { return sim.resting; },
      $: s => root.querySelector(s), $$: s => [...root.querySelectorAll(s)],
      step: (name, fn) => { if (typeof name === 'function') sim.steps.push({ name: `step ${sim.steps.length + 1}`, fn: name }); else sim.steps.push({ name, fn: fn! }); },
      onRest: fn => { sim.restFns.push(fn); },
      at: (ms, fn) => sim.add(sim.now + (ms || 0), fn, sim.ph),
      every: (ms, fn, first) => {
        if (sim.resting) return;
        const loop = { dead: false };
        let n = 0;
        const arm = (d: number) => sim.add(sim.now + d, () => { if (loop.dead) return; fn(n++); if (!loop.dead) arm(ms); }, 'loop');
        sim.loops.add(loop);
        arm(first ?? ms);
      },
      frame: fn => {
        if (sim.resting) return () => {};
        const t0 = sim.now, f = { dead: false };
        const tick = () => { if (f.dead) return; fn((sim.now - t0) / 1000, FRAME / 1000); sim.add(sim.now + FRAME, tick, 'loop'); };
        sim.frames.add(f);
        sim.add(sim.now, tick, 'loop');
        return () => { f.dead = true; sim.frames.delete(f); };
      },
      tween: (dur, fn, o = {}) => {
        const e = easeOf(o.ease, 'out');
        sim.run(sim.ph, fn, 0);
        sim.tweens.add({ start: sim.now + (o.delay || 0), dur: Math.max(1, dur), fn, ease: e, done: o.done, ph: sim.ph, n: sim.seq++ });
      },
      hide: t => { for (const el of many(t) as El[]) { remember(el); el.style.opacity = '0'; } },
      reveal: (t, o = {}) => {
        for (const el of many(t) as El[]) {
          const k = remember(el), y = o.y ?? 14, canMove = !(el instanceof SVGElement && el.hasAttribute('transform'));
          el.style.opacity = '0';
          c.tween(o.dur ?? 600, p => {
            el.style.opacity = p >= 1 ? k.op : fmt(k.end * p);
            if (canMove && y) el.style.translate = p >= 1 ? '' : `0 ${fmt(y * (1 - p))}px`;
          }, { delay: o.delay, ease: o.ease ?? 'out', done: o.done });
        }
      },
      pop: (t, o = {}) => {
        for (const el of many(t) as El[]) {
          const k = remember(el), from = o.from ?? .64;
          const b = (el as any).getBBox?.() ?? { x: 0, y: 0, width: 0, height: 0 }, x = b.x + b.width / 2, y = b.y + b.height / 2;
          el.style.opacity = '0';
          c.tween(o.dur ?? 380, p => {
            el.style.opacity = p >= 1 ? k.op : fmt(k.end * Math.min(1, p * 2.5));
            const s = from + (1 - from) * p;
            if (p >= 1) { if (k.tf == null) el.removeAttribute('transform'); else el.setAttribute('transform', k.tf); }
            else el.setAttribute('transform', `translate(${fmt(x)} ${fmt(y)}) scale(${s.toFixed(4)}) translate(${fmt(-x)} ${fmt(-y)}) ${k.tf ?? ''}`);
          }, { delay: o.delay, ease: o.ease ?? 'back', done: o.done });
        }
      },
      draw: (t, o = {}) => {
        for (const el of many(t)) {
          const geo = (typeof (el as any).getTotalLength === 'function' ? [el] : [...el.querySelectorAll('path,line,polyline,circle,rect')]) as any[];
          for (const g of geo) {
            const L = g.getTotalLength() as number, dash = g.style.strokeDasharray, off = g.style.strokeDashoffset;
            const mark = g.getAttribute('marker-end');   // the arrowhead lands with the line, not before it
            let spark: SVGCircleElement | null = null;
            g.style.strokeDasharray = `${fmt(L)} ${fmt(L + 20)}`;
            g.style.strokeDashoffset = fmt(L);
            if (mark) g.removeAttribute('marker-end');
            c.tween(o.dur ?? 600, p => {
              if (p >= 1) { g.style.strokeDasharray = dash; g.style.strokeDashoffset = off; if (mark) g.setAttribute('marker-end', mark); spark?.remove(); spark = null; return; }
              g.style.strokeDashoffset = fmt(L * (1 - p));
              if (o.spark && p > 0) {
                const pt = g.getPointAtLength(L * p);
                spark ??= c.dot(c.layer(), pt.x, pt.y, 3.6, typeof o.spark === 'string' ? `var(--${o.spark})` : undefined);
                spark.setAttribute('cx', fmt(pt.x)); spark.setAttribute('cy', fmt(pt.y));
              }
            }, { delay: o.delay, ease: o.ease ?? 'inOut', done: o.done });
          }
        }
      },
      // Text nodes are cut, not the element's text, so coloured tspans keep their colours.
      type: (el, o = {}) => {
        if (!el) return;
        const nodes: Text[] = [];
        const walk = (n: Node) => { for (const k of n.childNodes) { if (k.nodeType === 3) nodes.push(k as Text); else walk(k); } };
        walk(el);
        const fin = nodes.map(n => n.data), total = fin.reduce((s, x) => s + x.length, 0);
        c.tween(o.dur ?? Math.max(400, total * 38), p => {
          let left = p >= 1 ? Infinity : Math.round(total * p);
          nodes.forEach((n, i) => { const k = Math.min(left, fin[i].length); n.data = fin[i].slice(0, k); left -= k; });
        }, { delay: o.delay, ease: o.ease ?? 'lin', done: o.done });
      },
      count: (el, o = {}) => {
        const node = el && numberNode(el);
        if (!node) return;
        const { text, fin, m } = node;
        const num = parseFloat(m[0].replace(/,/g, '')), dec = (m[0].split('.')[1] ?? '').length, commas = m[0].includes(','), from = o.from ?? 0;
        c.tween(o.dur ?? 1200, p => {
          if (p >= 1) { text.data = fin; return; }
          const v = from + (num - from) * p;
          text.data = fin.slice(0, m.index) + (commas ? v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) : v.toFixed(dec)) + fin.slice(m.index! + m[0].length);
        }, { delay: o.delay, ease: o.ease ?? 'out', done: o.done });
      },
      hot: (el, ms, cls) => { if (!el) return; const k = cls ?? 'hot'; el.classList.add(k); c.at(ms ?? 700, () => el.classList.remove(k)); },
      el: (tag, attrs = {}, parent) => {
        const n = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
        parent?.appendChild(n);
        return n;
      },
      layer: parent => {
        const host = parent ?? svg ?? root;
        return (host.querySelector(':scope > g.fx-scene') as SVGGElement | null) ?? c.el('g', { class: 'fx fx-scene' }, host);
      },
      dot: (layer, x, y, r = 4, fill = 'var(--accent)') => { const d = c.el('circle', { cx: fmt(x), cy: fmt(y), r }, layer); d.style.fill = fill; return d; },
      along: (path, p) => { const pt = path.getPointAtLength(Math.max(0, Math.min(1, p)) * path.getTotalLength()); return { x: pt.x, y: pt.y }; },
      center: el => {
        const host = svg ?? root, r = el.getBoundingClientRect(), m = (host as any).getScreenCTM?.()?.inverse();
        const pt = new DOMPoint(r.left + r.width / 2, r.top + r.height / 2);
        const q = m ? pt.matrixTransform(m) : pt;
        return { x: q.x, y: q.y };
      },
      travel: (el, path, o = {}) => {
        const L = path.getTotalLength(), a = o.from ?? 0, b = o.to ?? 1;
        c.tween(o.dur ?? 1000, p => {
          const pt = path.getPointAtLength((a + (b - a) * p) * L);
          if (el.tagName === 'circle') { el.setAttribute('cx', fmt(pt.x)); el.setAttribute('cy', fmt(pt.y)); }
          else el.setAttribute('transform', `translate(${fmt(pt.x)} ${fmt(pt.y)})`);
        }, { delay: o.delay, ease: o.ease ?? 'inOut', done: o.done });
      },
      ripple: (layer, x, y, o = {}) => {
        const r0 = o.r0 ?? 4, r1 = o.r1 ?? 26;
        const ring = c.el('circle', { cx: fmt(x), cy: fmt(y), r: r0, fill: 'none', 'stroke-width': o.width ?? 2 }, layer);
        ring.style.stroke = o.color ?? 'var(--accent)';
        c.tween(o.dur ?? 900, p => { ring.setAttribute('r', fmt(r0 + (r1 - r0) * p)); ring.setAttribute('opacity', (1 - p).toFixed(3)); }, { delay: o.delay, ease: 'out', done: () => { ring.remove(); o.done?.(); } });
      },
      rand: seed => { let a = (seed ?? 1) >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; },
    };
    return c;
  }

  /** The next event at or before `to`: a timer, or the end of a tween. */
  private next(to: number, only?: Ph) {
    let best: Timer | null = null;
    for (const x of this.timers) if (x.t <= to && (!only || x.ph === only) && (!best || x.t < best.t || (x.t === best.t && x.n < best.n))) best = x;
    let end: { tw: Tween; e: number } | null = null;
    for (const tw of this.tweens) { const e = tw.start + tw.dur; if (e <= to && (!only || tw.ph === only) && (!end || e < end.e)) end = { tw, e }; }
    if (end && (!best || end.e <= best.t)) return { t: end.e, timer: null };
    return best ? { t: best.t, timer: best } : null;
  }
  private paint() {
    for (const tw of [...this.tweens]) {
      const local = this.now - tw.start;
      if (local < 0) continue;
      const p = local >= tw.dur - 1e-6 ? 1 : local / tw.dur;
      this.run(tw.ph, tw.fn, tw.ease(p));
      if (p >= 1) { this.tweens.delete(tw); if (tw.done) this.run(tw.ph, tw.done); }
    }
  }
  private step1(e: { t: number; timer: Timer | null }) {
    this.now = Math.max(this.now, e.t);
    this.paint();
    if (e.timer) { this.timers.splice(this.timers.indexOf(e.timer), 1); this.run(e.timer.ph, e.timer.fn); }
  }
  private advance(to: number, only?: Ph) {
    for (let g = 0, e; g < GUARD && (e = this.next(to, only)); g++) this.step1(e);
    if (!only) { this.now = Math.max(this.now, to); this.paint(); }
  }

  /** Puts the scene at a fraction of step k. Steps start 2ms after the last one ends. */
  apply(k: number, p: number) {
    if (!this.timing || k >= this.timing.durs.length) return;
    if (k > 0 && p <= 0) return;                // its start is the end of the step before
    const d = this.timing.durs[k];
    const target = p <= 0 ? 0 : this.start(k) + Math.min(1, p) * (d - .5);
    if (!this.started || target < this.now) this.reset();
    this.advance(target);
  }

  /** How long each step takes: its build, then, if it set loops going, the resting window and what onRest plays. */
  measure(): SceneTiming {
    this.timing = null;
    this.reset(false);
    const durs: number[] = [], rests: (number | null)[] = [], builds: number[] = [];
    const n = this.steps.length;
    for (let k = 0; k <= n; k++) {
      const begin = this.now;
      if (k) this.runStep();
      for (let g = 0, e; g < GUARD && (e = this.next(Infinity, 'build')); g++) this.step1(e);
      const build = this.now - begin;
      let rest: number | null = null;
      if (this.loops.size || this.frames.size) {
        rest = Math.ceil(build + this.window);
        this.advance(begin + rest);
        this.rest();
      }
      // Whatever is still moving (onRest's own tweens) finishes, within reason.
      const cap = this.now + TAIL;
      for (let g = 0, e; g < GUARD && (e = this.next(cap)); g++) this.step1(e);
      durs.push(Math.ceil(this.now - begin) + 2);
      rests.push(rest);
      builds.push(Math.ceil(build));
      this.advance(begin + durs[k]);
    }
    const timing = { durs, rests, builds, names: ['intro', ...this.steps.map(s => s.name)], errors: [...this.errors] };
    this.timing = timing;
    this.started = false;
    this.root.innerHTML = this.pristine;
    return timing;
  }
}

/** The first text node holding a number, anywhere inside: a count keeps every other character, and every tspan. */
export function numberNode(el: Node): { text: Text; fin: string; m: RegExpMatchArray } | null {
  const walk = (n: Node): { text: Text; fin: string; m: RegExpMatchArray } | null => {
    for (const k of n.childNodes) {
      if (k.nodeType === 3) { const fin = (k as Text).data, m = fin.match(/[\d,]*\.?\d+/); if (m) return { text: k as Text, fin, m }; }
      else { const hit = walk(k); if (hit) return hit; }
    }
    return null;
  };
  return walk(el);
}

const sims = new WeakMap<Element, Sim>();
export const simFor = (el: Element, name: string, window: number) => {
  let s = sims.get(el);
  if (!s || s.name !== name) { s = new Sim(el, name, window); sims.set(el, s); }
  return s;
};
