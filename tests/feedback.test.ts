// What a first real deck asked for: formulas, sizing, fit checks, leaving, branching and the rest.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addFromLibrary, catalog, compileDeck, compileSlide, CUES, groupDiagnostics, listLibrary, patchPlan, readPlan, removeFromLibrary, reuseReport, savePlan, saveToLibrary, applyOps, findDecks, noteOutsideEdits, revisionOf, undo, upgradeDeck, DECK_FORMAT, LOOP, type Diagnostic } from '@present/core';
import { exportHtml, exportPdf, exportPptx, Renderer } from '@present/render';

const slide = (body: string, front = '') => `---\ntitle: T\nbrief: B\n${front}---\n${body}\n`;
const compile = (body: string, front = '') => compileSlide(slide(body, front), { id: 's' });
const codes = (d: Diagnostic[]) => d.map(x => x.code);

function deck(slides: Record<string, string>, meta = '') {
  const dir = mkdtempSync(join(tmpdir(), 'present-fb-'));
  mkdirSync(join(dir, 'slides'));
  for (const [id, src] of Object.entries(slides)) writeFileSync(join(dir, 'slides', `${id}.slide`), src);
  writeFileSync(join(dir, 'deck.yaml'), `title: Fb\n${meta}slides:\n${Object.keys(slides).map(id => `  - ${id}`).join('\n')}\n`);
  return dir;
}

