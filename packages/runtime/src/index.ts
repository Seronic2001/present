// Browser entry: boots the player from the compiled deck embedded in the page.
import type { CompiledDeck } from '../../core/src/compiled.ts';
import { Player, presenterView, type SeekTarget } from './player.ts';
import { registerTrack, type TrackFactory } from './tracks.ts';

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
    Present: { track(name: string, f: TrackFactory): void };
  }
}

window.Present = { track: registerTrack };

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
if (el) addEventListener('DOMContentLoaded', () => { document.fonts.ready.finally(() => boot(JSON.parse(el.textContent!))); });
