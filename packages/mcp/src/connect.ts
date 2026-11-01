// How agents reach this server. Studio's chat and an agent in a terminal launch the same command,
// so a deck behaves the same whichever one is editing it.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';
import { DECK_FORMAT, LOOP } from '@present/core';

const bin = join(dirname(fileURLToPath(import.meta.url)), 'bin.ts');

export interface McpLaunch { command: string; args: string[]; env?: Record<string, string>; }

/** In the desktop app this process is Electron acting as Node, and the server must run the same way. */
export function mcpLaunch(dir: string): McpLaunch {
  return {
    command: process.execPath, args: [bin, resolve(dir)],
    ...(process.env.ELECTRON_RUN_AS_NODE ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {}),
  };
}

function writeClaude(root: string, launch: McpLaunch) {
  const file = join(root, '.mcp.json');
  // An unreadable config is refused rather than replaced: it may hold the human's other servers.
  const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  config.mcpServers = { ...config.mcpServers, present: launch };
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
}

/** Codex takes servers from its user config, not from the folder. So this is one entry, with no deck
 *  in it: the server serves whichever folder Codex was started in. */
export function codexArgs(launch: McpLaunch) {
  return ['mcp', 'add', ...Object.entries(launch.env ?? {}).flatMap(([k, v]) => ['--env', `${k}=${v}`]), 'present', '--', launch.command, launch.args[0]];
}
export function connectCodex() {
  return spawn.sync('codex', codexArgs(mcpLaunch('.')), { stdio: 'ignore' }).status === 0;
}
/** The same for Claude Code, so it has the tools in a finished project that has no deck yet. */
export function claudeArgs(launch: McpLaunch) {
  return ['mcp', 'add', '--scope', 'user', ...Object.entries(launch.env ?? {}).flatMap(([k, v]) => ['--env', `${k}=${v}`]), 'present', '--', launch.command, launch.args[0]];
}
export function connectClaude() {
  spawn.sync('claude', ['mcp', 'remove', '--scope', 'user', 'present'], { stdio: 'ignore' });   // adding refuses a name in use
  return spawn.sync('claude', claudeArgs(mcpLaunch('.')), { stdio: 'ignore' }).status === 0;
}

/** Points Claude Code at this deck and leaves the instructions any agent reads. Safe to run again. */
export function connectDeck(dir: string) {
  const root = resolve(dir);
  if (!existsSync(join(root, 'deck.yaml'))) throw new Error(`${root} has no deck.yaml`);
  writeClaude(root, mcpLaunch(root));
  if (!existsSync(join(root, 'AGENTS.md'))) writeFileSync(join(root, 'AGENTS.md'), LOOP);
  const skill = join(root, '.claude', 'skills', 'present', 'SKILL.md');
  if (!existsSync(skill)) {
    mkdirSync(dirname(skill), { recursive: true });
    writeFileSync(skill, `---\nname: present\ndescription: Build or edit this Present slide deck. Use for any change to slides, animation or speaker notes.\n---\n\n${LOOP}`);
  }
  return root;
}

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

/** A new deck, ready for agents. Refuses a folder that already holds one. */
export function createDeck(dir: string, title = 'Untitled talk') {
  const root = resolve(dir);
  mkdirSync(join(root, 'slides'), { recursive: true });
  if (existsSync(join(root, 'deck.yaml')) || readdirSync(join(root, 'slides')).length) throw new Error(`${root} already has a deck`);
  writeFileSync(join(root, 'deck.yaml'), `title: ${JSON.stringify(title)}\nformat: ${DECK_FORMAT}\nmode: auto\nslides:\n  - 01-title\n`);
  writeFileSync(join(root, 'slides', '01-title.slide'), FIRST);
  writeFileSync(join(root, '.gitignore'), '.present/\n');
  return connectDeck(root);
}
