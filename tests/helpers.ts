import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const EXAMPLE = resolve('examples/launch-story');

/** A throwaway copy of the example deck. */
export function tempDeck() {
  const dir = mkdtempSync(join(tmpdir(), 'present-'));
  cpSync(EXAMPLE, dir, { recursive: true, filter: s => !s.includes('.present') });
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}
