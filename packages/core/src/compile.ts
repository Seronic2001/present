// source text → compiled slide + diagnostics. Pure: reads nothing from disk.
import type { CompiledSlide } from './compiled.ts';
import type { Diagnostic } from './diagnostics.ts';
import { collectBoxes, expand, MACROS, toHtml } from './macros.ts';
import { parseSlide, textOf, walk, type XNode } from './parse.ts';
import { compileScore } from './score.ts';

const HTML_TAGS = 'div span p h1 h2 h3 h4 em strong b i u s small br hr ul ol li a img table thead tbody tr td th code pre blockquote figure figcaption sub sup kbd mark'.split(' ');
const SVG_TAGS = 'svg g defs symbol use path rect circle ellipse line polyline polygon text tspan marker linearGradient radialGradient stop filter feDropShadow feGaussianBlur feOffset feMerge feMergeNode clipPath mask pattern title desc image'.split(' ');
const ALLOWED = new Set([...HTML_TAGS, ...SVG_TAGS, 'slot']);
const HEX = /#[0-9a-fA-F]{3,8}\b/;

export interface CompileOpts { sourceMap?: boolean; id: string; images?: (src: string) => string | null; stepLimit?: number; macros?: Record<string, any>; }

const wrapWords = (n: XNode) => {
  const out: XNode[] = [];
  for (const ch of n.children ?? []) {
    if (ch.type === 'text') {
      for (const p of (ch.data ?? '').split(/(\s+)/)) {
        if (!p) continue;
        if (/^\s+$/.test(p)) out.push({ type: 'text', data: p, parent: n });
        else {
          const span: XNode = { type: 'tag', name: 'span', attribs: { class: 'w' }, children: [], parent: n };
          span.children = [{ type: 'text', data: p, parent: span }];
          out.push(span);
        }
      }
    } else { if (ch.type === 'tag' && ch.name !== 'br') wrapWords(ch); out.push(ch); }
  }
  n.children = out;
};
const relink = (n: XNode) => { for (const c of n.children ?? []) { c.parent = n; relink(c); } };

