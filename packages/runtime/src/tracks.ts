// Each cue binds to an apply(p). Contract: apply depends only on p, so any frame can be
// reproduced. p=1 restores the finished drawing; signals are also identity at p=0.
import type { Track } from '../../core/src/compiled.ts';
import { numberNode, simFor } from './scene.ts';

export type Apply = (p: number) => void;
export interface BindApi {
  node(n: number): Element;
  fx(el: Element): SVGGElement;
  center(el: Element, layer: SVGGElement): { x: number; y: number };
}
export type TrackFactory = (el: Element, a: Record<string, any>, api: BindApi) => Apply;

const NS = 'http://www.w3.org/2000/svg';
const custom: Record<string, TrackFactory> = {};
export const registerTrack = (name: string, f: TrackFactory) => { custom[name] = f; };

const css = (el: Element) => (el as HTMLElement).style;
// Inline styles belong to the drawing. Snapshot them at bind, before any track writes, so p=1
// restores what the author wrote rather than clearing it.
const drawn = new WeakMap<Element, CSSStyleDeclaration>();
const snap = (el: Element) => { if (!drawn.has(el)) drawn.set(el, (el.cloneNode(false) as HTMLElement).style); };
const base = (el: Element, prop: string) => (drawn.get(el) as any)?.[prop] ?? '';
const svgEl = (tag: string, attrs: Record<string, any>, parent: Element) => {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, String(attrs[k]));
  parent.appendChild(n);
  return n as any;
};
const endOpacity = (el: Element) => { const v = parseFloat(getComputedStyle(el).opacity); return isNaN(v) ? 1 : v; };
const setOp = (el: Element, end: number, p: number) => { css(el).opacity = p >= 1 ? base(el, 'opacity') : (end * Math.max(0, p)).toFixed(3); };
/** The screen box of what an element shows. A foreignObject's frame can be far wider than the text in it
 *  (a TextBlock with no w gets room to grow), so inside one, what it holds is measured instead. */
export function contentRect(el: Element): DOMRect {
  if (el.tagName !== 'foreignObject' && !el.querySelector('foreignObject')) return el.getBoundingClientRect();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of el.children) {
    const r = el.tagName === 'foreignObject' ? inkRect(k) : contentRect(k);
    if (!r.width && !r.height) continue;
    x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
  }
  return x0 === Infinity ? el.getBoundingClientRect() : new DOMRect(x0, y0, x1 - x0, y1 - y0);
}
const inkRect = (el: Element) => { const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect(); return b.width ? b : el.getBoundingClientRect(); };

// Scale about the element's own box. SVG composes into the transform attribute, centred in the
// parent's space, because CSS scale wraps an attribute transform and misplaces <use>. p=1 restores it.
const scaler = (el: Element, fx = .5, fy = .5) => {
  if (el instanceof SVGGraphicsElement && !(el instanceof SVGSVGElement)) {
    const orig = el.getAttribute('transform'), b = el.getBBox(), m = el.transform.baseVal.consolidate()?.matrix;
    let pt = new DOMPoint(b.x + b.width * fx, b.y + b.height * fy).matrixTransform(m ?? new DOMMatrix());
    const host = el.parentNode as SVGGraphicsElement | null;
    if (el.querySelector('foreignObject') && host?.getScreenCTM) {   // centred on its text, not on the frame around it
      const r = contentRect(el), inv = host.getScreenCTM()?.inverse();
      if (inv && r.width) pt = new DOMPoint(r.left + r.width * fx, r.top + r.height * fy).matrixTransform(inv);
    }
    return (sx: number, sy = sx) => {
      if (sx === 1 && sy === 1) { if (orig == null) el.removeAttribute('transform'); else el.setAttribute('transform', orig); return; }
      el.setAttribute('transform', `translate(${pt.x.toFixed(2)} ${pt.y.toFixed(2)}) scale(${sx.toFixed(3)} ${sy.toFixed(3)}) translate(${(-pt.x).toFixed(2)} ${(-pt.y).toFixed(2)}) ${orig ?? ''}`);
    };
  }
  css(el).transformOrigin = `${fx * 100}% ${fy * 100}%`;
  return (sx: number, sy = sx) => { css(el).scale = sx === 1 && sy === 1 ? base(el, 'scale') : `${sx.toFixed(3)} ${sy.toFixed(3)}`; };
};
const tone = (t?: string) => (t ? (t.startsWith('#') || t.startsWith('rgb') ? t : `var(--${t})`) : 'var(--accent)');
const geometry = (el: Element): any[] =>
  (typeof (el as any).getTotalLength === 'function' ? [el] : [...el.querySelectorAll('path,line,polyline,circle,rect')]);

