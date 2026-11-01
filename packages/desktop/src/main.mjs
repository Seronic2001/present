// Present as a desktop app. Each deck gets its own window and its own Studio server, the same server
// `present studio` runs. Electron acts as Node for that server, so the app needs no Node installed.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeTheme, screen, session, shell } from 'electron';
import { displays, Show } from './show.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = resolve(here, '../../cli/src/bin.ts');
const asNode = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
const BG = '#161618';
const BAR = { color: '#1c1c1f', symbolColor: '#a1a1a9', height: 43 };
const APP = 'present-app://';

const decks = new Map();   // folder -> { win, server, url, show }
let welcome = null;

// ---- recent decks
const recentFile = () => join(app.getPath('userData'), 'recent.json');
function recent() {
  try { return JSON.parse(readFileSync(recentFile(), 'utf8')).filter(d => existsSync(join(d, 'deck.yaml'))); } catch { return []; }
}
function remember(dir) {
  writeFileSync(recentFile(), JSON.stringify([dir, ...recent().filter(d => d !== dir)].slice(0, 8)));
  buildMenu();
}

// ---- the server behind a window
const stop = child => {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill();
};
function startServer(dir) {
  return new Promise((ok, no) => {
    const child = spawn(process.execPath, [bin, 'studio', dir, '--port', '0', '--no-open'], { env: asNode, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.setEncoding('utf8').on('data', d => {
      out += d;
      const m = /Present Studio at (http\S+)/.exec(out);
      if (m) ok({ child, url: m[1] });
    });
    child.stderr.setEncoding('utf8').on('data', d => { err = (err + d).slice(-1500); });
    child.on('error', no);
    child.on('exit', code => no(new Error(err.trim() || `The server stopped with code ${code}`)));
  });
}
/** One run of the CLI, for the commands that finish: init and export. */
function cli(...args) {
  return new Promise((ok, no) => {
    const child = spawn(process.execPath, [bin, ...args], { env: asNode, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.setEncoding('utf8').on('data', d => { err += d; });
    child.on('error', no);
    child.on('exit', code => (code ? no(new Error(err.trim() || `Failed with code ${code}`)) : ok()));
  });
}

// ---- windows
const fail = (title, e) => dialog.showErrorBox(title, String(e?.message ?? e));

/** Keeps a window on the deck's own pages. `popup` can size a window it opens. */
function guard(win, origin, popup) {
  const external = url => { if (/^https?:\/\//.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (url.startsWith(origin)) return { action: 'allow', overrideBrowserWindowOptions: popup?.(frameName) ?? undefined };   // the presenter view
    external(url);
    return { action: 'deny' };
  });
  // The presenter view opened with P: a window of the talk, with no app menu in it.
  win.webContents.on('did-create-window', child => {
    child.removeMenu();
    child.webContents.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && input.key === 'F5') { e.preventDefault(); child.close(); } });
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin)) { e.preventDefault(); external(url); }
  });
}

async function openDeck(dir) {
  dir = resolve(dir);
  const known = decks.get(dir);
  if (known) { known.win.show(); known.win.focus(); return; }
  if (!existsSync(join(dir, 'deck.yaml'))) { fail('Not a Present deck', `${dir} has no deck.yaml.`); return; }
  const win = new BrowserWindow({ width: 1500, height: 940, minWidth: 1040, minHeight: 640, backgroundColor: BG, title: basename(dir), show: false, titleBarStyle: 'hidden', titleBarOverlay: BAR, webPreferences: { preload: join(here, 'preload.cjs') } });
  win.once('ready-to-show', () => win.show());
  const entry = { win, server: null, url: null, show: null };
  decks.set(dir, entry);
  win.on('closed', () => {
    entry.show?.stop();
    decks.delete(dir);
    if (entry.server) stop(entry.server);
    if (!decks.size && !welcome && !app.isQuitting) showWelcome();
  });
  try {
    const { child, url } = await startServer(dir);
    entry.server = child;
    entry.url = url.replace(/studio$/, '');
    child.on('exit', () => {
      if (entry.server === child && !win.isDestroyed() && !app.isQuitting) { fail('Present stopped', `The server for ${basename(dir)} stopped. Reopen the deck to continue.`); win.close(); }
    });
    guard(win, new URL(url).origin);
    await win.loadURL(url);
    remember(dir);
    welcome?.close();
  } catch (e) {
    fail(`Could not open ${basename(dir)}`, e);
    if (!win.isDestroyed()) win.close();
  }
}

