import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import { tempDeck } from './helpers.ts';

const exe = process.env.PRESENT_DESKTOP_EXE ?? resolve('node_modules/electron/dist/electron.exe');
const main = process.env.PRESENT_DESKTOP_EXE ? [] : [resolve('packages/desktop/src/main.mjs')];

async function start(deck?: string) {
  const data = mkdtempSync(join(tmpdir(), 'present-data-'));
  const app = await electron.launch({ executablePath: exe, args: [...main, `--user-data-dir=${data}`, ...(deck ? [deck] : [])], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } as any, timeout: 60000 });
  return { app, data };
}
const serverAlive = async (url: string) => { try { await fetch(url, { signal: AbortSignal.timeout(1500) }); return true; } catch { return false; } };
const close = async (app: ElectronApplication, data: string) => { await app.close(); await new Promise(r => setTimeout(r, 500)); rmSync(data, { recursive: true, force: true }); };

describe.skipIf(!existsSync(exe))('desktop app', () => {
  it('opens on a welcome screen with nothing to open', async () => {
    const { app, data } = await start();
    const win = await app.firstWindow();
    await win.getByText('Open deck folder').waitFor();
    if (process.env.PRESENT_SHOT) await win.screenshot({ path: process.env.PRESENT_SHOT + '-welcome.png' });
    expect(await win.getByText('Your decks will appear here').count()).toBe(1);
    await close(app, data);
  }, 90000);

  describe('with a deck', () => {
    const t = tempDeck();
    let app: ElectronApplication, data: string, page: Page, url: string;
    const errors: string[] = [];
    afterAll(() => t.done());

    it('opens the deck in Studio, with no browser and no Node of its own', async () => {
      ({ app, data } = await start(t.dir));
      page = await app.firstWindow();
      page.on('pageerror', e => errors.push(e.message));
      await page.waitForURL(/\/studio$/, { timeout: 30000 });
      await page.waitForFunction(() => !!(document.querySelector('iframe') as any)?.contentWindow?.__present);
      await expect.poll(() => page.locator('nav .thumb').count()).toBe(6);
      url = page.url();
      if (process.env.PRESENT_SHOT) { await page.locator('nav .thumb img.in').first().waitFor(); await page.waitForTimeout(800); await page.screenshot({ path: process.env.PRESENT_SHOT + '-studio.png' }); }
    }, 90000);
    it('reports the Electron runtime to the server', async () => {
      const list = await page.evaluate(() => fetch('/api/references', { headers: { 'x-present-token': (window as any).__PRESENT_DEV.token } }).then(r => r.status));
      expect(list).toBe(200);
    });
    it('offers a capture picker, and a choice reaches the crop step', async () => {
      const opened = app.waitForEvent('window');
      await page.getByRole('button', { name: 'Capture window' }).click();
      const pick = await opened;
      await pick.locator('a').first().waitFor({ timeout: 15000 });
      expect(await pick.locator('a').count()).toBeGreaterThan(0);
      await pick.locator('a').first().click();
      await page.locator('.modal').waitFor({ timeout: 15000 });
      await page.getByText('Cancel').click();
    }, 40000);
    describe('presenting', () => {
      // A second screen cannot be plugged in here, so the app is told about one. It has the main
      // display's bounds so its window really opens, and only `id` tells the two apart.
      const addScreen = () => app.evaluate(({ screen }) => {
        const main = screen.getPrimaryDisplay();
        const real = screen.getAllDisplays.bind(screen);
        (screen as any).getAllDisplays = () => [...real(), { ...main, id: main.id + 1, label: 'Projector' }];
        (screen as any).emit('display-added');
      });
      const windows = () => app.windows().filter(w => !w.url().endsWith('/studio'));
      const find = async (part: string) => {
        await expect.poll(() => windows().some(w => w.url().includes(part)), { timeout: 20000 }).toBe(true);
        return windows().find(w => w.url().includes(part))!;
      };
      let stage: Page, notes: Page;

      it('offers each display, and opens the audience and presenter windows', async () => {
        await addScreen();
        await page.locator('nav .thumb').nth(1).click();
        await page.getByRole('button', { name: 'Present' }).click();
        await page.getByRole('menuitem', { name: /Projector/ }).click();
        stage = await find('?show#2');
        await stage.waitForFunction(() => !!(window as any).__present);
        notes = await find('presenter');
        await notes.waitForFunction(() => document.querySelector('#u-slide')?.textContent?.startsWith('2 /'));
        await page.getByText('Presenting').waitFor();
        expect(await stage.evaluate(() => getComputedStyle(document.querySelector('.ui-bar')!).opacity)).toBe('0');
        const full = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.isFullScreen()).length);
        expect(full).toBe(1);
      }, 40000);
      it('drives the show from the presenter view', async () => {
        await expect.poll(() => notes.locator('#u-now .p-body').count()).toBe(1);
        await notes.keyboard.press('ArrowRight');
        await expect.poll(() => stage.evaluate(() => (window as any).__present.state().slide)).toBe(3);
        await notes.waitForFunction(() => document.querySelector('#u-slide')?.textContent?.startsWith('3 /'));
        await notes.keyboard.press('b');
        await stage.locator('.ui-black.open').waitFor({ state: 'attached' });
        await notes.locator('#u-black.on').waitFor();
        await notes.getByText('Black screen').click();
        await expect.poll(() => stage.locator('.ui-black.open').count()).toBe(0);
      });
      it('draws the presenter view, with the clock running', async () => {
        await expect.poll(() => notes.locator('#u-time').textContent(), { timeout: 3000 }).not.toBe('00:00');
        if (process.env.PRESENT_SHOT) await notes.screenshot({ path: process.env.PRESENT_SHOT + '-presenter.png' });
        // The panes are the real slide, untouched by the presenter view's own styles.
        const font = (p: Page, at: string) => p.locator(at).first().evaluate(e => { const c = getComputedStyle(e); return [c.fontSize, c.fontFamily, c.textTransform]; });
        expect(await font(notes, '#u-now .p-body h1, #u-now .p-body h2')).toEqual(await font(stage, 'section.p-slide:last-of-type .p-body h1, section.p-slide:last-of-type .p-body h2'));
      });
      it('shows edits on both windows while presenting', async () => {
        const res = await page.evaluate(() => fetch('/api/outline', { headers: { 'x-present-token': (window as any).__PRESENT_DEV.token } }).then(r => r.json()));
        await page.evaluate(([revision]) => fetch('/api/ops', { method: 'POST', headers: { 'x-present-token': (window as any).__PRESENT_DEV.token }, body: JSON.stringify({ baseRevision: revision, ops: [{ op: 'setNotes', slide: '03-the-loop', notes: 'Edited while live' }] }) }).then(r => r.json()), [res.revision]);
        await expect.poll(() => notes.locator('#u-notes').textContent()).toBe('Edited while live');
      });
      it('ends with Esc from the presenter view, and closes both windows', async () => {
        await notes.keyboard.press('Escape').catch(() => {});   // the window goes before the key press returns
        await expect.poll(() => windows().length, { timeout: 10000 }).toBe(0);
        await page.getByRole('button', { name: 'Present' }).waitFor();
      }, 20000);
      it('ends with the End show button in the presenter view', async () => {
        await page.getByRole('button', { name: 'Present' }).click();
        await page.getByRole('menuitem', { name: /Projector/ }).click();
        const view = await find('presenter');
        await view.locator('#u-now .p-body').waitFor();
        await view.getByRole('button', { name: 'End show' }).click().catch(() => {});   // the window goes before the click returns
        await expect.poll(() => windows().length, { timeout: 10000 }).toBe(0);
        await page.getByRole('button', { name: 'Present' }).waitFor();
      }, 40000);
      it('opens the presenter view with P from the still preview, and it drives the slides', async () => {
        await page.locator('nav .thumb').nth(0).click();
        await expect.poll(() => page.locator('.count').textContent()).toContain('1 /');
        await page.locator('header .title').click();
        await page.keyboard.press('p');
        const view = await find('presenter');
        await view.locator('#u-now .p-body').waitFor();
        await view.keyboard.press('ArrowRight');
        await expect.poll(() => page.locator('.count').textContent()).toContain('2 /');
        await view.close();
        await page.getByRole('button', { name: 'Play' }).click();     // back to a fresh preview
        await page.getByRole('button', { name: 'Play' }).click();
        await page.waitForTimeout(500);
      }, 40000);
      it('keeps working with autoplay off in a presenter view opened with P, with no app menu', async () => {
        await page.locator('nav .thumb').nth(0).click();
        await expect.poll(() => page.locator('.count').textContent()).toContain('1 /');
        await page.locator('header .title').click();
        await page.keyboard.press('p');
        const view = await find('presenter');
        await view.locator('#u-now .p-body').waitFor();
        expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('presenter'))!.isMenuBarVisible())).toBe(false);
        await view.locator('#u-mode').click();
        await expect.poll(() => view.locator('#u-mode').textContent()).toBe('Autoplay: Off');
        // Past a slide change, which is where the preview used to reload and leave this window talking to nothing.
        for (const slide of ['2 /', '3 /']) {
          await expect.poll(async () => {
            await view.getByRole('button', { name: 'Next', exact: true }).click();
            await view.waitForTimeout(150);
            return view.locator('#u-slide').textContent();
          }, { timeout: 15000 }).toContain(slide);
        }
        const before = await view.locator('#u-slide').textContent();
        await view.getByRole('button', { name: 'Next', exact: true }).click();
        await expect.poll(() => view.locator('#u-slide').textContent()).not.toBe(before);
        await view.close();
        await page.getByRole('button', { name: 'Play' }).click();     // back to a fresh preview
        await page.getByRole('button', { name: 'Play' }).click();
        await page.waitForTimeout(500);
      }, 40000);
      it('shows no app menu in the windows of a show, and F5 still ends it from there', async () => {
        await page.getByRole('button', { name: 'Present' }).click();
        await page.getByRole('menuitem', { name: /Projector/ }).click();
        const view = await find('presenter');
        await view.locator('#u-now .p-body').waitFor();
        const menus = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => !w.webContents.getURL().endsWith('/studio')).map(w => w.isMenuBarVisible()));
        expect(menus).toEqual([false, false]);
        await app.evaluate(({ BrowserWindow }) => {                  // a native key, the path a real press takes
          const w = BrowserWindow.getAllWindows().find(x => x.webContents.getURL().includes('presenter'))!;
          w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F5' });
        });
        await expect.poll(() => windows().length, { timeout: 10000 }).toBe(0);
      }, 40000);
      it('has the menus of a finished app, and starts from the beginning with Shift+F5', async () => {
        const menus = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.map(i => i.label));
        expect(menus).toEqual(expect.arrayContaining(['File', 'Edit', 'Slideshow', 'View', 'Window', 'Help']));
        await page.locator('nav .thumb').nth(2).click();
        await expect.poll(() => page.locator('.count').textContent()).toContain('3 /');
        await app.evaluate(({ Menu }) => { Menu.getApplicationMenu()!.items.find(i => i.label === 'Slideshow')!.submenu!.items[0].click(); });
        await page.getByRole('menuitem', { name: /Projector/ }).click();
        await find('?show#1');
        await page.getByRole('button', { name: 'End show' }).click();
        await expect.poll(() => windows().length, { timeout: 10000 }).toBe(0);
      }, 40000);
      it('ends the show with F5 from the audience window', async () => {
        await page.getByRole('button', { name: 'Present' }).click();
        await page.getByRole('menuitem', { name: /Projector/ }).click();
        await find('?show');
        await page.getByRole('button', { name: 'End show' }).waitFor();
        await app.evaluate(({ BrowserWindow, Menu }) => {
          const real = BrowserWindow.getFocusedWindow;
          BrowserWindow.getFocusedWindow = () => BrowserWindow.getAllWindows().find(x => x.webContents.getURL().includes('?show') && !x.webContents.getURL().includes('presenter'))!;
          Menu.getApplicationMenu()!.items.find(i => i.label === 'Slideshow')!.submenu!.items[1].click();
          BrowserWindow.getFocusedWindow = real;
        });
        await expect.poll(() => windows().length, { timeout: 10000 }).toBe(0);
      }, 40000);
      it('starts a slideshow from the first slide, whichever is selected', async () => {
        await page.locator('nav .thumb').nth(2).click();
        await expect.poll(() => page.locator('.count').textContent()).toContain('3 /');
        await page.getByRole('button', { name: 'Start slideshow' }).click();
        await page.getByRole('menuitem', { name: /Projector/ }).click();
        const audience = await find('?show#1');
        await audience.waitForFunction(() => !!(window as any).__present);
        expect(await audience.evaluate(() => (window as any).__present.state().slide)).toBe(1);
        await page.getByRole('button', { name: 'End show' }).click();
        await expect.poll(() => windows().length, { timeout: 10000 }).toBe(0);
        // Present still means this slide, and a cancelled or earlier choice does not stick.
        await page.getByRole('button', { name: 'Present' }).click();
        await page.getByRole('menuitem', { name: /Projector/ }).click();
        await find('?show#3');
        await page.getByRole('button', { name: 'End show' }).click();
        await expect.poll(() => windows().length, { timeout: 10000 }).toBe(0);
      }, 60000);
      it('keeps the top bar in order at every width, with a long title', async () => {
        const size = (w: number, h: number) => app.evaluate(({ BrowserWindow }, s) => { BrowserWindow.getAllWindows().find(x => x.webContents.getURL().endsWith('/studio'))!.setSize(s[0], s[1]); }, [w, h]);
        await page.evaluate(() => { document.querySelector('.title')!.textContent = 'Zero-Knowledge Proofs for Graph Isomorphism and 3-Colouring'; });
        for (const w of [1040, 1500, 1913]) {
          await size(w, 800);
          await page.waitForTimeout(400);
          if (process.env.PRESENT_SHOT) await page.screenshot({ path: `${process.env.PRESENT_SHOT}-top-${w}.png`, clip: { x: 0, y: 0, width: await page.evaluate(() => innerWidth), height: 60 } });
          const bar = await page.evaluate(() => {
            const parts = [...document.querySelectorAll('.brand, .tools > *, .actions > *')].filter(e => getComputedStyle(e).display !== 'none' && !e.classList.contains('menu')).map(e => e.getBoundingClientRect());
            return {
              gaps: parts.slice(1).map((r, n) => r.left - parts[n].right),
              end: parts.at(-1)!.right, limit: (navigator as any).windowControlsOverlay?.getTitlebarAreaRect?.().right || innerWidth,
              squares: [...document.querySelectorAll('.act.square')].map(e => e.getBoundingClientRect().width),
              title: document.querySelector('.title')!.getBoundingClientRect().width,
            };
          });
          expect(Math.min(...bar.gaps), `at ${w}`).toBeGreaterThanOrEqual(0);    // nothing runs into its neighbour
          expect(bar.end).toBeLessThanOrEqual(bar.limit);
          expect(new Set(bar.squares)).toEqual(new Set([28]));                     // nothing is squashed
          expect(bar.title, `title at ${w}`).toBeGreaterThan(40);                 // and the title is still there
        }
        await size(1500, 940);
      }, 30000);
      it('starts and ends with F5, with the menu bar hidden', async () => {
        const f5 = () => app.evaluate(({ BrowserWindow }) => {
          const w = BrowserWindow.getAllWindows().find(x => x.webContents.getURL().endsWith('/studio'))!;
          w.focus();
          w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F5' });
          w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F5' });
        });
        await f5();
        await find('?show');
        await page.getByRole('button', { name: 'End show' }).waitFor();
        await f5();
        await expect.poll(() => windows().length, { timeout: 10000 }).toBe(0);
      }, 30000);
    });
    it('exports from the Export button, to the place chosen in the dialog', async () => {
      const out = join(t.dir, 'exported.html').replace(/\\/g, '\\\\');
      await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as any; }, out.replace(/\\\\/g, '\\'));
      await app.evaluate(({ shell }) => { shell.showItemInFolder = () => {}; });
      await page.getByRole('button', { name: 'Export' }).click();
      await page.getByRole('menuitem', { name: /^HTML/ }).click();
      await expect.poll(() => existsSync(join(t.dir, 'exported.html')), { timeout: 20000 }).toBe(true);
      await page.getByText('Exported').waitFor();
    }, 30000);
    it('sends other sites to the browser, not into the app', async () => {
      // Replaced, so a test run does not open the real browser.
      await app.evaluate(({ shell }) => { shell.openExternal = async (u: string) => { (globalThis as any).opened = u; }; });
      await page.evaluate(() => { location.href = 'https://example.com/'; }).catch(() => {});
      await expect.poll(() => app.evaluate(() => (globalThis as any).opened)).toBe('https://example.com/');
      expect(page.url()).toBe(url);
    });
    it('ran without a page error', () => { expect(errors).toEqual([]); });
    it('stops the server with the window', async () => {
      expect(await serverAlive(url)).toBe(true);
      await close(app, data);
      await expect.poll(() => serverAlive(url), { timeout: 8000 }).toBe(false);
    }, 30000);
  });
});
