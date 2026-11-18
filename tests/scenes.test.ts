// What the RookDB deck asked for: scenes as a feature, cues that keep state, code panels, and the workflow around them.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyOps, catalog, compileDeck, compileSlide, CUES, listLibrary, readDeck, readSceneTimings, revisionOf, saveToLibrary, searchLibrary, removeFromLibrary, quoteProse, type Diagnostic } from '@present/core';
import { exportHtml, Renderer } from '@present/render';

const slide = (body: string, front = '') => `---\ntitle: T\nbrief: B\n${front}---\n${body}\n`;
const compile = (body: string, front = '') => compileSlide(slide(body, front), { id: 's' });
const codes = (d: Diagnostic[]) => d.map(x => x.code);
const byId = (html: string, id: string) => Number(new RegExp(`id="${id}"[^>]*data-n="(\\d+)"|data-n="(\\d+)"[^>]*id="${id}"`).exec(html)?.slice(1).find(Boolean));

function deck(slides: Record<string, string>, extra: Record<string, string> = {}, meta = '') {
  const dir = mkdtempSync(join(tmpdir(), 'present-sc-'));
  mkdirSync(join(dir, 'slides'));
  for (const [id, src] of Object.entries(slides)) writeFileSync(join(dir, 'slides', `${id}.slide`), src);
  for (const [rel, src] of Object.entries(extra)) { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), src); }
  writeFileSync(join(dir, 'deck.yaml'), `title: Sc\n${meta}slides:\n${Object.keys(slides).map(id => `  - ${id}`).join('\n')}\n`);
  return dir;
}

describe('type and count keep the markup inside text', () => {
  it('no longer refuses a target with tspans', () => {
    const r = compile('<svg><text id="t">SELECT <tspan>name</tspan></text><text id="n"><tspan>Took </tspan>237 s</text></svg>', 'score:\n  intro:\n    - type: t\n    - count: n\n');
    expect(codes(r.diagnostics)).toEqual([]);
    expect(r.slide.phases[0].tracks.find(t => t.k === 'type')!.d).toBe(Math.max(400, 'SELECT name'.length * 38));
  });
  it('rate sets the speed, and chain types targets one after another', () => {
    const r = compile('<svg><text class="l">abcd</text><text class="l">abcdefgh</text></svg>', 'score:\n  intro:\n    - type: .l\n      rate: 50\n      chain: true\n      gap: 100\n');
    const [a, b] = r.slide.phases[0].tracks;
    expect([a.s, a.d, b.s, b.d]).toEqual([0, 200, 300, 400]);
  });
});

describe('animate carries on from where it stopped', () => {
  it('fills from with the last to on the same attribute, across steps', () => {
    const r = compile('<svg><rect id="m" x="548" y="0" width="10" height="10"/></svg>', 'score:\n  steps:\n    - cues:\n        - animate: m\n          attr: x\n          from: 0\n          to: 120\n    - cues:\n        - animate: m\n          attr: x\n          to: 548\n');
    expect(r.slide.phases[1].tracks[0].a).toMatchObject({ from: 0, to: 120 });
    expect(r.slide.phases[2].tracks[0].a).toMatchObject({ from: 120, to: 548 });
  });
});

