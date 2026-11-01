// The spotlight. A pure function of c in 0..1: the body zooms onto a part, and everything off
// the part's ancestor path dims. Dimming uses filter, not opacity, so it never fights a track.
import { ease } from './ease.ts';

const FILL_W = .84, FILL_H = .78, MAX = 2.4;
export const CAMERA_MS = 700;
export const W = 1920, H = 1080;

export interface Shot { body: HTMLElement; dim: Element[]; title: Element[]; s: number; tx: number; ty: number; }

export function frame(body: HTMLElement, part: Element, stageScale: number): Shot {
  const b = body.getBoundingClientRect(), r = part.getBoundingClientRect();
  const stage = body.closest('.p-stage')!.getBoundingClientRect();
  const x = (r.left - b.left) / stageScale, y = (r.top - b.top) / stageScale;
  const w = r.width / stageScale, h = r.height / stageScale;
  const s = Math.min(FILL_W * W / w, FILL_H * H / h, MAX);
  const bx = (b.left - stage.left) / stageScale, by = (b.top - stage.top) / stageScale;
  const tx = W / 2 - bx - (x + w / 2) * s, ty = H / 2 - by - (y + h / 2) * s;
  const dim: Element[] = [], title: Element[] = [];
  for (let n: Element = part; n !== body && n.parentElement; n = n.parentElement) {
    for (const sib of n.parentElement.children) {
      const tag = sib.tagName.toLowerCase();
      if (sib === n || tag === 'defs' || tag === 'style' || sib.classList.contains('fx')) continue;
      (sib.classList.contains('p-header') ? title : dim).push(sib);
    }
  }
  return { body, dim, title, s, tx, ty };
}

export function applyShot(shot: Shot, c: number) {
  const e = ease.inOut(c), { body, s, tx, ty } = shot;
  body.style.transformOrigin = '0 0';
  body.style.transform = c <= 0 ? '' : `translate(${(tx * e).toFixed(2)}px, ${(ty * e).toFixed(2)}px) scale(${(1 + (s - 1) * e).toFixed(4)})`;
  const f = c <= 0 ? '' : `opacity(${(1 - .88 * e).toFixed(3)})`;
  for (const el of shot.dim) (el as HTMLElement).style.filter = f;
  const tf = c <= 0 ? '' : `opacity(${Math.max(0, 1 - e * 4).toFixed(3)})`;
  for (const el of shot.title) (el as HTMLElement).style.filter = tf;
}
