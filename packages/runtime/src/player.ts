// The presenter: one clock, three ways of driving it (autoplay, step, still), plus everything
// around the slide. All state changes end in engine.seek, so a frame never depends on history.
import type { CompiledDeck, CompiledSlide } from '../../core/src/compiled.ts';
import { termCards, termIndex, type TermCards } from './terms.ts';
import { Engine } from './engine.ts';
import { applyShot, CAMERA_MS, frame, H, W, type Shot } from './camera.ts';
import { audit } from './audit.ts';
import { COMMANDS, slideLabels, stillSlide, type Command, type ShowState } from './presenter.ts';

const BEAT_LATE = 120, BAR_IDLE = 2500, AUTO_MAX = 10000, SWIPE = 50;
const icon = (d: string) => `<svg viewBox="0 0 16 16"><path d="${d}"/></svg>`;
const ICONS = {
  prev: 'M10 3 5 8l5 5', next: 'M6 3l5 5-5 5', replay: 'M3 8a5 5 0 1 0 1.6-3.7M3 2v3h3',
  grid: 'M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z', full: 'M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4',
  help: 'M6 6a2 2 0 1 1 3 1.7c-.7.4-1 .8-1 1.5M8 12v.2',
};
type Mode = 'auto' | 'steps' | 'still';
export interface SeekTarget { slide?: number; step?: number; t?: number; spot?: string; spotT?: number; actions?: Record<string, number>; }

export class Player {
  deck: CompiledDeck;
  order: CompiledSlide[];
  idx = 0;
  phase = 0;
  t = 0;
  t0 = 0;
  mode: Mode;
  frozen = false;           // seek() holds the clock until the next user action
  forced = false;           // the presenter chose a mode, which then beats each slide's own
  reduced: boolean;
  engine!: Engine;
  section!: HTMLElement;
  stage: HTMLElement;
  scale = 1;
  raf = 0;
  lastTick = 0;
  heldSpot: string | null = null;   // the spot a seek is holding open
  spot: { id: string; el: Element; shot: Shot; c: number; dir: 1 | -1; t: number } | null = null;
  bar!: HTMLElement;
  barT = 0;
  toastEl!: HTMLElement;
  ov!: HTMLElement;
  helpEl!: HTMLElement;
  terms!: TermCards;
  count!: HTMLElement;
  digits = '';
  digitT = 0;
  popup: Window | null = null;
  hosted = false;           // a preview in Studio turned into a show: Studio owns this frame and its address
  moving: Record<string, 1 | -1> = {};   // actions under way, and which way
  seed = 1;                 // of the slide on stage, shared with the presenter's copy of its embedded pages
  audience = false;         // ?show: the audience's window, with no controls on it
  blackEl!: HTMLElement;
  blacked = false;
  listeners: ((s: ReturnType<Player['state']>) => void)[] = [];

  constructor(deck: CompiledDeck, host: HTMLElement) {
    const q = new URLSearchParams(location.search);
    this.deck = deck;
    const only = (q.get('only') ?? '').split(',').map(x => parseInt(x, 10)).filter(n => n >= 1 && n <= deck.slides.length);
    this.order = only.length ? [...new Set(only)].map(n => deck.slides[n - 1]) : deck.slides;
    this.audience = q.has('show');
    this.mode = q.has('still') ? 'still' : q.has('steps') ? 'steps' : deck.mode;
    const os = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.reduced = os && deck.motion === 'auto' && !q.has('motion');
    const view = document.createElement('div');
    view.className = 'p-view';
    this.stage = document.createElement('div');
    this.stage.className = 'p-stage';
    view.appendChild(this.stage);
    host.appendChild(view);
    this.fit();
    addEventListener('resize', () => this.fit());
    // Meanings work in every mode, the still preview too: they belong to the slide, not to the show's controls.
    this.terms = termCards(host, { allowed: el => !!this.section?.contains(el) && !(window as any).__presentStudioActive });
    if (this.mode !== 'still') this.buildUi(host);
    const fromHash = parseInt(location.hash.slice(1), 10);
    const start = this.order.findIndex(s => deck.slides.indexOf(s) + 1 === fromHash);
    this.show(start >= 0 ? start : 0, { instant: this.mode === 'still' });
    if (this.reduced) this.toast('Reduced motion is on. Press M for full motion.');
  }

