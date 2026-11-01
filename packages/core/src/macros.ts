// Macros: capitalised tags that expand to plain HTML/SVG at build time. <slot/> marks children.
import { createRequire } from 'node:module';
import { attrStr, parseMarkup, serialize, walk, type XNode } from './parse.ts';
import type { Diagnostic } from './diagnostics.ts';

const octicons = createRequire(import.meta.url)('@primer/octicons') as Record<string, { heights: Record<string, { path: string }> }>;

export interface MacroCtx { diagram: boolean; boxes: Map<string, Rect>; slide: string; diags: Diagnostic[]; }
export interface Rect { x: number; y: number; w: number; h: number; }
type A = Record<string, string>;
export interface MacroDef {
  doc: string; example: string; props: string;
  html?: (a: A, c: MacroCtx) => string;
  svg?: (a: A, c: MacroCtx) => string;
}

const esc = (s: string) => s.replace(/&(?!\w+;|#\d+;)/g, '&amp;').replace(/</g, '&lt;');
const num = (a: A, k: string, d = 0) => { const v = parseFloat(a[k]); return isNaN(v) ? d : v; };
export const pass = (a: A, extra = '') => {
  const out: A = {};
  if (a.id) out.id = a.id;
  const cls = [extra, a.class].filter(Boolean).join(' ');
  if (cls) out.class = cls;
  if (a.style) out.style = a.style;
  if (a.spot != null) out['data-spot'] = '';
  return attrStr(out);
};
const toneVar = (t?: string) => (t ? `--tone:var(--${t});` : '');
const withStyle = (a: A, s: string) => ({ ...a, style: s + (a.style ?? '') });

export function iconPath(name: string) {
  const o = octicons[name];
  return o ? o.heights['24']?.path ?? o.heights['16'].path : null;
}
export const iconNames = () => Object.keys(octicons);
function iconSvg(name: string, c: MacroCtx, attrs: string) {
  const o = octicons[name];
  if (!o) {
    c.diags.push({ code: 'unknown-icon', severity: 'error', slide: c.slide, message: `Unknown icon "${name}"`, fix: 'Use an Octicon name; see catalog' });
    return `<svg${attrs}></svg>`;
  }
  const h = o.heights['24'] ? 24 : 16;
  return `<svg viewBox="0 0 ${h} ${h}" fill="currentColor"${attrs}>${o.heights[h].path}</svg>`;
}
const wrapText = (s: string, x: number, y: number, lh: number, cls: string, anchor = 'middle') => {
  const lines = s.split('\\n');
  const y0 = y - (lines.length - 1) * lh / 2;
  return lines.map((l, i) => `<text class="${cls}" x="${x}" y="${y0 + i * lh}" text-anchor="${anchor}">${esc(l)}</text>`).join('');
};

export function linkPath(a: Rect, b: Rect): string {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const gapX = bc.x > ac.x ? b.x - (a.x + a.w) : a.x - (b.x + b.w);
  const gapY = bc.y > ac.y ? b.y - (a.y + a.h) : a.y - (b.y + b.h);
  if (gapY > gapX) {                                   // vertical
    const down = bc.y > ac.y, y1 = down ? a.y + a.h : a.y, y2 = down ? b.y : b.y + b.h;
    const shared = [Math.max(a.x, b.x), Math.min(a.x + a.w, b.x + b.w)];
    if (shared[0] < shared[1]) { const x = (shared[0] + shared[1]) / 2; return `M ${x} ${y1} L ${x} ${y2}`; }
    const m = (y1 + y2) / 2;
    return `M ${ac.x} ${y1} L ${ac.x} ${m} L ${bc.x} ${m} L ${bc.x} ${y2}`;
  }
  const right = bc.x > ac.x, x1 = right ? a.x + a.w : a.x, x2 = right ? b.x : b.x + b.w;
  const shared = [Math.max(a.y, b.y), Math.min(a.y + a.h, b.y + b.h)];
  if (shared[0] < shared[1]) { const y = (shared[0] + shared[1]) / 2; return `M ${x1} ${y} L ${x2} ${y}`; }
  const m = (x1 + x2) / 2;
  return `M ${x1} ${ac.y} L ${m} ${ac.y} L ${m} ${bc.y} L ${x2} ${bc.y}`;
}

export const MACROS: Record<string, MacroDef> = {
  Header: {
    doc: 'Slide headline. Words rise in turn. Use <em> for the accent phrase. Give it an id to edit it with setText.', props: 'id?, aside?',
    example: '<Header aside="Illustrative">Customers pay for <em>business results</em></Header>',
    html: a => `<div${pass(a, 'p-header')}><h2 class="p-h" data-words=""><slot/></h2>${a.aside ? `<div class="p-aside">${esc(a.aside)}</div>` : ''}</div>`,
  },
  Title: {
    doc: 'Hero headline for a title slide.', props: '',
    example: '<Center><Title>Learnings from <em>the field</em></Title></Center>',
    html: a => `<h1${pass(a, 'p-hero')} data-words=""><slot/></h1>`,
  },
  Sub: { doc: 'Muted subtitle.', props: '', example: '<Sub>A short framing sentence.</Sub>', html: a => `<p${pass(a, 'p-sub')}><slot/></p>` },
  Text: { doc: 'Body text.', props: '', example: '<Text>One idea.</Text>', html: a => `<p${pass(a, 'p-text')}><slot/></p>` },
  Eyebrow: { doc: 'Small accent label pill.', props: '', example: '<Eyebrow>Part one</Eyebrow>', html: a => `<div${pass(a)}><span class="p-eyebrow"><slot/></span></div>` },
  Stack: { doc: 'Vertical layout.', props: 'gap?', example: '<Stack gap="16">...</Stack>', html: a => `<div${pass(withStyle(a, a.gap ? `--gap:${a.gap}px;` : ''), 'p-stack')}><slot/></div>` },
  Row: { doc: 'Horizontal layout.', props: 'gap?, align?', example: '<Row gap="16">...</Row>', html: a => `<div${pass(withStyle(a, (a.gap ? `--gap:${a.gap}px;` : '') + (a.align ? `--align:${a.align};` : '')), 'p-row')}><slot/></div>` },
  Center: { doc: 'Centred vertical layout.', props: '', example: '<Center>...</Center>', html: a => `<div${pass(a, 'p-center')}><slot/></div>` },
  Columns: {
    doc: 'Columns by ratio.', props: 'ratio (e.g. 1:1.3), gap?', example: '<Columns ratio="1:1.3">...</Columns>',
    html: a => {
      const cols = (a.ratio ?? '1:1').split(':').map(x => `minmax(0,${parseFloat(x) || 1}fr)`).join(' ');
      return `<div${pass(withStyle(a, `grid-template-columns:${cols};` + (a.gap ? `--gap:${a.gap}px;` : '')), 'p-columns')}><slot/></div>`;
    },
  },
  Grid: { doc: 'Equal grid.', props: 'cols, gap?', example: '<Grid cols="3">...</Grid>', html: a => `<div${pass(withStyle(a, `--cols:${a.cols ?? 3};` + (a.gap ? `--gap:${a.gap}px;` : '')), 'p-grid')}><slot/></div>` },
  Card: {
    doc: 'Card. In HTML it flows with its content. In a Diagram it needs x, y, w, h and is a box for Link.',
    props: 'id, tone (accent|ok|warn|danger), label?, title?, icon?; in a Diagram: x y w h',
    example: '<Card id="a" tone="danger" label="What we assume" icon="circle-slash">...</Card>',
    html: (a, c) => {
      const head = a.label || a.icon ? `<div class="p-card-head"><span>${esc(a.label ?? '')}</span>${a.icon ? iconSvg(a.icon, c, ' class="p-icon"') : ''}</div>` : '';
      return `<div${pass(withStyle(a, toneVar(a.tone)), 'p-card')}${a.tone ? ` data-tone="${a.tone}"` : ''}>${head}${a.title ? `<h3 class="p-card-title">${esc(a.title)}</h3>` : ''}<slot/></div>`;
    },
    svg: (a, c) => {
      const x = num(a, 'x'), y = num(a, 'y'), w = num(a, 'w'), h = num(a, 'h'), col = a.tone ? `var(--${a.tone})` : 'var(--muted)';
      const icon = a.icon ? iconSvg(a.icon, c, ` x="${x + w - 52}" y="${y + 29}" width="24" height="24" style="color:${col}"`) : '';
      return `<g${pass(a)} data-box=""><rect class="card" x="${x}" y="${y}" width="${w}" height="${h}" rx="12"/>${a.tone ? `<rect class="bar" x="${x}" y="${y}" width="${w}" height="3" rx="1.5" style="fill:${col}"/>` : ''}${a.label ? `<text class="m lbl" x="${x + 28}" y="${y + 46}" style="fill:${col}">${esc(a.label)}</text>` : ''}${a.title ? `<text class="st" x="${x + 28}" y="${y + 50}">${esc(a.title)}</text>` : ''}${icon}<slot/></g>`;
    },
  },
  Stat: {
    doc: 'Big number with a label. Target its id with count to count it up. HTML only.', props: 'id, value, label, tone? (any token)',
    example: '<Stat id="s1" value="+0.059" label="Gain over baseline" />',
    html: a => `<div${pass(withStyle(a, toneVar(a.tone)), 'p-stat')}><div class="p-stat-v" ${a.id ? `id="${a.id}-v"` : ''}>${esc(a.value ?? '')}</div><div class="p-stat-l">${esc(a.label ?? '')}</div><slot/></div>`,
  },
  Pill: { doc: 'Small rounded tag.', props: '', example: '<Pill>Model</Pill>', html: a => `<span${pass(a, 'p-pill')}><slot/></span>` },
  Pills: { doc: 'Row of pills.', props: '', example: '<Pills><Pill>A</Pill></Pills>', html: a => `<div${pass(a, 'p-pills')}><slot/></div>` },
  Item: { doc: 'Bullet line.', props: '', example: '<Item>One point</Item>', html: a => `<div${pass(a, 'p-item')}><span><slot/></span></div>` },
  Icon: {
    doc: 'Octicon by name. In a Diagram give x, y, size.', props: 'name, x?, y?, size?, tone?',
    example: '<Icon name="lock" x="48" y="159" size="30" />',
    html: (a, c) => iconSvg(a.name, c, `${pass(a, 'p-icon')}`),
    svg: (a, c) => {
      const s = num(a, 'size', 24);
      const o = octicons[a.name], h = o?.heights['24'] ? 24 : 16;
      if (!o) return iconSvg(a.name, c, '');
      return `<g${pass(withStyle(a, a.tone ? `color:var(--${a.tone});` : ''), a.tone ? '' : 'ic-d')}><g transform="translate(${num(a, 'x')} ${num(a, 'y')}) scale(${s / h})" fill="currentColor">${o.heights[h].path}</g></g>`;
    },
  },
  Diagram: {
    doc: 'SVG canvas with fixed coordinates for dense drawings. Raw SVG is allowed inside. alt is required.',
    props: 'viewBox, alt', example: '<Diagram viewBox="0 0 1600 600" alt="What it shows">...</Diagram>',
    html: (a, c) => `<svg${pass(a, 'p-diagram')} viewBox="${a.viewBox ?? '0 0 1600 700'}" role="img" aria-label="${esc(a.alt ?? '')}"><defs><marker id="${c.slide}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/></marker></defs><slot/></svg>`,
  },
  Box: {
    doc: 'Diagram box, a target for Link. Text in title is centred; use \\n for a second line.',
    props: 'id, x, y, w, h, tone?, title?, sub?, label?, r?', example: '<Box id="kpi" x="40" y="96" w="400" h="120" tone="accent" title="ROI" />',
    svg: a => {
      const x = num(a, 'x'), y = num(a, 'y'), w = num(a, 'w'), h = num(a, 'h');
      const cy = y + h / 2 + (a.sub ? -6 : 7);
      return `<g${pass(a)} data-box=""${a.tone ? ` data-tone="${a.tone}"` : ''}><rect class="card" x="${x}" y="${y}" width="${w}" height="${h}" rx="${a.r ?? 9}"/>${a.label ? `<text class="m lbl" x="${x + 20}" y="${y + 32}">${esc(a.label)}</text>` : ''}${a.title ? wrapText(a.title, x + w / 2, cy, 26, 'nm-l') : ''}${a.sub ? wrapText(a.sub, x + w / 2, cy + 26, 20, 'sm') : ''}<slot/></g>`;
    },
  },
  Chip: {
    doc: 'Rounded tag in a Diagram. Give it class part to light it with hot.', props: 'x, y, w?, h?, id?',
    example: '<Chip x="842" y="502" w="122">MODEL</Chip>',
    svg: a => {
      const x = num(a, 'x'), y = num(a, 'y'), w = num(a, 'w', 122), h = num(a, 'h', 38);
      return `<g${pass(a, 'chip')} data-box=""><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/><text class="m" x="${x + w / 2}" y="${y + h / 2 + 5}" text-anchor="middle" font-size="13" letter-spacing="1.4"><slot/></text></g>`;
    },
  },
  Link: {
    doc: 'Connector between two boxes by id, routed at build time. It is a real path, so draw and travel can target it.',
    props: 'id, from, to, tone? (accent|ok|warn|danger), dashed?, arrow? (default true)', example: '<Link id="l1" from="kpi" to="lat" tone="accent" />',
    svg: (a, c) => {
      const p = c.boxes.get(a.from), q = c.boxes.get(a.to);
      if (!p || !q) {
        c.diags.push({ code: 'dangling-link', severity: 'error', slide: c.slide, id: a.id, message: `Link ${a.from} → ${a.to} has no such box`, fix: 'from and to must be ids of a Box, Card or Chip in this Diagram' });
        return '';
      }
      const cls = a.dashed != null ? 'conn-d' : a.tone === 'accent' ? 'conn-a' : 'conn';
      const st = a.tone && a.tone !== 'accent' ? withStyle(a, `stroke:var(--${a.tone});`) : a;
      return `<path${pass(st, cls)} d="${linkPath(p, q)}"${a.arrow === 'false' ? '' : ` marker-end="url(#${c.slide}-arrow)"`}/>`;
    },
  },
  Label: {
    doc: 'Caps mono label. A few words only, never a sentence.', props: 'x?, y?, anchor? in a Diagram', example: '<Label x="48" y="62">End to end</Label>',
    html: a => `<div${pass(a, 'p-label')}><slot/></div>`,
    svg: a => `<text${pass(a, 'm lbl')} x="${num(a, 'x')}" y="${num(a, 'y')}"${a.anchor ? ` text-anchor="${a.anchor}"` : ''}><slot/></text>`,
  },
  Strike: {
    doc: 'Red strikethrough line for a Diagram. Target with draw.', props: 'x1, x2, y', example: '<Strike class="strike" x1="92" x2="398" y="174" />',
    svg: a => `<path${pass(a)} d="M ${num(a, 'x1')} ${num(a, 'y')} L ${num(a, 'x2')} ${num(a, 'y')}" fill="none" stroke-width="3.2" stroke-linecap="round" style="stroke:var(--danger)"/>`,
  },
  Badge: {
    doc: 'Small round status mark for a Diagram. Target with pop.', props: 'x, y, tone?, r?', example: '<Badge class="badge" x="77" y="160" tone="danger" />',
    svg: a => {
      const x = num(a, 'x'), y = num(a, 'y'), r = num(a, 'r', 8), d = r * .34;
      const col = `var(--${a.tone ?? 'danger'})`;
      const glyph = (a.tone ?? 'danger') === 'danger' ? `M ${x - d} ${y - d} L ${x + d} ${y + d} M ${x + d} ${y - d} L ${x - d} ${y + d}` : `M ${x - d} ${y} L ${x - d * .2} ${y + d} L ${x + d} ${y - d}`;
      return `<g${pass(a)}><circle cx="${x}" cy="${y}" r="${r}" stroke="#fff" stroke-width="2" style="fill:${col}"/><path d="${glyph}" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round"/></g>`;
    },
  },
  Trend: {
    doc: 'Rising sparkline. Decoration only, no axis. Target the id with draw.', props: 'id, x, y, w, h, points (comma list)', example: '<Trend id="trend" x="1408" y="120" w="120" h="70" points="2,3,3,5,4,7,9" />',
    svg: a => {
      const x = num(a, 'x'), y = num(a, 'y'), w = num(a, 'w', 120), h = num(a, 'h', 70);
      const v = (a.points ?? '1,2,3').split(',').map(Number), max = Math.max(...v), min = Math.min(...v);
      const pts = v.map((n, i) => [x + i * w / (v.length - 1), y + h - (n - min) / (max - min || 1) * h].map(k => +k.toFixed(1)));
      const d = 'M ' + pts.map(p => p.join(' ')).join(' L ');
      const last = pts[pts.length - 1];
      return `<path${pass(a)} d="${d}" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--accent)"/><circle cx="${last[0]}" cy="${last[1]}" r="4.5" ${a.id ? `id="${a.id}-head"` : ''} style="fill:var(--accent)"/>`;
    },
  },
};

const isMacro = (n: XNode) => n.type === 'tag' && !!n.name && /^[A-Z]/.test(n.name);

/** Collect box geometry first, so a Link can point at a box defined after it. */
export function collectBoxes(root: XNode): Map<string, Rect> {
  const m = new Map<string, Rect>();
  walk(root, e => {
    const a = e.attribs ?? {};
    if (a.id && ['Box', 'Card', 'Chip'].includes(e.name!) && a.x != null) {
      m.set(a.id, { x: +a.x, y: +a.y, w: +(a.w ?? 122), h: +(a.h ?? 38) });
    }
  });
  return m;
}

/** Expand every macro in place. Returns plain HTML/SVG nodes. */
export function expand(n: XNode, c: MacroCtx, project: Record<string, MacroDef> = {}): XNode {
  if (n.type !== 'tag' && !n.children) return n;
  const inDiagram = c.diagram || n.name === 'svg' || n.name === 'Diagram';
  const kids: XNode[] = [];
  for (const ch of n.children ?? []) {
    if (ch.type === 'comment') continue;
    if (!isMacro(ch)) { kids.push(expand(ch, { ...c, diagram: inDiagram }, project)); continue; }
    const def = project[ch.name!] ?? MACROS[ch.name!];
    const childCtx = { ...c, diagram: inDiagram };
    const f = def && (inDiagram ? def.svg ?? (ch.name === 'Icon' ? def.html : undefined) : def.html ?? undefined);
    if (!def || !f) {
      const known = !!def;
      c.diags.push({
        code: known ? 'macro-context' : 'unknown-macro', severity: 'error', slide: c.slide, id: ch.attribs?.id,
        message: known ? `<${ch.name}> cannot be used ${inDiagram ? 'inside' : 'outside'} a Diagram` : `Unknown macro <${ch.name}>`,
        fix: known ? 'Move it, or use its counterpart' : `Known macros: ${Object.keys(MACROS).join(', ')}`,
      });
      continue;
    }
    const known = new Set([...def.props.matchAll(/[A-Za-z][A-Za-z0-9]*/g)].map(m => m[0]).concat(['id', 'class', 'style', 'spot', 'data-src', 'data-n']));
    for (const k of Object.keys(ch.attribs ?? {})) {
      if (!known.has(k) && !k.startsWith('data-') && !k.startsWith('aria-')) c.diags.push({ code: 'unknown-prop', severity: 'warning', slide: c.slide, id: ch.attribs?.id, message: `<${ch.name}> ignores ${k}`, fix: `Props: ${def.props || 'none'}` });
    }
    const nextDiagram = inDiagram || ch.name === 'Diagram';
    const out = parseMarkup(f(ch.attribs ?? {}, childCtx));
    const inner = (ch.children ?? []).map(k => {
      if (k.type === 'comment') return null;
      return k;
    }).filter(Boolean) as XNode[];
    const holder: XNode = { type: 'tag', name: '#', attribs: {}, children: inner };
    const expandedKids = expand(holder, { ...c, diagram: nextDiagram }, project).children ?? [];
    const first = (out.children ?? []).find(k => k.type === 'tag');
    if (first && ch.attribs?.['data-src'] != null) (first.attribs ??= {})['data-src'] = ch.attribs['data-src'];
    fillSlot(out, expandedKids);
    kids.push(...(out.children ?? []));
  }
  n.children = kids;
  return n;
}

function fillSlot(n: XNode, kids: XNode[]) {
  const list = n.children ?? [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].type === 'tag' && list[i].name === 'slot') { list.splice(i, 1, ...kids); return; }
    fillSlot(list[i], kids);
  }
}

export const toHtml = (root: XNode) => (root.children ?? []).map(serialize).join('');