const restoreStroke = (g: any) => {
  g.style.strokeDasharray = base(g, 'strokeDasharray');
  g.style.strokeDashoffset = base(g, 'strokeDashoffset');
  g.style.visibility = base(g, 'visibility');
};

const move = (dx: number, dy: number): TrackFactory => (el, a) => {
  const end = endOpacity(el), x = a.x ?? dx, y = a.y ?? dy, hold = a.hold ?? 1;
  return p => {
    if (hold < 1) css(el).opacity = (end * hold * Math.max(0, p)).toFixed(3);
    else setOp(el, end, p);
    css(el).translate = p >= 1 ? base(el, 'translate') : `${(x * (1 - p)).toFixed(2)}px ${(y * (1 - p)).toFixed(2)}px`;
  };
};

const FACTORIES: Record<string, TrackFactory> = {
  fade: (el, a) => { const end = endOpacity(el), from = a.from ?? 0; return p => setOp(el, end, from + (1 - from) * p); },
  leave: (el, a) => {                                  // the one cue whose end is not the drawing
    const end = endOpacity(el), [x, y] = Array.isArray(a.to) ? a.to : [0, -10];
    return p => {
      css(el).opacity = p <= 0 ? base(el, 'opacity') : (end * (1 - p)).toFixed(3);
      css(el).translate = p <= 0 ? base(el, 'translate') : `${(x * p).toFixed(2)}px ${(y * p).toFixed(2)}px`;
      css(el).visibility = p >= 1 ? 'hidden' : base(el, 'visibility');
    };
  },
  state: (el, a) => { const cls = a.cls ?? 'off'; return p => { el.classList.toggle(cls, p < 1); }; },
  rise: move(0, 14),
  slide: move(-16, 0),
  word: el => {
    const end = endOpacity(el);
    return p => {
      setOp(el, end, p);
      css(el).translate = p >= 1 ? base(el, 'translate') : `0 ${(.42 * (1 - p)).toFixed(3)}em`;
      css(el).filter = p >= 1 ? base(el, 'filter') : `blur(${(5 * (1 - p)).toFixed(2)}px)`;
    };
  },
  pop: (el, a) => {
    const set = scaler(el), end = endOpacity(el), from = a.from ?? 0;
    return p => {
      set(p >= 1 ? 1 : Math.max(.001, from + (1 - from) * p));
      setOp(el, end, Math.min(1, p * 2.5));
    };
  },
  grow: (el, a) => {
    const ax = a.axis === 'x', set = scaler(el, ax ? 0 : .5, ax ? .5 : 1);
    return p => { const k = p >= 1 ? 1 : Math.max(.001, p); if (ax) set(k, 1); else set(1, k); };
  },
  draw: el => {
    const parts = geometry(el).map(g => { snap(g); return { g, L: g.getTotalLength() as number, mark: g.getAttribute('marker-end') as string | null }; });
    return p => {
      for (const { g, L, mark } of parts) {
        // the arrowhead lands with the line, not before it
        if (mark) { if (p >= 1) g.setAttribute('marker-end', mark); else g.removeAttribute('marker-end'); }
        if (p >= 1) { restoreStroke(g); continue; }
        g.style.strokeDasharray = `${L.toFixed(1)} ${(L + 20).toFixed(1)}`;
        g.style.strokeDashoffset = (L * (1 - p)).toFixed(1);
        g.style.visibility = p > 0 ? '' : 'hidden';
      }
    };
  },
  wipe: el => {                                        // draws outward from the middle
    const g = geometry(el)[0], L = g.getTotalLength() as number;
    snap(g);
    return p => {
      if (p >= 1) { restoreStroke(g); return; }
      const s = L / 2 * p;
      g.style.strokeDasharray = `${(2 * s).toFixed(1)} ${L.toFixed(1)}`;
      g.style.strokeDashoffset = (s - L / 2).toFixed(1);
      g.style.visibility = p > 0 ? '' : 'hidden';
    };
  },
  // Text nodes are cut, not the element's text, so tspans (coloured code, an <em>) survive. p=1 restores each.
  type: el => {
    const nodes: Text[] = [];
    const walk = (n: Node) => { for (const k of n.childNodes) { if (k.nodeType === 3) nodes.push(k as Text); else walk(k); } };
    walk(el);
    const fin = nodes.map(n => n.data), total = fin.reduce((s, x) => s + x.length, 0);
    return p => {
      let left = p >= 1 ? Infinity : Math.round(total * Math.max(0, p));
      nodes.forEach((n, i) => { const k = Math.min(left, fin[i].length); n.data = fin[i].slice(0, k); left -= k; });
    };
  },
  // The first number anywhere inside counts, and every other character and tspan stays: "237 s", "14×".
  count: (el, a) => {
    const hit = numberNode(el);
    if (!hit) return () => {};
    const { text, fin, m } = hit;
    const num = parseFloat(m[0].replace(/,/g, '')), dec = (m[0].split('.')[1] ?? '').length;
    const commas = m[0].includes(','), from = a.from ?? 0;
    return p => {
      if (p >= 1) { text.data = fin; return; }
      const v = from + (num - from) * p;
      const s = commas ? v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) : v.toFixed(dec);
      text.data = fin.slice(0, m.index) + s + fin.slice(m.index! + m[0].length);
    };
  },
  animate: (el, a) => {
    const prop = a.style as string | undefined, attr = a.attr as string;
    const read = () => (prop ? (el as any).style[prop] || (getComputedStyle(el) as any)[prop] : el.getAttribute(attr)) ?? '';
    const write = (v: string | null) => {
      if (prop) (el as any).style[prop] = v ?? '';
      else if (v == null) el.removeAttribute(attr);
      else el.setAttribute(attr, v);
    };
    const drawn = prop ? (el as any).style[prop] as string : el.getAttribute(attr);
    const from = String(a.from ?? read()), to = String(a.to ?? read()), numbers = /-?\d*\.?\d+/g;
    const fromN = (from.match(numbers) ?? []).map(Number), toN = to.match(numbers) ?? [];
    return p => {
      if (p >= 1) { write(a.to == null ? drawn : to); return; }
      if (fromN.length !== toN.length) { write(p > 0 ? to : from); return; }   // nothing to interpolate
      let i = 0;
      write(to.replace(numbers, () => { const f = fromN[i], t = +toN[i++]; return String(+(f + (t - f) * p).toFixed(2)); }));
    };
  },
  stream: (el, a, api) => {                            // el is the path; each particle rides a part of the run
    const layer = api.fx(el), path = el as unknown as SVGGeometryElement, L = path.getTotalLength();
    const n = a.n ?? 12, life = a.life ?? .45, jitter = a.jitter ?? 0, r = a.r ?? 3.4;
    let seed = (a.seed ?? 7) >>> 0;
    const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const dots = Array.from({ length: n }, () => {
      const c = svgEl('circle', { r }, layer);
      c.style.fill = tone(a.tone);
      c.style.visibility = 'hidden';
      return { c, start: rnd() * (1 - life), off: (rnd() * 2 - 1) * jitter };
    });
    return p => {
      for (const d of dots) {
        const q = (p - d.start) / life, on = p > 0 && p < 1 && q > 0 && q < 1;
        d.c.style.visibility = on ? '' : 'hidden';
        if (!on) continue;
        const pt = path.getPointAtLength(q * L), ahead = path.getPointAtLength(Math.min(L, q * L + 1));
        const nx = -(ahead.y - pt.y), ny = ahead.x - pt.x;
        d.c.setAttribute('cx', (pt.x + nx * d.off).toFixed(1));
        d.c.setAttribute('cy', (pt.y + ny * d.off).toFixed(1));
        d.c.setAttribute('opacity', Math.min(1, Math.min(q, 1 - q) * 6).toFixed(2));
      }
    };
  },
  tint: (el, a) => {
    const prop = a.prop ?? (el instanceof SVGElement && el.tagName !== 'use' ? 'fill' : 'color');
    const to = (getComputedStyle(el) as any)[prop] as string, from = tone(a.from), end = endOpacity(el), op = a.opacity;
    return p => {
      (css(el) as any)[prop] = p >= 1 ? base(el, prop) : `color-mix(in srgb, ${to} ${(p * 100).toFixed(1)}%, ${from})`;
      if (op != null) css(el).opacity = p >= 1 ? base(el, 'opacity') : (op + (end - op) * p).toFixed(3);
    };
  },
  hot: (el, a) => { const cls = a.cls ?? 'hot'; return p => { el.classList.toggle(cls, p > 0 && p < 1); }; },
  pulse: el => {
    const end = endOpacity(el);
    return p => { css(el).opacity = p <= 0 || p >= 1 ? base(el, 'opacity') : (end * (1 - .7 * Math.sin(Math.PI * p))).toFixed(3); };
  },
  bump: (el, a) => {
    const set = scaler(el), amt = a.amount ?? .14;
    return p => { set(p <= 0 || p >= 1 ? 1 : 1 + amt * Math.sin(Math.PI * p)); };
  },
  march: (el, a) => {
    const c = a.cycle ?? 14;
    return p => { css(el).strokeDashoffset = p <= 0 || p >= 1 ? base(el, 'strokeDashoffset') : (-c * p).toFixed(2); };
  },
  ripple: (el, a, api) => {
    const layer = api.fx(el), o = api.center(el, layer), r0 = a.r0 ?? 5, r1 = a.r1 ?? 24;
    const ring = svgEl('circle', { cx: o.x.toFixed(1), cy: o.y.toFixed(1), r: r0, fill: 'none', 'stroke-width': a.width ?? 1.8 }, layer);
    ring.style.stroke = tone(a.tone);
    ring.style.visibility = 'hidden';
    return p => {
      if (p <= 0 || p >= 1) { ring.style.visibility = 'hidden'; return; }
      ring.style.visibility = '';
      ring.setAttribute('r', (r0 + (r1 - r0) * p).toFixed(1));
      ring.setAttribute('opacity', (1 - p).toFixed(3));
    };
  },
  // A scene owns its root: each phase's track plays that step of the replay. The engine made the Sim and timed it.
  scene: (el, a) => { const sim = simFor(el, a.scene, a.window ?? 6000); return p => sim.apply(a.index, p); },
  travel: (el, a, api) => {                            // el is the path; a particle rides it
    const layer = api.fx(el), path = el as unknown as SVGGeometryElement, L = path.getTotalLength(), r = a.r ?? 3.6;
    const from = a.from ?? 0, to = a.to ?? 1, tail = a.tail ?? 0;
    const halo = svgEl('circle', { r: r * 2.4, opacity: .16 }, layer), dot = svgEl('circle', { r }, layer);
    const line = tail ? svgEl('line', { 'stroke-width': r * .7, 'stroke-linecap': 'round', opacity: .45 }, layer) : null;
    for (const n of [halo, dot]) { n.style.fill = tone(a.tone); n.style.visibility = 'hidden'; }
    if (line) { line.style.stroke = tone(a.tone); line.style.visibility = 'hidden'; }
    return p => {
      const on = p > 0 && p < 1;
      for (const n of [halo, dot, line]) if (n) n.style.visibility = on ? '' : 'hidden';
      if (!on) return;
      const at = (q: number) => path.getPointAtLength((from + (to - from) * q) * L);
      const pt = at(p);
      for (const n of [halo, dot]) { n.setAttribute('cx', pt.x.toFixed(1)); n.setAttribute('cy', pt.y.toFixed(1)); }
      if (line) {
        const b = at(Math.max(0, p - tail));
        line.setAttribute('x1', b.x.toFixed(1)); line.setAttribute('y1', b.y.toFixed(1));
        line.setAttribute('x2', pt.x.toFixed(1)); line.setAttribute('y2', pt.y.toFixed(1));
      }
    };
  },
};

export function bindTrack(t: Track, api: BindApi): Apply {
  const el = api.node(t.n);
  const f = t.k === 'track' ? custom[t.a?.name] : FACTORIES[t.k];
  if (!f || !el) { console.error('present: cannot bind track', t.k, t.a?.name ?? '', t.n); return () => {}; }
  snap(el);
  return f(el, t.a ?? {}, api);
}
