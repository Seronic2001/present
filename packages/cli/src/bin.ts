#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addFromLibrary, applyOps, compileDeck, groupDiagnostics, reuseReport, revisionOf, saveToLibrary, undo, upgradeDeck, hasErrors, deckOutline, libraryDir, listLibrary, removeFromLibrary, type Diagnostic } from '@present/core';
import { exportHtml, exportPdf, exportPng, exportPptx, Renderer } from '@present/render';
import { startDev } from '@present/studio';
import { connectClaude, connectCodex, connectDeck, serveMcp } from '@present/mcp';
import { init } from './init.ts';

const USAGE = `present <command> [deck folder]

  init [dir]                         new deck, with MCP config and agent instructions
  connect [dir]                      give Claude Code and Codex the tools in any folder
  studio [dir] [--port 4173] [--no-open]  Studio app: preview, references, screenshots, agent chat
  dev [dir] [--port 4173]            live preview with Studio (press I)
  check [dir] [--static]             diagnostics
  outline [dir]                      structure, timing and revision
  render <dir> <slide> [--step n] [--t ms] [--out f.png]
  filmstrip <dir> <slide> <step> [--out f.png] [--columns n]
  sheet <dir> [--out f.png] [--columns n] [--changed]   every slide on one image
  export <dir> html|pdf|png|pptx <out> [--steps]
  apply <dir> <ops.json>             run a batch of ops: a list, or { baseRevision, ops }
  undo <dir>                         roll back the last change, however it was made
  upgrade <dir> [--dry-run]          bring an older deck up to date
  library                            components saved across projects
  library add <name> [dir]           copy one into a deck
  library save <name> [dir] --doc "what it is" [--slide id]
  library remove <name>
  mcp [dir]                          MCP server on stdio`;

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1]; };
const has = (name: string) => argv.includes(`--${name}`);
const pos = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] ?? '').startsWith('--') || ['--static', '--steps', '--no-open', '--changed', '--dry-run'].includes(argv[i - 1]) && !a.startsWith('--'));
const cmd = pos[0];
const dir = pos[1] ?? '.';

