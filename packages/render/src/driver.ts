// Observation: drive the deck in a headless browser, always through seek, so every picture and
// every check is of a known frame. One browser stays warm; agents call this constantly.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { compileDeck, type Diagnostic } from '@present/core';
import { deckHtml, loadProjectMacros } from './bundle.ts';

export interface Frame { slide: number; step?: number; t?: number; spot?: string; spotT?: number; }

/** Pixels that differ visibly between two PNGs, measured in the page. */
export async function pngDiff(page: Page, a: Buffer, b: Buffer) {
  return page.evaluate(async ([x, y]) => {
    const load = async (s: string) => {
      const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode();
      const c = document.createElement('canvas'); c.width = i.width; c.height = i.height;
      const g = c.getContext('2d', { willReadFrequently: true })!; g.drawImage(i, 0, 0);
      return g.getImageData(0, 0, i.width, i.height).data;
    };
    const p = await load(x), q = await load(y);
    let count = 0, maxDelta = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let k = 0; k < p.length; k += 4) {
      const d = Math.max(Math.abs(p[k] - q[k]), Math.abs(p[k + 1] - q[k + 1]), Math.abs(p[k + 2] - q[k + 2]));
      if (d > maxDelta) maxDelta = d;
      if (d > 24) {
        count++;
        const px = (k / 4) % 1920, py = Math.floor(k / 4 / 1920);
        x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
      }
    }
    return { count, maxDelta, box: count ? [x0, y0, x1, y1] : null };
  }, [a.toString('base64'), b.toString('base64')]);
}

export class Renderer {
  dir: string;
  browser: Browser | null = null;
  page: Page | null = null;
  loaded = '';
  constructor(dir: string) { this.dir = resolve(dir); }

  async open(): Promise<Page> {
    if (!this.browser) {
      const candidates = [{ channel: 'chrome' }, { channel: 'msedge' }, {}];
      let last: unknown;
      for (const c of candidates) {
        try { this.browser = await chromium.launch({ headless: true, ...c }); break; } catch (e) { last = e; }
      }
      if (!this.browser) throw new Error(`Could not start a browser: ${last}`);
      const ctx = await this.browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
      this.page = await ctx.newPage();
    }
    await loadProjectMacros(this.dir);
    const { deck } = compileDeck(this.dir);
    if (deck.revision !== this.loaded) {
      const tmp = join(this.dir, '.present');
      mkdirSync(tmp, { recursive: true });
      const file = join(tmp, 'render.html');
      writeFileSync(file, await deckHtml(deck, this.dir));
      await this.page!.goto(pathToFileURL(file).href + '?still');
      await this.page!.waitForFunction(() => !!(window as any).__present);
      await this.page!.evaluate(() => (window as any).__present.ready());
      this.loaded = deck.revision;
    }
    return this.page!;
  }
  async close() { await this.browser?.close(); this.browser = null; this.page = null; this.loaded = ''; }