  // ---- geometry
  fit() {
    const k = Math.min(innerWidth / W, innerHeight / H);
    this.scale = k;
    this.stage.style.transform = `translate(${(innerWidth - W * k) / 2}px, ${(innerHeight - H * k) / 2}px) scale(${k})`;
  }

  // ---- slides
  private mount(i: number) {
    const s = document.createElement('section');
    s.className = 'p-slide';
    s.id = this.order[i].id;
    if (this.order[i].align) s.dataset.align = this.order[i].align;
    this.seed = this.mode === 'still' ? 1 : Math.floor(Math.random() * 2 ** 31);   // a still is a known picture
    const zoom = this.order[i].scale ? ` style="zoom:${this.order[i].scale}"` : '';
    s.innerHTML = `<div class="p-body"${zoom}>${this.order[i].html.replaceAll('PRESENT_SEED', String(this.seed))}</div>`;
    for (const f of s.querySelectorAll('iframe')) f.addEventListener('load', () => { f.dataset.ready = ''; }, { once: true });
    this.stage.appendChild(s);
    this.section = s;
    this.engine = new Engine(s, this.order[i]);
    this.moving = {};
    this.engine.acts = this.mode === 'still' ? undefined : {};
  }
  private lastPhase() { return this.order[this.idx].phases.length - 1; }
  /** The mode this slide plays in: its own, unless the presenter picked one, or the deck's. */
  private slideMode(): Mode {
    if (this.mode === 'still' || this.forced) return this.mode;
    return this.order[this.idx]?.mode ?? this.mode;
  }

