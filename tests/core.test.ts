import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyOps, catalog, compileDeck, compileSlide, CUES, deckOutline, patchSlide, revisionOf, undo, addAnnotation, readAnnotations, resolveAnnotations, confine, type Op } from '@present/core';
import { EXAMPLE, tempDeck } from './helpers.ts';

const slide = (body: string, score = '') => `---\ntitle: T\nbrief: B\n${score}---\n${body}\n`;
const codes = (src: string) => compileSlide(src, { id: 's' }).diagnostics.map(d => d.code);

describe('compile', () => {
  it('compiles the example deck with no diagnostics', () => {
    const { deck, diagnostics } = compileDeck(EXAMPLE);
    expect(diagnostics).toEqual([]);
    expect(deck.slides).toHaveLength(6);
  });
  it('knows durations without a browser', () => {
    const out = deckOutline(EXAMPLE);
    expect(out.runningTimeMs).toBeGreaterThan(5000);
    expect(out.slides[1].phaseMs.every(ms => ms > 0)).toBe(true);
  });
  it('expands macros to plain HTML and SVG', () => {
    const { slide: s } = compileSlide(slide('<Diagram viewBox="0 0 10 10" alt="a"><Box id="a" x="0" y="0" w="1" h="1" /><Box id="b" x="5" y="0" w="1" h="1" /><Link id="l" from="a" to="b" /></Diagram>'), { id: 's' });
    expect(s.html).not.toMatch(/<(Box|Link|Diagram)/);
    expect(s.html).toContain('id="l"');
    expect(s.html).toContain('d="M 1 0.5 L 5 0.5"');
  });
  it('wraps headline words', () => {
    expect(compileSlide(slide('<Header>Two <em>words</em></Header>'), { id: 's' }).slide.html.match(/class="w"/g)).toHaveLength(2);
  });
  it('compiles a score to absolute tracks with stagger and each', () => {
    const src = slide('<g class="x"><g class="y"></g></g><g class="x"><g class="y"></g></g>', 'score:\n  steps:\n    - each: .x\n      stagger: 100\n      cues:\n        - fade: $ .y\n          at: 10\n');
    const { slide: s, diagnostics } = compileSlide(src, { id: 's' });
    expect(diagnostics).toEqual([]);
    expect(s.phases[1].tracks.map(t => t.s)).toEqual([10, 110]);
  });
});

describe('diagnostics', () => {
  it('rejects scripts, handlers and foreign links', () => {
    expect(codes(slide('<script>alert(1)</script>'))).toContain('disallowed-tag');
    expect(compileSlide(slide('<script>alert(1)</script>'), { id: 's' }).slide.html).not.toContain('alert');
    expect(codes(slide('<div onclick="x()"></div>'))).toContain('disallowed-attr');
    expect(compileSlide(slide('<div onclick="x()"></div>'), { id: 's' }).slide.html).not.toContain('onclick');
    expect(codes(slide('<a href="javascript:x()">y</a>'))).toContain('disallowed-link');
  });
  it('flags author mistakes with fixes', () => {
    expect(codes(slide('<Nope />'))).toContain('unknown-macro');
    expect(codes(slide('<Box id="a" x="0" y="0" w="1" h="1" />'))).toContain('macro-context');
    expect(codes(slide('<div id="a"></div><div id="a"></div>'))).toContain('duplicate-id');
    expect(codes(slide('<Diagram viewBox="0 0 1 1"></Diagram>'))).toContain('missing-alt');
    expect(codes(slide('<div></div>', 'score:\n  intro:\n    - rise: nothing\n'))).toContain('cue-target-missing');
    expect(codes(slide('<div id="a"></div>', 'score:\n  intro:\n    - wiggle: a\n'))).toContain('unknown-cue');
    expect(codes(slide('<div style="color:#123456"></div>'))).toContain('raw-colour');
  });
  it('warns on props a macro ignores', () => {
    expect(codes(slide('<Diagram viewBox="0 0 9 9" alt="a"><Box id="a" x="0" y="0" w="1" h="1" colour="red" /></Diagram>'))).toContain('unknown-prop');
  });
  it('aims count at a Stat value', () => {
    const r = compileSlide(slide('<Stat id="n" value="3" label="L" />', 'score:\n  intro:\n    - count: n\n'), { id: 's' });
    expect(r.diagnostics).toEqual([]);
    expect(r.slide.html).toContain('id="n-v" data-n="1"');
  });
  it('colours a Link by tone', () => {
    expect(compileSlide(slide('<Diagram viewBox="0 0 9 9" alt="a"><Box id="a" x="0" y="0" w="1" h="1" /><Box id="b" x="5" y="0" w="1" h="1" /><Link id="l" from="a" to="b" tone="danger" /></Diagram>'), { id: 's' }).slide.html).toContain('stroke:var(--danger)');
  });
  it('keeps loops to signals, so slides can rest', () => {
    expect(codes(slide('<div id="a"></div>', 'score:\n  steps:\n    - loop:\n        cues:\n          - rise: a\n'))).toContain('loop-not-signal');
    expect(codes(slide('<div id="a"></div>', 'score:\n  steps:\n    - loop:\n        every: 100\n        cues:\n          - hot: a\n            dur: 500\n'))).toContain('loop-overlap');
  });
});

