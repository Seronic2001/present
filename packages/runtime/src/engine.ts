// One slide's timeline. seek(phase, t) is the pure function of the whole system: it puts the
// slide into the state for that moment, from any earlier state, with no clock involved.
import type { CompiledSlide, Track } from '../../core/src/compiled.ts';
import { bindTrack, type Apply, type BindApi } from './tracks.ts';
import { clamp01, ease } from './ease.ts';

const NS = 'http://www.w3.org/2000/svg';
interface Bound { t: Track; apply: Apply; f: (x: number) => number; last: number; }
interface BoundLoop { phase: number; every: number; after: number; len: number; b: Bound[]; }
const progress = (b: Bound, t: number) => (b.t.d <= 0 ? (t >= b.t.s ? 1 : 0) : clamp01((t - b.t.s) / b.t.d));

export class Engine {
  root: HTMLElement;
  slide: CompiledSlide;
  phases: Bound[][];
  loops: BoundLoop[] = [];
  spots: Record<string, Bound[]> = {};
  actions: Record<string, Bound[]> = {};
  acts?: Record<string, number>;      // ms into each action. Unset: the finished drawing
  windowMs: number;
  private overlay: SVGSVGElement | null = null;
  private layers = new Map<SVGSVGElement, SVGGElement>();

  constructor(root: HTMLElement, slide: CompiledSlide) {
    this.root = root;
    this.slide = slide;
    this.windowMs = slide.rest === 'always' ? Infinity : slide.rest;
    const nodes = new Map<number, Element>();
    root.querySelectorAll('[data-n]').forEach(e => nodes.set(+e.getAttribute('data-n')!, e));
    const api: BindApi = {
      node: n => nodes.get(n)!,
      fx: el => this.layerFor(el),
      center: (el, layer) => {
        const r = el.getBoundingClientRect(), m = (layer as any).getScreenCTM().inverse();
        const pt = new DOMPoint(r.left + r.width / 2, r.top + r.height / 2).matrixTransform(m);
        return { x: pt.x, y: pt.y };
      },
    };
    const bind = (t: Track): Bound => ({ t, apply: bindTrack(t, api), f: ease[t.e] ?? ease.out, last: NaN });
    // Bound against the pristine drawing, so every track reads finished values.
    this.phases = slide.phases.map(ph => ph.tracks.map(bind));
    slide.phases.forEach((ph, i) => ph.loops.forEach(l =>
      this.loops.push({ phase: i, every: l.every, after: l.after, len: l.len, b: l.tracks.map(bind) })));
    for (const s of slide.spots) this.spots[s.id] = s.tracks.map(bind);
    for (const a of slide.actions ?? []) this.actions[a.id] = a.tracks.map(bind);
  }

  private layerFor(el: Element): SVGGElement {
    let svg = (el as SVGElement).ownerSVGElement ?? (el instanceof SVGSVGElement ? el : null);
    while (svg?.ownerSVGElement) svg = svg.ownerSVGElement;
    if (!svg) {
      if (!this.overlay) {
        this.overlay = document.createElementNS(NS, 'svg') as SVGSVGElement;
        this.overlay.setAttribute('class', 'p-overlay');
        this.overlay.setAttribute('viewBox', '0 0 1920 1080');
        this.root.appendChild(this.overlay);
      }
      svg = this.overlay;
    }
    let g = this.layers.get(svg);
    if (!g) {
      g = document.createElementNS(NS, 'g') as SVGGElement;
      g.setAttribute('class', 'fx');
      svg.appendChild(g);
      this.layers.set(svg, g);
    }
    return g;
  }

  /** Time at which everything in this phase, loops included, has stopped. */
  settledAt(phase: number): number {
    const end = this.slide.phases[phase].end;
    const live = this.loops.filter(l => l.phase <= phase);
    if (this.windowMs === Infinity && live.length) return Infinity;
    let at = end;
    for (const l of live) {
      const base = end + l.after;
      const iters = Math.max(0, Math.ceil((end + this.windowMs - base) / l.every));
      if (iters) at = Math.max(at, base + (iters - 1) * l.every + l.len);
    }
    return at;
  }

  seek(phase: number, t: number, force = false, spot?: string, spotT = 0) {
    const pass: [Bound, number][] = [];
    this.phases.forEach((list, i) => {
      for (const b of list) pass.push([b, i < phase ? 1 : i > phase ? 0 : progress(b, t)]);
    });
    const end = this.slide.phases[phase].end;
    for (const l of this.loops) {
      const base = end + l.after, local = t - base;
      const nMax = Math.ceil((end + this.windowMs - base) / l.every) - 1;
      const n = l.phase > phase || local < 0 || !isFinite(t) ? -1 : Math.floor(local / l.every);
      const running = n >= 0 && n <= nMax;
      for (const b of l.b) pass.push([b, running ? progress(b, local - n * l.every) : 0]);
    }
    for (const [id, list] of Object.entries(this.spots)) {
      for (const b of list) pass.push([b, id === spot ? progress(b, spotT) : 1]);
    }
    for (const a of this.slide.actions ?? []) {
      const at = this.acts?.[a.id] ?? 0;
      for (const b of this.actions[a.id]) pass.push([b, this.acts ? (at > 0 ? progress(b, at) : 0) : a.alt ? 0 : 1]);
    }

    if (force) {
      // The earliest unstarted track owns the start state; started tracks then land in time order.
      for (let i = pass.length - 1; i >= 0; i--) { const [b, p] = pass[i]; if (p <= 0) { b.apply(0); b.last = 0; } }
      for (const [b, p] of pass) if (p > 0) { b.apply(p >= 1 ? 1 : b.f(p)); b.last = p; }
      return;
    }
    for (const [b, p] of pass) {
      if (p !== b.last) { b.apply(p >= 1 ? 1 : p <= 0 ? 0 : b.f(p)); b.last = p; }
    }
  }
}
