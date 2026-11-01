import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyOps, catalog, compileDeck, compileSlide, CUES, PATTERNS, PHRASES, deckOutline, patchSlide, revisionOf, deckPhrases, savePlan, undo, addAnnotation, readAnnotations, resolveAnnotations, confine, type Op } from '@present/core';
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
    expect(codes(slide('<svg><image href="missing.png"/></svg>'))).toEqual(['bad-image']);   // an SVG image is a local file, not a link
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

describe('primitives', () => {
  const score = (body: string, phrases?: any) => compileSlide(`---\ntitle: t\nbrief: b\nscore:\n${body}---\n<Diagram viewBox="0 0 1600 500" alt="x"><Milestones id="m" x="0" y="0" w="1600" h="480" items="A|a;B|b;C|c" /></Diagram>`, { id: 's', images: () => null, phrases });
  it('compiles every pattern with no errors, and each has what an agent needs', () => {
    for (const [name, p] of Object.entries(PATTERNS)) {
      const r = compileSlide(p.source, { id: name, images: () => null });
      expect(r.diagnostics.filter(d => d.severity === 'error'), name).toEqual([]);
      expect(p.useWhen.length, name).toBeGreaterThan(10);
    }
  });
  it('makes one step per part from a single line', () => {
    const r = score('  steps:\n    - over: .part\n      use: arrive\n');
    expect(r.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    expect(r.slide.phases).toHaveLength(4);
    expect(r.slide.phases[2].tracks.map(t => t.k)).toEqual(['draw', 'pop', 'ripple', 'rise']);
  });
  it('lets a phrase fit a drawing that lacks some parts', () => {
    expect(PHRASES.arrive.cues.every(c => c.optional)).toBe(true);
    const r = score('  intro:\n    - use: arrive\n      on: .card\n');
    expect(r.diagnostics.filter(d => d.code === 'cue-target-missing')).toEqual([]);
  });
  it('takes parameters, and a deck can add and override phrases', () => {
    const r = score('  intro:\n    - use: mine\n      who: m-2\n', { mine: { doc: 'x', cues: [{ pop: '{who}' }] } });
    expect(r.slide.phases[0].tracks.filter(t => t.k === 'pop')).toHaveLength(1);
    expect(r.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
  });
  it('says what is wrong with a bad phrase or cue', () => {
    const codes = (b: string, p?: any) => score(b, p).diagnostics.map(d => d.code);
    expect(codes('  intro:\n    - use: nope\n')).toContain('unknown-phrase');
    expect(codes('  intro:\n    - use: a\n', { a: { doc: '', cues: [{ use: 'a' }] } })).toContain('phrase-cycle');
    expect(codes('  intro:\n    - animate: m-1\n')).toContain('animate-needs-prop');
  });
  it('adds a slide from a pattern, and refuses an unknown one', () => {
    const t = tempDeck();
    const ok = applyOps(t.dir, [{ op: 'addSlide', id: 'plan', pattern: 'agenda' }], revisionOf(t.dir));
    expect(ok.ok).toBe(true);
    expect(compileDeck(t.dir).deck.slides.at(-1)!.phases.length).toBe(5);
    expect(applyOps(t.dir, [{ op: 'addSlide', id: 'x', pattern: 'nope' }], revisionOf(t.dir)).error).toContain('Patterns:');
    t.done();
  });
  it('reads phrases from deck.yaml', () => {
    const t = tempDeck();
    writeFileSync(join(t.dir, 'deck.yaml'), readFileSync(join(t.dir, 'deck.yaml'), 'utf8') + '\nphrases:\n  beat:\n    doc: mine\n    cues:\n      - bump: $\n');
    expect(catalog(CUES, deckPhrases(t.dir)).phrases.map((p: any) => p.name)).toContain('beat');
    t.done();
  });
  it('tells agents how to compose', () => {
    const c = catalog(CUES);
    expect(c.howToCompose).toContain('.part');
    expect(c.patterns.map((p: any) => p.name)).toContain('gates');
    expect(c.macros.map((m: any) => m.name)).toEqual(expect.arrayContaining(['Milestones', 'Plot', 'Timing', 'Hub', 'Terrain', 'Neck']));
  });
});

describe('the slide tree', () => {
  const nested = (t: ReturnType<typeof tempDeck>) => writeFileSync(join(t.dir, 'deck.yaml'), 'title: T\nslides:\n  - 01-title\n  - id: 02-why-it-fails\n    deep:\n      - 03-the-loop\n      - id: 04-a-frame\n        deep:\n          - 05-results\n  - 06-close\n');
  it('reads a tree, and counts only the main path as the talk', () => {
    const t = tempDeck();
    nested(t);
    const o = deckOutline(t.dir);
    expect(o.slides.map(s => s.label)).toEqual(['1', '2', '2.1', '2.2', '2.2.1', '3']);
    expect(o.slides.find(s => s.id === '05-results')).toMatchObject({ parent: '04-a-frame', depth: 2 });
    expect(o.deepDiveMs).toBeGreaterThan(0);
    t.done();
  });
  it('keeps the tree through edits, and undo restores it', () => {
    const t = tempDeck();
    nested(t);
    const before = readFileSync(join(t.dir, 'deck.yaml'), 'utf8');
    expect(applyOps(t.dir, [{ op: 'addSlide', id: 'extra', pattern: 'statement', under: '02-why-it-fails' }], revisionOf(t.dir)).ok).toBe(true);
    let o = deckOutline(t.dir);
    expect(o.slides.find(s => s.id === 'extra')).toMatchObject({ parent: '02-why-it-fails', label: '2.3' });
    expect(o.slides.find(s => s.id === '05-results')?.label).toBe('2.2.1');
    undo(t.dir);
    expect(readFileSync(join(t.dir, 'deck.yaml'), 'utf8')).toBe(before);
    t.done();
  });
  it('moves a slide in and out of a dive, and refuses a loop', () => {
    const t = tempDeck();
    nested(t);
    expect(applyOps(t.dir, [{ op: 'moveSlide', id: '06-close', under: '01-title' }], revisionOf(t.dir)).ok).toBe(true);
    expect(deckOutline(t.dir).slides.find(s => s.id === '06-close')).toMatchObject({ parent: '01-title', label: '1.1' });
    expect(applyOps(t.dir, [{ op: 'moveSlide', id: '06-close', under: null }], revisionOf(t.dir)).ok).toBe(true);
    expect(deckOutline(t.dir).slides.find(s => s.id === '06-close')?.depth).toBe(0);
    expect(applyOps(t.dir, [{ op: 'moveSlide', id: '02-why-it-fails', under: '05-results' }], revisionOf(t.dir)).error).toContain('its own deep dive');
    t.done();
  });
  it('keeps a removed slide\'s deep dives, one level up', () => {
    const t = tempDeck();
    nested(t);
    expect(applyOps(t.dir, [{ op: 'removeSlide', id: '04-a-frame' }], revisionOf(t.dir)).ok).toBe(true);
    expect(deckOutline(t.dir).slides.find(s => s.id === '05-results')).toMatchObject({ parent: '02-why-it-fails', depth: 1 });
    t.done();
  });
  it('plans deep dives without counting them against the time', () => {
    const t = tempDeck(), s = (id: string, under?: string) => ({ id, title: id, claim: 'c', under });
    const r = savePlan(t.dir, { goal: 'g', minutes: 2, slides: [s('a'), s('b', 'a'), s('c', 'a'), s('d', 'a'), s('e', 'a')] });
    expect(r.issues.filter(i => i.message.includes('minute'))).toEqual([]);
    expect(savePlan(t.dir, { goal: 'g', slides: [s('a', 'nope')] }).ok).toBe(false);
    t.done();
  });
});
