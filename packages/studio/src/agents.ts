// Runs Claude Code, Codex or OpenCode headless in the deck folder and turns their different event
// streams into one transcript. Every agent gets the present MCP tools and no other way to write, so
// its edits go through deck_apply: validated, atomic, undoable, and refused on a stale revision.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import spawn from 'cross-spawn';
import { LOOP } from '@present/core';

export const AGENTS = ['claude', 'codex', 'opencode'] as const;
export type AgentId = typeof AGENTS[number];
export const AGENT_LABEL: Record<AgentId, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };

export interface Mcp { command: string; args: string[]; env?: Record<string, string>; }
export interface Invocation { cmd: string; args: string[]; env?: Record<string, string>; }
export interface AgentEvent { session?: string; text?: string; tool?: string; error?: string; }

/** Is this command on PATH? Windows adds its executable extensions. */
export function onPath(cmd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  return (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean).some(d => exts.some(e => existsSync(join(d, cmd + e))));
}

export function invocation(agent: AgentId, root: string, mcp: Mcp, session?: string): Invocation {
  if (agent === 'claude') {
    const dir = join(root, '.present');
    mkdirSync(dir, { recursive: true });
    const config = join(dir, 'mcp.json');
    writeFileSync(config, JSON.stringify({ mcpServers: { present: mcp } }));
    return {
      cmd: 'claude',
      args: ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'default',
        '--strict-mcp-config', '--mcp-config', config, ...(session ? ['--resume', session] : []),
        '--disallowedTools', 'Bash,PowerShell,Edit,Write,NotebookEdit',
        '--allowedTools', 'mcp__present__*,Read,Glob,Grep,ToolSearch'],
    };
  }
  if (agent === 'codex') {
    // Codex refuses MCP calls in exec mode unless this server's tools are approved up front.
    const config = [
      'sandbox_mode="read-only"',
      `mcp_servers.present.command=${JSON.stringify(mcp.command)}`,
      `mcp_servers.present.args=${JSON.stringify(mcp.args)}`,
      'mcp_servers.present.default_tools_approval_mode="approve"',
      ...Object.entries(mcp.env ?? {}).map(([k, v]) => `mcp_servers.present.env.${k}=${JSON.stringify(v)}`),
    ].flatMap(c => ['-c', c]);
    return { cmd: 'codex', args: ['exec', ...(session ? ['resume', session] : []), '--json', '--skip-git-repo-check', ...config, '-'] };
  }
  return {
    cmd: 'opencode',
    args: ['run', '--format', 'json', '--auto', '--standalone', ...(session ? ['--session', session] : [])],
    // --auto approves everything not denied here. --standalone gives the run a private server, so Stop ends it.
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { present: { type: 'local', command: [mcp.command, ...mcp.args], environment: mcp.env } }, permission: { edit: 'deny', bash: 'deny', external_directory: 'deny' } }) },
  };
}

const short = (name: string) => name.replace(/^mcp__present__/, '');

/** One line of an agent's JSON output, as zero or more transcript events. */
export function parseLine(agent: AgentId, o: any): AgentEvent[] {
  if (agent === 'claude') {
    if (o.type === 'system' && o.subtype === 'init') return [{ session: o.session_id }];
    if (o.type === 'stream_event' && o.event?.delta?.type === 'text_delta') return [{ text: o.event.delta.text }];
    if (o.type === 'assistant') return (o.message?.content ?? []).filter((c: any) => c.type === 'tool_use' && c.name !== 'ToolSearch').map((c: any) => ({ tool: short(c.name) }));
    if (o.type === 'result') return [{ session: o.session_id }, ...(o.is_error ? [{ error: String(o.result ?? o.subtype ?? 'The agent failed') }] : [])];
    return [];
  }
  if (agent === 'codex') {
    if (o.type === 'thread.started') return [{ session: o.thread_id }];
    if (o.type === 'turn.failed') return [{ error: String(o.error?.message ?? 'The agent failed') }];
    if (o.type === 'error') return [{ error: String(o.message ?? 'The agent failed') }];
    const i = o.item;
    if (o.type === 'item.started' && i?.type === 'mcp_tool_call') return [{ tool: i.tool }];
    if (o.type === 'item.started' && i?.type === 'command_execution') return [{ tool: 'shell' }];
    if (o.type === 'item.completed' && i?.type === 'agent_message') return [{ text: `${i.text}\n\n` }];
    if (o.type === 'item.completed' && i?.status === 'failed' && i?.error) return [{ error: `${i.tool ?? 'Tool'}: ${i.error.message}` }];
    return [];
  }
  const out: AgentEvent[] = o.sessionID ? [{ session: o.sessionID }] : [];
  if (o.type === 'text' && o.part?.text) out.push({ text: `${o.part.text}\n\n` });
  if (o.type === 'tool_use') {
    const called = /tools\.present\.(\w+)/.exec(o.part?.state?.input?.code ?? '')?.[1];
    if (o.part?.tool !== 'skill') out.push({ tool: called ?? String(o.part?.tool ?? 'tool') });
  }
  if (o.type === 'error') out.push({ error: String(o.error?.data?.message ?? o.error?.message ?? o.message ?? 'The agent failed') });
  return out;
}

export interface ContextItem {
  kind: 'element' | 'capture' | 'file';
  label: string;
  slide?: string; step?: number;
  id?: string; src?: string; text?: string;   // element
  path?: string; ids?: string[];              // capture or file
}
export interface Part { text?: string; tool?: string; error?: string; }
export interface Message { role: 'user' | 'agent'; agent?: AgentId; text?: string; context?: ContextItem[]; parts?: Part[]; }
export interface ChatState { messages: Message[]; running: boolean; sessions: Partial<Record<AgentId, string>>; }

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