// ---- presenting
const deckOf = contents => [...decks.values()].find(d => d.win.webContents === contents);
const focused = () => [...decks].find(([, d]) => d.win === BrowserWindow.getFocusedWindow());
const tell = entry => { if (!entry.win.isDestroyed()) entry.win.webContents.send('show:state', { running: !!entry.show, displays: displays() }); };

function startShow(entry, { display, slide } = {}) {
  entry.show?.stop();
  const origin = new URL(entry.url).origin;
  entry.show = new Show({
    url: entry.url, slide, display, title: entry.win.getTitle(),
    guard: (win, popup) => guard(win, origin, popup),
    ended: () => { entry.show = null; tell(entry); },
  });
  tell(entry);
}
function watchDisplays() {
  const changed = () => { for (const d of decks.values()) { d.show?.displaysChanged(); tell(d); } };
  screen.on('display-added', changed);
  screen.on('display-removed', changed);
  ipcMain.handle('deck:export', (e, { format, steps }) => {
    const found = [...decks].find(([, d]) => d.win.webContents === e.sender);
    return found && ['html', 'pdf', 'pptx'].includes(format) ? exportDeck(format, found[0], !!steps) : false;
  });
  ipcMain.on('app:menu', e => { const d = deckOf(e.sender); if (d) Menu.getApplicationMenu()?.popup({ window: d.win, x: 10, y: 40 }); });
  ipcMain.handle('show:displays', () => displays());
  ipcMain.handle('show:start', (e, o) => { const d = deckOf(e.sender); if (d) startShow(d, o); });
  ipcMain.handle('show:stop', e => deckOf(e.sender)?.show?.stop());
}

async function connectDeck() {
  const dir = focused()?.[0];
  if (!dir) return;
  try {
    await cli('connect', dir);
    dialog.showMessageBox({ type: 'info', title: 'Agents connected', message: `Agents can now edit ${basename(dir)}.`, detail: `Start Claude Code or Codex in this folder and its edits appear here live:\n${dir}\n\nCodex is set up for all your decks, in its own settings.` });
  } catch (e) { fail('Could not connect the agents', e); }
}

async function chooseDeck() {
  const r = await dialog.showOpenDialog({ title: 'Open a deck folder', properties: ['openDirectory'] });
  if (!r.canceled) await openDeck(r.filePaths[0]);
}
async function newDeck() {
  const r = await dialog.showSaveDialog({ title: 'New deck folder', buttonLabel: 'Create deck', defaultPath: join(app.getPath('documents'), 'My talk') });
  if (r.canceled) return;
  try { await cli('init', r.filePath); await openDeck(r.filePath); } catch (e) { fail('Could not create the deck', e); }
}
/** Answers true once a file is written, and false if the human cancelled. */
async function exportDeck(format, dir = focused()?.[0], steps = false) {
  if (!dir) return false;
  const r = await dialog.showSaveDialog({ title: `Export ${format.toUpperCase()}`, defaultPath: join(dirname(dir), `${basename(dir)}.${format}`), filters: [{ name: format.toUpperCase(), extensions: [format] }] });
  if (r.canceled) return false;
  try { await cli('export', dir, format, r.filePath, ...(steps ? ['--steps'] : [])); shell.showItemInFolder(r.filePath); return true; } catch (e) { fail('Export failed', e); return false; }
}

