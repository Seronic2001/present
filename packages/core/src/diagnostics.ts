export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning';
  slide?: string;
  id?: string;
  message: string;
  fix: string;
}
export const hasErrors = (d: Diagnostic[]) => d.some(x => x.severity === 'error');