describe('swap', () => {
  const body = '<Diagram viewBox="0 0 800 400" alt="x"><Swap id="s"><g id="p1"><text x="10" y="20">one two three</text></g><g id="p2"><text x="10" y="20">four five</text></g><g id="p3"><text x="10" y="20">six</text></g></Swap></Diagram>';
  const front = 'score:\n  steps:\n    - cues:\n        - swap: s\n          to: 2\n    - cues:\n        - swap: s\n          to: p3\n';
  it('leaves the panel showing and brings in the next, and only the last stays at rest', () => {
    const r = compile(body, front);
    expect(codes(r.diagnostics)).toEqual([]);
    expect(r.slide.phases[1].tracks.map(t => t.k)).toEqual(['leave', 'rise']);
    expect(r.slide.html).toMatch(/id="p1"[^>]*data-leaves/);
    expect(r.slide.html).toMatch(/id="p2"[^>]*data-leaves/);
    expect(r.slide.html).not.toMatch(/id="p3"[^>]*data-leaves/);
  });
  it('warns about a panel that never shows, and a bad to', () => {
    const r = compile(body, 'score:\n  steps:\n    - cues:\n        - swap: s\n          to: 2\n');
    expect(codes(r.diagnostics)).toContain('swap-unused');
    expect(codes(compile(body, 'score:\n  steps:\n    - cues:\n        - swap: s\n          to: 9\n').diagnostics)).toContain('bad-swap');
  });
  it('counts the words of one panel, not all of them', () => {
    const many = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');
    const big = `<Diagram viewBox="0 0 800 400" alt="x"><Swap id="s"><g><text x="1" y="1">${many}</text></g><g><text x="1" y="1">${many}</text></g></Swap></Diagram>`;
    expect(codes(compile(big, 'score:\n  steps:\n    - cues:\n        - swap: s\n          to: 2\n').diagnostics)).not.toContain('too-many-words');
  });
});

describe('build', () => {
  const body = '<Diagram id="d" viewBox="0 0 1600 600" alt="x"><Box id="c" x="900" y="40" w="200" h="80" title="C" /><Box id="a" x="40" y="40" w="200" h="80" title="A" /><Box id="b" x="460" y="40" w="200" h="80" title="B" /><Link id="ab" from="a" to="b" /><Link id="bc" from="b" to="c" /></Diagram>';
  it('pops what nothing points at, then runs each link into its target as it lands', () => {
    const r = compile(body, 'score:\n  intro:\n    - build: d\n');
    expect(codes(r.diagnostics)).toEqual([]);
    const html = r.slide.html, t = r.slide.phases[0].tracks.filter(x => x.k !== 'word');
    const at = (k: string, id: string) => t.find(x => x.k === k && x.n === byId(html, id))!.s;
    expect(at('pop', 'a')).toBe(0);
    expect(at('draw', 'ab')).toBeGreaterThan(at('pop', 'a'));
    expect(at('travel', 'ab')).toBeGreaterThan(at('draw', 'ab'));
    expect(at('pop', 'b')).toBeGreaterThan(at('travel', 'ab'));
    expect(at('ripple', 'b')).toBeGreaterThan(at('pop', 'b') - 100);
    expect(at('draw', 'bc')).toBeGreaterThan(at('pop', 'b'));
    expect(at('pop', 'c')).toBeGreaterThan(at('travel', 'bc'));
  });
});

describe('steps and slides set their own pace', () => {
  it('auto on a step, and mode and scale on a slide', () => {
    const r = compile('<Text>x</Text>', 'mode: steps\nscale: 1.2\nscore:\n  steps:\n    - auto: 1200\n      cues: []\n    - auto: true\n      cues: []\n');
    expect(r.slide.mode).toBe('steps');
    expect(r.slide.scale).toBe(1.2);
    expect(r.slide.phases.map(p => p.auto)).toEqual([undefined, 1200, 700]);
    expect(codes(compile('<Text>x</Text>', 'mode: sometimes\n').diagnostics)).toContain('bad-mode');
  });
});

describe('define on a parent', () => {
  it('covers every formula inside it, marking each symbol once', () => {
    const r = compile('<Card id="c" define="H: height of the tree; b: bits guessed"><Text><Math>2^H</Math></Text><Text><Math>b + H</Math></Text></Card>');
    expect(codes(r.diagnostics)).toEqual([]);
    expect(r.slide.html.match(/data-term="H"/g)).toHaveLength(1);
    expect(r.slide.html.match(/data-term="b"/g)).toHaveLength(1);
  });
  it('reports a symbol that is in no formula inside', () => {
    expect(codes(compile('<Card define="z: nothing"><Text><Math>x</Math></Text></Card>').diagnostics)).toContain('bad-define');
  });
});

