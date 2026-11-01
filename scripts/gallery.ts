// Writes examples/patterns: one slide per pattern, as an agent would start from them.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PATTERNS } from '@present/core';

const dir = resolve('examples/patterns');
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, 'slides'), { recursive: true });
const names = Object.keys(PATTERNS);
for (const n of names) writeFileSync(join(dir, 'slides', `${n}.slide`), PATTERNS[n].source);
writeFileSync(join(dir, 'deck.yaml'), `title: Patterns\nmode: steps\nslides:\n${names.map(n => `  - ${n}\n`).join('')}`);
console.log(`${names.length} patterns in ${dir}`);