  async seek(f: Frame) {
    const page = await this.open();
    return page.evaluate(o => (window as any).__present.seek(o), f as any);
  }
  async frame(f: Frame) {
    const state = await this.seek(f);
    return { png: await this.page!.screenshot({ type: 'png' }), state };
  }
  async slideIndex(idOrNo: string | number): Promise<number> {
    if (typeof idOrNo === 'number') return idOrNo;
    if (/^\d+$/.test(idOrNo)) return +idOrNo;
    const { deck } = compileDeck(this.dir);
    const i = deck.slides.findIndex(s => s.id === idOrNo);
    if (i < 0) throw new Error(`No slide "${idOrNo}"`);
    return i + 1;
  }
  /** Rendered checks for one slide, at rest. */
  async check(no: number): Promise<{ diagnostics: Diagnostic[]; boxes: any[] }> {
    await this.seek({ slide: no });
    const page = this.page!;
    const { issues, boxes } = await page.evaluate(() => (window as any).__present.audit());
    const { deck } = compileDeck(this.dir);
    const id = deck.slides[no - 1].id;
    const diagnostics: Diagnostic[] = issues.map((i: any) => ({ ...i, slide: id }));
    const rested = await page.screenshot({ type: 'png' });
    await page.evaluate(n => (window as any).__present.player.pristine(n), no);
    const drawing = await page.screenshot({ type: 'png' });
    if (!rested.equals(drawing) && (await pngDiff(page, rested, drawing)).count > 40) diagnostics.push({ code: 'rest-differs', severity: 'error', slide: id, message: 'The rested slide differs from the finished drawing', fix: 'A track does not restore its element at p=1. Look at custom tracks and tint or hot classes.' });
    return { diagnostics, boxes };
  }
  async checkAll(): Promise<Diagnostic[]> {
    const { deck, diagnostics } = compileDeck(this.dir);
    const out = [...diagnostics];
    for (let i = 1; i <= deck.slides.length; i++) out.push(...(await this.check(i)).diagnostics);
    return out;
  }
  /** A contact sheet of one step over time, so motion can be judged from a still. */
  async filmstrip(no: number, step: number, frames = 8, spanMs?: number, spot?: string): Promise<Buffer> {
    const { deck } = compileDeck(this.dir);
    const spotEnd = spot ? 700 + (deck.slides[no - 1].spots.find(s => s.id === spot)?.end ?? 0) : 0;
    const end = spanMs ?? (spotEnd || Math.max(400, deck.slides[no - 1].phases[Math.min(step, deck.slides[no - 1].phases.length - 1)].end));
    const shots: { t: number; b64: string }[] = [];
    for (let i = 0; i < frames; i++) {
      const t = Math.round(end * i / (frames - 1));
      const { png } = await this.frame(spot ? { slide: no, step, spot, spotT: t } : { slide: no, step, t });
      shots.push({ t, b64: png.toString('base64') });
    }
    const ctx = await this.browser!.newContext({ viewport: { width: 1920, height: 300 }, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    await p.setContent(`<body style="margin:0;padding:12px;background:#0d1117;display:grid;grid-template-columns:repeat(4,1fr);gap:10px;font:14px monospace;color:#c9d1d9">${shots.map(s => `<div><img style="width:100%;display:block;border-radius:4px" src="data:image/png;base64,${s.b64}"><div>${s.t}ms</div></div>`).join('')}</body>`);
    await p.waitForFunction(() => [...document.images].every(i => i.complete));
    const png = await p.screenshot({ type: 'png', fullPage: true });
    await ctx.close();
    return png;
  }
}

export async function exportHtml(dir: string, out: string) {
  await loadProjectMacros(dir);
  const { deck, diagnostics } = compileDeck(dir);
  const html = await deckHtml(deck, dir);
  writeFileSync(out, html);
  return { out, bytes: Buffer.byteLength(html), diagnostics };
}

export async function exportPdf(dir: string, out: string, perStep = false) {
  const r = new Renderer(dir);
  const page = await r.open();
  await page.evaluate(s => (window as any).__present.player.printLayout(s), perStep);
  await page.waitForTimeout(100);
  await page.pdf({ path: out, width: '1920px', height: '1080px', printBackground: true });
  await r.close();
  return { out };
}

export async function exportPng(dir: string, outDir: string, perStep = false) {
  const r = new Renderer(dir);
  await r.open();
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const { deck } = compileDeck(dir);
  const files: string[] = [];
  for (const [i, s] of deck.slides.entries()) {
    const steps = perStep ? s.phases.map((_, k) => k) : [s.phases.length - 1];
    for (const st of steps) {
      const { png } = await r.frame({ slide: i + 1, step: st });
      const f = join(outDir, `${String(i + 1).padStart(2, '0')}-${s.id}${perStep ? `-${st}` : ''}.png`);
      writeFileSync(f, png);
      files.push(f);
    }
  }
  await r.close();
  return { files };
}
