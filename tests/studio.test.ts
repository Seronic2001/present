import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addReference, applyOps, listReferences, readPlan, readReference, removeReference, revisionOf, savePlan } from '@present/core';
import { startDev } from '@present/studio';
import { invocation, parseLine, buildPrompt, type AgentId } from '../packages/studio/src/agents.ts';
import { tempDeck } from './helpers.ts';

describe('references', () => {
  const t = tempDeck();
  afterAll(() => t.done());

  it('stores uploads under safe names and never overwrites', () => {
    const a = addReference(t.dir, 'notes.md', Buffer.from('one'));
    const b = addReference(t.dir, 'notes.md', Buffer.from('two'));
    expect([a.path, b.path]).toEqual(['references/notes.md', 'references/notes-2.md']);
    expect(addReference(t.dir, '../../evil.md', Buffer.from('x')).path).toBe('references/evil.md');
  });
  it('stays inside references/', async () => {
    await expect(readReference(t.dir, 'deck.yaml')).rejects.toThrow('Not a reference');
    await expect(readReference(t.dir, '../secret.txt')).rejects.toThrow();
    expect(() => removeReference(t.dir, 'slides/01-title.slide')).toThrow('Not a reference');
    expect(() => addReference(t.dir, 'a.png', Buffer.from('x'), '../slides')).toThrow();
    expect(existsSync(join(t.dir, 'slides', '01-title.slide'))).toBe(true);
  });
  it('reads long text in windows', async () => {
    addReference(t.dir, 'long.csv', Buffer.from('x'.repeat(50)));
    const a = await readReference(t.dir, 'references/long.csv', { limit: 20 }) as any;
    expect(a).toMatchObject({ kind: 'text', total: 50, nextOffset: 20 });
    expect((await readReference(t.dir, 'references/long.csv', { offset: 40, limit: 20 }) as any).nextOffset).toBeNull();
  });
  it('extracts text from a PDF', async () => {
    const browser = await chromium.launch({ channel: 'chrome' });
    const page = await browser.newPage();
    await page.setContent('<h1>Revenue grew 41 percent</h1>');
    addReference(t.dir, 'report.pdf', await page.pdf());
    await browser.close();
    const c = await readReference(t.dir, 'references/report.pdf') as any;
    expect(c.kind).toBe('text');
    expect(c.text).toContain('Revenue grew 41 percent');
    expect(c.text).toContain('--- page 1 ---');
  }, 30000);
  it('says so when it cannot read a file', async () => {
    addReference(t.dir, 'book.xlsx', Buffer.from('PK'));
    expect((await readReference(t.dir, 'references/book.xlsx')).kind).toBe('unreadable');
    expect(listReferences(t.dir).find(r => r.name === 'book.xlsx')?.kind).toBe('other');
  });
});

describe('agent adapters', () => {
  const t = tempDeck();
  const mcp = { command: 'node', args: ['bin.ts', 'mcp', t.dir] };
  afterAll(() => t.done());

  it('never gives an agent a general way to write', () => {
    const claude = invocation('claude', t.dir, mcp);
    expect(claude.args.join(' ')).toContain('--strict-mcp-config');
    expect(claude.args[claude.args.indexOf('--disallowedTools') + 1]).toContain('Bash');
    expect(claude.args[claude.args.indexOf('--disallowedTools') + 1]).toContain('Write');
    expect(claude.args.join(' ')).not.toMatch(/bypassPermissions|dangerously/);
    const codex = invocation('codex', t.dir, mcp);
    expect(codex.args).toContain('sandbox_mode="read-only"');
    expect(codex.args).toContain('mcp_servers.present.default_tools_approval_mode="approve"');
    expect(codex.args.join(' ')).not.toContain('dangerously');
    const open = JSON.parse(invocation('opencode', t.dir, mcp).env!.OPENCODE_CONFIG_CONTENT);
    expect(open.permission).toEqual({ edit: 'deny', bash: 'deny', external_directory: 'deny' });
  });
  it('resumes the session', () => {
    expect(invocation('claude', t.dir, mcp, 'S').args.join(' ')).toContain('--resume S');
    expect(invocation('codex', t.dir, mcp, 'S').args.slice(0, 3)).toEqual(['exec', 'resume', 'S']);
    expect(invocation('opencode', t.dir, mcp, 'S').args.join(' ')).toContain('--session S');
  });
  it('reads each agent\'s stream', () => {
    const one = (a: AgentId, o: any) => parseLine(a, o);
    expect(one('claude', { type: 'system', subtype: 'init', session_id: 'c' })).toEqual([{ session: 'c' }]);
    expect(one('claude', { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'hi' } } })).toEqual([{ text: 'hi' }]);
    expect(one('claude', { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__present__deck_apply' }, { type: 'tool_use', name: 'ToolSearch' }] } })).toEqual([{ tool: 'deck_apply' }]);
    expect(one('codex', { type: 'thread.started', thread_id: 'x' })).toEqual([{ session: 'x' }]);
    expect(one('codex', { type: 'item.started', item: { type: 'mcp_tool_call', tool: 'slide_render' } })).toEqual([{ tool: 'slide_render' }]);
    expect(one('codex', { type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'x', status: 'failed', error: { message: 'no' } } })).toEqual([{ error: 'x: no' }]);
    expect(one('opencode', { type: 'tool_use', sessionID: 's', part: { tool: 'execute', state: { input: { code: 'await tools.present.deck_outline({})' } } } })).toEqual([{ session: 's' }, { tool: 'deck_outline' }]);
    expect(one('opencode', { type: 'text', part: { text: 'done' } })).toEqual([{ text: 'done\n\n' }]);
  });
  it('tells the agent what the human pointed at', () => {
    const p = buildPrompt('Tighten this', [
      { kind: 'element', label: 'cause', slide: '02', step: 1, id: 'cause', text: 'Agents lack eyes' },
      { kind: 'capture', label: 'r', slide: '02', path: 'references/captures/a.png', ids: ['box', 'link'] },
      { kind: 'file', label: 'r', path: 'references/q3.pdf' },
    ], 'slide 2', true, []);
    expect(p).toContain('id "cause"');
    expect(p).toContain('references/captures/a.png');
    expect(p).toContain('covers ids: box, link');
    expect(p).toContain('references/q3.pdf');
    expect(p).toContain('catalog');
    expect(buildPrompt('Again', [], undefined, false, [])).not.toContain('catalog');
  });
});

