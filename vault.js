// Keeps the list of connected Google accounts the same on all of your devices (optional).
// The list, with each account's sign-in, is locked with a key made from your Client secret and
// kept in one hidden entry of the "Weftday" calendar in your home account. No server is involved:
// each device reads and writes that entry in your own Google account.
import { state, save } from './store.js';
import * as G from './google.js';

const DAY = '2000-01-05', NEXT_DAY = '2000-01-06'; // the hidden entry sits on this day, far from real plans
const FROM = new Date(Date.UTC(2000, 0, 4)), TO = new Date(Date.UTC(2000, 0, 7));
const KEEP_GONE = 180 * 86400000; // remember removed accounts for six months
const CHUNK = 900;                // Google limits how long one stored value can be

const home = () => state.accounts.find(a => a.id === state.settings.plannerAccountId);
const eventsPath = () => `/calendars/${G.enc(state.settings.plannerCalendarId)}/events`;
export const isShared = e => !!e.extendedProperties?.private?.plannerVault;
export const sharingReady = () => !!state.settings.shareAccounts && !!state.settings.clientSecret
  && !!state.settings.plannerCalendarId && !!home() && !home().needsReconnect;

// ---- locking
const toB64 = bytes => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const fromB64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
async function lockKey() {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('weftday accounts v1:' + state.settings.clientSecret));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function lock(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await lockKey(), data));
  const all = new Uint8Array(12 + ct.length);
  all.set(iv); all.set(ct, 12);
  return toB64(all);
}
async function unlock(text) {
  const all = fromB64(text);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, await lockKey(), all.slice(12));
  return JSON.parse(new TextDecoder().decode(plain));
}

// ---- the hidden calendar entry
function entry(text) {
  const priv = { plannerVault: '1', n: String(Math.ceil(text.length / CHUNK)) };
  for (let i = 0; i * CHUNK < text.length; i++) priv['c' + i] = text.slice(i * CHUNK, (i + 1) * CHUNK);
  return {
    summary: 'Weftday: your connected accounts (please keep)',
    description: 'Weftday uses this entry to keep your accounts the same on all your devices. Deleting it turns that off.',
    start: { date: DAY }, end: { date: NEXT_DAY }, transparency: 'transparent',
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: priv },
  };
}
async function findEntries() {
  const items = await G.listEvents(home(), state.settings.plannerCalendarId, FROM, TO);
  return items.filter(e => e.status !== 'cancelled' && isShared(e)).sort((a, b) => (a.updated < b.updated ? 1 : -1));
}

// ---- merging this device's list with the shared one
const byE = (a, b) => (a.e < b.e ? -1 : a.e > b.e ? 1 : 0);
// Your AI and search keys travel with the account list: { t: when they last changed, v: the keys }.
const KEY_FIELDS = ['aiProvider', 'aiKey', 'claudeKey', 'aiKeys', 'aiModels', 'searchProvider', 'searchKey', 'searchKeys'];
const pickKeys = from => Object.fromEntries(KEY_FIELDS.filter(k => from[k] !== undefined).map(k => [k, from[k]]));
const tidy = r => ({
  v: 1,
  keys: r.keys && r.keys.t && r.keys.v ? { t: r.keys.t, v: pickKeys(r.keys.v) } : null,
  accounts: (r.accounts || []).filter(x => x && x.e && x.r).map(({ e, r: tok, t }) => ({ e, r: tok, t: t || 0 })).sort(byE),
  gone: (r.gone || []).filter(g => g && g.e).map(({ e, t }) => ({ e, t: t || 0 })).sort(byE),
});
const mine = () => tidy({
  keys: state.settings.keysAt ? { t: state.settings.keysAt, v: pickKeys(state.settings) } : null,
  accounts: state.accounts.filter(a => a.refreshToken).map(a => ({ e: a.id, r: a.refreshToken, t: a.t })),
  gone: state.goneAccounts || [],
});