describe('ops', () => {
  let t: ReturnType<typeof tempDeck>;
  afterEach(() => t?.done());
  const path = (id: string) => join(t.dir, 'slides', `${id}.slide`);

  it('patches only what changed', () => {
    t = tempDeck();
    const before = readFileSync(path('02-why-it-fails'), 'utf8').replace(/\r\n/g, '\n');
    const after = patchSlide(before, { op: 'setText', slide: 'x', id: 'cause-text', text: 'No eyes' });
    expect(after).toBe(before.replace('No way to observe the result</text>', 'No eyes</text>'));
    expect(patchSlide(before, { op: 'setAttr', slide: 'x', id: 'cause', name: 'tone', value: 'ok' })).toBe(before.replace('id="cause" x="782" y="96" w="766" h="120" tone="accent"', 'id="cause" x="782" y="96" w="766" h="120" tone="ok"'));
  });
  it('supports structural edits', () => {
    t = tempDeck();
    const rev = revisionOf(t.dir);
    const ops: Op[] = [
      { op: 'insertNode', slide: '04-a-frame', parent: 'a', markup: '<Text id="note">Added</Text>' },
      { op: 'moveNode', slide: '04-a-frame', id: 'c', before: 'a' },
      { op: 'removeNode', slide: '04-a-frame', id: 'b' },
      { op: 'setNotes', slide: '04-a-frame', notes: 'New notes' },
      { op: 'setScore', slide: '04-a-frame', score: { intro: [{ rise: 'rule' }] } },
    ];
    const r = applyOps(t.dir, ops, rev);
    expect(r.ok, r.error).toBe(true);
    const s = readFileSync(path('04-a-frame'), 'utf8');
    expect(s).toContain('id="note"');
    expect(s).not.toContain('id="b"');
    expect(s.indexOf('id="c"')).toBeLessThan(s.indexOf('id="a"'));
    expect(s).toContain('notes: New notes');
  });
  it('rejects a stale revision and writes nothing', () => {
    t = tempDeck();
    const rev = revisionOf(t.dir);
    const file = path('04-a-frame');
    writeFileSync(file, readFileSync(file, 'utf8') + '\n<!-- a human edit -->\n');
    const human = readFileSync(file, 'utf8');
    const r = applyOps(t.dir, [{ op: 'setNotes', slide: '04-a-frame', notes: 'x' }], rev);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Stale/);
    expect(readFileSync(file, 'utf8')).toBe(human);
  });
  it('applies a batch atomically: one bad op, nothing written', () => {
    t = tempDeck();
    const rev = revisionOf(t.dir);
    const before = readFileSync(path('04-a-frame'), 'utf8');
    const r = applyOps(t.dir, [
      { op: 'setNotes', slide: '04-a-frame', notes: 'good' },
      { op: 'insertNode', slide: '04-a-frame', markup: '<script>bad()</script>' },
    ], rev);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.map(d => d.code)).toContain('disallowed-tag');
    expect(readFileSync(path('04-a-frame'), 'utf8')).toBe(before);
    expect(revisionOf(t.dir)).toBe(rev);
  });
  it('adds, reorders, removes and undoes', () => {
    t = tempDeck();
    const r1 = applyOps(t.dir, [{ op: 'addSlide', id: 'new', after: '01-title', source: slide('<Header>New</Header>') }], revisionOf(t.dir));
    expect(r1.ok, r1.error).toBe(true);
    expect(compileDeck(t.dir).deck.slides[1].id).toBe('new');
    expect(undo(t.dir).ok).toBe(true);
    expect(compileDeck(t.dir).deck.slides.map(s => s.id)).not.toContain('new');
    const order = compileDeck(t.dir).deck.slides.map(s => s.id).reverse();
    expect(applyOps(t.dir, [{ op: 'reorderSlides', order }], revisionOf(t.dir)).ok).toBe(true);
    expect(compileDeck(t.dir).deck.slides[0].id).toBe('06-close');
    expect(applyOps(t.dir, [{ op: 'addSlide', id: '../evil', source: 'x' }], revisionOf(t.dir)).ok).toBe(false);
  });
  it('sets deck fields', () => {
    t = tempDeck();
    expect(applyOps(t.dir, [{ op: 'setDeck', title: 'Renamed' }], revisionOf(t.dir)).ok).toBe(true);
    expect(compileDeck(t.dir).deck.title).toBe('Renamed');
    expect(undo(t.dir).ok).toBe(true);
    expect(compileDeck(t.dir).deck.title).not.toBe('Renamed');
  });
  it('edits cue timing in place', () => {
    t = tempDeck();
    const { deck } = compileDeck(t.dir);
    const cue = deck.slides[3].phases[1].tracks[0].c!;
    expect(applyOps(t.dir, [{ op: 'setCueTiming', slide: '04-a-frame', cue, at: 777 }], revisionOf(t.dir)).ok).toBe(true);
    expect(compileDeck(t.dir).deck.slides[3].phases[1].tracks[0].s).toBe(777);
  });
  it('stores annotations outside the source, and resolves them', () => {
    t = tempDeck();
    const before = readFileSync(path('04-a-frame'), 'utf8');
    const a = addAnnotation(t.dir, { slide: '04-a-frame', node: 'rule', step: 0, comment: 'Bigger' });
    expect(readFileSync(path('04-a-frame'), 'utf8')).toBe(before);
    expect(readAnnotations(t.dir)[0].comment).toBe('Bigger');
    expect(resolveAnnotations(t.dir, [a.id])).toBe(1);
    expect(readAnnotations(t.dir)[0].status).toBe('resolved');
  });
  it('writes an id into the source when annotating a part without one', () => {
    t = tempDeck();
    const a = addAnnotation(t.dir, { slide: '06-close', path: [0], step: 0, comment: 'x' });
    expect(a.node).toMatch(/^n-/);
    expect(readFileSync(path('06-close'), 'utf8')).toContain(`id="${a.node}"`);
  });
});

it('keeps paths in the deck', () => {
  expect(() => confine('/deck', '../secret')).toThrow();
});

it('documents every cue in the catalog', () => {
  const c = catalog(CUES);
  expect(c.cues.map(x => x.name)).toContain('travel');
  expect(c.macros.map(m => m.name)).toContain('Diagram');
});