describe('Studio app', () => {
  const t = tempDeck();
  const tool = resolve(t.dir, '.present', 'fake-agent.mjs');
  let dev: Awaited<ReturnType<typeof startDev>>, browser: Browser, page: Page;
  const errors: string[] = [];
  const preview = () => page.frameLocator('iframe');
  const prompt = () => readFileSync(join(t.dir, '.present', 'prompt.txt'), 'utf8');

  beforeAll(async () => {
    mkdirSync(join(t.dir, '.present'), { recursive: true });
    // Speaks Claude's protocol, records its prompt, and edits nothing.
    writeFileSync(tool, `import { writeFileSync } from 'node:fs';
let s = ''; process.stdin.on('data', d => s += d).on('end', () => {
  writeFileSync('.present/prompt.txt', s);
  const out = o => console.log(JSON.stringify(o));
  out({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__present__deck_outline' }] } });
  out({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'All done' } } });
  out({ type: 'result', session_id: 'sess-1' });
});`);
    dev = await startDev(t.dir, 0, { available: ['claude'], resolveCmd: () => ({ cmd: process.execPath, args: [tool] }) });
    browser = await chromium.launch({ channel: 'chrome' });
    page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' })).newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(dev.url + 'studio');
    await page.waitForFunction(() => !!(document.querySelector('iframe') as any)?.contentWindow?.__present);
    await page.locator('nav .thumb').first().waitFor();
  }, 60000);
  afterAll(async () => { await browser?.close(); await dev?.close(); t.done(); });

  it('refuses a rebound host', async () => {
    const http = await import('node:http');
    const u = new URL(dev.url);
    const code = await new Promise(ok => http.get({ host: u.hostname, port: u.port, path: '/studio', headers: { host: 'evil.example' } }, r => { r.resume(); ok(r.statusCode); }));
    expect(code).toBe(403);
  });
  it('lists the slides as pictures', async () => {
    await expect.poll(() => page.locator('nav .thumb').count()).toBe(6);
    await page.locator('nav .thumb img').first().evaluate(async (i: HTMLImageElement) => { await i.decode(); });
    expect(await page.locator('nav .thumb img').first().evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1920);
  }, 30000);
  it('attaches a clicked part', async () => {
    await page.locator('nav .thumb').nth(1).click();
    await page.getByRole('button', { name: /Select/ }).click();
    await preview().locator('#cause-text').click({ force: true });
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('.chip').allTextContents()).toContainEqual(expect.stringContaining('cause-text'));
  });
  it('circles a region into a marked screenshot with the ids inside it', async () => {
    const box = await preview().locator('#cause-text').boundingBox();
    await page.getByRole('button', { name: /Circle/ }).click();
    const cx = box!.x + box!.width / 2, cy = box!.y + box!.height / 2, r = Math.max(box!.width, box!.height) * .7;
    await page.mouse.move(cx + r, cy);
    await page.mouse.down();
    for (let a = 0; a <= 6.4; a += .4) await page.mouse.move(cx + r * Math.cos(a), cy + r * Math.sin(a));
    await page.mouse.up();
    await expect.poll(() => listReferences(t.dir).filter(f => f.name.includes('region')).length, { timeout: 20000 }).toBe(1);
    const png = readFileSync(join(t.dir, listReferences(t.dir).find(f => f.name.includes('region'))!.path));
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBeLessThan(1920);
  }, 40000);
  it('takes a full frame with S', async () => {
    await page.keyboard.press('s');
    await expect.poll(() => listReferences(t.dir).filter(f => f.path.startsWith('references/captures/') && !f.name.includes('region')).length, { timeout: 20000 }).toBe(1);
    const f = listReferences(t.dir).find(x => x.path.startsWith('references/captures/') && !x.name.includes('region'))!;
    expect(readFileSync(join(t.dir, f.path)).readUInt32BE(16)).toBe(1920);
  }, 30000);
  it('goes to the slide an agent changes, and can be told not to', async () => {
    const edit = (slide: string, title: string) => applyOps(t.dir, [{ op: 'setTitle', slide, title }], revisionOf(t.dir));
    const shown = () => preview().locator('section.p-slide').getAttribute('id');
    await page.locator('nav .thumb').first().click();
    expect(edit('04-a-frame', 'Followed').ok).toBe(true);
    await expect.poll(shown).toBe('04-a-frame');
    // A change to several slides at once has no one slide to go to, so the view stays and says so.
    expect(applyOps(t.dir, [{ op: 'setTitle', slide: '02-why-it-fails', title: 'Many A' }, { op: 'setTitle', slide: '05-results', title: 'Many B' }], revisionOf(t.dir)).ok).toBe(true);
    await expect.poll(() => page.locator('.toast').textContent()).toContain('changed 2 slides');
    expect(await shown()).toBe('04-a-frame');
    // A slide saved with nothing changed in it is not an edit.
    const same = join(t.dir, 'slides', '03-the-loop.slide');
    writeFileSync(same, readFileSync(same, 'utf8'));
    await page.waitForTimeout(600);
    expect(await shown()).toBe('04-a-frame');
    await page.getByRole('button', { name: 'Follow edits' }).click();
    expect(edit('06-close', 'Not followed').ok).toBe(true);
    await page.waitForTimeout(600);
    expect(await shown()).toBe('04-a-frame');
    await page.locator('nav .thumb').nth(1).click();
    expect(await page.getByRole('button', { name: 'Present' }).count()).toBe(0);   // a browser cannot reach other screens
  });
  it('takes dropped files and pasted images into references', async () => {
    const dropped = await page.evaluateHandle(() => { const d = new DataTransfer(); d.items.add(new File(['q3,41'], 'q3.csv', { type: 'text/csv' })); return d; });
    await page.dispatchEvent('main', 'dragenter', { dataTransfer: dropped });
    await page.dispatchEvent('.drop', 'drop', { dataTransfer: dropped });
    await expect.poll(() => listReferences(t.dir).some(f => f.name === 'q3.csv')).toBe(true);
    await page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = c.height = 8;
      const b: Blob = await new Promise(ok => c.toBlob(x => ok(x!)));
      const d = new DataTransfer(); d.items.add(new File([b], 'shot.png', { type: 'image/png' }));
      dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, cancelable: true }));
    });
    await expect.poll(() => listReferences(t.dir).some(f => f.name === 'shot.png' && f.path.includes('captures'))).toBe(true);
    await expect.poll(() => page.locator('aside').textContent()).toContain('q3.csv');
  });
  it('sends the question with everything attached, and shows the reply', async () => {
    await page.getByLabel('Message the agent').fill('Make this hit harder');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('.them').textContent(), { timeout: 15000 }).toContain('All done');
    expect(await page.locator('.steps code').textContent()).toBe('Read the outline');
    const p = prompt();
    expect(p).toContain('Make this hit harder');
    expect(p).toContain('id "cause-text"');
    expect(p).toContain('references/q3.csv');
    expect(p).toMatch(/covers ids:.*cause/);
    expect(p).toContain('slide 2');
    expect(await page.locator('.chip').count()).toBe(0);
    await page.getByRole('button', { name: 'Select' }).click();
    await page.getByLabel('Message the agent').focus();
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('.hint').count()).toBe(0);
  }, 30000);
  it('says what a slide\'s error is, and clears it when fixed', async () => {
    const file = join(t.dir, 'slides', '05-results.slide'), good = readFileSync(file, 'utf8');
    writeFileSync(file, `${good.trimEnd()}\n<a href="javascript:x()">y</a>\n`);
    await page.getByRole('button', { name: 'Show 1 error on slide 5' }).click({ timeout: 10000 });
    await expect.poll(() => page.locator('.problems').textContent()).toContain('javascript:x()');
    expect(await page.locator('.problems').textContent()).toContain('Use http(s) or #fragment');
    await page.getByRole('button', { name: 'Ask the agent to fix this' }).click();
    expect(await page.getByLabel('Message the agent').inputValue()).toContain('Fix this problem on 05-results');
    await page.getByLabel('Message the agent').fill('');
    writeFileSync(file, good);
    await expect.poll(() => page.locator('.status').textContent()).toContain('No problems');
  }, 20000);
  it('shows the plan as it arrives, tracks what is built, and takes a review', async () => {
    savePlan(t.dir, { goal: 'Show the loop works', audience: 'Engineers', minutes: 5, story: 'Claim, then proof.', questions: ['Keep slide 2?'], slides: [
      { id: '01-title', title: 'Opening', claim: 'Agents need eyes', pattern: 'statement' },
      { id: 'proof', title: 'Proof', claim: 'Three runs improved', pattern: 'evidence', animation: ['Line draws', 'Number counts up'], evidence: [{ claim: 'scores', source: 'evals/run.csv:12' }] },
    ] });
    await page.getByRole('region', { name: 'Plan' }).waitFor({ timeout: 8000 });
    const panel = page.getByRole('region', { name: 'Plan' });
    await expect.poll(() => panel.textContent()).toContain('1 of 2 built');
    for (const x of ['Line draws', 'evals/run.csv:12', 'Keep slide 2?', 'To build']) expect(await panel.textContent()).toContain(x);
    await page.getByLabel('Comment on the plan').fill('Add a baseline');
    await page.getByRole('button', { name: 'Request changes' }).click();
    await expect.poll(() => readPlan(t.dir)?.feedback[0]?.text).toBe('Add a baseline');
    expect(readPlan(t.dir)?.status).toBe('changes');
    // This chat has an agent in it, so the review goes straight to it.
    await expect.poll(() => panel.count()).toBe(0);
    await expect.poll(() => prompt()).toContain('plan_read');
    await expect.poll(() => page.locator('.busy').count(), { timeout: 15000 }).toBe(0);
    rmSync(join(t.dir, 'plan.yaml'));
  }, 30000);
  it('uses a macro added while it is running, as a library component would be', async () => {
    mkdirSync(join(t.dir, 'macros'), { recursive: true });
    writeFileSync(join(t.dir, 'macros', 'Fresh.ts'), "export default { doc: 'x', props: '', example: '', html: () => '<p id=\"fresh\"><slot/></p>' };");
    await page.waitForTimeout(400);
    const source = ['---', 'title: t', 'brief: b', '---', '<Fresh>Added live</Fresh>', ''].join('\n');
    const r = await fetch(`${dev.url}api/ops`, { method: 'POST', headers: { 'x-present-token': dev.token }, body: JSON.stringify({ ops: [{ op: 'addSlide', id: 'fresh', source }], baseRevision: revisionOf(t.dir) }) }).then(x => x.json());
    expect(r.ok, JSON.stringify(r).slice(0, 300)).toBe(true);
    await expect.poll(() => fetch(`${dev.url}api/problems?token=${dev.token}`).then(x => x.json()).then(l => l.filter((d: any) => d.severity === 'error').length)).toBe(0);
    expect(applyOps(t.dir, [{ op: 'removeSlide', id: 'fresh' }], revisionOf(t.dir)).ok).toBe(true);
  }, 20000);
  it('refuses a file served as active content', async () => {
    addReference(t.dir, 'x.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
    const r = await fetch(`${dev.url}api/reference-file?token=${dev.token}&path=references/x.svg`);
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
    expect(r.headers.get('content-disposition')).toBe('attachment');
    expect(r.headers.get('content-security-policy')).toContain('sandbox');
  });
  it('survives a request for a missing file', async () => {
    const r = await fetch(`${dev.url}api/reference-file?token=${dev.token}&path=references/captures/gone.png`);
    expect(r.status).toBe(400);
    expect((await fetch(`${dev.url}api/references?token=${dev.token}`)).status).toBe(200);
  });
  it('ran without a page error',() => { expect(errors).toEqual([]); });
  it('still needs the token', async () => {
    expect((await fetch(`${dev.url}api/references`)).status).toBe(403);
    expect((await fetch(`${dev.url}api/chat`, { method: 'POST', body: '{}' })).status).toBe(403);
    expect((await fetch(`${dev.url}api/frame?slide=1`)).status).toBe(403);
  });
});
