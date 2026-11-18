// The MCP replies are an agent's running cost: they must stay small on big decks without losing
// what the next edit needs.
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSlide, walk, type Diagnostic } from '@present/core';
import { digest, element, ELIDED, skim, slimOutline } from '../packages/mcp/src/compact.ts';
import { tempDeck } from './helpers.ts';

const d = (slide: string, code: string, message: string, severity: Diagnostic['severity'] = 'warning', id?: string): Diagnostic =>
  ({ slide, code, message, severity, fix: `fix ${code}`, ...(id ? { id } : {}) });

describe('diagnostics digest', () => {
  const list = [
    ...Array.from({ length: 40 }, (_, i) => d(`s${i % 5}`, 'raw-colour', `Raw colour in fill: #${i}`, 'warning', `p${i}`)),
    d('s1', 'raw-colour', 'Raw colour in fill: #0'),
    d('s2', 'low-contrast', '"1" contrast 4.4:1'),
    d('s4', 'text-overlap', '"A" overlaps "B"', 'error'),
  ];
  it('groups by kind, says the fix once, and caps the examples', () => {
    const g = digest(list);
    expect(g).toMatchObject({ errors: 1, warnings: 42 });
    expect(g.groups.map(x => x.code)).toEqual(['text-overlap', 'raw-colour', 'low-contrast']);
    const raw = g.groups[1];
    expect(raw).toMatchObject({ count: 41, fix: 'fix raw-colour', slides: ['s0', 's1', 's2', 's3', 's4'], more: 37 });
    expect(raw.examples[0]).toBe('Raw colour in fill: #0 (x2) at s0#p0 s1');
    expect(g.detail).toContain('deck_check');
  });
  it('after an edit, keeps errors from anywhere and warnings from the changed slides', () => {
    const g = digest(list, { scope: ['s2'] });
    expect(g.groups.map(x => x.code)).toEqual(['text-overlap', 'raw-colour', 'low-contrast']);
    expect(g.groups.find(x => x.code === 'raw-colour')?.slides).toEqual(['s2']);
    expect(g.elsewhere).toMatch(/^33 warnings on other slides/);
    expect(digest(list, { scope: [] }).groups.map(x => x.code)).toEqual(['text-overlap']);
  });
});

describe('skimming a slide', () => {
  const geometry = 'M0 0 ' + 'L10 10 '.repeat(40);
  const src = `---
title: t
brief: ${'a long brief '.repeat(30)}
---
<Diagram viewBox="0 0 100 100" alt="${'a long description of the figure '.repeat(10)}">
  <svg class="sprite"><defs><symbol id="ic-a" viewBox="0 0 24 24"><path d="${geometry}"/><defs><linearGradient id="g1"><stop offset="0"/></linearGradient></defs></symbol>
  <symbol id="ic-b"><path d="${geometry}"/></symbol></defs></svg>
  <symbol id="loose-1"><path d="${geometry}"/></symbol>
  <symbol id="loose-2"><path d="${geometry}"/></symbol>
  <g id="f" data-tex="x^2">${'<path d="M1 1"/>'.repeat(40)}</g>
  <path id="wave" class="seg" d="${geometry}"/>
  <text id="label">Hello</text>
</Diagram>
`;
  const s = skim(src);
  it('leaves out geometry, defs, symbol runs and typeset formulas, and keeps the rest', () => {
    expect(s.source.length).toBeLessThan(src.length / 2);
    expect(s.source.startsWith(src.slice(0, src.indexOf('<Diagram')))).toBe(true);      // frontmatter untouched
    expect(s.source).toContain('a long description of the figure');                       // prose attributes stay
    expect(s.source).toContain('<path id="wave" class="seg" d="' + ELIDED);
    expect(s.source).toContain('data-tex="x^2">');
    expect(s.source).toContain('2 symbols, ids: loose-1 loose-2');
    expect(s.source).toContain('<text id="label">Hello</text>');
    expect([...s.hidden].sort()).toEqual(['g1', 'ic-a', 'ic-b', 'loose-1', 'loose-2']);
  });
  it('still parses, with the same ids outside what it folded', () => {
    const ids = (x: string) => { const a: string[] = []; walk(parseSlide(x).root, e => { if (e.attribs?.id) a.push(e.attribs.id); }); return a; };
    expect(ids(s.source)).toEqual(ids(src).filter(i => !s.hidden.has(i)));
  });
  it('leaves a small hand-written slide exactly as it is', () => {
    const small = readFileSync(resolve('examples/launch-story/slides/02-why-it-fails.slide'), 'utf8');
    expect(skim(small)).toMatchObject({ source: small, saved: 0 });
  });
  it('gives one element verbatim', () => {
    expect(element(src, 'wave')).toBe(`<path id="wave" class="seg" d="${geometry}"/>`);
    expect(() => element(src, 'nope')).toThrow('No element');
  });
});

it('drops empty and repeated fields from the outline', () => {
  expect(slimOutline({ revision: 'r', slides: [{ id: 'a', title: 'T', brief: 'T', steps: 0, spots: [], depth: 1, warnings: 2 }] }))
    .toEqual({ revision: 'r', slides: [{ id: 'a', title: 'T', depth: 1, warnings: 2 }] });
});

describe('over MCP', () => {
  const t = tempDeck();
  const client = new Client({ name: 'test', version: '1' });
  const call = async (name: string, args: any = {}) => client.callTool({ name, arguments: args }) as Promise<any>;
  const json = (r: any) => JSON.parse(r.content.find((c: any) => c.type === 'text').text);
  beforeAll(async () => {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/src/bin.ts'), t.dir], env: process.env as Record<string, string>, stderr: 'ignore' }));
  }, 30000);
  afterAll(async () => { await client.close(); t.done(); });

  it('refuses to write back a skimmed source', async () => {
    const { revision } = json(await call('deck_outline'));
    const r = await call('deck_apply', { baseRevision: revision, ops: [{ op: 'replaceSlide', id: '06-close', source: `<path d="${ELIDED} 900 chars⟫"/>` }] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('full');
  });
  it('gives the catalog as an overview, and any part in full on request', async () => {
    const all = json(await call('catalog'));
    expect(all.macros.length).toBeGreaterThan(10);
    expect(all.macros[0].example).toBeUndefined();
    expect(all.scenes.more).toContain('topics');
    const some = json(await call('catalog', { topics: ['header', 'scenes', 'bogus'] }));
    expect(some.Header.example).toContain('<Header');
    expect(some.scenes.ctx).toBeDefined();
    expect(some.unknown).toEqual(['bogus']);
  });
  it('reads one element of a slide', async () => {
    const r = json(await call('slide_read', { slide: '02-why-it-fails', element: 'cause' }));
    expect(r.source.startsWith('<')).toBe(true);
    expect(r.source).toContain('id="cause"');
  });
});
