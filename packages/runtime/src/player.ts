// The presenter: one clock, three ways of driving it (autoplay, step, still), plus everything
// around the slide. All state changes end in engine.seek, so a frame never depends on history.
import type { CompiledDeck, CompiledSlide } from '../../core/src/compiled.ts';
import { Engine } from './engine.ts';
import { applyShot, CAMERA_MS, frame, H, W, type Shot } from './camera.ts';
import { audit } from './audit.ts';

const BAR_IDLE = 2500, AUTO_MAX = 10000, SWIPE = 50;
const icon = (d: string) => `<svg viewBox="0 0 16 16"><path d="${d}"/></svg>`;
const ICONS = {
  prev: 'M10 3 5 8l5 5', next: 'M6 3l5 5-5 5', replay: 'M3 8a5 5 0 1 0 1.6-3.7M3 2v3h3',
  grid: 'M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z', full: 'M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4',
  help: 'M6 6a2 2 0 1 1 3 1.7c-.7.4-1 .8-1 1.5M8 12v.2',
};
type Mode = 'auto' | 'steps' | 'still';
export interface SeekTarget { slide?: number; step?: number; t?: number; spot?: string; spotT?: number; }

export class Player {
  deck: CompiledDeck;
  order: CompiledSlide[];
  idx = 0;
  phase = 0;
  t = 0;
  t0 = 0;
  mode: Mode;
  frozen = false;           // seek() holds the clock until the next user action
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
  count!: HTMLElement;
  digits = '';
  digitT = 0;
  popup: Window | null = null;
  listeners: ((s: ReturnType<Player['state']>) => void)[] = [];

  constructor(deck: CompiledDeck, host: HTMLElement) {
    const q = new URLSearchParams(location.search);
    this.deck = deck;
    const only = (q.get('only') ?? '').split(',').map(x => parseInt(x, 10)).filter(n => n >= 1 && n <= deck.slides.length);
    this.order = only.length ? [...new Set(only)].map(n => deck.slides[n - 1]) : deck.slides;
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
    s.innerHTML = `<div class="p-body">${this.order[i].html}</div>`;
    this.stage.appendChild(s);
    this.section = s;
    this.engine = new Engine(s, this.order[i]);
  }
  private lastPhase() { return this.order[this.idx].phases.length - 1; }

