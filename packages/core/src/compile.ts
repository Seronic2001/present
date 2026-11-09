// source text → compiled slide + diagnostics. Pure: reads nothing from disk.
import type { CompiledSlide } from './compiled.ts';
import type { Diagnostic } from './diagnostics.ts';
import { collectBoxes, expand, MACROS, toHtml } from './macros.ts';
import { classes, parseSlide, textOf, walk, type XNode } from './parse.ts';
import { PATTERNS } from './patterns.ts';
import { PHRASES, type Phrase } from './phrases.ts';
import { compileScore } from './score.ts';

const HTML_TAGS = 'div span p h1 h2 h3 h4 em strong b i u s small br hr ul ol li a img table thead tbody tr td th code pre blockquote figure figcaption sub sup kbd mark'.split(' ');
const SVG_TAGS = 'svg g defs symbol use path rect circle ellipse line polyline polygon text tspan marker linearGradient radialGradient stop filter feDropShadow feGaussianBlur feOffset feMerge feMergeNode clipPath mask pattern title desc image foreignObject'.split(' ');
const ALLOWED = new Set([...HTML_TAGS, ...SVG_TAGS, 'slot', 'iframe']);
const HEX = /#[0-9a-fA-F]{3,8}\b/;
// The theme styles SVG text and its own shapes, and a stylesheet beats a presentation attribute. So what the
// author wrote moves to inline style, where it wins.
const TEXT_ATTRS = ['fill', 'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing'];
const SHAPE_ATTRS = ['fill', 'stroke', 'stroke-width'];
const THEMED_SHAPE = /(^|\s)(card|cardq|conn|conn-a|conn-d)(\s|$)/;
const PX = new Set(['font-size', 'letter-spacing', 'stroke-width']);

function promoteStyle(e: XNode, a: Record<string, string>) {
  const list = e.name === 'text' || e.name === 'tspan' ? TEXT_ATTRS : THEMED_SHAPE.test(a.class ?? '') ? SHAPE_ATTRS : [];
  const css = list.filter(k => a[k] != null).map(k => {
    const v = a[k];
    delete a[k];
    return `${k}:${PX.has(k) && /^-?[\d.]+$/.test(v) ? `${v}px` : v};`;
  }).join('');
  if (css) a.style = css + (a.style ?? '');
}
const holdsText = (n: XNode): boolean => n.name === 'text' || (n.children ?? []).some(holdsText);

