// Macros: capitalised tags that expand to plain HTML/SVG at build time. <slot/> marks children.
import { createRequire } from 'node:module';
import { attrStr, parseMarkup, serialize, textOf, walk, type XNode } from './parse.ts';
import type { Diagnostic } from './diagnostics.ts';
import { FIGURES } from './figures.ts';

const require = createRequire(import.meta.url);
const octicons = require('@primer/octicons') as Record<string, { heights: Record<string, { path: string }> }>;
const katex = require('katex') as { renderToString(tex: string, o: Record<string, unknown>): string };

export interface MacroCtx {
  diagram: boolean; boxes: Map<string, Rect>; slide: string; diags: Diagnostic[];
  text?: string;                                // the text between a macro's tags
  read?: (path: string) => string | null;       // a file in the deck; absent when only checking an edit
  terms?: TermGroup[];                          // define= on the elements around this one
}
export interface TermGroup { defs: { sym: string; def: string }[]; used: Set<string>; id?: string; }
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
  if (a.goto) out['data-goto'] = a.goto;
  if (a.act) out['data-act'] = a.act;
  return attrStr(out);
};
const toneVar = (t?: string) => (t ? `--tone:var(--${t});` : '');
const dataTone = (t?: string) => (t?.startsWith('data-') ? toneVar(t) : '');   // a data colour has no styles of its own
const withStyle = (a: A, s: string) => ({ ...a, style: s + (a.style ?? '') });
// A theme sets each kind of text in px, so a container's font-size reaches nothing: size sets the body text by a variable.
const textSize = (a: A) => (a.size ? `font-size:${num(a, 'size')}px;` : '');
const bodySize = (a: A) => (a.size ? `--text-size:${num(a, 'size')}px;` : '');
const fillAttr = (a: A) => (a.fill != null && a.fill !== 'false' ? ' data-fill=""' : '');

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
const wrapText = (s: string, x: number, y: number, lh: number, cls: string, size?: number) => {
  const lines = s.split('\\n');
  const y0 = y - (lines.length - 1) * lh / 2;
  return lines.map((l, i) => `<text class="${cls}" x="${x}" y="${y0 + i * lh}" text-anchor="middle"${size ? ` style="font-size:${size}px"` : ''}>${esc(l)}</text>`).join('');
};
const BASELINE = 1.03;                                 // first baseline below the top of a TextBlock, in font sizes
const round2 = (n: number) => +n.toFixed(2);
const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const attrText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const PROSE = new Set('in is of to if or on at by as an be we and the for all but not are with then from that else'.split(' '));
/** Plain words in LaTeX come out as a product of italic variables. Short runs are usually just that, so only known words count. */
function proseIn(tex: string) {
  const bare = tex.replace(/\\(text\w*|math(rm|bf|sf|tt|it|cal|bb)|operatorname\*?|mbox|hbox|label|tag|color|begin|end)\s*\{[^{}]*\}/g, ' ').replace(/\\[a-zA-Z]+/g, ' ');
  return [...new Set((bare.match(/[A-Za-z]{2,}/g) ?? []).filter(w => w.length >= 4 || PROSE.has(w.toLowerCase())))];
}

