// A deck outlives the version that made it. This says what has changed since, and brings it up to date.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { compileDeck, readDeck } from './deck.ts';
import { LOOP } from './guide.ts';

/** Raise this when a deck needs something done to it. A deck with no format: predates it. */
export const DECK_FORMAT = 2;

const guides = (root: string) => ['AGENTS.md', join('.claude', 'skills', 'present', 'SKILL.md')].flatMap(rel => {
  const p = join(root, rel);
  if (!existsSync(p)) return [];
  const old = readFileSync(p, 'utf8'), head = /^---[\s\S]*?---\n+/.exec(old.replace(/\r\n/g, '\n'))?.[0] ?? '';
  const want = head + LOOP;
  return old.replace(/\r\n/g, '\n') === want ? [] : [{ rel, p, want }];
});

/** Files it would change, and what only a person or an agent can do. dryRun writes nothing. */
export function upgradeDeck(dir: string, o: { dryRun?: boolean } = {}) {
  const root = resolve(dir), { meta } = readDeck(root), from = Number(meta.format ?? 1), stale = guides(root);
  const changes = [
    ...(from < DECK_FORMAT ? [{ file: 'deck.yaml', why: `Records format ${DECK_FORMAT}` }] : []),
    ...stale.map(g => ({ file: g.rel.replaceAll('\\', '/'), why: 'Its instructions are older than these tools' })),
  ];
  const manual = compileDeck(root).diagnostics.filter(d => d.code === 'hand-built-math').map(d => ({ slide: d.slide, message: d.message, fix: d.fix }));
  let backup: string | undefined;
  if (!o.dryRun && changes.length) {
    backup = join('.present', 'upgrade', new Date().toISOString().replace(/[:.]/g, '-'));
    for (const c of changes) {
      const to = join(root, backup, c.file);
      mkdirSync(dirname(to), { recursive: true });
      cpSync(join(root, c.file), to);
    }
    for (const g of stale) writeFileSync(g.p, g.want);
    if (from < DECK_FORMAT) {
      const f = join(root, 'deck.yaml'), doc = parseDocument(readFileSync(f, 'utf8'));
      doc.set('format', DECK_FORMAT);
      writeFileSync(f, doc.toString());
    }
  }
  return { from, to: DECK_FORMAT, dryRun: !!o.dryRun, upToDate: !changes.length && !manual.length, changes, manual, ...(backup ? { backup } : {}) };
}
