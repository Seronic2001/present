// Rendered checks. Runs in the page on a settled slide and reports what a person would notice.
export interface Issue { code: string; severity: 'error' | 'warning'; id?: string; message: string; fix: string; }
export interface Box { id: string; x: number; y: number; w: number; h: number; }

const SAFE = 24, MIN_PX = 12, EDGE = 6, EDGE_Y = 4;
const nameOf = (el: Element): string | undefined => el.closest('[id]')?.id || undefined;
const rgba = (s: string): [number, number, number, number] | null => {
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const v = m[1].split(/[,\s/]+/).filter(Boolean).map(parseFloat);
  return [v[0], v[1], v[2], v[3] ?? 1];
};
const lum = ([r, g, b]: number[]) => {
  const f = (c: number) => { c /= 255; return c <= .03928 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4); };
  return .2126 * f(r) + .7152 * f(g) + .0722 * f(b);
};
const over = (top: number[], a: number, under: number[]) => top.map((c, i) => c * a + under[i] * (1 - a));

function backgroundAt(el: Element, x: number, y: number): number[] {
  let bg = [255, 255, 255];
  const stack = document.elementsFromPoint(x, y).filter(e => e !== el && !el.contains(e)).reverse();
  for (const e of stack) {
    const cs = getComputedStyle(e);
    const isShape = e instanceof SVGElement && ['rect', 'circle', 'path', 'ellipse'].includes(e.tagName);
    const c = rgba(isShape ? cs.fill : cs.backgroundColor);
    if (!c) continue;
    let alpha = c[3] * (isShape ? parseFloat(cs.fillOpacity) : 1);
    for (let n: Element | null = e; n && !n.classList.contains('p-slide'); n = n.parentElement) alpha *= parseFloat(getComputedStyle(n).opacity);
    if (e.closest('defs,symbol,.fx,.p-spritesheet')) continue;
    if (alpha > 0) bg = over(c.slice(0, 3), alpha, bg);
  }
  return bg;
}