/** "H: height of the tree; b: bits guessed" as pairs. A meaning is one short sentence, so ; ends it. */
export function definitions(s?: string) {
  return (s ?? '').split(';').map(p => p.trim()).filter(Boolean).map(p => {
    const i = p.indexOf(':');
    return i < 0 ? { sym: p, def: '' } : { sym: p.slice(0, i).trim(), def: p.slice(i + 1).trim() };
  });
}
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Marks only the first place each defined symbol appears: it is explained once, where it is first read. */
function markTerms(tex: string, a: A, c: MacroCtx) {
  const defs = definitions(unescape(a.define ?? '')), found: { sym: string; def: string }[] = [];
  // A define on a parent (a Card, a Diagram, a group) covers every formula inside it: each symbol is marked where it first appears.
  for (const g of c.terms ?? []) for (const { sym, def } of g.defs) {
    if (!sym || !def || g.used.has(sym)) continue;
    const re = new RegExp(`(?<![\\\\A-Za-z])${reEsc(sym)}(?![A-Za-z])`);
    if (!re.test(tex)) continue;
    tex = tex.replace(re, `{\\htmlData{term=${found.length}}{${sym}}}`);
    found.push({ sym, def });
    g.used.add(sym);
  }
  for (const { sym, def } of defs) {
    const bad = (message: string, fix: string) => c.diags.push({ code: 'bad-define', severity: 'error', slide: c.slide, id: a.id, message, fix });
    if (!sym || !def) { bad(`define "${sym}" has no meaning`, 'Write define="H: what H means; b: what b means"'); continue; }
    // Not inside a command name (b in \beta) and not the start of a longer word.
    const re = new RegExp(`(?<![\\\\A-Za-z])${reEsc(sym)}(?![A-Za-z])`);
    if (!re.test(tex)) { bad(`define names "${sym}", which is not in the formula`, 'Name a symbol exactly as the LaTeX writes it, like x_i or \\theta'); continue; }
    tex = tex.replace(re, `{\\htmlData{term=${found.length}}{${sym}}}`);
    found.push({ sym, def });
  }
  return { tex, found };
}
const trustTerms = (ctx: { command: string }) => ctx.command === '\\htmlData';

