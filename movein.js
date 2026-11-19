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
// One recording, or one stored part of one, as it arrived. A recording must be of a kind this app
// makes; a small picture that is not a picture is left out (the app draws a new one by itself).
export function checkRecording(kind, v) {
  if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !v.id || v.id.length > 80) throw new Error('not a recording');
  if (kind === 'part' && !(['m', 'p', 'q'].includes(v.kind) && Number.isFinite(v.n) && v.n >= 0 && v.blob instanceof Blob)) throw new Error('not a part of a recording');
  if (kind === 'rec') {
    if (!['video', 'audio', 'shot'].includes(v.kind)) throw new Error('not a recording');
    if (v.thumb != null && !(v.thumb instanceof Blob)) delete v.thumb;
  }
  return v;
}

export const wanted = () => location.hash === '#movein' && !!window.opener && mayReceive(location);

// Does this saved state (as text; by default the one saved at this address) hold things of the
// person's own: accounts, tasks, notes, or a key they typed in?
export function hasThings(text) {
  try {
    const s = JSON.parse((text === undefined ? localStorage.getItem('planner.v1') : text) || 'null'), st = s?.settings || {};
    return !!s && ((s.accounts || []).length > 0 || (s.tasks || []).length > 0 || Object.keys(s.notes || {}).length > 0
      || !!(st.clientId || st.clientSecret || st.aiKey || st.claudeKey || st.searchKey)
      || Object.values(st.aiKeys || {}).some(Boolean) || Object.values(st.searchKeys || {}).some(Boolean));
  } catch { return false; }
}

// Takes everything in.
//   say(text)        shows progress
//   put(kind, value) stores one recording ('rec') or one part of one ('part')
//   ask()            true if the person agrees to replace what this address already has
//   tidy()           removes parts of a recording that never finished arriving
// Ends with 'all' (everything arrived), 'some' (the saved things are settled but not every
// recording arrived) or 'none' (nothing was changed here).
//
// The order keeps every stopping point safe. The saved things (tasks, notes, accounts, keys) are
// written first, in one go, so they never wait on a long recording. Each recording then arrives
// as its parts followed by its entry, so the app only ever lists a recording that is whole.
export function receive({ say, put, ask, tidy }) {
  return new Promise(done => {
    const from = window.opener;
    // Answers go to the old address and nowhere else, so a page that merely opened this one hears nothing.
    const to = isLocal(location.hostname) ? '*' : MOVED_FROM;
    let settled = false, kept = false, recordings = 0, timer = 0, over = false;
    const tell = m => { try { from.postMessage(m, to); } catch { /* the other tab has gone */ } }; // only "ready", "ok", "done", "failed": nothing private
    const finish = result => { over = true; clearTimeout(timer); removeEventListener('message', on); done(result); };
    const SOME = 'Your tasks, notes, accounts and keys are settled here, but not every recording came across. The rest are still at the old address: go back to the other tab and press the button again to bring them.';
    async function fail(text) {
      if (over) return;
      over = true; // nothing more is taken in while the leftovers are cleared
      try { await tidy?.(); } catch { /* the leftovers are cleared the next time the app starts */ }
      say(settled ? SOME : text);
      finish(settled ? 'some' : 'none');
    }
    const patience = () => { clearTimeout(timer); timer = setTimeout(() => fail('The old address stopped answering. Nothing was changed here.'), 60000); };
    async function on(e) {
      if (over || e.source !== from || !trusted(e.origin, location) || !e.data || typeof e.data !== 'object') return;
      const d = e.data;
      patience();
      try {
        if (d.t === 'store' && !settled) {
          let items = checkItems(d.items);
          if (!hasThings(items['planner.v1'] ?? null)) items = {}; // nothing of the person's in it: never replace what is here with nothing
          else if (hasThings() && !ask()) { items = {}; kept = true; say('Your things here were left as they are. Bringing your recordings.'); }
          patience(); // the question may have taken a while to answer
          for (const [key, value] of Object.entries(items)) localStorage.setItem(key, value);
          if (items['planner.v1']) localStorage.setItem('weftday.movedin', String(Date.now())); // other open copies of the app load afresh on this (store.js)
          settled = true;
          tell({ t: 'ok' });
        } else if (d.t === 'part' && settled) { await put('part', checkRecording('part', d.part)); tell({ t: 'ok' }); }
        else if (d.t === 'rec' && settled) { await put('rec', checkRecording('rec', d.rec)); recordings++; say(`Bringing your recordings: ${recordings}`); tell({ t: 'ok' }); }
        else if (d.t === 'end' && settled) { tell({ t: 'done', kept }); finish('all'); }
      } catch (err) {
        console.warn('move', err);
        tell({ t: 'failed' });
        fail('That did not work, and nothing was changed here. Go back to the other tab and try again.');
      }
    }
    addEventListener('message', on);
    patience();
    tell({ t: 'ready' });
  });
}
