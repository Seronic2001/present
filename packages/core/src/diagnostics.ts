export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning';
  slide?: string;
  id?: string;
  message: string;
  fix: string;
}
export const hasErrors = (d: Diagnostic[]) => d.some(x => x.severity === 'error');

export interface DiagnosticGroup { code: string; severity: 'error' | 'warning'; message: string; fix: string; count: number; slides: string[]; ids?: string[]; }
/** The same finding once, with where it occurs, so a deck with a repeated warning stays readable. */
export function groupDiagnostics(list: Diagnostic[]) {
  const groups = new Map<string, DiagnosticGroup>();
  for (const d of list) {
    const key = `${d.severity}|${d.code}|${d.message}`;
    const g = groups.get(key) ?? { code: d.code, severity: d.severity, message: d.message, fix: d.fix, count: 0, slides: [] };
    g.count++;
    if (d.slide && !g.slides.includes(d.slide)) g.slides.push(d.slide);
    if (d.id && !g.ids?.includes(d.id)) g.ids = [...(g.ids ?? []), d.id];
    groups.set(key, g);
  }
  const groupsList = [...groups.values()].sort((a, b) => Number(a.severity === 'warning') - Number(b.severity === 'warning') || b.count - a.count);
  const errors = list.filter(d => d.severity === 'error').length;
  return { errors, warnings: list.length - errors, groups: groupsList };
}