const printDiags = (d: Diagnostic[]) => {
  const { errors, warnings, groups } = groupDiagnostics(d);
  for (const x of groups) console.log(`${x.severity === 'error' ? 'error  ' : 'warning'} ${x.code}: ${x.message}${x.count > 1 ? ` (x${x.count})` : ''}\n        in: ${x.slides.join(', ')}${x.ids?.length ? ` (${x.ids.join(', ')})` : ''}\n        fix: ${x.fix}`);
  console.log(`${errors} errors, ${warnings} warnings`);
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
  case 'connect':
    if (existsSync(join(dir, 'deck.yaml'))) console.log(`This deck is ready: ${connectDeck(dir)}`);
    console.log(connectClaude() ? 'Claude Code: ready in any folder' : 'Claude Code: not found, so not connected');
    console.log(connectCodex() ? 'Codex: ready in any folder' : 'Codex: not found, so not connected');
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
    const reuse = reuseReport(dir);
    for (const m of reuse.macroCandidates) console.log(`reuse   drawing of ${m.parts} parts repeats on ${m.slides.join(', ')}: make it a macro`);
    for (const p of reuse.phraseCandidates) console.log(`reuse   ${p.cues} repeats on ${p.slides.join(', ')}: make it a phrase`);
    if (reuse.nothingSaved) console.log(`reuse   ${reuse.nothingSaved}`);
    const up = upgradeDeck(dir, { dryRun: true });
    if (!up.upToDate) console.log(`upgrade ${up.changes.length} files out of date, ${up.manual.length} slides need a person: present upgrade ${dir} --dry-run`);
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
  case 'sheet': {
    const r = new Renderer(dir);
    const { png, shown, total } = await r.contactSheet({ changed: has('changed'), columns: flag('columns') ? +flag('columns')! : undefined });
    await r.close();
    const out = flag('out') ?? 'sheet.png';
    if (png) { writeFileSync(out, png); console.log(`${out}  ${shown.length} of ${total} slides`); } else console.log('Nothing changed since the last sheet');
    break;
  }
  case 'apply': {
    if (!pos[2]) { console.error(USAGE); process.exitCode = 2; break; }
    const given = JSON.parse(readFileSync(pos[2], 'utf8'));
    const r = applyOps(dir, given.ops ?? given, given.baseRevision ?? revisionOf(dir));
    if (r.diagnostics.length) printDiags(r.diagnostics);
    console.log(r.ok ? `Applied. Changed: ${r.changed.join(', ') || 'deck'}. Revision ${r.revision}` : r.error);
    process.exitCode = r.ok ? 0 : 1;
    break;
  }
  case 'undo': {
    const r = undo(dir);
    console.log(r.ok ? `Undone. Changed: ${r.changed.join(', ') || 'deck'}` : r.error);
    process.exitCode = r.ok ? 0 : 1;
    break;
  }
  case 'upgrade': {
    const r = upgradeDeck(dir, { dryRun: has('dry-run') });
    for (const c of r.changes) console.log(`${r.dryRun ? 'would change' : 'changed'}  ${c.file}: ${c.why}`);
    for (const m of r.manual) console.log(`by hand       ${m.slide}: ${m.message}. ${m.fix}`);
    if (r.backup) console.log(`Old files are in ${r.backup}`);
    if (r.upToDate) console.log('Up to date');
    break;
  }
  case 'filmstrip': {
    const r = new Renderer(dir);
    const no = await r.slideIndex(pos[2] ?? 1);
    await r.open();
    const out = flag('out') ?? `film-${no}.png`;
    writeFileSync(out, await r.filmstrip(no, +(pos[3] ?? 0), undefined, undefined, undefined, { columns: flag('columns') ? +flag('columns')! : undefined }));
    console.log(out);
    await r.close();
    break;
  }
  case 'export': {
    const format = pos[2], out = pos[3];
    if (!out) { console.error(USAGE); process.exitCode = 2; break; }
    if (format === 'html') { const r = await exportHtml(dir, out); console.log(`${out}  ${(r.bytes / 1e6).toFixed(2)} MB`); }
    else if (format === 'pdf') { await exportPdf(dir, out, has('steps')); console.log(out); }
    else if (format === 'pptx') { await exportPptx(dir, out, has('steps')); console.log(out); }
    else if (format === 'png') { console.log((await exportPng(dir, out, has('steps'))).files.join('\n')); }
    else { console.error(USAGE); process.exitCode = 2; }
    break;
  }
  case 'library': {
    const [, sub, name] = pos;
    if (sub === 'add') {
      const got = addFromLibrary(pos[3] ?? '.', name, { overwrite: has('overwrite') });
      console.log(got.added.length ? `Added ${got.added.join(', ')}` : 'Already in this deck');
      if (got.slide) console.log('It has a slide: ask an agent to add it, or copy it from the library folder.');
    } else if (sub === 'save') {
      if (!flag('doc')) { console.error(USAGE); process.exitCode = 2; break; }
      console.log(`Saved ${saveToLibrary(pos[3] ?? '.', { name, doc: flag('doc')!, slide: flag('slide') }).name}`);
    } else if (sub === 'remove') { removeFromLibrary(name); console.log(`Removed ${name}`); }
    else {
      console.log(libraryDir());
      for (const i of listLibrary()) console.log(`  ${i.name.padEnd(24)} ${i.doc}${i.code ? '  [code]' : ''}${i.auto ? '  [auto]' : ''}`);
    }
    break;
  }
  case 'mcp':
    await serveMcp(dir);
    break;
  default:
    console.log(USAGE);
    process.exitCode = cmd ? 2 : 0;
}
