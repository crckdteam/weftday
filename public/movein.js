// Weftday used to live at another web address. A browser keeps what a site saves under that site's
// address, so the tasks, notes, connected accounts, keys and recordings saved at the old address do
// not show up at the new one by themselves. The small page left at the old address opens this one
// with "#movein" at the end and hands those things across, tab to tab, inside the person's own
// browser. Nothing goes through a server.
//
// The safety of this rests on two checks, both made on every message:
//   - it must come from the very tab that opened this one, and
//   - that tab must be showing the old address (the browser itself vouches for the address).
import { PUBLIC_URL, MOVED_FROM } from './config.js';

export const KEYS = ['planner.v1', 'weftday.rec', 'weftday.toured', 'weftday.tips'];
const LIMIT = 40 * 1024 * 1024; // more text than a browser lets a site keep in any case
const isLocal = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);

// Is this copy of Weftday one that things may be moved into? Only the published one (and a copy
// being tried out on this computer): a copy on someone else's address has no "old address".
export function mayReceive(here) {
  try { return isLocal(here.hostname) || here.origin === new URL(PUBLIC_URL).origin; } catch { return false; }
}
// May a tab at this address hand things over? The old address only. A copy being tried out on this
// computer also accepts another address on this same computer, which is how the checks run.
export function trusted(origin, here) {
  if (origin === MOVED_FROM) return true;
  try { return isLocal(here.hostname) && isLocal(new URL(origin).hostname); } catch { return false; }
}
// The saved settings as they arrived: only the names this app uses, only text, and the main one
// must read as what this app saves. Anything else is refused whole.
export function checkItems(items) {
  if (!items || typeof items !== 'object' || Array.isArray(items)) throw new Error('not a set of saved things');
  const out = {};
  for (const key of KEYS) {
    const v = items[key];
    if (v == null) continue;
    if (typeof v !== 'string' || v.length > LIMIT) throw new Error('a saved thing is not text');
    out[key] = v;
  }
  if (out['planner.v1']) {
    const s = JSON.parse(out['planner.v1']);
    if (!s || typeof s !== 'object' || Array.isArray(s) || (s.settings && typeof s.settings !== 'object')) throw new Error('the saved things do not read as Weftday’s');
  }
  return out;
}
// One recording, or one stored part of one, as it arrived.
export function checkRecording(kind, v) {
  if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !v.id || v.id.length > 80) throw new Error('not a recording');
  if (kind === 'part' && !(['m', 'p', 'q'].includes(v.kind) && Number.isFinite(v.n) && v.n >= 0 && v.blob instanceof Blob)) throw new Error('not a part of a recording');
  return v;
}

export const wanted = () => location.hash === '#movein' && !!window.opener && mayReceive(location);

// Does this address already hold things of its own in this browser?
export function hasThings() {
  try {
    const s = JSON.parse(localStorage.getItem('planner.v1') || 'null');
    return !!s && ((s.accounts || []).length > 0 || (s.tasks || []).length > 0 || Object.keys(s.notes || {}).length > 0);
  } catch { return false; }
}

// Takes everything in. say(text) shows progress; putRecording(kind, value) stores one recording or
// one part. Ends with true when everything arrived and was saved, false when it did not.
export function receive(say, putRecording) {
  return new Promise(done => {
    const from = window.opener;
    let staged = null, recordings = 0, timer = 0, over = false;
    const tell = m => { try { from.postMessage(m, '*'); } catch { /* the other tab has gone */ } }; // only "ready", "ok", "done": nothing private
    const finish = ok => { over = true; clearTimeout(timer); removeEventListener('message', on); done(ok); };
    const patience = () => { clearTimeout(timer); timer = setTimeout(() => { say('The old address stopped answering. Nothing was changed here.'); finish(false); }, 60000); };
    async function on(e) {
      if (over || e.source !== from || !trusted(e.origin, location) || !e.data || typeof e.data !== 'object') return;
      const d = e.data;
      patience();
      try {
        if (d.t === 'store') { staged = checkItems(d.items); tell({ t: 'ok' }); }
        else if (d.t === 'rec') { await putRecording('rec', checkRecording('rec', d.rec)); recordings++; say(`Bringing your recordings: ${recordings}`); tell({ t: 'ok' }); }
        else if (d.t === 'part') { await putRecording('part', checkRecording('part', d.part)); tell({ t: 'ok' }); }
        else if (d.t === 'end') {
          if (!staged) throw new Error('nothing arrived');
          for (const [key, value] of Object.entries(staged)) localStorage.setItem(key, value);
          tell({ t: 'done' });
          finish(true);
        }
      } catch (err) {
        console.warn('move', err);
        tell({ t: 'failed' });
        say('That did not work, and nothing was changed here. Go back to the other tab and try again.');
        finish(false);
      }
    }
    addEventListener('message', on);
    patience();
    tell({ t: 'ready' });
  });
}