// Brings this device's AI and search keys into step with the shared set.
// Normally the set that changed last wins outright, so removing a key somewhere removes it everywhere.
// The first time a device joins (or when two sets carry the same stamp) nothing is thrown away:
// each side's blanks are filled from the other.
const LOCAL_ONLY = ['ollama']; // a service on one computer is not chosen for your other devices
function mergeKeys(theirs) {
  if (!theirs) return;
  const s = state.settings, mineAt = s.keysAt || 0, v = { ...theirs.v };
  if (LOCAL_ONLY.includes(v.aiProvider)) delete v.aiProvider;
  if (state.sharedSeen && theirs.t !== mineAt) {
    if (theirs.t > mineAt) Object.assign(s, v, { keysAt: theirs.t, aiFreeSince: 0 });
    return;
  }
  const newer = theirs.t > mineAt ? v : pickKeys(s), older = theirs.t > mineAt ? pickKeys(s) : v, out = {};
  for (const k of KEY_FIELDS) {
    const a = newer[k], b = older[k];
    out[k] = a && typeof a === 'object' ? { ...(b && typeof b === 'object' ? b : {}), ...a } : a || b || (k.endsWith('Provider') ? undefined : '');
    if (out[k] === undefined) delete out[k];
  }
  const same = x => JSON.stringify(KEY_FIELDS.map(k => x[k] ?? null));
  if (same(out) === same(pickKeys(s))) { if (same(out) === same(v) && theirs.t > mineAt) s.keysAt = theirs.t; return; }
  Object.assign(s, out, { keysAt: same(out) === same(v) ? theirs.t : Date.now(), aiFreeSince: 0 });
}

function merge(remote) {
  const now = Date.now(), added = [], removed = [], homeId = state.settings.plannerAccountId;
  for (const a of state.accounts) if (!a.t) a.t = now;
  const gone = new Map();
  for (const g of [...remote.gone, ...(state.goneAccounts || [])]) {
    if (g && g.e && now - g.t < KEEP_GONE) gone.set(g.e, Math.max(g.t, gone.get(g.e) || 0));
  }
  const theirs = new Map(remote.accounts.map(x => [x.e, x]));
  mergeKeys(remote.keys);

  // removed on another device after it was last connected anywhere
  for (const a of [...state.accounts]) {
    const lastConnected = Math.max(a.t, theirs.get(a.id)?.t || 0);
    if (a.id !== homeId && gone.get(a.id) > lastConnected) {
      state.accounts.splice(state.accounts.indexOf(a), 1);
      removed.push(a.email);
    }
  }
  for (const [e, x] of theirs) {
    const a = state.accounts.find(o => o.id === e);
    if (a) { // same account on both: take the other device's sign-in if it is newer, or if ours has stopped working
      if (x.r !== a.refreshToken && (x.t > a.t || a.needsReconnect)) {
        Object.assign(a, { refreshToken: x.r, accessToken: null, expiresAt: 0, needsReconnect: false });
      }
      if (x.t > a.t) a.t = x.t;
    } else if (!(gone.get(e) > x.t)) { // connected on another device: add it here
      state.accounts.push({
        id: e, email: e, color: G.COLORS[state.accounts.length % G.COLORS.length], calendars: [],
        refreshToken: x.r, accessToken: null, expiresAt: 0, needsReconnect: false, t: x.t,
      });
      added.push(e);
    }
  }
  for (const a of state.accounts) if (gone.has(a.id) && gone.get(a.id) <= a.t) gone.delete(a.id); // connected again since
  state.goneAccounts = [...gone].map(([e, t]) => ({ e, t }));
  save();
  return { added, removed };
}

