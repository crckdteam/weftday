// Private notes on meetings.
// Each note is kept in this browser. When tasks are saved to Google, a note is also kept as a hidden
// entry in the "Weftday" calendar of your home account, so it follows you to your other devices.
// Nothing is written to the meeting itself, so other guests never see your notes.
import { state, save } from './store.js';
import * as G from './google.js';

const DAY = '2000-01-10', NEXT_DAY = '2000-01-11'; // the hidden entries sit on this day, far from real plans
const FROM = new Date(Date.UTC(2000, 0, 9)), TO = new Date(Date.UTC(2000, 0, 12));
export const MAX_LENGTH = 7500;
export const isNote = e => !!e.extendedProperties?.private?.plannerNote;

const home = () => state.accounts.find(a => a.id === state.settings.plannerAccountId);
const path = () => `/calendars/${G.enc(state.settings.plannerCalendarId)}/events`;
const gone = err => err.status === 404 || err.status === 410;
const all = () => (state.notes ||= {});

// Which meeting a note belongs to. The same meeting seen through two of your accounts gets the same
// key, and each occurrence of a repeating meeting gets its own.
export function keyFor(e) {
  const orig = e.originalStartTime?.dateTime || e.originalStartTime?.date || (e.recurringEventId ? e.start?.dateTime || e.start?.date : '');
  const when = !orig ? '' : orig.length > 10 ? new Date(orig).toISOString() : orig;
  const key = `${e.iCalUID || e.id}${when ? '|' + when : ''}`;
  if (key.length <= 900) return key;
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = (h * 33 + key.charCodeAt(i)) >>> 0;
  return `${key.slice(0, 860)}#${h.toString(36)}`;
}

export const get = key => all()[key] || null;
export const has = key => !!all()[key]?.text;

// Saves what was typed. "about" is { title, when, people } of the meeting, kept so the note can be
// found again later ("earlier notes with these people"). Returns true if anything changed.
export function set(key, text, about) {
  const notes = all(), old = notes[key];
  text = text.slice(0, MAX_LENGTH);
  if ((old?.text || '') === text) return false;
  if (!text && !old?.gEventId) delete notes[key]; // never reached Google: nothing to clean up there
  else notes[key] = { ...old, ...about, text, t: Date.now(), dirty: true };
  save();
  return true;
}

// What you know about a person is kept as a note of its own, so it shows in every meeting with them.
export const aboutKey = email => `person:${email}`;
const isAbout = key => key.startsWith('person:');

// Notes from other meetings that share at least one of these people, newest first.
export function withPeople(emails, exceptKey) {
  const want = new Set(emails);
  return Object.entries(all())
    .filter(([key, n]) => key !== exceptKey && !isAbout(key) && n.text && (n.people || []).some(p => want.has(p)))
    .map(([key, n]) => ({ key, ...n }))
    .sort((a, b) => (b.when || 0) - (a.when || 0));
}

export const pending = () => Object.values(all()).some(n => n.dirty);

// After the home account changes, every note has to be sent to the new place.
export function forgetRemote() {
  for (const n of Object.values(all())) { n.gEventId = null; n.remoteUpdated = null; n.dirty = true; }
  save();
}

function entry(key, n) {
  return {
    summary: isAbout(key) ? `About: ${n.title || 'a person'}` : `Notes: ${n.title || 'meeting'}`,
    description: n.text,
    start: { date: DAY }, end: { date: NEXT_DAY }, transparency: 'transparent',
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: {
      plannerNote: '1', key, when: String(n.when || ''), title: (n.title || '').slice(0, 300),
      people: (n.people || []).join(',').slice(0, 900),
    } },
  };
}

// Sends changed notes to Google. You may keep typing while a note is on its way: what was sent is
// matched up afterwards with the note as it is by then, never with an older copy of it.
export async function push() {
  const notes = all();
  for (const key of Object.keys(notes)) {
    const n = notes[key];
    if (!n?.dirty) continue;
    const t = n.t;
    if (!n.text) { // cleared: remove it from Google too
      if (n.gEventId) {
        try { await G.api(home(), `${path()}/${G.enc(n.gEventId)}`, { method: 'DELETE' }); }
        catch (err) { if (!gone(err)) throw err; }
      }
      if (notes[key]?.t === t) delete notes[key];
      else if (notes[key]) { notes[key].gEventId = null; notes[key].remoteUpdated = null; } // written again meanwhile: goes out as a new entry
      save();
      continue;
    }
    const body = entry(key, n);
    let res = null;
    if (n.gEventId) {
      try { res = await G.api(home(), `${path()}/${G.enc(n.gEventId)}`, { method: 'PUT', body }); }
      catch (err) { if (!gone(err)) throw err; }
    }
    if (!res) res = await G.api(home(), path(), { method: 'POST', body });
    const cur = notes[key]; // the note as it is now
    if (!cur) { // cleared while it was being sent, before it had an entry: take the new entry away again
      await G.api(home(), `${path()}/${G.enc(res.id)}`, { method: 'DELETE' }).catch(() => {});
      continue;
    }
    cur.gEventId = res.id;
    cur.remoteUpdated = res.updated;
    if (cur.t === t) cur.dirty = false; // typed again meanwhile: goes out on the next round
    save();
  }
}

// Brings in notes written on your other devices. Returns true if anything changed here.
export async function pull() {
  const notes = all();
  const items = (await G.listEvents(home(), state.settings.plannerCalendarId, FROM, TO))
    .filter(e => e.status !== 'cancelled' && isNote(e) && e.extendedProperties.private.key);
  const newest = new Map(); // if two devices made a note for the same meeting, the latest one counts
  for (const e of items) {
    const key = e.extendedProperties.private.key, cur = newest.get(key);
    if (!cur || e.updated > cur.updated) newest.set(key, e);
  }
  for (const e of items) { // an older second entry for the same note (left by an interrupted save) is taken away
    if (newest.get(e.extendedProperties.private.key) !== e) G.api(home(), `${path()}/${G.enc(e.id)}`, { method: 'DELETE' }).catch(() => {});
  }
  const live = new Set(items.map(e => e.id));
  let changed = false;
  for (const [key, e] of newest) {
    const n = notes[key], p = e.extendedProperties.private;
    if (n?.dirty) { if (!n.gEventId) n.gEventId = e.id; continue; } // a local edit is waiting to go out: it wins
    if (n && n.gEventId === e.id && n.remoteUpdated === e.updated) continue;
    notes[key] = {
      text: e.description || '', title: p.title || '', when: +p.when || 0, people: p.people ? p.people.split(',') : [],
      t: Date.parse(e.updated) || 0, gEventId: e.id, remoteUpdated: e.updated, dirty: false,
    };
    changed = true;
  }
  for (const [key, n] of Object.entries(notes)) { // removed on another device
    if (n.gEventId && !n.dirty && !live.has(n.gEventId)) { delete notes[key]; changed = true; }
  }
  if (changed) save();
  return changed;
}