describe('Code', () => {
  it('draws a line per part, colours keywords, strings and comments, and tints output', () => {
    const r = compile('<Diagram viewBox="0 0 1000 400" alt="q"><Code id="q" x="10" y="10" w="700" lang="sql" ok="✓" err="ERROR">\n  SELECT \'a\' -- note\n  FROM t;\n  ✓ 1 row\n  ERROR: no\n</Code></Diagram>', 'score:\n  intro:\n    - use: type-code\n      on: q\n');
    expect(codes(r.diagnostics)).toEqual([]);
    const h = r.slide.html;
    for (const id of ['q-1', 'q-2', 'q-3', 'q-4', 'q-1-t']) expect(h).toContain(`id="${id}"`);
    expect(h).toMatch(/<tspan style="fill:var\(--accent\)[^"]*">SELECT<\/tspan>/);
    expect(h).toMatch(/var\(--data-3\)[^>]*>'a'</);
    expect(h).toMatch(/font-style:italic[^>]*>-- note</);
    expect(h).toMatch(/id="q-3-t"[^>]*fill:var\(--ok\)/);
    expect(h).toMatch(/id="q-4-t"[^>]*fill:var\(--danger\)/);
    const types = r.slide.phases[0].tracks.filter(t => t.k === 'type');
    expect(types).toHaveLength(4);
    expect(types[1].s).toBeGreaterThanOrEqual(types[0].s + types[0].d);
  });
  it('also works outside a Diagram', () => {
    const r = compile('<Code id="c" lang="py">def f():\n  return 1</Code>');
    expect(codes(r.diagnostics)).toEqual([]);
    expect(r.slide.html).toContain('class="part p-code-line" id="c-2"');
  });
});

describe('Box and HTML sizes', () => {
  it('subSize sets the sub line, and defaults to three quarters of size', () => {
    expect(compile('<Diagram viewBox="0 0 800 400" alt="x"><Box id="b" x="0" y="0" w="400" h="160" title="A" sub="b" size="28" /></Diagram>').slide.html).toContain('font-size:21px');
    expect(compile('<Diagram viewBox="0 0 800 400" alt="x"><Box id="b" x="0" y="0" w="400" h="160" title="A" sub="b" subSize="19" /></Diagram>').slide.html).toContain('font-size:19px');
  });
  it('size reaches the text in a card, and fill marks a grid', () => {
    const h = compile('<Grid cols="2" fill="" size="30"><Card size="32"><Text>a</Text></Card><Card><Text size="24">b</Text></Card></Grid>').slide.html;
    expect(h).toContain('--text-size:30px');
    expect(h).toContain('--text-size:32px');
    expect(h).toContain('font-size:24px');
    expect(h).toContain('data-fill=""');
  });
});

