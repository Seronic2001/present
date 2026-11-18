// Turns a compiled deck into one self-contained HTML document.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { MACROS, type CompiledDeck } from '@present/core';

const require = createRequire(import.meta.url);
const runtimeDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../runtime');

let runtimeJs: string | null = null;
export async function runtimeBundle(): Promise<string> {
  if (runtimeJs) return runtimeJs;
  const r = await esbuild.build({
    entryPoints: [join(runtimeDir, 'src/index.ts')], bundle: true, format: 'iife', minify: true,
    write: false, target: 'es2022', logLevel: 'silent',
  });
  return (runtimeJs = r.outputFiles[0].text);
}

/** KaTeX's styles with its fonts inside them. Only a deck with a formula carries this. */
export function mathCss(): string {
  const dist = join(dirname(require.resolve('katex/package.json')), 'dist');
  return readFileSync(join(dist, 'katex.min.css'), 'utf8').replace(/src:url\(fonts\/([\w-]+\.woff2)\)[^;}]*/g, (_, f) =>
    `src:url("data:font/woff2;base64,${readFileSync(join(dist, 'fonts', f)).toString('base64')}") format("woff2")`);
}

export function fontCss(): string {
  const pkg = (name: string) => dirname(require.resolve(`${name}/package.json`, { paths: [runtimeDir] }));
  const face = (family: string, weight: number, file: string, format: string, range = '') =>
    `@font-face{font-family:"${family}";font-weight:${weight};font-style:normal;font-display:block;${range}src:url("data:font/${format};base64,${readFileSync(file).toString('base64')}") format("${format === 'otf' ? 'opentype' : 'woff2'}");}`;
  const mona = pkg('@fontsource/mona-sans'), inter = pkg('@fontsource/inter');
  const greek = 'unicode-range:U+0370-03FF,U+1F00-1FFF;';
  return [
    ...[400, 500, 600, 700].map(w => face('Mona Sans', w, join(mona, `files/mona-sans-latin-${w}-normal.woff2`), 'woff2')),
    ...[[400, 'Regular'], [500, 'Medium'], [600, 'SemiBold']].map(([w, n]) => face('Mona Sans Mono', w as number, join(runtimeDir, `fonts/MonaSansMono-${n}.otf`), 'otf')),
    ...[400, 500].flatMap(w => [
      face('Inter', w, join(inter, `files/inter-latin-${w}-normal.woff2`), 'woff2'),
      face('Inter', w, join(inter, `files/inter-greek-${w}-normal.woff2`), 'woff2', greek),
    ]),
  ].join('\n');
}

/** Custom tracks: each tracks/<name>.ts default-exports (el, args, api) => apply(p). Scenes: each
 *  scenes/<name>.ts default-exports (ctx) => void. Both are the deck's own code, bundled into the page. */
export async function tracksBundle(dir: string): Promise<string> {
  const root = resolve(dir), list = (kind: string) => {
    const d = join(root, kind);
    return existsSync(d) ? readdirSync(d).filter(f => /\.(ts|js|mjs)$/.test(f)).map(f => ({ kind, f })) : [];
  };
  const files = [...list('tracks'), ...list('scenes')];
  if (!files.length) return '';
  const entry = files.map(({ kind, f }, i) => `import t${i} from ${JSON.stringify(`./${kind}/${f}`)};\nPresent.${kind === 'tracks' ? 'track' : 'scene'}(${JSON.stringify(basename(f).replace(/\.\w+$/, ''))}, t${i});`).join('\n');
  try {
    const r = await esbuild.build({
      stdin: { contents: entry, resolveDir: root, loader: 'ts' }, bundle: true, format: 'iife', minify: true, write: false, logLevel: 'silent',
    });
    return r.outputFiles[0].text;
  } catch (e: any) {
    const why = (e.errors ?? []).map((x: any) => `${x.location?.file ?? ''}:${x.location?.line ?? ''} ${x.text}`).join('; ') || String(e.message);
    throw new Error(`tracks/ and scenes/ do not build: ${why}`);
  }
}

/** Project macros: each macros/<Name>.ts default-exports a macro definition. Trusted code. */
export async function loadProjectMacros(dir: string) {
  const m = join(resolve(dir), 'macros');
  if (!existsSync(m)) return;
  for (const f of readdirSync(m).filter(x => /\.(ts|js|mjs)$/.test(x))) {
    // By modified time, so an edited or newly added macro takes effect without a restart.
    const url = pathToFileURL(join(m, f));
    url.searchParams.set('t', String(statSync(join(m, f)).mtimeMs));
    const def = await import(url.href).then(x => x.default, e => { throw new Error(`macros/${f}: ${e.message}`); });
    if (!def?.html && !def?.svg) throw new Error(`macros/${f} must default-export { doc, props, example, svg?, html? }. See writingMacros in the catalog.`);
    MACROS[basename(f).replace(/\.\w+$/, '')] = { doc: '', props: '', example: '', ...def };
  }
}

const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const safeJs = (s: string) => s.replace(/<\/script/gi, '<\\/script');

export async function deckHtml(deck: CompiledDeck, dir: string, extraHead = '', extraBody = ''): Promise<string> {
  const theme = readFileSync(join(runtimeDir, 'src/theme.css'), 'utf8');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(deck.title)}</title>
<style>${fontCss()}</style>${deck.slides.some(s => s.html.includes('class="katex')) ? `<style>${mathCss()}</style>` : ''}
<style>${theme}\n${deck.css}</style>${extraHead}
</head><body>
<script type="application/json" id="present-deck">${safeJson(deck)}</script>
<script>${safeJs(await runtimeBundle())}</script>
<script>${safeJs(await tracksBundle(dir))}</script>${extraBody}
</body></html>`;
}
