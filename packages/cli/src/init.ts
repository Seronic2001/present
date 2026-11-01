import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOOP } from '@present/core';

const bin = join(dirname(fileURLToPath(import.meta.url)), 'bin.ts');

const FIRST = `---
title: A title worth saying out loud
brief: Opens the talk. Names the one idea the audience should leave with.
notes: Say the idea plainly, then move on.
score:
  intro:
    - rise: sub
      at: 700
---
<Center>
  <Eyebrow>Your event</Eyebrow>
  <Title>A title worth <em>saying out loud</em></Title>
  <Sub id="sub">One sentence on what this talk gives the room.</Sub>
</Center>
`;

export function init(dir: string) {
  const root = resolve(dir);
  mkdirSync(join(root, 'slides'), { recursive: true });
  if (existsSync(join(root, 'deck.yaml')) || readdirSync(join(root, 'slides')).length) throw new Error(`${root} already has a deck`);
  writeFileSync(join(root, 'deck.yaml'), 'title: Untitled talk\nmode: auto\nslides:\n  - 01-title\n');
  writeFileSync(join(root, 'slides', '01-title.slide'), FIRST);
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { present: { command: 'node', args: [bin, 'mcp', root] } } }, null, 2) + '\n');
  writeFileSync(join(root, 'AGENTS.md'), LOOP);
  const skill = join(root, '.claude', 'skills', 'present');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), `---\nname: present\ndescription: Build or edit this Present slide deck. Use for any change to slides, animation or speaker notes.\n---\n\n${LOOP}`);
  writeFileSync(join(root, '.gitignore'), '.present/\n');
  return root;
}
