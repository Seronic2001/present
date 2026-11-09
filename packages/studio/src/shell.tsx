// Present Studio: slides on the left, the deck in the middle, the agent and its sources on the right.
// Either side folds away, so the slide can have the window when it is half a screen.
// The preview is the real deck in a same-origin iframe, so this page reads the player directly.
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import arrowUp from '@primer/octicons/build/svg/arrow-up-16.svg';
import browser from '@primer/octicons/build/svg/browser-16.svg';
import check from '@primer/octicons/build/svg/check-16.svg';
import download from '@primer/octicons/build/svg/download-16.svg';
import eye from '@primer/octicons/build/svg/eye-16.svg';
import sidebarCollapse from '@primer/octicons/build/svg/sidebar-collapse-16.svg';
import sidebarExpand from '@primer/octicons/build/svg/sidebar-expand-16.svg';
import deviceDesktop from '@primer/octicons/build/svg/device-desktop-16.svg';
import screenFull from '@primer/octicons/build/svg/screen-full-16.svg';
import chevronDown from '@primer/octicons/build/svg/chevron-down-16.svg';
import chevronLeft from '@primer/octicons/build/svg/chevron-left-16.svg';
import chevronRight from '@primer/octicons/build/svg/chevron-right-16.svg';
import camera from '@primer/octicons/build/svg/device-camera-16.svg';
import tasklist from '@primer/octicons/build/svg/tasklist-16.svg';
import playIcon from '@primer/octicons/build/svg/play-16.svg';
import plus from '@primer/octicons/build/svg/plus-16.svg';
import sliders from '@primer/octicons/build/svg/sliders-16.svg';
import stop from '@primer/octicons/build/svg/square-fill-16.svg';
import bars from '@primer/octicons/build/svg/three-bars-16.svg';
import undoIcon from '@primer/octicons/build/svg/undo-16.svg';
import uploadIcon from '@primer/octicons/build/svg/upload-16.svg';
import close from '@primer/octicons/build/svg/x-16.svg';
import CSS from './shell.css';

const { token } = (window as any).__PRESENT_DEV as { token: string };
const W = 1920, H = 1080;
/** Side widths, and the least the slide may be left with before a side folds. */
const RAIL = 188, SIDE = 340, MIN_STAGE = 560;
const LIMITS = { rail: [140, 320], side: [280, 600] } as const;
/** The chat narrows, down to its least, before it folds: the slide keeps MIN_STAGE either way. */
const sideFor = (width: number, side: number) => Math.max(LIMITS.side[0], Math.min(side, width - MIN_STAGE));
const clampW = (k: 'rail' | 'side', w: number) => Math.round(Math.max(LIMITS[k][0], Math.min(LIMITS[k][1], isNaN(w) ? (k === 'rail' ? RAIL : SIDE) : w)));
/** Which sides fit beside a usable slide. The chat goes last: it is how the deck gets changed. */
function fitSides(width: number, w: { rail: number; side: number }, want: { rail: boolean; panel: boolean }) {
  const panel = want.panel && width - LIMITS.side[0] >= MIN_STAGE;
  w = { ...w, side: sideFor(width, w.side) };
  // The list folds first and stays folded while the chat is out for room, so the sides never swap places.
  return { panel, rail: want.rail && (panel || !want.panel) && width - (panel ? w.side : 0) - w.rail >= MIN_STAGE };
}
/** Only the desktop app can reach other screens. */
const desktop = (window as any).presentDesktop as undefined | {
  displays(): Promise<Display[]>; start(o: { display?: number; slide?: number }): Promise<void>; stop(): Promise<void>;
  onShow(f: (s: { running: boolean; displays: Display[] }) => void): void; onToggle(f: () => void): void; onBegin(f: () => void): void; menu(): void; platform: string; exportDeck(o: { format: string; steps?: boolean }): Promise<boolean>;
};
interface Display { id: number; label: string; primary: boolean; width: number; height: number; }

const api = async (path: string, body?: unknown) => {
  const r = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-present-token': token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const v = await r.json();
  if (!r.ok) throw new Error(v.error ?? 'Request failed');
  return v;
};
const upload = async (blob: Blob, name: string, folder = '') => {
  const r = await fetch(`/api/references?name=${encodeURIComponent(name)}&folder=${folder}`, { method: 'POST', headers: { 'x-present-token': token }, body: blob });
  const v = await r.json();
  if (!r.ok) throw new Error(v.error ?? 'Upload failed');
  return v as Ref;
};
const fileUrl = (path: string) => `/api/reference-file?token=${token}&path=${encodeURIComponent(path)}`;
const stamp = () => new Date().toTimeString().slice(0, 8).replaceAll(':', '');
const size = (n: number) => (n < 1e6 ? `${Math.ceil(n / 1e3)} KB` : `${(n / 1e6).toFixed(1)} MB`);

const cursor = '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 1.6v11.6l3.2-3 2 4.6 2-.9-2-4.5 4.4-.3z"/></svg>';
const loop = '<svg width="16" height="16" viewBox="0 0 16 16" style="fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round"><path d="M9.5 13.8C5 15 1.6 12.6 1.6 8.8 1.6 4.6 5 2 8.6 2c3.4 0 5.8 2.2 5.8 5.2 0 3-2.6 5-5.6 4.8"/></svg>';
const Icon = ({ svg }: { svg: string }) => <span class="icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;

/** What the human reads in place of a tool's name. */
const STEP: Record<string, string> = {
  catalog: 'Read the catalog', plan_write: 'Wrote the plan', plan_read: 'Read the plan', plan_status: 'Updated the plan', deck_create: 'Created the deck', pattern_read: 'Read a pattern', library_add: 'Added from the library', library_save: 'Saved to the library', library_read: 'Read a library item', library_remove: 'Removed from the library', deck_outline: 'Read the outline', slide_read: 'Read a slide', deck_apply: 'Edited the deck', deck_undo: 'Undid a change',
  slide_render: 'Looked at a slide', slide_filmstrip: 'Checked the motion', deck_check: 'Checked the deck', annotations_list: 'Read your comments',
  annotations_resolve: 'Closed comments', references_list: 'Listed references', reference_read: 'Read a reference', deck_export: 'Exported',
};
const IDEAS = ['Plan a deck from my references', 'Tighten this slide', 'Check the whole deck for problems'];

