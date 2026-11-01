// Present Studio: the deck in the middle, source material on the right, the agent in a floating bar.
// The preview is the real deck in a same-origin iframe, so this page reads the player directly.
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

const { token } = (window as any).__PRESENT_DEV as { token: string };
const W = 1920, H = 1080;

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
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [crop, setCrop] = useState<{ url: string; img: HTMLImageElement } | null>(null);
  const [dragging, setDragging] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const toolRef = useRef(tool); toolRef.current = tool;

  const win = () => frame.current?.contentWindow as any;
  const player = () => win()?.__present;
  const say = (m: string) => { setToast(m); setTimeout(() => setToast(t => (t === m ? '' : t)), 3500); };
  const fail = (e: any) => say(e.message ?? String(e));
  const attach = (it: Item) => { setItems(l => (l.some(x => x.key === it.key) ? l : [...l, it])); };
  const refreshOutline = () => api('outline').then(setOutline).catch(fail);
  const refreshRefs = () => api('references').then(setRefs).catch(fail);

  useEffect(() => {
    refreshOutline(); refreshRefs();
    api('chat').then(setChat).catch(fail);
    api('agents').then((l: any[]) => {
      setAgents(l);
      setAgent(a => (l.some(x => x.id === a && x.available) ? a : l.find(x => x.available)?.id ?? ''));
    }).catch(fail);
    const es = new EventSource(`/api/events?token=${token}`);
    es.onmessage = () => refreshOutline();
    es.addEventListener('chat', (e: any) => setChat(JSON.parse(e.data)));
    es.addEventListener('refs', () => refreshRefs());
    return () => es.close();
  }, []);
  useEffect(() => { if (agent) localStorage.setItem('present-agent', agent); }, [agent]);
  useEffect(() => { log.current?.scrollTo(0, log.current.scrollHeight); }, [chat, open]);

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
  const go = (d: number) => { const s = player()?.state(); if (s) player().player.go(s.slide - 1 + d); };

  // ---- the preview: follow its slide, and pick parts out of it
  const onPreview = () => {
    const w = win();
    const ready = () => {
      if (!w.__present) { setTimeout(ready, 40); return; }
      w.__present.player.listeners.push(setCur);
      setCur(w.__present.state());
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
    if (t.closest?.('input,textarea,select') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') setTool('none');
    else if (k === 'v') setTool(x => (x === 'pick' ? 'none' : 'pick'));
    else if (k === 'c') setTool(x => (x === 'circle' ? 'none' : 'circle'));
    else if (k === 's') shotRef.current();
    else if (k === 'arrowright') goRef.current(1);
    else if (k === 'arrowleft') goRef.current(-1);
  };
  const shotRef = useRef(shot); shotRef.current = shot;
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
      setText(''); setItems([]); setOpen(true);
    } catch (e) { fail(e); }
  };
  const remove = async (r: Ref) => {
    if (!confirm(`Delete ${r.name} from this deck's references?`)) return;
    await fetch(`/api/references?path=${encodeURIComponent(r.path)}`, { method: 'DELETE', headers: { 'x-present-token': token } });
    setItems(l => l.filter(i => i.path !== r.path));
    refreshRefs();
  };
  const toggleRef = (r: Ref) => setItems(l => (l.some(i => i.key === r.path) ? l.filter(i => i.key !== r.path) : [...l, { key: r.path, kind: r.kind === 'image' ? 'capture' : 'file', label: r.name, path: r.path }]));

  const captures = refs.filter(r => r.kind === 'image');
  const docs = refs.filter(r => r.kind !== 'image');
  const problems = (outline?.slides ?? []).reduce((n: number, s: any) => n + s.errors, 0);
  const installed = agents.some(a => a.available);

  return (
    <div class="app">
      <style>{CSS}</style>
      <header>
        <b>{outline?.title ?? 'Present'}</b>
        {problems ? <span class="bad">{problems} error{problems > 1 ? 's' : ''}</span> : null}
        <span class="grow" />
        <button class={tool === 'pick' ? 'on' : ''} title="Click parts of the slide to attach them to the chat (V)" onClick={() => setTool(t => (t === 'pick' ? 'none' : 'pick'))}>Select <kbd>V</kbd></button>
        <button class={tool === 'circle' ? 'on' : ''} title="Circle a region to attach a screenshot of it (C)" onClick={() => setTool(t => (t === 'circle' ? 'none' : 'circle'))}>Circle <kbd>C</kbd></button>
        <button title="Attach a screenshot of this frame (S)" onClick={shot}>Screenshot <kbd>S</kbd></button>
        <button title="Capture another window or screen" onClick={grabWindow}>Capture window</button>
        <i />
        <button title="Play the deck with its animation" class={play ? 'on' : ''} onClick={() => setPlay(p => !p)}>Play</button>
        <button title="Timeline, text and cue timing" onClick={() => win()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'i' }))}>Inspect</button>
        <button title="Undo the last change" onClick={() => api('undo', {}).then(r => say(r.ok ? 'Undone' : r.error)).catch(fail)}>Undo</button>
      </header>

      <nav aria-label="Slides">
        {(outline?.slides ?? []).map((s: any, i: number) => (
          <button class={'thumb' + (cur?.slide === i + 1 ? ' on' : '')} title={s.brief} onClick={() => player()?.player.go(i)}>
            <img loading="lazy" alt="" src={`/api/frame?token=${token}&slide=${i + 1}&v=${outline.revision}`} />
            <span>{i + 1}. {s.title}</span>
            {s.errors ? <em class="bad">{s.errors}</em> : s.annotations ? <em>{s.annotations}</em> : null}
          </button>
        ))}
      </nav>

      <main>
        <div class="stage">
          <iframe ref={frame} key={String(play)} title="Slide preview" src={`/?${play ? 'steps' : 'still'}#${cur?.slide ?? 1}`} onLoad={onPreview} />
          {tool === 'circle' ? <Lasso onDone={circled} /> : null}
          {tool !== 'none' ? <div class="hint">{tool === 'pick' ? 'Click parts to attach them. Esc when done.' : 'Draw a loop around what you mean.'}</div> : null}
        </div>
        <section class="dock">
          {open && chat.messages.length ? (
            <div class="log" ref={log}>
              {chat.messages.map((m: any) => m.role === 'user'
                ? <div class="me">{m.text}{m.context?.length ? <small>{m.context.map((c: any) => c.label).join(' · ')}</small> : null}</div>
                : <div class="them">
                    {(m.parts ?? []).map((p: any) => p.text ? <p>{p.text.trim()}</p> : p.tool ? <code>{p.tool}</code> : <p class="bad">{p.error}</p>)}
                  </div>)}
              {chat.running ? <div class="busy">Working…</div> : null}
            </div>
          ) : null}
          <div class="bar">
            {items.length ? <div class="chips">{items.map(i => (
              <span class="chip" title={i.path ?? i.text}>
                {i.path && i.kind === 'capture' ? <img alt="" src={fileUrl(i.path)} /> : null}
                {i.label}
                <button aria-label={`Remove ${i.label}`} onClick={() => setItems(l => l.filter(x => x !== i))}>×</button>
              </span>))}</div> : null}
            <textarea rows={Math.min(5, text.split('\n').length)} value={text} aria-label="Message the agent"
              placeholder={installed ? 'Ask the agent to build or change the deck' : 'No agent found. Install Claude Code, Codex or OpenCode.'}
              onInput={e => setText(e.currentTarget.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
            <div class="row">
              <select aria-label="Agent" value={agent} onChange={e => setAgent(e.currentTarget.value)}>
                {agents.map(a => <option value={a.id} disabled={!a.available}>{a.label}{a.available ? '' : ' (not installed)'}</option>)}
              </select>
              {chat.messages.length ? <button class="plain" onClick={() => setOpen(o => !o)}>{open ? 'Hide' : 'Show'} chat</button> : null}
              {chat.messages.length && !chat.running ? <button class="plain" onClick={() => api('chat/reset', {}).catch(fail)}>New chat</button> : null}
              <span class="grow" />
              {chat.running
                ? <button class="send" onClick={() => api('chat/stop', {}).catch(fail)}>Stop</button>
                : <button class="send" disabled={!text.trim() || !agent} onClick={send}>Send</button>}
            </div>
          </div>
        </section>
      </main>

      <aside>
        <h2>References</h2>
        <label class="add">Add files<input type="file" multiple hidden onChange={e => { addFiles([...e.currentTarget.files!]); e.currentTarget.value = ''; }} /></label>
        <p class="tip">Drop reports, docs and data anywhere, or paste a screenshot. Click one to attach it to your next message.</p>
        {docs.map(r => (
          <div class={'ref' + (items.some(i => i.key === r.path) ? ' on' : '')}>
            <button class="plain name" title={r.path} onClick={() => toggleRef(r)}>{r.name}<small>{size(r.bytes)}</small></button>
            <button class="plain x" aria-label={`Delete ${r.name}`} onClick={() => remove(r)}>×</button>
          </div>))}
        {captures.length ? <h2>Screenshots</h2> : null}
        <div class="shots">{captures.map(r => (
          <div class={'shot' + (items.some(i => i.key === r.path) ? ' on' : '')}>
            <button class="plain" title={r.name} onClick={() => toggleRef(r)}><img alt={r.name} loading="lazy" src={fileUrl(r.path)} /></button>
            <button class="plain x" aria-label={`Delete ${r.name}`} onClick={() => remove(r)}>×</button>
          </div>))}</div>
      </aside>

      {crop ? <div class="modal">
        <div class="cropper">
          <img src={crop.url} alt="Captured screen" />
          <Lasso onDone={async pts => {
            const el = document.querySelector('.cropper img') as HTMLImageElement, k = crop.img.naturalWidth / el.clientWidth;
            saveCrop(await cut(crop.img, pts.map(p => ({ x: p.x * k, y: p.y * k })), false));
          }} />
        </div>
        <p>Circle the part you want.</p>
        <button onClick={async () => saveCrop(await (await fetch(crop.url)).blob())}>Use all of it</button>
        <button onClick={() => setCrop(null)}>Cancel</button>
      </div> : null}
      {dragging ? <div class="drop" onDragOver={e => e.preventDefault()} onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); addFiles([...e.dataTransfer!.files]); }}>Drop to add to references</div> : null}
      {toast ? <div class="toast" role="status">{toast}</div> : null}
    </div>
  );
}