function showWelcome() {
  if (welcome) { welcome.show(); return; }
  welcome = new BrowserWindow({ width: 820, height: 540, resizable: false, maximizable: false, backgroundColor: BG, title: 'Present', show: false, titleBarStyle: 'hidden', titleBarOverlay: { ...BAR, color: BG } });
  welcome.once('ready-to-show', () => welcome.show());
  welcome.removeMenu();
  welcome.on('closed', () => { welcome = null; });
  welcome.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (url === `${APP}open`) chooseDeck();
    else if (url === `${APP}new`) newDeck();
    else if (url.startsWith(`${APP}recent/`)) openDeck(decodeURIComponent(url.slice(`${APP}recent/`.length)));
  });
  welcome.loadFile(join(here, 'welcome.html'), { query: { recent: JSON.stringify(recent()) } });
}

/** Capture window: Electron has no picker of its own on Windows, so this is one. */
function pickSource(sources) {
  return new Promise(ok => {
    const pick = new BrowserWindow({ width: 720, height: 520, parent: BrowserWindow.getFocusedWindow() ?? undefined, modal: true, backgroundColor: BG, title: 'Choose what to capture', show: false, autoHideMenuBar: true });
    pick.removeMenu();
    let chosen = null;
    pick.webContents.on('will-navigate', (e, url) => {
      e.preventDefault();
      chosen = sources.find(s => s.id === decodeURIComponent(url.slice(`${APP}pick/`.length))) ?? null;
      pick.close();
    });
    pick.on('closed', () => ok(chosen));
    pick.loadFile(join(here, 'pick.html')).then(async () => {
      const list = sources.map(s => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() }));
      await pick.webContents.executeJavaScript(`show(${JSON.stringify(list).replace(/</g, '\\u003c')})`);
      pick.show();
    });
  });
}

function buildMenu() {
  const open = recent().map(d => ({ label: d, click: () => openDeck(d) }));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'New Deck…', accelerator: 'CmdOrCtrl+N', click: newDeck },
      { label: 'Open Deck…', accelerator: 'CmdOrCtrl+O', click: chooseDeck },
      { label: 'Open Recent', enabled: open.length > 0, submenu: open },
      { type: 'separator' },
      { label: 'Export', submenu: [
        { label: 'HTML…', click: () => exportDeck('html') },
        { label: 'PDF…', click: () => exportDeck('pdf') },
        { label: 'PDF with Steps…', click: () => exportDeck('pdf', undefined, true) },
        { label: 'PowerPoint…', click: () => exportDeck('pptx') },
      ] },
      { type: 'separator' },
      { label: 'Connect to Claude Code and Codex…', click: connectDeck },
      { type: 'separator' },
      { role: 'close' },
      ...(process.platform === 'darwin' ? [] : [{ role: 'quit' }]),
    ] },
    { role: 'editMenu' },
    { label: 'Slideshow', submenu: [{ label: 'From Beginning', accelerator: 'Shift+F5', click: () => focused()?.[1].win.webContents.send('show:begin') }, { label: 'From Current Slide', accelerator: 'F5', click: () => {
      // In a show the focus is on the audience's or the presenter's window, not on Studio. For a moment,
      // as a window goes full screen, it is on none of them, and the show should still end.
      const w = BrowserWindow.getFocusedWindow(), running = [...decks.values()].find(d => d.show && (!w || d.show.stage === w || d.show.notes === w));
      if (running) running.show.stop(); else focused()?.[1].win.webContents.send('show:toggle');
    } }] },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }, { type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }])] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ role: 'about', label: 'About Present' }] },
  ]));
}

const deckFrom = argv => argv.slice(1).find(a => !a.startsWith('-') && existsSync(join(resolve(a), 'deck.yaml')));

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_e, argv) => { const d = deckFrom(argv); if (d) openDeck(d); else (welcome ?? [...decks.values()][0]?.win)?.focus(); });
  app.on('before-quit', () => { app.isQuitting = true; for (const d of decks.values()) if (d.server) stop(d.server); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) showWelcome(); });
  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark';
    buildMenu();
    watchDisplays();
    session.defaultSession.setDisplayMediaRequestHandler(async (_req, done) => {
      const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 320, height: 180 } });
      const source = await pickSource(sources);
      if (source) done({ video: source }); else done({});
    });
    const d = deckFrom(process.argv);
    if (d) openDeck(d); else showWelcome();
  });
}