  show(i: number, o: { dir?: number; last?: boolean; quiet?: boolean; instant?: boolean; phase?: number; axis?: 'x' | 'y' } = {}) {
    this.terms?.hide();
    this.closeSpot(true);
    this.frozen = false;
    this.ovToggle(false);
    const old = this.section;
    this.idx = Math.max(0, Math.min(this.order.length - 1, i));
    this.mount(this.idx);
    const instant = o.instant || this.reduced || this.mode === 'still';
    this.phase = o.last || this.mode === 'still' ? this.lastPhase() : (o.phase ?? 0);
    this.t = o.last || instant ? 1e9 : 0;
    if (this.reduced && !o.last && this.mode !== 'still') this.phase = this.lastPhase();
    this.t0 = performance.now();
    this.engine.seek(this.phase, this.mode === 'still' || o.last || instant ? this.endOf() : 0, true);
    if (old) {
      if (o.quiet || instant) old.remove();
      else {
        const d = (o.dir ?? 1) * 42, move = o.axis === 'y' ? 'translateY' : 'translateX';   // a dive moves down, not along
        old.style.pointerEvents = 'none';
        old.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `${move}(${-d}px)` }], { duration: 450, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'both' }).onfinish = () => old.remove();
        this.section.animate([{ opacity: 0, transform: `${move}(${d}px)` }, { opacity: 1, transform: 'none' }], { duration: 600, easing: 'cubic-bezier(.22,.61,.36,1)' });
      }
    }
    this.syncHash();
    this.emit();
    this.run();
  }

  private endOf() { const s = this.engine.settledAt(this.phase); return isFinite(s) ? s + 1 : this.order[this.idx].phases[this.phase].end; }

  // ---- clock
  private run() { if (!this.raf && this.mode !== 'still') this.raf = requestAnimationFrame(n => this.tick(n)); }
  private tick(now: number) {
    this.raf = 0;
    if (this.frozen) return;
    for (const [id, dir] of Object.entries(this.moving)) {
      const end = (this.order[this.idx].actions?.find(a => a.id === id)?.end ?? 0) + 1, acts = this.engine.acts ??= {};
      const dt = Math.max(0, Math.min(50, now - this.lastTick));   // a frame's time can fall just before the click
      acts[id] = Math.max(0, Math.min(end, (acts[id] ?? 0) + dir * dt));
      if (acts[id] === (dir > 0 ? end : 0)) delete this.moving[id];
    }
    if (this.spot) {
      const sp = this.spot;
      sp.t += Math.min(50, now - this.lastTick);
      sp.c = sp.dir > 0 ? Math.min(1, sp.t / CAMERA_MS) : Math.max(0, 1 - sp.t / CAMERA_MS);
      applyShot(sp.shot, sp.c);
      if (sp.dir < 0 && sp.c <= 0) { this.finishClose(); }
      else this.engine.seek(this.phase, this.t, false, sp.id, Math.max(0, sp.t - CAMERA_MS * .6));
      this.lastTick = now;
      this.t0 = now - this.t;
      this.run();
      return;
    }
    this.lastTick = now;
    this.t = now - this.t0;
    this.engine.seek(this.phase, this.t);
    const ph = this.order[this.idx].phases[this.phase], mode = this.slideMode();
    // A step can go on by itself even in step mode: auto is how long it waits after its build.
    const goesOn = this.phase < this.lastPhase() && (mode === 'auto' || ph.auto != null);
    const wait = ph.auto ?? this.deck.dwell, cap = ph.auto != null ? Infinity : AUTO_MAX + this.deck.dwell;
    if (goesOn && this.t >= Math.min(ph.end + wait, cap)) {
      this.phase++; this.t0 = now; this.t = 0; this.emit();
    }
    if (Object.keys(this.moving).length || this.t < this.engine.settledAt(this.phase) + 50 || goesOn) this.run();
  }

  // ---- navigation
  next() {
    if (this.ov?.classList.contains('open')) return;
    if (this.spot) { this.closeSpot(); return; }
    if (this.slideMode() === 'steps' && this.phase < this.lastPhase()) {
      this.frozen = false;
      this.engine.seek(this.phase, this.endOf());
      this.phase++; this.t = 0; this.t0 = performance.now();
      this.emit(); this.run();
      return;
    }
    const to = this.ahead();
    if (!to) this.wake();
    else if (to.up) this.show(to.i, { last: true, dir: -1, axis: 'y' });
    else this.show(to.i);
  }
  // ---- the tree: Next stays on the path it is on, and leaves a deep dive by coming back up
  private kids(i = this.idx) { const id = this.order[i].id; return this.order.flatMap((s, k) => (s.parent === id ? [k] : [])); }
  private parentAt(i = this.idx) { const p = this.order[i].parent; return p ? this.order.findIndex(s => s.id === p) : -1; }
  private ahead(): { i: number; up: boolean } | null {
    const here = this.order[this.idx];
    const next = this.order.findIndex((s, k) => k > this.idx && s.parent === here.parent);
    if (next >= 0) return { i: next, up: false };
    const up = this.parentAt();
    return up >= 0 ? { i: up, up: true } : null;
  }
  dive() { const k = this.kids(); if (k.length && !this.ov?.classList.contains('open')) { this.closeSpot(true); this.show(k[0], { axis: 'y' }); } }
  surface() { const p = this.parentAt(); if (p >= 0 && !this.ov?.classList.contains('open')) { this.closeSpot(true); this.show(p, { last: true, dir: -1, axis: 'y' }); } }
  /** The arrows do the useful thing wherever they are, so a slide with no tree behaves as it always has. */
  down() { if (this.kids().length) this.dive(); else this.next(); }
  up() { if (this.parentAt() >= 0) this.surface(); else this.prev(); }
  prev() {
    if (this.ov?.classList.contains('open')) return;
    if (this.spot) { this.closeSpot(); return; }
    if (this.slideMode() === 'steps' && this.phase > 0) {
      this.phase--; this.t = this.endOf(); this.engine.seek(this.phase, this.t, true);
      this.t0 = performance.now() - this.t; this.emit(); this.run();
      return;
    }
    const here = this.order[this.idx];
    const before = this.order.findLastIndex((s, k) => k < this.idx && s.parent === here.parent);
    if (before >= 0) this.show(before, { dir: -1, last: true });
    else if (this.parentAt() >= 0) this.surface();
    else this.wake();
  }
  replay() { this.show(this.idx, { quiet: true }); }
  go(k: number) { if (k >= 0 && k < this.order.length) { this.show(k, { dir: k < this.idx ? -1 : 1 }); this.wake(); } }
  toggleMode() { this.forced = true; this.setMode(this.slideMode() === 'steps' ? 'auto' : 'steps'); this.emit(); }
  black() { this.blacked = !this.blacked; this.blackEl.classList.toggle('open', this.blacked); this.emit(); }
  /** A browser refuses to close a window no script opened, so the show has to end without that too. */
  end() {
    this.popup?.close();
    this.popup = null;
    window.close();
    if (document.fullscreenElement) document.exitFullscreen();
    if (this.blacked) this.black();
    this.toast('Show ended. You can close this tab.');
  }
  setMode(m: Mode) {
    this.mode = m;
    if (!this.hosted) {
      const u = new URL(location.href);
      if (m === 'steps') u.searchParams.set('steps', ''); else u.searchParams.delete('steps');
      history.replaceState(null, '', u);
    }
    this.toast(m === 'steps' ? 'Step mode: Next runs each step' : 'Autoplay: steps run by themselves');
    this.run();
  }

  // ---- spotlight
  openSpot(el: Element) {
    if (this.spot || this.mode === 'still') return;
    const id = el.id || '';
    this.spot = { id, el, shot: frame(this.section.querySelector('.p-body')!, el, this.scale), c: 0, dir: 1, t: 0 };
    document.documentElement.classList.add('spot-on');
    this.emit(); this.run();
  }
  closeSpot(now = false) {
    if (!this.spot) return;
    if (now) { applyShot(this.spot.shot, 0); this.finishClose(); return; }
    this.spot.dir = -1; this.spot.t = 0;
    this.run();
  }
  private finishClose() {
    this.spot = null;
    document.documentElement.classList.remove('spot-on');
    this.engine.seek(this.phase, this.t);
    this.emit();
  }

  // ---- deterministic control, for tools and tests
  seek(o: SeekTarget) {
    this.frozen = true;
    this.closeSpot(true);
    this.heldSpot = o.spot ?? null;
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    const i = o.slide != null ? o.slide - 1 : this.idx;
    this.section?.remove();
    this.idx = Math.max(0, Math.min(this.order.length - 1, i));
    this.mount(this.idx);
    this.phase = o.step == null ? this.lastPhase() : Math.max(0, Math.min(this.lastPhase(), o.step));
    this.t = o.t == null ? this.endOf() : o.t;
    if (o.actions) this.engine.acts = o.actions;
    this.engine.seek(this.phase, this.t, true);
    if (o.spot) {
      const el = this.section.querySelector(`[id="${o.spot}"]`);
      if (!el) throw new Error(`no spot ${o.spot}`);
      const c = Math.min(1, (o.spotT ?? 1e9) / CAMERA_MS);
      const shot = frame(this.section.querySelector('.p-body')!, el, this.scale);
      applyShot(shot, c);
      this.engine.seek(this.phase, this.t, true, o.spot, Math.max(0, (o.spotT ?? 1e9) - CAMERA_MS * .6));
    }
    this.emit();
  }
  /** The finished drawing with no timeline applied, for the rest check. */
  pristine(no: number) {
    this.frozen = true;
    this.section?.remove();
    this.idx = no - 1;
    this.mount(this.idx);
    for (const el of this.section.querySelectorAll<HTMLElement>('[data-leaves]')) el.style.visibility = 'hidden';
  }
  /** Replace the page with one block per slide, or per step, for printing. */
  printLayout(perStep: boolean) {
    const pages: string[] = [];
    this.order.forEach((s, i) => {
      const steps = perStep ? s.phases.map((_, k) => k) : [s.phases.length - 1];
      for (const st of steps) {
        this.seek({ slide: i + 1, step: st });
        pages.push(`<div class="p-print"><div class="p-stage" style="position:absolute">${this.section.outerHTML}</div></div>`);
      }
    });
    document.body.innerHTML = pages.join('');
  }
  /** Swap in a new compile and hold the same frame. */
  replace(deck: CompiledDeck) {
    const n = this.order === this.deck.slides ? deck.slides : this.order.map(s => deck.slides.find(x => x.id === s.id) ?? s);
    this.deck = deck;
    this.order = n;
    this.popup?.postMessage({ present: 'deck', deck }, '*');
    const keep = { slide: Math.min(this.idx, n.length - 1) + 1, step: this.phase, t: this.t };
    const was = this.frozen;
    this.seek(keep);
    this.frozen = was;
    if (!was) { this.t0 = performance.now() - this.t; this.run(); }
  }
  audit() {
    const r = audit(this.section.querySelector('.p-body')!, this.scale), sc = this.engine.scene;
    for (const m of sc?.timing.errors ?? []) r.issues.push({ code: 'scene-error', severity: 'error', message: `Scene ${this.order[this.idx].scene!.name}: ${m}`, fix: 'Fix the scene file in scenes/. It ran up to the error' });
    return r;
  }
  /** What a scene measured on this slide, for the tools to record. */
  sceneTiming() { const t = this.engine.scene?.timing; return t ? { durs: t.durs, rests: t.rests, builds: t.builds, names: t.names } : null; }
  state() {
    const s = this.order[this.idx];
    return {
      slide: this.idx + 1, id: s.id, total: this.order.length, step: this.phase, steps: s.phases.length - 1,
      t: this.t, mode: this.slideMode(), spot: this.spot?.id ?? this.heldSpot, rested: this.t >= this.engine.settledAt(this.phase),
      label: slideLabels(this.deck.slides).get(s.id), depth: s.depth ?? 0, deep: this.kids().length,
    };
  }
  private emit() {
    this.paint();
    this.listeners.forEach(f => f(this.state()));
    this.tellPopup();
  }
  private tellPopup() {
    const s = this.order[this.idx], to = this.ahead(), trail: string[] = [];
    for (let p = this.parentAt(); p >= 0; p = this.parentAt(p)) trail.unshift(this.order[p].title);
    const state: ShowState = {
      present: 'state', id: s.id, nextId: to ? this.order[to.i].id : null, nextIsUp: !!to?.up,
      label: slideLabels(this.deck.slides).get(s.id)!, total: this.deck.slides.filter(x => !x.parent).length,
      deep: this.kids().map(k => this.order[k].title), trail,
      seed: this.seed, acts: this.played(), spot: this.spot?.id ?? null, phase: this.phase, t: this.t, mode: this.slideMode(), black: this.blacked,
    };
    this.popup?.postMessage(state, '*');
  }

  // ---- UI
  private syncHash() {
    if (this.mode === 'still') return;
    history.replaceState(null, '', '#' + (this.deck.slides.indexOf(this.order[this.idx]) + 1));
  }
  private paint() {
    if (!this.count) return;
    const s = this.order[this.idx], st = this.slideMode() === 'steps' && s.phases.length > 1 ? ` · ${this.phase}/${s.phases.length - 1}` : '';
    this.count.textContent = `${slideLabels(this.deck.slides).get(s.id)} / ${this.deck.slides.filter(x => !x.parent).length}${st}`;
  }
  private buildUi(host: HTMLElement) {
    const btn = (k: keyof typeof ICONS, label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.className = 'ui-btn'; b.title = label; b.setAttribute('aria-label', label); b.innerHTML = icon(ICONS[k]);
      b.onclick = e => { e.stopPropagation(); fn(); };
      return b;
    };
    const sep = () => { const d = document.createElement('i'); d.className = 'ui-sep'; return d; };
    const bar = this.bar = document.createElement('div');
    bar.className = 'ui ui-bar';
    this.count = document.createElement('button');
    this.count.className = 'ui-count';
    this.count.onclick = e => { e.stopPropagation(); this.ovToggle(); };
    bar.append(btn('prev', 'Previous', () => this.prev()), this.count, btn('next', 'Next', () => this.next()), sep(),
      btn('replay', 'Replay (R)', () => this.replay()), btn('grid', 'Overview (G)', () => this.ovToggle()),
      btn('full', 'Full screen (F)', () => this.fullscreen()), btn('help', 'Help (?)', () => this.help()));
    this.toastEl = document.createElement('div');
    this.toastEl.className = 'ui ui-toast';
    this.ov = document.createElement('div');
    this.ov.className = 'ui ui-ov';
    this.helpEl = document.createElement('div');
    this.helpEl.className = 'ui ui-help';
    const keys: [string, string][] = [['→ Space', 'Next'], ['←', 'Previous'], ['↓ D', 'Deep dive'], ['↑ U', 'Back up'], ['Home End', 'First, last'], ['1–99', 'Go to slide'], ['G', 'Overview'], ['R', 'Replay'], ['S', 'Autoplay or steps'], ['Z', 'Zoom to marked part'], ['F', 'Full screen'], ['B', 'Black screen'], ['P', 'Presenter view'], ['M', 'Toggle motion'], ['H', 'Show bar'], ['?', 'This help']];
    this.helpEl.innerHTML = `<div>${keys.map(([k, v]) => `<kbd>${k}</kbd><span>${v}</span>`).join('')}</div>`;
    this.helpEl.onclick = () => this.help();
    this.blackEl = document.createElement('div');
    this.blackEl.className = 'ui ui-black';
    host.append(bar, this.toastEl, this.ov, this.helpEl, this.blackEl);

    addEventListener('keydown', e => this.key(e));
    addEventListener('mousemove', () => this.wake());
    addEventListener('click', e => this.click(e));
    let x0 = 0;
    addEventListener('touchstart', e => { x0 = e.touches[0].clientX; this.wake(); }, { passive: true });
    addEventListener('touchend', e => {
      const dx = e.changedTouches[0].clientX - x0;
      if (dx < -SWIPE) this.next(); else if (dx > SWIPE) this.prev();
    });
    addEventListener('message', e => {
      // An embedded page holds the keyboard while it has focus, and passes the keys on.
      if (e.data?.present === 'pane' && e.source === this.popup) {      // a click on the slide in the presenter's view
        const part = e.data.spot ? this.section.querySelector(`[id="${CSS.escape(e.data.spot)}"]`) : null;
        if (this.spot) this.closeSpot(); else if (part) this.openSpot(part); else this.next();
      }
      if (e.data?.present === 'key' && (e.source === this.popup || [...this.section.querySelectorAll('iframe')].some(f => f.contentWindow === e.source))) dispatchEvent(new KeyboardEvent('keydown', { key: String(e.data.key) }));
      const onStage = [...this.section.querySelectorAll('iframe')].find(f => f.contentWindow === e.source);
      if (e.data?.present === 'embed' && onStage) this.popup?.postMessage(e.data, '*');
      if (e.data?.present === 'embed' && e.source === this.popup) this.section.querySelector('iframe')?.contentWindow?.postMessage({ ...e.data, present: 'click' }, '*');
      if (e.data?.present === 'beat' && e.source === this.popup && this.raf && performance.now() - this.lastTick > BEAT_LATE) {
        cancelAnimationFrame(this.raf);                  // the frame it asked for is not coming
        this.tick(performance.now());
      }
      if (e.data?.present === 'act' && e.source === this.popup) this.act(String(e.data.id));
      // The presenter points at a term in their view, and the room sees what it means.
      if (e.data?.present === 'term' && e.source === this.popup) {
        const term = e.data.slide === this.order[this.idx].id && e.data.i >= 0 ? this.section.querySelectorAll('[data-def]')[e.data.i] : null;
        if (term) this.terms.show(term); else this.terms.hide();
      }
      if (e.data?.present === 'goto' && e.source === this.popup) this.jump(String(e.data.id));
      if (e.data?.present === 'cmd' && e.source === this.popup && COMMANDS.includes(e.data.cmd)) this[e.data.cmd as Command]();
      if (e.data?.present === 'hello' || (e.data?.present === 'ping' && e.source !== this.popup)) {
        this.popup = e.source as Window;
        this.popup.postMessage({ present: 'deck', deck: this.deck }, '*');   // it may have loaded before an edit
        this.tellPopup();
      }
    });
  }
  wake() {
    if (this.audience) { document.documentElement.style.cursor = 'none'; return; }
    this.bar?.classList.add('show');
    document.documentElement.style.cursor = '';
    clearTimeout(this.barT);
    this.barT = window.setTimeout(() => {
      if (this.bar.matches(':hover') || this.bar.contains(document.activeElement)) return this.wake();
      this.bar.classList.remove('show');
      document.documentElement.style.cursor = 'none';
    }, BAR_IDLE);
  }
  toast(m: string) {
    if (!this.toastEl) return;
    this.toastEl.textContent = m;
    this.toastEl.classList.add('show');
    setTimeout(() => this.toastEl.classList.remove('show'), 2200);
  }
  fullscreen() { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); }
  help() { this.helpEl.classList.toggle('open'); }
  ovToggle(on?: boolean) {
    if (!this.ov) return;
    const open = on ?? !this.ov.classList.contains('open');
    if (open && !this.ov.childElementCount) this.buildOverview();
    this.ov.classList.toggle('open', open);
    [...this.ov.children].forEach((c, i) => c.classList.toggle('cur', i === this.idx));
  }
  private buildOverview() {
    this.order.forEach((s, i) => {
      const c = document.createElement('button');
      c.className = 'ui-ov-card' + (s.parent ? ' deep' : '');
      c.title = s.title;
      c.innerHTML = `<div class="ui-ov-inner">${stillSlide(s)}</div><span class="ui-ov-no">${slideLabels(this.deck.slides).get(s.id)}</span>`;
      c.onclick = e => { e.stopPropagation(); this.go(i); };
      this.ov.appendChild(c);
    });
    requestAnimationFrame(() => {
      for (const c of this.ov.children) (c.firstChild as HTMLElement).style.transform = `scale(${c.clientWidth / W})`;
    });
  }
  /** A click on a part with act=. */
  act(id: string) {
    const list = this.order[this.idx].actions ?? [], a = list.find(x => x.id === id);
    if (!a) return;
    const acts = this.engine.acts ??= {}, on = (x: string) => this.moving[x] === 1 || (!this.moving[x] && (acts[x] ?? 0) > 0);
    if (on(id) && !a.toggle) return;
    this.moving[id] = on(id) ? -1 : 1;
    if (a.group) for (const o of list) if (o.id !== id && o.group === a.group && on(o.id)) this.moving[o.id] = -1;
    this.lastTick = performance.now();
    this.frozen = false;
    if (this.reduced) for (const [k, dir] of Object.entries(this.moving)) { acts[k] = dir > 0 ? (list.find(x => x.id === k)?.end ?? 0) + 1 : 0; delete this.moving[k]; }
    this.emit();
    this.run();
  }
  /** Where each action is heading, for the presenter's copy. */
  private played() {
    const out: Record<string, number> = {};
    for (const a of this.order[this.idx].actions ?? []) if (this.moving[a.id] === 1 || (!this.moving[a.id] && (this.engine.acts?.[a.id] ?? 0) > 0)) out[a.id] = 1e9;
    return out;
  }
  private jump(id: string) {
    const to = this.order.findIndex(s => s.id === id);
    if (to < 0) return false;
    this.show(to, this.order[to].parent === this.order[this.idx].id ? { axis: 'y' } : { dir: to < this.idx ? -1 : 1 });
    return true;
  }
  private click(e: MouseEvent) {
    const t = e.target as Element;
    if (t.closest('.ui') || (window as any).__presentStudioActive) return;
    if (this.spot) { this.closeSpot(); return; }
    const acted = t.closest('[data-act]');
    if (acted && this.section.contains(acted)) { this.act(acted.getAttribute('data-act')!); return; }
    const jump = t.closest('[data-goto]');
    if (jump && this.section.contains(jump) && this.jump(jump.getAttribute('data-goto')!)) return;
    const part = t.closest('[data-spot]');
    if (part && this.section.contains(part)) { this.openSpot(part); return; }
    this.next();
  }
  private key(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.target as HTMLElement).closest?.('input,textarea,[contenteditable]')) return;
    const k = e.key;
    const ov = this.ov.classList.contains('open');
    if (ov && k === 'Escape') { this.ovToggle(false); return; }
    if (this.helpEl.classList.contains('open') && k === 'Escape') { this.help(); return; }
    if (k === 'Escape' && this.spot) { this.closeSpot(); return; }
    if (k === 'Escape' && this.audience) { this.end(); return; }
    if (['ArrowRight', ' ', 'PageDown', 'Enter'].includes(k)) { e.preventDefault(); this.next(); }
    else if (['ArrowLeft', 'PageUp', 'Backspace'].includes(k)) { e.preventDefault(); this.prev(); }
    else if (k === 'ArrowDown') { e.preventDefault(); this.down(); }
    else if (k === 'ArrowUp') { e.preventDefault(); this.up(); }
    else if (k === 'd') this.dive();
    else if (k === 'u') this.surface();
    else if (k === 'Home') this.go(0);
    else if (k === 'End') this.go(this.order.findLastIndex(s => !s.parent));
    else if (k === 'g' || k === 'o') this.ovToggle();
    else if (k === 'r') this.replay();
    else if (k === 's') this.toggleMode();
    else if (k === 'b' || k === '.') this.black();
    else if (k === 'f') this.fullscreen();
    else if (k === 'h') this.wake();
    else if (k === '?') this.help();
    else if (k === 'p') this.presenter();
    else if (k === 'm') { this.reduced = !this.reduced; this.toast(this.reduced ? 'Reduced motion' : 'Full motion'); }
    else if (k === 'z') {
      if (this.spot) this.closeSpot();
      else { const part = this.section.querySelector('[data-spot]'); if (part) this.openSpot(part); }
    } else if (/^\d$/.test(k)) {
      this.digits += k;
      clearTimeout(this.digitT);
      this.digitT = window.setTimeout(() => {
        const idx = this.order.indexOf(this.deck.slides.filter(s => !s.parent)[parseInt(this.digits, 10) - 1]);
        this.digits = '';
        this.go(idx);
      }, 450);
    }
  }
  presenter() {
    // Studio's preview is a still with no controls. Being presented makes it a real show.
    if (this.mode === 'still') { this.hosted = true; this.mode = this.deck.mode; this.buildUi(document.body); this.show(this.idx, { quiet: true }); }
    const u = new URL(location.href);
    u.searchParams.delete('still');
    u.searchParams.set('presenter', '');
    window.open(u.href, 'present-notes', 'width=1280,height=760');   // it says hello when it has loaded
  }
}