  show(i: number, o: { dir?: number; last?: boolean; quiet?: boolean; instant?: boolean; phase?: number } = {}) {
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
        const d = (o.dir ?? 1) * 42;
        old.style.pointerEvents = 'none';
        old.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${-d}px)` }], { duration: 450, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'both' }).onfinish = () => old.remove();
        this.section.animate([{ opacity: 0, transform: `translateX(${d}px)` }, { opacity: 1, transform: 'none' }], { duration: 600, easing: 'cubic-bezier(.22,.61,.36,1)' });
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
    const end = this.order[this.idx].phases[this.phase].end;
    if (this.mode === 'auto' && this.phase < this.lastPhase() && this.t >= Math.min(end + this.deck.dwell, AUTO_MAX + this.deck.dwell)) {
      this.phase++; this.t0 = now; this.t = 0; this.emit();
    }
    if (this.t < this.engine.settledAt(this.phase) + 50 || (this.mode === 'auto' && this.phase < this.lastPhase())) this.run();
  }

  // ---- navigation
  next() {
    if (this.ov?.classList.contains('open')) return;
    if (this.spot) { this.closeSpot(); return; }
    if (this.mode === 'steps' && this.phase < this.lastPhase()) {
      this.frozen = false;
      this.engine.seek(this.phase, this.endOf());
      this.phase++; this.t = 0; this.t0 = performance.now();
      this.emit(); this.run();
      return;
    }
    if (this.idx < this.order.length - 1) this.show(this.idx + 1);
    else this.wake();
  }
  prev() {
    if (this.ov?.classList.contains('open')) return;
    if (this.spot) { this.closeSpot(); return; }
    if (this.mode === 'steps' && this.phase > 0) {
      this.phase--; this.t = this.endOf(); this.engine.seek(this.phase, this.t, true);
      this.t0 = performance.now() - this.t; this.emit(); this.run();
      return;
    }
    if (this.idx > 0) this.show(this.idx - 1, { dir: -1, last: true });
    else this.wake();
  }
  replay() { this.show(this.idx, { quiet: true }); }
  go(k: number) { if (k >= 0 && k < this.order.length) { this.show(k, { dir: k < this.idx ? -1 : 1 }); this.wake(); } }
  setMode(m: Mode) {
    this.mode = m;
    const u = new URL(location.href);
    if (m === 'steps') u.searchParams.set('steps', ''); else u.searchParams.delete('steps');
    history.replaceState(null, '', u);
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
    const keep = { slide: Math.min(this.idx, n.length - 1) + 1, step: this.phase, t: this.t };
    const was = this.frozen;
    this.seek(keep);
    this.frozen = was;
    if (!was) { this.t0 = performance.now() - this.t; this.run(); }
  }
  audit() { return audit(this.section.querySelector('.p-body')!, this.scale); }
  state() {
    const s = this.order[this.idx];
    return {
      slide: this.idx + 1, id: s.id, total: this.order.length, step: this.phase, steps: s.phases.length - 1,
      t: this.t, mode: this.mode, spot: this.spot?.id ?? this.heldSpot, rested: this.t >= this.engine.settledAt(this.phase),
    };
  }
  private emit() {
    this.paint();
    this.listeners.forEach(f => f(this.state()));
    this.popup?.postMessage({ present: 'state', idx: this.idx, phase: this.phase }, '*');
  }

  // ---- UI
  private syncHash() {
    if (this.mode === 'still') return;
    history.replaceState(null, '', '#' + (this.deck.slides.indexOf(this.order[this.idx]) + 1));
  }
  private paint() {
    if (!this.count) return;
    const s = this.order[this.idx], st = this.mode === 'steps' && s.phases.length > 1 ? ` · ${this.phase}/${s.phases.length - 1}` : '';
    this.count.textContent = `${this.deck.slides.indexOf(s) + 1} / ${this.deck.slides.length}${st}`;
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
    const keys: [string, string][] = [['→ Space', 'Next'], ['←', 'Previous'], ['Home End', 'First, last'], ['1–99', 'Go to slide'], ['G', 'Overview'], ['R', 'Replay'], ['S', 'Autoplay or steps'], ['Z', 'Zoom to marked part'], ['F', 'Full screen'], ['P', 'Presenter view'], ['M', 'Toggle motion'], ['H', 'Show bar'], ['?', 'This help']];
    this.helpEl.innerHTML = `<div>${keys.map(([k, v]) => `<kbd>${k}</kbd><span>${v}</span>`).join('')}</div>`;
    this.helpEl.onclick = () => this.help();
    host.append(bar, this.toastEl, this.ov, this.helpEl);

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
      if (e.data?.present === 'cmd') (this as any)[e.data.cmd]?.();
      if (e.data?.present === 'hello') { this.popup = e.source as Window; this.emit(); }
    });
  }
  wake() {
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
      c.className = 'ui-ov-card';
      c.title = s.title;
      c.innerHTML = `<div class="ui-ov-inner"><section class="p-slide"><div class="p-body">${s.html}</div></section></div><span class="ui-ov-no">${this.deck.slides.indexOf(s) + 1}</span>`;
      c.onclick = e => { e.stopPropagation(); this.go(i); };
      this.ov.appendChild(c);
    });
    requestAnimationFrame(() => {
      for (const c of this.ov.children) (c.firstChild as HTMLElement).style.transform = `scale(${c.clientWidth / W})`;
    });
  }
  private click(e: MouseEvent) {
    const t = e.target as Element;
    if (t.closest('.ui') || (window as any).__presentStudioActive) return;
    if (this.spot) { this.closeSpot(); return; }
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
    if (['ArrowRight', 'ArrowDown', ' ', 'PageDown', 'Enter'].includes(k)) { e.preventDefault(); this.next(); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(k)) { e.preventDefault(); this.prev(); }
    else if (k === 'Home') this.go(0);
    else if (k === 'End') this.go(this.order.length - 1);
    else if (k === 'g' || k === 'o') this.ovToggle();
    else if (k === 'r') this.replay();
    else if (k === 's') this.setMode(this.mode === 'steps' ? 'auto' : 'steps');
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
        const idx = this.order.indexOf(this.deck.slides[parseInt(this.digits, 10) - 1]);
        this.digits = '';
        this.go(idx);
      }, 450);
    }
  }
  presenter() {
    const u = new URL(location.href);
    u.searchParams.set('presenter', '');
    this.popup = window.open(u.href, 'present-notes', 'width=1000,height=640');
    setTimeout(() => this.emit(), 500);
  }
}

/** The presenter's own window: notes, next slide, timer. Talks to the deck by postMessage, which
 *  works on file:// where BroadcastChannel does not reliably connect two windows. */
export function presenterView(deck: CompiledDeck, host: HTMLElement) {
  const el = document.createElement('div');
  el.className = 'ui-presenter';
  el.innerHTML = `<div class="timer"><span id="u-slide"></span><span id="u-time">00:00</span></div>
    <div><h2>Notes</h2><div class="notes" id="u-notes"></div></div>
    <div><h2>Next</h2><div class="next" id="u-next"></div></div>`;
  host.appendChild(el);
  const $ = (id: string) => el.querySelector('#' + id) as HTMLElement;
  const t0 = Date.now();
  setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    $('u-time').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
  const main = window.opener as Window | null;
  let last = -1;
  addEventListener('message', e => {
    if (e.data?.present !== 'state') return;
    const i = e.data.idx, s = deck.slides[i], n = deck.slides[i + 1];
    $('u-slide').textContent = `${i + 1} / ${deck.slides.length}  step ${e.data.phase}/${s.phases.length - 1}  ${s.title}`;
    if (i === last) return;
    last = i;
    $('u-notes').textContent = s.notes || '(no notes)';
    const box = $('u-next');
    box.innerHTML = n ? `<div class="ui-ov-inner"><section class="p-slide"><div class="p-body">${n.html}</div></section></div>` : '';
    if (n) (box.firstChild as HTMLElement).style.transform = `scale(${box.clientWidth / W})`;
  });
  addEventListener('keydown', e => {
    if (['ArrowRight', ' ', 'PageDown'].includes(e.key)) main?.postMessage({ present: 'cmd', cmd: 'next' }, '*');
    if (['ArrowLeft', 'PageUp'].includes(e.key)) main?.postMessage({ present: 'cmd', cmd: 'prev' }, '*');
  });
  main?.postMessage({ present: 'hello' }, '*');
}
