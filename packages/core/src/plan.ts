// The plan: how an agent intends to build a deck, in a file both the agent and the human can see. It is
// checked against what exists, and read back beside what has actually been built.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { compileDeck, readDeck } from './deck.ts';
import { listLibrary } from './library.ts';
import { PATTERNS } from './patterns.ts';

export type PlanStatus = 'proposed' | 'changes' | 'approved';
export interface Evidence { claim?: string; source: string; }
export interface PlanSlide {
  id: string; title: string; claim: string;
  under?: string;                           // a deep dive: the planned slide it hangs under
  pattern?: string; component?: string;     // what it starts from: a built-in pattern, or a library item
  visual?: string;                          // what is on screen
  animation?: string[];                     // the beats, in order: one line per step
  evidence?: Evidence[];                    // where each fact comes from
  notes?: string;
}
export interface Feedback { id: string; slide?: string; text: string; at: string; open: boolean; }
export interface Plan {
  goal: string; audience?: string; minutes?: number; story?: string;
  sources?: { path: string; use?: string }[];
  slides: PlanSlide[];
  questions?: string[];                     // what the agent needs the human to decide
  status: PlanStatus; feedback: Feedback[]; updatedAt: string;
}
export type PlanInput = Omit<Plan, 'status' | 'feedback' | 'updatedAt'>;
export interface PlanIssue { severity: 'error' | 'warning'; slide?: string; message: string; fix: string; }
export type SlideState = 'planned' | 'built' | 'problem';

const file = (dir: string) => join(resolve(dir), 'plan.yaml');
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MINUTES_PER_SLIDE = 1.5;

export function readPlan(dir: string): Plan | null {
  const f = file(dir);
  if (!existsSync(f)) return null;
  const p = parse(readFileSync(f, 'utf8'));
  return p ? { feedback: [], status: 'proposed', slides: [], ...p } : null;
}
const write = (dir: string, p: Plan) => writeFileSync(file(dir), stringify({ ...p, updatedAt: new Date().toISOString() }));

