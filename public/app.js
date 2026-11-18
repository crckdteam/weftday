import { state, save, isStale, DEMO, loadEventCache, saveEventCache } from './store.js';
import * as G from './google.js';
import * as V from './vault.js';
import * as N from './notes.js';
import * as AI from './ai.js';
import * as F from './facts.js';
import * as S from './services.js';
import * as R from './recorder.js';
import * as D from './drive.js';
import * as E from './editor.js';

// Weftday never runs inside another site's page, where a press could be tricked out of someone.
if (self !== top) { document.documentElement.innerHTML = ''; throw new Error('Weftday does not run inside another page.'); }
import { qrSvg } from './qr.js';
import { PUBLIC_URL } from './config.js';
import * as Move from './movein.js';
import {
  pad, ymd, fromYmd, addDays, startOfDay, startOfWeek, localIso, hhmm, parseHhmm, clamp,
  fmtTime, fmtRange, fmtDur, dayLabel, uid, esc, parseQuick, days, monthStart, repeatsOn, repeatLabel, repeatDays, firstRepeatDay, VIDEO_RE, webLink, hue } from './util.js';

const HOUR = 52, PXM = HOUR / 60, SNAP = 15;
const INBOX_DATE = '2000-01-01'; // inbox tasks are parked on this day in the "Weftday" calendar
const VIEWS = ['day', 'week', 'month', 'list'];        // the calendar's views; 'notes' is a view too, but is never the one the app opens on
const TZ = (zone => (zone === 'Asia/Calcutta' ? 'Asia/Kolkata' : zone))(Intl.DateTimeFormat().resolvedOptions().timeZone); // the old name for India's zone is still common
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = {
  side: $('#sideBody'), head: $('#gridHead'), body: $('#gridBody'), grid: $('#grid'),
  month: $('#month'), list: $('#list'), notes: $('#notes'), home: $('#home'), hint: $('#quickHint'),
  title: $('#title'), status: $('#status'), dlg: $('#dlg'), toast: $('#toast'),
};

const calendarView = () => (VIEWS.includes(state.settings.view) ? state.settings.view : (innerWidth < 760 ? 'day' : 'week')); // the calendar view last used
let view = 'home'; // the app opens on Home: what is next, today, your tasks and your latest notes
let cursor = startOfDay(new Date());
let miniMonth = null;   // month shown in the small sidebar calendar; null = follow the main view
let renderedDay = '';
let suppressClick = 0;
let dragging = false;
let didScroll = false;
const events = new Map(); // key -> calendar event

// ---------------------------------------------------------------- helpers
const acct = id => state.accounts.find(a => a.id === id);
const getTask = id => state.tasks.find(t => t.id === id);
const todayYmd = () => ymd(new Date());
const isPlannerCal = (a, c) => a.id === state.settings.plannerAccountId && c.id === state.settings.plannerCalendarId;
const plannerAccount = () => acct(state.settings.plannerAccountId);
const plannerReady = () => !DEMO && !!state.settings.plannerCalendarId && !!plannerAccount() && !plannerAccount().needsReconnect;
const tagColor = tag => { let h = 0; for (const ch of tag) h = (h * 31 + ch.charCodeAt(0)) % 360; return `hsl(${h} 58% 50%)`; };
const tagStyle = t => t.tag ? `--tc:${tagColor(t.tag)}` : '';
const pri = t => t.priority === 'high' ? '<span class="pri" title="High priority">!</span>' : '';
const relDay = ds => ds === todayYmd() ? 'Today' : ds === ymd(addDays(new Date(), 1)) ? 'Tomorrow' : dayLabel(fromYmd(ds));

function visibleDates() {
  if (view === 'day') return [cursor];
  if (view === 'week') return days(startOfWeek(cursor), 7);
  if (view === 'month') return days(startOfWeek(monthStart(cursor)), 42);
  return days(cursor, 14);
}
function range() { const d = visibleDates(); return [d[0], addDays(d[d.length - 1], 1)]; }

function enabledEvent(ev) {
  const c = acct(ev.accountId)?.calendars.find(c => c.id === ev.calendarId);
  return !!c && c.enabled;
}

let toastTimer, toastGo = null; // toastGo: what the button on the message does, if it has one
function toast(msg, o = {}) {
  if (o === true) o = { err: true };
  (el.dlg.open && !el.dlg.classList.contains('closing') ? el.dlg : document.body).append(el.toast);
  el.toast.innerHTML = `<span>${esc(msg)}</span>${o.undo ? '<button data-act="undo">Undo</button>' : ''}${o.reload ? '<button data-act="reload">Refresh</button>' : ''}${o.go ? `<button data-act="toast-go">${esc(o.go[0])}</button>` : ''}`;
  toastGo = o.go ? o.go[1] : null;
  el.toast.className = 'show' + (o.err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.className = ''; }, o.reload ? 30000 : o.go ? 15000 : o.err || o.undo ? 6000 : 3200);
}
function setStatus(text, isErr) {
  document.body.classList.toggle('loading', /…$/.test(text));
  el.status.textContent = text;
  el.status.className = isErr ? 'err' : '';
}

let dlgOpenedAt = 0, closeTimer = 0;
let noteCommit = null; // saves the notes box of the meeting that is open, if any
let aiJob = null;      // lets a running "Tidy my notes" be stopped when its box goes away
// Starts a piece of AI work, stopping the one before it so nothing is left running unseen.
let keyAt = 0; // when a key was last pressed
addEventListener('keydown', () => { keyAt = Date.now(); }, true);
function newJob() { aiJob?.abort(); return (aiJob = new AbortController()); }
function saveOpenNote() { aiJob?.abort(); aiJob = null; const f = noteCommit; noteCommit = null; if (f) f(); }
function dialog(html, handlers = {}, cls = '') {
  saveOpenNote();
  clearTimeout(closeTimer); // a box that was fading out is taken over by the new one
  const showing = el.toast.classList.contains('show');
  document.body.append(el.toast);
  el.dlg.className = cls;
  if (recBar?.isConnected) document.body.append(recBar);
  el.dlg.innerHTML = html;
  if (showing) el.dlg.append(el.toast); // a message on screen stays in front of the new box
  if (recBar?.isConnected) el.dlg.append(recBar); // so does the bar of a running recording
  dlgOpenedAt = Date.now();
  document.body.classList.remove('side-open'); // on a phone, a box opened from the side panel replaces it
  if (!el.dlg.open) el.dlg.showModal();
  // A box that opens without a key press (by itself, or from a tap) should not draw a keyboard ring
  // round its first link: the box itself takes the focus, and Tab goes on from there.
  const first = document.activeElement;
  if (Date.now() - keyAt > 800 && el.dlg.contains(first) && !first.matches('input, textarea, select, [contenteditable], [autofocus]')) { el.dlg.tabIndex = -1; el.dlg.focus(); }
  el.dlg.onclick = e => {
    if (el.dlg.classList.contains('closing')) return; // fading out: a second click must not run anything twice
    if (e.target === el.dlg) { if (Date.now() - dlgOpenedAt > 250) closeDialog(); return; }
    const onToast = e.target.closest('#toast [data-act]'); // a message shown inside the box, with its button
    if (onToast) return doAct(onToast);
    const x = e.target.closest('[data-x]');
    if (!x) return;
    if (x.dataset.x === 'close') return closeDialog();
    handlers[x.dataset.x]?.(x, e);
  };
  const f = $('form', el.dlg);
  if (f) f.onsubmit = e => { e.preventDefault(); if (!el.dlg.classList.contains('closing')) handlers.submit?.(new FormData(f), f); };
}
// Boxes fade out briefly instead of vanishing.
// A box that shows one thing in full (a meeting, a person, a task, a recording) opens as a panel down
// the right-hand side, so the calendar stays in view behind it. Called right after dialog().
function asPanel() {
  el.dlg.classList.add('panel');
  el.dlg.insertAdjacentHTML('afterbegin', '<button type="button" class="pclose" data-x="close" aria-label="Close" title="Close (Esc)">✕</button>');
}
function closeDialog() {
  if (!el.dlg.open || el.dlg.classList.contains('closing')) return;
  if (calm()) return el.dlg.close();
  el.dlg.classList.add('closing');
  closeTimer = setTimeout(() => { el.dlg.classList.remove('closing'); if (el.dlg.open) el.dlg.close(); }, 130);
}

// Tells you when a newer Weftday has been published while this page was open, so you are never
// left looking at an old version without knowing.
let loadedVersion = '', toldAboutUpdate = false;
async function checkForUpdate() {
  if (toldAboutUpdate) return;
  try {
    const version = (await fetch('sw.js', { cache: 'no-store' }).then(r => r.text())).match(/planner-shell-v\d+/)?.[0];
    if (!version) return;
    if (!loadedVersion) loadedVersion = version;
    else if (version !== loadedVersion && !el.dlg.open) { toldAboutUpdate = true; toast('A newer Weftday is ready.', { reload: true }); }
  } catch { /* offline: try again later */ }
}

// ---------------------------------------------------------------- motion
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// Redraws through a short animated hand-over where the browser supports it. "dir" picks the movement:
// 'next' and 'prev' slide sideways, 'fade' cross-fades.
function smooth(dir, fn) {
  if (!document.startViewTransition || calm() || document.hidden) { fn(); return Promise.resolve(); }
  const root = document.documentElement;
  root.dataset.dir = dir;
  let ran = false;
  const vt = document.startViewTransition(() => { ran = true; fn(); });
  vt.ready.catch(() => {}); // a newer move replaced this one: nothing to report
  vt.finished.catch(() => {}).finally(() => { if (root.dataset.dir === dir) delete root.dataset.dir; });
  setTimeout(() => { if (!ran) vt.skipTransition(); }, 150); // never keep the screen waiting for the animation
  return vt.updateCallbackDone.catch(() => {});
}
// Briefly marks what just changed (ticked, added, moved) so it settles into place instead of jumping.
function flash(id, cls = 'settle') {
  if (calm()) return;
  for (const n of document.querySelectorAll(`[data-id="${CSS.escape(id)}"]`)) {
    n.classList.add(cls);
    n.addEventListener('animationend', () => n.classList.remove(cls), { once: true });
  }
}
const opts = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l)}</option>`).join('');

// ---------------------------------------------------------------- tasks
function newTask(p = {}) {
  return {
    id: uid(), title: '', date: null, start: null, duration: 30, done: false,
    priority: 'normal', tag: '', repeat: 'none', seriesId: null, reminder: null, notes: '',
    gEventId: null, remoteUpdated: null, dirty: true, rev: 1, created: Date.now(), ...p,
  };
}
function touch(t) { t.rev = (t.rev || 0) + 1; t.dirty = true; }
function commit() { save(); render(); scheduleFlush(); }
function removeTask(t) {
  const i = state.tasks.indexOf(t);
  if (i >= 0) state.tasks.splice(i, 1);
  if (t.gEventId) state.tombstones.push(t.gEventId);
}

// One step of undo: remember the tasks before a change, put them back on request.
const UNDO_FIELDS = ['title', 'date', 'start', 'duration', 'done', 'priority', 'tag', 'repeat', 'seriesId', 'reminder', 'notes'];
let undoSnap = null;
function mark() { undoSnap = JSON.stringify(state.tasks); }
function undo() {
  if (!undoSnap) return toast('Nothing to undo');
  const before = JSON.parse(undoSnap);
  undoSnap = null;
  const ids = new Set(before.map(t => t.id));
  for (const cur of [...state.tasks]) if (!ids.has(cur.id)) removeTask(cur);
  for (const old of before) {
    const cur = getTask(old.id);
    if (cur) {
      if (UNDO_FIELDS.some(k => cur[k] !== old[k])) { for (const k of UNDO_FIELDS) cur[k] = old[k]; touch(cur); }
    } else {
      const i = old.gEventId ? state.tombstones.indexOf(old.gEventId) : -1;
      if (i >= 0) state.tombstones.splice(i, 1); else old.gEventId = null; // already deleted in Google: make it again
      old.remoteUpdated = null; old.dirty = true; old.rev = (old.rev || 0) + 1;
      state.tasks.push(old);
    }
  }
  commit();
  toast('Undone');
}

// Repeating tasks are written out as real blocks for the next four weeks.
function seriesDates(t, afterYmd, horizonYmd) {
  const out = [], end = fromYmd(horizonYmd), wd = fromYmd(t.date).getDay();
  for (let d = addDays(fromYmd(afterYmd), 1); d <= end; d = addDays(d, 1)) {
    const g = d.getDay();
    if (repeatsOn(t.repeat, g, wd)) out.push(ymd(d));
  }
  return out;
}
function topUpSeries() {
  const horizon = ymd(addDays(new Date(), 28));
  const last = new Map();
  for (const t of state.tasks) {
    if (!t.seriesId || !t.date) continue;
    const cur = last.get(t.seriesId);
    if (!cur || t.date > cur.date) last.set(t.seriesId, t);
  }
  let added = 0;
  const until = (state.seriesUntil ||= {}), yesterday = ymd(addDays(new Date(), -1));
  for (const t of last.values()) {
    if (!t.repeat || t.repeat === 'none') continue;
    // Start after the last day already written out, so a day you deleted does not come back, and
    // never before today, so a repeat set on an old task does not fill the past.
    const after = [t.date, until[t.seriesId] || '', yesterday].sort().pop();
    until[t.seriesId] = horizon;
    for (const ds of seriesDates(t, after, horizon)) {
      const id = `${t.seriesId}x${ds.replace(/-/g, '')}`;
      if (getTask(id)) continue;
      state.tasks.push(newTask({
        id, title: t.title, date: ds, start: t.start, duration: t.duration, priority: t.priority,
        tag: t.tag, repeat: t.repeat, seriesId: t.seriesId, reminder: t.reminder, notes: t.notes,
      }));
      added++;
    }
  }
  return added;
}
function endSeries(seriesId, fromDate, keep) {
  for (const s of state.tasks.filter(s => s.seriesId === seriesId && s !== keep)) {
    if (s.date && s.date > fromDate) removeTask(s);
    else if (s.repeat !== 'none') { s.repeat = 'none'; touch(s); }
  }
}

// Everything on each of the given (consecutive) days: calendar events plus tasks.
// Minutes after midnight on the clock, which is what counts on a day when the clocks change.
const clockMinutes = ms => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };
function collect(dates) {
  const out = new Map(dates.map(d => [ymd(d), { timed: [], allday: [] }]));
  const bounds = dates.map(d => [ymd(d), d.getTime(), addDays(d, 1).getTime()]);
  const first = bounds[0][1], last = bounds[bounds.length - 1][2];
  for (const ev of events.values()) {
    if (ev.e <= first || ev.s >= last || !enabledEvent(ev)) continue;
    for (const [ds, t0, t1] of bounds) {
      if (ev.e <= t0 || ev.s >= t1) continue;
      const b = out.get(ds);
      if (ev.allDay) b.allday.push({ kind: 'ev', ev });
      else b.timed.push({ kind: 'ev', ev, s: ev.s <= t0 ? 0 : clockMinutes(ev.s), e: ev.e >= t1 ? 1440 : clockMinutes(ev.e) });
    }
  }
  for (const t of state.tasks) {
    const b = t.date && out.get(t.date);
    if (!b) continue;
    if (t.start == null) b.allday.push({ kind: 'task', t });
    else b.timed.push({ kind: 'task', t, s: t.start, e: Math.min(1440, t.start + t.duration) });
  }
  return out;
}
const dayItems = d => collect([d]).get(ymd(d));
const busyOf = (d, except) => dayItems(d).timed
  .filter(i => !(i.kind === 'task' && (i.t.done || i.t === except)) && !(i.kind === 'ev' && i.ev.selfStatus === 'declined'))
  .map(i => [i.s, i.e]).sort((a, b) => a[0] - b[0]);
const nowMinutes = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };

// First gap that fits. "strict" keeps inside working hours and returns null when the day is full.
function nextFreeSlot(d, duration, strict, except) { // except: a task whose own slot counts as free
  const { dayStart, dayEnd } = state.settings;
  const isToday = ymd(d) === todayYmd();
  const first = isToday ? Math.max(Math.ceil((nowMinutes() + 1) / SNAP) * SNAP, dayStart) : dayStart;
  const limit = strict ? dayEnd : 1440;
  let s = first;
  for (const [bs, be] of busyOf(d, except)) {
    if (be <= s) continue;
    if (bs >= s + duration) break;
    s = Math.ceil(be / SNAP) * SNAP;
  }
  if (s + duration <= limit) return s;
  return strict ? null : clamp(first, 0, 1440 - duration);
}
function freeMinutes(d) {
  const { dayStart, dayEnd } = state.settings;
  let p = ymd(d) === todayYmd() ? Math.max(dayStart, nowMinutes()) : dayStart, free = 0;
  for (const [s, e] of busyOf(d)) {
    if (e <= p) continue;
    if (s >= dayEnd) break;
    if (s > p) free += s - p;
    p = Math.max(p, e);
  }
  return free + Math.max(0, dayEnd - p);
}

function quickHint() {
  const v = $('#quickInput').value;
  $('#quickPh').hidden = !!v;
  const p = v.trim() ? parseQuick(v) : null;
  if (!p || !p.title) { el.hint.hidden = true; return; }
  if (wantsAi(p)) { // too much for the simple reader: Enter hands it to your AI
    el.hint.innerHTML = '<kbd>↵</kbd><span class="qchip">✨ AI will work this out</span>';
    el.hint.hidden = false;
    return;
  }
  // what was understood, as small labels
  const chip = (text, kind = '') => `<span class="qchip ${kind}">${esc(text)}</span>`;
  const bits = [p.date ? chip(relDay(p.date)) : chip('Inbox', 'plain')];
  if (p.start != null) bits.push(chip(fmtTime(p.start)));
  if (p.duration) bits.push(chip(fmtDur(p.duration)));
  if (p.repeat) bits.push(chip(repeatLabel(p.repeat)));
  if (p.tag) bits.push(chip('#' + p.tag, 'plain'));
  if (p.priority === 'high') bits.push(chip('high priority', 'hot'));
  el.hint.innerHTML = `<kbd>↵</kbd>${bits.join('')}${v.trim().split(/\s+/).length >= 6 ? '<span class="qchip ai">✨ ⇧↵ several at once</span>' : ''}`;
  el.hint.hidden = false;
}

// Words the simple reader leaves behind that still talk about when: a sign the sentence needs AI.
const AI_CUES = new RegExp([
  '\\bexpect\\s+(mon|tue|wed|thu|fri|sat|sun|week)', '\\b(except|excluding|but not|every|each|until|till|alternate|twice|thrice|then|morning|afternoon|evening|tonight|night|noon|lunch|weekends?|monthly|fortnight|weekly|daily)\\b',
  '\\bat\\s+\\d', '\\bin\\s+(\\d+|a|an|two|three|few)\\s+(hours?|hrs?|minutes?|mins?|days?|weeks?|months?)\\b', '\\b\\d{3,4}\\b',
  '\\b(and|or)\\s+(mon|tue|wed|thu|fri|sat|sun)', ',',
].join('|'), 'i');
// Whether your AI can be asked: a key for a service that can do it, or the browser's own AI.
function planReady() {
  const s = state.settings, svc = S.aiService(s.aiProvider);
  if (DEMO || s.aiQuick === false) return false;
  return !!(s.claudeKey && svc.kind === 'claude') || ((svc.kind === 'google' || (svc.kind === 'chat' && svc.base)) && !!factsKey()) || !!s.aiKey || AI.supported();
}
const wantsAi = p => planReady() && AI_CUES.test(p.title);

function quickAdd() {
  const input = $('#quickInput');
  const p = parseQuick(input.value);
  if (!p.title) return;
  if (wantsAi(p)) return quickPlan(true);
  quickAddPlain(p);
}
function quickAddPlain(p) {
  const input = $('#quickInput');
  mark();
  const t = newTask({ title: p.title, date: p.date, start: p.start, duration: p.duration || 30, tag: p.tag, priority: p.priority });
  if (p.repeat) { t.repeat = p.repeat; t.seriesId = uid(); }
  state.tasks.push(t);
  topUpSeries();
  input.value = '';
  quickHint();
  commit();
  flash(t.id, 'born');
  toast(addedLine(t), { undo: true });
}
// What is said after a task is added: where it went.
const addedLine = t => (!t.date ? 'Task added to your inbox. Drag it onto a day when you know when.'
  : `Task added to your calendar: ${relDay(t.date)}${t.start != null ? `, ${fmtTime(t.start)}` : ''}${t.repeat && t.repeat !== 'none' ? `, ${repeatLabel(t.repeat)}` : ''}`);

function scheduleToday(t) {
  mark();
  const today = startOfDay(new Date());
  const hadTime = t.start != null || !t.date;
  t.date = ymd(today);
  t.start = null;
  if (hadTime) t.start = nextFreeSlot(today, t.duration);
  touch(t);
  commit();
  flash(t.id);
  toast(t.start != null ? `Scheduled today at ${fmtTime(t.start)}` : 'Moved to today', { undo: true });
}

function toggleDone(t) {
  mark();
  t.done = !t.done;
  if (t.done && !t.date) { t.date = todayYmd(); t.start = null; toast('Done. Logged on today.', { undo: true }); }
  touch(t);
  commit();
  flash(t.id, 'tick');
}

// ---------------------------------------------------------------- render
function render() {
  renderedDay = todayYmd();
  renderBar();
  renderSide();
  renderView();
}

function renderBar() {
  const dates = visibleDates();
  document.body.dataset.view = view; // lets the styles tell the views apart (a week on a phone is drawn tighter)
  document.body.classList.toggle('innotes', view === 'notes');
  document.body.classList.toggle('inhome', view === 'home');
  if (view === 'notes') el.title.textContent = 'Notes';
  else if (view === 'home') el.title.textContent = dayLabel(new Date(), true);
  else if (view === 'day') el.title.textContent = dayLabel(cursor, true);
  else if (view === 'month') el.title.textContent = cursor.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  else {
    const a = dates[0], b = dates[dates.length - 1];
    const month = d => d.toLocaleDateString('en-GB', { month: 'short' });
    el.title.textContent = a.getMonth() === b.getMonth()
      ? `${a.getDate()} – ${b.getDate()} ${month(b)} ${b.getFullYear()}`
      : `${a.getDate()} ${month(a)} – ${b.getDate()} ${month(b)} ${b.getFullYear()}`;
  }
  for (const b of document.querySelectorAll('#viewSeg button')) b.classList.toggle('on', b.dataset.view === view);
  for (const b of document.querySelectorAll('#mainNav button')) b.classList.toggle('on', b.dataset.nav === (view === 'notes' || view === 'home' ? view : 'calendar'));
  $('#demoTag').hidden = !DEMO;
  const z2 = state.settings.zone2 && state.settings.zone2 !== TZ ? state.settings.zone2 : '', zb = $('#zoneBtn');
  zb.classList.toggle('on', !!z2);
  zb.querySelector('span').textContent = z2 ? zoneShort(z2) : '';
  zb.title = z2 ? `Second time zone: ${zoneLabel(z2)}. Press to change it or switch it off.` : 'Show a second time zone next to your own';
}

function renderView() {
  const timeGrid = view === 'day' || view === 'week';
  el.grid.hidden = !timeGrid;
  el.month.hidden = view !== 'month';
  el.list.hidden = view !== 'list';
  el.notes.hidden = view !== 'notes';
  el.home.hidden = view !== 'home';
  if (timeGrid) renderGrid(); else if (view === 'month') renderMonth(); else if (view === 'notes') renderNotes(); else if (view === 'home') renderHome(); else renderList();
}

function itemHtml(t, meta) {
  return `<div class="item" data-id="${esc(t.id)}" style="${tagStyle(t)}">
    <button class="chk" data-act="toggle" aria-label="Mark done"></button>
    <div class="it"><div class="t">${pri(t)}${esc(t.title)}</div><div class="m">${meta}</div></div>
    <button class="mini" data-act="today" title="Put this on today's schedule">→ Today</button>
  </div>`;
}

function todayCardHtml() {
  const d = startOfDay(new Date()), ds = ymd(d);
  const mine = state.tasks.filter(t => t.date === ds), done = mine.filter(t => t.done).length;
  const taskMin = mine.filter(t => t.start != null).reduce((n, t) => n + t.duration, 0);
  const meets = dayItems(d).timed.filter(i => i.kind === 'ev' && i.ev.selfStatus !== 'declined');
  const meetMin = meets.reduce((n, i) => n + i.e - i.s, 0);
  return `<div class="card">
    <div class="ch"><b>Today</b><span>${dayLabel(d)}</span></div>
    <div class="prog"><i style="width:${mine.length ? Math.round(done / mine.length * 100) : 0}%"></i></div>
    <div class="cm">${mine.length ? `<b>${done} of ${mine.length}</b> tasks done` : 'No tasks planned yet'}</div>
    <div class="cm">${fmtDur(taskMin)} of tasks · ${meets.length} meeting${meets.length === 1 ? '' : 's'}${meetMin ? ` (${fmtDur(meetMin)})` : ''}</div>
    <button class="btn" data-act="plan">Plan my day</button>
    <div class="cardlinks"><button type="button" data-act="open-today" title="Each of today’s meetings: who is in it, last time, what is open">Prepare for meetings</button><button type="button" data-act="free" title="Times you are free, to send to someone">Free times</button></div>
  </div>`;
}

function upNextHtml() {
  const nowM = nowMinutes();
  const items = dayItems(startOfDay(new Date())).timed
    .filter(i => i.kind === 'task' ? !i.t.done : i.ev.selfStatus !== 'declined').sort((a, b) => a.s - b.s);
  const row = (label, i, when) => {
    const attr = i.kind === 'task' ? `class="un task" data-id="${esc(i.t.id)}"` : `class="un" data-key="${esc(i.ev.key)}"`;
    const join = i.kind === 'ev' && i.ev.meet ? `<a class="mini join" href="${esc(i.ev.meet)}" target="_blank" rel="noopener">Join</a>` : '';
    return `<div ${attr}><span class="ul${label === 'Now' ? ' now' : ''}">${label}</span>
      <div class="ut"><div class="t">${esc(i.kind === 'task' ? i.t.title : i.ev.title)}</div><div class="m">${when}</div></div>${join}</div>`;
  };
  let h = '';
  for (const i of items.filter(i => i.s <= nowM && i.e > nowM).slice(0, 2)) h += row('Now', i, `until ${fmtTime(i.e)}`);
  const next = items.find(i => i.s > nowM);
  if (next) h += row('Next', next, next.s - nowM < 60 ? `in ${next.s - nowM} min · ${fmtTime(next.s)}` : `at ${fmtTime(next.s)}`);
  return h || '<div class="un none">Nothing else scheduled today.</div>';
}
function renderUpNext() { const u = $('#upnext'); if (u) u.innerHTML = upNextHtml(); }

function miniHtml() {
  const m = miniMonth || monthStart(cursor), today = todayYmd();
  const [vf, vt] = view === 'month' ? [0, 0] : range().map(d => ymd(d));
  const has = new Set(state.tasks.filter(t => t.date && !t.done).map(t => t.date));
  let cells = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(w => `<span class="wd">${w}</span>`).join('');
  for (const d of days(startOfWeek(m), 42)) {
    const ds = ymd(d);
    const cls = (d.getMonth() !== m.getMonth() ? ' other' : '') + (ds === today ? ' today' : '') + (vf && ds >= vf && ds < vt ? ' sel' : '') + (has.has(ds) ? ' has' : '');
    cells += `<button class="md${cls}" data-act="goto" data-date="${ds}">${d.getDate()}</button>`;
  }
  return `<div class="sec minibox"><h4><span>${m.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</span>
    <span class="mnav"><button class="mini" data-act="mini-prev" aria-label="Previous month">‹</button><button class="mini" data-act="mini-next" aria-label="Next month">›</button></span></h4>
    <div class="mc">${cells}</div></div>`;
}

const openAccts = new Set(); // the accounts whose calendars are unfolded in the sidebar
function renderSide() {
  const today = todayYmd();
  const carried = state.tasks.filter(t => t.date && t.date < today && !t.done).sort((a, b) => a.date.localeCompare(b.date));
  const inbox = state.tasks.filter(t => !t.date && !t.done).sort((a, b) => (b.priority === 'high') - (a.priority === 'high') || b.created - a.created);
  const tagOf = t => t.tag ? ` · #${esc(t.tag)}` : '';
  let h = todayCardHtml()
    + `<div id="upnext">${upNextHtml()}</div>`;
  if (carried.length) {
    h += `<div class="sec"><h4><span>Carried over</span><span>${carried.length}</span></h4>${carried.map(t =>
      itemHtml(t, `from ${dayLabel(fromYmd(t.date))}${t.start != null ? ' · ' + fmtDur(t.duration) : ''}${tagOf(t)}`)).join('')}</div>`;
  }
  h += `<div class="sec"><h4><span>Inbox</span><span>${inbox.length || ''}</span></h4>${inbox.length
    ? inbox.map(t => itemHtml(t, `${fmtDur(t.duration)}${tagOf(t)}`)).join('')
    : '<div class="empty">Nothing waiting. Type above to add a task, or drag one onto the calendar.</div>'}</div>`;
  h += miniHtml();

  h += `<div class="sec"><h4><span>Calendars</span></h4>`;
  if (!state.accounts.length) h += '<div class="empty">No accounts connected yet.</div>';
  for (const a of state.accounts) {
    const cals = a.calendars.filter(c => !isPlannerCal(a, c)), shown = cals.filter(c => c.enabled).length;
    h += `<details class="acctbox" data-acct="${esc(a.id)}"${openAccts.has(a.id) ? ' open' : ''}>
      <summary class="acct"><button class="dot" data-act="acct-color" title="Change colour" style="background:${hue(a.color)}"></button><span class="em" title="${esc(a.email)}">${esc(a.email)}</span>${
      a.needsReconnect ? '<button class="mini warn" data-act="reconnect">Reconnect</button>' : `<span class="acount">${shown === cals.length ? '' : `${shown} of ${cals.length}`}</span>`}</summary>
      ${cals.map(c => `<label class="cal"><input type="checkbox" style="accent-color:${hue(a.color)}" data-cal="${esc(a.id)}|${esc(c.id)}"${c.enabled ? ' checked' : ''}><span>${esc(c.summary)}</span></label>`).join('')}
      <button class="mini acctrm" data-act="rm-acct">Remove this account</button></details>`;
  }
  h += '</div>';
  document.body.classList.toggle('has-accts', state.accounts.length > 0);
  el.side.innerHTML = h;
}

function layout(items) {
  items.sort((a, b) => a.s - b.s || b.e - a.e);
  let cluster = [], clusterEnd = -1;
  const flushCluster = () => {
    const ends = [];
    for (const it of cluster) {
      let c = ends.findIndex(end => end <= it.s);
      if (c < 0) { c = ends.length; ends.push(0); }
      ends[c] = it.ve;
      it.col = c;
    }
    for (const it of cluster) {
      it.cols = ends.length;
      // a block takes the room to its right that nothing else is using, rather than staying a sliver
      it.span = 1;
      for (let c = it.col + 1; c < it.cols && !cluster.some(o => o.col === c && o.s < it.ve && o.ve > it.s); c++) it.span++;
    }
    cluster = [];
  };
  for (const it of items) {
    it.ve = Math.max(it.e, it.s + 22);
    if (cluster.length && it.s >= clusterEnd) { flushCluster(); clusterEnd = -1; }
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.ve);
  }
  if (cluster.length) flushCluster();
}

const evClass = ev => ev.selfStatus === 'needsAction' ? ' pending' : ev.selfStatus === 'declined' ? ' declined' : '';
const evColor = ev => hue(acct(ev.accountId)?.color);

function blockHtml(it) {
  const h = Math.max((it.e - it.s) * PXM, 20);
  // how many lines of words fit: a long title runs on to the next line instead of being cut to "Wr…"
  const lines = Math.max(1, Math.floor((h - 5) / 16));
  const style = `top:${it.s * PXM}px;height:${h - 1}px;left:calc(${it.col / it.cols * 100}% + 1px);width:calc(${(it.span || 1) / it.cols * 100}% - 3px);--l:${lines};`;
  const sm = h < 34 ? ' sm' : ' ml';
  if (it.kind === 'task') {
    const t = it.t;
    return `<div class="blk task${t.done ? ' done' : ''}${sm}" data-id="${esc(t.id)}" style="${style}${tagStyle(t)}">
      <button class="chk" data-act="toggle" aria-label="Mark done"></button>
      <div class="bt"><div class="t">${pri(t)}${esc(t.title)}</div><div class="m">${fmtRange(it.s, it.e)}${t.tag ? ' · #' + esc(t.tag) : ''}</div></div>
      <div class="rs"></div></div>`;
  }
  const ev = it.ev;
  return `<div class="blk ev${evClass(ev)}${N.has(noteKey(ev)) ? ' noted' : ''}${sm}" data-key="${esc(ev.key)}" style="${style}--c:${evColor(ev)}">
    <div class="bt"><div class="t">${esc(ev.title)}</div><div class="m">${fmtRange(it.s, it.e)}${ev.location ? ' · ' + esc(ev.location) : ''}</div></div></div>`;
}

function chipHtml(it) {
  const tm = it.s != null ? `<i>${fmtTime(it.s)}</i> ` : '';
  if (it.kind === 'task') {
    return `<div class="chip task${it.t.done ? ' done' : ''}" data-id="${esc(it.t.id)}"><button class="chk" data-act="toggle" aria-label="Mark done"></button><span>${tm}${esc(it.t.title)}</span></div>`;
  }
  return `<div class="chip ev${it.ev.selfStatus === 'declined' ? ' declined' : ''}" data-key="${esc(it.ev.key)}" style="--c:${evColor(it.ev)}"><span>${tm}${esc(it.ev.title)}</span></div>`;
}

function renderGrid() {
  const dates = visibleDates(), today = todayYmd(), by = collect(dates);
  el.grid.style.setProperty('--n', dates.length);
  el.grid.style.setProperty('--ws', `${state.settings.dayStart * PXM}px`);
  el.grid.style.setProperty('--we', `${state.settings.dayEnd * PXM}px`);
  // With a second time zone chosen, its hours stand under your own down the side.
  const z2 = state.settings.zone2 && state.settings.zone2 !== TZ ? state.settings.zone2 : '';
  const ref = dates.find(d => ymd(d) === today) || dates[0];
  const other = h => { try { return fmtTime(zoneParts(new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), h).getTime(), z2).mins); } catch { return ''; } };
  el.grid.classList.toggle('twozones', !!z2);
  let head = z2 ? `<div class="zcorner"><b>${esc(zoneShort(TZ))}</b><i>${esc(zoneShort(z2))}</i></div>` : '<div></div>';
  let body = `<div class="gutter">${Array.from({ length: 23 }, (_, i) => `<span style="top:${(i + 1) * HOUR}px">${fmtTime((i + 1) * 60)}${z2 ? `<i>${other(i + 1)}</i>` : ''}</span>`).join('')}</div>`;
  for (const d of dates) {
    const ds = ymd(d), { timed, allday } = by.get(ds), wk = d.getDay() === 0 || d.getDay() === 6;
    head += `<div class="dh${ds === today ? ' today' : ''}" data-date="${ds}">
      <div class="dn"><span>${d.toLocaleDateString('en-GB', { weekday: 'short' })}</span><b>${d.getDate()}</b></div>
      <div class="allday">${allday.map(chipHtml).join('')}</div></div>`;
    layout(timed);
    body += `<div class="col${ds === today ? ' today' : ''}${wk ? ' wk' : ''}" data-date="${ds}">${timed.map(blockHtml).join('')}</div>`;
  }
  el.head.innerHTML = head;
  el.body.innerHTML = body;
  updateNowLine();
  if (!didScroll) { didScroll = true; scrollToNow(); }
}

function renderMonth() {
  const dates = visibleDates(), today = todayYmd(), by = collect(dates), m = cursor.getMonth();
  const cellH = (el.month.clientHeight - 30) / 6;
  const max = Math.max(1, Math.floor((cellH - 30) / 22));
  let h = '';
  for (const d of dates) {
    const ds = ymd(d), { timed, allday } = by.get(ds);
    timed.sort((a, b) => a.s - b.s);
    const items = [...allday.filter(i => i.kind === 'ev'), ...timed, ...allday.filter(i => i.kind === 'task')];
    const show = items.length > max ? items.slice(0, max - 1) : items;
    const num = d.getDate() === 1 ? `1 ${d.toLocaleDateString('en-GB', { month: 'short' })}` : d.getDate();
    h += `<div class="mcell${d.getMonth() !== m ? ' other' : ''}${ds === today ? ' today' : ''}" data-date="${ds}">
      <div class="mnum">${num}</div>${show.map(chipHtml).join('')}${items.length > show.length ? `<div class="more">+${items.length - show.length} more</div>` : ''}</div>`;
  }
  el.month.innerHTML = `<div class="mhead">${dates.slice(0, 7).map(d => `<span>${d.toLocaleDateString('en-GB', { weekday: 'short' })}</span>`).join('')}</div><div class="mgrid">${h}</div>`;
}

function listRow(it, when) {
  if (it.kind === 'task') {
    const t = it.t;
    return `<div class="lrow task${t.done ? ' done' : ''}" data-id="${esc(t.id)}"><span class="ltime">${when}</span>
      <button class="chk" data-act="toggle" aria-label="Mark done"></button>
      <div class="lt"><div class="t">${pri(t)}${esc(t.title)}</div>${t.tag ? `<div class="m">#${esc(t.tag)}</div>` : ''}</div></div>`;
  }
  const ev = it.ev, a = acct(ev.accountId);
  return `<div class="lrow ev${ev.selfStatus === 'declined' ? ' declined' : ''}" data-key="${esc(ev.key)}" style="--c:${evColor(ev)}"><span class="ltime">${when}</span>
    <span class="lbar"></span>
    <div class="lt"><div class="t">${esc(ev.title)}</div><div class="m">${esc(a?.email || '')}${ev.location ? ' · ' + esc(ev.location) : ''}${ev.selfStatus === 'needsAction' ? ' · needs your reply' : ''}</div></div></div>`;
}

function renderList() {
  const dates = visibleDates(), today = todayYmd(), by = collect(dates);
  let h = '';
  for (const d of dates) {
    const ds = ymd(d), { timed, allday } = by.get(ds);
    if (!timed.length && !allday.length && ds !== today) continue;
    timed.sort((a, b) => a.s - b.s);
    const rows = [...allday.map(i => listRow(i, i.kind === 'task' ? 'Any time' : 'All day')), ...timed.map(i => listRow(i, fmtRange(i.s, i.e)))];
    h += `<section class="lday" data-date="${ds}"><div class="lh"><span>${dayLabel(d, true)}</span>${ds === today ? '<span class="pill">Today</span>' : ''}</div>
      ${rows.join('') || '<div class="lnone">Nothing planned.</div>'}</section>`;
  }
  el.list.innerHTML = `<div class="lwrap">${h || '<div class="lnone">Nothing planned in these two weeks.</div>'}</div>`;
}

function updateNowLine() {
  el.body.querySelector('.nowline')?.remove();
  const col = el.body.querySelector(`.col[data-date="${todayYmd()}"]`);
  if (!col) return;
  const line = document.createElement('div');
  line.className = 'nowline';
  line.style.top = `${nowMinutes() * PXM}px`;
  col.append(line);
}
function scrollToNow(gently) {
  el.grid.scrollTo({ top: Math.max(0, (nowMinutes() - 120) * PXM), behavior: gently && !calm() ? 'smooth' : 'auto' });
}

// ---------------------------------------------------------------- navigation
function setView(v) { view = v; if (VIEWS.includes(v)) { state.settings.view = v; save(); } nav(); }
function nav(dir = 'fade') { smooth(dir, render).then(() => refresh()); }
function step(n) {
  if (view === 'notes' || view === 'home') return;
  cursor = view === 'month' ? new Date(cursor.getFullYear(), cursor.getMonth() + n, 1) : addDays(cursor, n * (view === 'day' ? 1 : 7));
  miniMonth = null;
  nav(n > 0 ? 'next' : 'prev');
}
function goTo(d, v) {
  const before = range()[0].getTime();
  cursor = startOfDay(d);
  miniMonth = null;
  if (v && v !== view) return setView(v);
  if (view === 'home' || view === 'notes') return setView(calendarView()); // a day was picked: show it on the calendar
  const after = range()[0].getTime();
  nav(after > before ? 'next' : after < before ? 'prev' : 'fade');
}
function goToday() { goTo(new Date()); if (!el.grid.hidden) scrollToNow(true); }

// ---------------------------------------------------------------- interactions
function colAt(x, y) {
  const g = el.grid.getBoundingClientRect();
  if (el.grid.hidden) return null;
  if (y != null && (y < g.top + el.head.offsetHeight || y > g.bottom)) return null;
  for (const col of el.body.querySelectorAll('.col')) {
    const r = col.getBoundingClientRect();
    if (x >= r.left && x < r.right) return col;
  }
  return null;
}

function onClick(e) {
  if (Date.now() < suppressClick) return;
  if (e.target.closest('dialog') || e.target.closest('a')) return;
  if (document.body.classList.contains('side-open') && !e.target.closest('#side')) {
    document.body.classList.remove('side-open');
    return;
  }
  const act = e.target.closest('[data-act]');
  if (act) return doAct(act);
  const evEl = e.target.closest('[data-key]');
  if (evEl) { const ev = events.get(evEl.dataset.key); if (ev) openEvent(ev); return; }
  const taskEl = e.target.closest('.blk.task, .item, .chip.task, .lrow.task, .un.task, .hrow.task');
  if (taskEl) { const t = getTask(taskEl.dataset.id); if (t) openTask(t); return; }
  const col = e.target.closest('.col');
  if (col) {
    const r = col.getBoundingClientRect();
    const m = clamp(Math.floor((e.clientY - r.top) / PXM / 30) * 30, 0, 1410);
    return openTask(newTask({ date: col.dataset.date, start: m }), true);
  }
  const cell = e.target.closest('.mcell');
  if (cell) {
    if (e.target.closest('.mnum, .more')) return goTo(fromYmd(cell.dataset.date), 'day');
    return openTask(newTask({ date: cell.dataset.date }), true);
  }
  const lh = e.target.closest('.lh');
  if (lh) return goTo(fromYmd(lh.parentElement.dataset.date), 'day');
  const dn = e.target.closest('.dn');
  if (dn && view === 'week') goTo(fromYmd(dn.parentElement.dataset.date), 'day');
}

function doAct(btn) {
  const act = btn.dataset.act;
  if (act === 'undo') return undo();
  if (act === 'reload') return location.reload();
  if (act === 'plan') return openPlan();
  if (act.startsWith('home-')) { // the buttons on the Home screen
    const ev = events.get(btn.dataset.ev);
    if (act === 'home-record' && ev) return quickRecord(ev);
    if (act === 'home-brief' && ev) return openBrief(ev);
    if (act === 'home-notes') return setView('notes');
    if (act === 'home-note') { noteOpen = btn.dataset.note; return setView('notes'); }
    if (act === 'home-calendar') return setView(calendarView());
    if (act === 'home-connect') return $('#connect').click();
    return;
  }
  if (act === 'open-today') return openToday(); // not 'today': that one is "do this task today" on a task
  if (act === 'people') return openPeople();
  if (act === 'recordings') return openRecordings();
  if (act === 'free') return openFreeTimes();
  if (act === 'record') return R.current() ? toast('A recording is running. Use the bar at the bottom to stop it.') : openRecordSetup(null);
  if (act === 'toast-go') { el.toast.className = ''; return toastGo?.(); }
  if (act === 'mini-prev' || act === 'mini-next') {
    const m = miniMonth || monthStart(cursor);
    miniMonth = new Date(m.getFullYear(), m.getMonth() + (act === 'mini-next' ? 1 : -1), 1);
    return renderSide();
  }
  if (act === 'goto') { document.body.classList.remove('side-open'); return goTo(fromYmd(btn.dataset.date)); }
  const t = getTask(btn.closest('[data-id]')?.dataset.id);
  if (act === 'toggle' && t) return toggleDone(t);
  if (act === 'today' && t) return scheduleToday(t);
  const a = acct(btn.closest('[data-acct]')?.dataset.acct);
  if (act === 'acct-color' && a) {
    a.color = G.COLORS[(G.COLORS.indexOf(a.color) + 1) % G.COLORS.length];
    save(); render();
    return;
  }
  if (act === 'reconnect' && a) return G.startConnect(a.email).catch(err => toast(err.message, true));
  if (act === 'rm-acct' && a) {
    const everywhere = V.sharingReady() && a.id !== state.settings.plannerAccountId;
    if (!confirm(`Remove ${a.email} from this app${everywhere ? ' on all your devices' : ''}?\n\nNothing is deleted from Google. The app just stops showing this account.`)) return;
    if (everywhere) V.forgetAccount(a.id);
    if (everywhere || !V.sharingReady()) G.revoke(a.refreshToken); // nothing of yours uses this sign-in any more: end it at Google too
    state.accounts.splice(state.accounts.indexOf(a), 1);
    if (state.settings.plannerAccountId === a.id) { // the home account: this device simply leaves
      Object.assign(state.settings, { plannerAccountId: '', plannerCalendarId: '', shareAccounts: false });
      state.sharedSeen = false;
    }
    for (const [k, ev] of events) if (ev.accountId === a.id) events.delete(k);
    save(); render();
    if (everywhere) shareSync();
  }
}

// Drag a task block to move it, or drag its bottom edge to change its length.
// Drag across empty space to draw a new task.
function onGridPointerDown(e) {
  if (e.button > 0 || e.target.closest('[data-act]')) return;
  const any = e.target.closest('.blk');
  if (!any) { if (e.pointerType !== 'touch') startCreateDrag(e); return; }
  const blk = any.classList.contains('task') ? any : null;
  const t = blk && getTask(blk.dataset.id);
  if (!t) return;
  const mode = e.target.classList.contains('rs') ? 'resize' : 'move';
  const sx = e.clientX, sy = e.clientY;
  const orig = { date: t.date, start: t.start, duration: t.duration }, cur = { ...orig };
  const label = blk.querySelector('.m');
  let armed = e.pointerType !== 'touch', moved = false;
  const hold = armed ? 0 : setTimeout(() => { armed = true; dragging = true; blk.classList.add('drag'); }, 350);

  function move(ev) {
    const dx = ev.clientX - sx, dy = ev.clientY - sy;
    if (!armed) { if (Math.hypot(dx, dy) > 8) end(); return; }
    if (!moved) {
      if (Math.hypot(dx, dy) < 4) return;
      moved = true; dragging = true;
      blk.classList.add('drag');
      blk.style.left = '1px'; blk.style.width = 'calc(100% - 3px)';
    }
    const dm = Math.round(dy / PXM / SNAP) * SNAP;
    if (mode === 'resize') cur.duration = clamp(orig.duration + dm, SNAP, 1440 - orig.start);
    else {
      cur.start = clamp(orig.start + dm, 0, 1440 - orig.duration);
      const col = colAt(ev.clientX, null);
      if (col && col.dataset.date !== cur.date) { cur.date = col.dataset.date; col.append(blk); }
    }
    blk.style.top = `${cur.start * PXM}px`;
    blk.style.height = `${Math.max(cur.duration * PXM, 20) - 1}px`;
    if (label) label.textContent = fmtRange(cur.start, cur.start + cur.duration);
  }
  function end() {
    clearTimeout(hold);
    removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', cancel);
    dragging = false;
    blk.classList.remove('drag');
  }
  function up() {
    end();
    if (!moved) return;
    suppressClick = Date.now() + 350;
    mark();
    Object.assign(t, cur); touch(t); commit();
    flash(t.id);
    toast(mode === 'resize' ? `Now ${fmtDur(t.duration)}` : `Moved to ${relDay(t.date)}, ${fmtTime(t.start)}`, { undo: true });
  }
  function cancel() { end(); if (moved) render(); }
  addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', cancel);
  if (armed) e.preventDefault();
}

function startCreateDrag(e) {
  const col = e.target.closest('.col');
  if (!col) return;
  const top = col.getBoundingClientRect().top, sy = e.clientY;
  const anchor = clamp(Math.floor((sy - top) / PXM / SNAP) * SNAP, 0, 1440 - SNAP);
  let box = null, s = anchor, en = anchor + 30;
  function move(ev) {
    if (!box) {
      if (Math.abs(ev.clientY - sy) < 6) return;
      box = document.createElement('div');
      box.className = 'blk task drop';
      col.append(box);
      dragging = true;
    }
    const b = clamp(Math.round((ev.clientY - top) / PXM / SNAP) * SNAP, 0, 1440);
    if (b > anchor) { s = anchor; en = Math.max(b, anchor + SNAP); } else { s = b; en = anchor + SNAP; }
    box.style.cssText = `top:${s * PXM}px;height:${(en - s) * PXM - 1}px;left:1px;width:calc(100% - 3px)`;
    box.innerHTML = `<div class="bt"><div class="t">New task</div><div class="m">${fmtRange(s, en)}</div></div>`;
  }
  function up(ev) {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
    if (!box) return;
    box.remove();
    dragging = false;
    suppressClick = Date.now() + 350;
    if (ev?.type === 'pointercancel') return; // the drag was interrupted: nothing is made
    openTask(newTask({ date: col.dataset.date, start: s, duration: en - s }), true);
  }
  addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
}

// Drag a task from the sidebar onto the calendar to give it a time (or a day, in month view).
function onSidePointerDown(e) {
  if (e.button > 0 || e.pointerType === 'touch' || e.target.closest('[data-act], input, label, a')) return;
  const item = e.target.closest('.item');
  const t = item && getTask(item.dataset.id);
  if (!t) return;
  const sx = e.clientX, sy = e.clientY;
  let ghost = null, drop = null, target = null, over = null;

  function move(ev) {
    if (!ghost) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      ghost = document.createElement('div');
      ghost.className = 'dragghost'; ghost.textContent = t.title;
      document.body.append(ghost);
      dragging = true;
    }
    ghost.style.transform = `translate(${ev.clientX + 10}px, ${ev.clientY + 8}px)`;
    drop?.remove(); drop = null; target = null;
    over?.classList.remove('dropover'); over = null;
    if (view === 'month') {
      over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.mcell') || null;
      if (over) { over.classList.add('dropover'); target = { date: over.dataset.date, start: t.start }; }
      return;
    }
    const col = colAt(ev.clientX, ev.clientY);
    if (!col) return;
    const r = col.getBoundingClientRect();
    const m = clamp(Math.round((ev.clientY - r.top) / PXM / SNAP) * SNAP, 0, 1440 - t.duration);
    target = { date: col.dataset.date, start: m };
    drop = document.createElement('div');
    drop.className = 'blk task drop';
    drop.style.cssText = `top:${m * PXM}px;height:${Math.max(t.duration * PXM, 20)}px;left:1px;width:calc(100% - 3px)`;
    drop.innerHTML = `<div class="bt"><div class="t">${esc(t.title)}</div><div class="m">${fmtRange(m, m + t.duration)}</div></div>`;
    col.append(drop);
  }
  function up(ev) {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
    if (!ghost) return;
    ghost.remove(); drop?.remove(); over?.classList.remove('dropover');
    dragging = false;
    suppressClick = Date.now() + 350;
    if (!target || ev?.type === 'pointercancel') return; // interrupted drags move nothing
    mark();
    t.date = target.date; t.start = target.start; touch(t); commit();
    toast(`Scheduled ${relDay(t.date)}${t.start != null ? ', ' + fmtTime(t.start) : ''}`, { undo: true });
  }
  addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  e.preventDefault();
}

function onKey(e) {
  if (tourOn) return;
  const mod = e.metaKey || e.ctrlKey, key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && key === 'k') { e.preventDefault(); return openPalette(); }
  if (el.dlg.open || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (mod && key === 'z') { e.preventDefault(); return undo(); }
  if (mod || e.altKey) return;
  const run = {
    t: goToday, d: () => setView('day'), w: () => setView('week'), m: () => setView('month'), l: () => setView('list'),
    ArrowLeft: () => step(-1), ArrowRight: () => step(1), k: () => step(-1), j: () => step(1),
    n: () => innerWidth < 760 ? newTaskHere() : $('#quickInput').focus(),
    e: () => openEventForm(null), p: () => openPlan(), '/': openPalette, '?': openHelp,
    r: () => doAct($('#recBtn')), 1: () => setView('home'), 2: () => setView(calendarView()), 3: () => setView('notes'), 4: openRecordings, 5: openPeople,
  }[key];
  if (['ArrowLeft', 'ArrowRight', 'j', 'k'].includes(key) && !VIEWS.includes(view)) return; // only the calendar moves by day or week
  if (run) { e.preventDefault(); run(); }
}

function newTaskHere() {
  openTask(newTask({ date: view === 'day' ? ymd(cursor) : todayYmd() }), true);
}

function bind() {
  const input = $('#quickInput');
  $('#quick').addEventListener('submit', e => { e.preventDefault(); if (!planJob) quickAdd(); });
  input.addEventListener('input', quickHint);
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (planJob) return planJob.abort(); input.value = ''; quickHint(); input.blur(); }
    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); quickPlan(); } // Shift+Enter: let AI work it out
  });
  $('#quickAi').onclick = quickPlan;
  // The greyed example in the empty box changes every few seconds, to show what can be typed.
  $('#todayBtn').onclick = goToday;
  $('#prev').onclick = () => step(-1);
  $('#next').onclick = () => step(1);
  $('#viewSeg').onclick = e => { if (e.target.dataset.view) setView(e.target.dataset.view); };
  $('#brandHome').onclick = () => { document.body.classList.remove('side-open'); if (view !== 'home') setView('home'); }; // the name at the top always leads Home
  // The places the app has: Home, the calendar (in the view it was last in) and the notes.
  $('#mainNav').onclick = e => {
    const b = e.target.closest('[data-nav]');
    if (!b || b.dataset.act) return; // Recordings and People open beside whatever is showing
    document.body.classList.remove('side-open');
    setView(b.dataset.nav === 'calendar' ? calendarView() : b.dataset.nav);
  };
  $('#newEvent').onclick = () => openEventForm(null);
  $('#searchBtn').onclick = e => { e.stopPropagation(); openPalette(); };
  $('#zoneBtn').onclick = openSecondZone;
  el.status.addEventListener('click', () => { if (el.status.classList.contains('err')) openSyncProblems(); });
  $('#fab').onclick = e => { e.stopPropagation(); newTaskHere(); };
  $('#connect').onclick = connect;
  $('#teamsBtn').onclick = openTeams;
  $('#settingsBtn').onclick = () => openSettings();
  $('#helpBtn').onclick = openHelp;
  $('#menu').onclick = e => { e.stopPropagation(); document.body.classList.add('side-open'); };
  $('#closeSide').onclick = e => { e.stopPropagation(); document.body.classList.remove('side-open'); };
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  el.body.addEventListener('pointerdown', onGridPointerDown);
  el.side.addEventListener('pointerdown', onSidePointerDown);
  el.side.addEventListener('toggle', e => { // remember which accounts are unfolded, so a redraw does not fold them again
    const id = e.target.dataset?.acct;
    if (id && e.target.matches('details.acctbox')) e.target.open ? openAccts.add(id) : openAccts.delete(id);
  }, true);
  el.side.addEventListener('change', e => {
    const key = e.target.dataset.cal;
    if (!key) return;
    const [aid, cid] = key.split('|');
    const c = acct(aid)?.calendars.find(c => c.id === cid);
    if (c) { c.enabled = e.target.checked; save(); render(); if (c.enabled) refresh(); }
  });
  document.addEventListener('touchmove', e => { if (dragging) e.preventDefault(); }, { passive: false });

  // Swipe left or right on a phone to move to the next or previous day, week or month.
  const main = $('main');
  let sw = null;
  main.addEventListener('touchstart', e => { sw = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, at: Date.now() } : null; }, { passive: true });
  main.addEventListener('touchend', e => {
    if (!sw || dragging || document.body.classList.contains('side-open')) return;
    const p = e.changedTouches[0], dx = p.clientX - sw.x, dy = p.clientY - sw.y, quick = Date.now() - sw.at < 600;
    sw = null;
    if (quick && Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 2) { suppressClick = Date.now() + 350; step(dx < 0 ? 1 : -1); }
  }, { passive: true });

  let resizeTimer;
  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (view === 'month') renderMonth(); }, 150); });
  addEventListener('offline', () => setStatus('Offline. Changes are kept and sent later.', true));
  addEventListener('online', () => { setStatus(''); scheduleFlush(); refresh(); });
  el.dlg.addEventListener('close', () => { saveOpenNote(); returnTo = null; document.body.append(el.toast); if (recBar?.isConnected) document.body.append(recBar); });
  addEventListener('weftday-save-failed', () => setStatus('This browser is out of storage space. New changes are not being kept.', true));
  el.dlg.addEventListener('submit', e => { // any form in a box: never let the browser reload the page
    e.preventDefault();
    if (e.target.id === 'hintRow') $('[data-x=retry]', el.dlg)?.click();
  });
  el.dlg.addEventListener('cancel', e => { if (!calm()) { e.preventDefault(); closeDialog(); } }); // Escape fades out too
}

// ---------------------------------------------------------------- task editor
const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];
function reminderOptions(cur, withDefault) {
  const list = [[-1, 'No reminder'], [0, 'At start'], [5, '5 min before'], [10, '10 min before'], [15, '15 min before'], [30, '30 min before'], [60, '1 hour before']];
  if (withDefault) list.unshift(['', 'Default']);
  return opts(list, cur == null ? '' : cur);
}

function openTask(t, isNew = false) {
  const durs = [...new Set([...DURATIONS, t.duration])].sort((a, b) => a - b);
  const inSeries = !isNew && t.seriesId && t.repeat !== 'none';
  dialog(`<form class="dbody taskform">
    <div class="thead2">${isNew ? '' : `<button type="button" class="chk${t.done ? ' on' : ''}" data-x="tick" aria-label="${t.done ? 'Mark as not done' : 'Mark as done'}" title="${t.done ? 'Mark as not done' : 'Mark as done'}"></button>`}
      <input name="title" class="ttl" required value="${esc(t.title)}" placeholder="What needs doing?" aria-label="Task" autocomplete="off"></div>
    <h4>When</h4>
    <div class="row">
      <label>Day<input type="date" name="date" value="${esc(t.date || '')}"></label>
      <label>Start<input type="time" name="start" value="${t.start != null ? hhmm(t.start) : ''}"></label>
      <label>Length<select name="duration">${opts(durs.map(d => [d, fmtDur(d)]), t.duration)}</select></label>
    </div>
    <div class="chips">
      <button type="button" class="mini" data-x="when" data-v="today">Today</button>
      <button type="button" class="mini" data-x="when" data-v="tomorrow">Tomorrow</button>
      <button type="button" class="mini" data-x="when" data-v="week">Next week</button>
      <button type="button" class="mini" data-x="when" data-v="free">Next free time</button>
      <button type="button" class="mini" data-x="when" data-v="inbox">No date (inbox)</button>
    </div>
    <h4>Details</h4>
    <div class="row">
      <label>Repeat<select name="repeat">${opts([['none', 'Never'], ['daily', 'Every day'], ['weekdays', 'Mon – Fri'], ['weekly', 'Every week'], ...(repeatDays(t.repeat) ? [[t.repeat, cap(repeatLabel(t.repeat))]] : [])], t.repeat)}</select></label>
      <label>Reminder<select name="reminder">${reminderOptions(t.reminder, true)}</select></label>
      <label>Priority<select name="priority">${opts([['normal', 'Normal'], ['high', 'High']], t.priority)}</select></label>
    </div>
    <label>Tag<input name="tag" value="${esc(t.tag)}" placeholder="work, personal, health…" autocomplete="off"></label>
    <label>Notes<textarea name="notes" rows="3">${esc(t.notes)}</textarea></label>
    <div class="actions">
      ${isNew ? '' : '<button type="button" class="btn danger" data-x="del">Delete</button>'}
      ${inSeries ? '<button type="button" class="btn danger" data-x="delAll">Delete this and later</button>' : ''}
      ${isNew ? '' : '<button type="button" class="btn" data-x="dup">Duplicate</button>'}
      <span class="sp"></span>
      <button type="button" class="btn ghost" data-x="close">Cancel</button>
      <button class="btn primary">Save</button>
    </div></form>`, {
    tick() { closeDialog(); toggleDone(t); }, // the circle next to the title
    when(btn) {
      const f = $('form', el.dlg).elements, v = btn.dataset.v, today = startOfDay(new Date());
      if (v === 'inbox') { f.date.value = ''; f.start.value = ''; return; }
      if (v === 'free') {
        const d = f.date.value ? fromYmd(f.date.value) : today;
        f.date.value = ymd(d);
        f.start.value = hhmm(nextFreeSlot(d, +f.duration.value, false, t));
        return;
      }
      f.date.value = ymd(v === 'today' ? today : v === 'tomorrow' ? addDays(today, 1) : addDays(startOfWeek(today), 7));
    },
    submit(fd) {
      const title = fd.get('title').trim();
      if (!title) return;
      mark();
      const oldDate = t.date, oldRepeat = t.repeat, oldSeries = t.seriesId;
      const start = parseHhmm(fd.get('start'));
      let date = fd.get('date') || null;
      if (start != null && !date) date = todayYmd();
      if (!date && fd.get('repeat') !== 'none') date = todayYmd(); // a repeating task has to start on some day
      Object.assign(t, {
        title, date, start: date ? start : null, duration: +fd.get('duration'),
        priority: fd.get('priority'), tag: fd.get('tag').trim().replace(/^#/, ''), notes: fd.get('notes'),
        reminder: fd.get('reminder') === '' ? null : +fd.get('reminder'),
      });
      const repeat = t.date ? fd.get('repeat') : 'none';
      if (repeat !== oldRepeat) {
        if (oldSeries) endSeries(oldSeries, oldDate || '', t);
        t.repeat = repeat;
        t.seriesId = repeat === 'none' ? null : uid();
      }
      touch(t);
      if (isNew) state.tasks.push(t);
      topUpSeries();
      closeDialog(); commit();
    },
    del() { mark(); removeTask(t); closeDialog(); commit(); toast('Task deleted', { undo: true }); },
    delAll() {
      mark();
      endSeries(t.seriesId, t.date, t);
      removeTask(t); closeDialog(); commit();
      toast('Deleted this and later repeats', { undo: true });
    },
    dup() {
      mark();
      const { title, date, start, duration, priority, tag, reminder, notes } = t;
      state.tasks.push(newTask({ title, date, start, duration, priority, tag, reminder, notes }));
      closeDialog(); commit();
      toast('Duplicated', { undo: true });
    },
  });
  asPanel();
  if (isNew) $('input[name=title]', el.dlg).focus();
}

// ---------------------------------------------------------------- plan my day
function openPlan() {
  const today = startOfDay(new Date()), ds = ymd(today);
  const meets = dayItems(today).timed.filter(i => i.kind === 'ev' && i.ev.selfStatus !== 'declined').sort((a, b) => a.s - b.s);
  const mine = state.tasks.filter(t => t.date === ds);
  const taskMin = mine.filter(t => t.start != null && !t.done).reduce((n, t) => n + t.duration, 0);
  const byPri = (a, b) => (b.priority === 'high') - (a.priority === 'high');
  const carried = state.tasks.filter(t => t.date && t.date < ds && !t.done).sort((a, b) => byPri(a, b) || a.date.localeCompare(b.date));
  const inbox = state.tasks.filter(t => !t.date && !t.done).sort((a, b) => byPri(a, b) || b.created - a.created);
  const hr = new Date().getHours();
  const pick = (t, on, meta) => `<label class="prow"><input type="checkbox" name="pick" value="${esc(t.id)}"${on ? ' checked' : ''}>
    <span class="pt">${pri(t)}${esc(t.title)}</span><span class="pd">${meta}</span></label>`;
  dialog(`<form class="dbody">
    <h3>${hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening'}</h3>
    <div class="meta">${dayLabel(today, true)}</div>
    <div class="stats">
      <div><b>${meets.length}</b><span>meeting${meets.length === 1 ? '' : 's'}${meets.length ? ' · ' + fmtDur(meets.reduce((n, i) => n + i.e - i.s, 0)) : ''}</span></div>
      <div><b>${mine.filter(t => !t.done).length}</b><span>tasks to do${taskMin ? ' · ' + fmtDur(taskMin) : ''}</span></div>
      <div><b>${fmtDur(freeMinutes(today))}</b><span>free until ${fmtTime(state.settings.dayEnd)}</span></div>
    </div>
    ${meets.length ? `<h4>Meetings today</h4><div class="plist">${meets.map(i => `<div class="prow"><span class="ptime">${fmtTime(i.s)}</span><span class="dot" style="background:${evColor(i.ev)}"></span><span class="pt">${esc(i.ev.title)}</span><span class="pd">${fmtDur(i.e - i.s)}</span></div>`).join('')}</div>` : ''}
    ${carried.length ? `<h4>Carried over from earlier</h4><div class="plist">${carried.map(t => pick(t, true, `${dayLabel(fromYmd(t.date))} · ${fmtDur(t.duration)}`)).join('')}</div>` : ''}
    ${inbox.length ? `<h4>From your inbox</h4><div class="plist">${inbox.map(t => pick(t, false, fmtDur(t.duration))).join('')}</div>` : ''}
    ${carried.length || inbox.length
      ? '<p class="note">Tick what you want to do today. Each one is placed in the next free gap in your working hours.</p>'
      : '<p class="note">Nothing is waiting to be planned. Add tasks with the box at the top left.</p>'}
    <div class="actions"><span class="sp"></span>
      <button type="button" class="btn ghost" data-x="close">Close</button>
      ${carried.length || inbox.length ? '<button class="btn primary">Add to today</button>' : ''}</div></form>`, {
    submit(fd) {
      const picked = fd.getAll('pick').map(getTask).filter(Boolean).sort(byPri);
      if (!picked.length) return closeDialog();
      mark();
      let loose = 0;
      for (const t of picked) {
        t.date = ds; t.start = null;
        t.start = nextFreeSlot(today, t.duration, true);
        if (t.start == null) loose++;
        touch(t);
      }
      closeDialog(); commit();
      const n = picked.length - loose;
      toast(loose ? `${n} scheduled, ${loose} added without a time (day is full)` : `${n} task${n === 1 ? '' : 's'} scheduled for today`, { undo: true });
    },
  });
  firstTip('plan');
}

// ---------------------------------------------------------------- search and commands
function openPalette() {
  dialog(`<div class="pal"><input id="palIn" placeholder="Search tasks and events, or type a date or command…" autocomplete="off" spellcheck="false">
    <div id="palList"></div><div class="palfoot">↑ ↓ to move · Enter to open · Esc to close</div></div>`, {}, 'palette');
  const input = $('#palIn', el.dlg), list = $('#palList', el.dlg);
  const cmds = [
    ['Go to today', goToday], ['Today: prepare for my meetings', openToday], ['People and companies', () => openPeople()], ['Share my free times', () => openFreeTimes()], ['Record a meeting or my screen', () => openRecordSetup(null)], ['Recordings', () => openRecordings(null)], ['Take a screenshot', () => takeShot(null)], ['Ask my meetings a question', openAskAll], ['Notes: everything you have written', () => setView('notes')], ['Show me around (tour)', () => setTimeout(startTour, 250)], ['Show a second time zone', openSecondZone], ['Plan my day', openPlan], ['New task', newTaskHere], ['New event', () => openEventForm(null)],
    ['Day view', () => setView('day')], ['Week view', () => setView('week')], ['Month view', () => setView('month')], ['List view', () => setView('list')],
    ['Settings', () => openSettings()], ['Set up phone or another device', openDeviceSetup], ['Keyboard shortcuts', openHelp],
  ].map(([label, run]) => ({ kind: 'Go', label, sub: '', run }));
  let rows = [], sel = 0;
  const paint = () => {
    list.innerHTML = rows.map((r, i) => `<div class="pr${i === sel ? ' on' : ''}" data-i="${i}"><span class="pk">${r.kind}</span><span class="pl">${esc(r.label)}</span><span class="ps">${esc(r.sub)}</span></div>`).join('')
      || '<div class="empty" style="padding:12px">No matches.</div>';
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  const build = () => {
    const q = input.value.trim().toLowerCase(), has = s => (s || '').toLowerCase().includes(q);
    rows = [];
    if (q) {
      const p = parseQuick(input.value);
      if (p.date && !p.title) rows.push({ kind: 'Go', label: `Go to ${dayLabel(fromYmd(p.date), true)}`, sub: '', run: () => goTo(fromYmd(p.date)) });
    }
    rows.push(...cmds.filter(c => !q || has(c.label)));
    if (q) { // people you meet and their companies
      const everyone = [...allPeople().values()], mine = myDomains();
      for (const w of everyone.filter(w => has(w.name) || has(w.email)).sort((a, b) => hasFacts(b.email) - hasFacts(a.email) || a.name.localeCompare(b.name)).slice(0, 5)) {
        rows.push({ kind: 'Person', label: w.name, sub: roleOf(w) || w.company || w.email, run: () => openPerson({ email: w.email, displayName: w.name }, null) });
      }
      const firms = new Map();
      for (const w of everyone) if (w.company && !mine.has(w.domain) && (has(w.company) || has(w.domain))) firms.set(w.domain, w.company);
      for (const [domain, name] of [...firms].slice(0, 3)) rows.push({ kind: 'Company', label: name, sub: domain, run: () => openCompany(domain, null) });
    }
    if (q) {
      const tasks = state.tasks.filter(t => has(t.title) || has(t.tag) || has(t.notes))
        .sort((a, b) => a.done - b.done || (a.date || '').localeCompare(b.date || '')).slice(0, 15);
      for (const t of tasks) rows.push({ kind: 'Task', label: (t.done ? '✓ ' : '') + t.title, sub: t.date ? relDay(t.date) + (t.start != null ? ', ' + fmtTime(t.start) : '') : 'Inbox', run: () => openTask(t) });
      const now = Date.now(); // upcoming first (soonest at the top), then past (most recent first)
      const evs = [...events.values()].filter(ev => enabledEvent(ev) && (has(ev.title) || has(ev.location)))
        .sort((a, b) => (a.e < now) - (b.e < now) || (a.e < now ? b.s - a.s : a.s - b.s)).slice(0, 10);
      for (const ev of evs) { const s = new Date(ev.s); rows.push({ kind: 'Event', label: ev.title, sub: `${dayLabel(s)}${ev.allDay ? '' : ', ' + fmtTime(s.getHours() * 60 + s.getMinutes())}`, run: () => openEvent(ev) }); }
    }
    sel = 0;
    paint();
  };
  const run = r => { if (!r) return; closeDialog(); r.run(); };
  input.oninput = build;
  input.onkeydown = e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = clamp(sel + (e.key === 'ArrowDown' ? 1 : -1), 0, Math.max(0, rows.length - 1)); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(rows[sel]); }
  };
  list.onclick = e => { const r = e.target.closest('[data-i]'); if (r) run(rows[+r.dataset.i]); };
  build();
  input.focus();
}

function openHelp() {
  const cmd = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  const groups = [
    ['Go to', [[['1'], 'Home'], [['2'], 'Calendar'], [['3'], 'Notes'], [['4'], 'Recordings'], [['5'], 'People'], [['/'], 'Search everything']]],
    ['Make', [[['R'], 'Record'], [['N'], 'New task'], [['E'], 'New event'], [['P'], 'Plan my day'], [[cmd, 'Z'], 'Undo']]],
    ['Calendar', [[['T'], 'Today'], [['D'], 'Day'], [['W'], 'Week'], [['M'], 'Month'], [['L'], 'List'], [['←', '→'], 'Earlier, later']]],
  ];
  const ex = [['gym tomorrow 7am 1h #health', 'a time, a length and a tag'], ['pay rent 1 dec !', 'a date, marked important'], ['standup every weekday 9:30am 15m', 'repeats'], ['read contract', 'no date: goes to your inbox']];
  dialog(`<div class="dbody keysbox"><h3>Shortcuts</h3>
    <div class="kgroups">${groups.map(([name, rows]) => `<section><h4>${name}</h4>${rows.map(([keys, label]) => `<div class="krow"><span>${label}</span><span class="kcaps">${keys.map(k => `<kbd>${k}</kbd>`).join('')}</span></div>`).join('')}</section>`).join('')}</div>
    <h4>Typing a task</h4>
    <div class="kex">${ex.map(([text, what]) => `<div><code>${esc(text)}</code><span>${what}</span></div>`).join('')}</div>
    <p class="note">On the calendar, click an empty time to add a task, drag a task to move it, and drag its bottom edge to make it longer. Press <kbd class="kin">?</kbd> any time to see this list.</p>
    <div class="actions"><span class="sp"></span><button class="btn primary" data-x="close">Done</button></div></div>`, {}, 'wide');
}

// ---------------------------------------------------------------- calendar events
const STATUS_LABEL = { accepted: 'going', declined: 'declined', tentative: 'maybe', needsAction: 'no reply yet' };

function eventWhen(ev) {
  const s = new Date(ev.s), e = new Date(ev.e);
  if (ev.allDay) {
    const last = addDays(e, -1);
    return ymd(s) === ymd(last) ? `${dayLabel(s, true)} · all day` : `${dayLabel(s)} – ${dayLabel(last)} · all day`;
  }
  const sm = s.getHours() * 60 + s.getMinutes(), em = e.getHours() * 60 + e.getMinutes();
  const z2 = state.settings.zone2 && state.settings.zone2 !== TZ ? state.settings.zone2 : '';
  const there = z2 ? `  ·  ${fmtRange(zoneParts(ev.s, z2).mins, zoneParts(ev.e, z2).mins)} ${zoneShort(z2)}` : ''; // the same meeting on the second zone's clock
  return (ymd(s) === ymd(e) ? `${dayLabel(s, true)} · ${fmtRange(sm, em)}` : `${dayLabel(s)} ${fmtTime(sm)} – ${dayLabel(e)} ${fmtTime(em)}`) + there;
}

// ---------------------------------------------------------------- meeting prep
// Who you are meeting, your history with them, ways to look them up, and your own private notes.
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com',
  'yahoo.co.in', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'aol.com', 'zoho.com', 'rediffmail.com']);
const cap = w => w.charAt(0).toUpperCase() + w.slice(1);
// Full names seen anywhere in your calendars (guest lists, organisers) are remembered, so someone who
// appears as just an email address in one meeting can still be named properly.
const knownNames = new Map(Object.entries(state.names || {}));
let namesChanged = false;
function learnNames(e) {
  for (const p of [...(e.attendees || []), e.organizer, e.creator]) {
    const email = (p?.email || '').toLowerCase(), name = (p?.displayName || '').trim();
    if (!email || !name || name.includes('@') || name.toLowerCase() === email.split('@')[0]) continue;
    const had = knownNames.get(email);
    if (had === name || (had?.includes(' ') && !name.includes(' '))) continue; // keep the fuller name
    knownNames.set(email, name);
    namesChanged = true;
  }
}
function saveNames() {
  if (!namesChanged) return;
  namesChanged = false;
  state.names = Object.fromEntries([...knownNames].slice(-800));
  save();
}
const TWO_PART_ENDINGS = /\.(co|com|org|net|ac|gov|edu)\.[a-z]{2}$/;
function person(p) {
  const email = (p.email || '').toLowerCase(), [local, host = ''] = email.split('@');
  const labels = host.split('.'), keep = TWO_PART_ENDINGS.test(host) ? 3 : 2;
  const domain = labels.slice(-keep).join('.'); // mail.acme.co.uk -> acme.co.uk
  const given = p.displayName && !p.displayName.includes('@') ? p.displayName.trim() : knownNames.get(email);
  const name = given || local.split(/[._-]+/).filter(Boolean).map(cap).join(' ') || email;
  const company = domain && !FREE_MAIL.has(domain) ? cap(domain.split('.')[0]) : '';
  return {
    email, name, domain, company, fullName: !!given && given.includes(' '),
    self: !!p.self || !!acct(email), organizer: !!p.organizer, status: p.responseStatus,
  };
}
// Links that search for the person. Nothing is sent until you press one. With a full name the search
// goes to LinkedIn directly; with only a first name it looks for LinkedIn profiles at that company.
const AI_APPS = {
  claude: ['Claude', q => `https://claude.ai/new?q=${G.enc(q)}`],
  chatgpt: ['ChatGPT', q => `https://chatgpt.com/?hints=search&q=${G.enc(q)}`],
  perplexity: ['Perplexity', q => `https://www.perplexity.ai/search?q=${G.enc(q)}`],
};
// A ready-made question about the person, opened in your own AI app. Sent only when you press it.
function askAiUrl(who, title) {
  const where = who.company ? ` at ${who.company} (${who.domain})` : '';
  const question = `Who is ${who.name}${where}? I have a meeting with them${title ? ` called "${title}"` : ''}. `
    + 'Search the web and tell me their role, their background, and anything recent worth knowing, with links. Keep it short.';
  return (AI_APPS[state.settings.aiApp] || AI_APPS.claude)[1](question);
}
function lookupLinks(who, title) {
  if (!who.fullName && !who.company) return ''; // a first name alone is not enough to find anyone
  const at = who.company ? ` ${who.company}` : '';
  const links = [
    ['Ask AI', askAiUrl(who, title)],
    ['LinkedIn', who.fullName
      ? `https://www.linkedin.com/search/results/people/?keywords=${G.enc(who.name + at)}`
      : `https://www.google.com/search?q=${G.enc(`site:linkedin.com/in ${who.name}${at}`)}`],
    ['Google', `https://www.google.com/search?q=${G.enc(`"${who.name}"${at}`)}`],
  ];
  if (who.company) links.push(['Website', `https://${who.domain}`]);
  return links.map(([label, url]) => `<a href="${esc(url)}" target="_blank" rel="noopener">${label}</a>`).join('');
}
// Your meetings with one person over the past year (and the next three months), oldest first.
const metCache = new Map();
async function meetingsWith(email) {
  const hit = metCache.get(email);
  if (hit && Date.now() - hit.at < 10 * 60000) return hit.list;
  const found = new Map();
  if (DEMO) {
    for (const ev of events.values()) if ((ev.att || []).some(p => (p.email || '').toLowerCase() === email)) found.set(noteKey(ev), { s: ev.s, nk: noteKey(ev), title: ev.title });
  } else {
    const now = new Date(), params = {
      q: email, timeMin: addDays(now, -365).toISOString(), timeMax: addDays(now, 90).toISOString(),
      singleEvents: true, orderBy: 'startTime', maxResults: 250,
    };
    await Promise.all(state.accounts.filter(a => !a.needsReconnect).map(async a => {
      const cal = a.calendars.find(c => c.primary);
      if (!cal) return;
      try {
        const items = [];
        for (let pageToken, page = 0; page < 6; page++) { // people you meet daily fill more than one page
          const j = await G.api(a, `/calendars/${G.enc(cal.id)}/events`, { params: { ...params, pageToken } });
          items.push(...(j.items || []));
          if (!(pageToken = j.nextPageToken)) break;
        }
        for (const e of items) {
          if (e.status === 'cancelled' || !e.start) continue;
          learnNames(e);
          if (!(e.attendees || []).some(p => (p.email || '').toLowerCase() === email)) continue;
          if ((e.attendees || []).find(p => p.self)?.responseStatus === 'declined') continue;
          const nk = N.keyFor(e);
          found.set(nk, { s: Date.parse(e.start.dateTime || `${e.start.date}T00:00:00`), nk, title: e.summary || '(No title)' });
        }
      } catch (err) { console.warn(a.email, err); }
    }));
  }
  const list = [...found.values()].sort((x, y) => x.s - y.s);
  metCache.set(email, { at: Date.now(), list });
  return list;
}
function metLine(list, key) {
  const now = Date.now(), past = list.filter(m => m.s < now && m.nk !== key);
  if (!past.length) return 'No earlier meetings in the past year';
  return `Met ${past.length === 1 ? 'once' : `${past.length} times`} in the past year · last on ${dayLabel(new Date(past[past.length - 1].s))}`;
}

// A feature that runs on AI was pressed before a key was added. One box says so in plain words,
// with one way forward: the key screen. what: the feature, as the start of a sentence ("Asking your
// meetings"); sent: what would go to the AI, when that is worth saying; back: where "Back" returns to.
const SPARK = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 3.5l1.9 5.1L18 10.5l-5.1 1.9L11 17.5l-1.9-5.1L4 10.5l5.1-1.9z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></svg>';
function needKey(what, { sent = '', back = null } = {}) {
  dialog(`<div class="dbody needkey"><span class="aimark">${SPARK}</span>
    <h3>Add your AI key to use this</h3>
    <p>${esc(what)} uses AI, and AI in Weftday runs on a key of your own. Google gives the key away free, and adding it takes about a minute.</p>
    ${sent ? `<p class="note">${esc(sent)}</p>` : ''}
    <div class="actions"><button type="button" class="btn ghost" data-x="${back ? 'back' : 'close'}">${back ? 'Back' : 'Not now'}</button><span class="sp"></span><button type="button" class="btn primary" data-x="add">Add my free key</button></div></div>`, {
    back: () => back?.(),
    add: () => openSettings('', 'ai'),
  });
}
// "Get facts" pressed before an AI key has been added.
const openFactsHelp = (guest, from) => needKey('Looking people up on the web', {
  sent: 'Each time facts are fetched, the person’s name, their company and the meeting title go to that AI. Nothing is sent before that.',
  back: () => openPerson(guest, from),
});

// The line shown under a person's name in a meeting: their role if facts were found, else the start
// of what you wrote about them.
function aboutLine(email) {
  const text = N.get(N.aboutKey(email))?.text || '';
  if (!text) return '';
  const { own, raw } = F.split(text);
  return (raw && F.parse(raw).role) || AI.gistOf(own, 160);
}
const initials = name => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';

// Pictures (can be switched off in Settings). A company's logo is its website icon, fetched through
// Google's site-icon service. A person's photo is the one they set up on Gravatar, looked up by a
// scrambled form of their email address; failing that, a picture found on the web by "Get facts"
// (see findPhotos). LinkedIn does not let other apps fetch profile photos, so those are never used.
// Without a photo the coloured initials stay.
const logoHtml = domain => (state.settings.pictures !== false && domain && !FREE_MAIL.has(domain)
  ? `<img class="logo" alt="" loading="lazy" referrerpolicy="no-referrer" src="https://www.google.com/s2/favicons?domain=${G.enc(domain)}&sz=128">` : '');
const savedFacts = email => { const raw = F.split(N.get(N.aboutKey(email))?.text || '').raw; return raw ? F.parse(raw) : null; };
const avatarHtml = (who, small) => `<div class="avatar${small ? ' sm' : ''}" data-photo="${esc(who.email)}" data-web="${esc(savedFacts(who.email)?.photo || '')}" style="--tc:${tagColor(who.email)}">${esc(initials(who.name))}</div>`;
// Loads a picture without telling its website which page asked for it. Resolves to the image, or null.
const loadPicture = (src, wait = 8000) => new Promise(done => {
  const img = new Image(), timer = setTimeout(() => done(null), wait);
  img.referrerPolicy = 'no-referrer'; img.alt = '';
  img.onload = () => { clearTimeout(timer); done(img); };
  img.onerror = () => { clearTimeout(timer); done(null); };
  img.src = src;
});
async function showPictures() {
  for (const logo of el.dlg.querySelectorAll('img.logo')) logo.addEventListener('error', () => logo.remove());
  if (state.settings.pictures === false) return;
  for (const spot of el.dlg.querySelectorAll('.avatar[data-photo]')) (async () => {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(spot.dataset.photo.trim().toLowerCase())));
    const img = await loadPicture(`https://gravatar.com/avatar/${[...bytes].map(b => b.toString(16).padStart(2, '0')).join('')}?s=160&d=404`)
      || (spot.dataset.web && await loadPicture(spot.dataset.web));
    if (img && spot.isConnected) { spot.textContent = ''; spot.append(img); spot.classList.add('photo'); }
  })();
}
// Looks for pictures of the person on the web, with your Tavily search key. Returns the ones that
// really load and look like a portrait, most likely first: [{ url, sure }].
async function findPhotos(who, hint, signal) {
  const key = searchKeyOf('tavily');
  if (state.settings.pictures === false || !key || !(who.fullName || who.company)) return [];
  try {
    const query = `${who.fullName ? `"${who.name}"` : who.name}${who.company ? ` ${who.company}` : ''}${hint ? ` ${hint}` : ''}`;
    const ranked = F.rankPhotos(await S.photoSearch(query, key, signal), who);
    const loaded = await Promise.all(ranked.map(p => loadPicture(p.url, 6000)));
    const portrait = img => img && img.naturalWidth >= 90 && img.naturalHeight >= 90 && img.naturalWidth / img.naturalHeight < 2.4 && img.naturalHeight / img.naturalWidth < 2.4;
    return ranked.filter((p, i) => portrait(loaded[i]));
  } catch { return []; }
}
// The lines about photos that go into the saved facts. A photo you already have for the same person
// (picked by you or found before) is kept; otherwise the best new one is used if it is sure.
async function photoLines(found, old, hint) {
  const same = old && (old.hint || '') === (hint || '');
  const all = [...new Set([...found.map(p => p.url), ...(same ? old.photos : [])])].slice(0, 6);
  const keep = same && old.photoSet && (!old.photo || !!(await loadPicture(old.photo, 6000))); // "no photo", or one that still loads
  const shown = keep ? (old.photo || 'none') : found.find(p => p.sure)?.url || '';
  return `${shown ? `\nPhoto: ${shown}` : ''}${all.length ? `\nPhotos:\n${all.map(u => `- ${u}`).join('\n')}` : ''}`;
}
// Lets you pick which of the pictures found on the web is the person, or none.
function openPhotoPick(guest, from) {
  const p = person(guest), key = N.aboutKey(p.email), f = savedFacts(p.email);
  if (!f) return openPerson(guest, from);
  dialog(`<div class="dbody"><h3>Photo of ${esc(p.name.split(' ')[0])}</h3>
    <p class="note">${f.photos.length ? 'These pictures were found on the web for this name. Pick the one that is them.' : 'No pictures were found on the web for this name. Press Refresh on their profile to look again.'}</p>
    <div class="pgrid">${f.photos.map(u => `<button type="button" class="pcell${u === f.photo ? ' on' : ''}" data-x="pick" data-url="${esc(u)}"><img src="${esc(u)}" alt="" referrerpolicy="no-referrer" loading="lazy"></button>`).join('')}
      <button type="button" class="pcell none${f.photo ? '' : ' on'}" data-x="pick" data-url="">No photo</button></div>
    <div class="actions"><button type="button" class="btn" data-x="back">Back</button></div></div>`, {
    back: () => openPerson(guest, from),
    pick(x) {
      N.set(key, F.setPhoto(N.get(key)?.text || '', x.dataset.url), { title: p.name, when: Date.now(), people: [p.email] });
      scheduleFlush();
      openPerson(guest, from);
    },
  });
  for (const img of el.dlg.querySelectorAll('.pcell img')) img.addEventListener('error', () => img.closest('.pcell').remove());
}

// The facts found on the web, laid out as a card: first the person, then their company.
function factsHtml(f, day, who) {
  const part = (label, items) => (items.length ? `<div class="fsec${items.length > 1 ? ' multi' : ''}"><h5>${label}</h5>${items.map(x => `<p>${esc(x)}</p>`).join('')}</div>` : '');
  const tags = (label, items) => (items.length ? `<div class="fsec"><h5>${label}</h5><div class="tags">${items.map(x => `<span>${esc(x)}</span>`).join('')}</div></div>` : '');
  const one = (label, text) => part(label, text ? [text] : []);
  const them = part('Background', f.background) + one('Education', f.education) + tags('Expertise', f.expertise);
  const firm = one('What they do', f.company) + one('Team size', f.teamSize) + part('Funding', f.funding) + part('Key people', f.people) + tags('Clients', f.clients);
  return `${them ? `<div class="fgroup"><h4>About ${esc(who.name.split(' ')[0])}</h4>${them}</div>` : ''}
    ${firm ? `<div class="fgroup"><h4>${logoHtml(who.domain)}${esc(who.company || 'Their company')}</h4>${firm}</div>` : ''}
    ${f.recent.length || f.ideas.length || f.other.length ? `<div class="fgroup"><h4>For this meeting</h4>${part('Recently', f.recent)}${part('Worth asking', f.ideas)}${part('Also', f.other)}</div>` : ''}
    ${f.sources.length ? `<div class="chips2">${f.sources.map(x => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.host)}</a>`).join('')}</div>` : ''}
    ${f.coverage ? '<div class="note">This comes from the company’s own website, so it says little about the person. Add a free search key in Settings → AI for more.</div>' : ''}
    <div class="ffoot"><span>From the web${day ? ` · ${esc(day)}` : ''}${f.hint ? `, using your hint “${esc(f.hint)}”` : ''}. Check before relying on it.</span>
      <span class="flinks">${f.photos.length || f.photo ? '<button type="button" class="linkbtn" data-x="photo">Change photo</button>' : ''}<button type="button" class="linkbtn" data-x="notthem">Not them?</button><button type="button" class="linkbtn" data-x="facts">Refresh</button></span></div>
    <form class="hintrow" id="hintRow" hidden><input name="hint" maxlength="120" placeholder="A hint: their job, city, or LinkedIn address" autocomplete="off" value="${esc(f.hint || '')}"><button class="btn" data-x="retry" type="button">Look again</button></form>`;
}
const FACTS_LOADING = `<div class="note">Reading the web about them and their company. This takes up to half a minute…</div>
  <div class="sk w40"></div><div class="sk"></div><div class="sk w80"></div><div class="sk w60"></div>`;

// Everything Weftday knows about one person: facts from the web, what you wrote about them, your
// meetings, what is still open and your notes from those meetings. "from" is the meeting to go back to.
function openPerson(guest, from) {
  const p = person(guest), key = N.aboutKey(p.email), first = p.name.split(' ')[0];
  let { own, raw, day } = F.split(N.get(key)?.text || '');
  const f = raw ? F.parse(raw) : null;
  let hint = f?.hint || ''; // what you told Weftday about them, used again on Refresh
  const canLook = p.fullName || !!p.company, at = p.company ? ` ${p.company}` : '';
  const linkedin = f?.linkedin || (!canLook ? '' : p.fullName
    ? `https://www.linkedin.com/search/results/people/?keywords=${G.enc(p.name + at)}`
    : `https://www.google.com/search?q=${G.enc(`site:linkedin.com/in ${p.name}${at}`)}`);
  const notes = N.withPeople([p.email], null);
  const open = openItems([p.email], null);
  const link = (label, url) => `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">${label}</a>`;
  dialog(`<div class="dbody">
    <div class="phead">${avatarHtml(p)}
      <div class="pmain"><h3>${esc(p.name)}</h3>
        ${f?.role ? `<div class="prole">${esc(f.role)}</div>` : ''}
        <div class="meta">${esc([f?.location, p.email].filter(Boolean).join(' · '))}</div></div></div>
    ${canLook ? `<div class="btnrow">${linkedin ? link(f?.linkedin ? 'LinkedIn profile' : 'Find on LinkedIn', linkedin) : ''}${p.company ? `<button type="button" class="btn" data-x="firm">${logoHtml(p.domain)}${esc(p.company)}</button>` : ''}${link('Ask AI', askAiUrl(p, from?.title))}</div>` : ''}
    <div class="facts" id="factsBox">${f ? factsHtml(f, day, p)
      : canLook ? `<div class="fempty"><b>No facts yet</b><span>Weftday can look ${esc(first)} up on the web and fill this in.</span><button type="button" class="btn primary" data-x="facts">Get facts</button></div>`
      : '<div class="fempty"><span>There is not enough to look this person up. A first name alone is too little.</span></div>'}</div>
    <div class="note" id="searched" hidden></div>
    <label><span>Your notes about ${esc(first)} <i>· only you can see this</i></span>
      <textarea name="about" rows="3" maxlength="${N.MAX_LENGTH}" placeholder="What matters to them, how you know them, anything to remember. It shows in every meeting with them.">${esc(own)}</textarea></label>
    <div class="airow"><span class="sp"></span><span class="saved" id="aboutState"></span></div>
    <h4>Your meetings</h4>
    <div class="plist2" id="metList"><div class="note">Checking your calendar…</div></div>
    ${open.length ? `<h4>Still open with ${esc(first)}</h4><div class="todo2">${open.slice(0, 12).map(o => `<div>• ${openLine(o)}</div>`).join('')}</div>` : ''}
    ${notes.length ? `<h4>Your notes from meetings with them</h4><div class="past">${notes.slice(0, 8).map(n => `<div><b>${esc(n.title || 'Meeting')}</b>${n.when ? ` <i>· ${esc(dayLabel(new Date(n.when)))}</i>` : ''}<div class="desc">${esc(AI.gistOf(n.text, 400))}</div></div>`).join('')}</div>` : ''}
    <div class="actions">${from ? '<button type="button" class="btn" data-x="back">Back to the meeting</button>' : returnTo ? '<button type="button" class="btn" data-x="ret">Back</button>' : ''}<span class="sp"></span><button type="button" class="btn primary" data-x="close">Close</button></div></div>`, {
    back: () => openEvent(from),
    ret: () => { commitAbout(true); const go = returnTo; returnTo = null; go(); },
    firm: () => { commitAbout(true); const back = returnTo; openCompany(p.domain, () => { returnTo = back; openPerson(guest, from); }); },
    photo: () => { commitAbout(true); openPhotoPick(guest, from); },
    // "Not them?": shows a box for a hint, then looks again with it.
    notthem() {
      const row = $('#hintRow', el.dlg);
      row.hidden = false;
      $('[name=hint]', row).focus();
    },
    retry() { hint = $('#hintRow [name=hint]', el.dlg).value.trim(); this.facts(); },
    // Looks the person up on the web and shows what it finds as a card.
    async facts() {
      if (!factsKey()) return openFactsHelp(guest, from);
      const card = $('#factsBox', el.dlg), before = card.innerHTML;
      const job = newJob();
      card.innerHTML = FACTS_LOADING;
      try {
        const answer = await getFacts(p, from?.title, job.signal, hint);
        if (job.signal.aborted || !card.isConnected) return;
        ({ raw, day } = F.split(F.mergeInto('', answer, dayLabel(new Date()))));
        lastOwn = box.value;
        N.set(key, F.join(box.value.trim() ? box.value : '', raw, day).slice(0, N.MAX_LENGTH), { title: p.name, when: Date.now(), people: [p.email] });
        scheduleFlush();
        const searched = answer.queries;
        openPerson(guest, from); // draw the page again, now with the facts
        if (searched.length) {
          const line = $('#searched', el.dlg);
          line.hidden = false;
          line.innerHTML = `Searched for: ${searched.map(q => `<a href="https://www.google.com/search?q=${G.enc(q)}" target="_blank" rel="noopener">${esc(q)}</a>`).join(' · ')}`;
        }
      } catch (err) {
        if (err.name !== 'AbortError' && card.isConnected) { card.innerHTML = before; toast(err.message, true); }
      } finally {
        if (aiJob === job) aiJob = null;
      }
    },
  });

  firstTip('person');
  showPictures();
  // Your own words save by themselves; the facts found on the web ride along in the same note.
  asPanel();
  const box = $('[name=about]', el.dlg), saved = $('#aboutState', el.dlg);
  let timer = 0;
  let lastOwn = box.value; // only what you changed in the box is saved, never an old copy over newer text
  const commitAbout = quiet => {
    clearTimeout(timer);
    if (box.value === lastOwn) return false;
    lastOwn = box.value;
    const now = F.split(N.get(key)?.text || ''); // facts may have arrived since this page was opened
    const text = F.join(box.value.trim() ? box.value : '', now.raw, now.day);
    if (text.length > N.MAX_LENGTH) toast('This is too long to keep in full. Shorten your notes a little.', true);
    if (!N.set(key, text.slice(0, N.MAX_LENGTH), { title: p.name, when: Date.now(), people: [p.email] })) return false;
    scheduleFlush();
    if (quiet !== true && saved.isConnected) saved.textContent = plannerReady() ? 'Saved' : 'Saved on this device';
    return true;
  };
  box.addEventListener('input', () => { saved.textContent = ''; clearTimeout(timer); timer = setTimeout(commitAbout, 600); });
  box.addEventListener('change', commitAbout);
  noteCommit = commitAbout;

  const box2 = $('#metList', el.dlg);
  meetingsWith(p.email).then(list => {
    if (!box2?.isConnected) return; // another page was opened meanwhile
    const now = Date.now(), past = list.filter(m => m.s < now).reverse(), next = list.filter(m => m.s >= now);
    const row = m => `<div><i>${esc(dayLabel(new Date(m.s)))}</i> ${esc(m.title || '')}${N.has(m.nk) ? ' <i class="nmark" title="You have notes on this one"></i>' : ''}</div>`;
    box2.innerHTML = !list.length ? '<div class="note">No meetings with them in the past year.</div>'
      : `<div class="note">${past.length ? `Met ${past.length === 1 ? 'once' : `${past.length} times`} in the past year` : 'Not met yet'}${next.length ? ` · ${next.length} coming up` : ''}</div>
         ${next.slice(0, 3).map(row).join('')}${past.slice(0, 8).map(row).join('')}${past.length > 8 ? `<div class="note">and ${past.length - 8} earlier</div>` : ''}`;
    saveNames();
  }).catch(() => {});
}

// "Brief me": everything worth knowing before one meeting, on a single screen. It is put together
// from what is already saved (profiles, your notes), so it opens at once.
function openBrief(ev) {
  const guests = (ev.att || []).filter(g => !g.resource);
  const others = guests.map(g => ({ guest: g, who: person(g) })).filter(x => !x.who.self).slice(0, 8);
  const withFacts = others.map(x => {
    const { own, raw } = F.split(N.get(N.aboutKey(x.who.email))?.text || '');
    return { ...x, own, f: raw ? F.parse(raw) : null };
  });
  const missing = withFacts.filter(x => !x.f && (x.who.fullName || x.who.company));
  // their company: the one most of the guests belong to
  const counts = new Map();
  for (const x of withFacts) if (x.who.company) counts.set(x.who.company, (counts.get(x.who.company) || 0) + 1);
  const firmName = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const firm = withFacts.find(x => x.who.company === firmName && x.f && (x.f.company || x.f.funding.length || x.f.teamSize))?.f || null;
  const firmDomain = withFacts.find(x => x.who.company === firmName)?.who.domain || '';
  const key = noteKey(ev), emails = others.map(x => x.who.email);
  const earlier = N.withPeople(emails, key), last = earlier.find(n => (n.when || 0) < ev.s) || null;
  const open = [];
  for (const n of earlier) for (const text of AI.actionsIn(n.text)) {
    const task = state.tasks.find(t => t.title.toLowerCase() === text.toLowerCase());
    if (!task?.done && !open.includes(text)) open.push(text);
  }
  const uniq = lists => [...new Set(lists.flat())].slice(0, 4);
  const recent = uniq(withFacts.map(x => x.f?.recent || [])), ideas = uniq(withFacts.map(x => x.f?.ideas || []));
  const mine = N.get(key)?.text || '';
  const list = items => items.map(x => `<p>${esc(x)}</p>`).join('');
  const tags = items => `<div class="tags">${items.map(x => `<span>${esc(x)}</span>`).join('')}</div>`;
  dialog(`<div class="dbody brief">
    <h3>${logoHtml(firmDomain)}${esc(ev.title)}</h3>
    <div class="meta">${esc(eventWhen(ev))}</div>
    <h4>Who you’re meeting</h4>
    <div class="whos">${withFacts.map(x => `<div class="bwho">
      ${avatarHtml(x.who, true)}
      <div><button type="button" class="nm" data-x="person" data-email="${esc(x.who.email)}">${esc(x.who.name)} ›</button>
        <div class="wm">${esc(x.f ? [x.f.role, x.f.location].filter(Boolean).join(' · ') || 'Profile saved' : x.own ? AI.gistOf(x.own, 120) : 'No profile yet')}</div>
        ${x.f?.expertise.length ? tags(x.f.expertise.slice(0, 4)) : ''}</div></div>`).join('')}</div>
    ${missing.length ? `<div><button type="button" class="mini" data-x="fill">Get the missing ${missing.length === 1 ? 'profile' : `${missing.length} profiles`}</button></div>` : ''}
    ${firm ? `<h4>${logoHtml(firmDomain)}${esc(firmName)}</h4><div class="fsec">${firm.company ? `<p>${esc(firm.company)}</p>` : ''}
      ${firm.teamSize ? `<p><i>Team</i> ${esc(firm.teamSize)}</p>` : ''}${firm.funding.length ? `<p><i>Funding</i> ${esc(firm.funding[0])}</p>` : ''}
      ${firm.clients.length ? tags(firm.clients.slice(0, 6)) : ''}</div>` : ''}
    ${last ? `<h4>Last time${last.when ? ` · ${esc(dayLabel(new Date(last.when)))}` : ''}</h4><div class="fsec"><p>${esc(AI.gistOf(last.text, 320))}</p></div>` : ''}
    ${open.length ? `<h4>Still open with them</h4><div class="fsec multi">${list(open.slice(0, 6))}</div>` : ''}
    ${recent.length ? `<h4>Recently</h4><div class="fsec multi">${list(recent)}</div>` : ''}
    ${ideas.length ? `<h4>Worth asking</h4><div class="fsec multi">${list(ideas)}</div>` : ''}
    ${mine ? `<h4>Your notes for this meeting</h4><div class="fsec"><p>${esc(AI.gistOf(mine, 400))}</p></div>` : ''}
    <div class="actions"><button type="button" class="btn" data-x="back">Back to the meeting</button><span class="sp"></span><button type="button" class="btn primary" data-x="close">Close</button></div></div>`, {
    back: () => openEvent(ev),
    person: btn => openPerson(guests.find(g => (g.email || '').toLowerCase() === btn.dataset.email), ev),
    // Looks up the people who have no profile yet, one after another, then shows the brief again.
    async fill(btn) {
      if (!factsKey()) return openFactsHelp(missing[0].guest, ev);
      const job = newJob();
      btn.disabled = true;
      try {
        for (let i = 0; i < missing.length; i++) {
          btn.textContent = `Looking up ${missing[i].who.name.split(' ')[0]}… (${i + 1} of ${missing.length})`;
          keepFacts(missing[i].who, await getFacts(missing[i].who, ev.title, job.signal));
          if (job.signal.aborted) return;
        }
      } catch (err) {
        if (err.name !== 'AbortError') toast(err.message, true);
      } finally {
        if (aiJob === job) aiJob = null;
      }
      if (!job.signal.aborted && btn.isConnected) openBrief(ev);
    },
  });
  asPanel();
  showPictures();
}

function openEvent(ev, writeNotes) { // writeNotes: put the cursor in the notes box straight away
  const a = acct(ev.accountId), c = a?.calendars.find(c => c.id === ev.calendarId);
  const guests = (ev.att || []).filter(p => !p.resource), everyone = guests.map(person);
  const others = everyone.filter(p => !p.self); // your own reply is shown further down, under "Are you going?"
  const key = noteKey(ev), note = N.get(key);
  const about = { title: ev.title, when: ev.s, people: others.slice(0, 30).map(p => p.email) };
  const earlier = N.withPeople(about.people, key).slice(0, 5);
  // "Last time": the most recent earlier meeting with these people that you kept notes on.
  const last = earlier.find(n => (n.when || 0) < ev.s) || null;
  const lastDay = last?.when ? dayLabel(new Date(last.when)) : '';
  const lastGist = last ? AI.gistOf(last.text) : '';
  const lastActions = last ? AI.actionsIn(last.text).map(text => {
    const task = state.tasks.find(t => t.title.toLowerCase() === text.toLowerCase());
    return { text, done: !!task?.done };
  }) : [];
  const shown = others.slice(0, 4), rest = others.slice(4, 40);
  const extras = [...(ev.links || []), ...(ev.files || []).filter(f => !(ev.links || []).some(l => l.url === f.url))].slice(0, 6);
  const face = p => (hasFacts(p.email) ? avatarHtml(p, true) : `<div class="avatar sm" style="--tc:${tagColor(p.email)}">${esc(initials(p.name))}</div>`);
  const who = (p, lookup) => `<div class="who" data-email="${esc(p.email)}">${face(p)}<div class="wbody">
      <div><button type="button" class="nm" data-x="person" data-email="${esc(p.email)}" title="Everything about this person">${esc(p.name)} ›</button>${p.organizer ? ' <i>· organiser</i>' : ''}${STATUS_LABEL[p.status] ? ` <i>· ${STATUS_LABEL[p.status]}</i>` : ''}</div>
      ${aboutLine(p.email) ? `<div class="abt">${esc(aboutLine(p.email))}</div>` : ''}
      <div class="wm">${lookup ? '<span class="met">Checking your past meetings…</span>' : ''}<span class="look">${lookupLinks(p, ev.title)}</span></div>
      ${lookupLinks(p, ev.title) ? `<div><button type="button" class="mini" data-x="facts" data-email="${esc(p.email)}">${hasFacts(p.email) ? 'See profile' : 'Get facts'}</button></div>` : ''}</div></div>`;
  // The box is laid out the way the meeting is used: who and when, the few things to press, and the
  // notes. Everything else (the people in full, last time, the invitation's details) is folded away.
  const where = ev.location && !/^https?:\/\//i.test(ev.location) && ev.location.length <= 60 ? ev.location : '';
  const chips = others.slice(0, 6), needsReply = ev.selfStatus === 'needsAction';
  const short = (text, max) => (text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, '')}…` : text);
  const replyButtons = `<span>
      <button class="btn" data-x="rsvp" data-s="accepted">Yes</button>
      <button class="btn" data-x="rsvp" data-s="tentative">Maybe</button>
      <button class="btn" data-x="rsvp" data-s="declined">No</button></span>`;
  dialog(`<div class="dbody evbox">
    <h3>${esc(ev.title)}</h3>
    <div class="meta">${esc([eventWhen(ev), where].filter(Boolean).join(' · '))}</div>
    ${others.length ? `<div class="pchips">${chips.map(p => `<button type="button" class="pchip" data-x="person" data-email="${esc(p.email)}" title="Everything about this person">${face(p)}<span>${esc(p.name)}</span></button>`).join('')}${others.length > chips.length ? `<span class="pmore">+${others.length - chips.length} more</span>` : ''}</div>` : ''}
    ${ev.meet || others.length || R.supported() ? `<div class="btnrow">
      ${ev.meet ? `<a class="btn primary" href="${esc(ev.meet)}" target="_blank" rel="noopener">Join video call</a>` : ''}
      ${R.supported() && !ev.allDay ? '<button type="button" class="btn" data-x="record">Record</button>' : ''}
      ${others.length ? '<button type="button" class="btn" data-x="brief">Brief me</button>' : ''}
      <button type="button" class="btn" data-x="recs" id="recsBtn" hidden></button></div>` : ''}
    ${needsReply ? `<div class="rowline"><span class="note">Are you going?</span>${replyButtons}</div>` : ''}
    <div class="field"><span>Your notes <i>· only you can see these</i></span>
      <textarea name="note" rows="7" maxlength="${N.MAX_LENGTH}" aria-label="Your notes" placeholder="What do you want to cover? What was decided?  Type - for a bullet, [] for a tick-box.">${esc(note?.text || '')}</textarea></div>
    <div class="airow">
      ${AI.supported() ? '<button type="button" class="mini" data-x="tidy">Tidy my notes</button>' : ''}
      <button type="button" class="mini" data-x="mktasks" hidden>Make tasks</button>
      <button type="button" class="mini" data-x="untidy" hidden>Undo tidy</button>
      <button type="button" class="mini" data-x="followup" hidden>Follow-up email</button>
      <span class="sp"></span><span class="saved" id="noteState"></span></div>
    ${last ? `<details class="rfold"${ev.e > Date.now() ? ' open' : ''}><summary>Last time${lastDay ? ` · ${esc(lastDay)}` : ''}<i>${esc(short(lastGist, 64))}</i></summary>
    <div class="last"><div class="lt2">${esc(last.title || 'Meeting')}</div>
      <div class="desc">${esc(lastGist)}</div>
      ${lastActions.length ? `<div class="todo">${lastActions.map(x => `<div class="${x.done ? 'done' : ''}">${x.done ? '✓' : '•'} ${esc(x.text)}</div>`).join('')}</div>` : ''}
      <div><button type="button" class="mini" data-x="uselast">Add to my notes</button></div></div></details>` : ''}
    ${others.length ? `<details class="rfold"><summary>People<i>${others.length} · look them up, see what you know</i></summary>
      <div class="whos">${shown.map(p => who(p, true)).join('')}${rest.map(p => who(p, false)).join('')}</div></details>` : ''}
    <details class="rfold"><summary>Details<i>${esc(short([a?.email, ev.description ? 'invitation text' : '', extras.length ? 'links' : ''].filter(Boolean).join(' · '), 64))}</i></summary>
      <div class="meta"><span class="dot" style="background:${hue(a?.color)}"></span>${esc(a?.email || '')}${c && !c.primary ? ' · ' + esc(c.summary) : ''}</div>
      ${ev.location && !where ? `<div class="meta">${esc(ev.location)}</div>` : ''}
      ${extras.length ? `<div class="btnrow">${extras.map(x => `<a class="btn" href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)}</a>`).join('')}</div>` : ''}
      ${ev.description ? `<div class="desc">${esc(ev.description)}</div>` : ''}
      ${earlier.length ? `<details><summary>All earlier notes with ${others.length === 1 ? esc(others[0].name) : 'these people'} (${earlier.length})</summary>
      <div class="past">${earlier.map(n => `<div><b>${esc(n.title || 'Meeting')}</b>${n.when ? ` <i>· ${esc(dayLabel(new Date(n.when)))}</i>` : ''}<div class="desc">${esc(n.text)}</div></div>`).join('')}</div></details>` : ''}
      ${ev.selfStatus && !needsReply ? `<div class="rowline"><span class="note">Are you going? <b>${STATUS_LABEL[ev.selfStatus] || ''}</b></span>${replyButtons}</div>` : ''}
      ${ev.htmlLink ? `<div><a class="linkbtn" href="${esc(ev.htmlLink)}" target="_blank" rel="noopener">Open in Google Calendar</a></div>` : ''}
    </details>
    <div class="actions">
      ${ev.calWritable ? '<button class="btn danger" data-x="del">Delete</button>' : ''}
      ${ev.canEdit && !ev.allDay ? '<button class="btn" data-x="edit">Edit</button>' : ''}
      <span class="sp"></span>
      <button class="btn${ev.meet ? '' : ' primary'}" data-x="close">Close</button>
    </div></div>`, {
    edit: () => openEventForm(ev),
    person: btn => openPerson(guests.find(g => (g.email || '').toLowerCase() === btn.dataset.email), ev),
    brief: () => openBrief(ev),
    record: () => quickRecord(ev),
    recs: () => openRecordings(ev),
    // Opens a draft in Gmail, written from your notes. Nothing is sent: you read it and press Send yourself.
    followup() {
      const text = $('[name=note]', el.dlg).value, to = outsiders(ev).map(x => x.who);
      const summary = /^Summary\n/.test(text.trim()) ? AI.gistOf(text, 600) : '', agreed = AI.decisionsIn(text), next = AI.actionsIn(text);
      const sameDay = startOfDay(new Date(ev.s)).getTime() === startOfDay(new Date()).getTime();
      const lines = [`Hi ${to.slice(0, 3).map(w => w.name.split(' ')[0]).join(', ') || 'there'},`, '', `Thank you for your time ${sameDay ? 'today' : `on ${dayLabel(new Date(ev.s))}`}. A short recap of our conversation:`, ''];
      if (summary) lines.push(summary, '');
      if (agreed.length) lines.push('What we agreed:', ...agreed.map(x => `- ${x}`), '');
      if (next.length) lines.push('Next steps:', ...next.map(x => `- ${x}`), '');
      if (!summary && !agreed.length && !next.length) lines.push([...AI.originalOf(text).trim()].slice(0, 1200).join(''), '');
      lines.push('Best regards,');
      window.open(`https://mail.google.com/mail/?authuser=${G.enc(a?.email || '')}&view=cm&fs=1&to=${G.enc(to.map(w => w.email).join(','))}`
        + `&su=${G.enc(`Follow-up: ${ev.title}`)}&body=${G.enc([...lines.join('\n')].slice(0, 1800).join(''))}`, '_blank', 'noopener');
      toast('A draft opened in Gmail. Read it before you send.');
    },
    // Looks the person up on the web, saves what it finds about them, then shows their page.
    async facts(btn) {
      const guest = guests.find(g => (g.email || '').toLowerCase() === btn.dataset.email), who = person(guest);
      if (hasFacts(who.email)) return openPerson(guest, ev);
      if (!factsKey()) return openFactsHelp(guest, ev);
      const job = newJob();
      btn.disabled = true;
      btn.textContent = 'Searching the web… about 20 seconds';
      try {
        const answer = await getFacts(who, ev.title, job.signal);
        if (job.signal.aborted) return;
        keepFacts(who, answer);
        if (btn.isConnected) openPerson(guest, ev);
      } catch (err) {
        if (err.name !== 'AbortError') toast(err.message, true);
      } finally {
        if (aiJob === job) aiJob = null;
        if (btn.isConnected) { btn.disabled = false; btn.textContent = 'Get facts'; }
      }
    },
    // Copies the reminder of last time to the top of this meeting's notes.
    uselast(btn) {
      const open = lastActions.filter(x => !x.done).map(x => `- ${x.text}`);
      const lines = [`Last time${lastDay ? ` (${lastDay})` : ''}: ${lastGist}`];
      if (open.length) lines.push('Still open from last time:', ...open);
      box.value = `${lines.join('\n')}${box.value.trim() ? `\n\n${box.value}` : ''}`;
      btn.hidden = true;
      commitNote();
    },
    // The browser's own AI turns rough notes into a summary, decisions and action points.
    async tidy(btn) {
      const rough = AI.originalOf(box.value).trim();
      if (rough.length < 15) return toast('Write a few notes first, then press Tidy.');
      // Tidying a second time: keep what you put above the summary and any points you added by hand.
      const markAt = box.value.indexOf(AI.ORIGINAL_MARK), tidied = markAt < 0 ? '' : box.value.slice(0, markAt);
      const head = tidied ? tidied.split(/^Summary$/m)[0].trim() : '';
      const kept = { actions: tidied ? AI.actionsIn(tidied) : [], decisions: tidied ? AI.decisionsIn(tidied) : [] };
      const words = x => new Set(x.toLowerCase().match(/[a-z0-9]{4,}/g) || []);
      const alike = (a, b) => { const wa = words(a), wb = words(b); let n = 0; for (const w of wa) if (wb.has(w)) n++; return n >= Math.max(1, Math.min(wa.size, wb.size) * 0.6); };
      const job = newJob(), label = btn.textContent;
      btn.disabled = box.readOnly = true;
      btn.textContent = 'Tidying…';
      saved.textContent = 'This can take a minute or two. It runs on your computer.';
      try {
        const result = await AI.tidy({ title: ev.title, people: others.map(p => p.name).join(', '), text: rough },
          { signal: job.signal, onProgress: part => { if (part < 1) saved.textContent = `Getting the AI ready… ${Math.round(part * 100)}%`; } });
        if (job.signal.aborted || !box.isConnected) return;
        beforeTidy = box.value;
        for (const part of ['actions', 'decisions']) for (const x of kept[part]) if (!result[part].some(y => alike(x, y))) result[part].push(x);
        box.value = `${head ? `${head}\n\n` : ''}${AI.layout(result, rough)}`;
        commitNote();
        saved.textContent = 'Tidied';
        $('[data-x=untidy]', el.dlg).hidden = false;
        showTaskButton();
      } catch (err) {
        if (err.name !== 'AbortError' && box.isConnected) { saved.textContent = ''; toast(AI.explain(err), true); }
      } finally {
        if (aiJob === job) aiJob = null;
        btn.disabled = box.readOnly = false;
        btn.textContent = label;
      }
    },
    untidy(btn) {
      if (beforeTidy == null) return;
      box.value = beforeTidy;
      beforeTidy = null;
      btn.hidden = true;
      commitNote();
      showTaskButton();
    },
    // Each action point becomes a task in the inbox.
    mktasks() {
      commitNote();
      tasksFromNotes(box.value, `${ev.title} (${dayLabel(new Date(ev.s))})`, new Date(ev.s));
    },
    async rsvp(btn) {
      if (DEMO) return toast('This is sample data. Connect a Google account to reply to invites.');
      try {
        const att = ev.att.map(p => p.self ? { ...p, responseStatus: btn.dataset.s } : p);
        await G.api(a, `/calendars/${G.enc(ev.calendarId)}/events/${G.enc(ev.id)}`, { method: 'PATCH', body: { attendees: att } });
        ev.att = att; ev.selfStatus = btn.dataset.s;
        closeDialog(); render(); toast('Reply sent'); refresh();
      } catch (err) { toast(err.message, true); }
    },
    async del() {
      if (DEMO) return toast('This is sample data. Connect a Google account to change events.');
      const guests = ev.organizerSelf && (ev.att || []).length > 0;
      if (!confirm(guests ? 'Delete this event? Guests will be told it is cancelled.' : 'Delete this event from your calendar?')) return;
      try {
        await G.api(a, `/calendars/${G.enc(ev.calendarId)}/events/${G.enc(ev.id)}`, { method: 'DELETE', params: { sendUpdates: guests ? 'all' : 'none' } });
        events.delete(ev.key);
        closeDialog(); render(); toast('Event deleted');
      } catch (err) { toast(err.message, true); }
    },
  });

  // Notes save by themselves a moment after you stop typing, and when the box closes.
  asPanel();
  const box = $('[name=note]', el.dlg), saved = $('#noteState', el.dlg);
  E.attach(box); // headings, bullets and tick-boxes; the box itself still holds the plain text
  let timer = 0, beforeTidy = null;
  const showTaskButton = () => {
    const n = AI.actionsIn(box.value).length, b = $('[data-x=mktasks]', el.dlg);
    b.hidden = !n;
    b.textContent = n === 1 ? 'Make 1 task' : `Make ${n} tasks`;
    $('[data-x=followup]', el.dlg).hidden = !box.value.trim() || ev.s > Date.now() || !outsiders(ev).length;
  };
  showTaskButton();
  box.dataset.key = key; // lets notes written from a recording appear here while the box is open
  if (R.current()?.rec.key === key) { box.classList.add('pad'); box.placeholder = 'Type as you go: key points, decisions, who does what. They are blended into the notes when the recording ends.'; }
  let lastNote = box.value; // only what you changed in the box is saved, never an old copy over newer text
  const commitNote = () => {
    clearTimeout(timer);
    if (box.value === lastNote) return;
    lastNote = box.value;
    if (box.value.length > N.MAX_LENGTH) toast('These notes are too long to keep in full. The end will be cut off: shorten them a little.', true);
    if (!N.set(key, box.value.trim() ? box.value : '', about)) return;
    scheduleFlush();
    if (saved.isConnected) saved.textContent = plannerReady() ? 'Saved' : 'Saved on this device';
    renderView(); // shows or hides the small note mark on the meeting
  };
  box.addEventListener('input', () => { saved.textContent = ''; showTaskButton(); clearTimeout(timer); timer = setTimeout(commitNote, 600); });
  box.addEventListener('change', commitNote);
  noteCommit = commitNote;
  R.forMeeting(key).then(list => { // recordings of this meeting, if there are any
    const b = $('#recsBtn', el.dlg);
    if (b && list.length) { b.hidden = false; b.textContent = list.length === 1 ? '1 recording' : `${list.length} recordings`; }
  }).catch(() => {});
  if (others.length) firstTip('meeting');
  showPictures();
  if (writeNotes) { box.scrollIntoView({ block: 'center' }); box.focus(); }

  // Fill in the history with each of the first few people.
  for (const p of shown) {
    meetingsWith(p.email).then(list => {
      const row = el.dlg.querySelector(`.who[data-email="${CSS.escape(p.email)}"]`);
      if (!row) return;
      row.querySelector('.met').textContent = metLine(list, key);
      const better = person(guests.find(g => (g.email || '').toLowerCase() === p.email)); // a fuller name may have turned up
      if (better.name !== p.name) { const chip = el.dlg.querySelector(`.pchip[data-email="${CSS.escape(p.email)}"] span`); if (chip) chip.textContent = better.name; row.querySelector('.nm').textContent = `${better.name} ›`; row.querySelector('.look').innerHTML = lookupLinks(better, ev.title); }
      saveNames();
    }).catch(() => {});
  }
}

function openEventForm(ev) {
  if (DEMO) return toast('This is sample data. Connect a Google account to add events.');
  const targets = [];
  for (const a of state.accounts) {
    if (a.needsReconnect) continue;
    for (const c of a.calendars) {
      if (isPlannerCal(a, c) || !['owner', 'writer'].includes(c.accessRole)) continue;
      targets.push([`${a.id}|${c.id}`, c.primary ? a.email : `${a.email} · ${c.summary}`, c.primary]);
    }
  }
  if (!targets.length) return openSettings('Connect a Google account first, then you can add events to it.', 'accounts');
  targets.sort((x, y) => y[2] - x[2]);
  const s = ev ? new Date(ev.s) : null, e = ev ? new Date(ev.e) : null;
  const defStart = Math.min(23 * 60, Math.ceil((nowMinutes() + 1) / 30) * 30);
  dialog(`<form class="dbody">
    <h3>${ev ? 'Edit event' : 'New event'}</h3>
    ${ev ? '' : `<label>Add to which account?<select name="target">${opts(targets, targets[0][0])}</select></label>`}
    <label>Title<input name="title" required value="${esc(ev?.title || '')}" autocomplete="off"></label>
    <div class="row">
      <label>Day<input type="date" name="date" required value="${ev ? ymd(s) : ymd(view === 'day' ? cursor : new Date())}"></label>
      <label>Start<input type="time" name="start" required value="${ev ? hhmm(s.getHours() * 60 + s.getMinutes()) : hhmm(defStart)}"></label>
      <label>End<input type="time" name="end" required value="${ev ? hhmm(e.getHours() * 60 + e.getMinutes()) : hhmm(defStart + 30)}"></label>
    </div>
    <label>Location<input name="location" value="${esc(ev?.location || '')}" autocomplete="off"></label>
    ${ev ? '' : `<label>Guests (email addresses, separated by commas)<input name="guests" autocomplete="off" placeholder="Optional. Guests get an invite email."></label>
    <label>Notes<textarea name="description" rows="2"></textarea></label>
    <label class="check"><input type="checkbox" name="meet"> Add a Google Meet video link</label>`}
    <div class="actions"><span class="sp"></span>
      <button type="button" class="btn ghost" data-x="close">Cancel</button>
      <button class="btn primary">${ev ? 'Save' : 'Add event'}</button></div></form>`, {
    async submit(fd, form) {
      const date = fd.get('date'), st = fd.get('start'), en = fd.get('end');
      if (parseHhmm(en) === parseHhmm(st)) return toast('The end time must be different from the start time.', true);
      const endDate = parseHhmm(en) < parseHhmm(st) ? ymd(addDays(fromYmd(date), 1)) : date; // ends after midnight
      const body = { summary: fd.get('title').trim(), location: fd.get('location').trim() };
      const sameTimes = ev && date === ymd(s) && st === hhmm(s.getHours() * 60 + s.getMinutes()) && en === hhmm(e.getHours() * 60 + e.getMinutes());
      if (!sameTimes) Object.assign(body, { start: { dateTime: `${date}T${st}:00`, timeZone: TZ }, end: { dateTime: `${endDate}T${en}:00`, timeZone: TZ } });
      const btn = $('button.primary', form);
      btn.disabled = true;
      try {
        if (ev) {
          await G.api(acct(ev.accountId), `/calendars/${G.enc(ev.calendarId)}/events/${G.enc(ev.id)}`,
            { method: 'PATCH', body, params: { sendUpdates: (ev.att || []).length ? 'all' : 'none' } });
        } else {
          const [aid, cid] = fd.get('target').split('|');
          const guests = (fd.get('guests') || '').split(/[\s,;]+/).filter(x => x.includes('@'));
          const params = { sendUpdates: guests.length ? 'all' : 'none' };
          if (guests.length) body.attendees = guests.map(email => ({ email }));
          if (fd.get('description')?.trim()) body.description = fd.get('description').trim();
          if (fd.get('meet')) {
            body.conferenceData = { createRequest: { requestId: uid(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
            params.conferenceDataVersion = 1;
          }
          await G.api(acct(aid), `/calendars/${G.enc(cid)}/events`, { method: 'POST', body, params });
        }
        closeDialog();
        toast(ev ? 'Event updated' : 'Event added');
        goTo(fromYmd(date));
      } catch (err) { btn.disabled = false; toast(err.message, true); }
    },
  });
}

// ---------------------------------------------------------------- Google sync

function normalize(e, a, c) {
  learnNames(e);
  const allDay = !!e.start?.date;
  const self = (e.attendees || []).find(p => p.self);
  const calWritable = ['owner', 'writer'].includes(c.accessRole);
  const entry = (e.conferenceData?.entryPoints || []).find(p => p.entryPointType === 'video' && /^https:\/\//.test(p.uri || ''))?.uri;
  // Meetings Google makes from an email carry two stock paragraphs, in the language of that Google
  // account. They are left out.
  let text = (e.description || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
  const mail = text.match(/https:\/\/mail\.google\.com\/mail\?extsrc=cal[^\s"'<>]*/)?.[0] || '';
  if (mail || e.eventType === 'fromGmail') text = text.split(/\n\s*\n/).filter(para => !/g\.co\/calendar|mail\.google\.com\/mail\?extsrc=cal/.test(para)).join('\n\n').trim();
  return {
    key: `${a.id}|${c.id}|${e.id}`, id: e.id, accountId: a.id, calendarId: c.id,
    title: e.summary || '(No title)',
    s: allDay ? fromYmd(e.start.date).getTime() : Date.parse(e.start.dateTime),
    e: allDay ? fromYmd(e.end.date).getTime() : Date.parse(e.end.dateTime),
    allDay, location: e.location || '', htmlLink: webLink(e.htmlLink),
    meet: webLink(e.hangoutLink) || webLink(entry) || `${e.location || ''} ${e.description || ''}`.match(VIDEO_RE)?.[0] || '',
    description: text.slice(0, 2000),
    att: e.attendees || [], selfStatus: self?.responseStatus || null,
    organizerSelf: !!e.organizer?.self, calWritable,
    canEdit: calWritable && (!!e.organizer?.self || !(e.attendees || []).length),
    nk: N.keyFor(e),
    files: (e.attachments || []).filter(f => /^https:\/\//.test(f.fileUrl || '')).slice(0, 6).map(f => ({ label: f.title || 'Attached file', url: f.fileUrl })),
    links: noteLinks(`${e.description || ''} ${e.location || ''}`),
  };
}

// Links to meeting-notes apps found in a meeting's description, so the notes are one press away.
const NOTE_APPS = [
  ['Fireflies', /https:\/\/app\.fireflies\.ai\/[^\s"'<>]+/i], ['Otter', /https:\/\/otter\.ai\/[^\s"'<>]+/i],
  ['Fathom', /https:\/\/(?:app\.)?fathom\.video\/[^\s"'<>]+/i], ['Granola', /https:\/\/(?:notes\.|app\.)?granola\.(?:ai|so)\/[^\s"'<>]+/i],
  ['tl;dv', /https:\/\/(?:app\.)?tldv\.io\/[^\s"'<>]+/i], ['Read', /https:\/\/app\.read\.ai\/[^\s"'<>]+/i],
  ['Notion', /https:\/\/(?:www\.)?notion\.so\/[^\s"'<>]+/i], ['Google Doc', /https:\/\/docs\.google\.com\/document\/[^\s"'<>]+/i],
];
function noteLinks(text) {
  const out = [];
  for (const [name, re] of NOTE_APPS) {
    const url = re.exec(text)?.[0].replace(/&amp;/g, '&');
    if (url) out.push({ label: name === 'Google Doc' || name === 'Notion' ? `Open ${name}` : `${name} notes`, url });
  }
  return out;
}
const noteKey = ev => ev.nk || ev.id;
const hasFacts = email => (N.get(N.aboutKey(email))?.text || '').includes(F.MARK);
// Runs "Get facts". A key without Google's own web search is remembered for a few days, so the
// free way (reading search result pages) is used straight away instead of asking and being refused.
// The keys you added in Settings. Google's, Claude's and Tavily's keep their first places; the rest
// are kept by the name of their service.
const aiKeyOf = id => { const s = state.settings; return (id === 'google' ? s.aiKey : id === 'claude' ? s.claudeKey : s.aiKeys?.[id]) || ''; };
const searchKind = () => S.searchService(state.settings.searchProvider).id;
const searchKeyOf = id => { const s = state.settings; return (id === 'tavily' ? s.searchKey : s.searchKeys?.[id]) || ''; };
// Whether "Get facts" can run: the chosen AI service has its key (one on your own computer needs none).
const factsKey = () => { const svc = S.aiService(state.settings.aiProvider); return svc.noKey ? 'none needed' : aiKeyOf(svc.id); };
async function getFacts(who, meeting, signal, hint = '') {
  const photos = findPhotos(who, hint, signal); // runs alongside the lookup
  const answer = await lookUp(who, meeting, signal, hint);
  // The AI's words may have been steered by a page it read: any picture address in them is dropped.
  const text = answer.text.split('\n').filter(line => !/^\s*[-*•]?\s*photos?\s*:/i.test(line)).join('\n');
  return { ...answer, text: text + await photoLines(await photos, savedFacts(who.email), hint) };
}
// What is already saved about the person's company (from a colleague's profile, in the last month) is
// not searched for again: it is copied in, which saves half the searches.
const firmLines = f => [f.company && `Company: ${f.company}`, f.teamSize && `Team size: ${f.teamSize}`,
  f.funding.length && `Funding:\n${f.funding.map(x => `- ${x}`).join('\n')}`, f.people.length && `Key people:\n${f.people.map(x => `- ${x}`).join('\n')}`,
  f.clients.length && `Clients: ${f.clients.join(', ')}`].filter(Boolean).join('\n');
async function lookUp(person0, meeting, signal, hint) {
  const firm = person0.company && !hasFacts(person0.email) ? companyFacts(person0.domain) : null;
  const canSearch = !!searchKeyOf(searchKind()) || !!S.aiService(state.settings.aiProvider).ownSearch; // not the website-only way, which is all about the company
  const known = canSearch && firm?.company && firm.when > Date.now() - 30 * 86400000 ? firm : null;
  const answer = await lookUpWith(known ? { ...person0, skipFirm: true } : person0, meeting, signal, hint);
  return known ? { ...answer, text: `${answer.text}\n${firmLines(known)}` } : answer;
}
async function lookUpWith(who, meeting, signal, hint) {
  const s = state.settings, svc = S.aiService(s.aiProvider);
  if (svc.kind === 'claude') { // Claude with its own web search
    const C = await import('./claude.js');
    return { ...(await C.personFacts(who, meeting, s.claudeKey, signal, hint)), hint };
  }
  const keys = { provider: svc.id, key: aiKeyOf(svc.id), model: s.aiModels?.[svc.id] || '', google: s.aiKey, search: searchKeyOf(searchKind()), searchKind: searchKind() };
  if (svc.kind !== 'google') return { ...(await F.personFacts(who, meeting, keys, signal, false, hint)), hint };
  const freeLately = s.aiFreeSince && Date.now() - s.aiFreeSince < 3 * 86400000;
  const answer = await F.personFacts(who, meeting, keys, signal, !freeLately, hint);
  const wasFree = !!s.aiFreeSince;
  if (answer.how !== 'search' && !freeLately && answer.noSearch) s.aiFreeSince = Date.now(); // only when Google said so for certain: skip its search for a few days
  if (answer.how === 'search') s.aiFreeSince = 0;
  if (wasFree !== !!s.aiFreeSince || answer.how !== 'search') save();
  return { ...answer, hint };
}
// Saves what was found into the person's note, keeping what you wrote about them yourself.
function keepFacts(who, answer) {
  const key = N.aboutKey(who.email);
  N.set(key, F.mergeInto(N.get(key)?.text || '', answer, dayLabel(new Date())).slice(0, N.MAX_LENGTH), { title: who.name, when: Date.now(), people: [who.email] });
  scheduleFlush();
}

// When switched on in Settings: quietly gets facts for the people in today's meetings, so their
// profiles are ready before you open the meeting. Colleagues (same email domain as one of your own
// accounts) are skipped, and nobody is looked up more than once a week.
let autoRunning = false, autoPausedUntil = 0;
async function autoFacts() {
  if (DEMO || autoRunning || aiJob || !state.settings.aiAuto || !factsKey() || document.hidden || Date.now() < autoPausedUntil) return;
  const from = startOfDay(new Date()).getTime(), to = from + 86400000, weekAgo = Date.now() - 7 * 86400000;
  const mine = new Set(state.accounts.map(a => a.email.split('@')[1]));
  const tried = (state.factsTried ||= {});
  const todo = new Map();
  for (const ev of events.values()) {
    if (ev.s < from || ev.s >= to || ev.selfStatus === 'declined' || !enabledEvent(ev)) continue;
    for (const guest of (ev.att || []).filter(g => !g.resource)) {
      const who = person(guest);
      if (who.self || mine.has(who.email.split('@')[1]) || (!who.fullName && !who.company)) continue;
      if (hasFacts(who.email) || tried[who.email] > weekAgo || todo.has(who.email)) continue;
      todo.set(who.email, { who, title: ev.title });
    }
  }
  if (!todo.size) return;
  autoRunning = true;
  let ready = 0;
  try {
    for (const { who, title } of [...todo.values()].slice(0, 5)) {
      try {
        keepFacts(who, await getFacts(who, title));
        tried[who.email] = Date.now();
        ready++;
      } catch (err) {
        console.warn('Could not get facts for', who.email, err.message);
        if (['key', 'credit', 'billing', 'model', 'nosearch', 'offline'].includes(err.kind)) { autoPausedUntil = Date.now() + 3600000; break; } // the key or the connection: stop for an hour
        tried[who.email] = ['slow', 'busy'].includes(err.kind) ? Date.now() - 6 * 86400000 // the AI was busy: try this person again tomorrow
          : Date.now(); // this person could not be found: leave them for a week and carry on with the others
      }
      save();
      await new Promise(r => setTimeout(r, 3000));
    }
  } finally { autoRunning = false; }
  if (ready) {
    if (!el.dlg.open) toast(ready === 1 ? 'A profile is ready for someone you are meeting today.' : `Profiles are ready for ${ready} people you are meeting today.`);
    renderView();
  }
}

let refreshSeq = 0, refreshedAt = 0;
async function refresh() {
  refreshedAt = Date.now();
  const [from, to] = range(), today = startOfDay(new Date());
  const ranges = [[from, to]];
  if (today < from || today >= to) ranges.push([today, addDays(today, 2)]); // keep today fresh for reminders
  if (DEMO) {
    for (const [f, t] of ranges) for (let ws = startOfWeek(f); ws < t; ws = addDays(ws, 7)) for (const ev of demoEvents(ws)) events.set(ev.key, ev);
    if (!dragging) render();
    return;
  }
  const live = state.accounts.filter(a => !a.needsReconnect);
  if (!live.length) { setStatus(state.accounts.length ? 'Reconnect needed' : '', true); return; }
  const seq = ++refreshSeq;
  setStatus('Updating…');
  const failed = []; // { a, c, err } for each calendar that could not be read
  const jobs = [];
  for (const [f, t] of ranges) for (const a of live) for (const c of a.calendars) {
    if (!c.enabled || isPlannerCal(a, c)) continue;
    jobs.push(G.listEvents(a, c.id, f, t).then(items => {
      const f0 = f.getTime(), t0 = t.getTime();
      for (const [k, ev] of events) if (ev.accountId === a.id && ev.calendarId === c.id && ev.e > f0 && ev.s < t0) events.delete(k);
      for (const e of items) {
        if (e.status === 'cancelled' || !e.start || e.eventType === 'workingLocation') continue;
        const ev = normalize(e, a, c);
        events.set(ev.key, ev);
      }
    }).catch(err => { if (!failed.some(x => x.a === a && x.c === c)) failed.push({ a, c, err }); console.warn(a.email, c.summary, err); }));
  }
  await Promise.all(jobs);
  // A calendar that is gone from an account: read that account's list again, so it drops out by itself.
  let healed = false;
  for (const a of new Set(failed.filter(x => [404, 410].includes(x.err.status)).map(x => x.a))) {
    const before = a.calendars.map(c => c.id).join('|');
    await G.refreshCalendars(a).catch(() => {});
    healed ||= a.calendars.map(c => c.id).join('|') !== before;
  }
  if (healed) { renderSide(); setTimeout(refresh, 400); } // the list was out of date: read the right calendars straight away
  const ws = startOfWeek(today).getTime(), we = addDays(startOfWeek(today), 7).getTime();
  saveEventCache(ymd(startOfWeek(today)), [...events.values()].filter(ev => ev.e > ws && ev.s < we));
  const noGoogle = failed.length > 0 && failed.every(x => x.err.kind === 'unreachable'); // nothing answered: no point in waiting on more
  let tasksCut = false; // the "Weftday" calendar itself could not be reached
  if (plannerReady() && !noGoogle) tasksCut = (await sync(() => pullPlanner(from, to)))?.kind === 'unreachable';
  if (plannerReady() && !noGoogle && !tasksCut) await sync(() => N.pull().catch(err => console.warn('Reading notes failed', err)));
  saveNames();
  if (!noGoogle) setTimeout(autoFacts, 1500);
  if (seq !== refreshSeq) return;
  if (!dragging) render();
  const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  syncProblems = failed.filter(x => x.a.calendars.includes(x.c)); // ones that dropped out of the list above are settled
  if (tasksCut && !syncProblems.length) syncProblems = [{ a: {}, c: {}, err: { kind: 'unreachable' } }];
  const cut = syncProblems.length && syncProblems.every(x => x.err.kind === 'unreachable');
  if (state.accounts.some(a => a.needsReconnect)) setStatus('An account needs reconnecting', true);
  else if (cut) tellProblem('Can’t reach Google Calendar · Why?');
  else if (syncProblems.length === 1) tellProblem(`“${syncProblems[0].c.summary}” could not be updated · Why?`);
  else if (syncProblems.length) tellProblem(`${syncProblems.length} calendars could not be updated · Why?`);
  else { toldProblem = ''; setStatus(`Updated ${time}`); }
}

// Why a calendar could not be read, in plain words.
let syncProblems = [], toldProblem = '';
// Shows the problem in the top bar; on a phone, where that line is hidden, as a message (once per problem).
function tellProblem(text) {
  setStatus(text, true);
  if (innerWidth < 760 && toldProblem !== text && !el.dlg.open) toast(text.replace(' · Why?', ''), { err: true, go: ['Why?', openSyncProblems] });
  toldProblem = text;
}
function whyFailed(err) {
  if (err.kind === 'unreachable') return 'Google Calendar could not be reached.';
  if (err.status === 401 || err.code === 'invalid_grant') return 'The sign-in for this account has run out. Reconnect the account.';
  if (err.status === 403 && /rate|quota|limit/i.test(err.message || '')) return 'Google is holding back requests for the moment. It works again in a few minutes.';
  if (err.status === 403) return 'Google says you no longer have access to this calendar.';
  if (err.status === 404 || err.status === 410) return 'This calendar no longer exists in this account, or is no longer shared with it.';
  if (err.status >= 500) return 'Google Calendar had a problem on its side. Try again in a minute.';
  return err.message || 'Google gave no reason.';
}
// Opened by pressing the red message in the top bar: what exactly failed, and what to do about it.
function openSyncProblems() {
  if (!syncProblems.length) return;
  const cut = syncProblems.every(x => x.err.kind === 'unreachable');
  const rows = syncProblems.slice(0, 12).map((x, i) => `<div class="srow"><span class="dot" style="background:${hue(x.a.color)}"></span>
    <div class="st"><b>${esc(x.c.summary || 'Calendar')}</b><span>${esc(x.a.email)} · ${esc(whyFailed(x.err))}</span></div>
    ${[403, 404, 410].includes(x.err.status) ? `<button type="button" class="btn" data-x="hide" data-i="${i}">Hide it</button>` : ''}</div>`).join('');
  dialog(`<div class="dbody">
    <h3>${cut ? 'Google Calendar can’t be reached' : syncProblems.length === 1 ? 'One calendar could not be updated' : `${syncProblems.length} calendars could not be updated`}</h3>
    ${cut ? `<p>Weftday asked Google for your calendars and got no answer from this device. Other websites may still work.</p>
      <ol class="steps"><li>Check that you are online.</li>
        <li>If a <b>VPN</b> is on, switch it off or change its server, then try again. Some VPNs and office networks block Google Calendar.</li>
        <li>Try opening <a href="https://calendar.google.com" target="_blank" rel="noopener">calendar.google.com</a>. If that does not open either, the network is the cause.</li></ol>
      <p class="note">Until then Weftday shows what it last loaded. Nothing is lost; tasks you add are kept here and sent to Google when it can be reached again.</p>`
    : `<p class="note">The rest of your calendars are up to date.</p><div class="sgroup">${rows}</div>`}
    <div class="actions"><span class="sp"></span><button type="button" class="btn ghost" data-x="close">Close</button><button type="button" class="btn primary" data-x="again">Try again</button></div></div>`, {
    again: () => { closeDialog(); refresh(); },
    hide(x) { // stop showing a calendar that Google no longer gives this account
      const p = syncProblems[+x.dataset.i];
      p.c.enabled = false;
      save();
      syncProblems = syncProblems.filter(y => y !== p);
      if (syncProblems.length) openSyncProblems(); else { closeDialog(); refresh(); }
      renderSide();
    },
  });
}

// All reads and writes of the planner calendar run one after another.
let chain = Promise.resolve();
const sync = fn => (chain = chain.then(fn, fn));

function taskToEvent(t) {
  const rem = t.reminder == null ? state.settings.reminder : t.reminder;
  const body = {
    summary: (t.done ? '✓ ' : '') + t.title,
    description: t.notes || '',
    extendedProperties: { private: {
      plannerTask: '1', taskId: t.id, done: t.done ? '1' : '0', priority: t.priority,
      tag: t.tag || '', repeat: t.repeat || 'none', seriesId: t.seriesId || '', duration: String(t.duration), reminder: t.reminder == null ? '' : String(t.reminder),
    } },
    reminders: { useDefault: false, overrides: (rem >= 0 && !t.done && t.date && t.start != null) ? [{ method: 'popup', minutes: rem }] : [] },
  };
  if (!t.date) {
    // No date yet: parked on a fixed day far in the past so every device shares the same inbox.
    body.start = { date: INBOX_DATE };
    body.end = { date: ymd(addDays(fromYmd(INBOX_DATE), 1)) };
    body.transparency = 'transparent';
  } else if (t.start == null) {
    body.start = { date: t.date };
    body.end = { date: ymd(addDays(fromYmd(t.date), 1)) };
  } else {
    const s = fromYmd(t.date); s.setMinutes(t.start);
    const e = new Date(s.getTime() + t.duration * 60000);
    body.start = { dateTime: localIso(s), timeZone: TZ };
    body.end = { dateTime: localIso(e), timeZone: TZ };
  }
  return body;
}

function applyEvent(t, e) {
  const p = e.extendedProperties?.private || {};
  const raw = e.summary || '(No title)';
  t.done = p.done === '1' || raw.startsWith('✓ ');
  t.title = raw.replace(/^✓ /, '');
  if (e.start.date) {
    t.date = e.start.date === INBOX_DATE ? null : e.start.date;
    t.start = null;
    if (+p.duration > 0) t.duration = +p.duration;
  } else {
    const s = new Date(e.start.dateTime), en = new Date(e.end.dateTime);
    t.date = ymd(s); t.start = s.getHours() * 60 + s.getMinutes();
    t.duration = Math.max(SNAP, Math.round((en - s) / 60000));
  }
  t.notes = e.description || '';
  if (p.plannerTask) {
    t.priority = p.priority || 'normal'; t.tag = p.tag || '';
    t.repeat = p.repeat || 'none'; t.seriesId = SAFE_ID.test(p.seriesId || '') ? p.seriesId : null;
    if (p.reminder !== undefined) t.reminder = p.reminder === '' ? null : +p.reminder;
  }
  t.gEventId = e.id; t.remoteUpdated = e.updated; t.dirty = false;
}

async function flush() {
  if (!plannerReady() || isStale()) return; // a copy left in the background writes nothing
  const a = plannerAccount(), base = `/calendars/${G.enc(state.settings.plannerCalendarId)}/events`;
  const gone = err => err.status === 404 || err.status === 410;
  try {
    while (state.tombstones.length) {
      const id = state.tombstones[0];
      try { await G.api(a, `${base}/${G.enc(id)}`, { method: 'DELETE' }); }
      catch (err) { if (!gone(err)) throw err; }
      const i = state.tombstones.indexOf(id);
      if (i >= 0) state.tombstones.splice(i, 1);
      else { const t = state.tasks.find(t => t.gEventId === id); if (t) { t.gEventId = null; touch(t); } } // delete was undone meanwhile
      save();
    }
    for (const t of state.tasks.filter(t => t.dirty)) {
      const rev = t.rev, body = taskToEvent(t);
      let res = null;
      if (t.gEventId) {
        try { res = await G.api(a, `${base}/${G.enc(t.gEventId)}`, { method: 'PUT', body }); }
        catch (err) { if (!gone(err)) throw err; }
      }
      if (!res) res = await G.api(a, base, { method: 'POST', body });
      if (!state.tasks.includes(t)) { if (!state.tombstones.includes(res.id)) state.tombstones.push(res.id); save(); continue; }
      t.gEventId = res.id; t.remoteUpdated = res.updated;
      if (t.rev === rev) t.dirty = false;
      save();
    }
    await N.push(); // meeting notes ride along
    if (state.tombstones.length || state.tasks.some(t => t.dirty) || N.pending()) scheduleFlush();
    else if (el.status.textContent.startsWith('Could not save')) setStatus('Saved');
  } catch (err) {
    console.warn('Saving to Google failed', err);
    setStatus('Could not save to Google. Will retry.', true);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => sync(flush), 30000);
  }
}
let flushTimer;
function scheduleFlush() {
  if (!plannerReady()) return;
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => sync(flush), 700);
}

const SAFE_ID = /^[\w-]{1,80}$/; // ids read back from Google are only trusted in this shape
function mergeRemote(e) {
  const p = e.extendedProperties?.private || {}, taskId = SAFE_ID.test(p.taskId || '') ? p.taskId : '';
  let t = state.tasks.find(t => t.gEventId === e.id) || (taskId ? state.tasks.find(t => t.id === taskId && !t.gEventId) : null);
  const twin = !t && taskId ? state.tasks.find(t => t.id === taskId && t.gEventId) : null;
  if (twin) {
    // Two devices each wrote this task to Google (a repeating task made on both before they met).
    // Both keep the entry with the smaller id and remove the other, so they end up agreeing.
    if (state.tombstones.includes(e.id)) return;
    if (e.id < twin.gEventId) {
      state.tombstones.push(twin.gEventId);
      if (twin.dirty) { twin.gEventId = e.id; twin.remoteUpdated = null; } else applyEvent(twin, e);
      undoSnap = null;
    } else state.tombstones.push(e.id);
    return;
  }
  if (t) {
    if (!t.dirty && e.updated !== t.remoteUpdated && (!t.remoteUpdated || e.updated > t.remoteUpdated)) { applyEvent(t, e); undoSnap = null; }
    else if (!t.gEventId) t.gEventId = e.id;
  } else if (!state.tombstones.includes(e.id)) {
    t = newTask({ id: taskId && !getTask(taskId) ? taskId : uid() });
    applyEvent(t, e);
    state.tasks.push(t);
    undoSnap = null; // what another device changed must not be wiped by an Undo of something older
  }
}

// Brings in what other devices (or Google Calendar itself) changed: the weeks around today,
// the weeks on screen, and the shared inbox.
async function pullPlanner(from, to) {
  const a = plannerAccount(), cal = state.settings.plannerCalendarId, today = startOfDay(new Date());
  const near = [addDays(today, -14), addDays(today, 28)];
  const ranges = from >= near[0] && to <= near[1] ? [near] : [near, [from, to]];
  try {
    const [inbox, ...lists] = await Promise.all([
      G.listEvents(a, cal, new Date(Date.UTC(1999, 11, 31)), new Date(Date.UTC(2000, 0, 3))),
      ...ranges.map(([f, t]) => G.listEvents(a, cal, f, t)),
    ]);
    const seen = new Set();
    for (const e of [...lists.flat(), ...inbox]) {
      if (e.status === 'cancelled' || !e.start || V.isShared(e) || N.isNote(e)) continue;
      seen.add(e.id);
      mergeRemote(e);
    }
    const spans = ranges.map(([f, t]) => [ymd(f), ymd(t)]);
    for (const t of [...state.tasks]) {
      if (!t.gEventId || t.dirty || seen.has(t.gEventId)) continue;
      if (!t.date || spans.some(([f, u]) => t.date >= f && t.date < u)) { state.tasks.splice(state.tasks.indexOf(t), 1); undoSnap = null; } // deleted or moved elsewhere
    }
    save();
    if (state.tombstones.length) scheduleFlush(); // a doubled entry found above is taken out of Google
  } catch (err) { console.warn('Reading planner calendar failed', err); return err; } // handed back so the reason can be shown
}

async function setPlanner(a) {
  const id = await G.ensurePlannerCalendar(a);
  await sync(() => { // not while tasks are being saved to the old place
    const changed = state.settings.plannerCalendarId && state.settings.plannerCalendarId !== id;
    state.settings.plannerAccountId = a.id;
    state.settings.plannerCalendarId = id;
    if (changed) { state.tombstones = []; for (const t of state.tasks) { t.gEventId = null; t.remoteUpdated = null; } N.forgetRemote(); }
    for (const t of state.tasks) if (!t.gEventId) t.dirty = true;
    save();
  });
  const [from, to] = range();
  await sync(() => pullPlanner(from, to)); // what is already there is matched up before anything is written
  scheduleFlush();
}

function connect() {
  if (DEMO) return toast('This is sample data. Open the app without “?demo” to connect your accounts.');
  if (!state.settings.clientId) return openSettings('One-time setup: add your Google keys below, then connect your accounts.');
  G.startConnect().catch(err => toast(err.message, true));
}

async function onConnected(a) {
  a.t = Date.now(); // when this sign-in was made; the newest one wins across devices
  save();
  toast(`Connected ${a.email}`);
  render();
  if (state.settings.plannerCalendarId) { shareSync(); return; }
  dialog(`<div class="dbody"><h3>Save your tasks to this account?</h3>
    <p class="note">Your tasks can be saved in a calendar called “Weftday” inside <b>${esc(a.email)}</b>. That keeps your devices in step and lets your phone remind you even when this computer is off.</p>
    <div class="actions"><span class="sp"></span><button class="btn ghost" data-x="close">Not this account</button><button class="btn primary" data-x="yes">Yes, use this account</button></div></div>`, {
    async yes(btn) {
      btn.disabled = true;
      try { await setPlanner(a); closeDialog(); toast('Tasks will be saved to “Weftday”'); render(); }
      catch (err) { btn.disabled = false; toast(err.message, true); }
    },
  });
}

// ---------------------------------------------------------------- other devices
// A link (shown as a camera-readable square) that opens the planner on another device with the
// Google keys already filled in. The keys ride in the part after "#", which is never sent to any server.
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
function setupLink() { // the plain link for someone else's device: your Google keys and nothing more
  const { clientId, clientSecret } = state.settings, d = { i: clientId, s: clientSecret };
  const data = btoa(JSON.stringify(d)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${isLocal ? PUBLIC_URL : G.redirectUri()}#setup=${data}`;
}
let homeFromLink = '', linkUndo = null; // linkUndo: how to put things back if a link's sign-in turns out not to be that account's
// text: a setup link pasted into Settings; without it, the link this page was opened with.
let lockedSetup = ''; // a locked link (for one of your own devices) that is waiting for its code
function importSetup(text) {
  const locked = text ? text.match(/#setup2=([\w-]+)\s*$/) : location.hash.match(/^#setup2=([\w-]+)$/);
  const m = locked ? null : text ? text.match(/#setup=([\w-]+)\s*$/) : location.hash.match(/^#setup=([\w-]+)$/);
  if (!m && !locked) { if (text) toast('That setup link is not valid.', true); return false; }
  if (!text) history.replaceState(null, '', location.pathname + location.search);
  if (locked) { lockedSetup = locked[1]; return false; } // openSetupCode() asks for the code next
  let d = null;
  try { d = JSON.parse(atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { toast('That setup link is not valid.', true); return false; }
  // A sign-in is only ever taken from a locked link, with its code. Plain links carry Google keys and nothing more.
  if (d && (d.e || d.r)) { toast('This setup link is an old kind. Make a fresh one on your other device.', true); return false; }
  return applySetup(d);
}
// What a setup link holds, put to use. d = { i, s } (Google keys), and for your own device also { e, r } (your home account).
function applySetup(d) {
  try {
    if (typeof d.i !== 'string' || typeof d.s !== 'string' || !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(d.i)) throw new Error('bad link');
    const s = state.settings, own = typeof d.e === 'string' && typeof d.r === 'string' && d.e && d.r;
    // A link that carries an account makes that account this device's home: tasks, notes and the list
    // of accounts are then kept there. That is only right for a link from one of your own devices, so
    // it is never done without a clear yes.
    if (own) {
      const has = s.plannerAccountId && s.plannerAccountId !== d.e ? `\n\nThis device now keeps its tasks in ${s.plannerAccountId}. They would move to the new account.` : '';
      const others = state.accounts.filter(a => a.id !== d.e).length;
      const keys = [s.aiKey, s.claudeKey, s.searchKey, ...Object.values(s.aiKeys || {}), ...Object.values(s.searchKeys || {})].some(Boolean);
      const copied = [others ? `${others} connected Google account${others === 1 ? '' : 's'}` : '', keys ? 'your AI and search keys' : ''].filter(Boolean).join(' and ');
      const warn = copied ? `\n\nThis device already has ${copied}. If you continue, they are copied into ${d.e} so your other devices get them. Anyone who can open that Google account can then use them.` : '';
      if (!confirm(`Set this device up with the Google account ${d.e}?\n\nYour tasks, notes and connected accounts on this device will be kept in that account.${warn}\n\nContinue only if ${d.e} is your own account and this link came from one of your own devices.${has}`)) return false;
    }
    // Keys from a link are never taken without a yes (a link with an account has just been asked about).
    const differ = s.clientId !== d.i || (s.clientSecret || '') !== d.s;
    if (differ && s.clientId && !confirm('Replace the Google keys saved on this device with the ones from this link?\n\nContinue only if the link came from you or from someone you trust. Signing in stops working if the keys are wrong.')) return false;
    if (differ && !s.clientId && !own && !confirm('Set this device up with the Google keys from this link?\n\nContinue only if the link came from you or from someone you trust.')) return false;
    s.clientId = d.i; s.clientSecret = d.s;
    if (own) {
      let a = acct(d.e);
      if (!a) { a = { id: d.e, email: d.e, color: G.COLORS[state.accounts.length % G.COLORS.length], calendars: [] }; state.accounts.push(a); }
      linkUndo = { id: d.e, was: a.refreshToken ? { refreshToken: a.refreshToken, needsReconnect: !!a.needsReconnect } : null };
      Object.assign(a, { refreshToken: d.r, accessToken: null, expiresAt: 0, needsReconnect: false, t: a.t || Date.now() });
      homeFromLink = d.e;
    }
    save();
    return true;
  } catch { toast('That setup link is not valid.', true); return false; }
}
// The code that unlocks a link for one of your own devices: asked for here, shown on the other device.
function openSetupCode() {
  const blob = lockedSetup;
  if (!blob) return;
  dialog(`<form class="dbody">
    <h3>Type the code</h3>
    <p class="note" style="color:var(--text)">Your other device shows a code under the square. Type it here to set this device up.</p>
    <input name="code" class="codein" autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="text" maxlength="14" placeholder="XXXXX-XXXXX" aria-label="The code from your other device">
    <p class="note warn" id="codeErr" hidden></p>
    <div class="actions"><span class="sp"></span><button type="button" class="btn ghost" data-x="close">Cancel</button><button class="btn primary">Continue</button></div></form>`, {
    async submit(fd, form) {
      const btn = $('button.primary', form), err = $('#codeErr', form);
      btn.disabled = true;
      err.hidden = true;
      try {
        const d = await V.unlockSetup(blob, String(fd.get('code') || ''));
        lockedSetup = '';
        closeDialog();
        if (!applySetup(d)) return;
        if (homeFromLink) adoptHome(homeFromLink).then(refresh); else { render(); toast('Keys added. Now press “+ Connect Google account”.'); }
      } catch (e) {
        btn.disabled = false;
        err.hidden = false;
        err.textContent = e.message;
        if (e.kind !== 'code') lockedSetup = '';
      }
    },
  });
  $('input[name=code]', el.dlg).focus();
}
// A setup link from one of your own devices carries your home account. Use it to bring in the rest.
async function adoptHome(id) {
  setStatus('Bringing in your accounts…');
  try {
    // The sign-in in the link must really belong to the account the link names. If it does not, it is
    // thrown away (and an account that was already here gets its own sign-in back) before anything is saved there.
    const main = await G.api(acct(id), '/calendars/primary');
    if (String(main?.id || '').toLowerCase() !== id.toLowerCase()) {
      const a = acct(id);
      if (linkUndo?.id === id && linkUndo.was) Object.assign(a, linkUndo.was, { accessToken: null, expiresAt: 0 });
      else state.accounts.splice(state.accounts.indexOf(a), 1);
      linkUndo = null; save(); render();
      return toast('That setup link does not belong to the account it names, so it was not used.', true);
    }
    linkUndo = null;
    await setPlanner(acct(id));
    state.settings.shareAccounts = true;
    state.sharedSeen = false;
    save();
    await shareSync();
    render();
    toast('Your accounts are set up on this device.');
  } catch (err) {
    console.warn(err);
    toast('Could not bring in your accounts. Press “+ Connect Google account” instead.', true);
  }
}
async function openDeviceSetup(mine = true) {
  if (DEMO) return toast('This is sample data. Open the app without “?demo” first.');
  if (!state.settings.clientId) return openSettings('Add your Google keys first, then you can set up your phone.');
  const canMine = V.sharingReady();
  mine = mine && canMine;
  // A link for your own device carries a sign-in, so it is locked with a code (see vault.js).
  const home = plannerAccount();
  const locked = mine ? await V.lockSetup({ i: state.settings.clientId, s: state.settings.clientSecret, e: home.id, r: home.refreshToken }) : null;
  const link = locked ? `${isLocal ? PUBLIC_URL : G.redirectUri()}#setup2=${locked.blob}` : setupLink(false);
  let square = '';
  try { square = qrSvg(link); } catch { /* too long for a square: the link can still be copied */ }
  dialog(`<div class="dbody"><h3>Set up another device</h3>
    ${canMine ? `<div class="seg"><button type="button" data-x="mine" class="${mine ? 'on' : ''}">My own device</button><button type="button" data-x="other" class="${mine ? '' : 'on'}">Someone else’s</button></div>` : ''}
    <p class="note">${mine
      ? 'Point your phone’s camera at this square and tap the link that appears. It asks for the code below, then opens with all your accounts already connected.'
      : 'Point the phone’s camera at this square and tap the link that appears. The planner opens with the Google keys already filled in. Then press “+ Connect Google account” there.'}</p>
    ${square ? `<div class="qr">${square}</div>` : '<p class="note warn">This link is too long to show as a square. Use “Copy the link instead”.</p>'}
    ${locked ? `<div class="setcode"><span>Type this code on the new device</span><b id="setupCode">${esc(locked.code)}</b></div>` : ''}
    <p class="note">On an iPhone, open the link in Safari, then use Share → Add to Home Screen to get an app icon.</p>
    <p class="note warn">${mine
      ? 'The link works only with this code, and only for 15 minutes. Never show the code to anyone else.'
      : 'This square contains your keys. Only show it to people you trust.'}</p>
    ${canMine ? '' : '<p class="note">Tip: switch on “Keep my accounts the same on all my devices” in Settings, and your own devices will need no Google login.</p>'}
    <div class="actions"><button class="btn" data-x="copy">Copy the link instead</button>
      ${isLocal ? `<a class="btn" href="${esc(link)}" target="_blank" rel="noopener">Open on this computer</a>` : ''}
      <span class="sp"></span><button class="btn primary" data-x="close">Done</button></div></div>`, {
    copy() { navigator.clipboard.writeText(link).then(() => toast('Link copied'), () => toast('Could not copy the link', true)); },
    mine: () => openDeviceSetup(true),
    other: () => openDeviceSetup(false),
  });
}

// ---------------------------------------------------------------- company Teams calendar (view-only)
// Weftday cannot sign in to a company's Microsoft account without that company's approval. Instead, a small
// helper script in the user's own Google account copies a published Outlook/Teams calendar into a Google
// calendar called "Teams". The helper is set up once; after that, the Outlook link is simply saved in that
// calendar's description, where the helper reads it.
const OUTLOOK_PUBLISH = 'https://outlook.office.com/calendar/options/calendar/SharedCalendars';
const LINK_RE = /(https|webcal):\/\/[^\s'"\\]+/i;
let teamsCode = '';
function teamsCalendar() { // the "Teams" calendar the helper made, looking in the home account first
  const order = [...state.accounts].sort((a, b) => (b.id === state.settings.plannerAccountId) - (a.id === state.settings.plannerAccountId));
  for (const a of order) {
    const c = a.needsReconnect ? null : a.calendars.find(c => c.summary === 'Teams' && c.accessRole === 'owner' && c.owned !== false);
    if (c) return { a, c };
  }
  return null;
}
function openTeams() {
  const found = DEMO ? null : teamsCalendar();
  if (found) openTeamsLink(found); else openTeamsSetup();
}

// The helper is in place: all that is needed is the calendar link.
function openTeamsLink({ a, c }) {
  const path = `/calendars/${G.enc(c.id)}`;
  dialog(`<form class="dbody"><h3>Teams calendar</h3>
    <p class="note">Paste the link to your Teams calendar. Your meetings then show here, to look at only, and update every 15 minutes.</p>
    <label>Outlook calendar link<input name="ics" placeholder="https://outlook.office365.com/…/calendar.ics" autocomplete="off" spellcheck="false"></label>
    <details><summary>Where do I find this link?</summary><ol>
      <li>Open <a href="${OUTLOOK_PUBLISH}" target="_blank" rel="noopener">Outlook on the web</a> with your Teams login.</li>
      <li>Under <b>Publish a calendar</b> choose <b>Calendar</b> and <b>Can view all details</b>, then press <b>Publish</b>.</li>
      <li>Copy the link that ends in <b>.ics</b> and paste it above.</li>
      <li>If your company has rules about sharing calendars, check that publishing is allowed.</li>
    </ol></details>
    <p class="note">Keep this link private. Anyone who has it can see your meetings.</p>
    <div class="actions"><span class="sp"></span><button type="button" class="btn ghost" data-x="close">Cancel</button><button class="btn primary">Save</button></div></form>`, {
    async submit(fd, form) {
      const link = fd.get('ics').trim();
      if (link && LINK_RE.exec(link)?.[0] !== link) return toast('That does not look like an Outlook calendar link.', true);
      const btn = $('button.primary', form);
      btn.disabled = true;
      try {
        await G.api(a, path, { method: 'PATCH', body: { description: link } });
        closeDialog();
        toast(link ? 'Saved. Your Teams meetings will show within 15 minutes.' : 'Link removed. No new meetings will be copied.');
      } catch (err) { btn.disabled = false; toast(err.message, true); }
    },
  });
  const input = $('[name=ics]', el.dlg);
  G.api(a, path).then(cal => { // show the link that is already saved, if any
    const saved = LINK_RE.exec(cal?.description || '')?.[0];
    if (saved && input.isConnected && !input.value) input.value = saved;
  }).catch(() => {});
}

// First time: put the helper into the user's own Google account. One small step per screen.
const TEAMS_STEPS = [
  { title: 'Copy the helper',
    body: 'Weftday uses a small helper that lives in your own Google account. Press the button to copy it.',
    action: '<button type="button" class="btn" data-x="copy">Copy the helper</button>' },
  { title: 'Paste it into Google',
    body: 'Open Google Apps Script with the Google account you use here. Delete what is in the new project, then paste.',
    action: '<a class="btn" href="https://script.google.com/home/projects/create" target="_blank" rel="noopener">Open Google Apps Script</a>' },
  { title: 'Give it calendar access',
    body: 'On the left, press <b>+</b> next to <b>Services</b>. Choose <b>Google Calendar API</b> and press <b>Add</b>.' },
  { title: 'Start it',
    body: 'At the top, choose <b>install</b> and press <b>Run</b>. Allow access when Google asks.' },
];
function openTeamsSetup(i = -1) {
  if (!teamsCode) fetch('helpers/teams-to-google.gs').then(r => (r.ok ? r.text() : '')).then(t => { teamsCode = t; }).catch(() => {});
  const step = TEAMS_STEPS[i], last = i === TEAMS_STEPS.length - 1;
  const html = step
    ? `<h4>Step ${i + 1} of ${TEAMS_STEPS.length}</h4><h3>${step.title}</h3><p>${step.body}</p>${step.action ? `<div>${step.action}</div>` : ''}`
    : `<h3>See your Teams meetings here</h3>
       <p>Weftday can show your company’s Teams meetings next to everything else, to look at only.</p>
       <p class="note">Setup takes about 3 minutes and you only do it once. Your company’s IT does not need to approve anything.</p>`;
  dialog(`<div class="dbody">${html}
    <div class="actions"><span class="sp"></span>
      <button type="button" class="btn ghost" data-x="${step ? 'back' : 'close'}">${step ? 'Back' : 'Not now'}</button>
      <button type="button" class="btn primary" data-x="next">${!step ? 'Start' : last ? 'I’ve done this' : 'Next'}</button></div></div>`, {
    copy() {
      if (!teamsCode) return toast('Still loading. Try again in a moment.', true);
      navigator.clipboard.writeText(teamsCode).then(
        () => toast('Copied'),
        () => toast('Could not copy. Open helpers/teams-to-google.gs on this site and copy it by hand.', true));
    },
    back: () => openTeamsSetup(i - 1),
    async next(btn) {
      if (!last) return openTeamsSetup(i + 1);
      if (DEMO) return toast('This is sample data. Open the app without “?demo” first.');
      btn.disabled = true;
      await Promise.all(state.accounts.filter(a => !a.needsReconnect).map(a => G.refreshCalendars(a).catch(err => console.warn(a.email, err))));
      render();
      refresh();
      const found = teamsCalendar();
      if (found) { el.toast.className = ''; return openTeamsLink(found); }
      btn.disabled = false;
      toast('No “Teams” calendar yet. Check that Run finished without an error, then press this again.', true);
    },
  });
}

// ---------------------------------------------------------------- same accounts on every device
// When switched on in Settings, the list of connected accounts is kept in step through the home account
// (the one that holds the "Weftday" calendar). Returns true when this device's list changed.
async function shareSync() {
  if (DEMO || !V.sharingReady()) return false;
  try {
    const r = await sync(() => V.syncAccounts());
    if (!r) return false;
    if (r.off) { toast('Keeping accounts the same was switched off on another device.'); return false; }
    if (!r.added.length && !r.removed.length) return false;
    for (const [k, ev] of events) if (!acct(ev.accountId)) events.delete(k);
    await Promise.all(r.added.map(id => G.refreshCalendars(acct(id)).catch(err => console.warn(id, err))));
    render();
    const n = r.added.length, m = r.removed.length;
    toast(n ? (n === 1 ? `Added ${r.added[0]} from your other device` : `Added ${n} accounts from your other devices`)
      : (m === 1 ? `${r.removed[0]} was removed on another device` : `${m} accounts were removed on another device`));
    return true;
  } catch (err) { console.warn('Could not update the shared account list', err); return false; }
}

// ---------------------------------------------------------------- settings
// The three shortcuts under the Today card.
const TOOL_ICONS = {
  prepare: '<path d="M11 3.5l1.9 5.1L18 10.5l-5.1 1.9L11 17.5l-1.9-5.1L4 10.5l5.1-1.9z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  people: '<circle cx="9" cy="8" r="3.3"/><path d="M2.8 19.2c.7-3.1 3-4.9 6.2-4.9s5.5 1.8 6.2 4.9"/><circle cx="17.2" cy="9" r="2.5"/><path d="M17 14.3c2.2.3 3.7 1.7 4.3 4"/>',
  free: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.3V12l3.2 2"/>',
  notes: '<path d="M6 3.500h9l4 4V20.500H6z"/><path d="M15 3.500v4h4M9 12h7M9 15.500h7M9 8.500h3"/>',
  record: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none"/>',
};
const toolIcon = name => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TOOL_ICONS[name]}</svg>`;

// The side panel can be made wider or narrower by dragging its edge (on a computer). Double-click puts it back.
const SIDE = { min: 260, max: 520, normal: 304 };
function applySide() {
  const w = clamp(+state.settings.sideWidth || SIDE.normal, SIDE.min, SIDE.max);
  if (w === SIDE.normal) $('#app').style.removeProperty('--side'); else $('#app').style.setProperty('--side', `${w}px`);
}
function bindSideGrip() {
  const grip = $('#sideGrip');
  grip.addEventListener('pointerdown', e => {
    if (e.button > 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add('sizing');
    const move = ev => { state.settings.sideWidth = clamp(Math.round(ev.clientX), SIDE.min, SIDE.max); applySide(); };
    const up = () => {
      grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
      document.body.classList.remove('sizing');
      save();
      updateNowLine();
    };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
  });
  grip.addEventListener('dblclick', () => { state.settings.sideWidth = SIDE.normal; applySide(); save(); });
}

function applyTheme() {
  const t = state.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

// Settings is split into a few sections, so no screen is long. Small line icons mark each one.
const SET_ICONS = {
  general: '<path d="M4 6h8M18 6h2M4 12h2M12 12h8M4 18h9M19 18h1"/><circle cx="15" cy="6" r="2.2"/><circle cx="9" cy="12" r="2.2"/><circle cx="16" cy="18" r="2.2"/>',
  reminders: '<path d="M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  accounts: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20c.8-3.6 3.5-5.6 7-5.6s6.2 2 7 5.6"/>',
  ai: '<path d="M11 3.5l1.9 5.1L18 10.5l-5.1 1.9L11 17.5l-1.9-5.1L4 10.5l5.1-1.9z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  data: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  advanced: '<circle cx="8" cy="15.5" r="4"/><path d="M11 12.5L19.5 4M16 7.5l3 3M13.5 10l2 2"/>',
};
const SET_PANES = [['general', 'General'], ['reminders', 'Reminders'], ['accounts', 'Accounts'], ['ai', 'AI'], ['data', 'Your data'], ['advanced', 'Advanced']];
const setIcon = name => `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SET_ICONS[name]}</svg>`;
let settingsPane = 'general'; // the section you last looked at

function openSettings(msg, pane) {
  const s = state.settings;
  // The key boxes show the key of the chosen service; the others are remembered until Save.
  const keys = { ...(s.aiKeys || {}), google: s.aiKey || '', claude: s.claudeKey || '' };
  const models = { ...(s.aiModels || {}) };
  const findKeys = { ...(s.searchKeys || {}), tavily: s.searchKey || '' };
  let provider = S.aiService(s.aiProvider).id, finder = S.searchService(s.searchProvider).id;
  // A list of services for a menu: the recommended one first, grouped into Free and Paid when both exist.
  const costly = list => {
    const sorted = [...list].sort((a, b) => !!b.recommended - !!a.recommended);
    const option = v => `<option value="${v.id}"${v.id === provider || v.id === finder ? ' selected' : ''}>${esc(`${v.name} (${v.cost})${v.recommended ? ' · Recommended' : ''}`)}</option>`;
    const groups = [['Free', sorted.filter(v => /^free/.test(v.cost))], ['Paid', sorted.filter(v => !/^free/.test(v.cost))]].filter(([, items]) => items.length);
    return groups.length < 2 ? sorted.map(option).join('') : groups.map(([name, items]) => `<optgroup label="${name}">${items.map(option).join('')}</optgroup>`).join('');
  };
  const permNow = () => !('Notification' in window) ? 'none' : Notification.permission;
  const PERM = { none: ['Not available in this browser', ''], granted: ['On', 'ok'], denied: ['Blocked in browser settings', 'warn'], default: ['Off', ''] };
  const hours = Array.from({ length: 24 }, (_, h) => [h * 60, fmtTime(h * 60)]);
  const first = pane || (msg ? 'advanced' : settingsPane);

  // The pieces every section is made of.
  const text = (title, desc) => `<div class="st"><b>${title}</b>${desc ? `<span>${desc}</span>` : ''}</div>`;
  const row = (title, desc, control) => `<div class="srow">${text(title, desc)}${control}</div>`;
  const toggle = (name, on, title, desc) => `<label class="srow">${text(title, desc)}<input type="checkbox" class="switch" name="${name}"${on ? ' checked' : ''}></label>`;
  const select = (name, list, cur) => `<select name="${name}">${opts(list, cur)}</select>`;
  const tag = (label, kind = '', id = '') => `<i class="stag ${kind}"${id ? ` id="${id}"` : ''}>${label}</i>`;
  const keyTag = (value, id) => tag(value ? 'Saved' : 'Not added', value ? 'ok' : '', id);
  const section = (name, title, lead, body) => `<section class="spane" data-pane="${name}"${name === first ? '' : ' hidden'}>
    <h3>${title}</h3>${lead ? `<p class="lead">${lead}</p>` : ''}${body}</section>`;
  const keysNow = () => JSON.stringify([s.aiProvider, s.aiKey, s.claudeKey, s.aiKeys, s.aiModels, s.searchProvider, s.searchKey, s.searchKeys]);
  const factsState = () => {
    const svc = S.aiService(provider);
    if (!svc.noKey && !keys[provider]) return ['Needs a key', ''];
    if (svc.ownSearch || findKeys[finder]) return ['Ready', 'ok'];
    return svc.kind === 'google' ? ['Company website only', 'ok'] : ['Needs a search key', ''];
  };

  const accounts = state.accounts.map(a => `<div class="srow"><span class="adot">${esc(a.email[0].toUpperCase())}</span>
    ${text(esc(a.email), a.needsReconnect ? 'Needs reconnecting. Use the Reconnect button in the side menu.' : a.id === s.plannerAccountId ? 'Your tasks are saved here' : `${a.calendars.length} calendar${a.calendars.length === 1 ? '' : 's'}`)}
    ${a.needsReconnect ? tag('Signed out', 'warn') : a.id === s.plannerAccountId ? tag('Home', 'ok') : ''}</div>`).join('');

  dialog(`<form class="sets">
    <nav class="snav" aria-label="Settings sections">
      <h3>Settings</h3>
      ${SET_PANES.map(([k, l]) => `<button type="button" data-x="pane" data-pane="${k}"${k === first ? ' class="on"' : ''}>${setIcon(k)}<span>${l}</span></button>`).join('')}
      ${loadedVersion ? `<span class="sver">Weftday · version ${esc(loadedVersion.replace(/\D+/g, ''))}</span>` : ''}
    </nav>
    <div class="smain">
      <div class="spanes">
        ${msg ? `<p class="note warn">${esc(msg)}</p>` : ''}

        ${section('general', 'General', '', `
          <h4>Your working day</h4>
          <div class="sgroup">
            ${row('Starts', 'Shown as the bright part of each day', select('dayStart', hours, s.dayStart))}
            ${row('Ends', '', select('dayEnd', hours.slice(1).concat([[1440, 'midnight']]), s.dayEnd))}
          </div>
          <h4>Look</h4>
          <div class="sgroup">
            ${row('Theme', '', `<div class="segr">${[['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) =>
              `<label><input type="radio" name="theme" value="${v}"${(s.theme || 'auto') === v ? ' checked' : ''}><span>${l}</span></label>`).join('')}</div>`)}
            ${toggle('pictures', s.pictures !== false, 'Photos and company logos', 'Logos come from Google’s site-icon service. Photos come from Gravatar or, with a Tavily search key, from the web when you get facts.')}
          </div>`)}

        ${section('reminders', 'Reminders', '', `
          <div class="sgroup">
            <div class="srow">${text('Notifications on this device', 'Needed for reminders to pop up')}<span id="permPart"></span></div>
            ${row('Remind me', 'Before a task or meeting starts', `<select name="reminder">${reminderOptions(s.reminder, false)}</select>`)}
            ${row('Morning summary', 'Your meetings and tasks for the day, once each morning', select('morning', [[-1, 'Off'], ...hours.slice(5, 12).map(([m, l]) => [m, `From ${l}`])], s.morning))}
          </div>`)}

        ${section('accounts', 'Accounts', '', `
          <h4>Google accounts</h4>
          <div class="sgroup">
            ${accounts || `<div class="srow">${text('No account connected yet', 'Connect one to see its calendars here')}</div>`}
            <div class="srow">${text(state.accounts.length ? 'Add another' : 'Connect your first account', '')}<button type="button" class="btn" data-x="connect">Connect account</button></div>
          </div>
          <h4>Tasks and devices</h4>
          <div class="sgroup">
            ${row('Save my tasks in', 'Kept in a calendar called “Weftday” in that account', select('planner', [['', 'This device only'], ...state.accounts.map(a => [a.id, a.email])], s.plannerAccountId))}
            ${toggle('share', s.shareAccounts, 'Same accounts on all my devices', 'Keeps your sign-ins and your AI keys, locked, inside the account above. A new device then needs no Google login and no keys. Keep that account safe.')}
            ${row('Phone, tablet or another computer', '', '<button type="button" class="btn" data-x="device">Set up a device</button>')}
          </div>
          <h4>Other calendars</h4>
          <div class="sgroup">
            ${row('Teams or Outlook calendar', 'View-only, through a small helper in your Google account', '<button type="button" class="btn" data-x="teams">Add</button>')}
          </div>`)}

        ${section('ai', 'AI', 'AI in Weftday runs on a key of your own. It is free, and nobody else sees what you send.', `
          <div class="aihero${s.aiKey ? ' ready' : ''}">
            <div class="aihead"><span class="aimark" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 3.5l1.9 5.1L18 10.5l-5.1 1.9L11 17.5l-1.9-5.1L4 10.5l5.1-1.9z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></svg></span>
              <div><b>${s.aiKey ? 'AI is switched on' : 'Switch AI on with one free key'}</b><span>${s.aiKey ? 'Notes from recordings, questions about your meetings and tasks in your own words are ready.' : 'It takes about a minute. Google gives the key away free; you paste it below.'}</span></div></div>
            ${row('AI service', 'Google’s is free and does everything here', `<select name="aiProvider">${costly(Object.values(S.AI_SERVICES))}</select>`)}
            <div class="sfield" id="aiKeyPart">
              <label for="aiKeyBox"><b id="aiKeyLabel"></b><i class="stag rec" id="aiRecTag" hidden>Recommended</i>${keyTag('', 'aiKeyTag')}</label>
              <div class="keyrow"><input id="aiKeyBox" name="aiKey" type="password" placeholder="Paste your key here" autocomplete="off" spellcheck="false"><button type="button" class="btn" id="aiKeyCheck" data-x="checkkey">Check it</button></div>
              <span class="hint keymsg" id="aiKeyMsg" hidden></span>
              <details id="aiHelpBox" class="keyhelp"><summary id="aiHelpTitle"></summary><ol id="aiKeyHelp"></ol><a class="btn primary" id="aiKeyGet" target="_blank" rel="noopener"></a></details>
            </div>
          </div>
          <h4>What it does for you</h4>
          <div class="sgroup aido">
            ${row('Notes from a recording', 'When a recording ends: a summary, the decisions, and who does what.', tag(s.aiKey ? 'Ready' : 'Needs the Google key', s.aiKey ? 'ok' : ''))}
            ${row('Ask my meetings', 'Ask a question and get the answer from your saved notes.', tag(s.aiKey ? 'Ready' : 'Needs the Google key', s.aiKey ? 'ok' : ''))}
            ${toggle('aiQuick', s.aiQuick !== false, 'Tasks in your own words', 'Type “call Priya tomorrow, gym at 6” and get separate tasks. You see them before anything is added.')}
            ${row('Tidy my notes', 'Turns rough notes into a summary. Runs inside this browser; nothing is sent.', tag('Checking…', '', 'aiState'))}
            ${row('Facts about a person', 'Looks someone up on the web and fills in their page: role, company, background.', tag(...factsState(), 'factsState'))}
            ${toggle('aiAuto', s.aiAuto, 'Look up today’s guests by itself', 'Their pages are ready when you open a meeting. Names go to the AI without a press. Your own company is skipped.')}
          </div>
          <details class="aimore"><summary>More choices</summary>
            <div class="sgroup">
              <div class="sfield">
                <details id="aiModelPart"><summary>Choose a model (optional)</summary>
                  <input name="aiModel" placeholder="Automatic" autocomplete="off" spellcheck="false" aria-label="Model name">
                  <span class="hint" id="aiModelHint"></span></details>
              </div>
              <div class="srow" id="ownSearchNote" hidden><div class="st"><b>Web search</b><span id="ownSearchText"></span></div>${tag('Built in', 'ok')}</div>
              <div id="searchPart">
                ${row('Search service', '<span id="searchWhy"></span>', `<select name="searchProvider">${costly(Object.values(S.SEARCH_SERVICES))}</select>`)}
                <div class="sfield">
                  <label for="searchKeyBox"><b id="searchKeyLabel"></b><i class="stag rec" id="searchRecTag" hidden>Recommended</i>${keyTag('', 'searchKeyTag')}</label>
                  <input id="searchKeyBox" name="searchKey" type="password" placeholder="Paste your key here" autocomplete="off" spellcheck="false">
                  <details class="keyhelp"><summary id="searchHelpTitle"></summary><ol id="searchKeyHelp"></ol></details>
                </div>
              </div>
              ${row('“Ask AI” opens', 'A chat app in a new tab, with a question about the person already typed', select('aiApp', Object.entries(AI_APPS).map(([k, v]) => [k, v[0]]), s.aiApp))}
            </div>
          </details>
          <p class="note">Nothing is sent until you press a button, or switch on a setting that says so. Keys are kept only in this browser.</p>`)}

        ${section('data', 'Your data', 'Weftday has no server. Everything lives in this browser and in your own Google accounts.', `
          <div class="sgroup">
            ${row(`${state.tasks.length} task${state.tasks.length === 1 ? '' : 's'} on this device`, 'Save a copy as a file', '<button type="button" class="btn" data-x="backup">Download backup</button>')}
            ${toggle('recAsk', s.recAsk !== false, 'Offer to record when a meeting starts', 'A small message with a “Record it” button as each meeting with other people begins. Nothing is recorded until you press it.')}
            ${row('Recordings', 'Kept in this browser only', '<button type="button" class="btn" data-x="recordings">Open</button>')}
            ${row('Tour', 'A quick look around the main screen', '<button type="button" class="btn" data-x="tour">Start</button>')}
            ${row('Guide', 'How each part works', '<a class="btn" href="guide.html" target="_blank" rel="noopener">Open</a>')}
            ${row('Privacy', 'What is kept, and where', '<a class="btn" href="privacy.html" target="_blank" rel="noopener">Read</a>')}
            ${row('Terms', 'The rules for using Weftday', '<a class="btn" href="terms.html" target="_blank" rel="noopener">Read</a>')}
            ${row('Help', 'Report a problem or ask a question', '<a class="btn" href="https://github.com/crckdteam/weftday/issues" target="_blank" rel="noopener">Get help</a>')}
            ${row('About Weftday', 'The website: what it is and who makes it', '<a class="btn" href="https://weftday.crckd.live/" target="_blank" rel="noopener">Open</a>')}
          </div>`)}

        ${section('advanced', 'Advanced', 'Weftday talks to Google with keys of your own. If this device was set up from another one, they are already filled in.', `
          <h4>Google connection</h4>
          <div class="sgroup">
            <div class="sfield">
              <label for="clientIdBox"><b>Client ID</b>${keyTag(s.clientId)}</label>
              <input id="clientIdBox" name="clientId" value="${esc(s.clientId)}" placeholder="…apps.googleusercontent.com" autocomplete="off" spellcheck="false">
            </div>
            <div class="sfield">
              <label for="clientSecretBox"><b>Client secret</b>${keyTag(s.clientSecret)}</label>
              <input id="clientSecretBox" name="clientSecret" type="password" value="${esc(s.clientSecret)}" autocomplete="off">
            </div>
          </div>
          <h4>Set up from another device</h4>
          <div class="sgroup"><div class="sfield">
            <label for="setupLinkBox"><b>Setup link</b></label>
            <span class="hint">On your other device: Settings → Accounts → Set up a device → Copy link. Paste it here. Useful when Weftday is installed on a phone’s home screen.</span>
            <input id="setupLinkBox" name="setupLink" placeholder="https://…#setup=…" autocomplete="off" spellcheck="false">
            <div><button type="button" class="btn" data-x="uselink">Use this link</button></div>
          </div></div>
          <details><summary>How to get these (one time, about 10 minutes)</summary><ol>
            <li>Open <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">console.cloud.google.com</a> and create a project called “Weftday”.</li>
            <li>Go to <b>APIs &amp; Services → Library</b>, find <b>Google Calendar API</b> and press Enable.</li>
            <li>Go to <b>Google Auth Platform</b> (OAuth consent screen). Choose <b>External</b>, give it a name and your email.</li>
            <li>Under <b>Audience</b>, press <b>Publish app</b>. This stops Google signing you out every 7 days. Only you can use it.</li>
            <li>Under <b>Clients</b>, create a client of type <b>Web application</b>. Add <code>${esc(location.origin)}</code> under “Authorised JavaScript origins” and <code>${esc(G.redirectUri())}</code> under “Authorised redirect URIs”.</li>
            <li>Copy the Client ID and Client secret into the boxes above and press Save.</li>
            <li>When you connect an account, Google shows a “not verified” warning. Choose <b>Advanced → Go to Weftday</b>. That is expected for a private app.</li>
          </ol></details>`)}
      </div>
      <div class="sfoot"><span class="sp"></span>
        <button type="button" class="btn ghost" data-x="close">Cancel</button>
        <button class="btn primary">Save</button></div>
    </div></form>`, {
    async submit(fd, form) {
      const stop = (where, text) => { show(where); toast(text, true); };
      if (!stash(fd)) return stop('general', 'Your working day must end after it starts.');
      const want = fd.get('planner'), share = fd.get('share') === 'on';
      if (share && !want) return stop('accounts', 'To keep your accounts the same everywhere, first choose an account to save tasks in.');
      if (share && !s.clientSecret) return stop('advanced', 'To keep your accounts the same everywhere, add the Client secret first.');
      const wasSharing = s.shareAccounts, moving = want !== s.plannerAccountId;
      $('button.primary', form).disabled = true;
      try {
        if (wasSharing && (!share || moving)) await sync(() => V.clearShared()); // switching off, or leaving the old home account
        if (!share) s.shareAccounts = false;
        if (!want && s.plannerAccountId) { s.plannerAccountId = ''; s.plannerCalendarId = ''; }
        else if (want && moving) await setPlanner(acct(want));
        if (share) { if (!wasSharing || moving) state.sharedSeen = false; s.shareAccounts = true; }
        save();
        if (share) await shareSync();
        closeDialog(); render(); toast('Settings saved');
      } catch (err) { $('button.primary', form).disabled = false; toast(err.message, true); }
    },
    pane: x => show(x.dataset.pane),
    async notif() { await Notification.requestPermission(); showPerm(); },
    tour: () => { stash(); closeDialog(); setTimeout(startTour, 250); },
    recordings: () => { stash(); openRecordings(null); },
    // These lead to another box, so what was typed here is kept first.
    device: () => { stash(); openDeviceSetup(); },
    connect: () => { stash(); connect(); },
    teams: () => { stash(); openTeams(); },
    uselink() {
      stash();
      if (!importSetup($('[name=setupLink]', el.dlg).value.trim())) { if (lockedSetup) openSetupCode(); return; }
      closeDialog();
      if (homeFromLink) adoptHome(homeFromLink).then(refresh); else { render(); toast('Keys added. Now press “+ Connect Google account”.'); }
    },
    async checkkey() { // asks the service a tiny question, so a wrong key is found now and not in the middle of a meeting
      keep();
      const svc = S.aiService(provider), msg = part('aiKeyMsg'), key = keys[provider];
      const say = (text, kind = '') => { msg.hidden = false; msg.textContent = text; msg.className = `hint keymsg ${kind}`; };
      if (!key) return say('Paste the key in the box first.');
      say('Checking…');
      try {
        const ok = await S.keyWorks(svc, key);
        if (ok === false) { const t = part('aiKeyTag'); t.textContent = 'Not accepted'; t.className = 'stag bad'; }
        say(ok ? 'This key works. Press Save to keep it.' : ok === false ? `${svc.name} did not accept this key. Copy the whole key again and paste it here.` : 'This service cannot be checked from here. Press Save and try it.', ok ? 'good' : ok === false ? 'bad' : '');
      } catch (err) { say(err.message, 'bad'); }
    },
    backup() {
      const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), tasks: state.tasks }, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `planner-backup-${todayYmd()}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
    },
  }, 'settings');

  // Saves everything in the form that needs no waiting (all but the home account and the sharing switch).
  // Returns false when the working day is not valid.
  const opened = { at: s.keysAt, keys: { ...keys }, models: { ...models }, findKeys: { ...findKeys }, provider, finder };
  function stash(fd = new FormData($('form', el.dlg))) {
    if (+fd.get('dayEnd') <= +fd.get('dayStart')) return false;
    s.clientId = fd.get('clientId').trim();
    s.clientSecret = fd.get('clientSecret').trim();
    s.reminder = +fd.get('reminder');
    s.dayStart = +fd.get('dayStart'); s.dayEnd = +fd.get('dayEnd');
    s.morning = +fd.get('morning');
    s.theme = fd.get('theme') || 'auto';
    s.pictures = fd.get('pictures') === 'on';
    s.aiApp = fd.get('aiApp');
    s.aiAuto = fd.get('aiAuto') === 'on';
    s.recAsk = fd.get('recAsk') === 'on';
    s.aiQuick = fd.get('aiQuick') === 'on';
    keep();
    if (s.keysAt !== opened.at) {
      // Newer keys arrived from another device while this box was open: only what you changed here
      // is kept from the form, the rest is taken as it is now.
      const fresh = { keys: { ...(s.aiKeys || {}), google: s.aiKey || '', claude: s.claudeKey || '' }, models: { ...(s.aiModels || {}) }, findKeys: { ...(s.searchKeys || {}), tavily: s.searchKey || '' } };
      for (const [name, mine] of [['keys', keys], ['models', models], ['findKeys', findKeys]]) {
        for (const k of new Set([...Object.keys(mine), ...Object.keys(fresh[name])])) if ((mine[k] || '') === (opened[name][k] || '')) mine[k] = fresh[name][k] || '';
      }
      if (provider === opened.provider) provider = S.aiService(s.aiProvider).id;
      if (finder === opened.finder) finder = S.searchService(s.searchProvider).id;
    }
    const keysBefore = keysNow();
    if (s.aiKey !== keys.google) s.aiFreeSince = 0; // a new key may have Google's own search
    const { google, claude, ...otherKeys } = keys, { tavily, ...otherFinders } = findKeys;
    const filled = map => Object.fromEntries(Object.entries(map).filter(([, v]) => v));
    s.aiKey = google; s.claudeKey = claude; s.aiKeys = filled(otherKeys); s.aiModels = filled(models);
    s.searchKey = tavily; s.searchKeys = filled(otherFinders);
    s.aiProvider = provider; s.searchProvider = finder;
    if (keysNow() !== keysBefore) s.keysAt = Date.now(); // the newest set of keys wins on your other devices
    Object.assign(opened, { at: s.keysAt, keys: { ...keys }, models: { ...models }, findKeys: { ...findKeys }, provider, finder });
    save();
    applyTheme();
    return true;
  }
  function show(name) {
    settingsPane = name;
    for (const p of $$('.spane', el.dlg)) p.hidden = p.dataset.pane !== name;
    for (const b of $$('.snav button', el.dlg)) {
      b.classList.toggle('on', b.dataset.pane === name);
      if (b.dataset.pane === name) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    $('.spanes', el.dlg).scrollTop = 0;
  }
  function showPerm() {
    const part = $('#permPart', el.dlg), now = permNow();
    if (part) part.innerHTML = now === 'default' ? '<button type="button" class="btn" data-x="notif">Turn on</button>' : tag(...PERM[now]);
  }
  showPerm();
  settingsPane = first;

  // The theme is shown as you pick it; closing without saving puts the saved one back.
  for (const r of $$('[name=theme]', el.dlg)) r.addEventListener('change', () => {
    if (r.value === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = r.value;
  });
  el.dlg.addEventListener('close', applyTheme, { once: true });

  // The boxes follow the chosen AI service and search service.
  const box = name => $(`[name=${name}]`, el.dlg), part = id => $(`#${id}`, el.dlg);
  // "Saved" only once it really is: a key typed in but not yet saved says so.
  const setTag = (id, value, stored) => { const t = part(id), same = !!value && value === stored; t.textContent = !value ? 'Not added' : same ? 'Saved' : 'Not saved yet'; t.className = `stag ${same ? 'ok' : ''}`; };
  function keep() { // what is typed in the boxes right now
    keys[provider] = box('aiKey').value.trim();
    models[provider] = box('aiModel').value.trim();
    findKeys[finder] = box('searchKey').value.trim();
  }
  function showStates() {
    const [label, kind] = factsState(), t = part('factsState');
    t.textContent = label; t.className = `stag ${kind}`;
    setTag('aiKeyTag', keys[provider], aiKeyOf(provider));
    setTag('searchKeyTag', findKeys[finder], (finder === 'tavily' ? state.settings.searchKey : state.settings.searchKeys?.[finder]) || '');
  }
  function showServices() {
    const svc = S.aiService(provider), find = S.searchService(finder);
    part('aiKeyPart').hidden = !!svc.noKey;
    const on = !!svc.noKey || !!aiKeyOf(provider), head = $('.aihead div', el.dlg);
    $('.aihero', el.dlg).classList.toggle('ready', on);
    $('b', head).textContent = on ? 'AI is switched on' : svc.kind === 'google' ? 'Switch AI on with one free key' : `Switch AI on with your ${svc.name} key`;
    $('span', head).textContent = on ? (svc.kind === 'google' ? 'Notes from recordings, questions about your meetings and tasks in your own words are ready.' : `${svc.name} is set up. Notes from a recording still use the free Google key.`)
      : svc.kind === 'google' ? 'It takes about a minute. Google gives the key away free; you paste it below.' : 'Paste the key below. Notes from a recording still use the free Google key.';
    part('aiKeyLabel').textContent = svc.label || '';
    part('aiRecTag').hidden = !svc.recommended;
    part('searchRecTag').hidden = !find.recommended;
    box('aiKey').value = keys[provider] || '';
    part('aiHelpTitle').textContent = `${svc.noKey ? `How to set ${svc.name} up` : 'How to get this key'} · ${svc.setup}`;
    part('searchHelpTitle').textContent = `How to get this key · ${find.setup}`;
    part('aiKeyHelp').innerHTML = svc.help;
    part('aiHelpBox').open = !!svc.noKey || !keys[provider]; // no key yet: the steps are in plain sight
    const get = part('aiKeyGet'), page = /href="([^"]+)"/.exec(svc.help || '');
    get.hidden = !page || !!svc.noKey;
    if (page) { get.href = page[1]; get.textContent = /^free/.test(svc.cost) ? 'Get my free key' : 'Get my key'; }
    part('aiKeyCheck').hidden = !(svc.kind === 'google' || (svc.kind === 'chat' && svc.base && !svc.noList));
    part('aiKeyMsg').hidden = true;
    part('aiModelPart').hidden = svc.kind !== 'chat';
    box('aiModel').value = models[provider] || '';
    part('aiModelHint').textContent = svc.local ? 'Leave empty to use the first model you have downloaded.' : `Leave empty and Weftday picks a good one${svc.model ? ` (${svc.model})` : ''}.`;
    part('ownSearchNote').hidden = !svc.ownSearch;
    part('ownSearchText').textContent = `${svc.name} searches the web by itself, so no search key is needed.`;
    part('searchPart').hidden = !!svc.ownSearch;
    part('searchWhy').textContent = svc.kind === 'google' ? 'Optional. Finds facts about the person, not only their company.' : `Needed: ${svc.name} cannot search the web by itself.`;
    part('searchKeyLabel').textContent = `${find.name} key`;
    box('searchKey').value = findKeys[finder] || '';
    part('searchKeyHelp').innerHTML = find.help;
    showStates();
  }
  showServices();
  box('aiProvider').addEventListener('change', e => { keep(); provider = e.target.value; showServices(); });
  box('searchProvider').addEventListener('change', e => { keep(); finder = e.target.value; showServices(); });
  for (const name of ['aiKey', 'searchKey']) box(name).addEventListener('input', () => { keep(); showStates(); });
  AI.status().then(st => {
    const line = $('#aiState', el.dlg);
    if (!line) return;
    line.textContent = { ready: 'Ready', download: 'One-time download', no: 'Chrome on a computer only' }[st];
    line.className = `stag ${st === 'ready' ? 'ok' : ''}`;
  });
}

// ---------------------------------------------------------------- reminders
// ev is the meeting the reminder is for, if it has guests from outside: its brief is one press away.
// Shows a system notification. Phones only allow these through the app's background helper (sw.js).
function systemNote(title, body, onPress) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const note = new Notification(title, { body, icon: 'icon-192.png' });
    note.onclick = () => { window.focus(); note.close(); onPress?.(); };
  } catch {
    navigator.serviceWorker?.ready.then(reg => reg.showNotification(title, { body, icon: 'icon-192.png' })).catch(() => {});
  }
}
function notify(title, body, ev) {
  toast(`${title} · ${body}`, ev ? { go: ['Brief me', () => openBrief(ev)] } : {});
  systemNote(title, ev ? `${body}. Press to see your brief.` : body, ev ? () => openBrief(ev) : null);
}
// A little after a meeting with outside guests ends, asks once how it went, if you kept no notes.
function askHowItWent(now, today) {
  if (el.dlg.open || document.hidden || el.toast.className.includes('show')) return;
  for (const ev of events.values()) {
    const since = (now.getTime() - ev.e) / 60000;
    if (ev.allDay || since < 1 || since > 45 || ev.selfStatus === 'declined' || !enabledEvent(ev)) continue;
    const key = `${today}:n:${noteKey(ev)}`;
    if (state.notified[key] || N.has(noteKey(ev)) || !outsiders(ev).length) continue;
    state.notified[key] = 1;
    save();
    toast(`How did “${ev.title}” go?`, { go: ['Add notes', () => openEvent(ev, true)] });
    return;
  }
}

// Once a day, from the time chosen in Settings: a summary of the day and the planning screen.
function morningBrief(now, today) {
  const at = state.settings.morning;
  if (at < 0 || state.lastBrief === today || nowMinutes() < at) return;
  if (!state.tasks.length && !state.accounts.length) return;
  if (el.dlg.open || document.hidden) return;
  state.lastBrief = today;
  save();
  const d = startOfDay(now);
  const meets = dayItems(d).timed.filter(i => i.kind === 'ev' && i.ev.selfStatus !== 'declined').length;
  const todo = state.tasks.filter(t => t.date === today && !t.done).length;
  systemNote('Your day', `${meets} meeting${meets === 1 ? '' : 's'} and ${todo} task${todo === 1 ? '' : 's'} today`);
  if (meets) openToday(); else openPlan();
}

function tick() {
  if (isStale()) return; // another open copy of Weftday has taken over; this one reloads when you return to it
  const now = new Date(), today = ymd(now), nowM = nowMinutes();
  if (today !== renderedDay) { topUpSeries(); save(); render(); scheduleFlush(); } else { updateNowLine(); renderUpNext(); if (view === 'home') renderHome(); }
  const due = [];
  const when = (mins, at) => mins > 0 ? `Starts at ${at} (in ${mins} min)` : `Starting now · ${at}`;
  for (const t of state.tasks) {
    if (t.done || t.date !== today || t.start == null) continue;
    const rem = t.reminder == null ? state.settings.reminder : t.reminder;
    if (rem >= 0 && nowM >= t.start - rem && nowM <= t.start) due.push({ key: `${today}:t:${t.id}:${t.start}`, title: t.title, body: when(t.start - nowM, fmtTime(t.start)) });
  }
  const rem = state.settings.reminder;
  if (rem >= 0) for (const ev of events.values()) {
    if (ev.allDay || ev.selfStatus === 'declined' || !enabledEvent(ev)) continue;
    const mins = Math.round((ev.s - now.getTime()) / 60000);
    if (mins <= rem && mins >= 0) {
      const s = new Date(ev.s);
      due.push({ key: `e:${noteKey(ev)}:${ev.s}`, title: ev.title, body: when(mins, fmtTime(s.getHours() * 60 + s.getMinutes())), ev: outsiders(ev).length ? ev : null });
    }
    // As a meeting with other people begins: one press to record it.
    if (mins <= 0 && mins >= -2 && state.settings.recAsk !== false && (ev.meet || outsiders(ev).length) && R.supported() && !R.current())
      due.push({ key: `e:${noteKey(ev)}:rec:${ev.s}`, title: ev.title, rec: ev });
  }
  let changed = false;
  for (const k of Object.keys(state.notified)) { // forget yesterday's; a meeting's own mark is kept until a day after it started
    const old = k.startsWith('e:') ? +k.slice(k.lastIndexOf(':') + 1) < now.getTime() - 86400000 : !k.startsWith(today);
    if (old) { delete state.notified[k]; changed = true; }
  }
  for (const d of due) {
    if (state.notified[d.key]) continue;
    state.notified[d.key] = 1; changed = true;
    if (d.rec) {
      toast(`“${d.title}” is starting`, { go: ['Record it', () => quickRecord(d.rec)] });
      systemNote(d.title, 'Starting now. Press to record it and get the notes written.', () => openRecordSetup(d.rec));
    } else notify(d.title, d.body, d.ev);
  }
  if (changed) save();
  if (!DEMO && Date.now() - refreshedAt > 12 * 60000 && navigator.onLine !== false) refresh(); // also in a background tab, so reminders know about new meetings
  askHowItWent(now, today);
  morningBrief(now, today);
}

// ---------------------------------------------------------------- add tasks in your own words
// The ✨ button in "Add a task": a sentence such as "call Priya tomorrow morning, gym at 6 and send
// the deck on Friday" is handed to your AI service, which answers with separate tasks. Only what you
// typed is sent. You see the tasks before anything is added.
const PLAN_SCHEMA = {
  type: 'object',
  properties: { tasks: { type: 'array', items: {
    type: 'object',
    properties: { title: { type: 'string' }, date: { type: 'string' }, start: { type: 'string' }, minutes: { type: 'integer' }, flexible: { type: 'boolean' }, repeat: { type: 'string' } },
    required: ['title', 'date', 'start', 'minutes', 'flexible', 'repeat'], additionalProperties: false,
  } } },
  required: ['tasks'], additionalProperties: false,
};
function planQuestion(text) {
  const now = new Date(), { dayStart, dayEnd } = state.settings;
  const dayName = d => d.toLocaleDateString('en-GB', { weekday: 'long' });
  const week = Array.from({ length: 8 }, (_, i) => addDays(startOfDay(now), i)).map(d => `${dayName(d)} ${ymd(d)}`).join(', ');
  return [
    'You turn what a person typed into tasks for their planner. Answer with JSON only, no other words:',
    '{"tasks":[{"title":"…","date":"YYYY-MM-DD","start":"HH:MM","minutes":30,"flexible":false,"repeat":""}]}',
    `Now it is ${dayName(now)} ${ymd(now)}, ${hhmm(nowMinutes())}. The coming days: ${week}. Their working day is ${hhmm(dayStart)} to ${hhmm(Math.min(dayEnd, 1439))}. Weeks start on Monday.`,
    'Rules:',
    '- One entry for each separate thing to do. Never add tasks they did not mention.',
    '- title: short and clear, without the day and time words. Keep names and details.',
    '- date: the day they meant. Use "" if they gave no day and no time.',
    '- start: 24-hour time. An exact time is kept as given ("at 6" in the evening context is 18:00; "7am" is 07:00). For a part of the day use: early morning 07:00, morning 09:00, late morning 11:00, noon or lunch 12:30, after lunch 14:00, afternoon 15:00, evening 18:00, night 20:00, and set flexible to true. Use "" if they gave no time at all.',
    '- A time with no day means today, or tomorrow if that time has already passed today.',
    '- minutes: the length they gave, or 0 if they gave none.',
    '- flexible: true only when the time came from a part of the day; false for exact times and for no time.',
    '- "then" or "after that" means straight after the task before it.',
    '- repeat: "" for a one-off. "daily" for every day, "weekdays" for Monday to Friday, "weekly" for once a week on the same weekday. For other patterns write "days:" and the weekday numbers it happens on, Sunday = 0 to Saturday = 6: every day except Sunday is "days:123456", Monday Wednesday Friday is "days:135", weekends is "days:06". A repeating task is ONE entry, never one entry per day. Its date is the first day it happens.',
    '- People make typing slips ("expect sundays" means "except Sundays"). Read what they meant.',
    `What they typed: """${text.slice(0, 1500)}"""`,
  ].join('\n');
}
// Reads the AI's answer into tasks, checks every part, and finds real free time for the loose ones.
function readPlan(raw, text = '') {
  const found = /\{[\s\S]*\}/.exec(String(raw || ''));
  let list = [];
  try { list = JSON.parse(found?.[0] || '{}').tasks || []; } catch { list = []; }
  const today = todayYmd(), taken = new Map(), out = [];
  for (const x of Array.isArray(list) ? list.slice(0, 12) : []) {
    let title = String(x?.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!title) continue;
    title = title[0].toUpperCase() + title.slice(1);
    let date = /^\d{4}-\d{2}-\d{2}$/.test(x.date || '') && !isNaN(fromYmd(x.date)) ? x.date : null;
    const clock = /^(\d{1,2}):(\d{2})$/.exec(x.start || '');
    let start = clock && +clock[1] < 24 && +clock[2] < 60 ? Math.round((+clock[1] * 60 + +clock[2]) / SNAP) * SNAP : null;
    const duration = +x.minutes >= 5 ? clamp(Math.round(+x.minutes / SNAP) * SNAP, SNAP, 720) : 30;
    if (date && date < today) date = today;
    if (start != null && !date) date = start < nowMinutes() ? ymd(addDays(new Date(), 1)) : today;
    // an exact time today that has already gone by means tomorrow, unless they said "today" themselves
    if (date === today && start != null && !x.flexible && start + 15 < nowMinutes() && !/\b(today|tonight|this (morning|afternoon|evening)|now)\b/i.test(text)) date = ymd(addDays(new Date(), 1));
    if (start != null) {
      start = Math.min(start, 1440 - duration);
      // a loose time ("in the morning"), or one that would sit on top of another new task, moves to the next gap
      const busy = [...(x.flexible ? busyOf(fromYmd(date)) : []), ...(taken.get(date) || [])].sort((a, b) => a[0] - b[0]);
      let s = date === today && x.flexible ? Math.max(start, Math.ceil((nowMinutes() + 1) / SNAP) * SNAP) : start;
      for (const [bs, be] of busy) { if (be <= s) continue; if (bs >= s + duration) break; s = Math.ceil(be / SNAP) * SNAP; }
      if (s + duration <= 1440) start = s;
      taken.set(date, [...(taken.get(date) || []), [start, start + duration]]);
    }
    const days = /^days:([0-6]{1,7})$/.exec(x.repeat || '');
    const repeat = days ? `d${[...new Set(days[1])].sort().join('')}` : ['daily', 'weekdays', 'weekly'].includes(x.repeat) ? x.repeat : '';
    if (repeat) date = firstRepeatDay(date || today, repeat); // a repeating task starts on a day it falls on
    out.push({ title, date, start, duration, repeat });
  }
  return out;
}
async function askForTasks(text, signal) {
  const s = state.settings, svc = S.aiService(s.aiProvider), question = planQuestion(text);
  if (svc.kind === 'claude' && s.claudeKey) return readPlan(await (await import('./claude.js')).plain(question, s.claudeKey, signal), text);
  const usable = svc.kind === 'google' || (svc.kind === 'chat' && svc.base);
  if (usable && factsKey()) return readPlan(await F.askPlain(question, { provider: svc.id, key: aiKeyOf(svc.id), model: s.aiModels?.[svc.id] || '', google: s.aiKey }, signal), text);
  if (s.aiKey) return readPlan(await F.askPlain(question, { provider: 'google', google: s.aiKey }, signal), text); // the chosen service cannot do this: your Google key can
  if (AI.supported() && await AI.status() !== 'no') return readPlan(await AI.ask(question, PLAN_SCHEMA, signal), text); // no key: the browser's own AI
  throw Object.assign(new Error('nokey'), { kind: 'nokey' });
}
let planJob = null;
// Adds what the AI made of the sentence and says so, with Undo.
function addPlanned(picked) {
  mark();
  const made = picked.map(p => {
    const t = newTask({ title: p.title, date: p.date, start: p.start, duration: p.duration });
    if (p.repeat) { t.repeat = p.repeat; t.seriesId = uid(); }
    return t;
  });
  state.tasks.push(...made);
  topUpSeries();
  $('#quickInput').value = '';
  quickHint();
  commit();
  for (const t of made) flash(t.id, 'born');
  const one = made.length === 1 ? made[0] : null;
  toast(one ? `✨ ${addedLine(one)}` : `✨ ${made.length} tasks added`, { undo: true });
}
// direct: Enter was pressed on a sentence the simple reader could not take; one task is then added
// straight away, like any other, and only several at once are shown first.
async function quickPlan(direct) {
  if (direct instanceof Event) direct = false;
  const input = $('#quickInput'), btn = $('#quickAi'), text = input.value.trim();
  if (planJob) { planJob.abort(); return; } // pressed again while thinking: stop
  if (text.split(/\s+/).length < 2) { input.focus(); return toast('Type what you want to do, in your own words, then press ✨.'); }
  if (DEMO) return toast('This is sample data. Open the app without “?demo” to plan with AI.');
  const job = planJob = new AbortController();
  btn.classList.add('busy'); input.readOnly = true;
  el.hint.innerHTML = '<span class="qchip ai busy">✨ Working out your tasks…</span>'; el.hint.hidden = false;
  try {
    const tasks = await askForTasks(text, job.signal);
    if (job.signal.aborted) return;
    if (!tasks.length) { if (direct === true) return quickAddPlain(parseQuick(text)); return toast('The AI found no tasks in that. Try saying it differently.', true); }
    if (direct === true && tasks.length === 1) return addPlanned(tasks);
    openPlanned(tasks, text);
  } catch (err) {
    if (err.name === 'AbortError' || job.signal.aborted) return;
    if (direct === true) { quickAddPlain(parseQuick(text)); toast('Added as typed: the AI could not be reached just now.', { undo: true }); return; }
    if (err.kind === 'nokey') needKey('Adding tasks in your own words');
    else toast(err.message || 'The AI could not work that out. Please try again.', true);
  } finally {
    if (planJob === job) planJob = null;
    btn.classList.remove('busy'); input.readOnly = false;
    quickHint();
  }
}
// Shows what the AI made of the sentence. Nothing is added until you say so.
function openPlanned(tasks, text) {
  const when = t => [t.date ? relDay(t.date) : 'Inbox', t.start != null ? fmtRange(t.start, t.start + t.duration) : t.date ? 'any time' : '', t.start == null ? fmtDur(t.duration) : '', t.repeat ? repeatLabel(t.repeat) : ''].filter(Boolean).join(' · ');
  dialog(`<form class="dbody">
    <h3>Add ${tasks.length === 1 ? 'this task' : `these ${tasks.length} tasks`}?</h3>
    <p class="note">From: “${esc(text.length > 160 ? `${text.slice(0, 160)}…` : text)}”</p>
    <div class="plist aiplan">${tasks.map((t, i) => `<label class="prow"><input type="checkbox" name="pick" value="${i}" checked>
      <span class="pt">${esc(t.title)}</span><span class="pd">${esc(when(t))}</span></label>`).join('')}</div>
    <p class="note">Untick anything that is wrong. You can move or change a task after it is added.</p>
    <div class="actions"><span class="sp"></span><button type="button" class="btn ghost" data-x="close">Cancel</button><button class="btn primary" id="planAdd">Add</button></div></form>`, {
    submit(fd) {
      const picked = fd.getAll('pick').map(i => tasks[+i]);
      closeDialog();
      if (picked.length) addPlanned(picked);
    },
  });
  $('#planAdd', el.dlg).focus();
}

// ---------------------------------------------------------------- your day, people and companies
// Screens that pull together what Weftday already knows, so you walk into a meeting prepared.
const myDomains = () => new Set(state.accounts.map(a => a.email.split('@')[1]).filter(d => d && !FREE_MAIL.has(d)));
// The people in a meeting who are not you and not from your own company.
const outsiders = ev => (ev.att || []).filter(g => !g.resource).map(g => ({ guest: g, who: person(g) }))
  .filter(x => !x.who.self && !myDomains().has(x.who.domain));
// Things you noted as action points with these people that are not ticked off yet: [{ text, when }].
function openItems(emails, exceptKey) {
  const out = [];
  for (const n of N.withPeople(emails, exceptKey)) for (const text of AI.actionsIn(n.text)) {
    const task = state.tasks.find(t => t.title.toLowerCase() === text.toLowerCase());
    if (!task?.done && !out.some(o => o.text === text)) out.push({ text, when: n.when || 0 });
  }
  return out;
}
const ago = when => {
  const d = Math.round((Date.now() - when) / 86400000);
  return !when || d < 0 ? '' : d === 0 ? 'today' : d === 1 ? 'yesterday' : d < 14 ? `${d} days ago` : d < 60 ? `${Math.round(d / 7)} weeks ago` : `${Math.round(d / 30)} months ago`;
};
const openLine = o => `${esc(o.text)}${ago(o.when) ? ` <em>· ${ago(o.when)}</em>` : ''}`;
let returnTo = null; // where "Back" on a person's profile goes when it was not opened from a meeting

// "Today": each of today's meetings with who is in it, what happened last time, what is still open
// and something worth asking. It only uses what is already saved, so it opens at once.
function openToday() {
  returnTo = null;
  const d = startOfDay(new Date()), nowT = Date.now(), nowM = nowMinutes();
  const meets = dayItems(d).timed.filter(i => i.kind === 'ev' && i.ev.selfStatus !== 'declined').sort((a, b) => a.s - b.s);
  const tasks = state.tasks.filter(t => t.date === ymd(d) && !t.done);
  const missing = new Map();
  const card = i => {
    const ev = i.ev, out = outsiders(ev), shown = out.slice(0, 4), emails = out.map(x => x.who.email), key = noteKey(ev);
    const facts = shown.map(x => savedFacts(x.who.email));
    for (const x of out) if (!hasFacts(x.who.email) && (x.who.fullName || x.who.company) && ev.e > nowT) missing.set(x.who.email, { who: x.who, title: ev.title });
    const last = emails.length ? N.withPeople(emails, key).find(n => (n.when || 0) < ev.s) : null;
    const open = emails.length ? openItems(emails, key).slice(0, 2) : [];
    const idea = facts.map(f => f?.ideas?.[0]).find(Boolean);
    const when = ev.e <= nowT ? 'done' : ev.s <= nowT ? 'now' : '';
    const k = `data-ev="${esc(ev.key)}"`; // not data-key: that one opens the meeting from anywhere on the page
    return `<div class="tcard ${when}">
      <div class="thead"><span class="ttime">${fmtRange(i.s, i.e)}</span>${when === 'now' ? '<span class="pill">Now</span>' : when === 'done' ? '<span class="tdone">Done</span>' : i.s - nowM <= 60 ? `<span class="tsoon">in ${i.s - nowM} min</span>` : ''}
        <span class="sp"></span>${ev.meet && when !== 'done' ? `<a class="mini join" href="${esc(ev.meet)}" target="_blank" rel="noopener">Join</a>` : ''}</div>
      <button type="button" class="ttitle" data-x="open" ${k}>${shown[0]?.who.company ? logoHtml(shown[0].who.domain) : ''}${esc(ev.title)}</button>
      ${shown.length ? `<div class="twho">${shown.map((x, n) => `<button type="button" class="tperson" data-x="person" ${k} data-email="${esc(x.who.email)}">${avatarHtml(x.who, true)}
        <span><b>${esc(x.who.name)}</b><i>${esc(facts[n]?.role || x.who.company || x.who.email)}</i></span></button>`).join('')}${out.length > 4 ? `<span class="note">and ${out.length - 4} more</span>` : ''}</div>`
        : `<div class="note">${(ev.att || []).length > 1 ? 'With your own team' : 'Just you'}</div>`}
      ${last ? `<div class="tline"><i>Last time</i><span>${esc(AI.gistOf(last.text, 170))}</span></div>` : ''}
      ${open.map(o => `<div class="tline"><i>Still open</i><span>${openLine(o)}</span></div>`).join('')}
      ${idea ? `<div class="tline"><i>Worth asking</i><span>${esc(idea)}</span></div>` : ''}
      ${shown.length && when !== 'done' ? `<div class="tfoot"><button type="button" class="mini" data-x="brief" ${k}>Brief me</button></div>` : ''}</div>`;
  };
  const cards = meets.map(card).join('');
  const left = meets.filter(i => i.ev.e > nowT).length;
  dialog(`<div class="dbody today">
    <h3>Today</h3>
    <div class="meta">${esc(dayLabel(d))} · ${meets.length ? `${left} of ${meets.length} meeting${meets.length === 1 ? '' : 's'} to go` : 'no meetings'} · ${tasks.length} task${tasks.length === 1 ? '' : 's'} · ${fmtDur(freeMinutes(d))} free</div>
    ${missing.size && factsKey() ? `<div class="rowline tfill"><span class="note">${missing.size === 1 ? 'One person has' : `${missing.size} people have`} no profile yet.</span><button type="button" class="btn" data-x="fill">Look them up</button></div>` : ''}
    ${cards || '<div class="fempty"><b>No meetings today</b><span>A clear day. Plan your tasks instead.</span></div>'}
    ${tasks.length ? `<h4>Tasks for today</h4><div class="todo2">${tasks.slice(0, 8).map(t => `<div>• ${esc(t.title)}${t.start != null ? ` <em>· ${fmtTime(t.start)}</em>` : ''}</div>`).join('')}${tasks.length > 8 ? `<div class="note">and ${tasks.length - 8} more</div>` : ''}</div>` : ''}
    <div class="actions"><button type="button" class="btn" data-x="plan">Plan my day</button><span class="sp"></span><button type="button" class="btn primary" data-x="close">Close</button></div></div>`, {
    open: x => (events.get(x.dataset.ev) ? openEvent(events.get(x.dataset.ev)) : openToday()), // gone meanwhile: show the day afresh
    brief: x => (events.get(x.dataset.ev) ? openBrief(events.get(x.dataset.ev)) : openToday()),
    person(x) {
      const ev = events.get(x.dataset.ev);
      if (!ev) return openToday();
      openPerson((ev.att || []).find(g => (g.email || '').toLowerCase() === x.dataset.email), ev);
    },
    plan: () => openPlan(),
    // Looks up everyone in today's meetings who has no profile yet, then shows the day again.
    async fill(btn) {
      const job = newJob(), list = [...missing.values()].slice(0, 8);
      btn.disabled = true;
      try {
        for (let n = 0; n < list.length; n++) {
          btn.textContent = `Looking up ${list[n].who.name.split(' ')[0]}… (${n + 1} of ${list.length})`;
          keepFacts(list[n].who, await getFacts(list[n].who, list[n].title, job.signal));
          if (job.signal.aborted) return;
        }
      } catch (err) {
        if (err.name !== 'AbortError') toast(err.message, true);
      } finally {
        if (aiJob === job) aiJob = null;
      }
      if (!job.signal.aborted && btn.isConnected) openToday();
    },
  }, 'wide');
  asPanel();
  firstTip('today');
  showPictures();
}

// Everyone Weftday has seen: in your calendars, in your notes and in saved profiles. email -> who.
function allPeople() {
  const out = new Map();
  const add = (email, displayName) => {
    email = (email || '').toLowerCase();
    if (!email.includes('@') || out.has(email) || /calendar\.google\.com$|resource\./.test(email)) return;
    const who = person({ email, displayName });
    if (!who.self) out.set(email, who);
  };
  for (const key of Object.keys(state.notes || {})) if (key.startsWith('person:')) add(key.slice(7), state.notes[key].title);
  for (const ev of events.values()) for (const g of ev.att || []) if (!g.resource) add(g.email, g.displayName);
  for (const [email, name] of knownNames) add(email, name);
  return out;
}
const peopleAt = domain => [...allPeople().values()].filter(w => w.domain === domain);
// What is saved about a company: taken from the profile of whoever there has the most about it.
function companyFacts(domain) {
  let best = null, bestScore = 0, bestWhen = 0;
  for (const [key, n] of Object.entries(state.notes || {})) {
    if (!key.startsWith('person:') || person({ email: key.slice(7) }).domain !== domain) continue;
    const raw = F.split(n.text || '').raw;
    if (!raw) continue;
    const f = F.parse(raw);
    const score = (f.company ? 2 : 0) + (f.teamSize ? 1 : 0) + f.funding.length + f.people.length + f.clients.length;
    if (score > bestScore || (score === bestScore && score && (n.when || 0) > bestWhen)) { best = f; bestScore = score; bestWhen = n.when || 0; }
  }
  return best && bestScore ? { ...best, when: bestWhen } : null;
}
const firmHtml = f => {
  const part = (label, items) => (items.length ? `<div class="fsec${items.length > 1 ? ' multi' : ''}"><h5>${label}</h5>${items.map(x => `<p>${esc(x)}</p>`).join('')}</div>` : '');
  return part('What they do', f.company ? [f.company] : []) + part('Team size', f.teamSize ? [f.teamSize] : []) + part('Funding', f.funding) + part('Key people', f.people)
    + (f.clients.length ? `<div class="fsec"><h5>Clients</h5><div class="tags">${f.clients.map(x => `<span>${esc(x)}</span>`).join('')}</div></div>` : '');
};
const personRow = (who, sub) => `<button type="button" class="prow2" data-x="person" data-email="${esc(who.email)}">
  ${hasFacts(who.email) ? avatarHtml(who, true) : `<div class="avatar sm" style="--tc:${tagColor(who.email)}">${esc(initials(who.name))}</div>`}
  <span><b>${esc(who.name)}</b><i>${esc(sub)}</i></span></button>`;
const roleOf = who => savedFacts(who.email)?.role || '';

// One company: what it does, who you know there, what is open with them and your meetings.
function openCompany(domain, back) {
  const people = peopleAt(domain), name = people[0]?.company || cap(domain.split('.')[0]);
  const emails = people.map(w => w.email), f = companyFacts(domain);
  const open = openItems(emails, null), notes = N.withPeople(emails, null);
  people.sort((a, b) => hasFacts(b.email) - hasFacts(a.email) || a.name.localeCompare(b.name));
  dialog(`<div class="dbody">
    <div class="phead"><div class="clogo">${logoHtml(domain) || esc(name[0])}</div>
      <div class="pmain"><h3>${esc(name)}</h3><div class="meta">${esc(domain)} · ${people.length} ${people.length === 1 ? 'person' : 'people'} you know</div></div></div>
    <div class="btnrow"><a class="btn" href="https://${esc(domain)}" target="_blank" rel="noopener">Website</a>
      <a class="btn" href="https://www.linkedin.com/search/results/companies/?keywords=${G.enc(name)}" target="_blank" rel="noopener">Find on LinkedIn</a></div>
    <div class="facts">${f ? `<div class="fgroup">${firmHtml(f)}</div><div class="ffoot"><span>From the web${f.when ? ` · ${esc(ago(f.when))}` : ''}. Check before relying on it.</span></div>`
      : '<div class="fempty"><b>No facts yet</b><span>Open someone below and press Get facts. What it finds about the company shows here.</span></div>'}</div>
    <h4>People you know there</h4>
    <div class="plist3">${people.slice(0, 30).map(w => personRow(w, roleOf(w) || w.email)).join('')}</div>
    ${open.length ? `<h4>Still open with them</h4><div class="todo2">${open.slice(0, 10).map(o => `<div>• ${openLine(o)}</div>`).join('')}</div>` : ''}
    <h4>Your meetings</h4>
    <div class="plist2" id="firmMeets"><div class="note">Checking your calendar…</div></div>
    ${notes.length ? `<h4>Your notes from meetings with them</h4><div class="past">${notes.slice(0, 6).map(n => `<div><b>${esc(n.title || 'Meeting')}</b>${n.when ? ` <i>· ${esc(dayLabel(new Date(n.when)))}</i>` : ''}<div class="desc">${esc(AI.gistOf(n.text, 300))}</div></div>`).join('')}</div>` : ''}
    <div class="actions">${back ? '<button type="button" class="btn" data-x="back">Back</button>' : ''}<span class="sp"></span><button type="button" class="btn primary" data-x="close">Close</button></div></div>`, {
    back: () => back(),
    person(x) {
      const w = people.find(p => p.email === x.dataset.email);
      returnTo = () => openCompany(domain, back);
      openPerson({ email: w.email, displayName: w.name }, null);
    },
  });
  showPictures();
  // meetings with the people you know there, newest first (the first few people are enough to find them)
  asPanel();
  const meetBox = $('#firmMeets', el.dlg);
  Promise.all(emails.slice(0, 6).map(e => meetingsWith(e).catch(() => []))).then(lists => {
    const box = meetBox;
    if (!box?.isConnected) return; // another page was opened meanwhile
    const all = [...new Map(lists.flat().map(m => [m.nk, m])).values()].sort((a, b) => b.s - a.s);
    const now = Date.now(), next = all.filter(m => m.s >= now).reverse(), past = all.filter(m => m.s < now);
    const row = m => `<div><i>${esc(dayLabel(new Date(m.s)))}</i> ${esc(m.title || '')}${N.has(m.nk) ? ' <i class="nmark" title="You have notes on this one"></i>' : ''}</div>`;
    box.innerHTML = !all.length ? '<div class="note">No meetings with them in the past year.</div>'
      : `<div class="note">${past.length ? `Met ${past.length === 1 ? 'once' : `${past.length} times`} in the past year` : 'Not met yet'}${next.length ? ` · ${next.length} coming up` : ''}</div>
         ${next.slice(0, 3).map(row).join('')}${past.slice(0, 8).map(row).join('')}`;
  });
}

// "People": everyone you meet, and the companies they are from, with a search box.
let peopleTab = 'people';
function openPeople(tab = peopleTab) {
  peopleTab = tab;
  returnTo = null;
  const mine = myDomains();
  const everyone = [...allPeople().values()];
  const outside = everyone.filter(w => !mine.has(w.domain));
  const firms = new Map();
  for (const w of outside) if (w.company) firms.set(w.domain, [...(firms.get(w.domain) || []), w]);
  dialog(`<div class="dbody ppl">
    <div class="rowline"><h3>People</h3><div class="seg"><button type="button" data-x="tab" data-tab="people" class="${tab === 'people' ? 'on' : ''}">People</button><button type="button" data-x="tab" data-tab="firms" class="${tab === 'firms' ? 'on' : ''}">Companies</button></div></div>
    <input id="pplFind" placeholder="${tab === 'people' ? 'Search by name, company or email' : 'Search companies'}" autocomplete="off" spellcheck="false">
    <div class="plist3 tall" id="pplList"></div>
    <div class="actions"><span class="note" id="pplCount"></span><span class="sp"></span><button type="button" class="btn primary" data-x="close">Close</button></div></div>`, {
    tab: x => openPeople(x.dataset.tab),
    person(x) {
      const w = everyone.find(p => p.email === x.dataset.email);
      returnTo = () => openPeople('people');
      openPerson({ email: w.email, displayName: w.name }, null);
    },
    firm: x => openCompany(x.dataset.domain, () => openPeople('firms')),
  }, 'wide');
  const find = $('#pplFind', el.dlg), list = $('#pplList', el.dlg), count = $('#pplCount', el.dlg);
  const rank = w => (hasFacts(w.email) ? 2 : 0) + (N.has(N.aboutKey(w.email)) ? 1 : 0);
  function paint() {
    const q = find.value.trim().toLowerCase();
    if (tab === 'people') {
      const hits = outside.filter(w => !q || `${w.name} ${w.email} ${w.company}`.toLowerCase().includes(q))
        .sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));
      list.innerHTML = hits.slice(0, 60).map(w => personRow(w, [roleOf(w), roleOf(w) ? '' : w.company].filter(Boolean).join('') || w.email)).join('')
        || `<div class="note">${q ? 'Nobody matches that search.' : 'Nobody here yet. People appear once they are in one of your meetings.'}</div>`;
      count.textContent = hits.length > 60 ? `Showing 60 of ${hits.length}. Search to narrow it down.` : `${hits.length} ${hits.length === 1 ? 'person' : 'people'}`;
    } else {
      const hits = [...firms].filter(([domain, ws]) => !q || `${ws[0].company} ${domain}`.toLowerCase().includes(q))
        .sort((a, b) => b[1].length - a[1].length || a[1][0].company.localeCompare(b[1][0].company));
      list.innerHTML = hits.slice(0, 60).map(([domain, ws]) => `<button type="button" class="prow2" data-x="firm" data-domain="${esc(domain)}">
        <div class="clogo sm">${logoHtml(domain) || esc(ws[0].company[0])}</div><span><b>${esc(ws[0].company)}</b><i>${ws.length} ${ws.length === 1 ? 'person' : 'people'} · ${esc(domain)}</i></span></button>`).join('')
        || '<div class="note">No companies yet. They appear once someone with a company email is in one of your meetings.</div>';
      count.textContent = `${hits.length} ${hits.length === 1 ? 'company' : 'companies'}`;
    }
    showPictures();
  }
  find.addEventListener('input', paint);
  paint();
  asPanel();
  firstTip('people');
  if (innerWidth >= 760) find.focus();
}

// ---------------------------------------------------------------- time zones
// Everything in Weftday is shown in this device's own time zone. On top of that you can look at a
// second zone next to it on the calendar, and write your free times out in someone else's zone.
const zoneParts = (ms, zone) => {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms))) p[x.type] = +x.value;
  return { y: p.year, m: p.month, d: p.day, mins: p.hour * 60 + p.minute };
};
// The moment at which the clocks in that zone show this date and time.
function zoneToMs(y, m, d, mins, zone) {
  const guess = Date.UTC(y, m - 1, d, 0, mins), p = zoneParts(guess, zone);
  return guess - (Date.UTC(p.y, p.m - 1, p.d, 0, p.mins) - guess);
}
const zoneNames = new Map();
// The short name people know a zone by ("CET", "IST", "EST"), or "GMT+3" when it has none.
function zoneShort(zone) {
  if (zoneNames.has(zone)) return zoneNames.get(zone);
  let name = '';
  for (const locale of ['en-GB', 'en-US', 'en-IN', 'en-AU']) {
    name = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || name;
    if (name && !/^(GMT|UTC)[+-]/.test(name)) break;
  }
  if (/^(GMT|UTC)[+-]/.test(name)) name = { 'Asia/Tokyo': 'JST', 'Asia/Seoul': 'KST', 'Asia/Singapore': 'SGT', 'Asia/Hong_Kong': 'HKT', 'Asia/Dubai': 'GST', 'America/Sao_Paulo': 'BRT' }[zone] || name;
  zoneNames.set(zone, name);
  return name;
}
const ZONES = [ // the ones people ask for most; any other can be found by searching
  ['Europe/Berlin', 'Central Europe', 'Berlin, Paris, Amsterdam, Madrid, Rome, Zurich'], ['Europe/London', 'United Kingdom', 'London, Dublin, Lisbon'],
  ['America/New_York', 'US Eastern', 'New York, Boston, Toronto, Miami'], ['America/Chicago', 'US Central', 'Chicago, Dallas, Mexico City'],
  ['America/Denver', 'US Mountain', 'Denver, Salt Lake City'], ['America/Los_Angeles', 'US Pacific', 'San Francisco, Los Angeles, Seattle'],
  ['America/Sao_Paulo', 'Brazil', 'São Paulo, Rio'], ['Asia/Dubai', 'Gulf', 'Dubai, Abu Dhabi'], ['Asia/Kolkata', 'India', 'Mumbai, Delhi, Bengaluru'],
  ['Asia/Singapore', 'Singapore', 'Singapore, Kuala Lumpur'], ['Asia/Hong_Kong', 'Hong Kong', 'Hong Kong'], ['Asia/Tokyo', 'Japan', 'Tokyo, Seoul'],
  ['Australia/Sydney', 'Australia East', 'Sydney, Melbourne'], ['Pacific/Auckland', 'New Zealand', 'Auckland'],
];
const zoneTitle = zone => ZONES.find(z => z[0] === zone)?.[1] || zone.split('/').pop().replace(/_/g, ' ');
const zoneLabel = zone => `${zoneTitle(zone)} (${zoneShort(zone)})`;
function useZone(zone) { // remembered, so the zones you use come first next time
  if (!zone || zone === TZ) return;
  state.settings.zonesUsed = [zone, ...(state.settings.zonesUsed || []).filter(z => z !== zone)].slice(0, 4);
}
// A box to choose a time zone. pick('') means your own. back() returns to where you came from.
function openZonePick(current, pick, back, why) {
  const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const used = (state.settings.zonesUsed || []).filter(z => z !== TZ);
  const row = (zone, title, sub) => {
    let now = '';
    try { now = fmtTime(zoneParts(Date.now(), zone).mins); } catch { return ''; }
    return `<button type="button" class="prow2 zrow${zone === current ? ' on' : ''}" data-x="zone" data-zone="${esc(zone)}">
      <span><b>${esc(title)} <em>${esc(zoneShort(zone))}</em></b><i>${esc(sub)}</i></span><span class="znow">${now}</span></button>`;
  };
  dialog(`<div class="dbody">
    <h3>Time zone</h3>
    <p class="note">${esc(why)}</p>
    <input id="zoneFind" placeholder="Search a city or zone: Paris, Tokyo, EST…" autocomplete="off" spellcheck="false">
    <div class="plist3 tall" id="zoneList"></div>
    <div class="actions">${back ? '<button type="button" class="btn" data-x="back">Back</button>' : ''}<span class="sp"></span><button type="button" class="btn ghost" data-x="close">Close</button></div></div>`, {
    back: () => back(),
    zone(x) { useZone(x.dataset.zone); save(); pick(x.dataset.zone === TZ ? '' : x.dataset.zone); },
  });
  const find = $('#zoneFind', el.dlg), list = $('#zoneList', el.dlg);
  function paint() {
    const q = find.value.trim().toLowerCase();
    let rows = '';
    if (!q) {
      rows += row(TZ, `My own time zone · ${zoneTitle(TZ)}`, 'Everything is shown in this zone');
      for (const z of used) rows += row(z, zoneTitle(z), ZONES.find(x => x[0] === z)?.[2] || 'Used before');
      for (const [z, title, cities] of ZONES) if (z !== TZ && !used.includes(z)) rows += row(z, title, cities);
    } else {
      const seen = new Set();
      for (const [z, title, cities] of ZONES) if (`${title} ${cities} ${z} ${zoneShort(z)}`.toLowerCase().includes(q)) { seen.add(z); rows += row(z, title, cities); }
      for (const z of all) {
        if (seen.size >= 30) break;
        if (seen.has(z) || !z.replace(/_/g, ' ').toLowerCase().includes(q)) continue;
        seen.add(z);
        rows += row(z, z.split('/').pop().replace(/_/g, ' '), z.split('/')[0]);
      }
    }
    list.innerHTML = rows || '<div class="note">No zone matches. Try the name of a large city.</div>';
  }
  find.addEventListener('input', paint);
  paint();
  if (innerWidth >= 760) find.focus();
}
// The calendar's second time zone: its times stand next to your own down the side of the day and week views.
function openSecondZone() {
  openZonePick(state.settings.zone2 || TZ, zone => {
    state.settings.zone2 = zone;
    save();
    closeDialog();
    render();
    toast(zone ? `${zoneLabel(zone)} is now shown next to your own time.` : 'Showing your own time zone only.');
  }, null, 'Pick a second zone to see next to your own on the calendar. Your own time zone always stays the main one.');
}

// ---------------------------------------------------------------- share my free times
// Loads the meetings of some days that may not be on screen.
async function loadDays(from, to) {
  if (DEMO) {
    for (let ws = startOfWeek(from); ws < to; ws = addDays(ws, 7)) for (const ev of demoEvents(ws)) events.set(ev.key, ev);
    return;
  }
  const jobs = [], f0 = from.getTime(), t0 = to.getTime();
  let failed = 0;
  for (const a of state.accounts.filter(a => !a.needsReconnect)) for (const c of a.calendars) {
    if (!c.enabled || isPlannerCal(a, c)) continue;
    jobs.push(G.listEvents(a, c.id, from, to).then(items => {
      for (const [k, ev] of events) if (ev.accountId === a.id && ev.calendarId === c.id && ev.e > f0 && ev.s < t0) events.delete(k); // gone from Google since
      for (const e of items) {
        if (e.status === 'cancelled' || !e.start || e.eventType === 'workingLocation') continue;
        const ev = normalize(e, a, c);
        events.set(ev.key, ev);
      }
    }).catch(err => { failed++; console.warn(a.email, c.summary, err); }));
  }
  await Promise.all(jobs);
  if (jobs.length && failed === jobs.length) throw new Error('offline');
  if (plannerReady()) await sync(() => pullPlanner(from, to)).catch(() => {});
  return failed;
}
// The gaps in a working day that are at least minLen minutes long, on the half hour: [[start, end]].
function freeSlots(d, minLen) {
  const { dayStart, dayEnd } = state.settings, half = m => Math.ceil(m / 30) * 30;
  let p = ymd(d) === todayYmd() ? Math.max(dayStart, half(nowMinutes() + 15)) : dayStart;
  const out = [], add = (s, e) => { s = half(s); e = Math.floor(e / 30) * 30; if (e - s >= minLen) out.push([s, e]); };
  for (const [s, e] of busyOf(d)) {
    if (e <= p) continue;
    if (s >= dayEnd) break;
    if (s > p) add(p, s);
    p = Math.max(p, e);
  }
  if (p < dayEnd) add(p, dayEnd);
  return out;
}
// A short text with the times you are free across all your calendars, ready to paste into an email.
function openFreeTimes(keep = {}) {
  let days = keep.days || 5, length = keep.length || 30, skipped = 0;
  let zone = state.settings.freeZone || '', daytime = state.settings.freeDaytime !== false; // '' = your own zone
  const seg = (name, list, cur) => `<div class="seg">${list.map(([v, l]) => `<button type="button" data-x="${name}" data-v="${v}" class="${v === cur ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  dialog(`<div class="dbody">
    <h3>Share my free times</h3>
    <p class="note">The times you are free across all your calendars, inside your working day. Copy them into an email or a chat.</p>
    <div class="rowline"><span class="note">Look ahead</span><span id="ftDays"></span></div>
    <div class="rowline"><span class="note">Meeting length</span><span id="ftLen"></span></div>
    <div class="rowline"><span class="note">Written in</span><button type="button" class="btn" data-x="zone" id="ftZone"></button></div>
    <label class="check" id="ftDayRow" hidden><input type="checkbox" id="ftDaytime"${daytime ? ' checked' : ''}>Only their daytime, 8am to 8pm</label>
    <textarea id="ftText" rows="9" spellcheck="false">Checking your calendars…</textarea>
    <div class="actions"><span class="note" id="ftNote"></span><span class="sp"></span><button type="button" class="btn ghost" data-x="close">Close</button><button type="button" class="btn primary" data-x="copy">Copy</button></div></div>`, {
    days(x) { days = +x.dataset.v; paint(true); },
    len(x) { length = +x.dataset.v; paint(false); },
    zone() {
      openZonePick(zone || TZ, picked => { state.settings.freeZone = picked; save(); openFreeTimes({ days, length }); },
        () => openFreeTimes({ days, length }), 'Your free times are written out in this zone, so the other person can read them without doing the sums.');
    },
    async copy() {
      const box = $('#ftText', el.dlg);
      try { await navigator.clipboard.writeText(box.value); toast('Copied. Paste it into your email.'); }
      catch { box.select(); toast('Press Cmd+C to copy.'); }
    },
  });
  $('#ftDaytime', el.dlg).addEventListener('change', e => { daytime = e.target.checked; state.settings.freeDaytime = daytime; save(); paint(false); });
  const workDays = () => { // the next working days, starting today
    const out = [];
    for (let d = startOfDay(new Date()); out.length < days; d = addDays(d, 1)) if (d.getDay() % 6) out.push(d);
    return out;
  };
  const at = (d, mins) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, mins).getTime();
  // Your free stretches as moments in time, cut down to the other person's daytime if asked.
  function stretches() {
    const out = [];
    for (const d of workDays()) for (const [s, e] of freeSlots(d, length)) {
      let from = at(d, s), to = at(d, e);
      if (!zone || !daytime) { out.push([from, to]); continue; }
      const p = zoneParts(from, zone);
      for (let n = 0; n < 2; n++) { // their day at the start of the stretch, and the one after
        const day = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
        const open = zoneToMs(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 8 * 60, zone), shut = open + 12 * 3600000;
        const a = Math.max(from, open), b = Math.min(to, shut);
        if (b - a >= length * 60000) out.push([a, b]);
      }
    }
    return out;
  }
  async function paint(load) {
    $('#ftDays', el.dlg).innerHTML = seg('days', [[3, '3 days'], [5, '5 days'], [10, '2 weeks']], days);
    $('#ftLen', el.dlg).innerHTML = seg('len', [[30, '30 min'], [45, '45 min'], [60, '1 hour']], length);
    $('#ftZone', el.dlg).textContent = zone ? zoneLabel(zone) : `My time zone (${zoneShort(TZ)})`;
    $('#ftDayRow', el.dlg).hidden = !zone;
    const list = workDays(), box = $('#ftText', el.dlg);
    if (load) {
      try { skipped = await loadDays(list[0], addDays(list[list.length - 1], 1)) || 0; }
      catch { if (box.isConnected) { box.value = 'Your calendars could not be read. Check your connection and try again.'; } return; }
      if (!box.isConnected) return;
    }
    // each stretch is written under the day it starts on, in the chosen zone
    const z = zone || TZ, byDay = new Map();
    for (const [from, to] of stretches()) {
      const a = zoneParts(from, z), b = zoneParts(to, z), key = `${a.y}-${pad(a.m)}-${pad(a.d)}`;
      const whole = a.mins === 0 && to - from >= 86400000;
      const text = whole ? 'all day' : `${fmtTime(a.mins)} – ${b.mins === 0 ? 'midnight' : fmtTime(b.mins)}${b.d !== a.d && b.mins !== 0 ? ' (next day)' : ''}`;
      byDay.set(key, [...(byDay.get(key) || []), text]);
    }
    const lines = [...byDay].sort((x, y) => x[0].localeCompare(y[0])).map(([key, parts]) => `• ${dayLabel(fromYmd(key))}: ${parts.join(', ')}`);
    box.value = lines.length ? `Here are some times that work for me (${zone ? `${zoneTitle(zone)} time, ${zoneShort(zone)}` : zoneShort(TZ)}):\n${lines.join('\n')}`
      : zone && daytime ? 'No free time that falls in their daytime on these days. Untick “Only their daytime” to see everything.' : 'No free time in your working hours on these days.';
    const live = state.accounts.filter(a => !a.needsReconnect).length, out = state.accounts.length - live;
    $('#ftNote', el.dlg).textContent = DEMO ? 'Sample data' : `${live} account${live === 1 ? '' : 's'} checked${out ? `, ${out} signed out and not counted` : ''}${skipped ? `, ${skipped} calendar${skipped === 1 ? '' : 's'} could not be read` : ''}`;
  }
  firstTip('free');
  paint(true);
}

// ---------------------------------------------------------------- the recorder
// Weftday's own recorder (recorder.js does the capturing and the storing). Here: the screens around
// it, the small bar shown while it runs, the floating controls, the library of what was recorded,
// and turning a recording into meeting notes with your AI key.
const clock = secs => { const h = Math.floor(secs / 3600), m = Math.floor(secs % 3600 / 60), s = secs % 60; return `${h ? `${h}:${pad(m)}` : m}:${pad(s)}`; };
const fmtSize = bytes => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(bytes >= 10485760 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const eventFor = key => [...events.values()].find(ev => noteKey(ev) === key) || null;
const ricon = d => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const REC_ICON = {
  cam: ricon('<path d="M3 7.500A1.500 1.500 0 0 1 4.500 6h9A1.500 1.500 0 0 1 15 7.500v9a1.500 1.500 0 0 1-1.500 1.500h-9A1.500 1.500 0 0 1 3 16.500z"/><path d="M15 10.500l6-3.500v10l-6-3.500"/>'),
  snap: ricon('<path d="M4 8h3l1.500-2h7L17 8h3v11H4z"/><circle cx="12" cy="13.200" r="3.200"/>'),
  notes: ricon('<path d="M5 19.500l1-4L16.500 5l3 3L9 18.500z"/><path d="M14.500 7l3 3"/>'),
  float: ricon('<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11.500" width="6.500" height="5" rx="1" fill="currentColor" stroke="none"/>'),
  sound: ricon('<path d="M4 10v4M8 6v12M12 9v6M16 4v16M20 10v4"/>'),
};
// What was chosen here last time: which microphone and camera, and where the camera sits. Kept on this device only.
const recPrefs = () => { try { return JSON.parse(localStorage.getItem('weftday.rec') || '{}') || {}; } catch { return {}; } };
const saveRecPrefs = p => { try { localStorage.setItem('weftday.rec', JSON.stringify(p)); } catch { /* private window */ } };
// Pictures and recordings are shown through short-lived addresses; they are given back when the box goes away.
const recUrls = [];
const recUrl = blob => { const u = URL.createObjectURL(blob); recUrls.push(u); return u; };
const dropRecUrls = () => { for (const u of recUrls.splice(0)) URL.revokeObjectURL(u); };

// ---- while a recording runs: the bar at the bottom, and the same controls floating over other windows
let recBar = null, recFloat = null, recMeter = 0;
const recViews = () => [recBar, recFloat && !recFloat.closed ? recFloat.document.body : null].filter(Boolean);
function syncRec(session) {
  for (const v of recViews()) {
    v.classList.toggle('paused', session.state === 'paused');
    const p = $('[data-r=pause]', v), c = $('[data-r=cam]', v);
    if (p) p.textContent = session.state === 'paused' ? 'Resume' : 'Pause';
    if (c) { c.classList.toggle('off', !session.look.on); c.setAttribute('aria-pressed', String(session.look.on)); }
  }
}
async function recAct(session, what, btn) {
  if (what === 'stop') {
    for (const v of recViews()) for (const b of $$('button', v)) b.disabled = true;
    btn.textContent = 'Saving…';
    return session.stop();
  }
  if (what === 'pause') { if (session.state === 'recording') session.pause(); else session.resume(); return syncRec(session); }
  if (what === 'cam') { session.setCamera({ on: !session.look.on }); return syncRec(session); }
  if (what === 'float') return openFloat(session);
  if (what === 'notes') return openRecPad(session);
  if (what === 'snap') {
    btn.disabled = true;
    try { const still = await session.snap(); if (still) toast('Still picture kept.', { go: ['Open it', () => openRecording(still.id)] }); }
    catch { toast('The still picture could not be taken.', true); }
    btn.disabled = false;
  }
}
// Notes typed while it records: the meeting's own notes, or a plain pad for a recording that has no meeting.
function openRecPad(session) {
  const ev = eventFor(session.rec.key);
  if (ev) return openEvent(ev, true);
  dialog(`<div class="dbody">
    <h3>Notes while recording</h3>
    <p class="note">Jot down what matters. When the recording ends, these are blended into the notes written from it.</p>
    <textarea name="jot" rows="9" maxlength="20000" placeholder="Key points, decisions, who does what…">${esc(session.rec.jot || '')}</textarea>
    <div class="actions"><span class="sp"></span><button type="button" class="btn primary" data-x="close">Done</button></div></div>`);
  const box = $('textarea', el.dlg);
  box.focus();
  box.addEventListener('input', () => { session.rec.jot = box.value; }); // kept with the recording as it is written
}
function showRecBar(session) {
  recBar ||= Object.assign(document.createElement('div'), { id: 'recBar' });
  recBar.className = '';
  document.body.classList.add('recording');
  recBar.innerHTML = `${session.cam ? '<video class="rface" muted playsinline></video>' : '<span class="rdot"></span>'}
    <b class="rtime">0:00</b>${session.rec.heard.length ? '<span class="rlevel" title="How loud it is right now"><i></i></span>' : ''}<span class="rname">${esc(session.rec.title)}</span>
    <button type="button" class="ricon" data-r="notes" title="Type notes while it records" aria-label="Type notes">${REC_ICON.notes}</button>
    ${session.camera ? `<button type="button" class="ricon" data-r="cam" aria-pressed="true" title="Show or hide your camera in the recording" aria-label="Show or hide your camera">${REC_ICON.cam}</button>` : ''}
    ${session.video ? `<button type="button" class="ricon" data-r="snap" title="Keep a still picture of this moment" aria-label="Keep a still picture">${REC_ICON.snap}</button>` : ''}
    ${'documentPictureInPicture' in window ? `<button type="button" class="ricon" data-r="float" title="Keep these controls on top of your other windows" aria-label="Float the controls">${REC_ICON.float}</button>` : ''}
    <button type="button" data-r="pause">Pause</button><button type="button" class="stop" data-r="stop">Stop</button>`;
  const face = $('.rface', recBar);
  if (face) { face.srcObject = session.cam; face.play().catch(() => {}); }
  recBar.onclick = e => { const b = e.target.closest('[data-r]'); if (b) { e.stopPropagation(); recAct(session, b.dataset.r, b); } };
  (el.dlg.open && !el.dlg.classList.contains('closing') ? el.dlg : document.body).append(recBar); // not into a box that is on its way out
  const level = $('.rlevel i', recBar);
  const draw = () => {
    if (!recBar?.isConnected || session.state === 'stopped') return;
    if (level) level.style.width = `${Math.round(session.level() * 100)}%`;
    recMeter = requestAnimationFrame(draw);
  };
  cancelAnimationFrame(recMeter);
  draw();
}
// The same controls in a small window that stays on top, for when you are in another tab or app.
async function openFloat(session, quiet) {
  if (!('documentPictureInPicture' in window)) return;
  if (recFloat && !recFloat.closed) return recFloat.focus();
  let win = null;
  try { win = await documentPictureInPicture.requestWindow({ width: 330, height: session.cam ? 190 : 100 }); }
  catch { if (!quiet) toast('The floating controls could not be opened here.', true); return; }
  recFloat = win;
  session.keepAwakeIn?.(win); // the screen stays awake through these controls while Weftday's own tab is hidden
  const css = getComputedStyle(document.documentElement), v = n => css.getPropertyValue(n).trim();
  win.document.title = 'Weftday is recording';
  win.document.head.innerHTML = `<style>
    body { margin: 0; height: 100vh; display: grid; place-items: center; overflow: hidden; background: ${v('--panel')}; color: ${v('--text')};
      font: 14px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif; }
    .f { display: grid; justify-items: center; gap: 10px; }
    .row { display: flex; align-items: center; gap: 9px; }
    .d { width: 10px; height: 10px; border-radius: 50%; background: ${v('--now')}; animation: p 1.4s ease-in-out infinite; }
    .paused .d { animation: none; opacity: .4; }
    b { font-variant-numeric: tabular-nums; font-size: 17px; font-weight: 650; min-width: 50px; }
    button { font: inherit; font-weight: 600; border-radius: 99px; padding: 6px 14px; border: 1px solid ${v('--line')}; background: ${v('--bg')}; color: inherit; cursor: pointer; }
    button:disabled { opacity: .6; }
    .stop { background: ${v('--now')}; border-color: ${v('--now')}; color: #fff; }
    video { width: 78px; height: 78px; border-radius: 50%; object-fit: cover; transform: scaleX(-1); background: #000; }
    @keyframes p { 50% { opacity: .35; } }
  </style>`;
  win.document.body.innerHTML = `<div class="f">${session.cam ? '<video muted playsinline></video>' : ''}
    <div class="row"><span class="d"></span><b class="rtime">${clock(session.seconds())}</b><button type="button" data-r="pause">Pause</button><button type="button" class="stop" data-r="stop">Stop</button></div></div>`;
  const face = win.document.querySelector('video');
  if (face) { face.srcObject = session.cam; face.play().catch(() => {}); }
  win.document.body.onclick = e => { const b = e.target.closest('[data-r]'); if (b) recAct(session, b.dataset.r, b); };
  win.addEventListener('pagehide', () => { if (recFloat === win) recFloat = null; });
  syncRec(session);
}
function endRecViews() {
  document.body.classList.remove('recording');
  cancelAnimationFrame(recMeter);
  recBar?.remove();
  if (recFloat && !recFloat.closed) recFloat.close();
  recFloat = null;
}
addEventListener('beforeunload', e => { if (R.current()) { e.preventDefault(); e.returnValue = ''; } }); // do not lose a running recording by accident

// ---- starting a recording. ev is the meeting it belongs to, if any.
// o = { what: 'sound' | 'video' | 'camera' | 'mic', mic, cam, micId, camId, corner, size, auto, preview }
// Asks the browser for what is needed, starts, shows the bar and opens the notes. Throws what the browser throws.
async function beginRecording(ev, o) {
  const wantMic = o.what === 'mic' || o.what === 'camera' || !!o.mic;
  // Asking for the screen comes first, straight from the press: the browser insists on that.
  const streams = await R.ask({ screen: o.what === 'sound' || o.what === 'video', mic: wantMic, micId: o.micId, cam: !!o.cam && !o.preview, camId: o.camId });
  if (o.cam && o.preview) streams.cam = o.preview; // the camera already open in the box carries on into the recording
  const now = new Date();
  const session = await R.start(streams, {
    keepVideo: o.what === 'video', camera: { corner: o.corner, size: o.size },
    key: ev ? noteKey(ev) : '', title: ev ? ev.title : `Recording, ${dayLabel(now)} ${fmtTime(now.getHours() * 60 + now.getMinutes())}`,
    onTick: secs => { for (const v of recViews()) { const t = $('.rtime', v); if (t) t.textContent = clock(secs); } },
    onProblem: () => toast('This browser ran out of room, so the recording was stopped. What was recorded so far is kept.', true),
    onEnd: (rec, endedBy) => {
      endRecViews();
      // Sharing can end by itself (the shared tab is closed, the screen goes to sleep). Say so, also when Weftday is not in front.
      const alone = endedBy === 'share';
      if (alone && document.hidden) systemNote('Recording stopped', `Sharing ended after ${clock(rec.secs)}, so Weftday stopped recording. What was recorded is saved.`);
      if (o.auto && rec.pieceMime && rec.secs >= 5) return autoNotes(rec);
      toast(alone ? `Sharing ended, so the recording stopped. Saved · ${clock(rec.secs)}` : `Recording saved · ${clock(rec.secs)}`, { go: ['Open it', () => openRecording(rec.id)] });
    },
  });
  closeDialog();
  showRecBar(session);
  // The small floating controls open only when asked for (the button in the bar), never by themselves.
  if (ev) openEvent(ev, true); // the meeting's own notes, ready to type in while it records
  const heard = session.rec.heard;
  if (streams.noSystemSound && heard.length < 2) toast('No sound is coming from what you shared. Stop, then share again with the sound switch on: “Share with tab audio” for a tab, “Share with system audio” for Entire screen.', true);
  else if (streams.micFailed) toast('Your microphone could not be used, so your own voice is not being recorded.', true);
  else if (streams.camFailed || (o.cam && !session.cam)) toast('Your camera could not be used, so the recording goes on without it.', true);
  else toast(`Recording${heard.length === 1 ? ` ${heard[0]} only` : ''}. Remember to tell everyone that it is being recorded.`);
  return session;
}
const recStartFailed = err => {
  if (err.name === 'NotAllowedError' || err.name === 'AbortError') toast('Nothing was chosen, so nothing is being recorded.');
  else toast(err.kind === 'nosound' ? err.message : 'The recording could not start. Check that this browser may use your screen, microphone and camera.', true);
};
// One press, for a meeting: listen to it and write the notes, the way it was set up last time.
// The first time (and whenever something has to be chosen) the Record box is shown instead.
function quickRecord(ev) {
  const prefs = recPrefs();
  if (R.current()) return toast('A recording is already running. Stop it first.');
  if (!prefs.seen || !R.canCaptureScreen()) return openRecordSetup(ev);
  beginRecording(ev, { what: 'sound', mic: !prefs.micOff, micId: prefs.micId, auto: !!state.settings.aiKey && prefs.auto !== false }).catch(recStartFailed);
}

// The Record box: what to record, in one row, and little else.
const REC_KINDS = { // name, the long line, the short line on its card, its picture
  sound: ['Meeting', 'Listens to the meeting and writes your notes. No bot joins the call.', 'Listens in and writes your notes', '<path d="M4 12v0M8 8v8M12 5v14M16 8v8M20 12v0"/>'],
  video: ['Screen', 'A video of your screen with its sound, to watch again or pass on.', 'A video of your screen', '<rect x="3" y="4.5" width="18" height="12" rx="2.5"/><path d="M8.5 20h7M12 16.5V20"/>'],
  camera: ['Camera', 'You, talking to the camera.', 'You, talking to the camera', '<rect x="3" y="6" width="13" height="12" rx="3"/><path d="m16 10.5 5-3v9l-5-3z"/>'],
  mic: ['Voice', 'For a meeting in the same room: records through your microphone.', 'People in the same room', '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/>'],
};
function openRecordSetup(ev) {
  if (R.current()) return toast('A recording is already running. Stop it first.');
  if (!R.supported()) return toast('This browser cannot record. Use Chrome on a computer.', true);
  const screen = R.canCaptureScreen(), drawCam = screen && R.canDrawCamera(), prefs = recPrefs(), hasKey = !!state.settings.aiKey;
  const kinds = Object.keys(REC_KINDS).filter(k => screen || k === 'camera' || k === 'mic'), first = kinds[0];
  let preview = null, opening = 0; // the camera, shown while this box is open
  const stopPreview = () => { preview?.getTracks().forEach(t => t.stop()); preview = null; };
  const corner = (value, label) => `<label title="${label}"><input type="radio" name="corner" value="${value}"${(prefs.corner || 'br') === value ? ' checked' : ''}><span></span></label>`;
  const size = (value, label) => `<label><input type="radio" name="size" value="${value}"${(prefs.size || 'medium') === value ? ' checked' : ''}><span>${label}</span></label>`;
  dialog(`<form class="dbody rsetup">
    <h3>${ev ? 'Record this meeting' : 'Record'}</h3>
    ${ev ? `<div class="meta">${esc(ev.title)}</div>` : ''}
    <div class="rpick${kinds.length < 4 ? ' two' : ''}">${kinds.map(k => `<label><input type="radio" name="what" value="${k}"${k === first ? ' checked' : ''}><span><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${REC_KINDS[k][3]}</svg><b>${REC_KINDS[k][0]}</b><i>${REC_KINDS[k][2]}</i></span></label>`).join('')}</div>
    <p class="note" id="recWhy" hidden></p>
    ${hasKey
    ? `<label class="ropt" id="recAutoRow"><span>Write my notes when it ends<i>Google’s AI, with your own key, is sent the sound, who was there and your notes.</i></span><input type="checkbox" class="switch" name="auto"${prefs.seen && prefs.auto === false ? '' : ' checked'}></label>`
    : '<p class="note" id="recAutoRow">To have the notes written for you, <button type="button" class="linkbtn" data-x="aikey">add the free Google AI key</button>.</p>'}
    <label class="ropt" id="recMicRow"><span>Record my own voice too</span><input type="checkbox" class="switch" name="mic"${prefs.micOff ? '' : ' checked'}></label>
    <label class="ropt" id="recCamRow" hidden><span>Show my face in a corner</span><input type="checkbox" class="switch" name="cam"${prefs.camOn ? ' checked' : ''}></label>
    <div class="rcamset" id="recCamSet" hidden>
      <video class="rcam" muted playsinline></video>
      <div class="rcamopts" id="recCamOpts">
        <div><span class="rlbl">Corner</span><div class="rcorners">${corner('tl', 'Top left')}${corner('tr', 'Top right')}${corner('bl', 'Bottom left')}${corner('br', 'Bottom right')}</div></div>
        <div><span class="rlbl">Size</span><div class="segr">${size('small', 'Small')}${size('medium', 'Medium')}${size('large', 'Large')}</div></div>
      </div>
    </div>
    <details class="rmore"><summary>Which microphone or camera</summary>
      <div class="grid2"><label>Microphone<select name="micId"><option value="">The usual one</option></select></label>
      <label>Camera<select name="camId"><option value="">The usual one</option></select></label></div>
    </details>
    ${screen ? '<p class="note rnext" id="recHow">Next, your browser asks what to share. Pick the meeting’s <b>tab</b> and keep its sound switched on. For Zoom or Teams, pick <b>Entire screen</b>.</p>' : ''}
    <div class="actions">${screen ? '<button type="button" class="btn ghost" data-x="shot">Screenshot instead</button>' : ''}<span class="sp"></span><button type="button" class="btn ghost" data-x="close">Cancel</button><button class="btn primary recgo"><i aria-hidden="true"></i>Start recording</button></div>
    <p class="rtell">Please tell everyone that you are recording.</p></form>`, {
    shot: () => { stopPreview(); takeShot(ev); },
    aikey: () => { stopPreview(); openSettings('Making notes from a recording needs the free Google AI key. Add it here.', 'ai'); },
    async submit(fd, form) {
      const what = fd.get('what'), btn = $('button.primary', form);
      const wantCam = what === 'camera' || (what === 'video' && drawCam && fd.get('cam') === 'on');
      saveRecPrefs({ seen: 1, auto: hasKey ? fd.get('auto') === 'on' : prefs.auto, micOff: fd.get('mic') !== 'on', camOn: fd.get('cam') === 'on', corner: fd.get('corner'), size: fd.get('size'), micId: fd.get('micId'), camId: fd.get('camId') });
      btn.disabled = true;
      try {
        const held = wantCam ? preview : null;
        const session = await beginRecording(ev, { what, mic: fd.get('mic') === 'on', cam: wantCam, micId: fd.get('micId'), camId: fd.get('camId'), corner: fd.get('corner'), size: fd.get('size'), auto: hasKey && fd.get('auto') === 'on', preview: held });
        if (held && session.cam === held) preview = null; // it lives on in the recording
      } catch (err) { btn.disabled = false; recStartFailed(err); }
    },
  });
  const form = $('form', el.dlg), f = name => form.elements[name];
  const names = async () => { // the lists of microphones and cameras (their names show once the browser may use them)
    const { mics, cams } = await R.devices();
    for (const [sel, list, keep] of [[f('micId'), mics, prefs.micId], [f('camId'), cams, prefs.camId]]) {
      if (!sel.isConnected) return;
      const now = sel.value || keep || '';
      sel.innerHTML = `<option value="">The usual one</option>${list.map(d => `<option value="${esc(d.id)}">${esc(d.label)}</option>`).join('')}`;
      sel.value = list.some(d => d.id === now) ? now : '';
    }
  };
  const showCamera = async () => {
    const what = f('what').value, need = what === 'camera' || (what === 'video' && drawCam && f('cam').checked);
    $('#recCamSet', form).hidden = !need;
    $('#recCamOpts', form).hidden = what === 'camera';
    if (!need) return stopPreview();
    if (preview) return;
    const mine = ++opening;
    try {
      const got = (await R.ask({ cam: true, camId: f('camId').value })).cam;
      if (mine !== opening || !form.isConnected || $('#recCamSet', form).hidden) return got.getTracks().forEach(t => t.stop()); // no longer wanted
      preview = got;
      const video = $('.rcam', form);
      video.srcObject = preview;
      video.play().catch(() => {});
      names();
    } catch {
      if (mine !== opening || !form.isConnected) return;
      f('cam').checked = false;
      $('#recCamSet', form).hidden = true;
      toast('The camera could not be opened. Check that this browser may use it.', true);
    }
  };
  const sync = () => {
    const what = f('what').value;
    $('#recWhy', form).textContent = REC_KINDS[what][1];
    $('#recMicRow', form).hidden = what === 'mic' || what === 'camera';
    $('#recCamRow', form).hidden = what !== 'video' || !drawCam;
    const how = $('#recHow', form);
    if (how) how.hidden = what === 'mic' || what === 'camera';
    f('camId').closest('label').hidden = what === 'sound' || what === 'mic';
    showCamera();
  };
  form.addEventListener('change', e => {
    if (e.target.name === 'camId') stopPreview(); // another camera was picked: open that one
    if (['what', 'cam', 'camId'].includes(e.target.name)) sync();
  });
  el.dlg.addEventListener('close', stopPreview, { once: true });
  names();
  sync();
}

// One screenshot: Chrome asks what to show, a single picture is kept, and sharing ends at once.
async function takeShot(ev) {
  if (!R.canCaptureScreen()) return toast('This browser cannot take a screenshot. Use Chrome on a computer.', true);
  try {
    const now = new Date();
    const rec = await R.shot({ key: ev ? noteKey(ev) : '', title: `Screenshot, ${dayLabel(now)} ${fmtTime(now.getHours() * 60 + now.getMinutes())}` });
    openRecording(rec.id);
    toast('Screenshot kept.');
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'AbortError') toast('Nothing was chosen, so no screenshot was taken.');
    else toast('The screenshot could not be taken.', true);
  }
}

// What is said in each piece of the recording, then the notes written from all of it.
const LISTEN = 'This is part of a recorded meeting. Write down what is said, as plain text, in the language it is spoken in. Start a new line each time the speaker changes, and begin it with “Speaker 1:”, “Speaker 2:” and so on when you can tell the voices apart. Leave out filler sounds. If nobody speaks, answer with exactly: (silence)';
async function notesFromRecording(rec, signal, say) {
  const key = state.settings.aiKey;
  if (!key) throw Object.assign(new Error('nokey'), { kind: 'nokey' });
  const parts = await R.pieces(rec.id);
  if (!parts.length) throw new Error('This recording has no sound that can be listened to.');
  // Everything Weftday already knows about this meeting goes in with it: that is what makes the notes specific.
  const ev = eventFor(rec.key), guests = ev ? outsiders(ev).filter(x => !x.who.self) : [], emails = guests.map(x => x.who.email);
  const me = ev?.att?.find(p => p.self)?.displayName || '';
  const cast = guests.slice(0, 12).map(x => { const f = savedFacts(x.who.email); return `${x.who.name}${f?.role ? `, ${f.role}` : ''}${x.who.company ? ` (${x.who.company})` : ''}`; });
  // Names it should know how to spell: the people, their companies, and your own company (from your accounts' addresses).
  const known = [...new Set([me, ...guests.slice(0, 12).flatMap(x => [x.who.name, x.who.company]), ...state.accounts.map(a => person({ email: a.email }).company)].filter(Boolean))].slice(0, 30);
  const listen = LISTEN + (cast.length || me ? ` The people in this meeting: ${[me, ...guests.slice(0, 12).map(x => x.who.name)].filter(Boolean).join(', ')}. When a speaker gives their name or is spoken to by name, write that name instead of “Speaker 1”.` : '');
  // Each piece is written down with who spoke and when. If Google's transcription model cannot be
  // used, the general model listens instead: the words are the same, only the times are coarser.
  const pause = () => new Promise((done, fail) => { const t = setTimeout(done, 30000); signal?.addEventListener('abort', () => { clearTimeout(t); fail(new DOMException('Stopped', 'AbortError')); }, { once: true }); });
  const lines = []; // { t: second of the recording, who, text }
  for (let i = 0; i < parts.length; i++) {
    say(parts.length > 1 ? `Listening… part ${i + 1} of ${parts.length}` : 'Listening to the recording…');
    const { blob, at } = parts[i];
    let timed = null, plain = '';
    for (let tries = 0; ; tries++) {
      try { timed = await F.transcribe(blob, rec.pieceMime, key, signal); break; }
      catch (err) {
        if (err.name === 'AbortError' || err.kind === 'key') throw err;
        if (tries < 2 && ['billing', 'credit', 'slow'].includes(err.kind)) { say('Google’s AI asked for a short pause. Carrying on in half a minute…'); await pause(); continue; } // the free key allows only so much a minute
        break; // not available for this key or this sound: listen the other way
      }
    }
    if (!timed) for (let tries = 0; ; tries++) {
      try { plain = await F.askAudio(blob, rec.pieceMime, listen, key, signal); break; }
      catch (err) {
        if (err.name === 'AbortError' || tries >= 2 || !['billing', 'credit', 'busy', 'slow'].includes(err.kind)) throw err;
        say('Google’s AI asked for a short pause. Carrying on in half a minute…');
        await pause();
      }
    }
    if (timed) for (const turn of timed.turns) lines.push({ t: Math.round((at + turn.at) * 10) / 10, who: turn.who == null ? '' : `Speaker ${turn.who + 1}`, text: turn.text, part: i });
    else for (const row of plain.split('\n').map(x => x.trim()).filter(x => x && !/^\(silence\)$/i.test(x))) {
      const named = /^([^:]{1,40}):\s+(.+)$/.exec(row);
      lines.push({ t: at, who: named ? named[1] : '', text: named ? named[2] : row, part: i, rough: true });
    }
  }
  if (!lines.length) throw new Error('No speech was found in this recording.');
  const several = lines.some(l => l.part > 0); // voices are numbered afresh in each piece of a long recording
  const written = () => lines.map((l, i) => `${several && i && l.part !== lines[i - 1].part ? '(the next part of the recording: voices are numbered afresh)\n' : ''}${recLine(l)}`).join('\n');
  let transcript = written();
  await R.update(rec.id, { transcript, lines });
  say('Writing the notes…');
  // What you typed yourself, in the meeting's notes or on the pad, shows what mattered to you.
  const openBox = $('textarea[name=note]', el.dlg), typing = openBox?.dataset.key === rec.key;
  const had = rec.key ? N.get(rec.key) : null;
  const own = (rec.key ? AI.originalOf(typing ? openBox.value : had?.text || '') : rec.jot || '').replace(/^Written from the recording[^\n]*$/m, '').trim(); // (a line older versions put there themselves)
  // What was still open from earlier meetings with the same people, and where things stood last time.
  const earlier = emails.length ? N.withPeople(emails, rec.key) : [], open = emails.length ? openItems(emails, rec.key).slice(0, 12) : [];
  const day = new Date(rec.at), agenda = (ev?.description || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  const raw = await askWriter(room => [
    `You are writing my notes of a meeting I recorded${rec.key && rec.title ? `, called “${rec.title}”` : ''}. It took place on ${day.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.`,
    me ? `I am ${me}. “I”, “me” and “mine” below always mean ${me}.` : 'I am the person who made the recording.',
    cast.length ? `The others in the meeting: ${cast.join('; ')}.` : '',
    known.length ? `Spell these names exactly this way wherever the transcript has something that sounds like one of them (speech-to-text often gets names wrong): ${known.join(', ')}.` : '',
    agenda ? `What the invitation said: ${agenda}` : '',
    earlier.length ? `Where things stood after our last meeting (${dayLabel(new Date(earlier[0].when || rec.at))}): ${AI.gistOf(earlier[0].text, 400)}` : '',
    open.length ? `Still open from earlier meetings:\n${open.map(o => `- ${o.text}`).join('\n')}` : '',
    own ? `My own rough notes, typed during the meeting. They show what mattered most to me: cover every point in them, and correct and complete each one from the transcript. Where the transcript says otherwise, the transcript is right.\n${own.slice(0, 6000)}` : '',
    'Answer with JSON only, no other words, in this shape:',
    '{"title":"three to six words naming what this meeting was about","kind":"sales call | customer call | interview | one-to-one | team meeting | planning | catch-up | other",'
      + '"summary":"two or three sentences: what it was about, what was settled, where things stand now","next":"one sentence: the single most useful next step for me",'
      + '"decisions":["…"],"mine":["…"],"theirs":["…"],"questions":["…"],"facts":["…"],"settled":["…"],'
      + '"voices":{"Speaker 1":"that person’s real name, only when the talk makes it certain, otherwise empty"},"chapters":[{"at":"m:ss","title":"three to six words"}]}',
    'decisions: what was agreed or settled. mine: what I have to do; start with a verb and keep the deadline, written as a date when one was meant (“Send the contract by Fri 20 Nov”). theirs: what somebody else promised; start with their name and a colon (“Ravi: send the security questionnaire by Wed 18 Nov”). When it is not clear who will do something, it goes in theirs, starting with “Someone:”. questions: what was left open. facts: prices, numbers, dates, names and other details worth keeping exactly as said. settled: lines from “Still open from earlier meetings” that this meeting dealt with, copied word for word.',
    'Fit the notes to the kind of meeting: for a sales or customer call bring out what they need, their objections and the next step; for an interview, strengths, concerns and what happens next; for a team meeting, who does what by when.',
    'chapters: where the talk moves to a new subject, with the time from the transcript where it starts; three to eight for a long meeting, none for one shorter than five minutes.',
    'Use only what was said. Leave a list empty when there is nothing for it. Write in the language the meeting was held in.',
    `Transcript (each line starts with its time):\n${transcript.slice(0, Math.max(4000, room - 9000))}`,
  ].filter(Boolean).join('\n'), signal);
  let got = {};
  try { got = JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] || '{}'); } catch { got = {}; }
  const line = v => String(v || '').replace(/\s+/g, ' ').trim();
  const list = v => (Array.isArray(v) ? v : []).map(line).filter(Boolean).slice(0, 20);
  const settled = list(got.settled).filter(x => open.some(o => o.text.toLowerCase() === x.toLowerCase())); // only ones that really were open
  const result = {
    summary: [line(got.summary), line(got.next) ? `Next: ${line(got.next)}` : ''].filter(Boolean).join('\n'),
    decisions: list(got.decisions), actions: list(got.mine ?? got.actions), waiting: list(got.theirs), questions: list(got.questions),
    info: [...list(got.facts), ...(settled.length ? [`Settled from last time: ${settled.join('; ')}`] : [])],
  };
  if (!result.summary && !result.actions.length && !result.decisions.length) throw new Error('The AI could not write notes from this recording. Please try again.');
  // Voices get their real names where the talk made them certain, and the recording gets its chapters.
  const voices = got.voices && typeof got.voices === 'object' && !several ? got.voices : {};
  let renamed = false;
  for (const l of lines) { const name = line(voices[l.who]).slice(0, 40); if (name && !/^speaker\b/i.test(name)) { l.who = name; renamed = true; } }
  if (renamed) transcript = written();
  const seconds = at => { const p = String(at || '').split(':').map(Number); return p.length > 1 && p.every(Number.isFinite) ? p.reduce((sum, x) => sum * 60 + x, 0) : NaN; };
  const chapters = (Array.isArray(got.chapters) ? got.chapters : []).map(c => ({ t: seconds(c?.at), title: line(c?.title).slice(0, 80) }))
    .filter(c => c.title && c.t >= 0 && c.t <= (rec.secs || 1e9)).sort((x, y) => x.t - y.t).slice(0, 12);
  // A recording that has no meeting gets a name that says what it was about.
  const named = !rec.key && /^Recording, /.test(rec.title) && line(got.title) ? line(got.title).slice(0, 80) : '';
  if (named) rec.title = named;
  // Says where the notes came from, so nobody takes them for something typed by hand. "Your notes" below
  // it holds only what you really typed, and is empty when that is nothing.
  const source = `Written by AI from what was said in the recording of ${dayLabel(new Date(rec.at))}.`;
  const sourced = text => { const at = text.lastIndexOf(`\n\n${AI.ORIGINAL_MARK}\n`), head = at < 0 ? text : text.slice(0, at); return `${head}\n\n${source}\n\n${AI.ORIGINAL_MARK}\n${own}`; };
  // into the meeting's own notes, above whatever you typed yourself
  let notes = '';
  if (rec.key) {
    notes = sourced(AI.layout(result, own)).slice(0, N.MAX_LENGTH);
    N.set(rec.key, notes, ev ? { title: ev.title, when: ev.s, people: outsiders(ev).map(x => x.who.email).slice(0, 30) } : { title: had?.title || rec.title, when: had?.when || rec.at, people: had?.people || [] });
    scheduleFlush();
    renderView();
    const box = $('textarea[name=note]', el.dlg); // the meeting's box is open: show the new notes in it
    if (box?.dataset.key === rec.key) { box.value = notes; box.dispatchEvent(new Event('input')); }
  } else notes = sourced(AI.layout(result, own));
  await R.update(rec.id, { notes, transcript, lines, chapters, ...(named ? { title: named } : {}) });
  return { transcript, notes, actions: result.actions.length, waiting: result.waiting.length };
}
// The AI services that can write from a long text, best first: Google reads a whole meeting in one go,
// then the service chosen in Settings, then any other you have saved a key for. If one is busy or has
// used up its free allowance, the next one is asked, so notes do not depend on a single service.
function writers() {
  const s = state.settings, out = [];
  const add = id => {
    const svc = S.AI_SERVICES[id];
    if (!svc || out.some(w => w.id === id)) return;
    if (id === 'google') { if (s.aiKey) out.push({ id, room: 500000, keys: { provider: 'google', google: s.aiKey } }); }
    else if (svc.kind === 'chat' && svc.base && (aiKeyOf(id) || (svc.noKey && s.aiProvider === id))) out.push({ id, room: svc.room || 60000, keys: { provider: id, key: aiKeyOf(id), model: s.aiModels?.[id] || '' } });
  };
  add('google'); add(s.aiProvider);
  for (const id of Object.keys(S.AI_SERVICES)) add(id);
  return out;
}
// build(room) gives the text to send, cut to what a service can take in one go.
async function askWriter(build, signal) {
  const list = writers();
  if (!list.length) throw Object.assign(new Error('nokey'), { kind: 'nokey' });
  let first = null;
  for (const w of list) {
    try { return await F.askPlain(build(w.room), w.keys, signal); }
    catch (err) { if (err.name === 'AbortError') throw err; first ||= err; }
  }
  throw first;
}
// Each action point in a note becomes a task in the inbox (ones you already have are not made twice).
function tasksFromNotes(text, from, when = new Date()) {
  const have = new Set(state.tasks.map(t => t.title.toLowerCase()));
  const fresh = AI.actionsIn(text).filter(a => !have.has(a.slice(0, 200).toLowerCase()));
  if (!fresh.length) return toast('These action points are already in your tasks.');
  mark();
  for (const title of fresh) {
    const read = parseQuick(title, when), day = read.date && read.date >= todayYmd() ? read.date : null; // “by Friday” becomes that Friday; a day already gone stays in the inbox
    state.tasks.push(newTask({ title: title.slice(0, 200), notes: `From: ${from}`, ...(day ? { date: day, start: read.start } : {}) }));
  }
  commit();
  toast(fresh.length === 1 ? 'Task added to your inbox' : `${fresh.length} tasks added to your inbox`, { undo: true });
}
// When a recording ends and you asked for it: the notes are written without another press.
async function autoNotes(rec) {
  const stop = new AbortController();
  toast(`Recording saved · ${clock(rec.secs)}. Writing the notes…`);
  try {
    const done = await notesFromRecording(rec, stop.signal, text => setStatus(text));
    setStatus('');
    const from = `${rec.title} (${dayLabel(new Date(rec.at))})`;
    const counts = [done.actions ? `${done.actions} for you` : '', done.waiting ? `${done.waiting} waiting on others` : ''].filter(Boolean).join(', ');
    if (done.actions) toast(`Notes written · ${counts}`, { go: [done.actions === 1 ? 'Make the task' : 'Make tasks', () => tasksFromNotes(done.notes, from, new Date(rec.at))] });
    else if (counts) toast(`Notes written · ${counts}`, { go: ['Open', () => (eventFor(rec.key) ? openEvent(eventFor(rec.key)) : openRecording(rec.id))] });
    else toast('Notes written.', { go: ['Open', () => (eventFor(rec.key) ? openEvent(eventFor(rec.key)) : openRecording(rec.id))] });
  } catch (err) {
    setStatus('');
    if (err.kind === 'nokey') toast('Recording saved. Add your AI key to have the notes written.', { go: ['Add my key', () => needKey('Writing notes from a recording', { back: () => openRecording(rec.id) })] });
    else toast(`Recording saved. ${err.message || 'The notes could not be written.'}`, { err: true, go: ['Open it', () => openRecording(rec.id)] });
  }
}

// ---- afterwards: one recording, and the library of them all
const recLine = l => `[${clock(Math.floor(l.t))}] ${l.who ? `${l.who}: ` : ''}${l.text}`; // one line of what was said, as it is written down
const REC_SPEEDS = [1, 1.25, 1.5, 2];
// Notes as they are read: headings, lists and the next step, instead of one block of text.
const NOTE_HEADS = /^(Summary|Decisions|Action points|Waiting on others|Open questions|Also noted)$/;
function notesHtml(text) {
  let html = '', list = false;
  for (const raw of text.split('\n')) {
    const row = raw.trim(), item = /^[-*•]\s+(.+)$/.exec(row);
    if (item) { html += `${list ? '' : '<ul>'}<li>${esc(item[1])}</li>`; list = true; continue; }
    if (list) { html += '</ul>'; list = false; }
    if (!row) continue;
    if (NOTE_HEADS.test(row)) html += `<h5>${esc(row)}</h5>`;
    else if (/^Next:\s/.test(row)) html += `<p class="rnext"><b>Next</b>${esc(row.replace(/^Next:\s*/, ''))}</p>`;
    else html += `<p>${esc(row)}</p>`;
  }
  return html + (list ? '</ul>' : '');
}
const recKind = r => (r.kind === 'shot' ? 'Screenshot' : r.kind === 'video' ? 'Video' : 'Sound');
const recFileName = r => `${r.title.replace(/[^\w -]+/g, '').trim() || 'recording'}.${r.mime === 'image/png' ? 'png' : r.mime.includes('mp4') ? (r.kind === 'audio' ? 'm4a' : 'mp4') : 'webm'}`;
// One recording: play it, name it, get notes from it, save it as a file, or delete it.
async function openRecording(id, back) {
  const rec = await R.get(id);
  if (!rec) return toast('That recording is no longer here.', true);
  dropRecUrls();
  const blob = await R.file(id), url = blob ? recUrl(blob) : '';
  const ev = eventFor(rec.key), shot = rec.kind === 'shot', canNote = !shot && !!rec.pieceMime;
  const facts = shot ? [dayLabel(new Date(rec.at)), rec.w ? `${rec.w} × ${rec.h}` : '', fmtSize(rec.size)]
    : [dayLabel(new Date(rec.at)), clock(rec.secs), fmtSize(rec.size), rec.heard?.length ? `heard ${rec.heard.join(' and ')}` : 'no sound', rec.cam && rec.surface ? 'with your camera' : '', rec.cut ? 'cut short' : ''];
  const stage = !url ? '<p class="note">This recording has no playable part.</p>'
    : shot ? `<div class="rstage"><img class="rshot" alt="${esc(rec.title)}" src="${url}"></div>`
      : rec.kind === 'video' ? `<div class="rstage"><video class="rplay" controls playsinline src="${url}"></video></div>` : `<audio class="rplay" controls src="${url}"></audio>`;
  dialog(`<div class="dbody">
    <input class="rtitle" name="title" value="${esc(rec.title)}" maxlength="120" aria-label="Name of this ${shot ? 'screenshot' : 'recording'}" title="Press to rename">
    <div class="meta">${esc(facts.filter(Boolean).join(' · '))}</div>
    ${stage}
    <div class="btnrow">
      ${canNote ? `<button type="button" class="btn primary" data-x="notes">${rec.notes ? 'Write the notes again' : 'Write the notes'}</button>` : ''}
      ${rec.notes && AI.actionsIn(rec.notes).length ? '<button type="button" class="btn" data-x="mktasks">Make tasks</button>' : ''}
      ${shot && url ? '<button type="button" class="btn primary" data-x="copy">Copy</button>' : ''}
      ${shot && url ? `<a class="btn" href="${url}" download="${esc(recFileName(rec))}">Save as a file</a>` : ''}
      ${url && !rec.share ? '<button type="button" class="btn" data-x="share">Share link</button>' : ''}
      ${ev ? '<button type="button" class="btn" data-x="meeting">Open the meeting</button>' : ''}
    </div>
    ${rec.share ? `<div class="rshare"><input readonly value="${esc(rec.share.url)}" aria-label="The link to this ${shot ? 'screenshot' : 'recording'}"><button type="button" class="btn primary" data-x="copylink">Copy link</button><button type="button" class="btn ghost" data-x="unshare">Stop sharing</button></div>
    <p class="note">${rec.share.open === false ? 'Your organisation does not allow links that anyone can open. Share this copy from Google Drive with the people who should see it.' : 'Anyone you send this link to can watch. The copy is in your own Google Drive, in “Weftday recordings”.'}</p>` : ''}
    <div class="note" id="recSay" hidden></div>
    ${rec.notes ? `<div class="rnotes">${notesHtml(AI.originalOf(rec.notes) === rec.notes ? rec.notes : rec.notes.slice(0, rec.notes.indexOf(AI.ORIGINAL_MARK)).trim())}</div>` : ''}
    ${rec.transcript ? `<form class="rask"><input name="q" maxlength="300" autocomplete="off" placeholder="Ask about this ${ev ? 'meeting' : 'recording'}: what did we agree on price?" aria-label="Ask about this recording"><button class="btn">Ask</button></form>
    <div class="desc rtext ranswer" id="recAnswer" hidden></div>` : ''}
    ${rec.chapters?.length > 1 ? `<details class="rfold"><summary>Chapters</summary><div class="rchaps">${rec.chapters.map(c => `<button type="button" data-x="jump" data-t="${+c.t}"><em>${clock(Math.floor(c.t))}</em>${esc(c.title)}</button>`).join('')}</div></details>` : ''}
    ${rec.transcript ? `<details class="rfold"><summary>What was said</summary>${rec.lines?.length
    ? `<div class="rlines">${rec.lines.map(l => `<button type="button" class="rline" data-x="jump" data-t="${+l.t}"><em>${clock(Math.floor(l.t))}</em><span>${l.who ? `<b>${esc(l.who)}</b> ` : ''}${esc(l.text)}</span></button>`).join('')}</div>`
    : `<div class="desc rtext">${esc(rec.transcript)}</div>`}</details>` : ''}
    ${url && !shot ? `<details class="rfold"><summary>Speed, save as a file${R.canTrim(rec) && rec.secs >= 6 ? ', trim' : ''}</summary>
      <div class="rspeed"><span class="rlbl">Speed</span><div class="seg">${REC_SPEEDS.map(v => `<button type="button" data-x="speed" data-v="${v}" class="${v === 1 ? 'on' : ''}">${v}×</button>`).join('')}</div></div>
      <div class="btnrow"><a class="btn" href="${url}" download="${esc(recFileName(rec))}">Save as a file</a>${R.canTrim(rec) && rec.secs >= 6 ? '<button type="button" class="btn" data-x="trim">Trim</button>' : ''}</div>
      <div class="rtrim" id="recTrim" hidden>
        <div class="rtrimrow"><button type="button" class="btn" data-x="trimfrom">Start here</button><button type="button" class="btn" data-x="trimto">End here</button>
          <span class="rkeep">Keeping <b id="trimSpan"></b></span><span class="sp"></span><button type="button" class="btn primary" data-x="trimsave">Save trimmed copy</button></div>
        <p class="note">Move the player to where it should begin and press “Start here”, then to where it should stop and press “End here”. The original stays as it is; the cut lands within two seconds of the spot.</p>
      </div></details>` : ''}
    <div class="actions"><button type="button" class="btn danger" data-x="del">Delete</button>${back ? '<button type="button" class="btn" data-x="back">Back</button>' : ''}<span class="sp"></span><button type="button" class="btn ghost" data-x="close">Close</button></div></div>`, {
    back: () => back(),
    meeting: () => openEvent(ev),
    mktasks: () => tasksFromNotes(rec.notes, `${rec.title} (${dayLabel(new Date(rec.at))})`, new Date(rec.at)),
    share: btn => { btn.disabled = true; shareRecording(id, back).finally(() => { if (btn.isConnected) btn.disabled = false; }); },
    async copylink() {
      try { await navigator.clipboard.writeText(rec.share.url); toast('Link copied.'); }
      catch { const box = $('.rshare input', el.dlg); box.focus(); box.select(); toast('Press Copy on your keyboard to copy the link.'); }
    },
    async unshare(btn) {
      if (!confirm('Stop sharing? The copy is removed from your Google Drive and the link stops working. The recording stays here.')) return;
      const a = acct(rec.share.account);
      btn.disabled = true;
      try {
        if (a && !a.needsReconnect) await D.remove(a, rec.share.id);
        await R.update(id, { share: null });
        toast(a && !a.needsReconnect ? 'The link no longer works.' : 'Forgotten here. That account is not connected, so remove the copy in Google Drive yourself.');
        openRecording(id, back);
      } catch (err) { btn.disabled = false; toast(err.message || 'It could not be removed from Google Drive. Please try again.', true); }
    },
    jump(x) { const m = $('.rplay', el.dlg); if (m) { m.currentTime = +x.dataset.t; m.play().catch(() => {}); } },
    trim() { const box = $('#recTrim', el.dlg); box.hidden = !box.hidden; showKeep(); },
    trimfrom() { const m = $('.rplay', el.dlg); keep.from = Math.min(m.currentTime, keep.to - 1); showKeep(); },
    trimto() { const m = $('.rplay', el.dlg); keep.to = Math.max(m.currentTime, keep.from + 1); showKeep(); },
    async trimsave(btn) {
      if (keep.from < 0.5 && keep.to > rec.secs - 0.5) return toast('Choose where it should start or end first.');
      btn.disabled = true;
      try {
        const copy = await R.trim(id, keep.from, keep.to);
        if (copy.lines?.length) await R.update(copy.id, { transcript: copy.lines.map(recLine).join('\n') });
        toast(`Trimmed copy saved · ${clock(copy.secs)}`);
        openRecording(copy.id, back);
      } catch (err) { btn.disabled = false; toast(err.kind === 'notrim' ? err.message : 'The trimmed copy could not be made.', true); }
    },
    // A question about what was said, answered from the text of this recording only.
    async submit(fd, form) {
      const q = String(fd.get('q') || '').trim(), out = $('#recAnswer', el.dlg), btn = $('button', form);
      if (!q) return;
      if (!writers().length) return needKey('Asking about a recording', { back: () => openRecording(rec.id) });
      const job = newJob();
      btn.disabled = true;
      out.hidden = false;
      out.textContent = 'Looking through what was said…';
      try {
        const answer = await askWriter(room => [
          'Answer the question from the transcript of a recorded meeting below, and from nothing else. Be brief and plain: a sentence or two, or a short list. Quote names, numbers and dates exactly as they were said. If the transcript does not say, answer: “That did not come up in this recording.”',
          `Question: ${q}`,
          `Transcript:\n${rec.transcript.slice(0, Math.max(4000, room - 2000))}`,
        ].join('\n'), job.signal);
        if (out.isConnected) out.textContent = String(answer || '').trim() || 'No answer came back. Please try again.';
      } catch (err) {
        if (err.name !== 'AbortError' && out.isConnected) out.textContent = err.message || 'That could not be answered just now. Please try again.';
      } finally { if (aiJob === job) aiJob = null; if (btn.isConnected) btn.disabled = false; }
    },
    speed(x) {
      const media = $('.rplay', el.dlg);
      if (media) media.playbackRate = +x.dataset.v;
      for (const b of $$('[data-x=speed]', el.dlg)) b.classList.toggle('on', b === x);
    },
    async copy() {
      try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('Copied. Paste it anywhere.'); }
      catch { toast('It could not be copied here. Use “Save as a file” instead.', true); }
    },
    async del() {
      if (!confirm(`Delete this ${shot ? 'screenshot' : 'recording'}? It cannot be brought back.`)) return;
      await R.remove(id);
      toast(shot ? 'Screenshot deleted' : 'Recording deleted');
      if (back) back(); else closeDialog();
    },
    async notes(btn) {
      const say = $('#recSay', el.dlg), job = newJob();
      btn.disabled = true;
      say.hidden = false;
      try {
        await notesFromRecording(rec, job.signal, text => { if (say.isConnected) say.textContent = text; });
        if (job.signal.aborted || !say.isConnected) return;
        toast(rec.key ? 'Notes written into the meeting.' : 'Notes written.');
        openRecording(id, back);
      } catch (err) {
        if (err.name === 'AbortError' || !say.isConnected) return;
        btn.disabled = false;
        say.hidden = true;
        if (err.kind === 'nokey') needKey('Writing notes from a recording', { back: () => openRecording(rec.id) });
        else toast(err.message || 'The notes could not be made. Please try again.', true);
      } finally { if (aiJob === job) aiJob = null; }
    },
  }, rec.kind === 'audio' ? '' : 'wide');
  asPanel();
  const title = $('.rtitle', el.dlg), media = $('.rplay', el.dlg);
  const keep = { from: 0, to: rec.secs || 0 }; // the stretch a trimmed copy would keep
  const showKeep = () => { const span = $('#trimSpan', el.dlg); if (span) span.textContent = `${clock(Math.floor(keep.from))} – ${clock(Math.ceil(keep.to))} (${clock(Math.max(1, Math.round(keep.to - keep.from)))})`; };
  title.addEventListener('change', async () => {
    const name = title.value.replace(/\s+/g, ' ').trim() || rec.title;
    title.value = rec.title = name;
    await R.update(id, { title: name });
  });
  title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
  // A recording made by a browser that cannot say how long its file is: a jump to the end finds out.
  if (media) media.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(media.duration)) return;
    media.addEventListener('durationchange', () => { if (Number.isFinite(media.duration)) media.currentTime = 0; }, { once: true });
    media.currentTime = 1e7;
  }, { once: true });
  if (media && rec.lines?.length) {
    // the line being said is marked as it plays
    const rows = $$('.rline', el.dlg);
    media.addEventListener('timeupdate', () => {
      let now = -1;
      for (let i = 0; i < rec.lines.length && rec.lines[i].t <= media.currentTime + 0.25; i++) now = i;
      rows.forEach((row, i) => row.classList.toggle('now', i === now));
    });
    // a video also gets them as captions (the CC button in the player)
    if (rec.kind === 'video') {
      const stamp = t => { const ms = Math.max(0, Math.round(t * 1000)); return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${String(ms % 1000).padStart(3, '0')}`; };
      const cues = rec.lines.filter(l => !l.rough).map((l, i, all) => `${stamp(l.t)} --> ${stamp(Math.max(l.t + 1, Math.min(all[i + 1]?.t ?? l.t + 8, l.t + 12)))}\n${`${l.who ? `${l.who}: ` : ''}${l.text}`.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}`);
      if (cues.length) media.append(Object.assign(document.createElement('track'), { kind: 'captions', label: 'Captions', srclang: 'en', src: recUrl(new Blob([`WEBVTT\n\n${cues.join('\n\n')}\n`], { type: 'text/vtt' })) }));
    }
  }
  const keys = e => {
    const m = $('.rplay', el.dlg);
    if (!m || e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, textarea, select, button, a, audio, video')) return;
    const jump = { ArrowLeft: -5, ArrowRight: 5, j: -10, l: 10 }[e.key];
    if (e.key === ' ' || e.key === 'k') { if (m.paused) m.play(); else m.pause(); }
    else if (jump) m.currentTime = clamp(m.currentTime + jump, 0, Number.isFinite(m.duration) ? m.duration : 1e7);
    else if (e.key === 'm') m.muted = !m.muted;
    else if (e.key === 'f' && m.requestFullscreen) m.requestFullscreen().catch(() => {});
    else return;
    e.preventDefault();
  };
  el.dlg.addEventListener('keydown', keys);
  el.dlg.addEventListener('close', () => { el.dlg.removeEventListener('keydown', keys); dropRecUrls(); }, { once: true });
}

// One question, answered from all your meeting notes and from what was said in every recording.
function openAskAll() {
  if (!writers().length) return needKey('Asking your meetings');
  dialog(`<form class="dbody">
    <h3>Ask your meetings</h3>
    <p class="note">The answer comes from your meeting notes and from what was said in your recordings, and from nothing else. They are sent to your AI service for this one answer.</p>
    <div class="rask"><input name="q" maxlength="300" autocomplete="off" placeholder="What did we agree with Acme about price?" aria-label="Your question"><button class="btn primary">Ask</button></div>
    <div class="desc rtext ranswer tall" id="askAnswer" hidden></div>
    <div class="actions"><span class="sp"></span><button type="button" class="btn ghost" data-x="close">Close</button></div></form>`, {
    async submit(fd, form) {
      const q = String(fd.get('q') || '').trim(), out = $('#askAnswer', form), btn = $('button', form);
      if (!q) return;
      const job = newJob();
      btn.disabled = true;
      out.hidden = false;
      out.textContent = 'Reading through your meetings…';
      try {
        // newest first: the notes of every meeting (short, and they hold the decisions), then what was said in each recording
        const notes = Object.entries(state.notes || {}).filter(([key, n]) => !key.startsWith('person:') && n.text).sort((a, b) => (b[1].when || 0) - (a[1].when || 0))
          .map(([, n]) => `### Meeting notes: ${n.title || 'a meeting'} · ${dayLabel(new Date(n.when || Date.now()), true)}\n${n.text.slice(0, 4000)}`);
        const said = (await R.all()).filter(r => r.transcript).map(r => `### What was said: ${r.title} · ${dayLabel(new Date(r.at), true)}\n${r.transcript.slice(0, 60000)}`);
        if (!notes.length && !said.length) { out.textContent = 'There are no meeting notes or recordings with notes yet. Record a meeting, or write notes on one, and ask again.'; return; }
        const answer = await askWriter(room => {
          let left = room - 3000;
          const fit = [];
          for (const block of [...notes, ...said]) { if (block.length > left) { if (left > 2000) fit.push(block.slice(0, left)); break; } fit.push(block); left -= block.length; }
          return [
            `Today is ${dayLabel(new Date(), true)}. Answer my question from my meeting notes and recordings below, and from nothing else.`,
            'Be brief and plain: a few sentences or a short list. After each point, say which meeting it comes from and its date, in brackets. Quote names, numbers and dates exactly. If they do not say, answer: “That is not in your notes or recordings.”',
            `Question: ${q}`,
            fit.join('\n\n'),
          ].join('\n');
        }, job.signal);
        if (out.isConnected) out.textContent = String(answer || '').trim() || 'No answer came back. Please try again.';
      } catch (err) {
        if (err.name !== 'AbortError' && out.isConnected) out.textContent = err.message || 'That could not be answered just now. Please try again.';
      } finally { if (aiJob === job) aiJob = null; if (btn.isConnected) btn.disabled = false; }
    },
  }, 'wide');
  $('input[name=q]', el.dlg).focus();
}
// ---- share links: a copy in your own Google Drive, and a link to it
// The account whose Drive is used: the one your tasks live in, or else the first one that is connected.
const shareAccount = () => (plannerAccount() && !plannerAccount().needsReconnect ? plannerAccount() : state.accounts.find(a => !a.needsReconnect)) || null;
async function shareRecording(id, back) {
  if (DEMO) return toast('This is sample data. Open the app without “?demo” to share a recording.');
  const rec = await R.get(id), a = shareAccount(), say = text => { const line = $('#recSay', el.dlg); if (line) { line.hidden = !text; line.textContent = text; } };
  if (!rec) return;
  if (!a) return toast('Connect a Google account first: the link is made in your own Google Drive.', true);
  const blob = await R.file(id);
  if (!blob) return toast('This recording has nothing to share.', true);
  say('Getting your Google Drive ready…');
  try {
    const folderId = await D.folder(a, state.settings.driveFolder);
    if (folderId !== state.settings.driveFolder) { state.settings.driveFolder = folderId; save(); }
    const fileId = await D.upload(a, blob, recFileName(rec), folderId, part => say(`Putting a copy in your Google Drive… ${Math.round(part * 100)}%`));
    let open = true;
    try { await D.publish(a, fileId); } catch (err) { if (err.kind !== 'policy') { await D.remove(a, fileId).catch(() => {}); throw err; } open = false; }
    const url = D.linkTo(fileId);
    await R.update(id, { share: { id: fileId, url, at: Date.now(), account: a.id, open } });
    if (open) navigator.clipboard?.writeText(url).catch(() => {});
    toast(open ? 'Link copied. Anyone you send it to can watch.' : 'The copy is in your Google Drive. Your organisation does not allow open links: share it from there.');
    if ($('#recSay', el.dlg)) openRecording(id, back);
  } catch (err) {
    say('');
    if (err.name === 'AbortError') return;
    if (err.kind === 'scope') return openDriveAsk(a, id);
    if (err.kind === 'off') return openDriveOff(err.link, id, back);
    toast(err.message || 'The link could not be made. Please try again.', true);
  }
}
// The first time: Google has to be asked whether Weftday may add files to Drive.
function openDriveAsk(a, id) {
  if (R.current()) return toast('Stop the recording that is running first: asking Google takes you away from this page for a moment.', true);
  dialog(`<div class="dbody">
    <h3>One permission from Google</h3>
    <p class="note" style="color:var(--text)">To make a link, Weftday puts a copy of the recording in your own Google Drive (${esc(a.email)}), in a folder called “Weftday recordings”. Google will now ask you to allow that.</p>
    <p class="note">Weftday can only see the files it puts there itself, nothing else in your Drive. This is asked once.</p>
    <div class="actions"><span class="sp"></span><button type="button" class="btn ghost" data-x="close">Not now</button><button type="button" class="btn primary" data-x="go">Continue to Google</button></div></div>`, {
    go: () => G.startConnect(a.email, { drive: true, after: { share: id } }).catch(err => toast(err.message, true)),
  });
}
// Google Drive has to be switched on once for the Google project the keys belong to.
function openDriveOff(link, id, back) {
  const open = /^https:\/\/console\.(developers|cloud)\.google\.com\//.test(link || '') ? link : 'https://console.cloud.google.com/apis/library/drive.googleapis.com';
  dialog(`<div class="dbody">
    <h3>Switch on Google Drive, once</h3>
    <p class="note" style="color:var(--text)">Share links use Google Drive, and it is not switched on yet for your Google project (the one your Google keys come from).</p>
    <ol class="steps"><li>Press <b>Open Google</b> below. If Google says you need access, switch (top right) to the Google account you made your keys with. The project named at the top should be the one with your keys.</li><li>Press the blue <b>Enable</b> button and wait a few seconds.</li><li>Come back here and press <b>Try again</b>.</li></ol>
    <div class="actions"><a class="btn" href="${esc(open)}" target="_blank" rel="noopener">Open Google</a><span class="sp"></span><button type="button" class="btn ghost" data-x="close">Not now</button><button type="button" class="btn primary" data-x="again">Try again</button></div></div>`, {
    again: () => openRecording(id, back).then(() => shareRecording(id, back)),
  });
}

// Everything recorded and kept in this browser: for one meeting (ev), or all of it.
let recShow = 'all';
async function openRecordings(ev) {
  const every = ev ? await R.forMeeting(noteKey(ev)) : await R.all(), total = every.reduce((n, r) => n + (r.size || 0), 0);
  const kinds = [['all', 'All'], ['video', 'Videos'], ['audio', 'Sound'], ['shot', 'Screenshots']].filter(([k]) => k === 'all' || every.some(r => r.kind === k));
  if (!kinds.some(([k]) => k === recShow)) recShow = 'all';
  const list = every.filter(r => recShow === 'all' || r.kind === recShow);
  dropRecUrls();
  const card = r => `<button type="button" class="rcard" data-x="open" data-id="${esc(r.id)}">
    <span class="rthumb ${esc(r.kind)}">${r.thumb ? `<img alt="" loading="lazy" src="${recUrl(r.thumb)}">` : (r.kind === 'audio' ? REC_ICON.sound : '')}${r.kind === 'shot' ? '' : `<em>${clock(r.secs)}</em>`}</span>
    <b>${esc(r.title)}</b><i>${esc(dayLabel(new Date(r.at)))} · ${fmtSize(r.size)}${r.notes ? ' · notes made' : ''}${r.cut ? ' · cut short' : ''}</i></button>`;
  dialog(`<div class="dbody">
    <h3>${ev ? 'Recordings of this meeting' : 'Recordings'}</h3>
    ${every.length ? `<p class="note">${every.length} kept in this browser, ${fmtSize(total)} in all. They stay on this device and are not copied to your other ones.</p>` : ''}
    ${kinds.length > 2 ? `<div class="seg rkinds">${kinds.map(([k, l]) => `<button type="button" data-x="kind" data-v="${k}" class="${k === recShow ? 'on' : ''}">${l}</button>`).join('')}</div>` : ''}
    ${every.length ? `<div class="rgrid">${list.map(card).join('')}</div>`
    : `<div class="rempty">${REC_ICON.snap}<b>Nothing recorded yet</b><span>Record a meeting to get its notes written for you, record your screen to show someone how something works, or keep a screenshot.</span></div>`}
    <div class="actions">${R.supported() ? `<button type="button" class="btn" data-x="rec">Record${ev && every.length ? ' again' : ''}</button>` : ''}${R.canCaptureScreen() ? '<button type="button" class="btn" data-x="shot">Screenshot</button>' : ''}${ev ? '' : '<button type="button" class="btn" data-x="askall">Ask your meetings</button>'}<span class="sp"></span><button type="button" class="btn primary" data-x="close">Close</button></div></div>`, {
    open: x => openRecording(x.dataset.id, () => openRecordings(ev)),
    kind: x => { recShow = x.dataset.v; openRecordings(ev); },
    rec: () => openRecordSetup(ev),
    shot: () => takeShot(ev),
    askall: () => openAskAll(),
  }, 'wide');
  asPanel();
  el.dlg.addEventListener('close', dropRecUrls, { once: true });
  // videos that have no small picture yet (cut off, or made by an older version) get one now, one at a time
  for (const r of list.filter(x => x.kind === 'video' && !x.thumb)) {
    const thumb = await R.makeThumb(r.id).catch(() => null), spot = $(`.rcard[data-id="${CSS.escape(r.id)}"] .rthumb`, el.dlg);
    if (!spot) return;
    if (thumb) spot.insertAdjacentHTML('afterbegin', `<img alt="" src="${recUrl(thumb)}">`);
  }
}

// ---------------------------------------------------------------- Home
// The place the app opens on: what is next, today's schedule, today's tasks and your latest notes.
// The calendar and the notes are each one press away.
async function renderHome() {
  const now = new Date(), today = startOfDay(now), ds = ymd(today), nowM = nowMinutes();
  const day = dayItems(today), timed = day.timed.filter(i => i.kind === 'task' || i.ev.selfStatus !== 'declined').sort((a, b) => a.s - b.s);
  const meets = timed.filter(i => i.kind === 'ev');
  const running = meets.find(i => i.s <= nowM && i.e > nowM), up = running || meets.find(i => i.s > nowM);
  const later = up ? null : [...events.values()].filter(ev => !ev.allDay && ev.selfStatus !== 'declined' && enabledEvent(ev) && ev.s > now.getTime()).sort((a, b) => a.s - b.s)[0] || null;
  const hour = now.getHours(), hello = hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const name = (knownNames.get((plannerAccount() || state.accounts[0])?.email || '') || '').split(' ')[0];
  const mine = state.tasks.filter(t => t.date === ds), open = mine.filter(t => !t.done);
  const carried = state.tasks.filter(t => t.date && t.date < ds && !t.done).length, inbox = state.tasks.filter(t => !t.date && !t.done).length;
  const left = meets.filter(i => i.e > nowM).length;
  const sum = [meets.length ? `${left} of ${meets.length} meeting${meets.length === 1 ? '' : 's'} to go` : 'no meetings today', mine.length ? `${open.length} task${open.length === 1 ? '' : 's'} left` : ''].filter(Boolean).join(' · ');
  const people = ev => outsiders(ev).filter(x => !x.who.self).slice(0, 5).map(x => `<span class="pchip still"><div class="avatar sm" style="--tc:${tagColor(x.who.email)}">${esc(initials(x.who.name))}</div><span>${esc(x.who.name)}</span></span>`).join('');
  const buttons = ev => `<div class="btnrow">${ev.meet ? `<a class="btn primary" href="${esc(ev.meet)}" target="_blank" rel="noopener">Join video call</a>` : ''}
      ${R.supported() ? `<button type="button" class="btn" data-act="home-record" data-ev="${esc(ev.key)}">Record</button>` : ''}
      ${outsiders(ev).length ? `<button type="button" class="btn" data-act="home-brief" data-ev="${esc(ev.key)}">Brief me</button>` : ''}</div>`;
  let hero;
  if (up) {
    const ev = up.ev, mins = up.s - nowM;
    const chip = running ? `Now · until ${fmtTime(up.e)}` : mins < 60 ? `In ${mins} min` : `At ${fmtTime(up.s)}`;
    hero = `<section class="hnext" style="--c:${evColor(ev)}"><span class="hchip${running ? ' now' : ''}">${chip}</span>
      <button type="button" class="hopen" data-key="${esc(ev.key)}"><b>${esc(ev.title)}</b><i>${esc(fmtRange(up.s, up.e))}${ev.location && ev.location.length <= 60 && !/^https?:/i.test(ev.location) ? ` · ${esc(ev.location)}` : ''}</i></button>
      ${people(ev) ? `<div class="pchips">${people(ev)}</div>` : ''}${buttons(ev)}</section>`;
  } else if (later) {
    const s = new Date(later.s), tomorrow = ymd(s) === ymd(addDays(today, 1));
    hero = `<section class="hnext quiet"><span class="hchip">${meets.length ? 'Done for today' : 'A clear day'}</span>
      <button type="button" class="hopen" data-key="${esc(later.key)}"><i>Your next meeting</i><b>${esc(later.title)}</b><i>${tomorrow ? 'Tomorrow' : esc(dayLabel(s, true))} · ${esc(fmtTime(s.getHours() * 60 + s.getMinutes()))}</i></button></section>`;
  } else {
    hero = `<section class="hnext quiet"><span class="hchip">${state.accounts.length || DEMO ? 'A clear stretch' : 'Welcome'}</span>
      <div class="hopen"><b>${state.accounts.length || DEMO ? 'No meetings in the next two weeks' : 'See your whole day here'}</b><i>${state.accounts.length || DEMO ? 'A good time for the tasks that need room.' : 'Connect your Google account and your meetings, with who is in them, show up on this page.'}</i></div>
      ${state.accounts.length || DEMO ? '' : '<div class="btnrow"><button type="button" class="btn primary" data-act="home-connect">Connect Google account</button></div>'}</section>`;
  }
  const row = i => {
    const past = i.e <= nowM, live = i.s <= nowM && i.e > nowM;
    if (i.kind === 'task') return `<div class="hrow task${i.t.done ? ' done' : ''}${past ? ' past' : ''}" data-id="${esc(i.t.id)}"><span class="ht">${fmtTime(i.s)}</span><button class="chk" data-act="toggle" aria-label="Mark done"></button><span class="hb"><b>${esc(i.t.title)}</b><em>${fmtDur(i.e - i.s)}${i.t.tag ? ` · #${esc(i.t.tag)}` : ''}</em></span></div>`;
    const who = outsiders(i.ev).filter(x => !x.who.self).map(x => x.who.name.split(' ')[0]);
    return `<div class="hrow${past ? ' past' : ''}${live ? ' live' : ''}" data-key="${esc(i.ev.key)}"><span class="ht">${fmtTime(i.s)}</span><i class="hbar" style="background:${evColor(i.ev)}"></i><span class="hb"><b>${esc(i.ev.title)}</b><em>${esc(fmtRange(i.s, i.e))}${who.length ? ` · with ${esc(who.slice(0, 3).join(', '))}${who.length > 3 ? ` +${who.length - 3}` : ''}` : ''}</em></span></div>`;
  };
  const untimed = mine.filter(t => t.start == null);
  el.home.innerHTML = `<div class="hwrap">
    <header class="hhello"><h2>${hello}${name ? `, ${esc(name)}` : ''}</h2><p>${esc(sum.charAt(0).toUpperCase() + sum.slice(1))}</p></header>
    <div class="hmain">${hero}
      <section class="hsec"><h4><span>Today</span><button type="button" class="linkbtn" data-act="home-calendar">Open the calendar</button></h4>
        ${timed.length ? timed.map(row).join('') : '<p class="hnone">Nothing is scheduled today.</p>'}</section>
    </div>
    <aside class="hside">
      <section class="hsec"><h4><span>Tasks today</span><span>${mine.length ? `${mine.length - open.length} of ${mine.length} done` : ''}</span></h4>
        ${untimed.length || mine.length ? (untimed.length ? untimed : mine).slice(0, 8).map(t => `<div class="hrow task slim${t.done ? ' done' : ''}" data-id="${esc(t.id)}"><button class="chk" data-act="toggle" aria-label="Mark done"></button><span class="hb"><b>${esc(t.title)}</b></span></div>`).join('') : '<p class="hnone">No tasks planned for today.</p>'}
        <p class="hfoot">${[carried ? `${carried} carried over` : '', inbox ? `${inbox} waiting in your inbox` : ''].filter(Boolean).join(' · ') || 'Nothing carried over.'}</p>
        <button type="button" class="btn" data-act="plan">Plan my day</button></section>
      <section class="hsec" id="homeNotes"><h4><span>Latest notes</span><button type="button" class="linkbtn" data-act="home-notes">All notes</button></h4><div class="hnotes"></div></section>
    </aside></div>`;
  const docs = (await noteDocs().catch(() => [])).filter(d => d.text).slice(0, 4), spot = $('#homeNotes .hnotes', el.home);
  if (!spot || view !== 'home') return; // drawn again meanwhile, or left: the newer drawing fills itself in
  spot.innerHTML = docs.length
    ? docs.map(d => `<button type="button" class="hnote" data-act="home-note" data-note="${esc(d.id)}"><b>${esc(d.title)}</b><em>${esc(dayLabel(new Date(d.when)))}${d.recorded ? ' · recorded' : ''}</em><span>${esc(noteGist(d.text))}</span></button>`).join('')
    : '<p class="hnone">Notes you write on a meeting, and notes written for you from a recording, show up here.</p>';
}

// ---------------------------------------------------------------- the Notes page
// Every note in one place: what you wrote on a meeting, notes of your own, and notes written from a
// recording. The list is on the left, the note you pick opens beside it and is edited right there.
let noteOpen = '', noteFind = '', noteDraft = null; // the note showing, the search, and a new note not yet typed in
const isOwnNote = id => id.startsWith('note:');
async function noteDocs() {
  const recs = await R.all().catch(() => []), recorded = new Set(recs.filter(r => r.key && r.kind !== 'shot').map(r => r.key));
  const docs = Object.entries(state.notes || {}).filter(([key, n]) => !key.startsWith('person:') && (n.text || key === noteOpen))
    .map(([key, n]) => ({ id: key, kind: isOwnNote(key) ? 'own' : 'meeting', title: n.title || (isOwnNote(key) ? 'Untitled' : 'Meeting'), when: n.when || n.t || 0, text: n.text || '', people: n.people || [], recorded: recorded.has(key) }));
  for (const r of recs) if (!r.key && r.notes) docs.push({ id: `rec:${r.id}`, kind: 'rec', title: r.title, when: r.at, text: r.notes, people: [], recorded: true });
  if (noteDraft && !docs.some(d => d.id === noteDraft.id)) docs.push(noteDraft);
  return docs.sort((a, b) => b.when - a.when);
}
const plainNote = text => text.replace(/^\s*(#{1,3}|[-*•])\s+/gm, '').replace(/\[( |x|X)?\]\s*/g, ''); // without the marks for headings, bullets and tick-boxes
const noteGist = text => { const plain = plainNote(text), body = AI.gistOf(plain, 110); return (body || plain).replace(/\s+/g, ' ').trim().slice(0, 110); };
function noteRows(docs) {
  const q = noteFind.trim().toLowerCase(), hits = q ? docs.filter(d => `${d.title}\n${d.text}`.toLowerCase().includes(q)) : docs;
  if (!hits.length) return `<p class="nnone">${q ? 'No note has those words.' : 'No notes yet.'}</p>`;
  const today = startOfDay(new Date()).getTime(), week = startOfWeek(new Date()).getTime();
  const group = d => (d.when >= today ? 'Today' : d.when >= week ? 'This week' : d.when >= today - 30 * 86400000 ? 'Last 30 days' : 'Earlier');
  let html = '', last = '';
  for (const d of hits) {
    const g = group(d);
    if (g !== last) { html += `<h4>${g}</h4>`; last = g; }
    html += `<button type="button" class="nrow${d.id === noteOpen ? ' on' : ''}" data-note="${esc(d.id)}"><b>${esc(d.title)}</b>
      <i>${esc(dayLabel(new Date(d.when)))}${d.kind === 'own' ? ' · your note' : d.recorded ? ' · recorded' : ''}</i><span>${esc(noteGist(d.text))}</span></button>`;
  }
  return html;
}
async function renderNotes() {
  const docs = await noteDocs();
  if (view !== 'notes') return;
  if (!docs.some(d => d.id === noteOpen)) noteOpen = innerWidth >= 760 && docs.length ? docs[0].id : '';
  const typing = el.notes.contains(document.activeElement) && $('.ndoc', el.notes)?.dataset.id === noteOpen && !!document.activeElement.closest('.ndoc');
  if (!$('.nlist', el.notes)) {
    el.notes.innerHTML = `<div class="nlist"><div class="nhead"><input type="search" id="noteFind" placeholder="Search your notes" aria-label="Search your notes" autocomplete="off"><button type="button" class="btn" id="noteNew">New note</button></div><div class="nrows"></div></div><div class="ndoc"></div>`;
    $('#noteFind', el.notes).addEventListener('input', e => { noteFind = e.target.value; noteDocs().then(all => { $('.nrows', el.notes).innerHTML = noteRows(all); }); });
    $('#noteNew', el.notes).addEventListener('click', () => {
      noteDraft = { id: `note:${uid()}`, kind: 'own', title: 'Untitled', when: Date.now(), text: '', people: [], recorded: false };
      noteOpen = noteDraft.id;
      renderNotes().then(() => $('.ndoc .ntitle', el.notes)?.select());
    });
    el.notes.addEventListener('click', e => {
      const row = e.target.closest('[data-note]');
      if (row) { noteOpen = row.dataset.note; renderNotes(); }
      else if (e.target.closest('#noteBack')) { noteOpen = ''; renderNotes(); }
    });
  }
  $('.nrows', el.notes).innerHTML = noteRows(docs);
  el.notes.classList.toggle('reading', !!noteOpen); // on a phone: the note takes the place of the list
  if (typing) return; // never redraw a note while it is being typed in
  const doc = docs.find(d => d.id === noteOpen), pane = $('.ndoc', el.notes);
  pane.dataset.id = noteOpen;
  if (!doc) {
    pane.innerHTML = `<div class="nempty">${toolIcon('notes')}<b>${docs.length ? 'Pick a note' : 'Your notes will gather here'}</b><span>${docs.length ? 'Choose one from the list to read or change it.' : 'Notes you write on a meeting, notes written for you from a recording, and notes of your own are all kept here.'}</span></div>`;
    return;
  }
  const ev = doc.kind === 'meeting' ? eventFor(doc.id) : null, names = doc.people.map(e => knownNames.get(e) || person({ email: e }).name).slice(0, 4);
  pane.innerHTML = `<div class="ndochead"><button type="button" class="icon only-mobile" id="noteBack" aria-label="Back to the list">‹</button>
      <input class="ntitle" value="${esc(doc.title)}" maxlength="140" aria-label="Title"${doc.kind === 'own' ? '' : ' readonly'}></div>
    <div class="meta">${esc([dayLabel(new Date(doc.when), true), names.join(', '), doc.kind === 'rec' ? 'written from a recording' : doc.kind === 'own' ? 'your note' : doc.recorded ? 'recorded' : ''].filter(Boolean).join(' · '))}</div>
    <textarea name="ndoc" maxlength="${N.MAX_LENGTH}" aria-label="The note" placeholder="Start writing.  - makes a bullet, [] a tick-box, # a heading.">${esc(doc.text)}</textarea>
    <div class="ndocfoot"><span class="saved" id="ndocState"></span><span class="sp"></span>
      <button type="button" class="btn" id="ndocCopy" title="Copy the note, ready to paste into an email or a chat">Copy</button>
      <button type="button" class="btn" id="ndocTasks" hidden>Make tasks</button>
      ${ev ? '<button type="button" class="btn" id="ndocMeeting">Open the meeting</button>' : ''}${doc.kind === 'rec' ? '<button type="button" class="btn" id="ndocRec">Open the recording</button>' : ''}
      ${doc.kind === 'own' ? '<button type="button" class="btn danger" id="ndocDel">Delete</button>' : ''}</div>`;
  const box = $('textarea', pane), title = $('.ntitle', pane), state2 = $('#ndocState', pane), tasks = $('#ndocTasks', pane);
  E.attach(box);
  const about = () => ({ title: (title.value.trim() || 'Untitled').slice(0, 140), when: doc.when, people: doc.people });
  const showTasks = () => { const n = AI.actionsIn(box.value).length; tasks.hidden = !n; tasks.textContent = n === 1 ? 'Make 1 task' : `Make ${n} tasks`; };
  let timer = 0, last = box.value;
  const keep = async () => {
    clearTimeout(timer);
    if (doc.kind === 'rec') { if (box.value !== last) { last = box.value; await R.update(doc.id.slice(4), { notes: box.value }); } }
    else {
      const had = state.notes[doc.id];
      if (box.value !== last) { last = box.value; N.set(doc.id, box.value, about()); }
      else if (had && had.title !== about().title) { Object.assign(had, { title: about().title, t: Date.now(), dirty: true }); save(); } // only the title changed
      if (noteDraft?.id === doc.id && state.notes[doc.id]) noteDraft = null;
      scheduleFlush();
    }
    state2.textContent = 'Saved';
    noteDocs().then(all => { if (view === 'notes') $('.nrows', el.notes).innerHTML = noteRows(all); });
  };
  const soon = () => { state2.textContent = ''; showTasks(); clearTimeout(timer); timer = setTimeout(keep, 600); };
  box.addEventListener('input', soon);
  box.addEventListener('change', keep);
  title.addEventListener('input', soon);
  title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); box.focus(); } });
  tasks.addEventListener('click', () => tasksFromNotes(box.value, `${about().title} (${dayLabel(new Date(doc.when))})`, new Date(doc.when)));
  $('#ndocCopy', pane).addEventListener('click', () => { // the title, the day, then the note as it is kept: plain text that reads well anywhere
    const text = `${title.value.trim() || doc.title}\n${dayLabel(new Date(doc.when), true)}\n\n${box.value.trim()}\n`;
    navigator.clipboard.writeText(text).then(() => toast('Note copied'), () => toast('Could not copy the note', true));
  });
  $('#ndocMeeting', pane)?.addEventListener('click', () => openEvent(ev));
  $('#ndocRec', pane)?.addEventListener('click', () => openRecording(doc.id.slice(4)));
  $('#ndocDel', pane)?.addEventListener('click', () => {
    if (!confirm('Delete this note? It cannot be brought back.')) return;
    clearTimeout(timer);
    N.set(doc.id, '', about());
    if (noteDraft?.id === doc.id) noteDraft = null;
    scheduleFlush();
    noteOpen = '';
    renderNotes();
    toast('Note deleted');
  });
  showTasks();
}

// ---------------------------------------------------------------- showing people around
// The first time Weftday opens, a short tour points at each part of the main screen, one at a time.
// The first time a feature's own box opens, one line at the top of that box says what it is for.
const TOUR = [ // three steps, never more: the rest explains itself as you use it
  { find: () => $('#connect'), side: true, when: () => !state.accounts.length && !DEMO, // nothing connected yet: this comes first
    title: 'Start with your calendar', text: 'Connect a Google account and your meetings appear here. Add work and personal: they show together, each in its own colour.' },
  { find: () => $('#recBtn'), side: true,
    title: 'Record a meeting', text: 'One press. Weftday listens, and when the meeting ends your notes and next steps are already written. No bot joins the call.' },
  { find: () => $('#mainNav'), side: true,
    title: 'Everything has a place', text: 'Home is your day. Calendar, Notes, Recordings and People are one press away, and so is anything else: press “/” to search.' },
  { find: () => $('.qbox'), side: true, when: () => state.accounts.length > 0 || DEMO,
    title: 'Add a task the way you say it', text: 'Type “gym tomorrow 7am” and press Enter. That is the whole tour.' },
];
let tourOn = false;
function startTour() {
  if (tourOn) return;
  const phone = innerWidth < 760;
  // only the parts that are on screen here (a phone has no second-time-zone button, for one)
  const steps = TOUR.filter(s => { const t = s.find(); return t && (s.side && phone ? true : t.offsetParent !== null) && (!s.when || s.when()); });
  if (!steps.length) return;
  tourOn = true;
  let at = 0;
  const box = document.createElement('div');
  box.id = 'tour';
  box.innerHTML = `<div class="tour-hole"></div><div class="tour-card" role="dialog" aria-label="A quick tour of Weftday">
    <div class="tour-count"></div><h4></h4><p></p>
    <div class="tour-actions"><button type="button" class="linkbtn" data-t="skip">Skip the tour</button><span class="sp"></span>
      <button type="button" class="btn" data-t="back">Back</button><button type="button" class="btn primary" data-t="next">Next</button></div></div>`;
  document.body.append(box);
  const hole = box.querySelector('.tour-hole'), card = box.querySelector('.tour-card');
  function place() {
    const s = steps[at], last = at === steps.length - 1;
    document.body.classList.toggle('side-open', phone && !!s.side);
    const target = s.find();
    if (!target) return go(1);
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    card.querySelector('.tour-count').textContent = `${at + 1} of ${steps.length}`;
    card.querySelector('h4').textContent = s.title;
    card.querySelector('p').textContent = s.text;
    card.querySelector('[data-t=back]').hidden = at === 0;
    card.querySelector('[data-t=next]').textContent = last ? 'Done' : 'Next';
    const settle = () => { // after any sliding panel has stopped moving
      const r = target.getBoundingClientRect(), pad = s.big ? -6 : 6, W = innerWidth, H = innerHeight;
      const x = Math.max(6, r.left - pad), y = Math.max(6, r.top - pad);
      const w = Math.min(W - 6, r.right + pad) - x, h = Math.min(H - 6, r.bottom + pad) - y;
      hole.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
      const cw = Math.min(340, W - 24), ch = card.offsetHeight || 170;
      let cx, cy;
      if (s.big) { cx = x + (w - cw) / 2; cy = y + Math.min(90, h / 5); } // a large area: the note sits inside it
      else if (y + h + 14 + ch <= H) { cx = x; cy = y + h + 14; }            // below
      else if (y - 14 - ch >= 0) { cx = x; cy = y - 14 - ch; }                // above
      else if (x + w + 14 + cw <= W) { cx = x + w + 14; cy = y; }             // to the right
      else { cx = x - 14 - cw; cy = y; }                                      // to the left
      card.style.cssText = `width:${cw}px;left:${clamp(cx, 12, W - cw - 12)}px;top:${clamp(cy, 12, H - ch - 12)}px`;
    };
    settle();
    setTimeout(settle, 320);
    card.querySelector('[data-t=next]').focus({ preventScroll: true });
  }
  function end(done) {
    tourOn = false;
    box.remove();
    document.body.classList.remove('side-open');
    removeEventListener('resize', place);
    removeEventListener('keydown', keys, true);
    try { localStorage.setItem('weftday.toured', '1'); } catch { /* private window */ }
    toast(done ? 'That’s the tour. Each feature also explains itself the first time you open it.' : 'Tour closed. You can take it again from Settings → Your data.');
  }
  function go(step) {
    at += step;
    if (at < 0) at = 0;
    if (at >= steps.length) return end(true);
    place();
  }
  function keys(e) { // the tour takes the keyboard while it is open
    if (!['Escape', 'ArrowRight', 'ArrowLeft', 'Enter'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') end(false); else go(e.key === 'ArrowLeft' ? -1 : 1);
  }
  box.addEventListener('click', e => {
    e.stopPropagation(); // the page underneath must not react (on a phone it would close the side menu)
    const b = e.target.closest('[data-t]');
    if (!b) return;
    if (b.dataset.t === 'skip') end(false); else go(b.dataset.t === 'back' ? -1 : 1);
  });
  addEventListener('resize', place);
  addEventListener('keydown', keys, true);
  place();
}
// Starts the tour once, the first time the app opens with nothing else on screen.
function maybeTour() {
  let seen = '1';
  try { seen = localStorage.getItem('weftday.toured'); } catch { /* private window: no tour */ }
  if (seen || tourOn) return;
  if (el.dlg.open) return el.dlg.addEventListener('close', () => setTimeout(maybeTour, 500), { once: true });
  startTour();
}
// One line at the top of a feature's box, the first time that box is opened.
const FIRST_TIPS = {
  meeting: 'This is a meeting. <b>Brief me</b> gathers what you know about the guests. Your notes below are private, and <b>Tidy my notes</b> turns them into action points.',
  person: 'Everything about one person. <b>Get facts</b> looks them up on the web. What you write about them here shows in every meeting you have together.',
  today: 'Your meetings for today, each with who is coming, what happened last time and what is still open. Press a name for the full profile.',
  people: 'Everyone from your meetings. Switch to <b>Companies</b> to see them grouped. Press anyone to open their profile.',
  free: 'Your open slots across all your calendars. Pick the other person’s time zone, then press <b>Copy</b> and paste it into an email.',
  plan: 'Tick the tasks you want to do today, and Weftday fits them into the gaps between your meetings.',
};
function firstTip(id) {
  if (tourOn) return;
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem('weftday.tips') || '{}'); } catch { return; }
  const body = $('.dbody', el.dlg);
  if (seen[id] || !body || $('.ftip', el.dlg)) return;
  seen[id] = 1;
  try { localStorage.setItem('weftday.tips', JSON.stringify(seen)); } catch { return; }
  const tip = document.createElement('div');
  tip.className = 'ftip';
  tip.innerHTML = `<span class="ftip-mark">New</span><span>${FIRST_TIPS[id]}</span><button type="button" class="linkbtn">Got it</button>`;
  tip.querySelector('button').onclick = () => tip.remove();
  body.insertBefore(tip, body.children[1] || null);
}

// ---------------------------------------------------------------- sample data (?demo)
const DEMO_ACCOUNTS = [
  { id: 'work@example.com', email: 'work@example.com', color: '#3566e0', calendars: [{ id: 'work', summary: 'Work', primary: true, accessRole: 'owner', enabled: true }] },
  { id: 'personal@example.com', email: 'personal@example.com', color: '#1a9a6c', calendars: [{ id: 'personal', summary: 'Personal', primary: true, accessRole: 'owner', enabled: true }] },
];
function demoEvents(ws) {
  const wk = ymd(ws);
  const mk = (who, day, h, m, mins, title, extra = {}) => {
    const s = addDays(ws, day); s.setHours(h, m);
    const a = DEMO_ACCOUNTS[who], id = `d${wk}-${day}-${h}-${m}`;
    return {
      key: `${a.id}|${a.calendars[0].id}|${id}`, id, accountId: a.id, calendarId: a.calendars[0].id,
      title, s: s.getTime(), e: s.getTime() + mins * 60000, allDay: false, location: '', htmlLink: '', meet: '', description: '',
      att: [], selfStatus: null, organizerSelf: true, calWritable: false, canEdit: false, nk: id, files: [], links: [], ...extra,
    };
  };
  const invite = status => ({ selfStatus: status, organizerSelf: false, att: [
    { email: 'priya@example.com', displayName: 'Priya Shah', organizer: true, responseStatus: 'accepted' },
    { email: 'work@example.com', displayName: 'You', self: true, responseStatus: status }] });
  // A day that falls on one fixed date, shown only in the week it belongs to.
  const once = (who, y, mo, d, h, m, mins, title, extra) => { const day = Math.round((new Date(y, mo - 1, d) - ws) / 86400000); return day >= 0 && day < 7 ? [mk(who, day, h, m, mins, title, extra)] : []; };
  // someone else in the meeting, by first name and where they are from
  const withThem = (who, name, email) => ({ att: [{ email, displayName: name, responseStatus: 'accepted' }, { email: DEMO_ACCOUNTS[who].email, displayName: 'You', self: true, responseStatus: 'accepted' }] });
  return [
    mk(0, 0, 10, 0, 30, 'Weekly team sync', invite('accepted')),
    mk(0, 0, 14, 0, 60, 'Client call: Acme', { location: 'Google Meet', meet: 'https://meet.google.com/', att: [
      { email: 'ravi.menon@acme.com', displayName: 'Ravi Menon', organizer: true, responseStatus: 'accepted' },
      { email: 'lena@acme.com', responseStatus: 'tentative' },
      { email: 'work@example.com', displayName: 'You', self: true, responseStatus: 'accepted' }],
      links: [{ label: 'Fireflies notes', url: 'https://app.fireflies.ai/' }] }),
    mk(0, 0, 16, 30, 60, 'Evolve session'),
    mk(1, 0, 19, 30, 60, 'Dinner with Meera'),
    mk(0, 1, 11, 0, 45, 'Pipeline review', invite('needsAction')),
    mk(0, 1, 11, 30, 30, 'Quick check-in with Arjun'),
    mk(0, 1, 15, 0, 45, 'Interview: growth lead, round two'),
    mk(1, 1, 18, 30, 60, 'Dance class', { location: 'Studio 9', ...withThem(1, 'Shruti', 'shruti@studio9.example') }),
    mk(0, 2, 9, 30, 60, 'Product demo', invite('accepted')),
    mk(0, 2, 13, 30, 45, 'Kitchen walkthrough, the new restaurant', { location: 'Lower Parel', ...withThem(0, 'Manasi', 'manasi@thirdcourse.example') }),
    mk(0, 2, 15, 0, 30, 'Vendor intro', invite('declined')),
    mk(0, 2, 16, 0, 30, 'YC office hours'),
    mk(1, 2, 18, 30, 50, 'Therapy (do not move this one)'),
    mk(0, 3, 0, 0, 1440, 'Team offsite', { allDay: true }),
    mk(0, 3, 11, 0, 30, 'Life sciences lab: results call', withThem(0, 'Aarya', 'aarya@helixbio.example')),
    mk(0, 3, 13, 30, 45, 'Interview: backend engineer', withThem(0, 'Kabir Rao', 'kabir.rao@hey.example')),
    mk(1, 3, 18, 30, 60, 'Dance class', { location: 'Studio 9', ...withThem(1, 'Shruti', 'shruti@studio9.example') }),
    mk(0, 4, 10, 0, 30, 'Weekly wrap-up'),
    mk(0, 4, 12, 0, 30, 'Field notes from Gujarat (research call)', withThem(0, 'Bhakti', 'bhakti@fieldnotes.example')),
    mk(0, 4, 14, 30, 45, 'EV battery lab, Kanpur: research sync', withThem(0, 'Jigyasa', 'jigyasa@evlab.example')),
    mk(1, 4, 16, 0, 30, 'Markets close: the week in equities', withThem(1, 'Tanish', 'tanish@openinterest.example')),
    mk(1, 4, 19, 0, 150, 'Harry Potter rewatch: Prisoner of Azkaban'),
    mk(1, 5, 9, 0, 90, 'Football'),
    mk(1, 5, 11, 30, 45, 'Vet: the cat’s check-up'),
    mk(1, 5, 17, 0, 30, 'Coffee, strictly to return the hoodie'),
    mk(1, 5, 20, 0, 120, 'Bar night: the new old fashioned', { location: 'He is behind the bar', ...withThem(1, 'Naman', 'naman@lastcall.example') }),
    mk(1, 6, 8, 30, 45, 'Temple with Mum. Say thank you properly.'),
    mk(1, 6, 11, 0, 60, 'Call the banker: how did the date go?', withThem(1, 'Divyaansh', 'divyaansh@northbank.example')),
    mk(1, 6, 16, 0, 45, 'Call Paris: wedding plans (bring your French)', withThem(1, 'Padmaja', 'padmaja@rivegauche.example')),
    mk(1, 6, 18, 0, 60, 'Meal prep: 160 g of protein a day, no excuses'),
    ...once(1, 2026, 11, 19, 0, 0, 1440, 'GTA VI is out. Do not disturb.', { allDay: true }),
    ...once(1, 2026, 12, 17, 18, 0, 180, 'Doomsday: first day, first show'),
  ];
}
const DEMO_SEED = 6; // raise this when the sample tasks and notes change, so everyone sees the new ones
function seedDemo() {
  state.accounts = structuredClone(DEMO_ACCOUNTS);
  if (state.demoSeed === DEMO_SEED) return;
  const today = startOfDay(new Date()), d = n => ymd(addDays(today, n)), ws = startOfWeek(today), wk = ymd(ws);
  state.tasks = [
    newTask({ title: 'Write proposal for Acme', date: d(0), start: 9 * 60, duration: 90, tag: 'work', priority: 'high' }),
    newTask({ title: 'Reply to investor email', date: d(0), start: 12 * 60, duration: 30, tag: 'work' }),
    newTask({ title: 'Gym', date: d(0), start: 17 * 60, duration: 60, tag: 'health' }),
    newTask({ title: 'Pay electricity bill', date: d(0), tag: 'personal' }),
    newTask({ title: 'Prepare demo script', date: d(1), start: 15 * 60, duration: 60, tag: 'work' }),
    newTask({ title: 'Send invoice to client', date: d(-1), start: 16 * 60, duration: 30, tag: 'work' }),
    newTask({ title: 'Book flights for Goa', duration: 30, tag: 'personal' }),
    newTask({ title: 'Order whey before the tub runs out', duration: 15, tag: 'health' }),
    newTask({ title: 'Read contract draft', duration: 45, tag: 'work' }),
  ];
  const at = (day, h, m = 0) => { const t = addDays(ws, day); t.setHours(h, m); return t.getTime(); };
  const note = (key, title, when, people, text) => { state.notes[key] = { title, when, people, text, t: when }; };
  state.notes = {};
  note(`d${wk}-0-14-0`, 'Client call: Acme', at(0, 14), ['ravi.menon@acme.com', 'lena@acme.com'], `Summary
Acme wants the pilot live before their board meets on the 30th. Ravi is happy with the price. Lena still needs the security answers before she signs off.

Next: Send the pilot plan by Wednesday.

Decisions
- The pilot starts with the Mumbai team, 12 seats
- Price stays at 40 a seat for the first year

Action points
- [ ] Send the pilot plan and timeline
- [x] Share the security one-pager
- [ ] Book the kickoff for next Tuesday

Waiting on others
- Ravi: confirm who signs
- Lena: the list of questions from their IT team

Open questions
- Do they need single sign-on in the pilot?

Written by AI from what was said in the recording of ${dayLabel(new Date(at(0, 14)))}.`);
  note(`d${wk}-0-10-0`, 'Weekly team sync', at(0, 10), ['priya@example.com'], `- Launch moves to the 17th, press told on Friday
- [ ] Rewrite the pricing page before the demo
- [x] Post the contractor brief
- Offsite on Thursday: bring walking shoes`);
  note('note:demo-yc', 'YC application, rough answers', at(-3, 21), [], `# What are you making?
One calm place for the working day: calendar, recorder and notes that write themselves.

# Why now?
- Everyone records meetings, nobody reads the transcript
- [ ] Cut this answer to two sentences
- [ ] Ask someone outside the team to read it cold`);
  note('note:demo-shelf', 'Weekend list', at(-1, 18), [], `- Prisoner of Azkaban, again
- The cat goes to the vet on Saturday
- [ ] Book the 17 December show before it sells out
- [ ] Learn three sentences of French before the wedding`);
  state.demoSeed = DEMO_SEED;
  save();
}

// ---------------------------------------------------------------- start
// Opened by the page at the old address to take over what this browser saved there (movein.js).
// Runs before anything is saved here, and ends by loading the app afresh.
async function moveIn() {
  const panel = document.createElement('div');
  panel.className = 'movein';
  panel.innerHTML = '<div><img src="icon.svg" width="48" height="48" alt=""><h2>Bringing your things over</h2><p role="status">One moment.</p><p hidden><a class="btn primary" href="./">Open Weftday</a></p></div>';
  document.body.append(panel);
  const line = panel.querySelector('[role=status]'), say = text => { line.textContent = text; };
  const stop = title => { panel.querySelector('h2').textContent = title; panel.querySelector('p[hidden]').hidden = false; };
  history.replaceState(null, '', location.pathname);
  const take = () => Move.receive({ say, put: R.takeIn, tidy: R.dropOrphans,
    ask: () => confirm('Weftday at this address already has things saved in this browser.\n\nReplace them with the ones from the old address? The copy there may be older: anything added or changed here since would be lost.') });
  // (the lock tells other open copies of the app that a move is under way, so they leave its half-arrived recordings alone)
  const result = await (navigator.locks ? navigator.locks.request('weftday-movein', take) : take());
  if (result === 'all') location.replace(location.pathname); // start again, now with everything in place
  else stop(result === 'some' ? 'Almost everything is here' : 'Nothing was moved');
}

async function boot() {
  applyTheme();
  if (!DEMO && Move.wanted()) return moveIn();
  applySide();
  bind();
  bindSideGrip();
  const gotKeys = importSetup();
  if (DEMO) seedDemo();
  else {
    const cached = loadEventCache();
    if (cached?.week === ymd(startOfWeek(new Date()))) for (const ev of cached.events) events.set(ev.key, ev);
  }
  // Finished tasks always belong to a day, so the inbox only ever holds things still to do.
  for (const t of state.tasks) if (t.done && !t.date) { t.date = ymd(new Date(t.created || Date.now())); touch(t); }
  for (const t of state.tasks) if (!t.gEventId) t.dirty = true; // anything not yet in "Weftday" (such as older inbox tasks) gets sent
  topUpSeries();
  save();
  render();
  setTimeout(maybeTour, 900);
  R.recover().then(n => { if (n) toast(n === 1 ? 'A recording that was cut off has been kept.' : `${n} recordings that were cut off have been kept.`, { go: ['Show', () => openRecordings(null)] }); }).catch(() => {});
  if (homeFromLink) await adoptHome(homeFromLink);
  else if (gotKeys) toast('Keys added. Now press “+ Connect Google account”.');
  if (lockedSetup) openSetupCode();
  try {
    const a = await G.finishConnect();
    if (a) await onConnected(a);
    const after = G.takeAfter(); // back from Google after being asked about Drive: carry on with the link
    if (a && after?.share) openRecording(after.share).then(() => shareRecording(after.share));
  } catch (err) { toast(err.message, true); }
  if (!DEMO) {
    let cut = false; // Google cannot be reached at all from here right now
    await Promise.all(state.accounts.filter(a => !a.needsReconnect).map(a => G.refreshCalendars(a).catch(err => { cut ||= err.kind === 'unreachable'; console.warn(a.email, err); })));
    renderSide();
    if (cut) { // say so at once instead of waiting on every calendar in turn; try again in a minute
      syncProblems = [{ a: {}, c: {}, err: { kind: 'unreachable' } }];
      tellProblem('Can’t reach Google Calendar · Why?');
      setTimeout(refresh, 60000);
    } else {
      scheduleFlush();
      await shareSync();
    }
  }
  if (!syncProblems.length) await refresh();
  tick();
  setInterval(tick, 30000);
  const catchUp = () => { checkForUpdate(); return shareSync().then(refresh); };
  checkForUpdate();
  setInterval(() => { if (!document.hidden) catchUp(); }, 5 * 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); catchUp(); } });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