/** Agent replies are Markdown. This covers what they use, and builds nodes, so nothing in a reply becomes HTML. */
function inline(s: string) {
  return s.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map(x =>
    x.startsWith('`') && x.length > 2 ? <code>{x.slice(1, -1)}</code> : x.startsWith('**') && x.length > 4 ? <b>{x.slice(2, -2)}</b> : x);
}
function Markdown({ text }: { text: string }) {
  const out: any[] = [];
  text.trim().split(/(```[\s\S]*?(?:```|$))/).forEach((chunk, i) => {
    if (i % 2) { out.push(<pre>{chunk.replace(/^```.*\n?/, '').replace(/\n?```$/, '')}</pre>); return; }
    for (const block of chunk.split(/\n{2,}/).map(b => b.trim()).filter(Boolean)) {
      const lines = block.split('\n');
      if (lines.every(l => /^\s*[-*] /.test(l))) out.push(<ul>{lines.map(l => <li>{inline(l.replace(/^\s*[-*] /, ''))}</li>)}</ul>);
      else if (lines.every(l => /^\s*\d+\. /.test(l))) out.push(<ol>{lines.map(l => <li>{inline(l.replace(/^\s*\d+\. /, ''))}</li>)}</ol>);
      else out.push(<p>{inline(block.replace(/^#+ /, ''))}</p>);
    }
  });
  return <>{out}</>;
}
/** Runs of tool calls read as one line of progress. */
const DOING: Record<string, string> = {
  Read: 'Reading', Wrote: 'Writing', Updated: 'Updating', Created: 'Creating', Added: 'Adding', Saved: 'Saving', Removed: 'Removing',
  Edited: 'Editing', Undid: 'Undoing', Looked: 'Looking', Checked: 'Checking', Closed: 'Closing', Listed: 'Listing', Exported: 'Exporting',
};
const stepLabel = (t: string) => STEP[t] ?? t;
/** "Edited the deck" while it is still going on: "Editing the deck". A tool with no label is named as it is. */
const doing = (t: string) => { const l = stepLabel(t), [verb, ...rest] = l.split(' '); return DOING[verb] ? [DOING[verb], ...rest].join(' ') : `Running ${l}`; };

/** A reply is the agent's work, then its answer. The work (steps, and what it said along the way) folds into one line once
 *  the reply is done, so the answer is what reads. While it runs, one line says what it is doing now. */
function Reply({ parts, live }: { parts: any[]; live: boolean }) {
  const lastTool = parts.findLastIndex(p => p.tool);
  let work = parts.slice(0, lastTool + 1), answer = parts.slice(lastTool + 1);
  // Ended on a step with nothing after it: the last thing it said is the answer.
  if (!live && !answer.some(p => p.text || p.error)) {
    const k = work.findLastIndex(p => p.text);
    if (k >= 0) { answer = [work[k]]; work = work.filter((_, n) => n !== k); }
  }
  const steps = work.filter(p => p.tool).length;
  const log = work.map(p => (p.tool ? <code title={p.tool}>{stepLabel(p.tool)}</code> : p.text ? <div class="said"><Markdown text={p.text} /></div> : <span class="oops">{p.error}</span>));
  const errors = work.filter(p => p.error);
  const body = answer.map(p => (p.text ? <Markdown text={p.text} /> : p.error ? <span class="oops">{p.error}</span> : null));
  if (live) {
    const now = parts.at(-1)?.tool ?? (lastTool >= 0 ? parts[lastTool].tool : null);
    const said = [...parts].reverse().find(p => p.text)?.text;
    return <>
      {steps ? <details class="work"><summary>{steps} step{steps > 1 ? 's' : ''} so far</summary><div class="log steps">{log}</div></details> : null}
      {answer.length ? body : said ? <div class="said"><Markdown text={said} /></div> : null}
      <div class="doing" role="status"><i class="spin" />{now ? `${doing(now)}…` : 'Thinking…'}</div>
    </>;
  }
  return <>
    {steps ? <details class="work"><summary>Worked · {steps} step{steps > 1 ? 's' : ''}{errors.length ? <em> · {errors.length} problem{errors.length > 1 ? 's' : ''}</em> : null}</summary><div class="log steps">{log}</div></details> : null}
    {body}
  </>;
}
/** The agent's plan beside what has been built. Comments reach an agent however it is running. */
function PlanView({ plan, canTalk, onReview, onClose, onOpen }: { plan: any; canTalk: boolean; onReview: (status: string, comment?: { text: string; slide?: string }) => void; onClose: () => void; onOpen: (number: number) => void }) {
  const [text, setText] = useState('');
  const [slide, setSlide] = useState<string | undefined>();
  const send = () => { onReview('changes', { text, slide }); setText(''); setSlide(undefined); };
  const label: Record<string, string> = { proposed: 'Waiting for your review', changes: 'Changes requested', approved: 'Approved' };
  const state: Record<string, string> = { planned: 'To build', built: 'Built', problem: 'Has errors' };
  return <section class="plan" role="region" aria-label="Plan">
    <div class="planhead">
      <span class="grow"><b>Plan</b> <small>{label[plan.status]} · {plan.built} of {plan.slides.length} built</small></span>
      {plan.status !== 'approved' ? <button class="btn primary" onClick={() => onReview('approved')}>Approve plan</button> : null}
      <button class="ghost square" aria-label="Close plan" onClick={onClose}><Icon svg={close} /></button>
    </div>
    <div class="planbody">
      <h2>{plan.goal}</h2>
      <p class="planmeta">{[plan.audience, plan.minutes ? `${plan.minutes} minutes` : '', `${plan.slides.length} slides`].filter(Boolean).join(' · ')}</p>
      {plan.story ? <p>{plan.story}</p> : null}
      {plan.questions?.length ? <div class="planq"><h3>Questions for you</h3><ul>{plan.questions.map((q: string) => <li>{q}</li>)}</ul></div> : null}
      {plan.issues.map((i: any) => <p class={'planissue ' + i.severity}>{i.slide ? `${i.slide}: ` : ''}{i.message}. {i.fix}.</p>)}
      <ol class="story">{plan.slides.map((s: any, k: number) => <li class={'beat ' + s.state}>
        <div class="beathead">
          <span class="n">{k + 1}</span>
          <b class="grow">{s.title}</b>
          <span class={'state ' + s.state}>{state[s.state]}</span>
          {s.number > 0 ? <button class="ghost" onClick={() => onOpen(s.number)}>Open</button> : null}
          <button class="ghost" aria-pressed={slide === s.id} onClick={() => setSlide(x => (x === s.id ? undefined : s.id))}>Comment</button>
        </div>
        <p>{s.claim}</p>
        <dl>
          {s.under ? <><dt>Deep dive</dt><dd>Under {s.under}</dd></> : null}
          {s.component || s.pattern ? <><dt>Starts from</dt><dd>{s.component ? `Library: ${s.component}` : s.pattern}</dd></> : null}
          {s.visual ? <><dt>On screen</dt><dd>{s.visual}</dd></> : null}
          {s.animation?.length ? <><dt>Animation</dt><dd><ol>{s.animation.map((b: string) => <li>{b}</li>)}</ol></dd></> : null}
          {s.evidence?.length ? <><dt>Evidence</dt><dd>{s.evidence.map((e: any) => <div>{e.claim ? `${e.claim}: ` : ''}<code>{e.source}</code></div>)}</dd></> : null}
        </dl>
      </li>)}</ol>
      {plan.sources?.length ? <div class="plansrc"><h3>Sources</h3>{plan.sources.map((s: any) => <div><code>{s.path}</code>{s.use ? ` ${s.use}` : ''}</div>)}</div> : null}
      {plan.openFeedback.length ? <div class="plansrc"><h3>Your comments</h3>{plan.openFeedback.map((f: any) => <div>{f.slide ? `${f.slide}: ` : ''}{f.text}</div>)}</div> : null}
    </div>
    <div class="planfoot">
      <textarea rows={2} value={text} aria-label="Comment on the plan" placeholder={slide ? `Comment on ${slide}` : 'Ask for a change to the plan'} onInput={e => setText(e.currentTarget.value)} />
      <button class="btn" disabled={!text.trim()} onClick={send}>Request changes</button>
    </div>
    {!canTalk ? <p class="plannote">An agent in a terminal reads your review the next time it calls plan_read. Tell it to continue.</p> : null}
  </section>;
}

function tile(name: string) {
  const e = name.split('.').pop()!.toLowerCase();
  const cls = e === 'pdf' ? 'pdf' : ['doc', 'docx'].includes(e) ? 'doc' : ['csv', 'tsv', 'xlsx', 'json'].includes(e) ? 'data' : '';
  return <span class={'tile ' + cls}>{e.slice(0, 4).toUpperCase()}</span>;
}

interface Ref { path: string; name: string; kind: string; bytes: number; }
interface Item { key: string; kind: 'element' | 'capture' | 'file'; label: string; slide?: string; step?: number; id?: string; src?: string; text?: string; path?: string; ids?: string[]; }
interface Pt { x: number; y: number; }
type Tool = 'none' | 'pick' | 'circle';

const loadImage = (url: string) => new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('Could not render this frame. Is Chrome or Edge installed?')); i.src = url; });
const toBlob = (c: HTMLCanvasElement) => new Promise<Blob>(ok => c.toBlob(b => ok(b!), 'image/png'));
const bounds = (pts: Pt[]) => {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};
function within(p: Pt, poly: Pt[]) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}
/** Cuts a region out of an image, and draws the human's mark on it when there is one. */
async function cut(img: HTMLImageElement, pts: Pt[], mark: boolean) {
  const b = bounds(pts), pad = mark ? 28 : 0;
  const x = Math.max(0, b.x0 - pad), y = Math.max(0, b.y0 - pad);
  const w = Math.min(img.naturalWidth, b.x1 + pad) - x, h = Math.min(img.naturalHeight, b.y1 + pad) - y;
  const c = document.createElement('canvas');
  c.width = Math.max(1, w); c.height = Math.max(1, h);
  const g = c.getContext('2d')!;
  g.drawImage(img, -x, -y);
  if (mark) {
    g.strokeStyle = '#0969da'; g.lineWidth = 5; g.lineJoin = 'round';
    g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x - x, p.y - y) : g.moveTo(p.x - x, p.y - y))); g.closePath(); g.stroke();
  }
  return toBlob(c);
}