/** Checks a plan against what the deck and library really hold, so a promise cannot be impossible. */
export function checkPlan(dir: string, p: Pick<Plan, 'slides' | 'minutes' | 'sources'>): PlanIssue[] {
  const root = resolve(dir), out: PlanIssue[] = [];
  const library = new Set(listLibrary().map(i => i.name)), seen = new Set<string>();
  const reference = (s: string, slide?: string) => {
    if (s.startsWith('references/') && !existsSync(join(root, s.split(/[#:]/)[0]))) out.push({ severity: 'warning', slide, message: `${s} is not in the deck`, fix: 'Add the file to references/, or cite where it really is' });
  };
  for (const s of p.sources ?? []) reference(s.path);
  for (const s of p.slides) {
    if (!SAFE_ID.test(s.id ?? '')) out.push({ severity: 'error', slide: s.id, message: `Bad slide id "${s.id}"`, fix: 'Use letters, numbers, - and _' });
    if (seen.has(s.id)) out.push({ severity: 'error', slide: s.id, message: `Slide id "${s.id}" is used twice`, fix: 'Ids must be unique' });
    seen.add(s.id);
    if (!s.claim?.trim()) out.push({ severity: 'warning', slide: s.id, message: 'No claim', fix: 'Say the one thing this slide argues' });
    if (s.pattern && !PATTERNS[s.pattern]) out.push({ severity: 'error', slide: s.id, message: `No pattern "${s.pattern}"`, fix: `Patterns: ${Object.keys(PATTERNS).join(', ')}` });
    if (s.component && !library.has(s.component)) out.push({ severity: 'error', slide: s.id, message: `No library item "${s.component}"`, fix: 'Check library in the catalog, or build it and save it' });
    // A number with no source is how an invented figure reaches a slide.
    const text = `${s.title ?? ''} ${s.claim ?? ''}`;
    if (/\d/.test(text.replace(/\b(19|20)\d\d\b/g, '')) && !s.evidence?.length) out.push({ severity: 'warning', slide: s.id, message: 'States a number with no evidence', fix: 'Add evidence: the file and where in it' });
    for (const e of s.evidence ?? []) reference(e.source, s.id);
  }
  for (const s of p.slides) if (s.under && !seen.has(s.under)) out.push({ severity: 'error', slide: s.id, message: `"${s.under}" is not in the plan`, fix: 'under must be the id of a planned slide' });
  const main = p.slides.filter(s => !s.under).length;    // deep dives are optional, so they cost no time
  if (p.minutes && main * MINUTES_PER_SLIDE > p.minutes * 1.25) out.push({ severity: 'warning', message: `${main} main slides is about ${Math.round(main * MINUTES_PER_SLIDE)} minutes, for a ${p.minutes} minute slot`, fix: 'Cut slides, or merge what can be said together' });
  return out;
}

/** Writing a plan sends it back for review. Comments stay until the agent says it dealt with them. */
export function savePlan(dir: string, input: PlanInput, resolved: string[] = []) {
  const issues = checkPlan(dir, input);
  if (issues.some(i => i.severity === 'error')) return { ok: false, issues };
  const old = readPlan(dir);
  const feedback = (old?.feedback ?? []).map(f => (resolved.includes(f.id) ? { ...f, open: false } : f));
  const plan: Plan = { ...input, status: 'proposed', feedback, updatedAt: '' };
  write(dir, plan);
  return { ok: true, issues, plan: readPlan(dir)! };
}

export interface PlanPatch extends Partial<Omit<PlanInput, 'slides'>> {
  slides?: (Partial<PlanSlide> & { id: string; after?: string })[];   // changed fields only; a new id adds a slide
  remove?: string[];
}

/** Change part of a plan without resending it. Slides are matched by id and merged field by field. */
export function patchPlan(dir: string, patch: PlanPatch, resolved: string[] = []) {
  const old = readPlan(dir);
  if (!old) throw new Error('This deck has no plan yet. Write one with plan_write.');
  const { status: _s, feedback: _f, updatedAt: _u, slides: before, ...fields } = old;
  const { slides: changes = [], remove = [], ...top } = patch;
  for (const id of remove) if (!before.some(s => s.id === id)) throw new Error(`No planned slide "${id}"`);
  const slides = before.filter(s => !remove.includes(s.id));
  for (const { after, ...change } of changes) {
    const at = slides.findIndex(s => s.id === change.id);
    if (after != null && !slides.some(s => s.id === after)) throw new Error(`No planned slide "${after}"`);
    if (at < 0 && !change.title) throw new Error(`New slide "${change.id}" needs a title and a claim`);
    const merged = { ...slides[at], ...change } as PlanSlide;
    if (at >= 0 && after == null) { slides[at] = merged; continue; }
    if (at >= 0) slides.splice(at, 1);
    slides.splice(after == null ? slides.length : slides.findIndex(s => s.id === after) + 1, 0, merged);
  }
  return savePlan(dir, { ...fields, ...top, slides }, resolved);
}

export function reviewPlan(dir: string, status: PlanStatus, comment?: { text: string; slide?: string }) {
  const p = readPlan(dir);
  if (!p) throw new Error('This deck has no plan yet');
  if (comment?.text.trim()) p.feedback.push({ id: `c${p.feedback.length + 1}`, slide: comment.slide, text: comment.text.trim(), at: new Date().toISOString(), open: true });
  p.status = status;
  write(dir, p);
  return readPlan(dir)!;
}

/** The plan beside the deck: what is done, what is not, and what was built that nobody planned. */
export function planProgress(dir: string) {
  const plan = readPlan(dir);
  if (!plan) return null;
  let order: string[] = [], errors = new Map<string, number>(), steps = new Map<string, number>();
  if (existsSync(join(resolve(dir), 'deck.yaml'))) {
    order = readDeck(dir).order;
    const { deck, diagnostics } = compileDeck(dir);
    steps = new Map(deck.slides.map(s => [s.id, s.phases.length - 1]));
    for (const d of diagnostics) if (d.severity === 'error' && d.slide) errors.set(d.slide, (errors.get(d.slide) ?? 0) + 1);
  }
  const slides = plan.slides.map(s => {
    const state: SlideState = !order.includes(s.id) ? 'planned' : errors.get(s.id) ? 'problem' : 'built';
    return { ...s, state, steps: steps.get(s.id) ?? 0, number: order.indexOf(s.id) + 1 };
  });
  const planned = new Set(plan.slides.map(s => s.id));
  return {
    ...plan, slides, unplanned: order.filter(id => !planned.has(id)),
    built: slides.filter(s => s.state === 'built').length, issues: checkPlan(dir, plan),
    openFeedback: plan.feedback.filter(f => f.open),
  };
}

/** The same plan for a terminal, where there is no Studio to show it. */
export function planMarkdown(p: Omit<Plan, 'slides'> & { slides: (PlanSlide & { state?: SlideState })[] }) {
  const line = (k: string, v?: string | number) => (v ? `**${k}:** ${v}\n` : '');
  const out = [`# Plan: ${p.goal}\n`, `Status: ${p.status}\n`, line('Audience', p.audience), line('Length', p.minutes && `${p.minutes} minutes`), line('Story', p.story)];
  if (p.sources?.length) out.push('## Sources\n', ...p.sources.map(s => `- ${s.path}${s.use ? `: ${s.use}` : ''}`), '');
  out.push('## Slides\n');
  p.slides.forEach((s, i) => {
    const mark = s.state === 'built' ? '[x]' : s.state === 'problem' ? '[!]' : '[ ]';
    out.push(`### ${mark} ${i + 1}. ${s.title}${s.under ? ` (deep dive under ${s.under})` : ''}\n`, `${s.claim}\n`);
    if (s.component || s.pattern) out.push(`- Starts from: ${s.component ? `library ${s.component}` : `pattern ${s.pattern}`}`);
    if (s.visual) out.push(`- On screen: ${s.visual}`);
    (s.animation ?? []).forEach((b, k) => out.push(`- Beat ${k + 1}: ${b}`));
    (s.evidence ?? []).forEach(e => out.push(`- Evidence: ${e.claim ? `${e.claim} from ` : ''}${e.source}`));
    out.push('');
  });
  if (p.questions?.length) out.push('## Questions for you\n', ...p.questions.map(q => `- ${q}`), '');
  return out.filter(x => x !== '').join('\n');
}