/** Typeset at build time, so a deck needs no maths library when it plays. */
function formula(a: A, c: MacroCtx) {
  const tex = unescape((a.tex ?? c.text ?? '').trim());
  const fail = (message: string) => { c.diags.push({ code: 'bad-math', severity: 'error', slide: c.slide, id: a.id, message, fix: 'Fix the LaTeX. Write \\lt for <' }); return `<span>${esc(tex)}</span>`; };
  if (!tex) return { tex, html: fail('Math has no formula') };
  const words = proseIn(tex);
  if (words.length) c.diags.push({ code: 'math-word', severity: 'warning', slide: c.slide, id: a.id, message: `"${words.join(', ')}" in a formula is set as italic letters`, fix: 'Put words in \\text{...}' });
  const marked = markTerms(tex, a, c);
  try {
    let html = katex.renderToString(marked.tex, { displayMode: a.display != null && a.display !== 'false', output: 'html', throwOnError: true, strict: 'ignore', trust: marked.found.length ? trustTerms : false });
    html = html.replace(/data-term="(\d+)"/g, (_, i) => { const t = marked.found[+i]; return `data-term="${attrText(t.sym)}" data-def="${attrText(t.def)}"`; });
    // The glyphs are hidden from screen readers, so the label carries the meanings.
    const label = marked.found.length ? `${tex}, where ${marked.found.map(t => `${t.sym} is ${t.def}`).join('; ')}` : tex;
    return { tex, html, label };
  }
  catch (e: any) { return { tex, html: fail(`Cannot typeset "${tex.slice(0, 40)}": ${String(e.message).split('\n')[0]}`) }; }
}
const mathStyle = (a: A) => (a.size ? `font-size:${num(a, 'size')}px;` : '') + toneVar(a.tone);
/** The same keys that drive the deck still work while the embedded page has focus. */
// An embedded page runs twice, on the audience's screen and in the presenter's pane. The seed gives both the same
// random numbers, and the bridge replays a click on one in the other, so they stay the same page.
const SEEDED = `<script>(function(s){function r(){s|=0;s=s+0x6D2B79F5|0;var t=Math.imul(s^s>>>15,1|s);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}Math.random=r;Object.defineProperty(crypto,'getRandomValues',{value:function(a){for(var i=0;i<a.length;i++)a[i]=Math.floor(r()*4294967296);return a}})})(PRESENT_SEED)</script>`;
const BRIDGE = `<script>(function(){addEventListener('keydown',function(e){if(!/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))parent.postMessage({present:'key',key:e.key},'*')});addEventListener('click',function(e){if(e.isTrusted)parent.postMessage({present:'embed',x:e.clientX,y:e.clientY},'*')},true);addEventListener('message',function(e){var d=e.data;if(!d||d.present!=='click')return;var t=document.elementFromPoint(d.x,d.y);if(t)['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(n){t.dispatchEvent(new(n[0]==='p'?PointerEvent:MouseEvent)(n,{bubbles:true,cancelable:true,clientX:d.x,clientY:d.y}))})})})()</script>`;
const embedded = (page: string) => { const head = /^\s*<!doctype[^>]*>/i.exec(page)?.[0] ?? ''; return head + SEEDED + page.slice(head.length) + BRIDGE; };

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
  Sub: { doc: 'Muted subtitle. size in px.', props: 'size?', example: '<Sub>A short framing sentence.</Sub>', html: a => `<p${pass(withStyle(a, textSize(a)), 'p-sub')}><slot/></p>` },
  Text: { doc: 'Body text, 26px. size in px.', props: 'size?', example: '<Text size="30">One idea.</Text>', html: a => `<p${pass(withStyle(a, textSize(a)), 'p-text')}><slot/></p>` },
  Eyebrow: { doc: 'Small accent label pill.', props: '', example: '<Eyebrow>Part one</Eyebrow>', html: a => `<div${pass(a)}><span class="p-eyebrow"><slot/></span></div>` },
  Stack: { doc: 'Vertical layout. size sets the body text inside it, in px.', props: 'gap?, size?', example: '<Stack gap="16">...</Stack>', html: a => `<div${pass(withStyle(a, (a.gap ? `--gap:${a.gap}px;` : '') + bodySize(a)), 'p-stack')}><slot/></div>` },
  Row: { doc: 'Horizontal layout. size sets the body text inside it, in px.', props: 'gap?, align?, size?', example: '<Row gap="16">...</Row>', html: a => `<div${pass(withStyle(a, (a.gap ? `--gap:${a.gap}px;` : '') + (a.align ? `--align:${a.align};` : '') + bodySize(a)), 'p-row')}><slot/></div>` },
  Center: { doc: 'Centred vertical layout.', props: '', example: '<Center>...</Center>', html: a => `<div${pass(a, 'p-center')}><slot/></div>` },
  Columns: {
    doc: 'Columns by ratio. fill stretches them, and the cards in them, down to the bottom of the slide. size sets the body text inside, in px.', props: 'ratio (e.g. 1:1.3), gap?, fill?, size?', example: '<Columns ratio="1:1.3" fill="">...</Columns>',
    html: a => {
      const cols = (a.ratio ?? '1:1').split(':').map(x => `minmax(0,${parseFloat(x) || 1}fr)`).join(' ');
      return `<div${pass(withStyle(a, `grid-template-columns:${cols};` + (a.gap ? `--gap:${a.gap}px;` : '') + bodySize(a)), 'p-columns')}${fillAttr(a)}><slot/></div>`;
    },
  },
  Grid: {
    doc: 'Equal grid. fill stretches its rows, and the cards in them, down to the bottom of the slide, so a few cards do not sit in the top half. size sets the body text inside, in px.',
    props: 'cols, gap?, fill?, size?', example: '<Grid cols="3" fill="" size="30">...</Grid>',
    html: a => `<div${pass(withStyle(a, `--cols:${a.cols ?? 3};` + (a.gap ? `--gap:${a.gap}px;` : '') + bodySize(a)), 'p-grid')}${fillAttr(a)}><slot/></div>`,
  },
  Card: {
    doc: 'Card. In HTML it flows with its content; size sets its body text in px, and its title in proportion. In a Diagram it needs x, y, w, h and is a box for Link.',
    props: 'id, tone (accent|ok|warn|danger), label?, title?, icon?, size?; in a Diagram: x y w h',
    example: '<Card id="a" tone="danger" label="What we assume" icon="circle-slash">...</Card>',
    html: (a, c) => {
      const head = a.label || a.icon ? `<div class="p-card-head"><span>${esc(a.label ?? '')}</span>${a.icon ? iconSvg(a.icon, c, ' class="p-icon"') : ''}</div>` : '';
      return `<div${pass(withStyle(a, toneVar(a.tone) + bodySize(a)), 'p-card')}${a.tone ? ` data-tone="${a.tone}"` : ''}>${head}${a.title ? `<h3 class="p-card-title">${esc(a.title)}</h3>` : ''}<slot/></div>`;
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
  Item: { doc: 'Bullet line. size in px.', props: 'size?', example: '<Item>One point</Item>', html: a => `<div${pass(withStyle(a, textSize(a)), 'p-item')}><span><slot/></span></div>` },
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
    doc: 'Diagram box, a target for Link. Text in title is centred; use \\n for a second line. size sets the title in px, default 20. sub is a smaller line under it, at subSize px: by default three quarters of size, or 14 with no size. A data-1 to data-6 tone colours the box as content.',
    props: 'id, x, y, w, h, tone?, title?, sub?, label?, r?, size?, subSize?', example: '<Box id="kpi" x="40" y="96" w="400" h="120" tone="accent" title="ROI" sub="what the customer pays for" size="26" />',
    svg: a => {
      const x = num(a, 'x'), y = num(a, 'y'), w = num(a, 'w'), h = num(a, 'h');
      const cy = y + h / 2 + (a.sub ? -6 : 7);
      const size = a.size ? num(a, 'size') : 0, lh = size ? Math.round(size * 1.3) : 26, sm = a.subSize ? num(a, 'subSize') : size ? Math.round(size * .75) : 0;
      const mid = size ? y + h / 2 + (a.sub ? -size * .3 : size * .35) : cy;
      return `<g${pass(withStyle(a, dataTone(a.tone)))} data-box=""${a.tone ? ` data-tone="${a.tone}"` : ''}><rect class="card" x="${x}" y="${y}" width="${w}" height="${h}" rx="${a.r ?? 9}"/>${a.label ? `<text class="m lbl" x="${x + 20}" y="${y + 32}">${esc(a.label)}</text>` : ''}${a.title ? wrapText(a.title, x + w / 2, mid, lh, 'nm-l', size) : ''}${a.sub ? wrapText(a.sub, x + w / 2, mid + Math.max(lh, sm ? Math.round(size * .55 + sm * .95) : 0), sm ? Math.round(sm * 1.35) : 20, 'sm', sm) : ''}<slot/></g>`;
    },
  },
  Chip: {
    doc: 'Rounded tag in a Diagram. Give it class part to light it with hot. size sets the text in px, default 13.', props: 'x, y, w?, h?, id?, size?',
    example: '<Chip x="842" y="502" w="122">MODEL</Chip>',
    svg: a => {
      const x = num(a, 'x'), y = num(a, 'y'), w = num(a, 'w', 122), h = num(a, 'h', 38), size = num(a, 'size', 13);
      return `<g${pass(a, 'chip')} data-box=""><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/><text class="m" x="${x + w / 2}" y="${y + h / 2 + Math.round(size * .38)}" text-anchor="middle" font-size="${size}" letter-spacing="1.4"><slot/></text></g>`;
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
      // The ends are kept, so the build cue knows what each link carries the eye to.
      return `<path${pass(st, cls)} d="${linkPath(p, q)}" data-from="${attrText(a.from)}" data-to="${attrText(a.to)}"${a.arrow === 'false' ? '' : ` marker-end="url(#${c.slide}-arrow)"`}/>`;
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
  Math: {
    doc: 'A formula in LaTeX, typeset when the deck is built, with its fonts inside the deck so it looks the same on every machine. Use it in any text: a Header, Text, Card or TextBlock. In a Diagram it stands alone: x is where it starts (anchor moves that), and y is its vertical middle. Put the LaTeX between the tags, or in tex. Write \\lt for <. display centres it on its own line at 40px. Elsewhere it takes the size of the text around it, or 26px on its own in a layout. size sets it in px. define explains symbols when the presenter points at them: define="H: height of the tree; b: bits the attacker guessed". Write each symbol as the LaTeX does (x_i, \\theta); only its first appearance is marked. Define only what the room cannot work out, a few per slide.',
    props: 'id?, class?, style?, tex?, display?, size?, tone?, define?; in a Diagram: x, y, anchor?, w?, h?',
    example: '<Text>The cost is <Math>O(n \\log n)</Math> per round.</Text>',
    html: (a, c) => {
      // Always a span: a div would break out of the <p> of a Text, and of any heading.
      const { tex, html, label } = formula(a, c), display = a.display != null && a.display !== 'false';
      return `<span${pass(withStyle(a, mathStyle(a)), display ? 'p-math p-math-display' : 'p-math')} role="img" aria-label="${attrText(label ?? tex)}">${html}</span>`;
    },
    svg: (a, c) => {
      const { tex, html, label } = formula(a, c), size = num(a, 'size', 28), w = num(a, 'w', 1200), h = num(a, 'h', size * 3), x = num(a, 'x');
      const left = a.anchor === 'middle' ? x - w / 2 : a.anchor === 'end' ? x - w : x, justify = a.anchor === 'middle' ? 'center' : a.anchor === 'end' ? 'flex-end' : 'flex-start';
      return `<foreignObject${pass(a)} x="${left}" y="${num(a, 'y') - h / 2}" width="${w}" height="${h}"><div class="p-math-line" style="justify-content:${justify};${mathStyle({ ...a, size: String(size) })}"><span class="p-math" role="img" aria-label="${attrText(label ?? tex)}">${html}</span></div></foreignObject>`;
    },
  },
  Term: {
    doc: 'A word or symbol the room may not know, explained in a small card when the presenter points at it. Nothing shows until then, so the slide must read without it. Mark a thing once, where it is first used, and only what the audience cannot work out: a few per slide at most. def is one short sentence. For symbols inside a formula, use define on the Math instead.',
    props: 'def, id?, class?',
    example: '<Text>Each proof is a path to the <Term def="The one hash at the top of the tree that every leaf rolls up to.">Merkle root</Term>.</Text>',
    html: (a, c) => {
      if (!a.def) c.diags.push({ code: 'bad-define', severity: 'error', slide: c.slide, id: a.id, message: 'Term has no def', fix: 'Say what it means in one short sentence' });
      return `<span${pass(a, 'p-term')} data-def="${attrText(unescape(a.def ?? ''))}"><slot/></span>`;
    },
  },
  TextBlock: {
    doc: 'Text that wraps by itself in a Diagram, and the way to mix words and <Math> on a line, since <text> cannot hold a formula. x and y are its top left corner and w is where it wraps. Leave out w to size it to its content on one line. To swap one in for a <text>: leave out w, baseline makes y the baseline of the first line, and anchor (start|middle|end) makes x work the same as text-anchor. nowrap keeps it on one line inside a given w. Inside it, write as in a slide: <em>, <Math> and the rest work. Give h to have overflow reported.',
    props: 'id?, class?, style?, x, y, w?, h?, size?, tone?, align?, anchor?, baseline?, nowrap?',
    example: '<TextBlock id="why" x="60" y="120" w="520" size="26">Any efficient cheat would break the <em>hardness assumption</em>.</TextBlock>',
    svg: a => {
      const flag = (k: string) => a[k] != null && a[k] !== 'false';
      // With no w the frame only gives the anchor room: the block itself is as wide as its text, so the checks see that.
      const fit = a.w == null, h = num(a, 'h'), size = num(a, 'size', 22), nowrap = fit || flag('nowrap'), w = num(a, 'w', 1600), x = num(a, 'x');
      const hug = !fit ? '' : `width:max-content;${a.anchor === 'middle' ? 'margin:0 auto;' : a.anchor === 'end' ? 'margin-left:auto;' : ''}`;
      const left = a.anchor === 'middle' ? x - w / 2 : a.anchor === 'end' ? x - w : x;
      const y = num(a, 'y') - (flag('baseline') ? round2(size * BASELINE) : 0);
      const align = a.align ?? (a.anchor === 'middle' ? 'center' : a.anchor === 'end' ? 'right' : '');
      return `<foreignObject${pass(a)} x="${left}" y="${y}" width="${w}" height="${h || 1}"><div class="p-textblock"${h ? ' data-fit=""' : ''} style="font-size:${size}px;${hug}${h ? `height:${h}px;` : ''}${align ? `text-align:${align};` : ''}${nowrap ? 'white-space:nowrap;' : ''}${a.tone ? `color:var(--${a.tone});` : ''}"><slot/></div></foreignObject>`;
    },
  },
  Embed: {
    doc: 'A live HTML page of your own on a slide, for what a slide cannot do: a poll, a picker, a demo. src is an .html file in the deck, and it is stored inside the deck, so it must be self-contained. It runs in a sandbox: its scripts work, but it cannot reach the deck, and exports show it as it first loads. It also runs in the presenter view, and clicks in either copy reach both, with the same random numbers, so you can drive it from your own screen. Typing and timers are not shared. For choosing where the talk goes, try goto first.',
    props: 'src, alt, w?, h?', example: '<Embed src="widgets/pick-an-edge.html" alt="The room picks an edge" h="640" />',
    html: (a, c) => {
      const page = c.read?.(a.src ?? '');
      if (!a.alt) c.diags.push({ code: 'missing-alt', severity: 'error', slide: c.slide, id: a.id, message: 'Embed has no alt', fix: 'Say what the page does' });
      if (c.read && page == null) {
        c.diags.push({ code: 'bad-embed', severity: 'error', slide: c.slide, id: a.id, message: `Embed "${a.src ?? ''}" not found`, fix: 'src must be an .html file in the deck folder' });
        return `<div${pass(a, 'p-embed')}></div>`;
      }
      const size = `width:${a.w ? `${num(a, 'w')}px` : '100%'};height:${num(a, 'h', 640)}px;`;
      return `<iframe${pass(withStyle(a, size), 'p-embed')} title="${attrText(a.alt ?? '')}" sandbox="allow-scripts" srcdoc="${attrText(embedded(page ?? ''))}"></iframe>`;
    },
  },
  Code: {
    doc: 'A code or terminal panel: monospace, syntax-coloured, one line per .part (ids <id>-1, <id>-2...; each line\'s text is <id>-1-t, class code-text). Write the lines between the tags, or in lines with \\n between them. lang (sql|js|ts|py|sh) colours its keywords, strings and comments; a sh line starting "$ " has a muted prompt. ok and err are prefixes that tint a whole line, for output: ok="✓" err="ERROR". bold lists words to set bold. label is a caps title above the panel. Type it in with `- use: type-code` and `on: <id>`: the built-in type keeps the colours. In a Diagram give x, y, w (h fits the lines unless given).',
    props: 'id, lines?, lang?, size?, lh?, label?, bold?, ok?, err?, pad?; in a Diagram: x, y, w?, h?',
    example: '<Code id="q" x="80" y="120" w="760" lang="sql" label="Query">SELECT name\nFROM users\nWHERE id = 7;</Code>',
    svg: (a, c) => codePanel(a, c, true),
    html: (a, c) => codePanel(a, c, false),
  },
  Swap: {
    doc: 'Panels in one place, one showing at a time: each child is a panel (a <g>, a Card, a Code...), drawn stacked. The swap cue changes which shows: `- swap: <id>` with `to: 2`. The first panel shows at the start. Only one panel counts towards the words on the slide.',
    props: 'id',
    example: '<Swap id="out"><g id="out-1">...</g><g id="out-2">...</g></Swap>',
    svg: a => `<g${pass(a, 'swap')}><slot/></g>`,
    html: a => `<div${pass(a, 'p-swap')}><slot/></div>`,
  },
  ...FIGURES,
};

// ---- Code: highlighting is a small tokenizer, not a parser. Enough to tell keywords, strings and comments apart.
const KEYWORDS: Record<string, string> = {
  sql: 'select from where join inner left right outer full on and or not order by group having limit offset insert into values delete update set create table index view drop alter add as in exists null is between like distinct union all except intersect with case when then else end primary key foreign references explain analyze begin commit rollback count sum avg min max asc desc returning',
  js: 'const let var function return if else for while do switch case break continue class new import export from default await async yield try catch finally throw typeof instanceof in of this null undefined true false',
  py: 'def return if elif else for while class import from as with in not and or is none true false lambda yield async await pass break continue try except finally raise global nonlocal assert del print self',
  sh: 'sudo cd ls cat echo export grep curl git npm npx node python pip make docker cargo psql',
};
KEYWORDS.ts = `${KEYWORDS.js} type interface extends implements enum readonly private public protected as keyof`;
const COMMENT: Record<string, RegExp> = { sql: /--.*$/, js: /\/\/.*$/, ts: /\/\/.*$/, py: /#.*$/, sh: /(^|\s)#.*$/ };

function codePanel(a: A, c: MacroCtx, svg: boolean) {
  const raw = a.lines != null ? unescape(a.lines).split('\\n') : unescape(c.text ?? '').replace(/^\s*\n/, '').replace(/\s+$/, '').split('\n');
  const indent = Math.min(...raw.filter(l => l.trim()).map(l => /^\s*/.exec(l)![0].length), 99);
  const lines = raw.map(l => l.slice(indent === 99 ? 0 : indent));
  const lang = (a.lang ?? '').toLowerCase(), kw = new Set((KEYWORDS[lang] ?? '').split(' ').filter(Boolean));
  const bold = new Set((a.bold ?? '').split(',').map(s => s.trim()).filter(Boolean));
  const id = a.id ?? `${c.slide}-code`, size = num(a, 'size', 22), lh = num(a, 'lh', Math.round(size * 1.5)), pad = num(a, 'pad', 26);
  if (!a.id) c.diags.push({ code: 'code-unnamed', severity: 'warning', slide: c.slide, message: 'Code has no id', fix: 'Give it an id, so its lines can be typed in: <id>-1-t, <id>-2-t...' });
  const span = (cls: string, t: string) => (svg ? `<tspan style="${cls}">${esc(t)}</tspan>` : `<span style="${cls}">${esc(t)}</span>`);
  const colour = (line: string) => {
    if (a.err && line.trimStart().startsWith(unescape(a.err))) return { tint: 'var(--danger)', body: esc(line) };
    if (a.ok && line.trimStart().startsWith(unescape(a.ok))) return { tint: 'var(--ok)', body: esc(line) };
    let rest = line, tail = '', head = '';
    if (lang === 'sh' && rest.startsWith('$ ')) { head = span('fill:var(--muted);color:var(--muted)', '$ '); rest = rest.slice(2); }
    const cm = COMMENT[lang]?.exec(rest);
    if (cm) { tail = span('fill:var(--muted);color:var(--muted);font-style:italic', cm[0]); rest = rest.slice(0, cm.index); }
    const body = rest.split(/('(?:[^'\\]|\\.)*'?|"(?:[^"\\]|\\.)*"?|`[^`]*`?|\w+)/).map(t => {
      if (!t) return '';
      if (/^['"`]/.test(t)) return span('fill:var(--data-3);color:var(--data-3)', t);
      if (kw.has(lang === 'sql' || lang === 'py' ? t.toLowerCase() : t)) return span(`fill:var(--accent);color:var(--accent)${bold.has(t) ? ';font-weight:700' : ''}`, t);
      if (bold.has(t)) return span('font-weight:700', t);
      return esc(t);
    }).join('');
    return { tint: '', body: head + body + tail };
  };
  if (!svg) {
    const rows = lines.map((l, i) => { const { tint, body } = colour(l); return `<span class="part p-code-line" id="${id}-${i + 1}"><span class="body code-text" id="${id}-${i + 1}-t"${tint ? ` style="color:${tint}"` : ''}>${body || ' '}</span></span>`; }).join('');
    return `<div${pass(withStyle(a, `font-size:${size}px;--lh:${lh}px;`), 'p-code')}>${a.label ? `<div class="p-code-label">${esc(unescape(a.label))}</div>` : ''}<pre class="p-code-body code-panel">${rows}</pre></div>`;
  }
  const x = num(a, 'x'), y = num(a, 'y'), w = num(a, 'w', 800), top = a.label ? 34 : 0;
  const h = a.h != null ? num(a, 'h') : top + pad * 2 + (lines.length - 1) * lh + size;
  const rows = lines.map((l, i) => {
    const { tint, body } = colour(l), ty = round2(y + top + pad + size * .8 + i * lh);
    return `<g class="part" id="${id}-${i + 1}"><text class="body code-text" id="${id}-${i + 1}-t" x="${x + pad}" y="${ty}" style="font-family:var(--font-mono);font-size:${size}px;white-space:pre;fill:${tint || 'var(--ink)'}">${body}</text></g>`;
  }).join('');
  const label = a.label ? `<text class="m lbl" x="${x}" y="${y + 20}">${esc(unescape(a.label))}</text>` : '';
  return `<g${pass({ ...a, id }, 'code')}>${label}<rect class="code-panel" x="${x}" y="${y + top}" width="${w}" height="${h - top}" rx="12"/>${rows}</g>`;
}

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
  for (const ch0 of n.children ?? []) {
    if (ch0.type === 'comment') continue;
    // define= on anything but a formula is for the formulas inside it.
    const define = ch0.type === 'tag' && ch0.name !== 'Math' ? ch0.attribs?.define : undefined;
    if (define == null) { expandOne(ch0, c); continue; }
    const group: TermGroup = { defs: definitions(unescape(define)), used: new Set(), id: ch0.attribs?.id };
    if (!isMacro(ch0)) delete ch0.attribs!.define;
    expandOne(ch0, { ...c, terms: [...(c.terms ?? []), group] });
    for (const { sym, def } of group.defs) {
      const bad = (message: string, fix: string) => c.diags.push({ code: 'bad-define', severity: 'error', slide: c.slide, id: group.id, message, fix });
      if (!sym || !def) bad(`define "${sym}" has no meaning`, 'Write define="H: what H means; b: what b means"');
      else if (!group.used.has(sym)) bad(`define names "${sym}", which is in no formula inside`, 'Name a symbol exactly as the LaTeX of a <Math> inside writes it, like x_i or \\theta');
    }
  }
  n.children = kids;
  return n;

  function expandOne(ch: XNode, c: MacroCtx) {
    if (!isMacro(ch)) { kids.push(expand(ch, { ...c, diagram: inDiagram }, project)); return; }
    const def = project[ch.name!] ?? MACROS[ch.name!];
    const childCtx = { ...c, diagram: inDiagram, text: textOf(ch) };
    const f = def && (inDiagram ? def.svg ?? (ch.name === 'Icon' ? def.html : undefined) : def.html ?? undefined);
    if (!def || !f) {
      const known = !!def;
      c.diags.push({
        code: known ? 'macro-context' : 'unknown-macro', severity: 'error', slide: c.slide, id: ch.attribs?.id,
        message: known ? `<${ch.name}> cannot be used ${inDiagram ? 'inside' : 'outside'} a Diagram` : `Unknown macro <${ch.name}>`,
        fix: known ? 'Move it, or use its counterpart' : `Known macros: ${Object.keys(MACROS).join(', ')}`,
      });
      return;
    }
    const known = new Set([...def.props.matchAll(/[A-Za-z][A-Za-z0-9]*/g)].map(m => m[0]).concat(['id', 'class', 'style', 'spot', 'goto', 'act', 'define', 'data-src', 'data-n']));
    for (const k of Object.keys(ch.attribs ?? {})) {
      if (!known.has(k) && !k.startsWith('data-') && !k.startsWith('aria-')) c.diags.push({ code: 'unknown-prop', severity: 'warning', slide: c.slide, id: ch.attribs?.id, message: `<${ch.name}> ignores ${k}`, fix: `Props: ${def.props || 'none'}` });
    }
    const nextDiagram = ch.name !== 'TextBlock' && (inDiagram || ch.name === 'Diagram');   // a TextBlock holds HTML
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
}

function fillSlot(n: XNode, kids: XNode[]) {
  const list = n.children ?? [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].type === 'tag' && list[i].name === 'slot') { list.splice(i, 1, ...kids); return; }
    fillSlot(list[i], kids);
  }
}

export const toHtml = (root: XNode) => (root.children ?? []).map(serialize).join('');