export function audit(root: HTMLElement, stageScale: number): { issues: Issue[]; boxes: Box[] } {
  const issues: Issue[] = [];
  const add = (i: Issue) => { if (!issues.some(o => o.code === i.code && o.id === i.id && o.message === i.message)) issues.push(i); };
  const stage = root.closest('.p-stage')!.getBoundingClientRect();
  const toStage = (r: DOMRect) => ({
    x: (r.left - stage.left) / stageScale, y: (r.top - stage.top) / stageScale,
    w: r.width / stageScale, h: r.height / stageScale,
  });
  const faint = getComputedStyle(document.documentElement).getPropertyValue('--faint').trim();

  // What text sits on: any card or box, whether the text is inside it in the markup or only drawn over it.
  const plates = [...root.querySelectorAll('[data-box] > rect, rect.card')].filter(e => !e.closest('[data-leaves]')).map(e => ({ e, r: toStage(e.getBoundingClientRect()) }));
  const plateFor = (r: ReturnType<typeof toStage>) => {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    return plates.filter(p => cx > p.r.x && cx < p.r.x + p.r.w && cy > p.r.y && cy < p.r.y + p.r.h).sort((p, q) => p.r.w * p.r.h - q.r.w * q.r.h)[0];
  };
  // A block's own box is as wide as its column, so measure the words in it.
  const inked = (el: Element) => {
    if (el instanceof SVGElement) return toStage(el.getBoundingClientRect());
    const range = document.createRange();
    range.selectNodeContents(el);
    return toStage(range.getBoundingClientRect());
  };
  const texts: { el: Element; r: ReturnType<typeof toStage>; text: string; plate?: Element; ink: ReturnType<typeof toStage>; size: string }[] = [];
  const candidates = [...root.querySelectorAll('text, h1, h2, h3, p, span, li, div, em, code, td, th')].filter(el => {
    if (el.closest('.fx') || el.closest('defs') || el.closest('[data-leaves]')) return false;
    const math = el.closest('.katex');                 // a formula is one thing, not its stacked glyphs
    if (math) return el === math;
    if (el instanceof SVGElement) return el.tagName === 'text';
    return [...el.childNodes].some(n => n.nodeType === 3 && n.textContent!.trim());
  });
  for (const el of candidates) {
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
    if (!text) continue;
    const r = toStage(el.getBoundingClientRect());
    if (r.w <= 0 || r.h <= 0) {
      add({ code: 'never-visible', severity: 'error', id: nameOf(el), message: `"${text.slice(0, 40)}" has no size at rest`, fix: 'Check display and clipping' });
      continue;
    }
    const cs = getComputedStyle(el);
    if (cs.opacity === '0' || cs.visibility === 'hidden') {
      add({ code: 'never-visible', severity: 'error', id: nameOf(el), message: `"${text.slice(0, 40)}" is hidden at rest`, fix: 'The drawing must show the finished state' });
    }
    const ink = inked(el), plate = plateFor(ink);
    texts.push({ el, r, text, plate: plate?.e, ink, size: cs.fontSize });
    if (plate && (ink.x < plate.r.x + EDGE || ink.x + ink.w > plate.r.x + plate.r.w - EDGE)) {
      add({ code: 'text-tight', severity: 'warning', id: nameOf(el), message: `"${text.slice(0, 40)}" is ${Math.max(0, Math.round(Math.min(ink.x - plate.r.x, plate.r.x + plate.r.w - ink.x - ink.w)))}px from the edge of its box`, fix: 'Shorten it, reduce its size, or widen the box' });
    } else if (plate) {
      // Line boxes are taller than the letters, so measure the letters.
      const top = ink.y + ink.h * .2, bottom = ink.y + ink.h * .85;
      if (top < plate.r.y + EDGE_Y || bottom > plate.r.y + plate.r.h - EDGE_Y) add({ code: 'text-tight', severity: 'warning', id: nameOf(el), message: `"${text.slice(0, 40)}" sits against the top or bottom of its box`, fix: 'Move it inward, or make the box taller' });
    }

    let px = parseFloat(cs.fontSize);
    const svg = (el as SVGElement).ownerSVGElement;
    if (svg) { const m = (el as any).getScreenCTM(); px *= Math.hypot(m.a, m.b) / stageScale; }
    if (px < MIN_PX) add({ code: 'text-too-small', severity: 'warning', id: nameOf(el), message: `"${text.slice(0, 40)}" is ${px.toFixed(1)}px on a 1920 stage`, fix: `Use at least ${MIN_PX}px` });

    if (r.x < SAFE || r.y < SAFE || r.x + r.w > 1920 - SAFE || r.y + r.h > 1080 - SAFE) {
      add({ code: 'outside-safe-area', severity: 'error', id: nameOf(el), message: `"${text.slice(0, 40)}" leaves the safe area`, fix: 'Move it inward, or shorten the content above it' });
    }
    const box = el.closest('[data-box]');
    if (box && el !== box) {
      const shape = box.querySelector(':scope > rect') ?? box;
      const b = toStage(shape.getBoundingClientRect());
      if (r.x < b.x - 1 || r.y < b.y - 1 || r.x + r.w > b.x + b.w + 1 || r.y + r.h > b.y + b.h + 1) {
        add({ code: 'text-overflow', severity: 'error', id: nameOf(box), message: `"${text.slice(0, 40)}" overflows its box`, fix: 'Shorten the text, wrap it, or widen the box' });
      }
    }
    const fill = rgba(svg ? cs.fill : cs.color);
    if (fill) {
      const cx = stage.left + (r.x + r.w / 2) * stageScale, cy = stage.top + (r.y + r.h / 2) * stageScale;
      const bg = backgroundAt(el, cx, cy);
      const fg = over(fill.slice(0, 3), fill[3], bg);
      const [a, b] = [lum(fg), lum(bg)].sort((p, q) => q - p);
      const ratio = (a + .05) / (b + .05), large = px >= 24;
      if (ratio < (large ? 3 : 4.5)) {
        add({ code: 'low-contrast', severity: 'warning', id: nameOf(el), message: `"${text.slice(0, 40)}" contrast ${ratio.toFixed(2)}:1`, fix: 'Use a darker token such as ink or muted' });
      }
    }
    if (faint && (cs.fill === hexToRgb(faint) && svg || cs.color === hexToRgb(faint) && !svg)) {
      add({ code: 'faint-text', severity: 'warning', id: nameOf(el), message: `"${text.slice(0, 40)}" uses the faint token`, fix: 'Faint is for icons and rules; use muted' });
    }
    if (cs.textTransform === 'uppercase' && text.split(' ').length > 8) {
      add({ code: 'caps-sentence', severity: 'warning', id: nameOf(el), message: `Caps label carries a sentence: "${text.slice(0, 40)}"`, fix: 'Caps labels are for a few words' });
    }
  }
  // HTML containers clipping or spilling their content
  for (const el of root.querySelectorAll<HTMLElement>('.p-card, .p-stack, .p-columns, .p-grid, .p-row, .p-textblock[data-fit]')) {
    if (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2) {
      add({ code: 'text-overflow', severity: 'error', id: nameOf(el), message: 'Content is larger than its container', fix: 'Cut content, or give the container more room' });
    }
  }
  // Text colliding with text, not nested in each other
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i], b = texts[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const w = Math.min(a.r.x + a.r.w, b.r.x + b.r.w) - Math.max(a.r.x, b.r.x);
      const h = Math.min(a.r.y + a.r.h, b.r.y + b.r.h) - Math.max(a.r.y, b.r.y);
      if (w > 2 && h > 2 && w * h > .25 * Math.min(a.r.w * a.r.h, b.r.w * b.r.h)) {
        add({ code: 'text-overlap', severity: 'error', id: nameOf(a.el), message: `"${a.text.slice(0, 30)}" overlaps "${b.text.slice(0, 30)}"`, fix: 'Move one of them' });
      } else if (a.plate && a.plate === b.plate && a.size !== b.size && w > 2 && h > 0) {
        // Too little to call an overlap, but on one card a label and its text should not share a line box.
        add({ code: 'text-crowded', severity: 'warning', id: nameOf(a.el), message: `"${a.text.slice(0, 30)}" crowds "${b.text.slice(0, 30)}"`, fix: 'Move one of them, or make the box taller' });
      }
    }
  }
  const boxes: Box[] = [...root.querySelectorAll('[id]')]
    .filter(e => !e.closest('defs'))
    .map(e => ({ id: e.id, ...toStage(e.getBoundingClientRect()) }))
    .map(b => ({ ...b, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) }));
  return { issues, boxes };
}

function hexToRgb(h: string) {
  const n = parseInt(h.slice(1, 7), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
