// A show: the deck full screen on one display, and the presenter's view on another. The presenter's
// window is opened by the deck itself, the same way `P` opens it in an exported file, so the two talk
// as they do everywhere else. This file only decides where windows go.
import { BrowserWindow, screen } from 'electron';

const NOTES = 'present-notes';

export const displays = () => {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id, primary: d.id === primary, width: d.size.width, height: d.size.height,
    label: d.label || (d.id === primary ? 'Main display' : `Display ${i + 1}`),
  }));
};

/** The display the audience sees: the one asked for if it is still there, otherwise any external one. */
export function stageDisplay(all, primaryId, wanted) {
  return all.find(d => d.id === wanted) ?? all.find(d => d.id !== primaryId) ?? all.find(d => d.id === primaryId);
}
/** Where the presenter's view goes: the main display, unless the audience has it. None with one display. */
export function notesDisplay(all, primaryId, stage) {
  return stage.id === primaryId ? all.find(d => d.id !== stage.id) : all.find(d => d.id === primaryId);
}

export class Show {
  stage = null;
  notes = null;
  wanted;
  ended;

  /** `guard` keeps a window on the deck's own pages. `ended` runs once, when the audience's window goes. */
  constructor({ url, slide, display, title, guard, ended }) {
    this.wanted = display;
    this.ended = ended;
    const stage = this.stage = new BrowserWindow({ frame: false, backgroundColor: '#000', title: `${title}: audience`, show: false, autoHideMenuBar: true });
    this.bare(stage);
    guard(stage, frame => (frame === NOTES ? { title: `${title}: presenter`, backgroundColor: '#161618', autoHideMenuBar: true, ...this.notesBounds() } : null));
    stage.webContents.on('did-create-window', win => {
      if (this.notes && !this.notes.isDestroyed()) return;
      this.notes = win;
      this.bare(win);
      guard(win);
      win.maximize();
      win.on('closed', () => { if (this.notes === win) this.notes = null; });
    });
    stage.on('closed', () => {
      this.stage = null;
      if (this.notes && !this.notes.isDestroyed()) this.notes.close();
      this.ended();
    });
    this.place();
    stage.loadURL(`${url}?show#${slide ?? 1}`).then(() => { if (!stage.isDestroyed()) { stage.show(); stage.setFullScreen(true); this.openNotes(); } });
  }

  /** No app menu in a window of the show. That also takes its F5 away, so it is handled here. */
  bare(win) {
    win.removeMenu();
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'F5') { e.preventDefault(); this.stop(); }
    });
  }
  layout() {
    const all = screen.getAllDisplays(), primary = screen.getPrimaryDisplay().id;
    const stage = stageDisplay(all, primary, this.wanted);
    return { stage, notes: notesDisplay(all, primary, stage) };
  }
  notesBounds() {
    const { notes } = this.layout();
    return notes ? { ...notes.workArea } : {};
  }
  place() {
    const { stage } = this.layout();
    this.stage.setFullScreen(false);
    this.stage.setBounds(stage.bounds);
    if (this.stage.isVisible()) this.stage.setFullScreen(true);
  }
  openNotes() {
    if (!this.layout().notes || this.notes) return;
    this.stage.webContents.executeJavaScript('window.__present?.player.presenter()', true);
  }
  /** Screens come and go mid-talk: a cable is pulled, or a projector wakes up late. */
  displaysChanged() {
    if (!this.stage) return;
    this.place();
    const { notes } = this.layout();
    if (!notes) this.notes?.close();                     // it would sit behind the only screen there is
    else if (this.notes) { this.notes.unmaximize(); this.notes.setBounds(notes.workArea); this.notes.maximize(); }
    else this.openNotes();
  }
  stop() { this.stage?.close(); }
}