describe('scenes compile', () => {
  const s = (front: string, body = '<Diagram id="d" viewBox="0 0 800 400" alt="x"><rect id="r" x="1" y="1" width="9" height="9"/></Diagram><Text id="out">x</Text>') => slide(body, front);
  it('needs a scene file and a root', () => {
    const dir = deck({ a: s('score:\n  scene: nope\n'), b: s('score:\n  scene: lane\n', '<Text>no svg</Text>') }, { 'scenes/lane.ts': 'export default (ctx) => {};' });
    const c = codes(compileDeck(dir).diagnostics);
    expect(c).toContain('unknown-scene');
    expect(c).toContain('scene-root-missing');
    rmSync(dir, { recursive: true, force: true });
  });
  it('refuses cues inside the root, and allows them outside it', () => {
    const dir = deck({ a: s('score:\n  scene: lane\n  intro:\n    - rise: r\n'), b: s('score:\n  scene: lane\n  intro:\n    - rise: out\n') }, { 'scenes/lane.ts': 'export default (ctx) => { ctx.step(() => {}); };' });
    const d = compileDeck(dir).diagnostics;
    expect(d.filter(x => x.code === 'scene-owns').map(x => x.slide)).toEqual(['a']);
    rmSync(dir, { recursive: true, force: true });
  });
  it('guesses a step per ctx.step until a browser has timed it', () => {
    const dir = deck({ a: s('score:\n  scene: lane\n') }, { 'scenes/lane.ts': 'export default (ctx) => { ctx.step(() => {}); ctx.step("b", () => {}); };' });
    const sl = compileDeck(dir).deck.slides[0];
    expect(sl.phases).toHaveLength(3);
    expect(sl.scene).toMatchObject({ name: 'lane', measured: false });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('ops', () => {
  let dir = '';
  beforeAll(() => { dir = deck({ a: slide('<Text>a</Text>', 'score:\n  intro:\n    - rise: x\n'), b: slide('<Text>b</Text>'), c: slide('<Text>c</Text>') }); writeFileSync(join(dir, 'slides', 'a.slide'), slide('<Text id="x">a</Text>', 'score:\n  intro:\n    - rise: x\n')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it('setStep and appendCue change one step without resending the slide', () => {
    let r = applyOps(dir, [{ op: 'setStep', slide: 'a', step: 1, name: 'show', cues: [{ fade: 'x' }] }], revisionOf(dir));
    expect(r.ok).toBe(true);
    r = applyOps(dir, [{ op: 'appendCue', slide: 'a', step: 1, cue: { pulse: 'x', at: 300 } }, { op: 'setStep', slide: 'a', step: 1, auto: 900 }], revisionOf(dir));
    expect(r.ok).toBe(true);
    const sl = compileDeck(dir).deck.slides[0];
    expect(sl.phases[1]).toMatchObject({ name: 'show', auto: 900 });
    expect(sl.phases[1].tracks.map(t => t.k)).toEqual(['fade', 'pulse']);
    expect(applyOps(dir, [{ op: 'appendCue', slide: 'a', step: 5, cue: { fade: 'x' } }], revisionOf(dir)).error).toMatch(/gap/);
  });
  it('setCueTiming finds a cue by its numbered path', () => {
    expect(applyOps(dir, [{ op: 'setCueTiming', slide: 'a', cue: 'steps.0.cues.1', at: 450 }], revisionOf(dir)).ok).toBe(true);
    expect(compileDeck(dir).deck.slides[0].phases[1].tracks[1].s).toBe(450);
  });
  it('reorderSlides takes a subset and leaves the rest in place', () => {
    expect(applyOps(dir, [{ op: 'moveSlide', id: 'b', under: 'a' }], revisionOf(dir)).ok).toBe(true);
    expect(applyOps(dir, [{ op: 'reorderSlides', order: ['c', 'a'] }], revisionOf(dir)).ok).toBe(true);
    expect(readDeck(dir).order).toEqual(['c', 'a', 'b']);
    expect(readDeck(dir).parents).toEqual({ b: 'a' });
    expect(applyOps(dir, [{ op: 'reorderSlides', order: ['c', 'c'] }], revisionOf(dir)).ok).toBe(false);
  });
  it('quotes a brief with ": " in it rather than failing', () => {
    const src = '---\ntitle: T\nbrief: The point: rows move\n---\n<Text>x</Text>\n';
    expect(quoteProse(src)).toContain('brief: "The point: rows move"');
    expect(applyOps(dir, [{ op: 'replaceSlide', id: 'c', source: src }], revisionOf(dir)).ok).toBe(true);
    expect(compileDeck(dir).deck.slides.find(s => s.id === 'c')!.brief).toBe('The point: rows move');
    expect(compile('<Text>x</Text>', 'notes: a: b: c\n').diagnostics.find(d => d.code === 'bad-frontmatter')?.fix).toMatch(/quotes/);
  });
});

describe('library', () => {
  let dir = '';
  beforeAll(() => {
    dir = deck({ a: slide('<Diagram viewBox="0 0 800 400" alt="x"><rect id="r"/></Diagram>', 'score:\n  scene: gate-stop\n') }, { 'scenes/gate-stop.ts': '// A request runs a lane and stops at the gate that rejects it.\nexport default (ctx) => {};', 'macros/CostBars.ts': "export default { doc: 'Bars grow to each option\\'s cost; the cheapest wins.', props: '', example: '', svg: () => '<g/>' };" });
  });
  afterAll(() => { for (const n of ['gate-stop', 'CostBars', 'lane-pattern']) try { removeFromLibrary(n); } catch { /* not there */ } rmSync(dir, { recursive: true, force: true }); });
  it('saves a slide with the scene it uses, and finds items by what they are for', () => {
    const item = saveToLibrary(dir, { name: 'lane-pattern', doc: 'A lane with a gate', slide: 'a' });
    expect(item.scenes).toEqual(['gate-stop']);
    expect(item.code).toBe(true);
    saveToLibrary(dir, { name: 'CostBars', doc: 'Bars grow to each option\'s cost; the cheapest wins and is chosen.', macros: ['CostBars'] });
    expect(searchLibrary('choose between two options by cost')[0].name).toBe('CostBars');
    expect(searchLibrary('request stopped at a gate').map(h => h.name)).toContain('lane-pattern');
    expect(listLibrary().find(i => i.name === 'lane-pattern')?.scenes).toEqual(['gate-stop']);
  });
  it('the catalog documents scenes and says where the library is', () => {
    const c = catalog(CUES, {}, [], '/x/library') as any;
    expect(Object.keys(c.scenes.ctx)).toEqual(expect.arrayContaining(['step(name, fn)', 'every(ms, fn, first?)', 'travel(el, path, o?)', 'draw(els, o?)']));
    expect(c.libraryPath).toContain('/x/library');
    expect(c.cues.map((x: any) => x.name)).toEqual(expect.arrayContaining(['swap', 'build']));
  });
});

describe('scenes in the browser', () => {
  const scene = `export default (ctx) => {
  const fx = ctx.layer(), boxes = ctx.$$('[data-box]');
  ctx.hide(boxes);
  boxes.forEach((b, i) => ctx.pop(b, { delay: 80 + i * 120 }));
  ctx.step('send', () => {
    const link = ctx.$('#l1'), to = ctx.$('#b');
    ctx.draw(link, { dur: 500, spark: true });
    ctx.at(500, () => { const c = ctx.center(to); ctx.ripple(fx, c.x, c.y); ctx.hot(to, 900); });
    ctx.every(1250, () => { const d = ctx.dot(fx, 0, 0, 5); ctx.travel(d, link, { dur: 900, done: () => d.remove() }); });
  });
  ctx.step('count', () => { ctx.type(ctx.$('#q'), { dur: 400 }); ctx.count(ctx.$('#n'), { dur: 800 }); });
};`;
  const body = '<Header>A scene</Header><Diagram viewBox="0 0 1600 500" alt="two boxes"><Box id="a" x="100" y="150" w="300" h="140" title="Client" /><Box id="b" x="1000" y="150" w="300" h="140" title="Server" /><Link id="l1" from="a" to="b" tone="accent" /><text id="q" x="100" y="420">SELECT <tspan style="fill:var(--accent)">name</tspan></text><text id="n" x="700" y="420"><tspan>Took </tspan>237 ms</text></Diagram>';
  let dir = '', r: Renderer;
  beforeAll(async () => {
    dir = deck({ lane: slide(body, 'score:\n  scene: lane\n'), code: slide('<Diagram viewBox="0 0 1600 600" alt="c"><Code id="k" x="40" y="40" w="900" lang="js">const a = "x"; // why\nreturn a;</Code></Diagram>', 'score:\n  intro:\n    - use: type-code\n      on: k\n') }, { 'scenes/lane.ts': scene });
    r = new Renderer(dir);
  }, 60000);
  afterAll(async () => { await r.close(); rmSync(dir, { recursive: true, force: true }); });

  it('times every step by replay, and the compiler then knows', async () => {
    const t = (await r.measureScenes()).lane;
    expect(t.names).toEqual(['intro', 'send', 'count']);
    expect(t.rests).toEqual([null, t.builds[1] + 6000, null]);           // a step with loops rests after its window
    expect(t.durs[1]).toBeGreaterThanOrEqual(t.rests[1]!);
    expect(t.durs[2]).toBeLessThan(1000);
    expect(readSceneTimings(dir).lane.durs).toEqual(t.durs);
    const sl = compileDeck(dir).deck.slides[0];
    expect(sl.phases.map(p => p.end).slice(1)).toEqual(t.durs.slice(1));
    expect(sl.scene!.measured).toBe(true);
  }, 60000);
  it('is a pure function of time, through loops and going back', async () => {
    const f = { slide: 1, step: 1, t: 2600 };
    const a = (await r.frame(f)).png;
    await r.frame({ slide: 1 });
    await r.frame({ slide: 1, step: 0, t: 100 });
    expect((await r.frame(f)).png.equals(a)).toBe(true);
  }, 60000);
  it('rests looking like its drawing, and types coloured text without losing it', async () => {
    expect((await r.check(1)).diagnostics).toEqual([]);
    expect((await r.check(2)).diagnostics).toEqual([]);
    const mid = await r.seek({ slide: 1, step: 2, t: 200 });
    expect(mid.step).toBe(2);
    const text = await r.page!.evaluate(() => [document.querySelector('#q')!.innerHTML, document.querySelector('#n')!.textContent]);
    expect(text[0]).toMatch(/^SELECT( <tspan[^>]*>n?a?m?e?<\/tspan>)?$|^SELE?C?T?/);
    expect(text[1]).toMatch(/^Took \d+ ms$/);
  }, 60000);
  it('reports an error thrown inside a scene', async () => {
    writeFileSync(join(dir, 'scenes', 'lane.ts'), scene.replace("ctx.step('count', () => {", "ctx.step('count', () => { ctx.nope();"));
    const d = (await r.check(1)).diagnostics;
    expect(codes(d)).toContain('scene-error');
    writeFileSync(join(dir, 'scenes', 'lane.ts'), scene);
  }, 60000);
  it('films the resting loop', async () => {
    const png = await r.filmstrip(1, 1, 4, undefined, undefined, { loop: true });
    expect(png.length).toBeGreaterThan(1000);
    await expect(r.filmstrip(1, 2, 4, undefined, undefined, { loop: true })).rejects.toThrow(/no resting loop/);
  }, 60000);
});

describe('pace in a show', () => {
  const dir = deck({
    a: slide('<Text id="x">x</Text>', 'score:\n  steps:\n    - auto: 300\n      cues:\n        - fade: x\n          dur: 100\n    - cues:\n        - pulse: x\n'),
    b: slide('<Text id="y">y</Text>', 'mode: steps\nscore:\n  steps:\n    - cues:\n        - fade: y\n          dur: 100\n'),
  });
  const file = join(dir, 'show.html');
  beforeAll(() => exportHtml(dir, file).then(() => undefined), 30000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it('a step with auto goes on by itself in step mode; a slide in step mode waits in an autoplay deck', async () => {
    const b = await chromium.launch({ headless: true, channel: 'chrome' }).catch(() => chromium.launch({ headless: true, channel: 'msedge' }));
    const p = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    await p.goto(pathToFileURL(file).href + '?steps');
    await p.waitForFunction(() => !!(window as any).__present);
    const state = () => p.evaluate(() => (window as any).__present.state());
    await p.keyboard.press('ArrowRight');                       // step 1, which has auto
    await expect.poll(async () => (await state()).step, { timeout: 5000 }).toBe(2);
    await p.goto(pathToFileURL(file).href + '#2');                // the deck autoplays; this slide does not
    await p.waitForFunction(() => !!(window as any).__present);
    await p.waitForTimeout(2500);
    expect((await state()).step).toBe(0);
    expect((await state()).mode).toBe('steps');
    await b.close();
  }, 30000);
});

describe('the reference deck still reads', () => {
  it('has nothing new to say about the example', () => {
    const d = compileDeck('examples/launch-story').diagnostics;
    expect(d.filter(x => x.severity === 'error')).toEqual([]);
    expect(readFileSync('examples/launch-story/deck.yaml', 'utf8')).toContain('slides');
  });
});
