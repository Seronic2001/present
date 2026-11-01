#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { compileDeck, hasErrors, deckOutline, type Diagnostic } from '@present/core';
import { exportHtml, exportPdf, exportPng, Renderer } from '@present/render';
import { startDev } from '@present/studio';
import { init } from './init.ts';
import { serveMcp } from './mcp.ts';

const USAGE = `present <command> [deck folder]

  init [dir]                         new deck, with MCP config and agent instructions
  studio [dir] [--port 4173] [--no-open]  Studio app: preview, references, screenshots, agent chat
  dev [dir] [--port 4173]            live preview with Studio (press I)
  check [dir] [--static]             diagnostics
  outline [dir]                      structure, timing and revision
  render <dir> <slide> [--step n] [--t ms] [--out f.png]
  filmstrip <dir> <slide> <step> [--out f.png]
  export <dir> html|pdf|png <out> [--steps]
  mcp [dir]                          MCP server on stdio`;

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1]; };
const has = (name: string) => argv.includes(`--${name}`);
const pos = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] ?? '').startsWith('--') || (argv[i - 1] === '--static' || argv[i - 1] === '--steps' || argv[i - 1] === '--no-open') && !a.startsWith('--'));
const cmd = pos[0];
const dir = pos[1] ?? '.';

const printDiags = (d: Diagnostic[]) => {
  for (const x of d) console.log(`${x.severity === 'error' ? 'error  ' : 'warning'} ${x.slide ?? ''}${x.id ? '#' + x.id : ''} ${x.code}: ${x.message}\n        fix: ${x.fix}`);
  const e = d.filter(x => x.severity === 'error').length;
  console.log(`${e} errors, ${d.length - e} warnings`);
};

/** A window of its own where the browser allows it. */
function openApp(url: string) {
  const [c, ...a] = process.platform === 'win32' ? ['cmd', '/c', 'start', '', 'msedge', `--app=${url}`]
    : process.platform === 'darwin' ? ['open', '-na', 'Google Chrome', '--args', `--app=${url}`]
    : ['xdg-open', url];
  spawn(c, a, { stdio: 'ignore', detached: true }).on('error', () => console.log(`Open ${url} in Chrome or Edge`)).unref();
}

switch (cmd) {
  case 'init':
    console.log(`Deck created in ${init(dir)}. Next: present dev ${dir}`);
    break;
  case 'studio': {
    const s = await startDev(dir, Number(flag('port') ?? 4173));
    console.log(`Present Studio at ${s.url}studio`);
    if (!has('no-open')) openApp(`${s.url}studio`);
    break;
  }
  case 'dev': {
    const s = await startDev(dir, Number(flag('port') ?? 4173));
    console.log(`Present at ${s.url}  (press I for Studio)`);
    break;
  }
  case 'check': {
    if (has('static')) { const { diagnostics } = compileDeck(dir); printDiags(diagnostics); process.exitCode = hasErrors(diagnostics) ? 1 : 0; break; }
    const r = new Renderer(dir);
    const d = await r.checkAll();
    await r.close();
    printDiags(d);
    process.exitCode = hasErrors(d) ? 1 : 0;
    break;
  }
  case 'outline':
    console.log(JSON.stringify(deckOutline(dir), null, 2));
    break;
  case 'render': {
    const r = new Renderer(dir);
    const no = await r.slideIndex(pos[2] ?? 1);
    const { png, state } = await r.frame({ slide: no, step: flag('step') ? +flag('step')! : undefined, t: flag('t') ? +flag('t')! : undefined });
    const out = flag('out') ?? `slide-${no}.png`;
    writeFileSync(out, png);
    console.log(out, state);
    await r.close();
    break;
  }
  case 'filmstrip': {
    const r = new Renderer(dir);
    const no = await r.slideIndex(pos[2] ?? 1);
    await r.open();
    const out = flag('out') ?? `film-${no}.png`;
    writeFileSync(out, await r.filmstrip(no, +(pos[3] ?? 0)));
    console.log(out);
    await r.close();
    break;
  }
  case 'export': {
    const format = pos[2], out = pos[3];
    if (!out) { console.error(USAGE); process.exitCode = 2; break; }
    if (format === 'html') { const r = await exportHtml(dir, out); console.log(`${out}  ${(r.bytes / 1e6).toFixed(2)} MB`); }
    else if (format === 'pdf') { await exportPdf(dir, out, has('steps')); console.log(out); }
    else if (format === 'png') { console.log((await exportPng(dir, out, has('steps'))).files.join('\n')); }
    else { console.error(USAGE); process.exitCode = 2; }
    break;
  }
  case 'mcp':
    await serveMcp(dir);
    break;
  default:
    console.log(USAGE);
    process.exitCode = cmd ? 2 : 0;
}
