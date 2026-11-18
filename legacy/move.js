// The page left at the address Weftday used to live at. A browser keeps what a site saves under
// that site's address, so this page, which is still at the old address, can read what was saved
// here and hand it to the app at its new address: tab to tab, inside this browser, through no server.
//
// What is handed over includes sign-ins and keys, so it is only ever sent to the one tab this page
// opened itself, and only while that tab is showing the new address (the browser enforces the
// address named in every postMessage call below).
const NEW = document.querySelector('meta[name=weftday-new]').content;
const NEW_ORIGIN = new URL(NEW).origin;
const KEYS = ['planner.v1', 'weftday.rec', 'weftday.toured', 'weftday.tips'];
const DB = 'weftday-recordings';
const $ = id => document.getElementById(id);
// A browser that blocks this site's storage simply has nothing saved here.
const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* storage is blocked */ } };

// ---- what is saved here
function saved() {
  const out = {};
  for (const key of KEYS) { const v = read(key); if (v != null) out[key] = v; }
  return out;
}
function hasThings(items) {
  try {
    const s = JSON.parse(items['planner.v1'] || 'null');
    return !!s && ((s.accounts || []).length > 0 || (s.tasks || []).length > 0 || Object.keys(s.notes || {}).length > 0 || !!s.settings?.clientId);
  } catch { return false; }
}
const wait = req => new Promise((done, fail) => { req.onsuccess = () => done(req.result); req.onerror = () => fail(req.error); });
// The recordings kept here, or null when there have never been any.
async function recordingsDb() {
  let made = false;
  const req = indexedDB.open(DB);
  req.onupgradeneeded = () => { made = true; }; // it did not exist: opening it has just made an empty one
  const db = await wait(req);
  if (made || !db.objectStoreNames.contains('recs') || !db.objectStoreNames.contains('parts')) { db.close(); if (made) indexedDB.deleteDatabase(DB); return null; }
  return db;
}
const from = (db, store, fn) => wait(fn(db.transaction(store, 'readonly').objectStore(store)));

// ---- handing it over
// The saved things go first, in one message. Then each recording: its parts, one at a time (so a
// long recording never has to fit in memory at once), and only then its entry, so the app at the
// new address never lists a recording that is not whole. Each message waits for its answer.
// onSettled() is called once the saved things have arrived, whatever happens to the recordings.
function handOver(win, items, db, say, onSettled) {
  return new Promise((done, fail) => {
    let next = null, timer = 0, kept = false;
    const watch = setInterval(() => { if (win.closed) stop(new Error('closed')); }, 1000);
    const stop = err => { clearTimeout(timer); clearInterval(watch); removeEventListener('message', on); err ? fail(err) : done(kept); };
    const patience = ms => { clearTimeout(timer); timer = setTimeout(() => stop(new Error('quiet')), ms); };
    const send = msg => new Promise((ok, no) => { next = { ok, no }; patience(180000); win.postMessage(msg, NEW_ORIGIN); });
    function on(e) {
      if (e.source !== win || e.origin !== NEW_ORIGIN || !e.data || typeof e.data !== 'object') return;
      const t = e.data.t, waiting = next;
      if (t === 'ready' && !waiting) { run().then(() => stop(), stop); return; }
      if (!waiting) return;
      next = null;
      if (t === 'done') kept = e.data.kept === true;
      if (t === 'ok' || t === 'done') waiting.ok(t); else waiting.no(new Error('refused'));
    }
    async function run() {
      await send({ t: 'store', items });
      onSettled();
      if (db) {
        const recs = await from(db, 'recs', s => s.getAll()), keys = await from(db, 'parts', s => s.getAllKeys());
        let n = 0;
        for (const rec of recs) {
          for (const key of keys.filter(k => k[0] === rec.id)) {
            const part = await from(db, 'parts', s => s.get(key));
            if (part) await send({ t: 'part', part });
            say(`Moving your recordings: ${Math.round(++n / keys.length * 100)}%`);
          }
          await send({ t: 'rec', rec });
        }
      }
      if (await send({ t: 'end' }) !== 'done') throw new Error('not finished');
    }
    addEventListener('message', on);
    patience(240000); // for the new tab to open and say it is ready (it may first ask whether to replace what it has)
  });
}

let busy = false;
addEventListener('beforeunload', e => { if (busy) e.preventDefault(); }); // leaving mid-move would cut it short
function show(state, text) {
  const status = $('status');
  busy = state === 'busy';
  status.hidden = !text; status.textContent = text || ''; status.classList.toggle('bad', state === 'bad');
  $('move').disabled = busy;
  $('open').hidden = busy; // the way out comes back when the move is over
}

