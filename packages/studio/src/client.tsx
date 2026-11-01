// Studio overlay: press I to inspect. Everything it changes goes through ops, like an agent.
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

const { token } = (window as any).__PRESENT_DEV as { token: string };
const api = async (path: string, body?: unknown) => {
  const r = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-present-token': token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.json();
};
const P = () => (window as any).__present;

const box = 'position:fixed;right:12px;top:12px;bottom:12px;width:340px;z-index:70;background:#fff;border:1px solid #d1d9e0;border-radius:12px;box-shadow:0 6px 18px #25292e1f;padding:14px;overflow:auto;font:13px/1.45 var(--font-sans);color:#1f2328';
const label = { font: '600 11px var(--font-mono)', letterSpacing: '.08em', textTransform: 'uppercase', color: '#59636e', margin: '12px 0 4px' } as const;
const input = { width: '100%', font: 'inherit', padding: '6px 8px', border: '1px solid #d1d9e0', borderRadius: 6 } as const;
const btn = { font: 'inherit', padding: '5px 10px', border: '1px solid #d1d9e0', borderRadius: 6, background: '#f6f8fa', cursor: 'pointer', marginRight: 6 } as const;

interface Pick { el: Element; id: string; src: string | null; text: string; n: number | null; }

function App() {
  const [on, setOn] = useState(false);
  const [pick, setPick] = useState<Pick | null>(null);
  const [state, setState] = useState<any>(null);
  const [comment, setComment] = useState('');
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  const [anns, setAnns] = useState<any[]>([]);
  const [revision, setRevision] = useState('');

  const refresh = async () => {
    const c = await api('deck');
    setRevision(c.deck.revision);
    P().player.replace(c.deck);
    setAnns(await api('annotations'));
  };
  useEffect(() => {
    const es = new EventSource(`/api/events?token=${token}`);
    es.onmessage = e => { if (e.data === 'reload') location.reload(); else refresh(); };
    api('deck').then(c => setRevision(c.deck.revision));
    const key = (e: KeyboardEvent) => {
      if (e.key === 'i' && !(e.target as HTMLElement).closest?.('input,textarea')) setOn(v => !v);
    };
    addEventListener('keydown', key);
    return () => { es.close(); removeEventListener('keydown', key); };
  }, []);
  useEffect(() => {
    (window as any).__presentStudioActive = on;
    if (!on) return;
    api('annotations').then(setAnns);
    setState(P().state());
    const click = (e: MouseEvent) => {
      const t = e.target as Element;
      if (t.closest('.ui') || t.closest('#present-studio')) return;
      const el = t.closest('[data-src]');
      if (!el) return;
      e.stopPropagation();
      const named = el.closest('[id]');
      const id = el.id || (named && named.closest('.p-body') && named.id) || '';
      const n = (el.closest('[data-n]') as HTMLElement | null)?.getAttribute('data-n');
      setPick({ el, id, src: el.getAttribute('data-src'), text: el.textContent?.trim() ?? '', n: n ? +n : null });
      setText(el.textContent?.trim() ?? '');
      setState(P().state());
      document.querySelectorAll('.st-sel').forEach(x => x.classList.remove('st-sel'));
      el.classList.add('st-sel');
    };
    addEventListener('click', click, true);
    return () => removeEventListener('click', click, true);
  }, [on]);

  if (!on) return null;
  const slide = P().player.order[P().player.idx];
  const phase = slide.phases[state?.step ?? 0];
  const cues = pick?.n ? slide.phases.flatMap((ph: any, i: number) => ph.tracks.filter((t: any) => t.n === pick.n).map((t: any) => ({ ...t, phase: i, name: ph.name }))) : [];
  const ops = async (list: any[]) => {
    const r = await api('ops', { ops: list, baseRevision: revision });
    setMsg(r.ok ? 'Saved' : r.error + ' ' + (r.diagnostics ?? []).map((d: any) => d.message).join('; '));
    if (r.ok) setRevision(r.revision);
  };
  const open = anns.filter(a => a.status === 'open' && a.slide === slide.id);

  return (
    <div id="present-studio" class="ui" style={box as any}>
      <style>{`.st-sel{outline:2px solid #0969da;outline-offset:2px}`}</style>
      <b>Studio</b> <span style={{ color: '#59636e' }}>slide {state?.slide} · {slide.id}</span>
      <div style={label}>Timeline: {phase?.name}</div>
      <select style={input} value={state?.step ?? 0} onChange={e => { const s = +e.currentTarget.value; setState(P().seek({ step: s, t: slide.phases[s].end })); }}>
        {slide.phases.map((p: any, i: number) => <option value={i}>{i}: {p.name}</option>)}
      </select>
      <input aria-label="Scrub" type="range" min={0} max={Math.max(100, phase?.end ?? 100)} value={Math.min(state?.t ?? 0, phase?.end ?? 0)} style={{ width: '100%' }}
        onInput={e => setState(P().seek({ step: state.step, t: +e.currentTarget.value }))} />
      <div style={{ color: '#59636e' }}>{Math.round(Math.min(state?.t ?? 0, phase?.end ?? 0))} / {phase?.end} ms</div>

      {pick ? <>
        <div style={label}>Selected</div>
        <div><code>{pick.id || '(no id yet)'}</code></div>
        {pick.id ? <>
          <div style={label}>Text</div>
          <textarea style={input} rows={2} value={text} onInput={e => setText(e.currentTarget.value)} />
          <button style={btn} onClick={() => ops([{ op: 'setText', slide: slide.id, id: pick.id, text }])}>Save text</button>
        </> : null}
        {cues.length ? <div style={label}>Cues</div> : null}
        {cues.map((c: any) => (
          <div style={{ marginBottom: 6 }}>
            <code>{c.k}</code> · {c.name}<br />
            at <input aria-label="at" type="number" style={{ width: 70 }} value={c.s} onChange={e => ops([{ op: 'setCueTiming', slide: slide.id, cue: c.c, at: +e.currentTarget.value }])} />
            {' '}dur <input aria-label="dur" type="number" style={{ width: 70 }} value={c.d} onChange={e => ops([{ op: 'setCueTiming', slide: slide.id, cue: c.c, dur: +e.currentTarget.value }])} />
          </div>
        ))}
        <div style={label}>Tell the agent</div>
        <textarea style={input} rows={3} value={comment} placeholder="Make this tighter, slow the arrow..." onInput={e => setComment(e.currentTarget.value)} />
        <button style={btn} onClick={async () => {
          await api('annotate', { slide: slide.id, node: pick.id || undefined, path: pick.id ? undefined : [+(pick.src ?? 0)], step: state?.step ?? 0, comment });
          setComment(''); setAnns(await api('annotations')); setMsg('Comment saved for the agent');
        }}>Add comment</button>
      </> : <p style={{ color: '#59636e' }}>Click any part of the slide.</p>}

      {msg ? <p>{msg}</p> : null}
      <div style={label}>Open comments ({open.length})</div>
      {open.map(a => <div style={{ marginBottom: 6 }}><code>{a.node}</code>: {a.comment}</div>)}
      <button style={btn} onClick={() => api('undo', {}).then(r => setMsg(r.ok ? 'Undone' : r.error))}>Undo last change</button>
    </div>
  );
}

const host = document.createElement('div');
document.body.appendChild(host);
render(<App />, host);
