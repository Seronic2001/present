// Real playback in a real clock: dropped frames, spotlight, reduced motion, presenter view.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { exportHtml, exportPdf, Renderer } from '@present/render';

const fixture = 'fixtures/reference', example = 'examples/launch-story';
const tmp = mkdtempSync(join(tmpdir(), 'present-v-'));
const file = join(tmp, 'fixture.html');
await exportHtml(fixture, file);
const url = pathToFileURL(resolve(file)).href;
const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function fps(label: string, hash: string, ms: number, act?: (p: any) => Promise<void>) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'no-preference' });
  const p = await ctx.newPage();
  await p.goto(url + '?steps' + hash);
  await p.waitForFunction(() => !!(window as any).__present);
  await p.evaluate(() => {
    const w = window as any;
    w.__f = []; let last = performance.now();
    const go = (n: number) => { w.__f.push(n - last); last = n; requestAnimationFrame(go); };
    requestAnimationFrame(go);
  });
  if (act) await act(p);
  await p.waitForTimeout(ms);
  const f: number[] = (await p.evaluate(() => (window as any).__f)).slice(2);
  f.sort((a, b) => a - b);
  console.log(label, { frames: f.length, p50: +f[f.length >> 1].toFixed(1), p99: +f[Math.floor(f.length * .99)].toFixed(1), over33ms: f.filter(x => x > 33.4).length });
  await ctx.close();
}
const steps = (n: number) => async (p: any) => { for (let i = 0; i < n; i++) { await p.keyboard.press('ArrowRight'); await p.waitForTimeout(1500); } };
await fps('slide 9, all steps and loops', '#3', 9000, steps(4));
await fps('slide 3, whole-system loop', '#1', 8000, steps(3));

// reduced motion
{
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const p = await ctx.newPage();
  await p.goto(pathToFileURL(resolve(file)).href + '#1');
  await p.waitForFunction(() => !!(window as any).__present);
  console.log('reduced motion starts built:', await p.evaluate(() => { const s = (window as any).__present.state(); return s.step === s.steps; }), 'toast:', await p.locator('.ui-toast').textContent());
  await p.keyboard.press('m');
  await p.keyboard.press('r');
  console.log('M then R replays from intro:', await p.evaluate(() => (window as any).__present.state().step === 0));
  await ctx.close();
}

// presenter view, over file://
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const p = await ctx.newPage();
  const ex = join(tmp, 'ex.html');
  await exportHtml(example, ex);
  await p.goto(pathToFileURL(resolve(ex)).href + '?steps');
  await p.waitForFunction(() => !!(window as any).__present);
  const [pop] = await Promise.all([ctx.waitForEvent('page'), p.keyboard.press('p')]);
  await pop.waitForLoadState();
  await pop.waitForFunction(() => document.querySelector('#u-notes')?.textContent !== '');
  console.log('presenter notes:', await pop.locator('#u-notes').textContent());
  await pop.keyboard.press('ArrowRight');
  await p.waitForFunction(() => (window as any).__present.state().slide === 2);
  await pop.waitForFunction(() => document.querySelector('#u-slide')?.textContent?.startsWith('2 /'));
  console.log('presenter drives deck and follows:', await pop.locator('#u-slide').textContent());
  await pop.screenshot({ path: 'tests/.presenter.png' });
  await ctx.close();
}
await browser.close();

const r = new Renderer(fixture);
const spot = [[1500, 'a'], [2300, 'b'], [5000, 'c']] as const;
for (const [t, n] of spot) writeFileSync(`tests/.spot-${n}.png`, (await r.frame({ slide: 3, step: 4, spot: 's09-find', spotT: t })).png);
writeFileSync('tests/.film-3.png', await r.filmstrip(1, 2, 8));
await r.close();
await exportPdf(example, 'tests/.deck.pdf');