export interface CompileOpts { sourceMap?: boolean; id: string; images?: (src: string) => string | null; read?: (path: string) => string | null; align?: string; stepLimit?: number; macros?: Record<string, any>; phrases?: Record<string, Phrase>; }

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
    } else if (classes(ch).includes('p-math')) {        // a formula rises as one word
      (ch.attribs ??= {}).class += ' w';
      out.push(ch);
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

  // Formulas made by hand, in a deck written before <Math> or by a script that does not know of it.
  let fragments = 0;
  walk(p.root, e => {
    const a = e.attribs ?? {};
    if (e.name === 'tspan' && a.x == null && (a.dy != null || a['baseline-shift'] != null || /baseline-shift/.test(a.style ?? ''))) fragments++;   // with x, it is a line break
  });
  const subscripts = (p.body.match(/[A-Za-z][₀-₉ₐ-ₜ]/g) ?? []).length;
  if (fragments + subscripts) add('hand-built-math', 'warning', `${[fragments && `${fragments} shifted tspans`, subscripts && `${subscripts} Unicode subscripts`].filter(Boolean).join(' and ')} look like a formula built by hand`, 'Use <Math>. A line mixing words and maths becomes a TextBlock');

  const ids = new Set<string>();
  walk(p.root, e => {
    const id = e.attribs?.id;
    if (id) { if (ids.has(id)) add('duplicate-id', 'error', `Duplicate id "${id}"`, 'Ids must be unique in a slide', id); ids.add(id); }
    if (e.name === 'Diagram' && !e.attribs?.alt) add('missing-alt', 'error', 'Diagram has no alt', 'Describe what the diagram shows', id);
  });

  if (o.sourceMap) { let i = 0; walk(p.root, e => { (e.attribs ??= {})['data-src'] = String(i++); }); }
  const root = expand(p.root, { diagram: false, boxes: collectBoxes(p.root), slide, diags, read: o.read }, o.macros);
  relink(root);

  walk(root, e => {
    const a = (e.attribs ??= {});
    // A frame is only ever a sandboxed page held in the slide: it cannot load anything or reach the deck.
    if (!ALLOWED.has(e.name!) || (e.name === 'iframe' && (a.sandbox !== 'allow-scripts' || a.src != null))) {
      add('disallowed-tag', 'error', `<${e.name}> is not allowed in a slide`, 'Slides are data: use HTML/SVG from the allowlist, and tracks/ for code', a.id);
      e.type = 'comment';
      e.children = [];
      return;
    }
    for (const k of Object.keys(a)) {
      if (/^on/i.test(k)) { add('disallowed-attr', 'error', `${k} is not allowed`, 'Slides cannot contain event handlers', a.id); delete a[k]; }
      else if (['href', 'xlink:href'].includes(k) && e.name !== 'image' && !/^(#|https?:)/.test(a[k])) { add('disallowed-link', 'error', `Link "${a[k]}" is not allowed`, 'Use http(s) or #fragment', a.id); delete a[k]; }
      else if (['fill', 'stroke', 'style', 'stop-color', 'flood-color'].includes(k) && HEX.test(a[k]) && !/#fff\b/i.test(a[k])) {
        add('raw-colour', 'warning', `Raw colour in ${k}: ${a[k].slice(0, 40)}`, 'Use a token: var(--data-1) to var(--data-6) when the colour is content, like series or categories, or var(--danger) and the other tones when it means something', a.id);
      }
    }
    promoteStyle(e, a);
    if (e.name === 'g' && (e.children ?? []).some(holdsText)) {
      const lost = Object.keys(a).filter(k => k === 'fill' || k.startsWith('font-'));
      if (lost.length) add('style-ignored', 'warning', `${lost.join(', ')} on <g> does not reach the <text> inside it`, 'The theme styles text directly. Put it on each <text>, where it is applied', a.id);
    }
    if (a.goto) { a['data-goto'] = a.goto; delete a.goto; }
    if (a.act) { a['data-act'] = a.act; delete a.act; }
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

  // Definitions are for the few things a room cannot work out. A slide full of them is a glossary, not a slide.
  const terms = new Map<string, number>();
  walk(root, e => {
    const def = e.attribs?.['data-def'];
    if (def == null) return;
    const name = e.attribs?.['data-term'] ?? textOf(e).trim();
    terms.set(name, (terms.get(name) ?? 0) + 1);
    if (def.length > 160) add('term-long', 'warning', `The meaning of "${name}" is ${def.length} characters`, 'Keep it to one short sentence. A longer idea belongs on the slide');
  });
  const twice = [...terms].filter(([, n]) => n > 1).map(([k]) => k);
  if (twice.length) add('term-repeated', 'warning', `${twice.map(k => `"${k}"`).join(', ')} defined more than once`, 'Define a thing once, where it is first used');
  if (terms.size > 3) add('too-many-terms', 'warning', `Slide defines ${terms.size} terms`, 'Keep the 3 the audience most needs. Underline everywhere reads as noise');

  const { phases, spots, actions } = compileScore({ root, score: p.front.score, slide, diags, stepLimit: o.stepLimit ?? 10000, phrases: { ...o.phrases, ...p.front.score?.phrases } });
  const restRaw = p.front.score?.rest;
  const clicked = new Set<string>();
  walk(root, e => { const k = e.attribs?.['data-act']; if (k) clicked.add(k); });
  for (const k of clicked) if (!actions.some(x => x.id === k)) add('unknown-action', 'error', `act="${k}" has no action`, 'Define it under score.actions in the frontmatter');
  for (const x of actions) if (!clicked.has(x.id)) add('unused-action', 'warning', `Nothing has act="${x.id}"`, 'Add act to the part that should be clicked, or remove the action');
  const align = p.front.align ?? o.align;
  if (align != null && align !== 'top' && align !== 'center') add('bad-align', 'warning', `align is "${align}"`, 'Use top or center');
  const compiled: CompiledSlide = {
    id: slide, title: String(p.front.title ?? ''), brief: String(p.front.brief ?? ''), notes: String(p.front.notes ?? ''),
    html: toHtml(root), phases, spots, rest: restRaw === 'always' ? 'always' : Number(restRaw ?? 6000),
    ...(align === 'top' ? { align: 'top' as const } : {}),
    ...(actions.length ? { actions } : {}),
  };
  return { slide: compiled, diagnostics: diags };
}

export function catalog(cues: Record<string, { d: number; e: string; doc: string }>, phrases: Record<string, Phrase> = {}, library: any[] = []) {
  return {
    writingMacros: `A macro is a file, macros/<Name>.ts in the deck, and the file name is the tag: macros/Triangle.ts gives <Triangle>. It default-exports { doc, props, example, svg?, html? }. Give svg to use it in a Diagram, html to use it outside one, or both. Each is (a, c) => markup: a holds the attributes as strings, and c has slide, diagram and diags. Put a <slot/> where the tag's children go. id, class and style are not applied for you: write them into the markup. List every attribute in props, or it is reported as ignored. Type annotations work; enums do not, and it needs no imports. It takes effect on the next tool call and goes to the library by itself. Macros are code, and run on this machine.\n\n// macros/Triangle.ts\nexport default {\n  doc: 'Three joined nodes.', props: 'id, x, y, r?',\n  example: '<Triangle id="t" x="200" y="200" />',\n  svg: a => {\n    const x = +a.x, y = +a.y, r = +(a.r ?? 60);\n    return \`<g id="\${a.id}" class="part"><path class="seg conn" d="M \${x} \${y - r} L \${x + r} \${y + r} L \${x - r} \${y + r} Z"/><slot/></g>\`;\n  },\n};`,
    interaction: 'act="name" on a Box, Card, Chip, Text or raw element makes it a click target that plays the cues under score.actions.name, in any order and at any step: score:\n  actions:\n    show-a:\n      cues:\n        - fade: a\n    pick-b:\n      group: choice\n      toggle: true\n      cues:\n        - tint: v\n          from: data-2\nA click plays an action once. toggle lets a second click reverse it, and group makes actions pick-one, resetting the others. Everything starts unplayed in a show, while checks, PDFs and exports see the finished drawing with actions played, except the later choices of a group. An action needs parts of its own, not ones the steps move. slide_render takes actions to see any state, and slide_filmstrip takes action to judge one. goto="slide-id" makes a part a click target that jumps there. Point the choices at deep dives and the room can pick a branch: Next at the end of a deep dive returns to the slide they chose from. For anything more, like a poll, use Embed.',
    layout: 'Slides are centred vertically, so a header moves with the height of what is under it. Set align: top in deck.yaml to pin every header, and align: center in the frontmatter of a slide that should stay centred, such as a title.',
    deepDives: 'A deck is a tree. The main path is the talk; a slide can have deep dives under it, for when the room wants more. The presenter opens one with Down, and Next at its end returns to the parent. Put the argument on the main path and the detail underneath: addSlide with under, or moveSlide with under. Timing counts the main path only.',
    library: library.map(i => ({ name: i.name, doc: i.doc, useWhen: i.useWhen, slide: i.slide, uses: [...i.macros, ...i.tracks, ...i.phrases], code: i.code, from: i.from })),
    howToCompose: 'Look in library first: it holds components saved from earlier projects, and library_add copies one into this deck. Otherwise start from a pattern (addSlide with pattern, or pattern_read to adapt one). Draw with macros; every figure (Milestones, Plot, Timing, Hub, Terrain, Neck) has the same anatomy: .part holding .seg, .node and .body, also reachable as <id>-1, <id>-2. Move things with phrases before single cues: `- use: arrive` with `on: .part`. In steps, `- over: .part` and `use: arrive` makes one step per match. When a beat repeats, name it under phrases: in deck.yaml. When a drawing repeats, add it to macros/. Anything worth keeping goes to the library with library_save, without asking: see the guide.',
    patterns: Object.entries(PATTERNS).map(([name, p]) => ({ name, doc: p.doc, useWhen: p.useWhen })),
    phrases: Object.entries({ ...PHRASES, ...phrases }).map(([name, p]) => ({ name, doc: p.doc, params: p.params ?? '', example: `- use: ${name}${p.params ? p.params.split(', ').map(k => `\n  ${k}: an-id`).join('') : '\n  on: .part'}` })),
    macros: Object.entries(MACROS).map(([name, m]) => ({ name, doc: m.doc, props: m.props, example: m.example, where: [m.html && 'html', m.svg && 'diagram'].filter(Boolean) })),
    cues: Object.entries(cues).filter(([k]) => k !== 'word').map(([name, c]) => ({ name, doc: c.doc, defaultDur: c.d, defaultEase: c.e })),
    cueOptions: 'Every cue takes at (ms), dur, stagger, ease (lin|out|inOut|back|sine). A step or cue group takes each: selector, then cues use $ for the item and "$ .x" for parts inside it. Selectors are an id, .class, or a list. optional: true lets a target be absent, which is what makes a phrase fit many drawings.',
    tokens: ['ink', 'muted', 'faint', 'rule', 'canvas', 'accent', 'accent-deep', 'tint', 'ok', 'ok-muted', 'warn', 'warn-muted', 'danger', 'danger-muted', 'struck', 'data-1', 'data-2', 'data-3', 'data-4', 'data-5', 'data-6'],
    spot: 'Add spot="" to any part with an id, or to a Box or Card, and the presenter can zoom into it. Motion that plays when zoomed goes under score.spots.<id>.cues.',
    hot: 'hot works on any Box, Card or Chip, by id or class.',
    tones: 'One accent, for the thing the deck argues for. ok = verified, warn = partial, danger = broken, grey = ambient. Never decoration.',
    dataColours: 'When colour is content, like three vertex colours, chart series or teams, use data-1 to data-6: var(--data-1), or tone="data-1" on a Box. They carry no meaning of their own and raise no raw colour warning. Set your own in theme.yaml, e.g. data-1: "#b5179e".',
    icons: 'Octicons by name, e.g. lock, shield, stopwatch, graph, check-circle, x-circle, cpu, database, tools, people, flame, zap, rocket.',
    slideFormat: `---\ntitle: ...\nbrief: what the slide argues and how it builds\nnotes: speaker notes\nscore:\n  intro:\n    - rise: left\n  steps:\n    - name: first beat\n      cues:\n        - draw: link\n        - rise: [a, b]\n          stagger: 60\n          at: 200\n      loop:\n        every: 6000\n        cues:\n          - travel: link\n  spots:\n    part-id:\n      cues:\n        - type: label\n---\n<Header>Title with <em>accent</em></Header>\n<Diagram viewBox="0 0 1600 640" alt="...">...</Diagram>`,
  };
}
