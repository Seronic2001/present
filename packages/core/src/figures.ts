// Figures: the drawings talks keep needing, as macros for a Diagram. They share one anatomy so motion
// composes across them: each repeated unit is a .part, holding .seg (a stroke), .node (a mark) and
// .body (its label). Parts also get ids, <id>-1, <id>-2, for a single part's cue.
import type { MacroDef } from './macros.ts';

type A = Record<string, string>;
const esc = (s: string) => s.replace(/&(?!\w+;|#\d+;)/g, '&amp;').replace(/</g, '&lt;');
const num = (a: A, k: string, d = 0) => { const v = parseFloat(a[k]); return isNaN(v) ? d : v; };
/** items="One|detail;Two|detail" */
const items = (s = '') => s.split(';').map(x => x.trim()).filter(Boolean).map(x => x.split('|').map(y => y.trim()));
const root = (a: A, cls: string) => `<g${a.id ? ` id="${a.id}"` : ''} class="${[cls, a.class].filter(Boolean).join(' ')}"${a.spot != null ? ' data-spot=""' : ''}>`;
const part = (a: A, k: number, extra = '') => `<g${a.id ? ` id="${a.id}-${k + 1}"` : ''} class="part${extra ? ' ' + extra : ''}">`;
const dot = (x: number, y: number, r = 9, tone = 'accent') => `<circle class="node" cx="${x}" cy="${y}" r="${r}" stroke-width="2.4" style="fill:var(--paper);stroke:var(--${tone})"/>`;
const round = (n: number) => +n.toFixed(1);

export const FIGURES: Record<string, MacroDef> = {
  Milestones: {
    doc: 'A rising line through stops, with a card under each. For agendas, roadmaps, phases. size sets the card titles in px, default 20, and the details follow it.',
    props: 'id, x, y, w, h, items (Title|detail|detail;...), rise?, size?',
    example: '<Milestones id="plan" x="0" y="0" w="1600" h="520" items="Ask|What customers pay for;Build|How it gets there" />',
    svg: a => {
      const x = num(a, 'x'), y = num(a, 'y'), w = num(a, 'w', 1600), h = num(a, 'h', 520), list = items(a.items), n = list.length;
      const rise = num(a, 'rise', 90), line = y + 40 + rise, gap = w / n, card = gap - 24;
      const k0 = num(a, 'size', 20) / 20, big = a.size ? ` style="font-size:${num(a, 'size')}px"` : '', small = a.size ? ` style="font-size:${round(14 * k0)}px"` : '';
      const at = (k: number) => ({ x: x + gap * (k + .5), y: line - rise * (n > 1 ? k / (n - 1) : 0) });
      return `${root(a, 'milestones')}${list.map(([title, ...rest], k) => {
        const p = at(k), from = k ? at(k - 1) : { x, y: line + rise / (n * 1.5) }, top = line + 56;
        return `${part(a, k)}<path class="seg conn-a" d="M ${round(from.x)} ${round(from.y)} L ${round(p.x)} ${round(p.y)}"/>${dot(round(p.x), round(p.y))}`
          + `<g class="body"><path class="conn-d" d="M ${round(p.x)} ${round(p.y + 12)} L ${round(p.x)} ${top}"/><rect class="card" x="${round(p.x - card / 2)}" y="${top}" width="${round(card)}" height="${Math.min(y + h - top, round((66 + rest.length * 26) * k0))}" rx="10"/>`
          + `<text class="nm-l" x="${round(p.x - card / 2 + 22)}" y="${round(top + 42 * k0)}"${big}>${esc(title)}</text>`
          + rest.map((l, i) => `<text class="sm" x="${round(p.x - card / 2 + 22)}" y="${round(top + (76 + i * 24) * k0)}"${small}>${esc(l)}</text>`).join('') + '</g></g>';
      }).join('')}</g>`;
    },
  },
  Plot: {
    doc: 'A line chart that makes one claim: each point is a part, and the last is marked. Real values only; label the axes.',
    props: 'id, x, y, w, h, points (values), labels? (one per point), values? (shown at points), min?, max?, tone?',
    example: '<Plot id="score" x="60" y="20" w="900" h="460" points="0.52,0.81,0.95" labels="Start,After SFT,After RL" />',
    svg: a => {
      const x = num(a, 'x'), y = num(a, 'y'), w = num(a, 'w', 800), h = num(a, 'h', 400), tone = a.tone ?? 'accent';
      const v = (a.points ?? '').split(',').map(Number), labels = (a.labels ?? '').split(','), shown = (a.values ?? a.points ?? '').split(',');
      const min = num(a, 'min', Math.min(...v)), max = num(a, 'max', Math.max(...v)), span = max - min || 1, base = y + h - 34;
      const at = (k: number) => ({ x: round(x + 30 + k * (w - 60) / Math.max(1, v.length - 1)), y: round(base - 30 - (v[k] - min) / span * (h - 110)) });
      return `${root(a, 'plot')}<path class="plot-axis conn" d="M ${x} ${base} L ${x + w} ${base}"/>${v.map((_, k) => {
        const p = at(k), q = k ? at(k - 1) : p;
        return `${part(a, k, k === v.length - 1 ? 'last' : '')}${k ? `<path class="seg" d="M ${q.x} ${q.y} L ${p.x} ${p.y}" fill="none" stroke-width="3" stroke-linecap="round" style="stroke:var(--${tone})"/>` : ''}${dot(p.x, p.y, k === v.length - 1 ? 9 : 6, tone)}`
          + `<g class="body"><text class="nm-l" x="${p.x}" y="${p.y - 20}" text-anchor="middle">${esc((shown[k] ?? '').trim())}</text>${labels[k] ? `<text class="sm" x="${p.x}" y="${base + 26}" text-anchor="middle">${esc(labels[k].trim())}</text>` : ''}</g></g>`;
      }).join('')}</g>`;
    },
  },
  Timing: {
    doc: 'Horizontal bars on a shared clock: where time goes, schedules, waterfalls. Each bar is a .seg, so draw grows it.',
    props: 'id, x, y, w, label?, rows (Name|start|length|tone?;...)',
    example: '<Timing id="trace" x="40" y="20" w="900" rows="Plan|0|3;Search|3|5;Retry|8|6|danger" />',
    svg: a => {
      const x = num(a, 'x'), y = num(a, 'y'), w = num(a, 'w', 800), rows = items(a.rows), left = 210;
      const end = Math.max(...rows.map(r => +r[1] + +r[2])), k = (w - left) / (end || 1);
      return `${root(a, 'timing')}${a.label ? `<text class="m lbl" x="${x + left}" y="${y + 6}">${esc(a.label)}</text>` : ''}${rows.map(([name, start, len, tone], i) => {
        const yy = y + 54 + i * 68, x1 = round(x + left + +start * k), x2 = round(x1 + +len * k);
        return `${part(a, i)}<g class="body"><text class="nm" x="${x}" y="${yy + 6}">${esc(name)}</text></g><path class="seg" d="M ${x1} ${yy} L ${x2} ${yy}" fill="none" stroke-width="34" style="stroke:var(--${tone ?? 'accent'})"/></g>`;
      }).join('')}</g>`;
    },
  },
  Hub: {
    doc: 'One thing in the middle, with what surrounds it on spokes. Each spoke is a part. Tone a spoke to mark it blocked or verified.',
    props: 'id, x, y (centre), r, label, items (Name|tone?;...)',
    example: '<Hub id="agent" x="400" y="300" r="220" label="Agent" items="Tools|ok;Data|ok;Network|danger" />',
    svg: a => {
      const x = num(a, 'x'), y = num(a, 'y'), r = num(a, 'r', 220), list = items(a.items), core = r * .3;
      return `${root(a, 'hub')}<circle class="ring" cx="${x}" cy="${y}" r="${round(r * .68)}" fill="none" style="stroke:var(--rule)"/>${list.map(([name, tone], k) => {
        const t = -Math.PI / 2 + k * 2 * Math.PI / list.length, c = Math.cos(t), s = Math.sin(t);
        const px = round(x + c * r), py = round(y + s * r), col = tone ?? 'accent';
        const anchor = c > .3 ? 'start' : c < -.3 ? 'end' : 'middle', lx = round(px + c * 22), ly = round(py + s * 26 + 7);
        return `${part(a, k)}<path class="seg" d="M ${round(x + c * core)} ${round(y + s * core)} L ${px} ${py}" fill="none" stroke-width="1.8" stroke-linecap="round" style="stroke:var(--${col})"/>${dot(px, py, 9, col)}<g class="body"><text class="nm" x="${lx}" y="${ly}" text-anchor="${anchor}">${esc(name)}</text></g></g>`;
      }).join('')}<g class="hub-core"><circle cx="${x}" cy="${y}" r="${round(core)}" stroke-width="2" style="fill:var(--paper);stroke:var(--accent)"/><text class="nm-l" x="${x}" y="${y + 7}" text-anchor="middle">${esc(a.label ?? '')}</text></g></g>`;
    },
  },
  Terrain: {
    doc: 'A contour map with a path climbing to a summit: search, optimisation, progress toward a goal. The climb is <id>-climb, for travel and stream.',
    props: 'id, x, y, w, h, label?, tone?',
    example: '<Terrain id="map" x="200" y="0" w="1200" h="520" label="Goal" />',
    svg: a => {
      const x = num(a, 'x'), y = num(a, 'y'), w = num(a, 'w', 1000), h = num(a, 'h', 500), tone = a.tone ?? 'accent';
      const cx = x + w * .68, cy = y + h * .36, rings = [1, .8, .6, .42, .26];
      const px = (t: number) => round(x + w * t), py = (t: number) => round(y + h * t);
      const d = `M ${px(.04)} ${py(.92)} C ${px(.22)} ${py(.72)}, ${px(.3)} ${py(.95)}, ${px(.42)} ${py(.66)} S ${px(.56)} ${py(.42)}, ${round(cx)} ${round(cy)}`;
      return `${root(a, 'terrain')}${rings.map(k => `<ellipse class="ring" cx="${round(cx)}" cy="${round(cy)}" rx="${round(w * .3 * k)}" ry="${round(h * .34 * k)}" transform="rotate(-14 ${round(cx)} ${round(cy)})" fill="none" stroke-width="1.2" style="stroke:var(--rule)"/>`).join('')}`
        + `<g${a.id ? ` id="${a.id}-1"` : ''} class="part"><path class="seg"${a.id ? ` id="${a.id}-climb"` : ''} d="${d}" fill="none" stroke-width="2.6" stroke-linecap="round" style="stroke:var(--${tone})"/>${dot(round(cx), round(cy), 10, tone)}<g class="body">${a.label ? `<text class="m lbl" x="${round(cx + 22)}" y="${round(cy - 16)}">${esc(a.label)}</text>` : ''}</g></g></g>`;
    },
  },
  Neck: {
    doc: 'A wide input squeezed through checkpoints into a wide output: bottlenecks, gated review, funnels. Each gate is a part. The centre line is <id>-flow, for stream.',
    props: 'id, x, y, w, h, input?, output?, items (Gate|detail;...)',
    example: '<Neck id="gates" x="0" y="0" w="1600" h="520" input="Capability" output="Outcomes" items="Alignment|To our goals;Verification|Check every action" />',
    svg: a => {
      const x = num(a, 'x'), y = num(a, 'y'), w = num(a, 'w', 1600), h = num(a, 'h', 520), list = items(a.items);
      const mid = y + h * .42, half = h * .4, neck = h * .1, a1 = x + w * .17, b1 = x + w * .26, a2 = x + w * .74, b2 = x + w * .83;
      const wall = (s: number) => `M ${x} ${mid + s * half} C ${a1} ${mid + s * half}, ${a1} ${mid + s * neck}, ${b1} ${mid + s * neck} L ${a2} ${mid + s * neck} C ${b2} ${mid + s * neck}, ${b2} ${mid + s * half}, ${x + w} ${mid + s * half}`;
      const gap = (a2 - b1) / list.length;
      return `${root(a, 'neck')}<path class="wall" d="${wall(-1)}" fill="none" stroke-width="1.6" style="stroke:var(--rule)"/><path class="wall" d="${wall(1)}" fill="none" stroke-width="1.6" style="stroke:var(--rule)"/>`
        + `<path class="neck-flow"${a.id ? ` id="${a.id}-flow"` : ''} d="M ${round(x + w * .14)} ${mid} L ${round(x + w * .84)} ${mid}" fill="none" stroke="none"/>`
        + (a.input ? `<text class="nm-l neck-in" x="${x + 24}" y="${mid + 7}">${esc(a.input)}</text>` : '')
        + (a.output ? `<text class="nm-l neck-out" x="${x + w - 24}" y="${mid + 7}" text-anchor="end">${esc(a.output)}</text>` : '')
        + list.map(([name, detail], k) => {
          const gx = round(b1 + gap * (k + .5)), top = mid + neck + 46;
          return `${part(a, k)}<path class="seg conn-a" d="M ${gx} ${round(mid - neck)} L ${gx} ${round(mid + neck)}"/>${dot(gx, round(mid - neck), 8)}<g class="body"><rect class="card" x="${round(gx - gap / 2 + 10)}" y="${round(top)}" width="${round(gap - 20)}" height="${detail ? 86 : 58}" rx="10"/><text class="nm" x="${gx}" y="${round(top + 34)}" text-anchor="middle">${esc(name)}</text>${detail ? `<text class="sm" x="${gx}" y="${round(top + 60)}" text-anchor="middle">${esc(detail)}</text>` : ''}</g></g>`;
        }).join('') + '</g>';
    },
  },
};