describe('ending a show in a browser', () => {
  const dir = deck({ a: slide('<Text>x</Text>') });
  const file = join(dir, 'show.html');
  const open = async () => {
    const b = await chromium.launch({ headless: true, channel: 'chrome' }).catch(() => chromium.launch({ headless: true, channel: 'msedge' }));
    const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
    const p = await ctx.newPage();
    await p.goto(pathToFileURL(file).href);
    await p.waitForFunction(() => !!(window as any).__present);
    const [notes] = await Promise.all([ctx.waitForEvent('page'), p.keyboard.press('p')]);
    await notes.locator('#u-now .p-body').waitFor();     // it has heard from the deck
    return { b, p, notes };
  };
  beforeAll(() => exportHtml(dir, file).then(() => undefined), 30000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // The click closes the window it is in, sometimes before Playwright has finished the click.
  const endShow = (notes: any) => notes.getByRole('button', { name: 'End show' }).click().catch((e: Error) => {
    if (!/has been closed/.test(e.message)) throw e;
  });

  it('closes the presenter view and says so, though the browser keeps the tab open', async () => {
    const { b, p, notes } = await open();
    await notes.getByRole('button', { name: 'Black screen' }).click();
    await p.locator('.ui-black.open').waitFor({ state: 'attached' });
    await endShow(notes);
    await expect.poll(() => notes.isClosed()).toBe(true);
    await p.locator('.ui-toast.show', { hasText: 'Show ended' }).waitFor();
    expect(await p.locator('.ui-black.open').count()).toBe(0);
    await b.close();
  }, 30000);
  it('closes the presenter view when the deck has already gone', async () => {
    const { b, p, notes } = await open();
    await p.close();
    await endShow(notes);
    await expect.poll(() => notes.isClosed()).toBe(true);
    await b.close();
  }, 30000);
  it('can open the presenter view again afterwards', async () => {
    const { b, p, notes } = await open();
    await endShow(notes);
    await expect.poll(() => notes.isClosed()).toBe(true);
    const [again] = await Promise.all([p.context().waitForEvent('page'), p.keyboard.press('p')]);
    await again.locator('#u-now .p-body').waitFor();
    await b.close();
  }, 30000);
});

describe('meanings shown from the presenter view', () => {
  const dir = deck({ a: slide(String.raw`<Center><Text>Paths to the <Term def="The hash at the top.">root</Term>, odds <Math define="b: bits guessed">2^{-b}</Math></Text></Center>`) });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it('shows the room the meaning the presenter points at, and closes it after', async () => {
    const file = join(dir, 'show.html');
    await exportHtml(dir, file);
    const b = await chromium.launch({ headless: true, channel: 'chrome' }).catch(() => chromium.launch({ headless: true, channel: 'msedge' }));
    const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
    const p = await ctx.newPage();
    await p.goto(pathToFileURL(file).href);
    await p.waitForFunction(() => !!(window as any).__present);
    const [notes] = await Promise.all([ctx.waitForEvent('page'), p.keyboard.press('p')]);
    await notes.locator('#u-now [data-term="b"]').waitFor();
    await notes.waitForTimeout(600);
    await notes.locator('#u-now [data-term="b"]').hover();
    await expect.poll(() => p.locator('.ui-term.open').textContent()).toContain('bits guessed');   // the second term, found by its place
    await notes.locator('#u-now .p-term').hover();
    await expect.poll(() => p.locator('.ui-term.open').textContent()).toContain('The hash at the top.');
    await notes.mouse.move(2, 700);
    await expect.poll(() => p.locator('.ui-term.open').count()).toBe(0);
    await b.close();
  }, 40000);
});

describe('working a live slide from the presenter view', () => {
  const page = '<!doctype html><button id="roll" onclick="out.textContent=Math.floor(Math.random()*1e6)+\'-\'+crypto.getRandomValues(new Uint32Array(1))[0]">Roll</button><p id="out">start ' + "<script>first.textContent=Math.random()</script>".replace('first.textContent', 'document.title') + '</p>';
  const dir = deck({ a: slide('<Diagram viewBox="0 0 1600 500" alt="d"><Box id="b" x="100" y="100" w="400" h="200" title="Go live" goto="live"/></Diagram>'), live: slide('<Embed id="e" src="w.html" alt="Roll" h="400" />') });
  writeFileSync(join(dir, 'w.html'), page);
  const file = join(dir, 'show.html');
  const start = async () => {
    await exportHtml(dir, file);
    const b = await chromium.launch({ headless: true, channel: 'chrome' }).catch(() => chromium.launch({ headless: true, channel: 'msedge' }));
    const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
    const p = await ctx.newPage();
    await p.goto(pathToFileURL(file).href);
    await p.waitForFunction(() => !!(window as any).__present);
    const [notes] = await Promise.all([ctx.waitForEvent('page'), p.keyboard.press('p')]);
    await notes.locator('#u-now #b').waitFor({ state: 'attached' });
    return { b, p, notes };
  };
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('follows a goto clicked in the pane, then a click in either copy reaches both, with the same random result', async () => {
    const { b, p, notes } = await start();
    await p.waitForTimeout(800);                         // the words and the pane settle
    await notes.locator('#u-now #b text').click();
    await expect.poll(() => p.evaluate(() => (window as any).__present.state().id)).toBe('live');
    const stage = p.frameLocator('iframe.p-embed'), pane = notes.frameLocator('#u-now iframe');
    await stage.locator('#roll').waitFor();
    await pane.locator('#roll').waitFor();
    await notes.waitForTimeout(400);
    // A real mouse at the real spot: the pane is the slide scaled down, and that is the path a person takes.
    const box = (await notes.locator('#u-now iframe').boundingBox())!, k = box.width / 1768;
    await notes.mouse.click(box.x + 24 * k, box.y + 18 * k);   // the button, in the page's own coordinates
    await expect.poll(() => stage.locator('#out').textContent()).toMatch(/^\d+-\d+$/);
    const first = await stage.locator('#out').textContent();
    expect(await pane.locator('#out').textContent()).toBe(first);
    await p.bringToFront();                              // a page behind another gets no frames to click on
    await stage.locator('#roll').click();                // and back
    await expect.poll(() => pane.locator('#out').textContent()).not.toBe(first);
    expect(await pane.locator('#out').textContent()).toBe(await stage.locator('#out').textContent());
    await b.close();
  }, 40000);
  it('gives a replay fresh random numbers, in both copies', async () => {
    const { b, p, notes } = await start();
    await p.evaluate(() => (window as any).__present.player.go(1));
    const stage = p.frameLocator('iframe.p-embed'), pane = notes.frameLocator('#u-now iframe');
    const titles = async () => [await stage.locator('html').evaluate(() => document.title), await pane.locator('html').evaluate(() => document.title)];
    await expect.poll(async () => { const [x, y] = await titles().catch(() => ['a', 'b']); return x === y; }).toBe(true);
    const [one] = await titles();
    await notes.getByRole('button', { name: 'Replay' }).click();
    await expect.poll(async () => { const [x, y] = await titles().catch(() => ['a', 'b']); return x === y && x !== one; }).toBe(true);
    await b.close();
  }, 40000);
});

describe('the slide in the presenter view', () => {
  it('does what the slide does: next on a click, zooms a spot, and takes the same keys', async () => {
    const dir = deck({
      a: slide('<Diagram viewBox="0 0 1600 500" alt="d"><Box id="part" x="100" y="100" w="400" h="200" title="Zoom" spot=""/></Diagram><Text id="plain">Plain text</Text>'),
      b: slide('<Text id="two">Two</Text>'), c: slide('<Text id="three">Three</Text>'),
    });
    const file = join(dir, 'show.html');
    await exportHtml(dir, file);
    const b = await chromium.launch({ headless: true, channel: 'chrome' }).catch(() => chromium.launch({ headless: true, channel: 'msedge' }));
    const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
    const p = await ctx.newPage();
    await p.goto(pathToFileURL(file).href);
    await p.waitForFunction(() => !!(window as any).__present);
    const [notes] = await Promise.all([ctx.waitForEvent('page'), p.keyboard.press('p')]);
    await notes.locator('#u-now #part').waitFor({ state: 'attached' });
    await notes.waitForTimeout(800);
    const at = () => p.evaluate(() => (window as any).__present.state());
    const zoomed = () => notes.locator('#u-now .p-body').evaluate(e => (e as HTMLElement).style.transform !== '');
    await notes.locator('#u-now #part text').click();
    await expect.poll(async () => (await at()).spot).toBe('part');
    await expect.poll(zoomed).toBe(true);
    await notes.locator('#u-now #part text').click();    // a click closes it, as it does on the slide
    await expect.poll(async () => (await at()).spot).toBe(null);
    await expect.poll(zoomed).toBe(false);
    await notes.locator('#u-now #plain').click();
    await expect.poll(async () => (await at()).id).toBe('b');
    await notes.keyboard.press('End');
    await expect.poll(async () => (await at()).id).toBe('c');
    await notes.keyboard.press('Home');
    await expect.poll(async () => (await at()).id).toBe('a');
    await b.close();
    rmSync(dir, { recursive: true, force: true });
  }, 40000);
});

describe('click actions', () => {
  const body = '<Stack><Text id="ga" act="show-a">Show A</Text><Text id="gb" act="show-b">Show B</Text><Text id="pa" act="pick-a">Pick A</Text><Text id="pb" act="pick-b">Pick B</Text><Text id="flip" act="swap">Flip</Text><Text id="a">Part A</Text><Text id="b">Part B</Text><Text id="ca">Choice one</Text><Text id="cb" style="margin-top:-37px">Choice two</Text><Text id="f">Flipped</Text></Stack>';
  const front = 'score:\n  actions:\n    show-a:\n      cues:\n        - fade: a\n          dur: 100\n    show-b:\n      cues:\n        - fade: b\n          dur: 100\n    pick-a:\n      group: c\n      cues:\n        - fade: ca\n          dur: 100\n    pick-b:\n      group: c\n      cues:\n        - fade: cb\n          dur: 100\n    swap:\n      toggle: true\n      cues:\n        - fade: f\n          dur: 100\n';

  it('catches an action nothing clicks, a click with no action, and a part the steps also move', () => {
    expect(codes(compile('<Text id="a" act="nope">x</Text>').diagnostics)).toContain('unknown-action');
    expect(codes(compile('<Text id="a">x</Text>', 'score:\n  actions:\n    go:\n      - fade: a\n').diagnostics)).toContain('unused-action');
    expect(codes(compile('<Text id="a" act="go">x</Text>', 'score:\n  intro:\n    - rise: a\n  actions:\n    go:\n      - fade: a\n').diagnostics)).toContain('action-clash');
  });
  it('passes the checks as a finished drawing, and shows any state to an agent', async () => {
    const dir = deck({ main: slide(body, front) });
    const r = new Renderer(dir);
    expect(await r.checkAll()).toEqual([]);
    await r.seek({ slide: 1, actions: {} });
    const op = (id: string) => r.page!.evaluate(i => getComputedStyle(document.getElementById(i)!).opacity, id);
    expect(await op('a')).toBe('0');
    await r.seek({ slide: 1, actions: { 'show-b': 1e9 } });
    expect([await op('a'), await op('b')]).toEqual(['0', '1']);
    await r.seek({ slide: 1 });
    expect([await op('a'), await op('ca'), await op('cb')]).toEqual(['1', '1', '0']);   // later choices stay out of the drawing
    expect(await r.filmstrip(1, 0, 4, undefined, undefined, { action: 'show-a' })).toBeInstanceOf(Buffer);
    await expect(r.filmstrip(1, 0, 4, undefined, undefined, { action: 'nope' })).rejects.toThrow('No action');
    await r.close();
    rmSync(dir, { recursive: true, force: true });
  }, 40000);
  it('plays in any order on a click, picks one, toggles, stays on the slide, and matches in the presenter view', async () => {
    const dir = deck({ main: slide(body, front), z: slide('<Text>Next</Text>') });
    const file = join(dir, 'show.html');
    await exportHtml(dir, file);
    const b = await chromium.launch({ headless: true, channel: 'chrome' }).catch(() => chromium.launch({ headless: true, channel: 'msedge' }));
    const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
    const p = await ctx.newPage();
    await p.goto(`${pathToFileURL(file).href}?steps`);
    await p.waitForFunction(() => !!(window as any).__present);
    await p.waitForTimeout(300);
    const op = (id: string, on = p) => on.evaluate(i => Number(getComputedStyle(document.querySelector(i)!).opacity), id);
    const shows = (id: string, v: number, on = p) => expect.poll(() => op(id, on)).toBe(v);
    await shows('#a', 0);
    await p.locator('#gb').click();                     // out of order
    await shows('#b', 1);
    expect(await op('#a')).toBe(0);
    await p.locator('#ga').click();
    await shows('#a', 1);
    await p.locator('#pa').click();
    await shows('#ca', 1);
    await p.locator('#pb').click();                     // pick-one
    await shows('#cb', 1);
    await shows('#ca', 0);
    await p.locator('#flip').click();
    await shows('#f', 1);
    await p.locator('#flip').click();                   // toggle
    await shows('#f', 0);
    await p.locator('#gb').click();                     // once: a second click does nothing
    await p.waitForTimeout(200);
    expect(await op('#b')).toBe(1);
    expect(await p.evaluate(() => (window as any).__present.state().id)).toBe('main');
    const [notes] = await Promise.all([ctx.waitForEvent('page'), p.keyboard.press('p')]);
    await notes.locator('#u-now #a').waitFor({ state: 'attached' });
    await shows('#u-now #b', 1, notes);                  // joins in the same state
    await notes.locator('#u-now #flip').click();         // and drives it
    await shows('#f', 1);
    await shows('#u-now #f', 1, notes);
    await b.close();
    rmSync(dir, { recursive: true, force: true });
  }, 40000);
});

describe('the autoplay button', () => {
  it('says whether autoplay is on, and clicking it does what it says', async () => {
    const dir = deck({ a: slide('<Text id="x">One</Text>', 'score:\n  steps:\n    - cues:\n        - fade: x\n          dur: 100\n') });
    const file = join(dir, 'show.html');
    await exportHtml(dir, file);
    const b = await chromium.launch({ headless: true, channel: 'chrome' }).catch(() => chromium.launch({ headless: true, channel: 'msedge' }));
    const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
    const p = await ctx.newPage();
    await p.goto(pathToFileURL(file).href);
    await p.waitForFunction(() => !!(window as any).__present);
    const [notes] = await Promise.all([ctx.waitForEvent('page'), p.keyboard.press('p')]);
    const mode = notes.locator('#u-mode');
    await expect.poll(() => mode.textContent()).toBe('Autoplay: On');
    expect(await mode.getAttribute('aria-pressed')).toBe('true');
    await mode.click();
    await expect.poll(() => mode.textContent()).toBe('Autoplay: Off');
    expect(await mode.getAttribute('aria-pressed')).toBe('false');
    await b.close();
    rmSync(dir, { recursive: true, force: true });
  }, 30000);
});

describe('a deck behind the presenter view', () => {
  it('keeps autoplaying when its window gets no animation frames', async () => {
    const dir = deck({ a: slide('<Text id="x">One</Text><Text id="y">Two</Text>', 'score:\n  steps:\n    - cues:\n        - fade: x\n          dur: 100\n    - cues:\n        - fade: y\n          dur: 100\n') });
    const file = join(dir, 'show.html');
    await exportHtml(dir, file);
    const b = await chromium.launch({ headless: true, channel: 'chrome' }).catch(() => chromium.launch({ headless: true, channel: 'msedge' }));
    const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
    const p = await ctx.newPage();
    await p.goto(pathToFileURL(file).href);
    await p.waitForFunction(() => !!(window as any).__present);
    const [notes] = await Promise.all([ctx.waitForEvent('page'), p.keyboard.press('p')]);
    await notes.locator('#u-now #x').waitFor({ state: 'attached' });
    await p.evaluate(() => { window.requestAnimationFrame = () => 1; });   // what a covered window does
    await notes.getByRole('button', { name: 'Replay' }).click();
    await expect.poll(() => p.evaluate(() => (window as any).__present.state().step), { timeout: 6000 }).toBe(2);
    await expect.poll(() => notes.locator('#u-slide').textContent()).toContain('step 2/2');
    await b.close();
    rmSync(dir, { recursive: true, force: true });
  }, 30000);
  it('has a scrollbar that belongs to the dark view', async () => {
    const dir = deck({ a: slide('<Text>x</Text>', 'notes: |\n  ' + 'Long notes. '.repeat(400) + '\n') });
    const file = join(dir, 'show.html');
    await exportHtml(dir, file);
    const b = await chromium.launch({ headless: true, channel: 'chrome' }).catch(() => chromium.launch({ headless: true, channel: 'msedge' }));
    const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
    const p = await ctx.newPage();
    await p.goto(pathToFileURL(file).href);
    await p.waitForFunction(() => !!(window as any).__present);
    const [notes] = await Promise.all([ctx.waitForEvent('page'), p.keyboard.press('p')]);
    await notes.locator('#u-now #x, #u-now .p-body').first().waitFor({ state: 'attached' });
    const thumb = await notes.evaluate(() => getComputedStyle(document.getElementById('u-notes')!, '::-webkit-scrollbar-thumb').backgroundColor);
    await b.close();
    rmSync(dir, { recursive: true, force: true });
    expect(thumb).toBe('rgb(63, 63, 70)');
  }, 30000);
});

describe('the presenter view during a show', () => {
  it('shows a step animating, not only how it ends, and keeps up with autoplay', async () => {
    const dir = deck({ a: slide('<Text id="x">Moves</Text>', 'score:\n  intro:\n    - fade: x\n      dur: 2500\n') });
    const file = join(dir, 'show.html');
    await exportHtml(dir, file);
    const b = await chromium.launch({ headless: true, channel: 'chrome' }).catch(() => chromium.launch({ headless: true, channel: 'msedge' }));
    const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
    const p = await ctx.newPage();
    await p.goto(pathToFileURL(file).href);
    await p.waitForFunction(() => !!(window as any).__present);
    const [notes] = await Promise.all([ctx.waitForEvent('page'), p.keyboard.press('p')]);
    await notes.locator('#u-now #x').waitFor({ state: 'attached' });
    await notes.getByRole('button', { name: 'Replay' }).click();
    const seen = await notes.evaluate(() => new Promise<number[]>(done => {
      const out: number[] = [], t0 = performance.now();
      const look = () => {
        const el = document.querySelector('#u-now #x');
        if (el) out.push(parseFloat(getComputedStyle(el).opacity));
        if (performance.now() - t0 < 3200) requestAnimationFrame(look); else done(out);
      };
      look();
    }));
    await b.close();
    rmSync(dir, { recursive: true, force: true });
    expect(seen.some(o => o > .1 && o < .9)).toBe(true);  // caught part way
    expect(seen.at(-1)).toBe(1);                          // and it lands on the drawing
  }, 30000);
});

describe('compile', () => {
  it('typesets a formula to allowed markup, with no diagnostics', () => {
    const { slide: s, diagnostics } = compile(String.raw`<Text>Cost <Math>G_0 = \sqrt{\frac{a}{b}}</Math></Text>`);
    expect(diagnostics).toEqual([]);
    expect(s.html).toContain('class="katex"');
    expect(s.html).toContain('aria-label="G_0 = \\sqrt{\\frac{a}{b}}"');
  });
  it('reports LaTeX it cannot typeset', () => {
    expect(codes(compile(String.raw`<Text><Math>\frac{a</Math></Text>`).diagnostics)).toContain('bad-math');
  });
  it('marks the first use of each defined symbol, and says what it means', () => {
    const { slide: s, diagnostics } = compile(String.raw`<Text><Math define="b: bits the attacker guessed; \theta: the threshold">2^{-b} \lt \theta \cdot b</Math></Text>`);
    expect(diagnostics).toEqual([]);
    expect(s.html.match(/data-def=/g)?.length).toBe(2);           // b twice in the formula, marked once
    expect(s.html).toContain('data-term="b" data-def="bits the attacker guessed"');
    expect(s.html).toContain('data-term="\\theta"');
    expect(s.html).toContain('where b is bits the attacker guessed; \\theta is the threshold');
    expect(s.html).not.toContain('#cc0000');                      // typeset, not shown as an untrusted command
  });
  it('defines words with Term', () => {
    const { slide: s, diagnostics } = compile('<Text>A path to the <Term def="The one hash at the top &amp; centre.">Merkle root</Term>.</Text>');
    expect(diagnostics).toEqual([]);
    expect(s.html).toMatch(/<span class="p-term" data-def="The one hash at the top &amp; centre.">Merkle root<\/span>/);
  });
  it('keeps definitions deliberate', () => {
    expect(codes(compile(String.raw`<Text><Math define="z: absent">x</Math></Text>`).diagnostics)).toContain('bad-define');
    expect(codes(compile(String.raw`<Text><Math define="x">x</Math></Text>`).diagnostics)).toContain('bad-define');
    expect(codes(compile(String.raw`<Text><Math define="b: one">\beta</Math></Text>`).diagnostics)).toContain('bad-define');  // b is not in \beta
    expect(codes(compile('<Text><Term>x</Term></Text>').diagnostics)).toContain('bad-define');
    expect(codes(compile('<Text><Term def="a">x</Term> <Term def="b">x</Term></Text>').diagnostics)).toContain('term-repeated');
    expect(codes(compile(String.raw`<Text><Math define="a: 1; b: 2; c: 3; d: 4">a+b+c+d</Math></Text>`).diagnostics)).toContain('too-many-terms');
    expect(codes(compile(`<Text><Term def="${'long '.repeat(40)}">x</Term></Text>`).diagnostics)).toContain('term-long');
  });
  it('keeps a formula in a header whole, and rising with the words', () => {
    const { html, phases } = compile(String.raw`<Header>Bound <Math>x^2</Math></Header>`).slide;
    expect(html).toMatch(/class="p-math w"/);
    expect(phases[0].tracks.length).toBe(2);
  });
  it('makes fill and font attributes on text work, by moving them to style', () => {
    const { html } = compile('<Diagram viewBox="0 0 100 100" alt="a"><text x="1" y="9" fill="var(--danger)" font-family="serif" font-size="30" style="opacity:.5">Hi</text></Diagram>').slide;
    expect(html).toContain('style="fill:var(--danger);font-family:serif;font-size:30px;opacity:.5"');
    expect(html).not.toMatch(/<text[^>]* fill=/);
  });
  it('warns when a group attribute cannot reach its text', () => {
    expect(codes(compile('<Diagram viewBox="0 0 100 100" alt="a"><g fill="red"><text x="1" y="9">Hi</text></g></Diagram>').diagnostics)).toContain('style-ignored');
    expect(codes(compile('<Diagram viewBox="0 0 100 100" alt="a"><g fill="red"><rect width="9" height="9"/></g></Diagram>').diagnostics)).not.toContain('style-ignored');
  });
  it('sizes Box, Chip and Milestones, and leaves their defaults alone', () => {
    const big = compile('<Diagram viewBox="0 0 900 600" alt="a"><Box id="b" x="0" y="0" w="300" h="99" title="T" sub="S" size="30"/><Chip x="0" y="200" size="20">C</Chip><Milestones x="0" y="300" w="900" h="300" items="A|b" size="30"/></Diagram>');
    expect(big.diagnostics).toEqual([]);
    expect(big.slide.html).toContain('font-size:30px');
    expect(big.slide.html).toContain('font-size:20px');
    const plain = compile('<Diagram viewBox="0 0 900 600" alt="a"><Box id="b" x="0" y="0" w="300" h="99" title="T"/></Diagram>').slide.html;
    expect(plain).not.toContain('font-size');
  });
  it('gives data colours a box tone and no raw colour warning', () => {
    const r = compile('<Diagram viewBox="0 0 900 600" alt="a"><Box id="b" x="0" y="0" w="300" h="99" tone="data-2"/><circle r="9" style="fill:var(--data-1)"/></Diagram>');
    expect(r.diagnostics).toEqual([]);
    expect(r.slide.html).toContain('--tone:var(--data-2)');
  });
  it('allows only the sandboxed frame an Embed makes', () => {
    expect(codes(compile('<iframe src="https://example.com"></iframe>').diagnostics)).toContain('disallowed-tag');
    expect(codes(compile('<iframe srcdoc="x"></iframe>').diagnostics)).toContain('disallowed-tag');
    expect(codes(compile('<Embed src="a.html" />').diagnostics)).toContain('missing-alt');
  });
  it('marks a part that ends gone, but not one that comes back', () => {
    const body = '<Text id="a">A</Text>';
    const gone = compile(body, 'score:\n  steps:\n    - cues:\n        - leave: a\n').slide;
    expect(gone.html).toContain('data-leaves');
    const back = compile(body, 'score:\n  steps:\n    - cues:\n        - leave: a\n    - cues:\n        - fade: a\n').slide;
    expect(back.html).not.toContain('data-leaves');
  });
  it('rejects leave in a loop, which would not come back', () => {
    expect(codes(compile('<Text id="a">A</Text>', 'score:\n  intro:\n    loop:\n      cues:\n        - leave: a\n').diagnostics)).toContain('loop-not-signal');
  });
});

describe('grouping', () => {
  it('reports the same finding once, with where it occurs', () => {
    const d = (slide: string, id?: string): Diagnostic => ({ code: 'raw-colour', severity: 'warning', slide, id, message: 'Raw colour', fix: 'f' });
    const { warnings, groups } = groupDiagnostics([d('a', 'x'), d('b', 'y'), d('b', 'y'), { ...d('c'), severity: 'error', code: 'other' }]);
    expect(warnings).toBe(3);
    expect(groups).toHaveLength(2);
    expect(groups[0].code).toBe('other');
    expect(groups[1]).toMatchObject({ count: 3, slides: ['a', 'b'], ids: ['x', 'y'] });
  });
});

describe('catalog', () => {
  it('documents the macro file format, tokens and interaction', () => {
    const c = catalog(CUES);
    expect(c.writingMacros).toContain('macros/Triangle.ts');
    expect(c.writingMacros).toContain('export default');
    expect(c.tokens).toContain('data-1');
    expect(c.macros.map(m => m.name)).toEqual(expect.arrayContaining(['Math', 'TextBlock', 'Embed']));
    expect(c.cues.map(x => x.name)).toContain('leave');
  });
});

describe('what a deck could give the library', () => {
  const graph = (label: string, x: number) => `<Diagram viewBox="0 0 900 500" alt="g"><g><circle cx="${x}" cy="9" r="9"/><circle cx="20" cy="9" r="9"/><circle cx="40" cy="9" r="9"/><path d="M 0 0 L 9 9"/><path d="M 1 1 L 9 9"/><text x="9" y="30">${label}</text></g></Diagram>`;
  const beat = 'score:\n  steps:\n    - cues:\n        - draw: a\n        - pop: a\n        - fade: a\n';
  const mark = '<Text id="a">x</Text>';

  it('finds one drawing on two slides, whatever its labels and numbers', () => {
    const dir = deck({ a: slide(graph('One', 10)), b: slide(graph('Two', 99)), c: slide('<Text>other</Text>') });
    const { macroCandidates, phraseCandidates } = reuseReport(dir);
    expect(macroCandidates).toHaveLength(1);                 // the whole drawing, not each piece of it too
    expect(macroCandidates[0].slides).toEqual(['a', 'b']);
    expect(phraseCandidates).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
  it('leaves alone a drawing on one slide, and a plain list of one tag', () => {
    const rows = Array.from({ length: 8 }, (_, i) => `<text y="${i}">r</text>`).join('');
    const dir = deck({ a: slide(graph('One', 10)), b: slide(`<Diagram viewBox="0 0 9 9" alt="r">${rows}</Diagram>`), c: slide(`<Diagram viewBox="0 0 9 9" alt="r">${rows}</Diagram>`) });
    expect(reuseReport(dir).macroCandidates).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
  it('finds a beat written out on three slides', () => {
    const dir = deck({ a: slide(mark, beat), b: slide(mark, beat), c: slide(mark, beat) });
    expect(reuseReport(dir).phraseCandidates).toEqual([expect.objectContaining({ cues: 'draw + pop + fade', slides: ['a', 'b', 'c'] })]);
    rmSync(dir, { recursive: true, force: true });
  });
  it('says when a whole deck has saved nothing, until it has', () => {
    const dir = deck(Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(k => [k, slide('<Text>x</Text>')])));
    expect(reuseReport(dir).nothingSaved).toContain('library_save');
    saveToLibrary(dir, { name: 'fb-saved', doc: 'd', slide: 'a' });
    expect(reuseReport(dir).nothingSaved).toBeUndefined();
    expect(reuseReport(dir).saved).toEqual(['fb-saved']);
    removeFromLibrary('fb-saved');
    rmSync(dir, { recursive: true, force: true });
  });
  it('stays quiet in a deck that opted out', () => {
    const dir = deck(Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(k => [k, slide(graph('x', 1))])), 'library: false\n');
    const r = reuseReport(dir);
    expect([r.macroCandidates, r.nothingSaved]).toEqual([[], undefined]);
    rmSync(dir, { recursive: true, force: true });
  });
  it('keeps a slide\'s animation through the library', () => {
    const from = deck({ a: slide(mark, beat) }), to = deck({ b: slide('<Text>y</Text>') });
    saveToLibrary(from, { name: 'fb-score', doc: 'd', slide: 'a' });
    expect(listLibrary().find(i => i.name === 'fb-score')?.slide).toBe(true);
    const { slide: src } = addFromLibrary(to, 'fb-score');
    const { slide: s, diagnostics } = compileSlide(src!, { id: 'c' });
    expect(diagnostics).toEqual([]);
    expect(s.phases[1].tracks.map(t => t.k)).toEqual(['draw', 'pop', 'fade']);
    removeFromLibrary('fb-score');
    rmSync(from, { recursive: true, force: true });
    rmSync(to, { recursive: true, force: true });
  });
});

describe('plan patches', () => {
  const dir = deck({ a: slide('<Text>x</Text>') });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const start = () => savePlan(dir, { goal: 'G', slides: [{ id: 'a', title: 'A', claim: 'x', visual: 'keep' }, { id: 'b', title: 'B', claim: 'y' }] });

  it('merges by field, and adds, moves and removes slides', () => {
    start();
    expect(patchPlan(dir, { minutes: 20, slides: [{ id: 'a', claim: 'new' }, { id: 'c', title: 'C', claim: 'z', after: 'a' }], remove: ['b'] }).ok).toBe(true);
    const p = readPlan(dir)!;
    expect(p.minutes).toBe(20);
    expect(p.goal).toBe('G');
    expect(p.slides.map(s => s.id)).toEqual(['a', 'c']);
    expect(p.slides[0]).toMatchObject({ claim: 'new', visual: 'keep' });
    patchPlan(dir, { slides: [{ id: 'a', after: 'c' }] });
    expect(readPlan(dir)!.slides.map(s => s.id)).toEqual(['c', 'a']);
  });
  it('refuses what it cannot do', () => {
    start();
    expect(() => patchPlan(dir, { remove: ['nope'] })).toThrow('No planned slide');
    expect(() => patchPlan(dir, { slides: [{ id: 'new' }] })).toThrow('needs a title');
  });
});

describe('a deck written by an older version, or by hand', () => {
  const S = String.fromCharCode(92);
  it('flags formulas built from tspans and Unicode, but not line breaks or units', () => {
    const d = (b: string) => compile('<Diagram viewBox="0 0 9 9" alt="a">' + b + '</Diagram>').diagnostics;
    expect(codes(d('<text x="1" y="1">G<tspan dy="4">0</tspan></text>'))).toContain('hand-built-math');
    expect(codes(d('<text x="1" y="1">G₀</text>'))).toContain('hand-built-math');
    expect(codes(d('<text x="1" y="1">One<tspan x="1" dy="9">Two</tspan></text><text y="9">5 km² and CO2</text>'))).toEqual([]);
  });
  it('flags words set as maths, but not variables or commands', () => {
    const w = (tex: string) => codes(compile('<Text><Math tex="' + tex + '"/></Text>').diagnostics);
    expect(w('x in S')).toContain('math-word');
    expect(w('for all x')).toContain('math-word');
    expect(w('x ' + S + 'in S ' + S + 'text{ for all } E = mc^2 + xy')).toEqual([]);
  });
  it('upgrades a dry run writing nothing, then with its old files kept', () => {
    const dir = deck({ a: slide('<Diagram viewBox="0 0 9 9" alt="a"><text y="1">G<tspan dy="4">0</tspan></text></Diagram>') });
    writeFileSync(join(dir, 'AGENTS.md'), 'old advice');
    const dry = upgradeDeck(dir, { dryRun: true });
    expect(dry.changes.map(c => c.file)).toEqual(['deck.yaml', 'AGENTS.md']);
    expect(dry.manual).toHaveLength(1);
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('old advice');
    const done = upgradeDeck(dir);
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe(LOOP);
    expect(readFileSync(join(dir, done.backup!, 'AGENTS.md'), 'utf8')).toBe('old advice');
    expect(readFileSync(join(dir, 'deck.yaml'), 'utf8')).toContain('format: ' + DECK_FORMAT);
    expect(upgradeDeck(dir, { dryRun: true }).changes).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
  it('makes an outside edit a step that undo reverses, and keeps the steps apart', () => {
    const dir = deck({ a: slide('<Text id="t">one</Text>') });
    const file = join(dir, 'slides', 'a.slide'), body = () => readFileSync(file, 'utf8');
    expect(noteOutsideEdits(dir)).toBe(false);          // the first look only sets the baseline
    expect(applyOps(dir, [{ op: 'setText', slide: 'a', id: 't', text: 'two' }], revisionOf(dir)).ok).toBe(true);
    expect(noteOutsideEdits(dir)).toBe(false);          // the tools' own write is not an outside edit
    writeFileSync(file, body().replace('two', 'three'));
    writeFileSync(join(dir, 'slides', 'b.slide'), slide('<Text>new</Text>'));
    expect(undo(dir).ok).toBe(true);                    // it notices by itself
    expect(body()).toContain('two');
    expect(existsSync(join(dir, 'slides', 'b.slide'))).toBe(false);
    expect(undo(dir).ok).toBe(true);
    expect(body()).toContain('one');
    expect(undo(dir).ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
  it('finds decks under a folder and above it, and skips what is not a project', () => {
    const top = mkdtempSync(join(tmpdir(), 'present-find-'));
    const inner = join(top, 'talks', 'course'), hidden = join(top, 'node_modules', 'x');
    mkdirSync(join(inner, 'slides'), { recursive: true });
    mkdirSync(hidden, { recursive: true });
    writeFileSync(join(inner, 'deck.yaml'), 'title: x\n');
    writeFileSync(join(hidden, 'deck.yaml'), 'title: x\n');
    expect(findDecks(top)).toEqual([inner]);
    expect(findDecks(join(inner, 'slides'))).toEqual([inner]);
    rmSync(top, { recursive: true, force: true });
  });
});

describe('a TextBlock in place of <text>', () => {
  const place = (a: string) => compile('<Diagram viewBox="0 0 900 500" alt="a"><TextBlock ' + a + '>x</TextBlock></Diagram>');
  it('takes an anchor, and needs no width on one line', () => {
    const r = place('id="t" x="400" y="50" anchor="middle" nowrap=""');
    expect(r.diagnostics).toEqual([]);
    expect(r.slide.html).toContain('x="-400"');
    expect(r.slide.html).toContain('text-align:center');
    expect(r.slide.html).toContain('white-space:nowrap');
  });
  it('sizes to its content with no w, matching <text> at each anchor', async () => {
    const row = (anchor: string, x: number, y: number) => `<text id="t-${anchor}" x="${x}" y="${y}" text-anchor="${anchor}" style="font-size:30px">Same words here</text><TextBlock id="b-${anchor}" x="${x}" y="${y + 50}" size="30" anchor="${anchor}" baseline="">Same words here</TextBlock>`;
    const dir = deck({ a: slide(`<Diagram viewBox="0 0 1600 500" alt="a">${row('start', 40, 60)}${row('middle', 800, 200)}${row('end', 1560, 340)}</Diagram>`) });
    const r = new Renderer(dir);
    await r.seek({ slide: 1 });
    const edges = await r.page!.evaluate(() => ['start', 'middle', 'end'].map(k => {
      const t = document.getElementById(`t-${k}`)!.getBoundingClientRect(), b = document.querySelector(`#b-${k} .p-textblock`)!.getBoundingClientRect();
      return [Math.abs(t.left - b.left), Math.abs(t.right - b.right)];
    }));
    const found = await r.checkAll();
    await r.close();
    rmSync(dir, { recursive: true, force: true });
    for (const e of edges.flat()) expect(e).toBeLessThan(2);
    expect(found).toEqual([]);                          // a wide frame must not read as text leaving the slide
  }, 30000);
  it('sits on the same baseline as the <text> it replaces', async () => {
    const dir = deck({ a: slide('<Diagram viewBox="0 0 1600 500" alt="a"><text id="old" x="100" y="200" style="font-size:40px">Hxg</text><TextBlock id="new" x="600" y="200" size="40" baseline="" nowrap=""><span id="ink">Hxg</span></TextBlock></Diagram>') });
    const r = new Renderer(dir);
    await r.seek({ slide: 1 });
    const gap = await r.page!.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('ink')!);
      return Math.abs(document.getElementById('old')!.getBoundingClientRect().top - range.getBoundingClientRect().top);
    });
    await r.close();
    rmSync(dir, { recursive: true, force: true });
    expect(gap).toBeLessThan(1.5);
  }, 30000);
});

describe('seeing the whole deck', () => {
  it('shows every slide, then only what changed', async () => {
    const dir = deck({ a: slide('<Text id="t">one</Text>'), b: slide('<Text>two</Text>') });
    const r = new Renderer(dir);
    const first = await r.contactSheet();
    expect(first.shown).toEqual(['a', 'b']);
    expect(first.png).not.toBeNull();
    expect((await r.contactSheet({ changed: true })).png).toBeNull();
    applyOps(dir, [{ op: 'setText', slide: 'a', id: 't', text: 'three' }], revisionOf(dir));
    expect((await r.contactSheet({ changed: true })).shown).toEqual(['a']);
    await r.close();
    rmSync(dir, { recursive: true, force: true });
  }, 30000);
});

describe('text against the edge of its card', () => {
  it('catches a label at the top of a card', async () => {
    const dir = deck({ a: slide('<Diagram viewBox="0 0 1600 500" alt="d"><Box id="b" x="20" y="60" w="600" h="200"/><text x="60" y="76" style="font-size:24px">Close</text><text x="60" y="160" style="font-size:24px">Clear</text></Diagram>') });
    const r = new Renderer(dir);
    const tight = (await r.checkAll()).filter(d => d.code === 'text-tight');
    await r.close();
    rmSync(dir, { recursive: true, force: true });
    expect(tight.map(d => d.message)).toEqual([expect.stringContaining('Close')]);
  }, 30000);
});

describe('formulas on a real slide', () => {
  const S = String.fromCharCode(92);
  const dir = deck({ a: slide(`<Stack><Math id="block" display="true">|E| = ${S}frac{a}{b}</Math><Math id="bare">|E|</Math><Math id="set" display="true" size="60">x</Math><Text id="line">Before <Math id="held" display="true">|E|</Math> after <Math id="flow">y</Math></Text></Stack>`) });
  const r = new Renderer(dir);
  beforeAll(() => r.seek({ slide: 1 }), 30000);
  afterAll(async () => { await r.close(); rmSync(dir, { recursive: true, force: true }); });
  const size = (id: string) => r.page!.evaluate(i => getComputedStyle(document.getElementById(i)!).fontSize, id);

  it('sizes a formula for the room, however it is placed', async () => {
    expect(await size('block')).toBe('40px');
    expect(await size('bare')).toBe('26px');
    expect(await size('set')).toBe('60px');
    expect(await size('flow')).toBe('26px');        // from the Text around it
  });
  it('keeps a display formula inside its paragraph', async () => {
    expect(await r.page!.evaluate(() => document.getElementById('held')!.parentElement!.id)).toBe('line');
  });
  it('takes screenshots with neutral text, so colour can be judged', async () => {
    const png = await r.page!.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 960, height: 540 } });
    const tinted = await r.page!.evaluate(async b64 => {
      const i = new Image(); i.src = `data:image/png;base64,${b64}`; await i.decode();
      const c = document.createElement('canvas'); c.width = i.width; c.height = i.height;
      const g = c.getContext('2d')!; g.drawImage(i, 0, 0);
      const d = g.getImageData(0, 0, i.width, i.height).data;
      let n = 0;
      for (let k = 0; k < d.length; k += 4) if (Math.max(d[k], d[k + 1], d[k + 2]) - Math.min(d[k], d[k + 1], d[k + 2]) > 24) n++;
      return n;
    }, png.toString('base64'));
    expect(tinted).toBe(0);
  });
  it('points a raw colour at the data tokens', () => {
    const d = compile('<Diagram viewBox="0 0 9 9" alt="a"><circle r="4" fill="#123456"/></Diagram>').diagnostics.find(x => x.code === 'raw-colour');
    expect(d?.fix).toContain('--data-1');
  });
});

describe('in a browser', () => {
  const page = String.raw`<!doctype html><button id="b" onclick="document.body.dataset.hit=1">Pick</button>`;
  const dir = deck({
    math: slide(String.raw`<Header>Bound <Math>G_0</Math></Header>
<Text>Inline <Math>\sum_{i=1}^{n} x_i^2 \le \sqrt{n}</Math> text.</Text>
<Math display="" size="60">\frac{a}{b}</Math>
<Diagram viewBox="0 0 1600 300" alt="d"><Math id="dm" x="800" y="100" anchor="middle" size="48">E = mc^2</Math></Diagram>`),
    wrap: slide('<Diagram viewBox="0 0 1600 500" alt="d"><TextBlock id="tb" x="40" y="20" w="300" size="26">One two three four five six seven eight nine ten eleven twelve</TextBlock><TextBlock id="over" x="500" y="20" w="200" h="40" size="26">This will not fit in forty units of height at all</TextBlock></Diagram>'),
    fit: slide(`<Diagram viewBox="0 0 1600 500" alt="d">
<Box id="fits" x="20" y="20" w="600" h="120"/><text x="320" y="90" text-anchor="middle" style="font-size:24px">Short</text>
<Box id="tight" x="20" y="200" w="300" h="120"/><text x="170" y="270" text-anchor="middle" textLength="296" style="font-size:30px">any efficient cheat</text>
<Card id="card" x="700" y="20" w="500" h="200" label="Label here"/><text x="728" y="92" style="font-size:24px">Crowding it</text>
</Diagram>`),
    swap: slide('<Stack><Text id="first">Shown first</Text></Stack>', 'score:\n  steps:\n    - cues:\n        - leave: first\n        - fade: second\n          at: 300\n') .replace('<Stack>', '<Stack>').replace('</Stack>', '<Text id="second" style="margin-top:-37px">Then this</Text></Stack>'),
    pin: slide('<Header>Pinned</Header>'),
    mid: slide('<Header>Centred</Header>', 'align: center\n'),
    pick: slide('<Diagram viewBox="0 0 1600 500" alt="d"><Box id="edge" x="100" y="100" w="400" h="200" title="Edge" goto="pin"/></Diagram><Text id="plain" goto="mid">Or here</Text>'),
    embed: slide('<Embed id="e" src="widgets/pick.html" alt="Pick one" h="300" />'),
  }, 'align: top\n');
  mkdirSync(join(dir, 'widgets'));
  writeFileSync(join(dir, 'widgets', 'pick.html'), page);
  const r = new Renderer(dir);
  const check = (id: string, all: Diagnostic[]) => all.filter(d => d.slide === id);
  let all: Diagnostic[] = [];
  beforeAll(async () => { all = await r.checkAll(); }, 120000);
  afterAll(async () => { await r.close(); rmSync(dir, { recursive: true, force: true }); });

  it('renders formulas in KaTeX fonts, with no false alarms from stacked glyphs', async () => {
    expect(check('math', all)).toEqual([]);
    await r.seek({ slide: 1 });
    const font = await r.page!.evaluate(() => ({ family: getComputedStyle(document.querySelector('.mathnormal')!).fontFamily, loaded: document.fonts.check('20px KaTeX_Main') }));
    expect(font.family).toContain('KaTeX');
    expect(font.loaded).toBe(true);
  });
  it('wraps a TextBlock, and reports one that overflows its height', async () => {
    await r.seek({ slide: 2 });
    const h = await r.page!.evaluate(() => document.querySelector('#tb .p-textblock')!.getBoundingClientRect().height);
    expect(h).toBeGreaterThan(100);
    expect(check('wrap', all).map(d => [d.code, d.id])).toEqual([['text-overflow', 'over']]);
  });
  it('checks text drawn over a box or card against it', () => {
    const d = check('fit', all);
    expect(d.filter(x => x.code === 'text-tight').map(x => x.message)).toEqual([expect.stringContaining('any efficient')]);
    expect(codes(d)).toContain('text-crowded');
    expect(d.some(x => x.message.includes('Short'))).toBe(false);
  });
  it('shows a part, then takes it away and keeps it gone', async () => {
    expect(check('swap', all)).toEqual([]);
    const seen = async (step: number, t?: number) => { await r.seek({ slide: 4, step, t }); return r.page!.evaluate(() => getComputedStyle(document.getElementById('first')!).visibility); };
    expect(await seen(0)).toBe('visible');
    expect(await seen(1)).toBe('hidden');
    expect(await seen(0)).toBe('visible');          // going back restores it
  });
  it('pins the header on every slide but one that opts out', async () => {
    const top = async (slide: number) => { await r.seek({ slide }); return r.page!.evaluate(() => document.querySelector('.p-header')!.getBoundingClientRect().top); };
    expect(await top(5)).toBeLessThan(80);
    expect(await top(6)).toBeGreaterThan(300);
  });
  it('jumps on a click, then returns to the path', async () => {
    const file = join(dir, 'out', 'nested', 'deck.html');
    await exportHtml(dir, file);                    // and creates the folder
    const b = await chromium.launch({ headless: true, channel: 'chrome' }).catch(() => chromium.launch({ headless: true, channel: 'msedge' }));
    const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
    await p.goto(`${pathToFileURL(file).href}?steps#7`);
    await p.waitForFunction(() => !!(window as any).__present);
    expect(await p.evaluate(() => (window as any).__present.state().id)).toBe('pick');
    await p.click('#plain');
    expect(await p.evaluate(() => (window as any).__present.state().id)).toBe('mid');
    await b.close();
    expect(codes(compileDeck(dir).diagnostics)).not.toContain('bad-goto');
  }, 30000);
  it('reports a goto that leads nowhere', () => {
    const bad = deck({ a: slide('<Text goto="nope">x</Text>') });
    expect(codes(compileDeck(bad).diagnostics)).toContain('bad-goto');
    rmSync(bad, { recursive: true, force: true });
  });
  it('embeds a page that runs in a sandbox, and still passes keys to the deck', async () => {
    expect(check('embed', all)).toEqual([]);
    const file = join(dir, 'out', 'embed.html');
    await exportHtml(dir, file);
    const b = await chromium.launch({ headless: true, channel: 'chrome' }).catch(() => chromium.launch({ headless: true, channel: 'msedge' }));
    const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
    await p.goto(`${pathToFileURL(file).href}#8`);
    await p.waitForFunction(() => !!(window as any).__present);
    const frame = p.frameLocator('iframe.p-embed');
    await frame.locator('#b').waitFor();
    await p.waitForTimeout(300);                     // a new sandboxed frame takes no input for its first moments
    await frame.locator('#b').click();
    await expect.poll(() => frame.locator('body').getAttribute('data-hit')).toBe('1');
    expect(await p.evaluate(() => { try { return !!document.querySelector('iframe')!.contentDocument; } catch { return false; } })).toBe(false);
    await frame.locator('body').press('ArrowLeft');  // focus is in the page; the deck still moves
    await p.waitForFunction(() => (window as any).__present.state().id === 'pick');
    await b.close();
  }, 30000);
  it('reports an embed that is missing, or outside the deck', () => {
    const bad = deck({ a: slide('<Embed src="../secret.html" alt="x" />') });
    expect(codes(compileDeck(bad).diagnostics)).toContain('bad-embed');
    rmSync(bad, { recursive: true, force: true });
  });
  it('picks up a macro edit without a slide edit', async () => {
    const m = deck({ a: slide('<Text>x</Text><Note />') });
    mkdirSync(join(m, 'macros'));
    const write = (t: string) => writeFileSync(join(m, 'macros', 'Note.mjs'), `export default { doc: 'd', props: '', example: '', html: () => '<p class="n">${t}</p>' };`);
    write('one');
    const rr = new Renderer(m);
    await rr.seek({ slide: 1 });
    expect(await rr.page!.textContent('.n')).toBe('one');
    await new Promise(f => setTimeout(f, 20));
    write('two');
    await rr.seek({ slide: 1 });
    expect(await rr.page!.textContent('.n')).toBe('two');
    await rr.close();
    rmSync(m, { recursive: true, force: true });
  }, 30000);
  it('films one region, in larger frames', async () => {
    const size = (b: Buffer) => [b.readUInt32BE(16), b.readUInt32BE(20)];
    await r.open();
    const four = await r.filmstrip(1, 0, 4, 400);
    const two = await r.filmstrip(1, 0, 4, 400, undefined, { columns: 2 });
    expect(size(two)[1]).toBeGreaterThan(size(four)[1] * 1.8);
    const crop = await r.filmstrip(1, 0, 4, 400, undefined, { columns: 2, region: { x: 0, y: 0, w: 960, h: 270 } });
    expect(size(crop)[1]).toBeLessThan(size(two)[1]);
  }, 60000);
  it('exports PDF per step, without spoiling a build, into a new folder', async () => {
    const one = join(dir, 'pdf', 'a', 'deck.pdf'), each = join(dir, 'pdf', 'b', 'deck.pdf');
    await exportPdf(dir, one);
    await exportPdf(dir, each, true);
    const pages = (f: string) => (readFileSync(f, 'latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pages(one)).toBe(8);
    expect(pages(each)).toBe(9);                    // swap has two
  }, 60000);
  it('exports PPTX with a picture per slide and its notes', async () => {
    const out = join(dir, 'ppt', 'deck.pptx');
    const notes = deck({ a: slide('<Text>x</Text>', 'notes: Say this\n') });
    await exportPptx(notes, out);
    expect(existsSync(out)).toBe(true);
    const zip = readFileSync(out).toString('latin1');
    expect(zip).toContain('ppt/slides/slide1.xml');
    expect(zip).toContain('ppt/notesSlides/notesSlide1.xml');
    expect(zip).toContain('ppt/media/');
    rmSync(notes, { recursive: true, force: true });
  }, 60000);
});