const CSS = `
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{font:13px/1.45 "Mona Sans",system-ui,sans-serif;color:#1f2328;background:#f6f8fa}
button,select,textarea{font:inherit;color:inherit}
button{padding:4px 10px;border:1px solid #d1d9e0;border-radius:6px;background:#fff;cursor:pointer}
button:hover{background:#f3f4f6}button.on{background:#ddf4ff;border-color:#0969da;color:#0969da}
button.plain{border:0;background:none;padding:2px 6px;color:#59636e}
button:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid #0969da;outline-offset:1px}
kbd{font:11px "Mona Sans Mono",monospace;color:#59636e;margin-left:3px}
.grow{flex:1}.bad{color:#d1242f}
.app{display:grid;height:100%;grid-template:44px minmax(0,1fr)/176px minmax(0,1fr) 264px}
header{grid-column:1/-1;display:flex;align-items:center;gap:6px;padding:0 12px;background:#fff;border-bottom:1px solid #d1d9e0}
header i{width:1px;height:20px;background:#d1d9e0;margin:0 4px}
nav{overflow:auto;padding:10px;background:#fff;border-right:1px solid #d1d9e0}
.thumb{position:relative;display:block;width:100%;padding:4px;margin-bottom:8px;text-align:left;border-color:transparent;background:none}
.thumb.on{background:#ddf4ff;border-color:#0969da;color:inherit}
.thumb img{display:block;width:100%;aspect-ratio:16/9;background:#eaeef2;border:1px solid #d1d9e0;border-radius:4px}
.thumb span{display:block;margin-top:3px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.thumb em{position:absolute;top:8px;right:8px;padding:0 5px;font:600 11px "Mona Sans";border-radius:8px;background:#0969da;color:#fff}.thumb em.bad{background:#d1242f}
main{position:relative;min-width:0;padding:14px 14px 96px}
.stage{position:relative;height:100%;border-radius:8px;overflow:hidden;background:#eaeef2;border:1px solid #d1d9e0}
iframe{display:block;width:100%;height:100%;border:0}
.lasso{position:absolute;inset:0;width:100%;height:100%;cursor:crosshair;touch-action:none}
.hint{position:absolute;top:10px;left:50%;transform:translateX(-50%);padding:3px 12px;border-radius:12px;background:#1f2328;color:#fff;font-size:12px;pointer-events:none}
.dock{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);width:min(680px,calc(100% - 28px));display:flex;flex-direction:column;gap:8px;max-height:calc(100% - 28px);z-index:5}
.log,.bar{background:#fff;border:1px solid #d1d9e0;border-radius:12px;box-shadow:0 6px 18px #25292e26}
.log{flex:1;min-height:0;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
.me{align-self:flex-end;max-width:85%;padding:6px 10px;border-radius:10px;background:#ddf4ff;white-space:pre-wrap}
.me small{display:block;color:#59636e}
.them{max-width:95%}.them p{margin:0 0 6px;white-space:pre-wrap}
.them code{display:inline-block;margin:0 4px 4px 0;padding:0 6px;font:11px "Mona Sans Mono",monospace;color:#59636e;background:#f6f8fa;border:1px solid #d1d9e0;border-radius:4px}
.busy{color:#59636e}
.bar{padding:8px 10px}
.bar textarea{display:block;width:100%;border:0;outline:0;resize:none;background:none;padding:2px}
.chips{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px}
.chip{display:flex;align-items:center;gap:4px;max-width:220px;padding:1px 2px 1px 6px;border-radius:6px;background:#ddf4ff;font-size:12px;white-space:nowrap;overflow:hidden}
.chip img{height:18px;border-radius:2px}.chip button{border:0;background:none;padding:0 4px}
.row{display:flex;align-items:center;gap:4px;margin-top:4px}
.row select{border:1px solid #d1d9e0;border-radius:6px;background:#fff;padding:3px 4px}
.send{background:#0969da;border-color:#0969da;color:#fff;font-weight:600}.send:hover{background:#0860ca}.send:disabled{opacity:.45;cursor:default}
aside{overflow:auto;padding:12px;background:#fff;border-left:1px solid #d1d9e0}
h2{margin:4px 0 8px;font:600 11px "Mona Sans Mono",monospace;letter-spacing:.08em;text-transform:uppercase;color:#59636e}
.shots+h2,.ref+h2{margin-top:16px}
.add{display:block;padding:6px;text-align:center;border:1px dashed #d1d9e0;border-radius:6px;cursor:pointer}.add:hover{background:#f6f8fa}
.tip{margin:8px 0 12px;color:#59636e;font-size:12px}
.ref{display:flex;align-items:center;border-radius:6px}.ref.on{background:#ddf4ff}
.ref .name{flex:1;min-width:0;text-align:left;color:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ref small{margin-left:6px;color:#59636e}
.shots{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:4px}
.shot{position:relative;border:2px solid transparent;border-radius:6px}.shot.on{border-color:#0969da}
.shot button:first-child{display:block;width:100%;padding:0}
.shot img{display:block;width:100%;height:64px;object-fit:cover;border:1px solid #d1d9e0;border-radius:4px}
.shot .x{position:absolute;top:2px;right:2px;padding:0 5px;background:#fffc;border-radius:4px}
.modal{position:fixed;inset:0;z-index:20;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:#1f2328cc;color:#fff}
.modal button{color:#1f2328}.cropper{position:relative;line-height:0}.cropper img{max-width:88vw;max-height:76vh}.modal p{margin:0}
.drop{position:fixed;inset:0;z-index:30;display:grid;place-items:center;font-size:20px;font-weight:600;color:#0969da;background:#ddf4ffe6;border:3px dashed #0969da}
.toast{position:fixed;left:50%;top:54px;transform:translateX(-50%);z-index:40;padding:5px 14px;border-radius:8px;background:#1f2328;color:#fff}
`;

render(<App />, document.body);
