import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Renderer } from '@present/render';

// Icons drawn with <use> and groups with an attribute transform must scale about their own centre.
const dir = mkdtempSync(join(tmpdir(), 'present-m-'));
mkdirSync(join(dir, 'slides'));
writeFileSync(join(dir, 'deck.yaml'), 'title: Motion\n');
writeFileSync(join(dir, 'slides', 'a.slide'), `---
title: Motion
brief: Scaling test
score:
  steps:
    - cues:
        - bump: [u, ic, g]
          dur: 1000
          ease: lin
          amount: .5
---
<Diagram viewBox="0 0 1600 600" alt="x">
  <defs><symbol id="sym" viewBox="0 0 24 24"><rect width="24" height="24" /></symbol></defs>
  <use id="u" href="#sym" x="1200" y="300" width="40" height="40" />
  <Icon id="ic" name="lock" x="800" y="300" size="40" />
  <g id="g" transform="translate(200 300)"><rect width="40" height="40" /></g>
</Diagram>
`);
const r = new Renderer(dir);
beforeAll(() => r.open().then(() => undefined), 60000);
afterAll(() => r.close());

it('keeps each centre fixed through a bump', async () => {
  const centres = () => r.page!.evaluate(() => ['u', 'ic', 'g'].map(id => {
    const q = document.getElementById(id)!.getBoundingClientRect();
    return [q.left + q.width / 2, q.top + q.height / 2, q.width];
  }));
  await r.seek({ slide: 1, step: 1, t: 0 });
  const rest = await centres();
  await r.seek({ slide: 1, step: 1, t: 500 });
  const peak = await centres();
  rest.forEach((c, i) => {
    expect(Math.abs(peak[i][0] - c[0]), 'x of ' + i).toBeLessThan(1);
    expect(Math.abs(peak[i][1] - c[1]), 'y of ' + i).toBeLessThan(1);
    expect(peak[i][2]).toBeGreaterThan(c[2] * 1.4);
  });
});
