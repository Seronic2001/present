import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileDeck } from '@present/core';
import { exportHtml, exportPdf, pngDiff, Renderer } from '@present/render';
import { EXAMPLE } from './helpers.ts';

const r = new Renderer(EXAMPLE);
beforeAll(() => r.open().then(() => undefined), 60000);
afterAll(() => r.close());
const shot = async (f: any) => (await r.frame(f)).png;

describe('frames are a pure function', () => {
  const frames = [
    { slide: 2, step: 1, t: 200 },         // mid build
    { slide: 2, step: 2, t: 500 },
    { slide: 3, step: 2, t: 3000 },        // mid loop, particle in flight
    { slide: 3, step: 2, spot: 'render', spotT: 500 },   // mid camera
    { slide: 5, step: 0, t: 700 },         // mid count
  ];
  for (const f of frames) {
    it(`reproduces ${JSON.stringify(f)} from any earlier state`, async () => {
      const a = await shot(f);
      await shot({ slide: f.slide, step: 0, t: 0 });      // jump backward
      await shot({ slide: 1 });                          // leave the slide
      const b = await shot(f);
      expect(a.equals(b)).toBe(true);
    });
  }
  it('mid-animation actually differs from rest', async () => {
    const d = await pngDiff(r.page!, await shot({ slide: 2, step: 1, t: 200 }), await shot({ slide: 2, step: 1 }));
    expect(d.count).toBeGreaterThan(100);
  });
});

describe('rest', () => {
  it('every slide rests as its finished drawing', async () => {
    const { deck } = compileDeck(EXAMPLE);
    for (let i = 1; i <= deck.slides.length; i++) {
      const rest = await shot({ slide: i });
      await r.page!.evaluate(n => (window as any).__present.player.pristine(n), i);
      const drawing = await r.page!.screenshot({ type: 'png' });
      expect((await pngDiff(r.page!, rest, drawing)).count, deck.slides[i - 1].id).toBe(0);
    }
  }, 60000);
  it('has no rendered problems', async () => {
    expect(await r.checkAll()).toEqual([]);
  }, 60000);
});

describe('golden images', () => {
  it('matches every step of the example deck', async () => {
    // Each OS rasterises text its own way, so goldens are per platform. One with none yet records them.
    const dir = resolve('tests/golden', process.platform), update = !!process.env.UPDATE_GOLDEN;
    mkdirSync(dir, { recursive: true });
    const { deck } = compileDeck(EXAMPLE);
    const failures: string[] = [];
    for (const [i, s] of deck.slides.entries()) {
      for (let st = 0; st < s.phases.length; st++) {
        const png = await shot({ slide: i + 1, step: st });
        const f = join(dir, `${s.id}-${st}.png`);
        if (update || !existsSync(f)) { writeFileSync(f, png); continue; }
        const d = await pngDiff(r.page!, png, readFileSync(f));
        if (d.count > 40) failures.push(`${s.id}-${st}: ${d.count}px`);
      }
    }
    expect(failures).toEqual([]);
  }, 60000);
});

describe('checks catch real problems', () => {
  it('reports overflow and overlap from the rendered page', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'present-bad-'));
    mkdirSync(join(dir, 'slides'));
    writeFileSync(join(dir, 'deck.yaml'), 'title: Bad\n');
    writeFileSync(join(dir, 'slides', 'a.slide'), `---\ntitle: Bad\nbrief: Bad\n---\n<Diagram viewBox="0 0 1600 600" alt="x"><Box id="b" x="10" y="10" w="100" h="60" title="A title far too long for this box" /><text x="300" y="100" class="big">Same place</text><text x="300" y="100" class="big">Same place</text><text x="500" y="300" class="sm" style="fill:var(--faint)">Faint words here</text></Diagram>\n`);
    const b = new Renderer(dir);
    const d = (await b.checkAll()).map(x => x.code);
    await b.close();
    expect(d).toEqual(expect.arrayContaining(['text-overflow', 'text-overlap', 'faint-text']));
  }, 60000);
});

describe('export', () => {
  it('runs offline from file://, with motion, keys, spotlight and overview', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'present-x-')), 'deck.html');
    const { bytes } = await exportHtml(EXAMPLE, out);
    expect(bytes).toBeLessThan(2.5e6);
    const browser = await chromium.launch({ channel: 'chrome' });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, offline: true, reducedMotion: 'no-preference' });
    const page = await ctx.newPage();
    const bad: string[] = [];
    page.on('pageerror', e => bad.push(e.message));
    page.on('console', m => { if (m.type() === 'error') bad.push(m.text()); });
    page.on('requestfailed', q => bad.push(q.url()));
    await page.goto(pathToFileURL(out).href + '#3?');
    await page.waitForFunction(() => !!(window as any).__present);
    const state = () => page.evaluate(() => (window as any).__present.state());
    expect((await state()).slide).toBe(3);
    expect(await page.evaluate(() => document.fonts.check('600 20px "Mona Sans"') && document.fonts.check('12px "Mona Sans Mono"'))).toBe(true);
    // autoplay walks the steps by itself
    await page.waitForFunction(() => (window as any).__present.state().step === 2, undefined, { timeout: 8000 });
    await page.keyboard.press('z');
    await page.waitForFunction(() => (window as any).__present.state().spot === 'render');
    await page.waitForTimeout(900);
    expect(await page.evaluate(() => document.querySelector<HTMLElement>('.p-body')!.style.transform)).toMatch(/scale/);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (window as any).__present.state().spot === null);
    await page.keyboard.press('ArrowRight');
    expect((await state()).slide).toBe(4);
    await page.keyboard.press('s');
    await page.keyboard.press('r');
    expect((await state()).step).toBe(0);
    await page.keyboard.press('ArrowRight');
    expect((await state()).step).toBe(1);
    await page.keyboard.press('ArrowLeft');
    expect((await state()).step).toBe(0);
    await page.keyboard.press('g');
    expect(await page.locator('.ui-ov-card').count()).toBe(6);
    await page.locator('.ui-ov-card').nth(1).click();
    expect((await state()).slide).toBe(2);
    await page.mouse.move(100, 100);
    await page.waitForTimeout(350);
    expect(await page.locator('.ui-bar.show').count()).toBe(1);
    expect(bad).toEqual([]);
    await browser.close();
  }, 60000);
  it('writes a PDF with one page per slide', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'present-p-')), 'deck.pdf');
    await exportPdf(EXAMPLE, out);
    expect(statSync(out).size).toBeGreaterThan(10000);
    expect(readFileSync(out).toString('latin1').match(/\/Type\s*\/Page[^s]/g)).toHaveLength(6);
  }, 60000);
});