function describe(c: ContextItem): string {
  const where = c.slide ? ` on slide ${c.slide}${c.step === undefined ? '' : `, step ${c.step}`}` : '';
  if (c.kind === 'element') return `- Part${where}: ${c.id ? `id "${c.id}"` : `no id, source node ${c.src}`}${c.text ? `, text "${clip(c.text, 160)}"` : ''}`;
  if (c.kind === 'capture') return `- Screenshot${where}: ${c.path}. Open it with reference_read.${c.ids?.length ? ` The marked region covers ids: ${c.ids.join(', ')}.` : ''}`;
  return `- Reference file: ${c.path}. Open it with reference_read.`;
}

/** What the agent receives. The first turn of a session carries the guide; a new agent gets the recent talk. */
export function buildPrompt(text: string, context: ContextItem[], viewing: string | undefined, fresh: boolean, history: Message[]) {
  const out: string[] = [];
  if (fresh) {
    out.push('You are working inside Present Studio. The human sees the deck live and it updates as you edit. Change the deck only with the present MCP tools.\n', LOOP);
    const earlier = history.map(m => (m.role === 'user' ? `Human: ${m.text}` : `Agent: ${(m.parts ?? []).map(p => p.text ?? '').join('').trim()}`)).filter(l => !l.endsWith(': ')).slice(-6);
    if (earlier.length) out.push(`Earlier in this conversation, with another agent:\n${earlier.map(l => clip(l, 600)).join('\n')}\n`);
  }
  if (viewing) out.push(`The human is looking at ${viewing}.`);
  if (context.length) out.push(`They attached:\n${context.map(describe).join('\n')}\n`);
  out.push(`Their request:\n${text}`);
  return out.join('\n');
}

function killTree(c: ChildProcess) {
  if (process.platform === 'win32' && c.pid) nodeSpawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
  else c.kill();
}

export class Chat {
  state: ChatState = { messages: [], running: false, sessions: {} };
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | undefined;
  private file: string;
  private root: string;
  private notify: (s: ChatState) => void;
  private resolveCmd: (agent: AgentId, session?: string) => Invocation;

  constructor(root: string, mcp: Mcp, notify: (s: ChatState) => void, resolveCmd?: (agent: AgentId, session?: string) => Invocation) {
    this.root = root;
    this.notify = notify;
    this.resolveCmd = resolveCmd ?? ((a, s) => invocation(a, root, mcp, s));
    this.file = join(root, '.present', 'chat.json');
    if (existsSync(this.file)) try { this.state = { ...JSON.parse(readFileSync(this.file, 'utf8')), running: false }; } catch { /* a damaged log is not worth stopping for */ }
  }

  private changed(now = false) {
    clearTimeout(this.timer);
    const send = () => this.notify(this.state);
    if (now) send(); else this.timer = setTimeout(send, 50);
  }
  private save() {
    mkdirSync(join(this.root, '.present'), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.state));
  }

  send(agent: AgentId, text: string, context: ContextItem[], viewing?: string) {
    if (this.state.running) throw new Error('The agent is still working');
    if (!text.trim()) throw new Error('Nothing to send');
    if (!AGENTS.includes(agent)) throw new Error(`Unknown agent: ${agent}`);
    const session = this.state.sessions[agent];
    const prompt = buildPrompt(text, context, viewing, !session, this.state.messages);
    const reply: Message = { role: 'agent', agent, parts: [] };
    this.state.messages.push({ role: 'user', text, context }, reply);
    this.state.running = true;
    this.changed(true);

    const add = (p: Part) => {
      const last = reply.parts!.at(-1);
      if (p.text && last?.text !== undefined) last.text += p.text; else reply.parts!.push(p);
      this.changed();
    };
    const run = this.resolveCmd(agent, session);
    const child = spawn(run.cmd, run.args, { cwd: this.root, env: { ...process.env, ...run.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    let buf = '', err = '', ended = false;
    const line = (l: string) => {
      if (!l.trim()) return;
      let o: any;
      try { o = JSON.parse(l); } catch { return; }
      for (const e of parseLine(agent, o)) {
        if (e.session) this.state.sessions[agent] = e.session;
        if (e.text) add({ text: e.text });
        if (e.tool) add({ tool: e.tool });
        if (e.error) add({ error: e.error });
      }
    };
    const finish = (problem?: string) => {
      if (ended) return;
      ended = true;
      if (this.child !== child) return;   // reset while running: this run is no longer the chat's
      if (problem) add({ error: problem });
      this.child = null;
      this.state.running = false;
      this.save();
      this.changed(true);
    };
    child.stdout!.setEncoding('utf8').on('data', (d: string) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop()!;
      lines.forEach(line);
    });
    child.stderr!.setEncoding('utf8').on('data', (d: string) => { err = (err + d).slice(-2000); });
    child.on('error', e => finish(`Could not start ${run.cmd}: ${e.message}`));
    child.on('close', code => {
      line(buf);
      const stopped = (child as any).stoppedByUser;
      finish(stopped ? 'Stopped' : code && !reply.parts!.some(p => p.error) ? (err.trim() || `${run.cmd} exited with code ${code}`) : undefined);
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end(prompt);
  }

  stop() {
    if (!this.child) return;
    (this.child as any).stoppedByUser = true;
    killTree(this.child);
  }
  reset() {
    this.stop();
    this.child = null;
    this.state = { messages: [], running: false, sessions: {} };
    this.save();
    this.changed(true);
  }
}
