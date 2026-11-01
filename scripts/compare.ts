// Private fixture check: reference vs port at the same frame.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Renderer } from '@present/render';
import { compileDeck } from '@present/core';
const dir = 'fixtures/reference';
const { diagnostics } = compileDeck(dir);
console.log(diagnostics.filter(d => d.severity === 'error').slice(0, 20), 'warnings', diagnostics.filter(d => d.severity === 'warning').length);
const r = new Renderer(dir);
await r.open();
const ctx = await r.browser!.newContext({ viewport: { width: 1920, height: 1080 } });
const ref = await ctx.newPage();
await ref.goto(pathToFileURL(resolve('01-learnings-from-enterprise-rl.html')).href + '?still');
for (const [no, n] of [[1, 3], [2, 5], [3, 9]] as const) {
  const { png } = await r.frame({ slide: no });
  writeFileSync(`tests/.port-${n}.png`, png);
  await ref.evaluate(k => (window as any).show(k - 1), n);
  await ref.waitForTimeout(300);
  await ref.screenshot({ path: `tests/.ref-${n}.png` });
}
const all = await r.checkAll();
console.log(JSON.stringify(all.filter(d => d.code !== 'raw-colour').map(d => [d.slide, d.code, d.id, d.message]).slice(0, 30)));
await r.close();
