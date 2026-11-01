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
export interface Phase { name: string; tracks: Track[]; loops: Loop[]; end: number; }
export interface Spot { id: string; n: number; tracks: Track[]; end: number; }
export interface CompiledSlide {
  id: string; title: string; brief: string; notes: string;
  html: string;
  phases: Phase[];           // [0] is the intro
  spots: Spot[];
  rest: number | 'always';   // ms after a build settles before loops stop
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