// The installed copy on an iPhone or iPad keeps its things apart from the browser, and cannot open
// the new address in a way that could receive them. It says so instead of pretending.
const walledOff = navigator.standalone === true;

async function start() {
  if (window.top !== window) return; // never inside another page
  // A setup link or a sample-data link made for the old address still works: it is passed on.
  const setup = /^#setup2?=[\w-]+$/.test(location.hash) ? location.hash : '';
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  const query = new URLSearchParams(location.search), again = query.has('again'), demo = query.has('demo') ? '?demo' : '';
  $('where').textContent = new URL(NEW).host;
  $('open').href = NEW;
  const items = saved();
  let db = null;
  try { db = await recordingsDb(); } catch { /* no recordings can be read: the rest still moves */ }
  const count = db ? await from(db, 'recs', s => s.count()).catch(() => 0) : 0;
  // Nothing here to move, or already moved: go straight to the new address.
  if (!again && (read('weftday.moved') || (!hasThings(items) && !count))) { location.replace(NEW + demo + setup); return; }
  $('card').hidden = false;
  if (walledOff) {
    $('lede').textContent = `Weftday now lives at ${new URL(NEW).host}. This installed copy cannot pass its things to the new address by itself. Open the new address in your browser and connect your Google account there: your tasks come back from your Weftday calendar. Recordings kept in this copy stay here, so save the ones you want as files first.`;
    $('move').hidden = true; $('note').hidden = true;
    return;
  }
  $('move').addEventListener('click', async () => {
    const win = window.open(NEW + '#movein', '_blank');
    if (!win) { show('bad', 'Your browser stopped the new tab from opening. Allow pop-ups for this page, then press the button again.'); return; }
    show('busy', 'Moving your things to the new tab. Keep this tab open until it says they have moved.');
    // After a move that brought the saved things but not every recording, a second go sends only the recordings.
    const things = read('weftday.settled') && !again ? {} : saved();
    try {
      const kept = await handOver(win, things, db, text => show('busy', text), () => write('weftday.settled', new Date().toISOString()));
      write('weftday.moved', new Date().toISOString());
      finished(kept, db);
    } catch (err) {
      console.warn('move', err);
      const some = !!read('weftday.settled');
      show('bad', some ? 'Your tasks, notes, accounts and keys have arrived, but not every recording did. Close the new tab, then press the button again to bring the rest.'
        : err.message === 'closed' ? 'The new tab was closed before anything moved. Press the button again when you are ready.'
        : err.message === 'quiet' ? 'The new tab did not answer. Nothing was changed. Close it, then press the button again.'
        : 'That did not work. Nothing was changed. Close the new tab, then press the button again.');
    }
  });
}

function finished(kept, db) {
  show('done', '');
  $('title').textContent = 'Your things have moved';
  $('lede').textContent = kept
    ? 'You kept what the new address already had, and your recordings were brought over. From now on, use the new address.'
    : 'Weftday is open in the other tab with everything in place. From now on, use the new address.';
  $('move').hidden = true;
  $('open').textContent = 'Open Weftday'; $('open').className = 'btn solid';
  $('note').textContent = 'A copy of your things is still saved at this old address, sign-ins and keys included. You can remove it now that they have arrived.';
  const forget = $('forget');
  forget.hidden = false;
  forget.addEventListener('click', async () => {
    if (!confirm('Remove everything Weftday saved at this old address?\n\nYour things at the new address are not touched. Do this only once you have seen them there.')) return;
    forget.disabled = true;
    try {
      for (const key of Object.keys(localStorage)) if ((key.startsWith('planner.') || key.startsWith('weftday.')) && key !== 'weftday.moved') localStorage.removeItem(key);
      db?.close(); // an open connection would hold the removal up
      await new Promise(done => { const r = indexedDB.deleteDatabase(DB); r.onsuccess = r.onerror = r.onblocked = done; });
      forget.hidden = true;
      $('note').textContent = 'Removed. Nothing of yours is saved at this old address any more.';
    } catch { forget.disabled = false; $('note').textContent = 'That could not be removed just now. You can also clear this site’s data in your browser’s settings.'; }
  });
}

// Whatever goes wrong before the page is drawn, nobody is left looking at a blank one.
start().catch(() => location.replace(NEW));
