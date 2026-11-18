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

// ---- what is saved here
function saved() {
  const out = {};
  for (const key of KEYS) { const v = localStorage.getItem(key); if (v != null) out[key] = v; }
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
const read = (db, store, fn) => wait(fn(db.transaction(store, 'readonly').objectStore(store)));

// ---- handing it over
function handOver(win, items, db, say) {
  return new Promise((done, fail) => {
    let next = null, timer = 0;
    const stop = err => { clearTimeout(timer); removeEventListener('message', on); err ? fail(err) : done(); };
    const patience = ms => { clearTimeout(timer); timer = setTimeout(() => stop(new Error('quiet')), ms); };
    const send = msg => new Promise((ok, no) => { next = { ok, no }; patience(120000); win.postMessage(msg, NEW_ORIGIN); });
    function on(e) {
      if (e.source !== win || e.origin !== NEW_ORIGIN || !e.data || typeof e.data !== 'object') return;
      const t = e.data.t, waiting = next;
      if (t === 'ready' && !waiting) { run().then(() => stop(), stop); return; }
      if (!waiting) return;
      next = null;
      if (t === 'ok' || t === 'done') waiting.ok(t); else waiting.no(new Error('refused'));
    }
    async function run() {
      await send({ t: 'store', items });
      if (db) {
        const recs = await read(db, 'recs', s => s.getAll()), keys = await read(db, 'parts', s => s.getAllKeys());
        let n = 0;
        for (const rec of recs) await send({ t: 'rec', rec });
        for (const key of keys) { // one part at a time, so a long recording never has to fit in memory at once
          const part = await read(db, 'parts', s => s.get(key));
          if (part) await send({ t: 'part', part });
          say(`Moving your recordings: ${Math.round(++n / keys.length * 100)}%`);
        }
      }
      if (await send({ t: 'end' }) !== 'done') throw new Error('not finished');
    }
    addEventListener('message', on);
    patience(180000); // for the new tab to open and say it is ready (it may first ask whether to replace what it has)
  });
}

function show(state, text) {
  const status = $('status');
  status.hidden = !text; status.textContent = text || ''; status.classList.toggle('bad', state === 'bad');
  $('move').disabled = state === 'busy';
  if (state === 'done') {
    $('title').textContent = 'Your things have moved';
    $('lede').textContent = 'Weftday is open in the other tab with everything in place. From now on, use the new address.';
    $('move').hidden = true; $('note').hidden = true;
    $('open').textContent = 'Open Weftday'; $('open').className = 'btn solid';
  }
}

async function start() {
  $('where').textContent = new URL(NEW).host;
  $('open').href = NEW;
  const again = new URLSearchParams(location.search).has('again');
  const items = saved();
  let db = null;
  try { db = await recordingsDb(); } catch { /* no recordings can be read: the rest still moves */ }
  const count = db ? await read(db, 'recs', s => s.count()).catch(() => 0) : 0;
  // Nothing here to move, or already moved: go straight to the new address.
  if (!again && (localStorage.getItem('weftday.moved') || (!hasThings(items) && !count))) { location.replace(NEW); return; }
  $('card').hidden = false;
  $('move').addEventListener('click', async () => {
    const win = window.open(NEW + '#movein', '_blank');
    if (!win) { show('bad', 'Your browser stopped the new tab from opening. Allow pop-ups for this page, then press the button again.'); return; }
    show('busy', 'Moving your things to the new tab. Keep this tab open.');
    try {
      await handOver(win, saved(), db, text => show('busy', text));
      localStorage.setItem('weftday.moved', new Date().toISOString());
      show('done', '');
    } catch (err) {
      console.warn('move', err);
      show('bad', err.message === 'quiet'
        ? 'The new tab did not answer. Close it, then press the button again.'
        : 'That did not work. Nothing was changed. Close the new tab, then press the button again.');
    }
  });
}
start();