// Brings this device and the shared list into step. Returns what changed on this device.
export async function syncAccounts() {
  if (!sharingReady()) return null;
  const found = await findEntries(), ev = found[0];
  let remote = null;
  if (ev) {
    const p = ev.extendedProperties.private;
    let text = '';
    for (let i = 0; i < +p.n; i++) text += p['c' + i] || '';
    try { remote = tidy(await unlock(text)); } catch { remote = null; } // locked with other keys: start again from this device
  } else if (state.sharedSeen) { // the entry is gone: sharing was turned off on another device
    state.settings.shareAccounts = false;
    state.sharedSeen = false;
    save();
    return { off: true, added: [], removed: [] };
  }
  const result = merge(remote || tidy({}));
  const next = mine();
  if (!remote || JSON.stringify(remote) !== JSON.stringify(next)) {
    const body = entry(await lock(next));
    if (ev) await G.api(home(), `${eventsPath()}/${G.enc(ev.id)}`, { method: 'PUT', body });
    else await G.api(home(), eventsPath(), { method: 'POST', body });
  }
  for (const extra of found.slice(1)) await G.api(home(), `${eventsPath()}/${G.enc(extra.id)}`, { method: 'DELETE' }).catch(() => {});
  state.sharedSeen = true;
  save();
  return result;
}

// Call when an account is removed here, so your other devices drop it too.
export function forgetAccount(id) {
  if (!state.settings.shareAccounts || id === state.settings.plannerAccountId) return; // also while the home account is signed out
  state.goneAccounts = (state.goneAccounts || []).filter(g => g.e !== id).concat({ e: id, t: Date.now() });
  save();
}

// Removes the shared list from Google (used when sharing is switched off, or the home account changes).
export async function clearShared() {
  if (!state.settings.plannerCalendarId) return;
  // If the copy at Google cannot be removed, say so: the switch must not look off while the copy is still there.
  if (!home() || home().needsReconnect) throw new Error('The shared copy is kept in an account that is signed out. Reconnect it first, then switch this off again.');
  for (const e of await findEntries()) await G.api(home(), `${eventsPath()}/${G.enc(e.id)}`, { method: 'DELETE' });
  state.sharedSeen = false;
  save();
}

// ---- the link that sets up one of your own devices
// It carries a sign-in, so it is locked: the link alone (in a chat, a photo of the square, the
// clipboard) opens nothing. It only works together with a code that is shown on your screen and
// typed on the new device, and only for a quarter of an hour.
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I/L to mix up
const toB64u = bytes => toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = text => fromB64(text.replace(/-/g, '+').replace(/_/g, '/'));
const plainCode = code => String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
async function codeKey(code, salt) {
  const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(plainCode(code)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 310000 }, raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
// Returns { blob, code }: blob goes into the link, code is shown to the person.
export async function lockSetup(d, minutes = 15) {
  let code = '';
  while (code.length < 10) for (const b of crypto.getRandomValues(new Uint8Array(16))) if (b < 248 && code.length < 10) code += CODE_LETTERS[b % 31]; // 248 = 8 x 31: every letter equally likely
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new TextEncoder().encode(JSON.stringify({ ...d, x: Date.now() + minutes * 60000 }));
  const locked = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await codeKey(code, salt), body));
  const all = new Uint8Array(28 + locked.length);
  all.set(salt); all.set(iv, 16); all.set(locked, 28);
  return { blob: toB64u(all), code: `${code.slice(0, 5)}-${code.slice(5)}` };
}
// Opens it again. Throws an error with kind 'link' (damaged), 'code' (wrong code) or 'expired'.
export async function unlockSetup(blob, code) {
  let all = null;
  try { all = fromB64u(blob); } catch { /* not a link of ours */ }
  if (!all || all.length < 45) throw Object.assign(new Error('That setup link is not valid.'), { kind: 'link' });
  let d = null;
  try { d = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(16, 28) }, await codeKey(code, all.slice(0, 16)), all.slice(28)))); }
  catch { throw Object.assign(new Error('That code does not match. Check it on your other device and type it again.'), { kind: 'code' }); }
  if (!(d.x > Date.now())) throw Object.assign(new Error('This link is more than 15 minutes old. Make a fresh one on your other device.'), { kind: 'expired' });
  return d;
}

