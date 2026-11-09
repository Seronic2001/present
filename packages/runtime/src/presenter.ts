// The presenter's own window: this step, the next one, notes and clocks. It ships in every deck, so it
// works in an exported file too. It talks to the deck by postMessage, which works on file:// where
// BroadcastChannel does not reliably connect two windows.
import { slideLabels, type CompiledDeck, type CompiledSlide } from '../../core/src/compiled.ts';
import { applyShot, frame, W, type Shot } from './camera.ts';
import { Engine } from './engine.ts';
import { termCards, termIndex } from './terms.ts';

export const COMMANDS = ['next', 'prev', 'replay', 'black', 'toggleMode', 'end', 'down', 'up', 'dive', 'surface'] as const;
export type Command = typeof COMMANDS[number];

export interface ShowState {
  present: 'state';
  id: string; nextId: string | null; nextIsUp: boolean;
  label: string; total: number;      // total counts the main path
  deep: string[]; trail: string[];   // deep dive titles here, and the way back to the main path
  acts: Record<string, number>;      // actions played, so the pane shows the same picture
  seed: number;                      // what the slide's embedded pages draw their random numbers from
  spot: string | null;               // the part the audience is zoomed into
  phase: number; t: number; mode: string; black: boolean;   // t: how far into the step, to join it in time
}

export { slideLabels };
const BEAT = 50;
const pad = (n: number) => String(n).padStart(2, '0');
const clock = (ms: number) => `${pad(Math.floor(ms / 60000))}:${pad(Math.floor(ms / 1000) % 60)}`;

/** A slide as markup. In a thumbnail embedded pages do not run; give a seed for the pane that shows the live slide. */
export const stillSlide = (s: CompiledSlide, seed?: number) => `<section class="p-slide"${s.align ? ` data-align="${s.align}"` : ''}><div class="p-body">${seed == null ? s.html.replace(/ srcdoc="[^"]*"/g, '') : s.html.replaceAll('PRESENT_SEED', String(seed))}</div></section>`;

/** A slide at the end of a step. seek() is pure, so this is the same picture the audience gets. */
function draw(box: HTMLElement, slide: CompiledSlide, phase: number, t = slide.phases[phase].end + 1, seed?: number) {
  box.innerHTML = `<div class="ui-ov-inner">${stillSlide(slide, seed)}</div>`;
  fit(box);
  const engine = new Engine(box.querySelector('section')!, slide);
  engine.seek(phase, t, true);
  return engine;
}
const fit = (box: HTMLElement) => { (box.firstChild as HTMLElement).style.transform = `scale(${box.clientWidth / W})`; };

