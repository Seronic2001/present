// esbuild loads these as text for the Studio page.
declare module '*.svg' { const text: string; export default text; }
declare module '*.css' { const text: string; export default text; }
