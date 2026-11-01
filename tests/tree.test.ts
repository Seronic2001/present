import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportHtml } from '@present/render';
import { EXAMPLE, tempDeck } from './helpers.ts';

// The example, as a tree: 1, 2 (2.1, 2.2 (2.2.1)), 3
const TREE = 'title: T\nmode: steps\nslides:\n  - 01-title\n  - id: 02-why-it-fails\n    deep:\n      - 03-the-loop\n      - id: 04-a-frame\n        deep:\n          - 05-results\n  - 06-close\n';

describe('presenting a tree', () => {
  const t = tempDeck(), out = mkdtempSync(join(tmpdir(), 'present-tree-'));
  let browser: Browser, p: Page;
  const here = () => p.evaluate(() => { const s = (window as any).__present.state(); return s.label as string; });
  const press = async (...keys: string[]) => { for (const k of keys) { await p.keyboard.press(k); await p.waitForTimeout(40); } };
  const go = async (no: number) => { await p.evaluate(n => (window as any).__present.player.show(n, { instant: true }), no); };
  const finish = () => p.evaluate(() => { const P = (window as any).__present.player; return { step: P.phase, last: P.phase === P.order[P.idx].phases.length - 1 }; });

  beforeAll(async () => {
    writeFileSync(join(t.dir, 'deck.yaml'), TREE);
    await exportHtml(t.dir, join(out, 'tree.html'));
    await exportHtml(EXAMPLE, join(out, 'flat.html'));
    browser = await chromium.launch({ channel: 'chrome' });
    p = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    await p.goto(pathToFileURL(join(out, 'tree.html')).href);
    await p.waitForFunction(() => !!(window as any).__present);
  }, 60000);
  afterAll(async () => { await browser?.close(); t.done(); rmSync(out, { recursive: true, force: true }); });

  it('stays on the main path unless told otherwise', async () => {
    await go(0);
    await p.evaluate(() => { const P = (window as any).__present.player; P.mode = 'auto'; });   // one press, one slide
    await press('ArrowRight');
    expect(await here()).toBe('2');
    await press('ArrowRight');
    expect(await here()).toBe('3');
    await press('ArrowLeft');
    expect(await here()).toBe('2');
  });
  it('dives, goes along, dives again, and comes back in order', async () => {
    await go(1);
    await press('ArrowDown');
    expect(await here()).toBe('2.1');
    await press('ArrowRight');
    expect(await here()).toBe('2.2');
    await press('ArrowDown');
    expect(await here()).toBe('2.2.1');
    await press('ArrowUp');
    expect(await here()).toBe('2.2');
    await press('u');
    expect(await here()).toBe('2');
  });
  it('comes back to the parent at the end of a dive, built, and then carries on', async () => {
    await go(3);
    expect(await here()).toBe('2.2');
    await press('ArrowRight');
    expect(await here()).toBe('2');
    expect((await finish()).last).toBe(true);
    await press('ArrowRight');
    expect(await here()).toBe('3');
  });
  it('has Previous leave the start of a dive for its parent', async () => {
    await go(2);
    await press('ArrowLeft');
    expect(await here()).toBe('2');
  });
  it('treats Down on a slide with no dive as Next', async () => {
    await go(0);
    await press('ArrowDown');
    expect(await here()).toBe('2');
    await go(0);
    await press('d');
    expect(await here()).toBe('1');
  });
  it('numbers by the main path, and jumps there by number', async () => {
    await go(0);
    expect(await p.evaluate(() => { const s = (window as any).__present; s.player.wake(); return s.player.count.textContent; })).toMatch(/^1 \/ 3/);
    await press('3');
    await p.waitForTimeout(520);
    expect(await here()).toBe('3');
  });
  it('shows the presenter what it can dive into, and drives it from there', async () => {
    await go(1);
    const [pop] = await Promise.all([p.context().waitForEvent('page'), p.keyboard.press('p')]);
    await pop.waitForLoadState();
    await pop.waitForFunction(() => document.querySelector('#u-deep')?.textContent?.includes('Can go deeper'));
    expect(await pop.locator('#u-deep').textContent()).toContain('The loop');
    await pop.getByRole('button', { name: 'Dive in (2)' }).click();
    await pop.waitForFunction(() => document.querySelector('#u-trail')?.textContent?.startsWith('Deep dive:'));
    expect(await here()).toBe('2.1');
    await pop.keyboard.press('ArrowRight');
    await pop.waitForFunction(() => document.querySelector('#u-slide')?.textContent?.startsWith('2.2 /'));
    if (process.env.PRESENT_SHOT) await pop.screenshot({ path: `${process.env.PRESENT_SHOT}-tree-presenter.png` });
    await pop.getByRole('button', { name: 'Back up' }).click();
    await pop.waitForFunction(() => document.querySelector('#u-slide')?.textContent?.startsWith('2 /'));
    expect(await pop.locator('#u-trail').textContent()).toBe('');
    await pop.close();
  }, 20000);
  it('changes nothing for a deck with no tree', async () => {
    await p.goto(pathToFileURL(join(out, 'flat.html')).href);
    await p.waitForFunction(() => !!(window as any).__present);
    await go(0);
    await p.evaluate(() => { (window as any).__present.player.mode = 'auto'; });
    await press('ArrowDown', 'ArrowRight');
    expect(await here()).toBe('3');
    await press('ArrowUp');
    expect(await here()).toBe('2');
    expect(await p.evaluate(() => (window as any).__present.state().total)).toBe(6);
  });
});
