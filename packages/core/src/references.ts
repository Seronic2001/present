// Source material for a deck: reports, docs, data, screenshots. It lives in references/ so it travels
// with the deck, stays out of the revision, and can be read by any agent through the same tools.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { confine } from './deck.ts';

export const REFERENCES = 'references';
export type ReferenceKind = 'image' | 'text' | 'document' | 'other';
export interface Reference { path: string; name: string; kind: ReferenceKind; bytes: number; modified: string; }

const IMAGE: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const TEXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.log', '.rst', '.tex', '.svg']);
const DOCUMENT = new Set(['.pdf', '.docx']);

export const imageMime = (path: string) => IMAGE[extname(path).toLowerCase()] ?? null;

function kindOf(path: string): ReferenceKind {
  const e = extname(path).toLowerCase();
  return IMAGE[e] ? 'image' : TEXT.has(e) ? 'text' : DOCUMENT.has(e) ? 'document' : 'other';
}

/** A path from outside, held to references/. */
function inside(dir: string, rel: string): string {
  const base = join(resolve(dir), REFERENCES), p = confine(dir, rel);
  if (!p.startsWith(base + sep)) throw new Error(`Not a reference: ${rel}`);
  return p;
}

export function listReferences(dir: string): Reference[] {
  const root = resolve(dir), base = join(root, REFERENCES), out: Reference[] = [];
  if (!existsSync(base)) return out;
  for (const e of readdirSync(base, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const full = join(e.parentPath, e.name), s = statSync(full);
    out.push({ path: relative(root, full).replaceAll(sep, '/'), name: e.name, kind: kindOf(e.name), bytes: s.size, modified: s.mtime.toISOString() });
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

/** Stores a file under a safe, unused name. An upload never overwrites. */
export function addReference(dir: string, name: string, bytes: Buffer, folder = ''): Reference {
  const clean = basename(name.replaceAll('\\', '/')).replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').trim() || 'file';
  const ext = extname(clean), stem = clean.slice(0, clean.length - ext.length);
  const parent = folder ? inside(dir, join(REFERENCES, folder)) : join(resolve(dir), REFERENCES);
  mkdirSync(parent, { recursive: true });
  let p = join(parent, clean);
  for (let i = 2; existsSync(p); i++) p = join(parent, `${stem}-${i}${ext}`);
  writeFileSync(p, bytes);
  return listReferences(dir).find(r => resolve(dir, r.path) === p)!;
}

export function removeReference(dir: string, path: string) {
  const p = inside(dir, path);
  if (!existsSync(p) || !statSync(p).isFile()) throw new Error(`No such reference: ${path}`);
  rmSync(p);
  return { removed: path };
}

export function referenceFile(dir: string, path: string) {
  const p = inside(dir, path);
  if (!existsSync(p) || !statSync(p).isFile()) throw new Error(`No such reference: ${path}`);
  return p;
}

async function pdfText(bytes: Buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(bytes), disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    const line = c.items.map((x: any) => (x.str ?? '') + (x.hasEOL ? '\n' : ' ')).join('');
    pages.push(`--- page ${i} ---\n${line.trim()}`);
  }
  await task.destroy();
  return pages.join('\n\n');
}

async function docxText(bytes: Buffer) {
  const { default: mammoth } = await import('mammoth');
  return (await mammoth.extractRawText({ buffer: bytes })).value;
}

export type ReferenceContent =
  | { kind: 'image'; path: string; mime: string; base64: string }
  | { kind: 'text'; path: string; text: string; offset: number; total: number; nextOffset: number | null }
  | { kind: 'unreadable'; path: string; message: string };

/** Text comes in windows so a long report does not arrive whole. */
export async function readReference(dir: string, path: string, opts: { offset?: number; limit?: number } = {}): Promise<ReferenceContent> {
  const p = referenceFile(dir, path), mime = imageMime(p), bytes = readFileSync(p);
  if (mime) return { kind: 'image', path, mime, base64: bytes.toString('base64') };
  const e = extname(p).toLowerCase();
  let text: string;
  if (e === '.pdf') text = await pdfText(bytes);
  else if (e === '.docx') text = await docxText(bytes);
  else if (TEXT.has(e)) text = bytes.toString('utf8');
  else return { kind: 'unreadable', path, message: `Cannot read ${e || 'this file type'} as text. Ask for a PDF, DOCX or CSV export.` };
  if (e === '.pdf' && !text.replace(/--- page \d+ ---/g, '').trim()) return { kind: 'unreadable', path, message: 'This PDF has no text layer, so it is probably scanned. Ask for screenshots of the pages that matter.' };
  const offset = Math.max(0, opts.offset ?? 0), limit = Math.min(100_000, Math.max(1, opts.limit ?? 20_000)), end = offset + limit;
  return { kind: 'text', path, text: text.slice(offset, end), offset, total: text.length, nextOffset: end < text.length ? end : null };
}
