// What the tools send back. An agent pays for every character of a reply, on every call, so a reply
// carries what the next step needs and says where the rest is. Core stays complete; Studio and the
// CLI read it whole. Only this layer trims.
import { parseSlide, walk, type Diagnostic, type XNode } from '@present/core';

/** Diagnostics by kind: the fix once, where it occurs, and a few distinct examples. Errors come first.
 *  scope keeps errors from anywhere but warnings only from those slides: an edit to one slide is not
 *  the moment to hear about every other. */
export function digest(list: Diagnostic[], { scope, examples = 3 }: { scope?: string[]; examples?: number } = {}) {
  const errors = list.filter(d => d.severity === 'error').length;
  const shown = scope ? list.filter(d => d.severity === 'error' || (d.slide != null && scope.includes(d.slide))) : list;
  const kinds = new Map<string, { code: string; severity: Diagnostic['severity']; count: number; fix: string; slides: string[]; seen: Map<string, string[]> }>();
  for (const d of shown) {
    const key = `${d.severity}|${d.code}`;
    const k = kinds.get(key) ?? { code: d.code, severity: d.severity, count: 0, fix: d.fix, slides: [] as string[], seen: new Map<string, string[]>() };
    k.count++;
    if (d.slide && !k.slides.includes(d.slide)) k.slides.push(d.slide);
    const at = [d.slide, d.id].filter(Boolean).join('#');
    k.seen.set(d.message, [...(k.seen.get(d.message) ?? []), ...(at ? [at] : [])]);
    kinds.set(key, k);
  }
  const groups = [...kinds.values()]
    .sort((a, b) => Number(a.severity === 'warning') - Number(b.severity === 'warning') || b.count - a.count)
    .map(({ seen, ...k }) => {
      const cap = k.severity === 'error' ? Math.max(examples, 10) : examples;
      const all = [...seen.entries()].map(([m, at]) => {
        const where = [...new Set(at)];
        return `${m}${at.length > 1 ? ` (x${at.length})` : ''}${where.length ? ` at ${where.slice(0, 3).join(' ')}${where.length > 3 ? ` +${where.length - 3}` : ''}` : ''}`;
      });
      return { ...k, examples: all.slice(0, cap), ...(all.length > cap ? { more: all.length - cap } : {}) };
    });
  const hidden = list.length - shown.length;
  return {
    errors, warnings: list.length - errors, groups,
    ...(hidden ? { elsewhere: `${hidden} warnings on other slides: deck_check lists them` } : {}),
    ...(groups.some(g => g.more) ? { detail: 'deck_check with slide or code lists every one' } : {}),
  };
}

// Marks text a reply left out. A source carrying it is a summary, not a slide, and must not be written back.
export const ELIDED = '⟪elided';
const PROSE = new Set(['alt', 'title', 'aria-label', 'label', 'caption', 'text', 'placeholder']);
const GEOMETRY = new Set(['d', 'points', 'values', 'keyPoints', 'path']);
const BULKY = 400;

/** A slide's source with the bulk left out: long geometry (path data, points, data: URIs), and the
 *  insides of <defs> and runs of <symbol>, which are drawn by reference. Everything an id-based op
 *  needs stays: ids, classes, text, layout attributes and the whole frontmatter. */
export function skim(src: string) {
  const { body, root } = parseSlide(src);
  const start = src.length - body.length;
  let saved = 0;
  const hidden = new Set<string>();

  // What to fold, as [from, to) ranges of the body. A folded node's descendants are not visited.
  const folds: { from: number; to: number; what: string }[] = [];
  const visit = (n: XNode) => {
    for (const c of n.children ?? []) {
      if (c.type !== 'tag') continue;
      const from = c.startIndex!, to = c.endIndex! + 1;
      if (c.name === 'symbol') { folds.push({ from, to, what: 'symbol' }); continue; }
      // defs are drawn by reference, and a typeset formula is drawn from its data-tex: keep the tag, fold the inside.
      const inside = c.name === 'defs' ? 'defs' : c.attribs?.['data-tex'] != null ? 'typeset formula' : '';
      if (inside && to - from >= BULKY) {
        const inner = body.indexOf('>', from) + 1, close = body.lastIndexOf('</', to - 1);
        if (inner > 0 && close > inner) { folds.push({ from: inner, to: close, what: inside }); continue; }
      }
      visit(c);
    }
  };
  visit(root);
  // Neighbouring symbols, with only whitespace between them, fold into one note. Small lone ones stay.
  const merged: typeof folds = [];
  for (const f of folds) {
    const last = merged.at(-1);
    if (last && (last.what === 'symbol' || last.what === 'symbols') && f.what === 'symbol' && !body.slice(last.to, f.from).trim()) { last.to = f.to; last.what = 'symbols'; }
    else merged.push({ ...f });
  }
  const note = (chunk: string, what: string) => {
    const ids = [...chunk.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
    ids.forEach(i => hidden.add(i));
    saved += chunk.length;
    return `<!-- ${ELIDED} ${chunk.length} chars of ${what}${ids.length ? `, ids: ${ids.join(' ')}` : ''}⟫ -->`;
  };
  const attrs = (s: string) => s.replace(/(\s([\w:.-]+)=)(?:"([^"]{80,})"|'([^']{80,})')/g, (all, pre: string, name: string, dq?: string, sq?: string) => {
    const v = dq ?? sq!;
    if (!GEOMETRY.has(name) && !v.startsWith('data:') && (v.length < 200 || PROSE.has(name))) return all;
    saved += v.length;
    return `${pre}"${ELIDED} ${v.length} chars⟫"`;
  });

  let out = '', at = 0;
  for (const f of merged) {
    const chunk = body.slice(f.from, f.to);
    if (f.what === 'symbol' && chunk.length < BULKY) continue;     // left as is, and its attributes skimmed below
    out += attrs(body.slice(at, f.from)) + note(chunk, f.what === 'symbols' ? `${chunk.split('<symbol').length - 1} symbols` : f.what);
    at = f.to;
  }
  out += attrs(body.slice(at));
  return { source: src.slice(0, start) + out, saved, hidden };
}

/** One element's markup, verbatim. */
export function element(src: string, id: string) {
  const { body, root } = parseSlide(src);
  let found: XNode | undefined;
  walk(root, e => { if (!found && e.attribs?.id === id) found = e; });
  if (!found) throw new Error(`No element with id "${id}" in this slide`);
  return body.slice(found.startIndex!, found.endIndex! + 1);
}

/** The outline without what is empty, zero, or the same as its title. */
export function slimOutline(o: any) {
  return {
    ...o,
    slides: o.slides?.map((s: any) => Object.fromEntries(Object.entries(s).filter(([k, v]) =>
      !(v === 0 || v === '' || v == null || (Array.isArray(v) && !v.length) || (k === 'brief' && v === s.title))))),
  };
}
