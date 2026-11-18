// Browser entry: boots the player from the compiled deck embedded in the page.
import type { CompiledDeck } from '../../core/src/compiled.ts';
import { Player, type SeekTarget } from './player.ts';
import { presenterView } from './presenter.ts';
import { registerTrack, type TrackFactory } from './tracks.ts';
import { registerScene, type SceneFn } from './scene.ts';

declare global {
  interface Window {
    __present: {
      seek(t: SeekTarget): ReturnType<Player['state']>;
      ready(): Promise<void>;
      state(): ReturnType<Player['state']>;
      audit(): ReturnType<Player['audit']>;
      player: Player;
      track(name: string, f: TrackFactory): void;
    };
    Present: { track(name: string, f: TrackFactory): void; scene(name: string, f: SceneFn): void };
  }
}

window.Present = { track: registerTrack, scene: registerScene };

export function boot(deck: CompiledDeck) {
  if (new URLSearchParams(location.search).has('presenter')) { presenterView(deck, document.body); return; }
  const player = new Player(deck, document.body);
  const ready = (document.fonts as any).ready.then(() => undefined);
  window.__present = {
    player,
    ready: () => ready,
    seek: t => { player.seek(t); return player.state(); },
    state: () => player.state(),
    audit: () => player.audit(),
    track: registerTrack,
  };
}

const el = document.getElementById('present-deck');
// Maths fonts are loaded up front: a font fetched on first use would land after a screenshot, or mid-talk.
const mathFonts = () => Promise.allSettled([...document.fonts].filter(f => f.family.includes('KaTeX')).map(f => f.load()));
if (el) addEventListener('DOMContentLoaded', () => { mathFonts().then(() => document.fonts.ready).finally(() => boot(JSON.parse(el.textContent!))); });