/** A surface to draw a loop on. Reports the stroke in its own CSS pixels. */
function Lasso({ onDone }: { onDone: (pts: Pt[]) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const pts = useRef<Pt[]>([]);
  const at = (e: PointerEvent) => { const r = ref.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const draw = () => {
    const c = ref.current!, r = c.getBoundingClientRect(), d = devicePixelRatio;
    c.width = r.width * d; c.height = r.height * d;
    const g = c.getContext('2d')!;
    g.scale(d, d); g.strokeStyle = '#0969da'; g.fillStyle = '#0969da1f'; g.lineWidth = 2.5; g.lineJoin = 'round';
    g.beginPath(); pts.current.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.fill(); g.stroke();
  };
  return <canvas ref={ref} class="lasso" onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); pts.current = [at(e)]; }}
    onPointerMove={e => { if (pts.current.length) { pts.current.push(at(e)); draw(); } }}
    onPointerUp={() => { const p = pts.current; pts.current = []; draw(); if (p.length > 2) onDone(p); }} />;
}

function App() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [outline, setOutline] = useState<any>(null);
  const [cur, setCur] = useState<any>(null);
  const [tool, setTool] = useState<Tool>('none');
  const [play, setPlay] = useState(false);
  const [refs, setRefs] = useState<Ref[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [agent, setAgent] = useState(localStorage.getItem('present-agent') ?? '');
  const [chat, setChat] = useState<any>({ messages: [], running: false });
  const [text, setText] = useState('');
  const [tab, setTab] = useState<'chat' | 'sources'>('chat');
  // A side the human folded stays folded. With no choice made, a narrow window starts without the slide list.
  // What the human chose for each side, and how wide they dragged it. The window decides the rest: a side that
  // would leave the slide too little room folds, and comes back when the window is wide again.
  const pref = useRef({ rail: localStorage.getItem('present-show-rail') !== 'off', panel: localStorage.getItem('present-show-panel') !== 'off' });
  const [widths, setWidths] = useState(() => ({ rail: clampW('rail', +(localStorage.getItem('present-rail-w') ?? RAIL)), side: clampW('side', +(localStorage.getItem('present-side-w') ?? SIDE)) }));
  const room = (w = widths) => fitSides(innerWidth, w, pref.current);
  const [rail, setRail] = useState(() => room().rail);
  const [panel, setPanel] = useState(() => room().panel);
  const [resizing, setResizing] = useState<'' | 'rail' | 'side'>('');
  const [winW, setWinW] = useState(innerWidth);
  const [toast, setToast] = useState('');
  const [crop, setCrop] = useState<{ url: string; img: HTMLImageElement } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [ready, setReady] = useState(false);
  const [menu, setMenu] = useState(false);
  const [follow, setFollow] = useState(localStorage.getItem('present-follow') !== 'off');
  const [showing, setShowing] = useState(false);
  const [screens, setScreens] = useState<Display[] | null>(null);
  const [exporting, setExporting] = useState<'menu' | 'busy' | null>(null);
  const [problemList, setProblemList] = useState<any[] | null>(null);
  const [plan, setPlan] = useState<any>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [warnings, setWarnings] = useState(false);
  const [sure, setSure] = useState('');
  const [loaded, setLoaded] = useState<Record<string, boolean>>({});
  const picker = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const toolRef = useRef(tool); toolRef.current = tool;
  const followRef = useRef(follow); followRef.current = follow;
  const playRef = useRef(play); playRef.current = play;

  const win = () => frame.current?.contentWindow as any;
  const player = () => win()?.__present;
  const say = (m: string) => { setToast(m); setTimeout(() => setToast(t => (t === m ? '' : t)), 3500); };
  const fail = (e: any) => say(e.message ?? String(e));
  const attach = (it: Item) => { setPanel(true); setItems(l => (l.some(x => x.key === it.key) ? l : [...l, it])); };
  const refreshOutline = () => api('outline').then(setOutline).catch(fail);
  const refreshRefs = () => api('references').then(setRefs).catch(fail);
  /** A new proposal opens itself: it is waiting on the human. */
  const refreshPlan = (reveal = false) => api('plan').then(p => { setPlan(p); if (reveal && p?.status === 'proposed') setPlanOpen(true); }).catch(fail);
  /** Goes to the slide an agent just changed. A new slide may not have reached the preview yet. */
  const showEdited = (id: string, tries = 20) => {
    const p = player()?.player;
    if (!p) return;
    const i = p.order.findIndex((s: any) => s.id === id);
    if (i < 0) { if (tries) setTimeout(() => showEdited(id, tries - 1), 50); return; }
    if (i !== p.idx) p.show(i, { instant: true });
  };
  /** Follows a change to one slide. A change to the slide in view, or to several at once, leaves the view where it is:
   *  there is no one slide to go to, and jumping to whichever was saved last looks random. */
  const followEdits = (ids: string[]) => {
    const p = player()?.player;
    if (!p || ids.includes(p.order[p.idx]?.id)) return;
    if (ids.length === 1) showEdited(ids[0]);
    else say(`The agent changed ${ids.length} slides`);
  };

  useEffect(() => {
    refreshOutline(); refreshRefs(); refreshPlan();
    api('chat').then(setChat).catch(fail);
    api('agents').then((l: any[]) => {
      setAgents(l);
      setAgent(a => (l.some(x => x.id === a && x.available) ? a : l.find(x => x.available)?.id ?? ''));
    }).catch(fail);
    const es = new EventSource(`/api/events?token=${token}`);
    es.onmessage = () => { refreshOutline(); refreshPlan(); };
    es.addEventListener('plan', () => refreshPlan(true));
    es.addEventListener('chat', (e: any) => setChat(JSON.parse(e.data)));
    es.addEventListener('refs', () => refreshRefs());
    es.addEventListener('edited', (e: any) => {
      const ids = [JSON.parse(e.data)].flat() as string[];
      if (followRef.current && !playRef.current) followEdits(ids);
    });
    return () => es.close();
  }, []);
  useEffect(() => { if (agent) localStorage.setItem('present-agent', agent); }, [agent]);
  useEffect(() => { localStorage.setItem('present-follow', follow ? 'on' : 'off'); }, [follow]);
  // A button press is a choice, and is kept. Folding for a small window is not.
  const toggleRail = () => setRail(x => { pref.current.rail = !x; localStorage.setItem('present-show-rail', x ? 'off' : 'on'); return !x; });
  const togglePanel = () => setPanel(x => { pref.current.panel = !x; localStorage.setItem('present-show-panel', x ? 'off' : 'on'); return !x; });
  // Only a change in what fits moves a side, so a side opened by hand in a small window stays open until the window crosses a line.
  const fitted = useRef(room());
  useEffect(() => {
    const onResize = () => {
      setWinW(innerWidth);
      const f = fitSides(innerWidth, widthsRef.current, pref.current), was = fitted.current;
      if (f.rail !== was.rail) setRail(f.rail);
      if (f.panel !== was.panel) setPanel(f.panel);
      fitted.current = f;
    };
    addEventListener('resize', onResize);
    return () => removeEventListener('resize', onResize);
  }, []);
  const widthsRef = useRef(widths); widthsRef.current = widths;
  /** Drags the edge of a side. The slide takes whatever is left, live. Double-click puts it back. */
  const grip = (which: 'rail' | 'side') => ({
    onPointerDown: (e: PointerEvent) => {
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setResizing(which);
    },
    onPointerMove: (e: PointerEvent) => {
      if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
      const w = clampW(which, which === 'rail' ? e.clientX : innerWidth - e.clientX);
      setWidths(x => ({ ...x, [which]: w }));
    },
    onPointerUp: () => {
      setResizing('');
      localStorage.setItem(`present-${which}-w`, String(widthsRef.current[which]));
      fitted.current = room(widthsRef.current);
    },
    onDblClick: () => { const w = which === 'rail' ? RAIL : SIDE; setWidths(x => ({ ...x, [which]: w })); localStorage.removeItem(`present-${which}-w`); },
  });
  useEffect(() => {
    desktop?.onShow(s => { setShowing(s.running); setScreens(null); });
    desktop?.onToggle(() => toggleShowRef.current());
    desktop?.onBegin(() => presentRef.current(1));
  }, []);
  useEffect(() => {
    if (!menu) return;
    const away = (e: Event) => { if (!(e.target as Element).closest('.menu,[aria-haspopup]')) setMenu(false); };
    addEventListener('pointerdown', away);
    return () => removeEventListener('pointerdown', away);
  }, [menu]);
  useEffect(() => {
    if (!screens && exporting !== 'menu' && !problemList) return;
    const away = (e: Event) => {
      if ((e.target as Element).closest('.menu,.problems,[aria-haspopup]')) return;
      setScreens(null); setProblemList(null); setExporting(x => (x === 'menu' ? null : x));
    };
    addEventListener('pointerdown', away);
    return () => removeEventListener('pointerdown', away);
  }, [screens, exporting, problemList]);
  // An open list follows the deck, so a fixed problem leaves it.
  useEffect(() => { if (problemList) api('problems').then(setProblemList).catch(fail); }, [outline?.revision]);
  useEffect(() => { log.current?.scrollTo(0, log.current.scrollHeight); }, [chat, tab]);

  // ---- files, however they arrive
  const addFiles = async (files: File[], folder = '') => {
    for (const f of files) {
      try {
        const r = await upload(f, f.name || `pasted-${stamp()}.png`, folder);
        attach({ key: r.path, kind: f.type.startsWith('image/') ? 'capture' : 'file', label: r.name, path: r.path });
      } catch (e) { fail(e); }
    }
    refreshRefs();
  };
  const addFilesRef = useRef(addFiles); addFilesRef.current = addFiles;

  // ---- tools
  const framed = (s: any) => {
    const rest = s.rested && s.step === s.steps;
    return `/api/frame?token=${token}&slide=${s.slide}&v=${outline?.revision ?? ''}${rest ? '' : `&step=${s.step}&t=${Math.round(s.t)}`}`;
  };
  const shot = async () => {
    const s = player()?.state();
    if (!s) return;
    try {
      const png = await (await fetch(framed(s))).blob();
      const r = await upload(png, `${s.id}-${stamp()}.png`, 'captures');
      attach({ key: r.path, kind: 'capture', label: `Slide ${s.slide}`, path: r.path, slide: s.id, step: s.step });
      refreshRefs(); say('Screenshot added');
    } catch (e) { fail(e); }
  };
  const circled = async (pts: Pt[]) => {
    const s = player()?.state(), el = frame.current!;
    const k = Math.min(el.clientWidth / W, el.clientHeight / H), ox = (el.clientWidth - W * k) / 2, oy = (el.clientHeight - H * k) / 2;
    const stage = pts.map(p => ({ x: Math.round((p.x - ox) / k), y: Math.round((p.y - oy) / k) }));
    const b = bounds(pts);
    if (!s || b.x1 - b.x0 < 12 || b.y1 - b.y0 < 12) return;
    const inside = [...player().player.section.querySelectorAll('[id]')].filter((n: any) => n !== player().player.section).filter((n: any) => {
      const r = n.getBoundingClientRect();
      return r.width > 0 && within({ x: r.left + r.width / 2, y: r.top + r.height / 2 }, pts);
    }).map((n: any) => n.id).slice(0, 12);
    try {
      const png = await cut(await loadImage(framed(s)), stage, true);
      const r = await upload(png, `${s.id}-region-${stamp()}.png`, 'captures');
      attach({ key: r.path, kind: 'capture', label: `Region, slide ${s.slide}`, path: r.path, slide: s.id, step: s.step, ids: inside });
      refreshRefs(); setTool('none');
    } catch (e) { fail(e); }
  };
  const grabWindow = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const v = document.createElement('video');
      v.srcObject = stream; v.muted = true;
      await v.play();
      await new Promise(ok => requestAnimationFrame(ok));
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d')!.drawImage(v, 0, 0);
      stream.getTracks().forEach(t => t.stop());
      const url = URL.createObjectURL(await toBlob(c));
      setCrop({ url, img: await loadImage(url) });
    } catch (e: any) { if (e.name !== 'NotAllowedError') fail(e); }
  };
  const saveCrop = async (blob: Blob) => {
    try {
      const r = await upload(blob, `screen-${stamp()}.png`, 'captures');
      attach({ key: r.path, kind: 'capture', label: 'Screen capture', path: r.path });
      refreshRefs();
    } catch (e) { fail(e); }
    setCrop(null);
  };
  const go = (d: number) => { const s = player()?.state(); if (s) player().player.show(s.slide - 1 + d); };

  // ---- presenting: on the external screen if there is one, and ask only when there is a real choice
  const startAt = useRef<number | undefined>(undefined);      // a slide to start on; otherwise the one on screen
  const startShow = (display?: number) => { setScreens(null); desktop?.start({ display, slide: startAt.current ?? player()?.state().slide }).catch(fail); };
  const toggleShow = () => { if (showing) desktop?.stop().catch(fail); else { startAt.current = undefined; startShow(); } };
  const toggleShowRef = useRef(toggleShow); toggleShowRef.current = toggleShow;
  const present = async (slide?: number) => {
    if (showing) { toggleShow(); return; }
    startAt.current = slide;
    try {
      const all = await desktop!.displays();
      if (all.length > 1) setScreens(all); else startShow();
    } catch (e) { fail(e); }
  };

  const presentRef = useRef(present); presentRef.current = present;

  const review = async (status: string, comment?: { text: string; slide?: string }) => {
    try {
      setPlan(await api('plan', { status, comment }));
      if (!chat.messages.length || chat.running || !agent) { say(status === 'approved' ? 'Plan approved' : 'Comment saved'); return; }
      await api('chat', { agent, context: [], text: status === 'approved' ? 'The plan is approved. Build it, and keep to it.' : 'I left comments on the plan. Read them with plan_read, then write a new plan.' });
      setPlanOpen(false); setTab('chat'); setPanel(true);
    } catch (e) { fail(e); }
  };
  const save = async (format: string, steps = false) => {
    setExporting('busy');
    say('Exporting…');
    try { if (await desktop!.exportDeck({ format, steps })) say('Exported'); } catch (e) { fail(e); }
    setExporting(null);
  };
  const showProblems = async (slide?: number) => {
    if (slide) player()?.player.show(slide - 1);
    try { setProblemList(await api('problems')); } catch (e) { fail(e); }
  };
  /** Hands one problem to the agent, with the slide attached to the message as usual. */
  const askToFix = (d: any) => {
    setText(`Fix this problem on ${d.slide ?? 'the deck'}: ${d.message} ${d.fix}`);
    setProblemList(null); setPanel(true);
    setTimeout(() => (document.querySelector('.composer textarea') as HTMLElement | null)?.focus());
  };

  // ---- the preview: follow its slide, and pick parts out of it
  const onPreview = () => {
    const w = win();
    const ready = () => {
      if (!w.__present) { setTimeout(ready, 40); return; }
      w.__present.player.listeners.push(setCur);
      setCur(w.__present.state());
      setReady(true);
      const doc: Document = w.document;
      const style = doc.createElement('style');
      style.textContent = '.st-hover{outline:2px solid #0969da!important;outline-offset:2px;cursor:copy}';
      doc.head.appendChild(style);
      const target = (e: Event) => (e.target as Element).closest?.('[data-src]');
      const clear = () => doc.querySelectorAll('.st-hover').forEach(x => x.classList.remove('st-hover'));
      doc.addEventListener('mousemove', e => { clear(); if (toolRef.current === 'pick') target(e)?.classList.add('st-hover'); });
      doc.addEventListener('click', e => {
        if (toolRef.current !== 'pick' || (e.target as Element).closest('#present-studio')) return;
        const el = target(e);
        if (!el) return;
        e.preventDefault(); e.stopPropagation();
        const named = el.closest('[id]'), s = w.__present.state();
        const id = el.id || (named?.closest('.p-body') && named.id) || '';
        const t = el.textContent?.trim() ?? '';
        attach({ key: `${s.id}#${id || el.getAttribute('data-src')}`, kind: 'element', label: id || t.slice(0, 28) || el.tagName.toLowerCase(), slide: s.id, step: s.step, id, src: el.getAttribute('data-src') ?? undefined, text: t });
      }, true);
      doc.addEventListener('keydown', onKey);
      doc.addEventListener('dragenter', () => setDragging(true));
      doc.addEventListener('paste', onPaste);
    };
    ready();
  };
  useEffect(() => {
    if (win()) win().__presentStudioActive = tool === 'pick';
    if (tool !== 'pick') win()?.document?.querySelectorAll('.st-hover').forEach((x: Element) => x.classList.remove('st-hover'));
  }, [tool]);

  // ---- keys, paste, drop, here and inside the preview
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (e.key === 'Escape') { setTool('none'); setMenu(false); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && ['b', 'j'].includes(e.key.toLowerCase())) {
      e.preventDefault();
      if (e.key.toLowerCase() === 'b') toggleRailRef.current(); else togglePanelRef.current();
      return;
    }
    if (t.closest?.('input,textarea,select') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'v') setTool(x => (x === 'pick' ? 'none' : 'pick'));
    else if (k === 'c') setTool(x => (x === 'circle' ? 'none' : 'circle'));
    else if (k === 's') shotRef.current();
    else if (k === 'arrowright') goRef.current(1);
    else if (k === 'arrowleft') goRef.current(-1);
    // A playing preview hears its own keys. A still one, or a key pressed out here, does not.
    else if (k === 'p' && (t.ownerDocument === document || player()?.player.mode === 'still')) player()?.player.presenter();
  };
  const shotRef = useRef(shot); shotRef.current = shot;
  const toggleRailRef = useRef(toggleRail); toggleRailRef.current = toggleRail;
  const togglePanelRef = useRef(togglePanel); togglePanelRef.current = togglePanel;
  const goRef = useRef(go); goRef.current = go;
  const onPaste = (e: ClipboardEvent) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length) { e.preventDefault(); addFilesRef.current(files, files.every(f => f.type.startsWith('image/')) ? 'captures' : ''); }
  };
  useEffect(() => {
    const enter = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) setDragging(true); };
    addEventListener('keydown', onKey); addEventListener('paste', onPaste); addEventListener('dragenter', enter);
    return () => { removeEventListener('keydown', onKey); removeEventListener('paste', onPaste); removeEventListener('dragenter', enter); };
  }, []);

  // ---- chat
  const send = async () => {
    if (!text.trim() || chat.running || !agent) return;
    const context = items.map(({ key, ...rest }) => rest);
    const s = player()?.state();
    try {
      await api('chat', { agent, text, context, viewing: s ? `slide ${s.slide} (${s.id}), step ${s.step} of ${s.steps}` : undefined });
      setText(''); setItems([]); setTab('chat');
    } catch (e) { fail(e); }
  };
  const remove = async (r: Ref) => {
    if (sure !== r.path) { setSure(r.path); setTimeout(() => setSure(x => (x === r.path ? '' : x)), 3000); return; }
    setSure('');
    await fetch(`/api/references?path=${encodeURIComponent(r.path)}`, { method: 'DELETE', headers: { 'x-present-token': token } });
    setItems(l => l.filter(i => i.path !== r.path));
    refreshRefs();
  };
  const toggleRef = (r: Ref) => setItems(l => (l.some(i => i.key === r.path) ? l.filter(i => i.key !== r.path) : [...l, { key: r.path, kind: r.kind === 'image' ? 'capture' : 'file', label: r.name, path: r.path }]));

  const captures = refs.filter(r => r.kind === 'image');
  const docs = refs.filter(r => r.kind !== 'image');
  const problems = (outline?.slides ?? []).reduce((n: number, s: any) => n + s.errors, 0);
  const installed = agents.some(a => a.available);

  const running = agents.find(a => a.id === chat.messages.at(-1)?.agent)?.label ?? 'Agent';
  const label = agents.find(a => a.id === agent)?.label ?? 'No agent';
  const X = (r: Ref) => <button class={'x' + (sure === r.path ? ' sure' : '')} aria-label={`Delete ${r.name}`} onClick={() => remove(r)}>{sure === r.path ? 'Delete?' : <Icon svg={close} />}</button>;
  const toolBtn = (id: Tool, name: string, key: string, svg: string, tip: string) => (
    <button class={'tool' + (tool === id ? ' on' : '')} aria-label={name} aria-pressed={tool === id} data-tip={`${tip}  (${key})`} onClick={() => setTool(t => (t === id ? 'none' : id))}><Icon svg={svg} /><span class="label">{name}</span></button>
  );

  return (
    <div class={'app' + (desktop ? ' desktop' : '') + (desktop?.platform === 'darwin' ? ' mac' : '') + (rail ? '' : ' rail-off') + (panel ? '' : ' panel-off') + (resizing ? ' resizing' : '')}
      style={`--rail-w:${widths.rail}px;--side-w:${sideFor(winW, widths.side)}px`}>
      <style>{CSS}</style>
      <input ref={picker} type="file" multiple hidden aria-label="Add files" onChange={e => { addFiles([...e.currentTarget.files!]); e.currentTarget.value = ''; }} />
      <header>
        <div class="brand">
          {desktop && desktop.platform !== 'darwin' ? <button class="act square" aria-label="Menu" onClick={() => desktop.menu()}><Icon svg={bars} /></button> : null}
          <button class="act square" aria-label="Slide list" aria-pressed={rail} data-tip="Show or hide the slides  (Ctrl+B)" onClick={() => toggleRail()}><Icon svg={rail ? sidebarCollapse : sidebarExpand} /></button>
          <span class="mark" aria-hidden="true">P</span>
          <span class="title">{outline?.title ?? 'Present'}</span>
        </div>
        <div class="tools" role="toolbar" aria-label="Tools">
          {toolBtn('pick', 'Select', 'V', cursor, 'Click parts of the slide to attach them')}
          {toolBtn('circle', 'Circle', 'C', loop, 'Circle a region to attach it')}
          <button class="tool" aria-label="Screenshot" data-tip="Attach this frame  (S)" onClick={shot}><Icon svg={camera} /><span class="label">Screenshot</span></button>
          <button class="tool roomy" aria-label="Capture window" data-tip="Capture another window or screen" onClick={grabWindow}><Icon svg={browser} /><span class="label">Window</span></button>
        </div>
        <div class="actions">
          <button class="act square roomy" aria-label="Previous slide" disabled={!cur || cur.slide <= 1} onClick={() => go(-1)}><Icon svg={chevronLeft} /></button>
          <span class="count roomy">{cur ? `${cur.label ?? cur.slide} / ${(outline?.slides ?? []).filter((x: any) => !x.parent).length || cur.total}` : ''}</span>
          <button class="act square roomy" aria-label="Next slide" disabled={!cur || cur.slide >= cur.total} onClick={() => go(1)}><Icon svg={chevronRight} /></button>
          <i class="sep roomy" />
          {plan ? <button class={'act' + (planOpen ? ' on' : '')} aria-label="Plan" aria-pressed={planOpen} data-tip="How the agent will build this deck" onClick={() => setPlanOpen(o => !o)}><Icon svg={tasklist} /><span class="label wide">Plan</span></button> : null}
          <button class="act square" aria-label="Undo" data-tip="Undo the last change" onClick={() => api('undo', {}).then(r => say(r.ok ? 'Undone' : r.error)).catch(fail)}><Icon svg={undoIcon} /></button>
          <button class={'act square' + (follow ? ' on' : '')} aria-label="Follow edits" aria-pressed={follow} data-tip="Go to the slide an agent is changing" onClick={() => setFollow(f => !f)}><Icon svg={eye} /></button>
          <button class="act square roomy" aria-label="Inspect" data-tip="Timeline, text and cue timing" onClick={() => win()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'i' }))}><Icon svg={sliders} /></button>
          <button class={'act' + (play ? ' on' : '')} aria-label="Play" aria-pressed={play} onClick={() => { setReady(false); setPlay(p => !p); }}><Icon svg={play ? stop : playIcon} /><span class="label">{play ? 'Stop' : 'Play'}</span></button>
          {desktop ? <button class="act" aria-label="Export" aria-haspopup="menu" aria-expanded={exporting === 'menu'} disabled={exporting === 'busy'} data-tip="Save as HTML, PDF or PowerPoint" onClick={() => setExporting(x => (x ? null : 'menu'))}><Icon svg={download} /><span class="label">Export</span></button> : null}
          {exporting === 'menu' ? <div class="menu screens" role="menu">
            <button role="menuitem" onClick={() => save('html')}><span class="grow">HTML</span><small>One file, with animation</small></button>
            <button role="menuitem" onClick={() => save('pdf')}><span class="grow">PDF</span><small>One page per slide</small></button>
            <button role="menuitem" onClick={() => save('pdf', true)}><span class="grow">PDF with steps</span><small>One page per step</small></button>
            <button role="menuitem" onClick={() => save('pptx')}><span class="grow">PowerPoint</span><small>One picture per slide, with notes</small></button>
          </div> : null}
          {desktop && !showing ? <button class="act" aria-label="Present" aria-haspopup="menu" aria-expanded={!!screens} data-tip="Present from this slide  (F5)" onClick={() => present()}><Icon svg={deviceDesktop} /><span class="label wide">Present</span></button> : null}
          {desktop ? <button class={'act primary' + (showing ? ' on' : '')} aria-label={showing ? 'End show' : 'Start slideshow'} aria-haspopup="menu" aria-expanded={!!screens} data-tip={showing ? 'End the show  (F5)' : 'Start from the first slide'} onClick={() => present(1)}><Icon svg={screenFull} /><span class="label wide">{showing ? 'End show' : 'Start slideshow'}</span></button> : null}
          {screens ? <div class="menu screens" role="menu">{[...screens].sort((a, b) => +a.primary - +b.primary).map(d => (
            <button role="menuitem" onClick={() => startShow(d.id)}><span class="grow">{d.label}</span><small>{d.primary ? 'Main · ' : ''}{d.width}×{d.height}</small></button>))}</div> : null}
          <i class="sep" />
          <button class={'act square flip' + (!panel && chat.running ? ' working' : '')} aria-label="Agent panel" aria-pressed={panel} data-tip="Show or hide the chat and sources  (Ctrl+J)" onClick={() => togglePanel()}><Icon svg={panel ? sidebarCollapse : sidebarExpand} /></button>
        </div>
      </header>

      <nav aria-label="Slides" inert={!rail}>
        <div class="panelhead">Slides {outline ? <small>{outline.slides.length}</small> : null}</div>
        {(outline?.slides ?? []).map((s: any, i: number) => (
          <button class={'thumb' + (cur?.slide === i + 1 ? ' on' : '') + (s.depth ? ' deep' : '')} style={s.depth ? `--depth:${s.depth}` : undefined} aria-label={`Slide ${s.label ?? i + 1}: ${s.title}`} aria-current={cur?.slide === i + 1} title={s.brief} onClick={() => player()?.player.show(i)}>
            <span class="n">{s.label ?? i + 1}</span>
            <span class={'pic' + (loaded[s.id] ? ' in' : '')}>
              <img class={loaded[s.id] ? 'in' : ''} loading="lazy" alt="" src={`/api/frame?token=${token}&slide=${i + 1}&v=${outline.revision}`} onLoad={() => setLoaded(l => (l[s.id] ? l : { ...l, [s.id]: true }))} />
              {s.errors ? <em class="bad" role="button" tabIndex={0} aria-label={`Show ${s.errors} error${s.errors > 1 ? 's' : ''} on slide ${i + 1}`} onClick={e => { e.stopPropagation(); showProblems(i + 1); }}>{s.errors}</em> : s.annotations ? <em>{s.annotations}</em> : null}
            </span>
          </button>
        ))}
      </nav>

      <main>
        <div class="stage">
          <iframe ref={frame} class={ready ? 'in' : ''} key={String(play)} title="Slide preview" src={`/?${play ? 'steps' : 'still'}#${cur?.slide ?? 1}`} onLoad={onPreview} />
          {tool === 'circle' ? <Lasso onDone={circled} /> : null}
          {tool !== 'none' ? <div class="hint">{tool === 'pick' ? 'Click parts to attach them' : 'Draw a loop around what you mean'}<kbd>Esc</kbd></div> : null}
        </div>
        {planOpen && plan ? <PlanView plan={plan} canTalk={!!chat.messages.length} onReview={review} onClose={() => setPlanOpen(false)} onOpen={n => { setPlanOpen(false); player()?.player.show(n - 1); }} /> : null}
      </main>

      <aside aria-label="Agent" inert={!panel}>
        <div class="tabs" role="tablist" aria-label="Panel">
          <button role="tab" aria-selected={tab === 'chat'} class={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>Chat{chat.running && tab !== 'chat' ? <i class="pip" aria-label="Working" /> : null}</button>
          <button role="tab" aria-selected={tab === 'sources'} class={tab === 'sources' ? 'on' : ''} onClick={() => setTab('sources')}>Sources{refs.length ? <small>{refs.length}</small> : null}</button>
          <span class="grow" />
          {tab === 'chat' && chat.messages.length && !chat.running ? <button class="ghost" data-tip="Start over with a clear context" onClick={() => api('chat/reset', {}).catch(fail)}>New chat</button> : null}
        </div>
        <div class="pane thread" ref={log} role="tabpanel" aria-label="Chat" hidden={tab !== 'chat'}>
          {chat.messages.length ? chat.messages.map((m: any) => m.role === 'user'
            ? <div class="me">{m.text}{m.context?.length ? <small>{m.context.map((c: any) => <span>{c.label}</span>)}</small> : null}</div>
            : <div class="them"><Reply parts={m.parts ?? []} live={chat.running && m === chat.messages.at(-1)} /></div>)
            : <div class="welcome">
              <b>{installed ? 'What should this deck say?' : 'No agent installed'}</b>
              <p>{installed ? 'Point at a slide with Select or Circle, then ask. Changes appear on the slide as they happen.' : 'Install Claude Code, Codex or OpenCode to build and change the deck from here.'}</p>
              {installed ? <div class="ideas">{IDEAS.map(i => <button onClick={() => { setText(i); (document.querySelector('.composer textarea') as HTMLElement | null)?.focus(); }}>{i}</button>)}</div> : null}
            </div>}
          {chat.running && chat.messages.at(-1)?.role === 'user' ? <div class="them"><div class="doing" role="status"><i class="spin" />Thinking…</div></div> : null}
        </div>
        <div class="pane library" role="tabpanel" aria-label="Sources" hidden={tab !== 'sources'}>
          <section>
            <h2 class="head">Sources {docs.length ? <small>{docs.length}</small> : null}
              {docs.length ? <button class="ghost square" aria-label="Add files" onClick={() => picker.current?.click()}><Icon svg={plus} /></button> : null}
            </h2>
            {!docs.length ? <button class="empty" onClick={() => picker.current?.click()}><Icon svg={uploadIcon} /><b>Add reports, docs and data</b>Drop them anywhere, or click to browse</button> : null}
            {docs.map(r => {
              const on = items.some(i => i.key === r.path);
              return <div class={'ref' + (on ? ' on' : '')}>
                <button class="open" aria-pressed={on} title={on ? 'Attached to your next message' : 'Attach to your next message'} onClick={() => toggleRef(r)}>
                  {tile(r.name)}<span class="meta"><b>{r.name}</b><small>{size(r.bytes)}</small></span>
                </button>
                <span class="check"><Icon svg={check} /></span>
                {X(r)}
              </div>;
            })}
          </section>
          <section>
            <h2 class="head">Screenshots {captures.length ? <small>{captures.length}</small> : null}</h2>
            {!captures.length ? <p class="tip">Press <kbd>S</kbd> or paste an image.</p> : null}
            <div class="shots">{captures.map(r => {
              const on = items.some(i => i.key === r.path);
              return <div class={'shot' + (on ? ' on' : '')}>
                <button class="open" aria-pressed={on} title={r.name} onClick={() => toggleRef(r)}><img alt={r.name} loading="lazy" src={fileUrl(r.path)} /></button>
                <span class="check"><Icon svg={check} /></span>
                {X(r)}
              </div>;
            })}</div>
          </section>
        </div>
        <div class="composer">
          {items.length ? <div class="chips">{items.map(i => (
            <div class="chip" title={i.path ?? i.text}>
              {i.path && i.kind === 'capture' ? <img alt="" src={fileUrl(i.path)} /> : null}
              <span>{i.label}</span>
              <button aria-label={`Remove ${i.label}`} onClick={() => setItems(l => l.filter(x => x !== i))}><Icon svg={close} /></button>
            </div>))}</div> : null}
          <textarea rows={Math.min(5, text.split('\n').length)} value={text} aria-label="Message the agent"
            placeholder={installed ? 'Ask the agent to build or change the deck' : 'Install Claude Code, Codex or OpenCode to chat'}
            onInput={e => setText(e.currentTarget.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <div class="row">
            <button class="ghost square" aria-label="Attach files" data-tip="Attach files" onClick={() => picker.current?.click()}><Icon svg={plus} /></button>
            <button class="ghost" aria-label="Agent" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(m => !m)}>{label}<Icon svg={chevronDown} /></button>
            {menu ? <div class="menu" role="menu">{agents.map(a => (
              <button role="menuitem" disabled={!a.available} onClick={() => { setAgent(a.id); setMenu(false); }}>
                <span class="grow">{a.label}</span>
                {a.id === agent ? <Icon svg={check} /> : !a.available ? <small>Not installed</small> : null}
              </button>))}</div> : null}
            <span class="grow" />
            {chat.running
              ? <button class="send" aria-label="Stop" onClick={() => api('chat/stop', {}).catch(fail)}><Icon svg={stop} /></button>
              : <button class="send" aria-label="Send" disabled={!text.trim() || !agent} onClick={send}><Icon svg={arrowUp} /></button>}
          </div>
        </div>
      </aside>

      {rail ? <div class="grip rail" role="separator" aria-orientation="vertical" aria-label="Resize the slide list" title="Drag to resize. Double-click to reset." {...grip('rail')} /> : null}
      {panel ? <div class="grip side" role="separator" aria-orientation="vertical" aria-label="Resize the chat" title="Drag to resize. Double-click to reset." {...grip('side')} /> : null}
      <footer class="status">
        <span class="clip">{cur ? `Slide ${cur.label ?? cur.slide}${cur.depth ? ' (deep dive)' : ` of ${(outline?.slides ?? []).filter((x: any) => !x.parent).length || cur.total}`}${cur.steps ? `, step ${cur.step} of ${cur.steps}` : ''}` : ''}</span>
        <button class={problems ? 'fail' : 'good'} aria-haspopup="dialog" aria-expanded={!!problemList} onClick={() => (problemList ? setProblemList(null) : showProblems())}>{problems ? `${problems} error${problems > 1 ? 's' : ''}` : 'No problems'}</button>
        {plan ? <span>Plan {plan.built} of {plan.slides.length}</span> : null}
        <span class="grow" />
        {showing ? <span class="busy-dot">Presenting</span> : null}
        {chat.running ? <span class="busy-dot">{running} is working</span> : <span>{installed ? label : 'No agent installed'}</span>}
      </footer>

      {problemList ? (() => {
        const errs = problemList.filter(d => d.severity === 'error'), warns = problemList.filter(d => d.severity !== 'error');
        const number = (d: any) => (outline?.slides ?? []).findIndex((s: any) => s.id === d.slide) + 1;
        const row = (d: any) => <li class={d.severity === 'error' ? 'err' : 'warn'}>
          <button class="where" onClick={() => { const n = number(d); if (n) player()?.player.show(n - 1); }}>{number(d) ? `Slide ${number(d)}` : 'Deck'}{d.id ? ` · ${d.id}` : ''}</button>
          <p>{d.message}</p><small>{d.fix}</small>
          {agent ? <button class="ghost" onClick={() => askToFix(d)}>Ask the agent to fix this</button> : null}
        </li>;
        return <section class="problems" role="dialog" aria-label="Problems">
          <div class="loghead"><span class="grow">Problems</span>
            {warns.length ? <button class="ghost" onClick={() => setWarnings(w => !w)}>{warnings ? 'Hide' : 'Show'} {warns.length} warning{warns.length > 1 ? 's' : ''}</button> : null}
            <button class="ghost square" aria-label="Close problems" onClick={() => setProblemList(null)}><Icon svg={close} /></button></div>
          <ul>
            {errs.map(row)}
            {warnings ? warns.slice(0, 200).map(row) : null}
            {!errs.length && !warnings ? <li class="none">No errors{warns.length ? '. Warnings do not stop the deck from running.' : '.'}</li> : null}
          </ul>
        </section>;
      })() : null}

      {crop ? <div class="modal" role="dialog" aria-label="Crop capture">
        <div class="cropper">
          <img src={crop.url} alt="Captured screen" />
          <Lasso onDone={async pts => {
            const el = document.querySelector('.cropper img') as HTMLImageElement, k = crop.img.naturalWidth / el.clientWidth;
            saveCrop(await cut(crop.img, pts.map(p => ({ x: p.x * k, y: p.y * k })), false));
          }} />
        </div>
        <div class="modalbar">
          <span>Circle the part you want</span>
          <button class="btn" onClick={() => setCrop(null)}>Cancel</button>
          <button class="btn primary" onClick={async () => saveCrop(await (await fetch(crop.url)).blob())}>Use all of it</button>
        </div>
      </div> : null}
      {dragging ? <div class="drop" onDragOver={e => e.preventDefault()} onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); addFiles([...e.dataTransfer!.files]); }}><div><Icon svg={uploadIcon} />Drop to add to references<small>They stay in this deck's folder</small></div></div> : null}
      {toast ? <div class="toast" role="status"><Icon svg={check} />{toast}</div> : null}
    </div>
  );
}

render(<App />, document.body);