export function compileSlide(src: string, o: CompileOpts): { slide: CompiledSlide; diagnostics: Diagnostic[] } {
  const diags: Diagnostic[] = [];
  const slide = o.id;
  const p = parseSlide(src);
  const add = (code: string, severity: 'error' | 'warning', message: string, fix: string, id?: string) => diags.push({ code, severity, slide, id, message, fix });

  if (p.frontError) add('bad-frontmatter', 'error', p.frontError.split('\n')[0], 'Fix the YAML frontmatter');
  if (!p.front.title) add('missing-title', 'warning', 'Slide has no title', 'Add title to the frontmatter');
  if (!p.front.brief) add('missing-brief', 'warning', 'Slide has no brief', 'Add brief: what the slide argues and how it builds');

  const ids = new Set<string>();
  walk(p.root, e => {
    const id = e.attribs?.id;
    if (id) { if (ids.has(id)) add('duplicate-id', 'error', `Duplicate id "${id}"`, 'Ids must be unique in a slide', id); ids.add(id); }
    if (e.name === 'Diagram' && !e.attribs?.alt) add('missing-alt', 'error', 'Diagram has no alt', 'Describe what the diagram shows', id);
  });

  if (o.sourceMap) { let i = 0; walk(p.root, e => { (e.attribs ??= {})['data-src'] = String(i++); }); }
  const root = expand(p.root, { diagram: false, boxes: collectBoxes(p.root), slide, diags }, o.macros);
  relink(root);

  walk(root, e => {
    const a = (e.attribs ??= {});
    if (!ALLOWED.has(e.name!)) {
      add('disallowed-tag', 'error', `<${e.name}> is not allowed in a slide`, 'Slides are data: use HTML/SVG from the allowlist, and tracks/ for code', a.id);
      e.type = 'comment';
      e.children = [];
      return;
    }
    for (const k of Object.keys(a)) {
      if (/^on/i.test(k)) { add('disallowed-attr', 'error', `${k} is not allowed`, 'Slides cannot contain event handlers', a.id); delete a[k]; }
      else if (['href', 'xlink:href'].includes(k) && !/^(#|https?:)/.test(a[k])) { add('disallowed-link', 'error', `Link "${a[k]}" is not allowed`, 'Use http(s) or #fragment', a.id); delete a[k]; }
      else if (['fill', 'stroke', 'style', 'stop-color', 'flood-color'].includes(k) && HEX.test(a[k]) && !/#fff\b/i.test(a[k])) {
        add('raw-colour', 'warning', `Raw colour in ${k}: ${a[k].slice(0, 40)}`, 'Use a token, e.g. var(--danger) or class tone', a.id);
      }
    }
    if (a.spot != null) { a['data-spot'] = ''; delete a.spot; }
    if (a['data-spot'] != null && !a.id) add('spot-unnamed', 'error', 'A spot part needs an id', 'Add an id');
    if (a['data-words'] != null) { wrapWords(e); delete a['data-words']; }
    if ((e.name === 'img' || e.name === 'image') && (a.src ?? a.href)) {
      const key = e.name === 'img' ? 'src' : 'href', v = a[key];
      const data = o.images?.(v);
      if (data) a[key] = data;
      else { add('bad-image', 'error', `Image "${v}" not found`, 'Images must be local files in the deck folder', a.id); delete a[key]; }
    }
  });
  relink(root);

  const words = textOf(root).trim().split(/\s+/).filter(Boolean).length;
  if (words > 160) add('too-many-words', 'warning', `Slide has ${words} words`, 'Cut text or split the slide');

  const { phases, spots } = compileScore({ root, score: p.front.score, slide, diags, stepLimit: o.stepLimit ?? 10000 });
  const restRaw = p.front.score?.rest;
  const compiled: CompiledSlide = {
    id: slide, title: String(p.front.title ?? ''), brief: String(p.front.brief ?? ''), notes: String(p.front.notes ?? ''),
    html: toHtml(root), phases, spots, rest: restRaw === 'always' ? 'always' : Number(restRaw ?? 6000),
  };
  return { slide: compiled, diagnostics: diags };
}

export function catalog(cues: Record<string, { d: number; e: string; doc: string }>) {
  return {
    macros: Object.entries(MACROS).map(([name, m]) => ({ name, doc: m.doc, props: m.props, example: m.example, where: [m.html && 'html', m.svg && 'diagram'].filter(Boolean) })),
    cues: Object.entries(cues).filter(([k]) => k !== 'word').map(([name, c]) => ({ name, doc: c.doc, defaultDur: c.d, defaultEase: c.e })),
    cueOptions: 'Every cue takes at (ms), dur, stagger, ease (lin|out|inOut|back|sine). A step or cue group takes each: selector, then cues use $ for the item and "$ .x" for parts inside it. Selectors are an id, .class, or a list.',
    tokens: ['ink', 'muted', 'faint', 'rule', 'canvas', 'accent', 'accent-deep', 'tint', 'ok', 'ok-muted', 'warn', 'warn-muted', 'danger', 'danger-muted', 'struck'],
    spot: 'Add spot="" to any part with an id, or to a Box or Card, and the presenter can zoom into it. Motion that plays when zoomed goes under score.spots.<id>.cues.',
    hot: 'hot works on any Box, Card or Chip, by id or class.',
    tones: 'One accent, for the thing the deck argues for. ok = verified, warn = partial, danger = broken, grey = ambient. Never decoration.',
    icons: 'Octicons by name, e.g. lock, shield, stopwatch, graph, check-circle, x-circle, cpu, database, tools, people, flame, zap, rocket.',
    slideFormat: `---\ntitle: ...\nbrief: what the slide argues and how it builds\nnotes: speaker notes\nscore:\n  intro:\n    - rise: left\n  steps:\n    - name: first beat\n      cues:\n        - draw: link\n        - rise: [a, b]\n          stagger: 60\n          at: 200\n      loop:\n        every: 6000\n        cues:\n          - travel: link\n  spots:\n    part-id:\n      cues:\n        - type: label\n---\n<Header>Title with <em>accent</em></Header>\n<Diagram viewBox="0 0 1600 640" alt="...">...</Diagram>`,
  };
}
