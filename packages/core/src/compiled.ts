// The compiled deck: plain JSON. Everything the runtime needs, nothing it has to work out.
export type Ease = 'lin' | 'out' | 'inOut' | 'back' | 'sine';

export interface Track {
  k: string;                 // cue kind
  n: number;                 // target: data-n of the element in the slide
  s: number;                 // start, ms from the phase's start
  d: number;                 // duration, ms
  e: Ease;
  a?: Record<string, any>;   // cue arguments
  c?: string;                // where the cue lives in the score, e.g. steps.1.cues.0
}
export interface Loop { every: number; after: number; len: number; tracks: Track[]; }
/** auto: in step mode, go on by itself this many ms after the build ends. */
export interface Phase { name: string; tracks: Track[]; loops: Loop[]; end: number; auto?: number; }
/** A scene's timing, measured by replaying it in a browser. builds: when each step's build ends; rests: when its loops stop. */
export interface SceneTiming { durs: number[]; rests: (number | null)[]; builds: number[]; names: string[]; }
export interface Spot { id: string; n: number; tracks: Track[]; end: number; }
/** Cues a click plays. alt: a choice other than the first in its group, so not part of the finished drawing. */
export interface Action { id: string; tracks: Track[]; end: number; toggle?: boolean; group?: string; alt?: boolean; }
export interface CompiledSlide {
  id: string; title: string; brief: string; notes: string;
  html: string;
  phases: Phase[];           // [0] is the intro
  spots: Spot[];
  actions?: Action[];        // what clicking a part with act= plays
  rest: number | 'always';   // ms after a build settles before loops stop
  parent?: string;           // a deep dive: the slide it hangs under
  depth?: number;            // 0 is the main path
  align?: 'top';             // pinned to the top, rather than centred
  mode?: 'auto' | 'steps';   // this slide's own, over the deck's
  scale?: number;            // the whole slide's content, larger or smaller
  scene?: { name: string; n: number; measured: boolean };   // n: the root the scene owns
}
export interface CompiledDeck {
  title: string;
  mode: 'auto' | 'steps';
  motion: 'auto' | 'on';
  dwell: number;
  css: string;
  slides: CompiledSlide[];
  revision: string;
}

/** Where each slide sits: 5 on the main path, 5.2 in a deep dive under it. */
export function slideLabels(slides: Pick<CompiledSlide, 'id' | 'parent'>[]) {
  const labels = new Map<string, string>(), counts = new Map<string, number>();
  for (const s of slides) {
    const key = s.parent ?? '', n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    labels.set(s.id, s.parent ? `${labels.get(s.parent) ?? '?'}.${n}` : String(n));
  }
  return labels;
}
