// Meanings of defined terms (<Term def>, <Math define>): a small card beside the term while it is pointed at.
// One card per window. The deck and the presenter's view both use it, so a term reads the same in either.

export interface TermCards {
  /** Closes the card. */
  hide(): void;
  /** Closes it if its term has left the page, as when a pane is redrawn. */
  check(): void;
  /** Opens it for a term at once, as when the presenter points at the same term in their view. */
  show(term: Element): void;
}
export interface TermOptions {
  /** Which terms answer the pointer here. */
  allowed?: (term: Element) => boolean;
  /** Told when the pointer opens or closes a card, so another window can follow. Not told of show() or hide(). */
  onChange?: (term: Element | null) => void;
}

/** The position of a term among those on its slide: the same in every copy of the slide. */
export const termIndex = (root: Element, term: Element) => [...root.querySelectorAll('[data-def]')].indexOf(term);

/** Shows meanings for terms inside host that `allowed` accepts. Parts not yet revealed show nothing. */
export function termCards(host: HTMLElement, { allowed = () => true, onChange }: TermOptions = {}): TermCards {
  const card = document.createElement('div');
  card.className = 'ui ui-term';
  card.setAttribute('role', 'tooltip');
  host.append(card);
  let on: Element | null = null, timer = 0;

  const close = () => { clearTimeout(timer); on = null; card.classList.remove('open'); };
  /** Closed by the pointer, a key or a click: a following window closes too. */
  const hide = () => { const was = card.classList.contains('open') || on; close(); if (was) onChange?.(null); };
  const place = (el: Element) => {
    const name = document.createElement('div');
    name.className = 'ui-term-name';
    if (el.closest('.katex')) {
      // A symbol keeps its typesetting: the card names the same glyph the room sees.
      const k = document.createElement('span'), c = el.cloneNode(true) as Element;
      k.className = 'katex'; c.removeAttribute('data-def'); k.append(c); name.append(k);
    } else name.textContent = el.textContent?.trim() ?? '';
    const p = document.createElement('p');
    p.textContent = el.getAttribute('data-def');
    card.replaceChildren(name, p);
    const r = el.getBoundingClientRect(), w = card.offsetWidth, h = card.offsetHeight, m = 12, gap = 10;
    const above = r.top - h - gap >= m;
    card.style.left = `${Math.max(m, Math.min(innerWidth - w - m, r.left + r.width / 2 - w / 2))}px`;
    card.style.top = `${above ? r.top - h - gap : Math.min(innerHeight - h - m, r.bottom + gap)}px`;
    card.dataset.side = above ? 'above' : 'below';
    card.classList.add('open');
  };
  const point = (t: EventTarget | null) => {
    const el = (t as Element | null)?.closest?.('[data-def]') ?? null;
    if (el === on) return;
    clearTimeout(timer);
    if (!el || !host.contains(el) || !allowed(el) || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) { hide(); return; }
    on = el;
    // A short wait, so a pointer passing over does not flash a card. Moving between terms is immediate.
    timer = window.setTimeout(() => { place(el); onChange?.(el); }, card.classList.contains('open') ? 0 : 90);
  };
  const visible = (el: Element) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true });

  addEventListener('pointerover', e => point(e.target));
  addEventListener('pointerout', e => { if (!e.relatedTarget) hide(); });
  addEventListener('focusin', e => point(e.target));
  addEventListener('keydown', hide, true);
  addEventListener('pointerdown', hide, true);
  return {
    hide: close,
    check: () => { if (on && !on.isConnected) close(); },
    show: el => { clearTimeout(timer); if (!host.contains(el) || !visible(el)) { close(); return; } on = el; place(el); },
  };
}
