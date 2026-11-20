import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addAnnotation, addFromLibrary, applyOps, harvest, listLibrary, planMarkdown, planProgress, readAnnotations, reviewPlan, revisionOf, savePlan, saveToLibrary } from '@present/core';
import { claudeArgs, codexArgs, connectDeck, mcpSaved } from '@present/mcp';
import { startDev } from '@present/studio';
import { tempDeck } from './helpers.ts';

describe('MCP', () => {
  const t = tempDeck();
  const client = new Client({ name: 'test', version: '1' });
  const call = async (name: string, args: any = {}) => client.callTool({ name, arguments: args }) as Promise<any>;
  const json = (r: any) => JSON.parse(r.content.find((c: any) => c.type === 'text').text);
  beforeAll(async () => {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/src/bin.ts'), t.dir], env: process.env as Record<string, string>, stderr: 'ignore' }));
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
  it('gives agents the patterns, and renders one they add', async () => {
    const cat = json(await call('catalog'));
    expect(cat.patterns.length).toBeGreaterThan(5);
    expect((await call('pattern_read', { name: 'gates' })).content[0].text).toContain('<Neck');
    const { revision } = json(await call('deck_outline'));
    expect(json(await call('deck_apply', { baseRevision: revision, ops: [{ op: 'addSlide', id: 'gates', pattern: 'gates' }] })).ok).toBe(true);
    const seen = await call('slide_render', { slide: 'gates' });
    expect(JSON.parse(seen.content[1].text).diagnostics.filter((d: any) => d.severity === 'error')).toEqual([]);
    expect(json(await call('deck_undo')).ok).toBe(true);
  }, 60000);
  it('refuses to export outside the deck', async () => {
    const r = await call('deck_export', { format: 'html', out: '../escape.html' });
    expect(r.isError).toBe(true);
  });
});

describe('the library, across two projects', () => {
  const a = tempDeck(), b = tempDeck();
  const lib = mkdtempSync(join(tmpdir(), 'present-lib-')), was = process.env.PRESENT_LIBRARY;
  const macro = `// A labelled note\nexport default { doc: 'A labelled note', props: 'id', example: '', html: (a) => '<div id="' + a.id + '" class="note"><slot/></div>' };\n`;
  const client = new Client({ name: 'test', version: '1' });
  const call = async (name: string, args: any = {}) => client.callTool({ name, arguments: args }) as Promise<any>;
  const json = (r: any) => JSON.parse(r.content.find((c: any) => c.type === 'text').text);
  beforeAll(() => {
    process.env.PRESENT_LIBRARY = lib;
    mkdirSync(join(a.dir, 'macros')); mkdirSync(join(a.dir, 'tracks'));
    writeFileSync(join(a.dir, 'macros', 'Note.ts'), macro);
    writeFileSync(join(a.dir, 'tracks', 'nudge.ts'), '// Nudges a part\nexport default (el: any) => (p: number) => { el.style.opacity = String(p); };\n');
    writeFileSync(join(a.dir, 'deck.yaml'), readFileSync(join(a.dir, 'deck.yaml'), 'utf8') + '\nphrases:\n  beat:\n    doc: A small beat\n    cues:\n      - track: nudge\n        target: $\n');
    writeFileSync(join(a.dir, 'slides', 'keep.slide'), '---\ntitle: t\nbrief: b\nscore:\n  intro:\n    - use: beat\n      on: n\n---\n<Note id="n">Hi</Note>\n');
    writeFileSync(join(a.dir, 'deck.yaml'), readFileSync(join(a.dir, 'deck.yaml'), 'utf8').replace('06-close', '06-close\n  - keep'));
  });
  afterAll(async () => { await client.close(); process.env.PRESENT_LIBRARY = was; a.done(); b.done(); rmSync(lib, { recursive: true, force: true }); });

  it('saves what a deck defined with no one asking, and marks code as code', () => {
    const names = harvest(a.dir).map(i => i.name).sort();
    expect(names).toEqual(['Note', 'beat', 'nudge'].sort());
    expect(listLibrary().find(i => i.name === 'Note')).toMatchObject({ auto: true, code: true, doc: 'A labelled note', from: a.dir });
    expect(listLibrary().find(i => i.name === 'beat')).toMatchObject({ tracks: ['nudge'] });
    expect(harvest(a.dir)).toEqual([]);          // nothing changed, nothing saved
  });
  it('gathers everything a saved slide depends on, and it works in another deck', () => {
    const item = saveToLibrary(a.dir, { name: 'note-card', doc: 'A note that nudges in', slide: 'keep' });
    expect(item).toMatchObject({ macros: ['Note'], tracks: ['nudge'], phrases: ['beat'], slide: true, auto: false });
    const got = addFromLibrary(b.dir, 'note-card');
    expect(got.added).toEqual(expect.arrayContaining(['macros/Note.ts', 'tracks/nudge.ts', 'phrase beat']));
    expect(readFileSync(join(b.dir, 'macros', 'Note.ts'), 'utf8')).toBe(macro);
  });
  it('never overwrites what a deck changed, unless told to', () => {
    writeFileSync(join(b.dir, 'macros', 'Note.ts'), macro + '// mine\n');
    expect(() => addFromLibrary(b.dir, 'note-card')).toThrow('its own version');
    expect(readFileSync(join(b.dir, 'macros', 'Note.ts'), 'utf8')).toContain('mine');
    addFromLibrary(b.dir, 'note-card', { overwrite: true });
    expect(readFileSync(join(b.dir, 'macros', 'Note.ts'), 'utf8')).not.toContain('mine');
  });
  it('gives another deck\'s different component its own name', () => {
    harvest(b.dir);
    expect(listLibrary().filter(i => i.name === 'Note' && i.from === a.dir)).toHaveLength(1);
  });
  it('respects a deck that opts out, and refuses names that leave the library', () => {
    const c = tempDeck();
    mkdirSync(join(c.dir, 'tracks'));
    writeFileSync(join(c.dir, 'tracks', 'secret.ts'), 'export default () => () => {};\n');
    writeFileSync(join(c.dir, 'deck.yaml'), readFileSync(join(c.dir, 'deck.yaml'), 'utf8') + '\nlibrary: false\n');
    expect(harvest(c.dir)).toEqual([]);
    expect(() => saveToLibrary(c.dir, { name: '../evil', doc: 'x', tracks: ['secret'] })).toThrow('Bad library name');
    c.done();
  });
  it('is one MCP call from a fresh deck to a rendered slide, in the same session', async () => {
    const fresh = tempDeck();
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/src/bin.ts'), fresh.dir], env: process.env as Record<string, string>, stderr: 'ignore' }));
    expect(json(await call('catalog')).library.map((i: any) => i.name)).toContain('note-card');
    const r = json(await call('library_add', { name: 'note-card', slideId: 'reused' }));
    expect(r.slideAdded).toBe('reused');
    const seen = await call('slide_render', { slide: 'reused' });
    expect(JSON.parse(seen.content[1].text).diagnostics.filter((d: any) => d.severity === 'error')).toEqual([]);
    fresh.done();
  }, 60000);
});

describe('planning', () => {
  const slide = { id: 'proof', title: 'We gained 0.43', claim: 'It worked', pattern: 'evidence' };
  it('catches a plan that cannot be built, and a number with no source', () => {
    const t = tempDeck();
    const bad = savePlan(t.dir, { goal: 'g', slides: [{ ...slide, pattern: 'nope' }, { ...slide, id: 'x', pattern: undefined, component: 'missing' }] });
    expect(bad.ok).toBe(false);
    expect(bad.issues.filter(i => i.severity === 'error')).toHaveLength(2);
    expect(existsSync(join(t.dir, 'plan.yaml'))).toBe(false);
    const warned = savePlan(t.dir, { goal: 'g', minutes: 1, slides: [slide, { ...slide, id: 'b' }, { ...slide, id: 'c' }] });
    expect(warned.ok).toBe(true);
    expect(warned.issues.map(i => i.message).join()).toContain('no evidence');
    expect(warned.issues.map(i => i.message).join()).toContain('1 minute slot');
    t.done();
  });
  it('goes back to review when rewritten, and keeps comments until they are dealt with', () => {
    const t = tempDeck(), plan = { goal: 'g', slides: [{ ...slide, evidence: [{ source: 'evals.csv' }] }] };
    savePlan(t.dir, plan);
    reviewPlan(t.dir, 'approved');
    const c = reviewPlan(t.dir, 'changes', { text: 'More', slide: 'proof' }).feedback[0];
    savePlan(t.dir, plan);
    expect(planProgress(t.dir)).toMatchObject({ status: 'proposed', openFeedback: [{ text: 'More' }] });
    savePlan(t.dir, plan, [c.id]);
    expect(planProgress(t.dir)?.openFeedback).toEqual([]);
    t.done();
  });
  it('reports what is built, what is missing, and what nobody planned', () => {
    const t = tempDeck();
    savePlan(t.dir, { goal: 'g', slides: [{ id: '01-title', title: 'a', claim: 'b' }, { id: 'later', title: 'c', claim: 'd' }] });
    const p = planProgress(t.dir)!;
    expect(p.slides.map(s => s.state)).toEqual(['built', 'planned']);
    expect(p.built).toBe(1);
    expect(p.unplanned).toContain('02-why-it-fails');
    expect(planMarkdown(p)).toContain('[x] 1. a');
    t.done();
  });
  it('lets an agent in a project with no deck create one, plan it and build from it', async () => {
    const project = mkdtempSync(join(tmpdir(), 'present-project-'));
    writeFileSync(join(project, 'evals.csv'), 'run,score\n1,0.52\n');
    const c = new Client({ name: 'test', version: '1' });
    const call = (name: string, args: any = {}) => c.callTool({ name, arguments: args }) as Promise<any>;
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/src/bin.ts'), project], env: process.env as Record<string, string>, stderr: 'ignore' }));
    const first = await call('catalog');                 // the guide says to read it first, so it must work with no deck
    expect(first.isError).toBeFalsy();
    expect(JSON.parse(first.content[0].text).next).toContain('deck_create');
    expect(first.content.at(-1).text).toContain('Not a deck');
    expect((await call('deck_outline')).content[0].text).toContain('deck_create');
    expect(JSON.parse((await call('deck_create', { title: 'My eval results' })).content[0].text).deck).toBe(join(project, 'presentation'));
    const shown = await call('plan_write', { goal: 'Show the results', sources: [{ path: '../evals.csv', use: 'scores' }], slides: [{ id: 'result', title: 'Scores rose', claim: 'Training worked', pattern: 'evidence', animation: ['Line draws'], evidence: [{ source: '../evals.csv:2' }] }] });
    expect(shown.content[0].text.length).toBeLessThan(400);   // it does not echo the plan back
    const patched = JSON.parse((await call('plan_patch', { minutes: 5, slides: [{ id: 'result', claim: 'Training clearly worked' }] })).content[0].text);
    expect(patched).toMatchObject({ ok: true, slides: 1 });
    const plan = (await call('plan_read')).content[0].text;
    expect(plan).toContain('Beat 1: Line draws');
    expect(plan).toContain('Training clearly worked');
    const { revision } = JSON.parse((await call('deck_outline')).content[0].text);
    expect(JSON.parse((await call('deck_apply', { baseRevision: revision, ops: [{ op: 'addSlide', id: 'result', pattern: 'evidence' }] })).content[0].text).ok).toBe(true);
    expect((await call('plan_read')).content[0].text).toContain('[x] 1. Scores rose');
    mkdirSync(join(project, 'presentation', 'macros'));          // written directly, with no deck_apply after it
    const byHand = `ByHand${Date.now()}`;                         // the test library outlives a run
    writeFileSync(join(project, 'presentation', 'macros', `${byHand}.mjs`), "export default { doc: 'Written by hand', props: '', example: '', html: () => '<p>x</p>' };");
    const checked = JSON.parse((await call('deck_check')).content[0].text);
    expect(checked.library.savedNow).toContain(byHand);
    expect(checked.library.saved).toContain(byHand);
    expect((await call('deck_outline')).content.at(-1).text).toBe('deck: ' + join(project, 'presentation'));
    await c.close();

    // The wrong folder: the deck is just below it, and must be found rather than made again.
    const d = new Client({ name: 'test', version: '1' });
    const on = (name: string, args: any = {}) => d.callTool({ name, arguments: args }) as Promise<any>;
    await d.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/src/bin.ts'), project], env: process.env as Record<string, string>, stderr: 'ignore' }));
    const read = await on('plan_read');
    expect(read.content.at(-1).text).toContain('Decks nearby: ' + join(project, 'presentation'));
    const made = await on('deck_create');
    expect(made.isError).toBe(true);
    expect(made.content[0].text).toContain('deck_open');
    expect(JSON.parse((await on('deck_open', { path: 'presentation' })).content[0].text).slides).toBe(2);
    expect((await on('plan_read')).content[0].text).toContain('Scores rose');
    await d.close();
    rmSync(project, { recursive: true, force: true });
  }, 60000);
});

describe('connecting agents', () => {
  const t = tempDeck();
  afterAll(() => t.done());

  it('points Claude Code at the server, keeps other servers, and can run again', () => {
    writeFileSync(join(t.dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    connectDeck(t.dir);
    connectDeck(t.dir);
    const { mcpServers } = JSON.parse(readFileSync(join(t.dir, '.mcp.json'), 'utf8'));
    expect(mcpServers.other).toEqual({ command: 'x' });
    expect(mcpServers.present.args).toEqual([expect.stringMatching(/packages[\\/]mcp[\\/]src[\\/]bin\.ts$/), t.dir]);
  });
  it('will not replace a config it cannot read', () => {
    writeFileSync(join(t.dir, '.mcp.json'), '{ broken');
    expect(() => connectDeck(t.dir)).toThrow();
    expect(readFileSync(join(t.dir, '.mcp.json'), 'utf8')).toBe('{ broken');
  });
  it('gives Claude Code a user-level entry too, for a project with no deck yet', () => {
    expect(claudeArgs({ command: 'node', args: ['bin.ts', 'deck'] })).toEqual(['mcp', 'add', '--scope', 'user', 'present', '--', 'node', 'bin.ts']);
  });
  it('saves the AppImage file, not a path inside its mount, which is gone once the app closes', () => {
    const saved = mcpSaved('deck', { APPIMAGE: '/home/a/Present.AppImage', ELECTRON_RUN_AS_NODE: '1' });
    expect(saved).toEqual({ command: '/home/a/Present.AppImage', args: ['--mcp', resolve('deck')] });
    expect(claudeArgs(saved)).toEqual(['mcp', 'add', '--scope', 'user', 'present', '--', '/home/a/Present.AppImage', '--mcp']);
    expect(mcpSaved('deck', {}).command).toBe(process.execPath);
  });
  it('gives Codex one entry that follows the folder, and the app runs it as Node', () => {
    const args = codexArgs({ command: 'present.exe', args: ['bin.ts', 'deck'], env: { ELECTRON_RUN_AS_NODE: '1' } });
    expect(args).toEqual(['mcp', 'add', '--env', 'ELECTRON_RUN_AS_NODE=1', 'present', '--', 'present.exe', 'bin.ts']);
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
