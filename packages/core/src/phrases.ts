// Phrases: named runs of cues, so a beat is written once and reused. A phrase is plain score data, which
// is what lets a deck add its own under `phrases:` in deck.yaml. A `{name}` in a cue is a parameter.
export interface Phrase { doc: string; params?: string; cues: any[]; }

export const PHRASES: Record<string, Phrase> = {
  arrive: {
    doc: 'A part lands: its stroke draws, its mark pops with a ring, its label rises. Works on every figure.',
    cues: [
      { draw: '$ .seg', dur: 420, optional: true },
      { pop: '$ .node', at: 340, optional: true },
      { ripple: '$ .node', at: 340, tone: 'accent', optional: true },
      { rise: '$ .body', at: 460, dur: 420, from: [0, 12], optional: true },
    ],
  },
  appear: { doc: 'A thing fades in rising. For cards and groups with no parts of their own.', cues: [{ rise: '$', dur: 480, from: [0, 14] }] },
  strike: {
    doc: 'A claim is crossed out: a Strike draws and a Badge pops inside each item.',
    cues: [{ draw: '$ .strike', dur: 380 }, { pop: '$ .badge', at: 260, optional: true }, { ripple: '$ .badge', at: 260, tone: 'danger', optional: true }],
  },
  handoff: {
    doc: 'Work moves along a Link: a particle runs it, then the target lights up.',
    params: 'link, to',
    cues: [{ draw: '{link}', dur: 360 }, { travel: '{link}', at: 200, dur: 520 }, { hot: '{to}', at: 620, dur: 900 }, { ripple: '{to}', at: 620 }],
  },
  verdict: {
    doc: 'A result lands with weight: the number counts up, then its mark pops.',
    params: 'number, mark',
    cues: [{ count: '{number}', dur: 1100 }, { pop: '{mark}', at: 900 }, { ripple: '{mark}', at: 900, tone: 'ok' }],
  },
  flood: {
    doc: 'Many things move along a path at once. Use it in a loop: it leaves nothing behind.',
    params: 'path',
    cues: [{ stream: '{path}', dur: 2600, n: 16, jitter: 8 }],
  },
  survey: {
    doc: 'A map comes up: its .ring lines fade in from the outside, then its part arrives.',
    cues: [{ fade: '.ring', dur: 420, stagger: 90 }, { use: 'arrive', on: '.part', at: 500 }],
  },
};
