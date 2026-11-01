import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addAnnotation, applyOps, readAnnotations, revisionOf } from '@present/core';
import { startDev } from '@present/studio';
import { tempDeck } from './helpers.ts';

describe('MCP', () => {
  const t = tempDeck();
  const client = new Client({ name: 'test', version: '1' });
  const call = async (name: string, args: any = {}) => client.callTool({ name, arguments: args }) as Promise<any>;
  const json = (r: any) => JSON.parse(r.content.find((c: any) => c.type === 'text').text);
  beforeAll(async () => {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/cli/src/bin.ts'), 'mcp', t.dir], stderr: 'ignore' }));
  }, 30000);
  afterAll(async () => { await client.close(); t.done(); });

  it('lists the tools', async () => {
    const names = (await client.listTools()).tools.map(x => x.name);
    expect(names).toEqual(expect.arrayContaining(['catalog', 'deck_outline', 'slide_read', 'deck_apply', 'slide_render', 'slide_filmstrip', 'deck_check', 'annotations_list', 'annotations_resolve', 'deck_export']));
  });
  it('runs the read, edit, see loop', async () => {
    const out = json(await call('deck_outline'));
    expect(out.slides).toHaveLength(6);
    const read = json(await call('slide_read', { slide: '02-why-it-fails' }));
    expect(read.ids).toContain('cause');
    const edit = json(await call('deck_apply', { baseRevision: out.revision, ops: [{ op: 'setText', slide: '02-why-it-fails', id: 'cause-text', text: 'Agents cannot see' }] }));
    expect(edit.ok).toBe(true);
    const stale = json(await call('deck_apply', { baseRevision: out.revision, ops: [{ op: 'setNotes', slide: '02-why-it-fails', notes: 'x' }] }));
    expect(stale.ok).toBe(false);
    const seen = await call('slide_render', { slide: '02-why-it-fails', step: 2, t: 300 });
    expect(seen.content[0].type).toBe('image');
    expect(seen.content[0].data.length).toBeGreaterThan(1000);
    const info = JSON.parse(seen.content[1].text);
    expect(info.state.step).toBe(2);
    expect(info.boxes.map((b: any) => b.id)).toContain('cause');
    const film = await call('slide_filmstrip', { slide: 2, step: 1, frames: 4 });
    expect(film.content[0].type).toBe('image');
    expect(json(await call('deck_undo')).ok).toBe(true);
  }, 60000);
  it('refuses to export outside the deck', async () => {
    const r = await call('deck_export', { format: 'html', out: '../escape.html' });
    expect(r.isError).toBe(true);
  });
});

describe('dev server', () => {
  const t = tempDeck();
  let dev: Awaited<ReturnType<typeof startDev>>;
  beforeAll(async () => { dev = await startDev(t.dir, 0); }, 30000);
  afterAll(async () => { await dev.close(); t.done(); });

  it('listens on loopback only', () => { expect(dev.url).toContain('127.0.0.1'); });
  it('rejects foreign origins and missing tokens', async () => {
    const post = (headers: Record<string, string>) => fetch(dev.url + 'api/undo', { method: 'POST', headers, body: '{}' });
    expect((await post({ 'x-present-token': dev.token, origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({})).status).toBe(403);
    expect((await post({ 'x-present-token': 'wrong' })).status).toBe(403);
    expect((await post({ 'x-present-token': dev.token })).status).toBe(200);
  });

  it('holds the frame across hot reload, and closes the comment loop', async () => {
    const browser = await chromium.launch({ channel: 'chrome' });
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 }, reducedMotion: 'no-preference' })).newPage();
    await page.goto(dev.url + '?steps#2');
    await page.waitForFunction(() => !!(window as any).__present);
    await page.evaluate(() => (window as any).__present.seek({ slide: 2, step: 2, t: 300 }));
    await page.waitForTimeout(300);          // EventSource connected

    // the human comments in Studio
    await page.keyboard.press('i');
    await page.waitForSelector('#present-studio');
    await page.locator('#cause-text').click({ force: true });
    await page.getByPlaceholder('Make this tighter').fill('Say it shorter');
    await page.getByText('Add comment').click();
    await page.waitForFunction(() => document.body.textContent!.includes('Comment saved'));
    const [ann] = readAnnotations(t.dir);
    expect(ann).toMatchObject({ slide: '02-why-it-fails', node: 'cause-text', comment: 'Say it shorter', step: 2 });

    // the agent acts on it, and the open page updates in place
    const r = applyOps(t.dir, [{ op: 'setText', slide: ann.slide, id: ann.node, text: 'No eyes' }], revisionOf(t.dir));
    expect(r.ok).toBe(true);
    await page.waitForFunction(() => document.querySelector('#cause-text')?.textContent === 'N', undefined, { timeout: 5000 }).catch(() => {});
    await page.waitForFunction(() => { const s = (window as any).__present.state(); return s.slide === 2 && s.step === 2 && s.t === 300; });
    const st = await page.evaluate(() => (window as any).__present.state());
    expect(st).toMatchObject({ slide: 2, step: 2, t: 300 });
    expect(await page.evaluate(() => (window as any).__present.player.order[1].html)).toContain('No eyes');

    // inline text edit goes through ops and lands in the file
    await page.locator('#present-studio textarea').first().fill('Edited here');
    await page.getByText('Save text').click();
    await page.waitForFunction(() => document.body.textContent!.includes('Saved'));
    expect(readFileSync(join(t.dir, 'slides', '02-why-it-fails.slide'), 'utf8')).toContain('Edited here');
    await browser.close();
  }, 60000);

  it('writes an id for a part that has none', () => {
    const a = addAnnotation(t.dir, { slide: '06-close', path: [1], step: 0, comment: 'x' });
    expect(a.node).toMatch(/^n-/);
  });
});