export function presenterView(first: CompiledDeck, host: HTMLElement) {
  let deck = first;
  const el = document.createElement('div');
  el.className = 'ui-presenter';
  el.innerHTML = `<header>
      <span id="u-slide"></span>
      <button id="u-timer" title="Pause or resume the timer"><span id="u-time">00:00</span></button>
      <button id="u-reset" title="Reset the timer">Reset</button>
      <span id="u-clock"></span>
    </header>
    <section class="now"><h2 class="u-h">On screen</h2><div class="u-pane" id="u-now"></div></section>
    <section class="side">
      <div id="u-trail"></div>
      <div><h2 class="u-h" id="u-next-label">Next</h2><div class="u-pane" id="u-next"></div></div>
      <div id="u-deep"></div>
      <div class="notes-wrap"><h2 class="u-h">Notes</h2><div id="u-notes"></div></div>
    </section>
    <footer>
      <button data-cmd="prev">Previous</button>
      <button data-cmd="next" class="primary">Next</button>
      <button data-cmd="replay">Replay</button>
      <button data-cmd="toggleMode" id="u-mode"></button>
      <button data-cmd="black" id="u-black">Black screen</button>
      <button data-cmd="dive" id="u-dive"></button>
      <button data-cmd="surface" id="u-up"></button>
      <span class="grow"></span>
      <button data-cmd="end">End show</button>
    </footer>`;
  host.appendChild(el);
  const $ = (id: string) => el.querySelector('#' + id) as HTMLElement;
  const main = window.opener as Window | null;
  const send = (cmd: Command) => {
    if (cmd === 'end' && (!main || main.closed)) window.close();   // the deck is gone, so nothing would answer
    else main?.postMessage({ present: 'cmd', cmd }, '*');
  };

  // ---- clocks: the timer can be paused, so it adds up running time rather than subtracting a start
  let ran = 0, since: number | null = Date.now();
  const tick = () => {
    $('u-time').textContent = clock(ran + (since === null ? 0 : Date.now() - since));
    $('u-clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  setInterval(tick, 1000);
  tick();
  $('u-timer').onclick = () => {
    if (since === null) since = Date.now(); else { ran += Date.now() - since; since = null; }
    $('u-timer').classList.toggle('paused', since === null);
    tick();
  };
  $('u-reset').onclick = () => { ran = 0; if (since !== null) since = Date.now(); tick(); };

  // ---- the show
  let last: ShowState | null = null;
  // The on-screen pane runs its own clock from the moment the deck reports, so it moves as the audience sees it.
  let live: { slide: CompiledSlide; seed: number; engine: Engine; phase: number; t0: number } | null = null, raf = 0;
  const run = (now: number) => {
    raf = 0;
    if (!live) return;
    const t = now - live.t0;
    live.engine.seek(live.phase, t);
    if (t < live.engine.settledAt(live.phase) + 50) raf = requestAnimationFrame(run);
  };
  const onScreen = (slide: CompiledSlide, s: ShowState) => {
    const box = $('u-now');
    const same = live?.slide === slide && live.seed === s.seed;
    const acted = same && JSON.stringify(live!.engine.acts) !== JSON.stringify(s.acts);
    if (acted) { live!.engine.acts = s.acts; live!.engine.seek(live!.phase, performance.now() - live!.t0, true); }
    if (same && live!.phase === s.phase) { fit(box); return; }   // a black screen or a resize, not a new moment
    if (same) { live!.engine.seek(s.phase, s.t, true); live!.phase = s.phase; }
    else { live = { slide, seed: s.seed, engine: draw(box, slide, s.phase, s.t, s.seed), phase: s.phase, t0: 0 }; live.engine.acts = s.acts; live.engine.seek(s.phase, s.t, true); }
    live!.t0 = performance.now() - s.t;
    if (!raf) raf = requestAnimationFrame(run);
  };
  // The pane zooms with the audience, at once rather than by the camera's move.
  let zoom: { id: string; shot: Shot } | null = null;
  const zoomTo = (id: string | null) => {
    const box = $('u-now'), body = box.querySelector<HTMLElement>('.p-body');
    if (zoom && !zoom.shot.body.isConnected) zoom = null;  // the slide was redrawn
    if (zoom?.id === id || !body) return;
    if (zoom) applyShot(zoom.shot, 0);
    zoom = null;
    const part = id ? body.querySelector(`[id="${CSS.escape(id)}"]`) : null;
    if (part) { zoom = { id: id!, shot: frame(body, part, box.clientWidth / W) }; applyShot(zoom.shot, 1); }
  };
  const paint = () => {
    const s = last;
    if (!s) return;
    const slide = deck.slides.find(x => x.id === s.id);
    if (!slide) return;
    const steps = slide.phases.length - 1, follow = deck.slides.find(x => x.id === s.nextId);
    $('u-slide').textContent = `${s.label} / ${s.total}  step ${s.phase}/${steps}  ${slide.title}`;
    $('u-trail').textContent = s.trail.length ? `Deep dive: ${[...s.trail, slide.title].join(' › ')}` : '';
    $('u-deep').textContent = s.deep.length ? `Can go deeper: ${s.deep.join(', ')}` : '';
    $('u-dive').textContent = `Dive in (${s.deep.length})`;
    $('u-dive').hidden = !s.deep.length;
    $('u-up').textContent = 'Back up';
    $('u-up').hidden = !s.trail.length;
    $('u-notes').textContent = slide.notes || '(no notes)';
    // It says what is true now, so that clicking it never looks like the wrong thing happened.
    $('u-mode').textContent = `Autoplay: ${s.mode === 'steps' ? 'Off' : 'On'}`;
    $('u-mode').setAttribute('aria-pressed', String(s.mode !== 'steps'));
    $('u-mode').classList.toggle('armed', s.mode !== 'steps');
    $('u-black').classList.toggle('on', s.black);
    el.classList.toggle('blacked', s.black);
    onScreen(slide, s);
    zoomTo(s.spot);
    // In step mode Next runs the next step; on autoplay it goes to the next slide and plays it through.
    const stepping = s.mode === 'steps' && s.phase < steps;
    $('u-next-label').textContent = stepping ? 'Next step' : s.nextIsUp ? 'Back up to' : 'Next slide';
    if (stepping) draw($('u-next'), slide, s.phase + 1);
    else if (follow) draw($('u-next'), follow, s.mode === 'steps' && !s.nextIsUp ? 0 : follow.phases.length - 1);
    else $('u-next').innerHTML = '<p class="end">End of the deck</p>';
  };
  new ResizeObserver(paint).observe($('u-now'));
  // Meanings on the live slide, so the presenter can read one before the room asks.
  const terms = termCards(el, {
    allowed: t => !!t.closest('#u-now'),
    // The room sees the same card: the deck finds the term by its place on the slide, the same in both copies.
    onChange: t => main?.postMessage({ present: 'term', slide: last?.id, i: t ? termIndex($('u-now'), t) : -1 }, '*'),
  });

  addEventListener('message', e => {
    const page = $('u-now').querySelector('iframe')?.contentWindow;
    if (page && e.source === page) {                     // the embedded page in the pane
      if (e.data?.present === 'key') dispatchEvent(new KeyboardEvent('keydown', { key: String(e.data.key) }));
      if (e.data?.present === 'embed') main?.postMessage(e.data, '*');
      return;
    }
    if (e.source !== main) return;
    if (e.data?.present === 'embed') page?.postMessage({ ...e.data, present: 'click' }, '*');
    if (e.data?.present === 'deck') { deck = e.data.deck; paint(); }
    if (e.data?.present === 'state') { last = e.data; paint(); terms.check(); }
  });
  el.addEventListener('click', e => {
    const acted = (e.target as HTMLElement).closest('#u-now [data-act]');
    if (acted) { main?.postMessage({ present: 'act', id: acted.getAttribute('data-act') }, '*'); return; }
    const jump = (e.target as HTMLElement).closest('#u-now [data-goto]');
    if (jump) { main?.postMessage({ present: 'goto', id: jump.getAttribute('data-goto') }, '*'); return; }
    const onSlide = (e.target as HTMLElement).closest('#u-now .ui-ov-inner');
    if (onSlide) { main?.postMessage({ present: 'pane', spot: (e.target as HTMLElement).closest('[data-spot]')?.id ?? null }, '*'); return; }
    const cmd = (e.target as HTMLElement).closest<HTMLElement>('[data-cmd]')?.dataset.cmd;
    if (cmd) send(cmd as Command);
  });
  addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (['ArrowRight', ' ', 'PageDown', 'Enter'].includes(k)) { e.preventDefault(); send('next'); }
    else if (['ArrowLeft', 'PageUp', 'Backspace'].includes(k)) { e.preventDefault(); send('prev'); }
    else if (k === 'ArrowDown') { e.preventDefault(); send('down'); }
    else if (k === 'ArrowUp') { e.preventDefault(); send('up'); }
    else if (k === 'd') send('dive');
    else if (k === 'u') send('surface');
    else if (k === 'b' || k === '.') send('black');
    else if (k === 'r') send('replay');
    else if (k === 's') send('toggleMode');
    else if (k === 'Escape') send('end');
    else if (['Home', 'End', 'z', 'm'].includes(k) || /^\d$/.test(k)) main?.postMessage({ present: 'key', key: k }, '*');
  });
  // A window that is covered gets no animation frames, and the presenter's window can be what covers the deck.
  // This one is on screen, so it keeps the deck's clock going.
  setInterval(() => main?.postMessage({ present: 'beat' }, '*'), BEAT);
  // Again on a timer: a deck that reloads (its tracks changed) forgets this window.
  main?.postMessage({ present: 'hello' }, '*');
  setInterval(() => main?.postMessage({ present: 'ping' }, '*'), 2000);
}
