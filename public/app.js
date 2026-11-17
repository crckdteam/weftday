import { state, save, DEMO, loadEventCache, saveEventCache } from './store.js';
import * as G from './google.js';
import * as V from './vault.js';
import * as N from './notes.js';
import * as AI from './ai.js';
import * as F from './facts.js';
import * as S from './services.js';
import { qrSvg } from './qr.js';
import { PUBLIC_URL } from './config.js';
import {
  ymd, fromYmd, addDays, startOfDay, startOfWeek, localIso, hhmm, parseHhmm, clamp,
  fmtTime, fmtRange, fmtDur, dayLabel, uid, esc, parseQuick, days, monthStart,
} from './util.js';

const HOUR = 52, PXM = HOUR / 60, SNAP = 15;
const INBOX_DATE = '2000-01-01'; // inbox tasks are parked on this day in the "Weftday" calendar
const VIEWS = ['day', 'week', 'month', 'list'];
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = {
  side: $('#sideBody'), head: $('#gridHead'), body: $('#gridBody'), grid: $('#grid'),
  month: $('#month'), list: $('#list'), hint: $('#quickHint'),
  title: $('#title'), status: $('#status'), dlg: $('#dlg'), toast: $('#toast'),
};

let view = VIEWS.includes(state.settings.view) ? state.settings.view : (innerWidth < 760 ? 'day' : 'week');
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
function saveOpenNote() { aiJob?.abort(); aiJob = null; const f = noteCommit; noteCommit = null; if (f) f(); }
function dialog(html, handlers = {}, cls = '') {
  saveOpenNote();
  clearTimeout(closeTimer); // a box that was fading out is taken over by the new one
  document.body.append(el.toast);
  el.dlg.className = cls;
  el.dlg.innerHTML = html;
  dlgOpenedAt = Date.now();
  if (!el.dlg.open) el.dlg.showModal();
  el.dlg.onclick = e => {
    if (e.target === el.dlg) { if (Date.now() - dlgOpenedAt > 250) closeDialog(); return; }
    const x = e.target.closest('[data-x]');
    if (!x) return;
    if (x.dataset.x === 'close') return closeDialog();
    handlers[x.dataset.x]?.(x, e);
  };
  const f = $('form', el.dlg);
  if (f) f.onsubmit = e => { e.preventDefault(); handlers.submit?.(new FormData(f), f); };
}
// Boxes fade out briefly instead of vanishing.
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
    if (t.repeat === 'daily' || (t.repeat === 'weekdays' && g >= 1 && g <= 5) || (t.repeat === 'weekly' && g === wd)) out.push(ymd(d));
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
  for (const t of last.values()) {
    if (!t.repeat || t.repeat === 'none') continue;
    for (const ds of seriesDates(t, t.date, horizon)) {
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
      else b.timed.push({ kind: 'ev', ev, s: Math.max(0, Math.round((ev.s - t0) / 60000)), e: Math.min(1440, Math.round((ev.e - t0) / 60000)) });
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
const busyOf = d => dayItems(d).timed
  .filter(i => !(i.kind === 'task' && i.t.done) && !(i.kind === 'ev' && i.ev.selfStatus === 'declined'))
  .map(i => [i.s, i.e]).sort((a, b) => a[0] - b[0]);
const nowMinutes = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };

// First gap that fits. "strict" keeps inside working hours and returns null when the day is full.
function nextFreeSlot(d, duration, strict) {
  const { dayStart, dayEnd } = state.settings;
  const isToday = ymd(d) === todayYmd();
  const first = isToday ? Math.max(Math.ceil((nowMinutes() + 1) / SNAP) * SNAP, dayStart) : dayStart;
  const limit = strict ? dayEnd : 1440;
  let s = first;
  for (const [bs, be] of busyOf(d)) {
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
  const p = v.trim() ? parseQuick(v) : null;
  if (!p || !p.title) { el.hint.hidden = true; return; }
  const bits = [p.date ? relDay(p.date) : 'Inbox'];
  if (p.start != null) bits.push(fmtTime(p.start));
  if (p.duration) bits.push(fmtDur(p.duration));
  if (p.repeat) bits.push({ daily: 'every day', weekdays: 'Mon – Fri', weekly: 'every week' }[p.repeat]);
  if (p.tag) bits.push('#' + p.tag);
  if (p.priority === 'high') bits.push('high priority');
  el.hint.textContent = '↵  ' + bits.join(' · ');
  el.hint.hidden = false;
}

function quickAdd() {
  const input = $('#quickInput');
  const p = parseQuick(input.value);
  if (!p.title) return;
  mark();
  const t = newTask({ title: p.title, date: p.date, start: p.start, duration: p.duration || 30, tag: p.tag, priority: p.priority });
  if (p.repeat) { t.repeat = p.repeat; t.seriesId = uid(); }
  state.tasks.push(t);
  topUpSeries();
  input.value = '';
  quickHint();
  commit();
  flash(t.id, 'born');
  if (!t.date) toast('Added to your inbox', { undo: true });
  else toast(`Scheduled ${relDay(t.date)}${t.start != null ? ', ' + fmtTime(t.start) : ''}`, { undo: true });
}

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
  if (view === 'day') el.title.textContent = dayLabel(cursor, true);
  else if (view === 'month') el.title.textContent = cursor.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  else {
    const a = dates[0], b = dates[dates.length - 1];
    const month = d => d.toLocaleDateString('en-GB', { month: 'short' });
    el.title.textContent = a.getMonth() === b.getMonth()
      ? `${a.getDate()} – ${b.getDate()} ${month(b)} ${b.getFullYear()}`
      : `${a.getDate()} ${month(a)} – ${b.getDate()} ${month(b)} ${b.getFullYear()}`;
  }
  for (const b of document.querySelectorAll('#viewSeg button')) b.classList.toggle('on', b.dataset.view === view);
  $('#demoTag').hidden = !DEMO;
}

function renderView() {
  const timeGrid = view === 'day' || view === 'week';
  el.grid.hidden = !timeGrid;
  el.month.hidden = view !== 'month';
  el.list.hidden = view !== 'list';
  if (timeGrid) renderGrid(); else if (view === 'month') renderMonth(); else renderList();
}

function itemHtml(t, meta) {
  return `<div class="item" data-id="${t.id}" style="${tagStyle(t)}">
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
  </div>`;
}

function upNextHtml() {
  const nowM = nowMinutes();
  const items = dayItems(startOfDay(new Date())).timed
    .filter(i => i.kind === 'task' ? !i.t.done : i.ev.selfStatus !== 'declined').sort((a, b) => a.s - b.s);
  const row = (label, i, when) => {
    const attr = i.kind === 'task' ? `class="un task" data-id="${i.t.id}"` : `class="un" data-key="${esc(i.ev.key)}"`;
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
  return `<div class="sec"><h4><span>${m.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</span>
    <span class="mnav"><button class="mini" data-act="mini-prev" aria-label="Previous month">‹</button><button class="mini" data-act="mini-next" aria-label="Next month">›</button></span></h4>
    <div class="mc">${cells}</div></div>`;
}

function renderSide() {
  const today = todayYmd();
  const carried = state.tasks.filter(t => t.date && t.date < today && !t.done).sort((a, b) => a.date.localeCompare(b.date));
  const inbox = state.tasks.filter(t => !t.date && !t.done).sort((a, b) => (b.priority === 'high') - (a.priority === 'high') || b.created - a.created);
  const tagOf = t => t.tag ? ` · #${esc(t.tag)}` : '';
  let h = todayCardHtml() + `<div class="tools"><button data-act="today">Today</button><button data-act="people">People</button><button data-act="free">Free times</button></div>`
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
    h += `<div class="acct" data-acct="${esc(a.id)}"><button class="dot" data-act="acct-color" title="Change colour" style="background:${a.color}"></button><span class="em" title="${esc(a.email)}">${esc(a.email)}</span>${
      a.needsReconnect ? '<button class="mini warn" data-act="reconnect">Reconnect</button>' : '<button class="mini" data-act="rm-acct">Remove</button>'}</div>`;
    for (const c of a.calendars) {
      if (isPlannerCal(a, c)) continue;
      h += `<label class="cal"><input type="checkbox" style="accent-color:${a.color}" data-cal="${esc(a.id)}|${esc(c.id)}"${c.enabled ? ' checked' : ''}><span>${esc(c.summary)}</span></label>`;
    }
  }
  h += '</div>';
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
    for (const it of cluster) it.cols = ends.length;
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
const evColor = ev => acct(ev.accountId)?.color || '#888';

function blockHtml(it) {
  const h = Math.max((it.e - it.s) * PXM, 20);
  const style = `top:${it.s * PXM}px;height:${h - 1}px;left:calc(${it.col / it.cols * 100}% + 1px);width:calc(${100 / it.cols}% - 3px);`;
  const sm = h < 34 ? ' sm' : '';
  if (it.kind === 'task') {
    const t = it.t;
    return `<div class="blk task${t.done ? ' done' : ''}${sm}" data-id="${t.id}" style="${style}${tagStyle(t)}">
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
    return `<div class="chip task${it.t.done ? ' done' : ''}" data-id="${it.t.id}"><button class="chk" data-act="toggle" aria-label="Mark done"></button><span>${tm}${esc(it.t.title)}</span></div>`;
  }
  return `<div class="chip ev${it.ev.selfStatus === 'declined' ? ' declined' : ''}" data-key="${esc(it.ev.key)}" style="--c:${evColor(it.ev)}"><span>${tm}${esc(it.ev.title)}</span></div>`;
}

function renderGrid() {
  const dates = visibleDates(), today = todayYmd(), by = collect(dates);
  el.grid.style.setProperty('--n', dates.length);
  el.grid.style.setProperty('--ws', `${state.settings.dayStart * PXM}px`);
  el.grid.style.setProperty('--we', `${state.settings.dayEnd * PXM}px`);
  let head = '<div></div>';
  let body = `<div class="gutter">${Array.from({ length: 23 }, (_, i) => `<span style="top:${(i + 1) * HOUR}px">${fmtTime((i + 1) * 60)}</span>`).join('')}</div>`;
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
    return `<div class="lrow task${t.done ? ' done' : ''}" data-id="${t.id}"><span class="ltime">${when}</span>
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
function setView(v) { view = v; state.settings.view = v; save(); nav(); }
function nav(dir = 'fade') { smooth(dir, render).then(() => refresh()); }
function step(n) {
  cursor = view === 'month' ? new Date(cursor.getFullYear(), cursor.getMonth() + n, 1) : addDays(cursor, n * (view === 'day' ? 1 : 7));
  miniMonth = null;
  nav(n > 0 ? 'next' : 'prev');
}
function goTo(d, v) {
  const before = range()[0].getTime();
  cursor = startOfDay(d);
  miniMonth = null;
  if (v && v !== view) return setView(v);
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
  const taskEl = e.target.closest('.blk.task, .item, .chip.task, .lrow.task, .un.task');
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
  if (act === 'today') return openToday();
  if (act === 'people') return openPeople();
  if (act === 'free') return openFreeTimes();
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
  function up() {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
    if (!box) return;
    box.remove();
    dragging = false;
    suppressClick = Date.now() + 350;
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
      if (over) { over.classList.add('dropover'); target = { date: over.dataset.date, start: null }; }
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
  function up() {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
    if (!ghost) return;
    ghost.remove(); drop?.remove(); over?.classList.remove('dropover');
    dragging = false;
    suppressClick = Date.now() + 350;
    if (!target) return;
    mark();
    t.date = target.date; t.start = target.start; touch(t); commit();
    toast(`Scheduled ${relDay(t.date)}${t.start != null ? ', ' + fmtTime(t.start) : ''}`, { undo: true });
  }
  addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  e.preventDefault();
}

function onKey(e) {
  const mod = e.metaKey || e.ctrlKey, key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && key === 'k') { e.preventDefault(); return openPalette(); }
  if (el.dlg.open || e.target.closest?.('input, textarea, select')) return;
  if (mod && key === 'z') { e.preventDefault(); return undo(); }
  if (mod || e.altKey) return;
  const run = {
    t: goToday, d: () => setView('day'), w: () => setView('week'), m: () => setView('month'), l: () => setView('list'),
    ArrowLeft: () => step(-1), ArrowRight: () => step(1), k: () => step(-1), j: () => step(1),
    n: () => innerWidth < 760 ? newTaskHere() : $('#quickInput').focus(),
    e: () => openEventForm(null), p: () => openPlan(), '/': openPalette, '?': openHelp,
  }[key];
  if (run) { e.preventDefault(); run(); }
}

function newTaskHere() {
  openTask(newTask({ date: view === 'day' ? ymd(cursor) : todayYmd() }), true);
}

function bind() {
  const input = $('#quickInput');
  $('#quick').addEventListener('submit', e => { e.preventDefault(); quickAdd(); });
  input.addEventListener('input', quickHint);
  input.addEventListener('keydown', e => { if (e.key === 'Escape') { input.value = ''; quickHint(); input.blur(); } });
  $('#todayBtn').onclick = goToday;
  $('#prev').onclick = () => step(-1);
  $('#next').onclick = () => step(1);
  $('#viewSeg').onclick = e => { if (e.target.dataset.view) setView(e.target.dataset.view); };
  $('#newEvent').onclick = () => openEventForm(null);
  $('#searchBtn').onclick = e => { e.stopPropagation(); openPalette(); };
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
  el.dlg.addEventListener('close', () => { saveOpenNote(); returnTo = null; document.body.append(el.toast); });
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
  dialog(`<form class="dbody">
    <h3>${isNew ? 'New task' : 'Task'}</h3>
    <label>What needs doing?<input name="title" required value="${esc(t.title)}" autocomplete="off"></label>
    <div class="row">
      <label>Day<input type="date" name="date" value="${t.date || ''}"></label>
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
    <div class="row">
      <label>Repeat<select name="repeat">${opts([['none', 'Never'], ['daily', 'Every day'], ['weekdays', 'Mon – Fri'], ['weekly', 'Every week']], t.repeat)}</select></label>
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
    when(btn) {
      const f = $('form', el.dlg).elements, v = btn.dataset.v, today = startOfDay(new Date());
      if (v === 'inbox') { f.date.value = ''; f.start.value = ''; return; }
      if (v === 'free') {
        const d = f.date.value ? fromYmd(f.date.value) : today;
        f.date.value = ymd(d);
        f.start.value = hhmm(nextFreeSlot(d, +f.duration.value));
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
  const pick = (t, on, meta) => `<label class="prow"><input type="checkbox" name="pick" value="${t.id}"${on ? ' checked' : ''}>
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
}

// ---------------------------------------------------------------- search and commands
function openPalette() {
  dialog(`<div class="pal"><input id="palIn" placeholder="Search tasks and events, or type a date or command…" autocomplete="off" spellcheck="false">
    <div id="palList"></div><div class="palfoot">↑ ↓ to move · Enter to open · Esc to close</div></div>`, {}, 'palette');
  const input = $('#palIn', el.dlg), list = $('#palList', el.dlg);
  const cmds = [
    ['Go to today', goToday], ['Today: prepare for my meetings', openToday], ['People and companies', () => openPeople()], ['Share my free times', openFreeTimes], ['Plan my day', openPlan], ['New task', newTaskHere], ['New event', () => openEventForm(null)],
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
  const keys = [['T', 'Go to today'], ['D   W   M   L', 'Day, week, month or list view'], ['←   →', 'Previous or next'], ['N', 'New task'],
    ['E', 'New event'], ['P', 'Plan my day'], ['/   or   ⌘K', 'Search everything'], ['⌘Z', 'Undo the last change'], ['?', 'Show this list']];
  const ex = ['gym tomorrow 7am 1h #health', 'pay rent 1 dec !', 'standup every weekday 9:30am 15m', 'call mum fri 6pm', 'read contract (goes to your inbox)'];
  dialog(`<div class="dbody"><h3>Shortcuts</h3>
    <div class="keys">${keys.map(([k, v]) => `<div><kbd>${k}</kbd><span>${v}</span></div>`).join('')}</div>
    <h4>Things you can type in “Add a task”</h4>
    <div class="keys ex">${ex.map(x => `<div><kbd>${esc(x)}</kbd></div>`).join('')}</div>
    <p class="note">On the calendar: click an empty time to add a task, drag across empty space to draw one, drag a task to move it, and drag its bottom edge to make it longer.</p>
    <div class="actions"><span class="sp"></span><button class="btn primary" data-x="close">Close</button></div></div>`);
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
  return ymd(s) === ymd(e) ? `${dayLabel(s, true)} · ${fmtRange(sm, em)}` : `${dayLabel(s)} ${fmtTime(sm)} – ${dayLabel(e)} ${fmtTime(em)}`;
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
        const j = await G.api(a, `/calendars/${G.enc(cal.id)}/events`, { params });
        for (const e of j.items || []) {
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

// Shown when "Get facts" is pressed before an AI key has been added.
function openFactsHelp(guest, from) {
  dialog(`<div class="dbody"><h3>Get facts needs a free key</h3>
    <p>To look people up on the web, Weftday uses Google’s AI with a key that belongs to you. The key is free.</p>
    <ol class="steps">
      <li>Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a> and press <b>Create API key</b>.</li>
      <li>Copy the key and paste it into <b>Settings → AI</b>.</li>
    </ol>
    <p class="note">Each time facts are fetched, the person’s name, their company and the meeting title go to that AI. Nothing is sent before that.</p>
    <p class="note">Settings → AI also has a free search key for richer results, and other AI services to choose from (OpenAI, Claude, Ollama and more), each marked free or paid.</p>
    <div class="actions"><button type="button" class="btn ghost" data-x="back">Back</button><span class="sp"></span><button type="button" class="btn primary" data-x="settings">Open Settings</button></div></div>`, {
    back: () => openPerson(guest, from),
    settings: () => openSettings(),
  });
}

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
  ? `<img class="logo" alt="" loading="lazy" src="https://www.google.com/s2/favicons?domain=${G.enc(domain)}&sz=128">` : '');
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
      const job = aiJob = new AbortController();
      card.innerHTML = FACTS_LOADING;
      try {
        const answer = await getFacts(p, from?.title, job.signal, hint);
        if (job.signal.aborted || !card.isConnected) return;
        ({ raw, day } = F.split(F.mergeInto('', answer, dayLabel(new Date()))));
        if (!commitAbout(true)) { N.set(key, F.join(box.value, raw, day), { title: p.name, when: Date.now(), people: [p.email] }); scheduleFlush(); }
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

  showPictures();
  // Your own words save by themselves; the facts found on the web ride along in the same note.
  const box = $('[name=about]', el.dlg), saved = $('#aboutState', el.dlg);
  let timer = 0;
  const commitAbout = quiet => {
    clearTimeout(timer);
    if (!N.set(key, F.join(box.value.trim() ? box.value : '', raw, day).slice(0, N.MAX_LENGTH), { title: p.name, when: Date.now(), people: [p.email] })) return false;
    scheduleFlush();
    if (quiet !== true && saved.isConnected) saved.textContent = plannerReady() ? 'Saved' : 'Saved on this device';
    return true;
  };
  $('#hintRow', el.dlg)?.addEventListener('submit', e => { e.preventDefault(); $('[data-x=retry]', el.dlg).click(); });
  box.addEventListener('input', () => { saved.textContent = ''; clearTimeout(timer); timer = setTimeout(commitAbout, 600); });
  box.addEventListener('change', commitAbout);
  noteCommit = commitAbout;

  meetingsWith(p.email).then(list => {
    const box2 = $('#metList', el.dlg);
    if (!box2) return;
    const now = Date.now(), past = list.filter(m => m.s < now).reverse(), next = list.filter(m => m.s >= now);
    const row = m => `<div><i>${esc(dayLabel(new Date(m.s)))}</i> ${esc(m.title || '')}${N.has(m.nk) ? ' ✎' : ''}</div>`;
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
      const job = aiJob = new AbortController();
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
  const who = (p, lookup) => `<div class="who" data-email="${esc(p.email)}">
      <div><button type="button" class="nm" data-x="person" data-email="${esc(p.email)}" title="Everything about this person">${esc(p.name)} ›</button>${p.organizer ? ' <i>· organiser</i>' : ''}${STATUS_LABEL[p.status] ? ` <i>· ${STATUS_LABEL[p.status]}</i>` : ''}</div>
      ${aboutLine(p.email) ? `<div class="abt">${esc(aboutLine(p.email))}</div>` : ''}
      <div class="wm">${lookup ? '<span class="met">Checking your past meetings…</span>' : ''}<span class="look">${lookupLinks(p, ev.title)}</span></div>
      ${lookupLinks(p, ev.title) ? `<div><button type="button" class="mini" data-x="facts" data-email="${esc(p.email)}">${hasFacts(p.email) ? 'See profile' : 'Get facts'}</button></div>` : ''}</div>`;
  dialog(`<div class="dbody">
    <h3>${esc(ev.title)}</h3>
    <div class="meta">${esc(eventWhen(ev))}</div>
    <div class="meta"><span class="dot" style="background:${a?.color || '#888'}"></span>${esc(a?.email || '')}${c && !c.primary ? ' · ' + esc(c.summary) : ''}</div>
    ${ev.location ? `<div class="meta">${esc(ev.location)}</div>` : ''}
    ${ev.meet || extras.length || others.length ? `<div class="btnrow">
      ${ev.meet ? `<a class="btn primary" href="${esc(ev.meet)}" target="_blank" rel="noopener">Join video call</a>` : ''}
      ${others.length ? '<button type="button" class="btn" data-x="brief">Brief me</button>' : ''}
      ${extras.map(x => `<a class="btn" href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)}</a>`).join('')}</div>` : ''}
    ${others.length ? `<h4>Who’s there</h4><div class="whos">${shown.map(p => who(p, true)).join('')}
      ${rest.length ? `<details><summary>${rest.length} more</summary><div class="whos">${rest.map(p => who(p, false)).join('')}</div></details>` : ''}</div>` : ''}
    ${last ? `<h4>Last time${lastDay ? ` · ${esc(lastDay)}` : ''}</h4>
    <div class="last"><div class="lt2">${esc(last.title || 'Meeting')}</div>
      <div class="desc">${esc(lastGist)}</div>
      ${lastActions.length ? `<div class="todo">${lastActions.map(x => `<div class="${x.done ? 'done' : ''}">${x.done ? '✓' : '•'} ${esc(x.text)}</div>`).join('')}</div>` : ''}
      <div><button type="button" class="mini" data-x="uselast">Add to my notes</button></div></div>` : ''}
    <label><span>Your notes <i>· only you can see these</i></span>
      <textarea name="note" rows="4" maxlength="${N.MAX_LENGTH}" placeholder="What do you want to cover? What was decided?">${esc(note?.text || '')}</textarea></label>
    <div class="airow">
      ${AI.supported() ? '<button type="button" class="mini" data-x="tidy">Tidy my notes</button>' : ''}
      <button type="button" class="mini" data-x="mktasks" hidden>Make tasks</button>
      <button type="button" class="mini" data-x="untidy" hidden>Undo tidy</button>
      <button type="button" class="mini" data-x="followup" hidden>Follow-up email</button>
      ${AI.supported() ? '' : '<span class="note">Tidying notes with AI works in Chrome on your computer.</span>'}
      <span class="sp"></span><span class="saved" id="noteState"></span></div>
    ${earlier.length ? `<details><summary>All earlier notes with ${others.length === 1 ? esc(others[0].name) : 'these people'} (${earlier.length})</summary>
      <div class="past">${earlier.map(n => `<div><b>${esc(n.title || 'Meeting')}</b>${n.when ? ` <i>· ${esc(dayLabel(new Date(n.when)))}</i>` : ''}<div class="desc">${esc(n.text)}</div></div>`).join('')}</div></details>` : ''}
    ${ev.description ? `<div class="desc">${esc(ev.description)}</div>` : ''}
    ${ev.selfStatus ? `<div class="rowline"><span class="note">Are you going? <b>${STATUS_LABEL[ev.selfStatus] || ''}</b></span><span>
      <button class="btn" data-x="rsvp" data-s="accepted">Yes</button>
      <button class="btn" data-x="rsvp" data-s="tentative">Maybe</button>
      <button class="btn" data-x="rsvp" data-s="declined">No</button></span></div>` : ''}
    <div class="actions">
      ${ev.calWritable ? '<button class="btn danger" data-x="del">Delete</button>' : ''}
      ${ev.canEdit && !ev.allDay ? '<button class="btn" data-x="edit">Edit</button>' : ''}
      <span class="sp"></span>
      ${ev.htmlLink ? `<a class="btn ghost" href="${esc(ev.htmlLink)}" target="_blank" rel="noopener">Open in Google</a>` : ''}
      <button class="btn${ev.meet ? '' : ' primary'}" data-x="close">Close</button>
    </div></div>`, {
    edit: () => openEventForm(ev),
    person: btn => openPerson(guests.find(g => (g.email || '').toLowerCase() === btn.dataset.email), ev),
    brief: () => openBrief(ev),
    // Opens a draft in Gmail, written from your notes. Nothing is sent: you read it and press Send yourself.
    followup() {
      const text = $('[name=note]', el.dlg).value, to = outsiders(ev).map(x => x.who);
      const summary = /^Summary\n/.test(text.trim()) ? AI.gistOf(text, 600) : '', agreed = AI.decisionsIn(text), next = AI.actionsIn(text);
      const sameDay = startOfDay(new Date(ev.s)).getTime() === startOfDay(new Date()).getTime();
      const lines = [`Hi ${to.slice(0, 3).map(w => w.name.split(' ')[0]).join(', ') || 'there'},`, '', `Thank you for your time ${sameDay ? 'today' : `on ${dayLabel(new Date(ev.s))}`}. A short recap of our conversation:`, ''];
      if (summary) lines.push(summary, '');
      if (agreed.length) lines.push('What we agreed:', ...agreed.map(x => `- ${x}`), '');
      if (next.length) lines.push('Next steps:', ...next.map(x => `- ${x}`), '');
      if (!summary && !agreed.length && !next.length) lines.push(AI.originalOf(text).trim().slice(0, 1200), '');
      lines.push('Best regards,');
      window.open(`https://mail.google.com/mail/?authuser=${G.enc(a?.email || '')}&view=cm&fs=1&to=${G.enc(to.map(w => w.email).join(','))}`
        + `&su=${G.enc(`Follow-up: ${ev.title}`)}&body=${G.enc(lines.join('\n').slice(0, 1800))}`, '_blank', 'noopener');
      toast('A draft opened in Gmail. Read it before you send.');
    },
    // Looks the person up on the web, saves what it finds about them, then shows their page.
    async facts(btn) {
      const guest = guests.find(g => (g.email || '').toLowerCase() === btn.dataset.email), who = person(guest);
      if (hasFacts(who.email)) return openPerson(guest, ev);
      if (!factsKey()) return openFactsHelp(guest, ev);
      const job = aiJob = new AbortController();
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
      const job = aiJob = new AbortController(), label = btn.textContent;
      btn.disabled = box.readOnly = true;
      btn.textContent = 'Tidying…';
      saved.textContent = 'This can take a minute or two. It runs on your computer.';
      try {
        const result = await AI.tidy({ title: ev.title, people: others.map(p => p.name).join(', '), text: rough },
          { signal: job.signal, onProgress: part => { if (part < 1) saved.textContent = `Getting the AI ready… ${Math.round(part * 100)}%`; } });
        if (job.signal.aborted || !box.isConnected) return;
        beforeTidy = box.value;
        box.value = AI.layout(result, rough);
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
      const have = new Set(state.tasks.filter(t => !t.done).map(t => t.title.toLowerCase()));
      const fresh = AI.actionsIn(box.value).filter(a => !have.has(a.toLowerCase()));
      if (!fresh.length) return toast('These action points are already in your tasks.');
      commitNote();
      mark();
      for (const title of fresh) state.tasks.push(newTask({ title: title.slice(0, 200), notes: `From: ${ev.title} (${dayLabel(new Date(ev.s))})` }));
      commit();
      toast(fresh.length === 1 ? 'Task added to your inbox' : `${fresh.length} tasks added to your inbox`, { undo: true });
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
  const box = $('[name=note]', el.dlg), saved = $('#noteState', el.dlg);
  let timer = 0, beforeTidy = null;
  const showTaskButton = () => {
    const n = AI.actionsIn(box.value).length, b = $('[data-x=mktasks]', el.dlg);
    b.hidden = !n;
    b.textContent = n === 1 ? 'Make 1 task' : `Make ${n} tasks`;
    $('[data-x=followup]', el.dlg).hidden = !box.value.trim() || ev.s > Date.now() || !outsiders(ev).length;
  };
  showTaskButton();
  const commitNote = () => {
    clearTimeout(timer);
    if (!N.set(key, box.value.trim() ? box.value : '', about)) return;
    scheduleFlush();
    if (saved.isConnected) saved.textContent = plannerReady() ? 'Saved' : 'Saved on this device';
    renderView(); // shows or hides the small note mark on the meeting
  };
  box.addEventListener('input', () => { saved.textContent = ''; showTaskButton(); clearTimeout(timer); timer = setTimeout(commitNote, 600); });
  box.addEventListener('change', commitNote);
  noteCommit = commitNote;
  if (writeNotes) { box.scrollIntoView({ block: 'center' }); box.focus(); }

  // Fill in the history with each of the first few people.
  for (const p of shown) {
    meetingsWith(p.email).then(list => {
      const row = el.dlg.querySelector(`.who[data-email="${CSS.escape(p.email)}"]`);
      if (!row) return;
      row.querySelector('.met').textContent = metLine(list, key);
      const better = person(guests.find(g => (g.email || '').toLowerCase() === p.email)); // a fuller name may have turned up
      if (better.name !== p.name) { row.querySelector('.nm').textContent = `${better.name} ›`; row.querySelector('.look').innerHTML = lookupLinks(better, ev.title); }
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
      if (parseHhmm(en) <= parseHhmm(st)) return toast('The end time must be after the start time.', true);
      const body = {
        summary: fd.get('title').trim(), location: fd.get('location').trim(),
        start: { dateTime: `${date}T${st}:00`, timeZone: TZ }, end: { dateTime: `${date}T${en}:00`, timeZone: TZ },
      };
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
const VIDEO_RE = /https:\/\/[^\s"'<>]*(?:zoom\.us\/j\/|teams\.microsoft\.com\/l\/meetup-join|teams\.microsoft\.com\/meet\/|teams\.live\.com\/meet\/|meet\.google\.com\/|webex\.com\/)[^\s"'<>]*/i;

function normalize(e, a, c) {
  learnNames(e);
  const allDay = !!e.start?.date;
  const self = (e.attendees || []).find(p => p.self);
  const calWritable = ['owner', 'writer'].includes(c.accessRole);
  const entry = (e.conferenceData?.entryPoints || []).find(p => p.entryPointType === 'video' && /^https:\/\//.test(p.uri || ''))?.uri;
  // Meetings Google makes from an email carry two stock paragraphs, in the language of that Google
  // account. They are left out, and the link to the email is offered as a button instead.
  let text = (e.description || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
  const mail = text.match(/https:\/\/mail\.google\.com\/mail\?extsrc=cal[^\s"'<>]*/)?.[0] || '';
  if (mail || e.eventType === 'fromGmail') text = text.split(/\n\s*\n/).filter(para => !/g\.co\/calendar|mail\.google\.com\/mail\?extsrc=cal/.test(para)).join('\n\n').trim();
  return {
    key: `${a.id}|${c.id}|${e.id}`, id: e.id, accountId: a.id, calendarId: c.id,
    title: e.summary || '(No title)',
    s: allDay ? fromYmd(e.start.date).getTime() : Date.parse(e.start.dateTime),
    e: allDay ? fromYmd(e.end.date).getTime() : Date.parse(e.end.dateTime),
    allDay, location: e.location || '', htmlLink: e.htmlLink || '',
    meet: e.hangoutLink || entry || `${e.location || ''} ${e.description || ''}`.match(VIDEO_RE)?.[0] || '',
    description: text.slice(0, 2000),
    att: e.attendees || [], selfStatus: self?.responseStatus || null,
    organizerSelf: !!e.organizer?.self, calWritable,
    canEdit: calWritable && (!!e.organizer?.self || !(e.attendees || []).length),
    nk: N.keyFor(e),
    files: (e.attachments || []).filter(f => /^https:\/\//.test(f.fileUrl || '')).slice(0, 6).map(f => ({ label: f.title || 'Attached file', url: f.fileUrl })),
    links: [...(mail ? [{ label: 'Open the email', url: `${mail}&authuser=${G.enc(a.email)}` }] : []), ...noteLinks(`${e.description || ''} ${e.location || ''}`)],
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
  return { ...answer, text: answer.text + await photoLines(await photos, savedFacts(who.email), hint) };
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
  if (answer.how !== 'search' && !freeLately) s.aiFreeSince = Date.now();
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
        if (!['slow', 'busy'].includes(err.kind)) { autoPausedUntil = Date.now() + 3600000; break; } // a problem with the key: stop for an hour
        tried[who.email] = Date.now() - 6 * 86400000; // the AI was busy: try this person again tomorrow
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

let refreshSeq = 0;
async function refresh() {
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
  let failed = 0;
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
    }).catch(err => { failed++; console.warn(a.email, c.summary, err); }));
  }
  await Promise.all(jobs);
  const ws = startOfWeek(today).getTime(), we = addDays(startOfWeek(today), 7).getTime();
  saveEventCache(ymd(startOfWeek(today)), [...events.values()].filter(ev => ev.e > ws && ev.s < we));
  if (plannerReady()) await sync(() => pullPlanner(from, to));
  if (plannerReady()) await sync(() => N.pull().catch(err => console.warn('Reading notes failed', err)));
  saveNames();
  setTimeout(autoFacts, 1500);
  if (seq !== refreshSeq) return;
  if (!dragging) render();
  const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (state.accounts.some(a => a.needsReconnect)) setStatus('An account needs reconnecting', true);
  else if (failed) setStatus('Some calendars could not be updated', true);
  else setStatus(`Updated ${time}`);
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
      tag: t.tag || '', repeat: t.repeat || 'none', seriesId: t.seriesId || '', duration: String(t.duration),
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
    t.repeat = p.repeat || 'none'; t.seriesId = p.seriesId || null;
  }
  t.gEventId = e.id; t.remoteUpdated = e.updated; t.dirty = false;
}

async function flush() {
  if (!plannerReady()) return;
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

function mergeRemote(e) {
  const p = e.extendedProperties?.private || {};
  let t = state.tasks.find(t => t.gEventId === e.id) || (p.taskId ? state.tasks.find(t => t.id === p.taskId && !t.gEventId) : null);
  if (t) {
    if (!t.dirty && e.updated !== t.remoteUpdated && (!t.remoteUpdated || e.updated > t.remoteUpdated)) applyEvent(t, e);
    else if (!t.gEventId) t.gEventId = e.id;
  } else if (!state.tombstones.includes(e.id)) {
    t = newTask({ id: p.taskId && !getTask(p.taskId) ? p.taskId : uid() });
    applyEvent(t, e);
    state.tasks.push(t);
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
      if (!t.date || spans.some(([f, u]) => t.date >= f && t.date < u)) state.tasks.splice(state.tasks.indexOf(t), 1); // deleted or moved elsewhere
    }
    save();
  } catch (err) { console.warn('Reading planner calendar failed', err); }
}

async function setPlanner(a) {
  const id = await G.ensurePlannerCalendar(a);
  const changed = state.settings.plannerCalendarId && state.settings.plannerCalendarId !== id;
  state.settings.plannerAccountId = a.id;
  state.settings.plannerCalendarId = id;
  if (changed) { state.tombstones = []; for (const t of state.tasks) { t.gEventId = null; t.remoteUpdated = null; } N.forgetRemote(); }
  for (const t of state.tasks) if (!t.gEventId) t.dirty = true;
  save();
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
function setupLink(mine) {
  const { clientId, clientSecret } = state.settings, d = { i: clientId, s: clientSecret };
  if (mine) { const h = plannerAccount(); d.e = h.id; d.r = h.refreshToken; } // your own device also gets your home account
  const data = btoa(JSON.stringify(d)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${isLocal ? PUBLIC_URL : G.redirectUri()}#setup=${data}`;
}
let homeFromLink = '';
function importSetup() {
  const m = location.hash.match(/^#setup=([\w-]+)$/);
  if (!m) return false;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const d = JSON.parse(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof d.i !== 'string' || typeof d.s !== 'string' || !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(d.i)) throw new Error('bad link');
    const s = state.settings;
    if (s.clientId && s.clientId !== d.i && !confirm('Replace the Google keys saved on this device with the ones from this link?')) return false;
    s.clientId = d.i; s.clientSecret = d.s;
    if (typeof d.e === 'string' && typeof d.r === 'string' && d.e && d.r) {
      let a = acct(d.e);
      if (!a) { a = { id: d.e, email: d.e, color: G.COLORS[state.accounts.length % G.COLORS.length], calendars: [] }; state.accounts.push(a); }
      Object.assign(a, { refreshToken: d.r, accessToken: null, expiresAt: 0, needsReconnect: false, t: a.t || Date.now() });
      homeFromLink = d.e;
    }
    save();
    return true;
  } catch { toast('That setup link is not valid.', true); return false; }
}
// A setup link from one of your own devices carries your home account. Use it to bring in the rest.
async function adoptHome(id) {
  setStatus('Bringing in your accounts…');
  try {
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
function openDeviceSetup(mine = true) {
  if (DEMO) return toast('This is sample data. Open the app without “?demo” first.');
  if (!state.settings.clientId) return openSettings('Add your Google keys first, then you can set up your phone.');
  const canMine = V.sharingReady();
  mine = mine && canMine;
  const link = setupLink(mine);
  let square = '';
  try { square = qrSvg(link); } catch { /* too long for a square: the link can still be copied */ }
  dialog(`<div class="dbody"><h3>Set up another device</h3>
    ${canMine ? `<div class="seg"><button type="button" data-x="mine" class="${mine ? 'on' : ''}">My own device</button><button type="button" data-x="other" class="${mine ? '' : 'on'}">Someone else’s</button></div>` : ''}
    <p class="note">${mine
      ? 'Point your phone’s camera at this square and tap the link that appears. The planner opens with all your accounts already connected.'
      : 'Point the phone’s camera at this square and tap the link that appears. The planner opens with the Google keys already filled in. Then press “+ Connect Google account” there.'}</p>
    ${square ? `<div class="qr">${square}</div>` : '<p class="note warn">This link is too long to show as a square. Use “Copy the link instead”.</p>'}
    <p class="note">On an iPhone, open the link in Safari, then use Share → Add to Home Screen to get an app icon.</p>
    <p class="note warn">${mine
      ? 'This square signs a device in to your Google calendars. Never show it to anyone else.'
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
    const c = a.needsReconnect ? null : a.calendars.find(c => c.summary === 'Teams' && c.accessRole === 'owner');
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
            <div class="srow">${text('Add another', '')}<button type="button" class="btn" data-x="connect">Connect account</button></div>
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

        ${section('ai', 'AI', 'Three optional helpers for your meetings. Each is a button you press; here is what they do.', `
          <h4>Tidy my notes</h4>
          <p class="gintro">A button under your notes in a meeting. It turns rough notes into a short summary, decisions and action points.</p>
          <div class="sgroup">
            ${row('Runs on this device', 'Inside your browser, so your notes are never sent anywhere. No key needed.', tag('Checking…', '', 'aiState'))}
          </div>
          <h4>Get facts about a person ${tag(...factsState(), 'factsState')}</h4>
          <p class="gintro">A button on a person’s profile. It looks them up on the web and fills in their profile inside Weftday: role, background, company and photo. It needs a key of your own.</p>
          <div class="sgroup">
            ${row('AI service', 'Writes the brief', `<select name="aiProvider">${costly(Object.values(S.AI_SERVICES))}</select>`)}
            <div class="sfield" id="aiKeyPart">
              <label for="aiKeyBox"><b id="aiKeyLabel"></b><i class="stag rec" id="aiRecTag" hidden>Recommended</i>${keyTag('', 'aiKeyTag')}</label>
              <input id="aiKeyBox" name="aiKey" type="password" placeholder="Paste your key here" autocomplete="off" spellcheck="false">
            </div>
            <div class="sfield">
              <details id="aiHelpBox"><summary id="aiHelpTitle"></summary><ol id="aiKeyHelp"></ol></details>
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
                <details><summary id="searchHelpTitle"></summary><ol id="searchKeyHelp"></ol></details>
              </div>
            </div>
            ${toggle('aiAuto', s.aiAuto, 'Look up today’s guests by itself', 'Profiles are ready when you open a meeting. Their names go to the AI without you pressing anything. People at your own company are skipped.')}
          </div>
          <h4>Ask AI ${tag('No key needed', 'ok')}</h4>
          <p class="gintro">Another button on a person’s profile, for when you want to dig deeper. It opens a chat app in a new tab with a question about them already typed. You carry on the conversation there, with your own account in that app.</p>
          <div class="sgroup">
            ${row('Chat app to open', '', select('aiApp', Object.entries(AI_APPS).map(([k, v]) => [k, v[0]]), s.aiApp))}
          </div>
          <p class="note">“Get facts” and “Ask AI” send the person’s name, company and the meeting title to that AI. Keys are kept only in this browser.</p>`)}

        ${section('data', 'Your data', 'Weftday has no server. Everything lives in this browser and in your own Google accounts.', `
          <div class="sgroup">
            ${row(`${state.tasks.length} task${state.tasks.length === 1 ? '' : 's'} on this device`, 'Save a copy as a file', '<button type="button" class="btn" data-x="backup">Download backup</button>')}
            ${row('Privacy', 'What is kept, and where', '<a class="btn" href="privacy.html" target="_blank" rel="noopener">Read</a>')}
            ${row('About Weftday', '', '<a class="btn" href="about.html" target="_blank" rel="noopener">Open</a>')}
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
      if (+fd.get('dayEnd') <= +fd.get('dayStart')) return stop('general', 'Your working day must end after it starts.');
      s.clientId = fd.get('clientId').trim();
      s.clientSecret = fd.get('clientSecret').trim();
      s.reminder = +fd.get('reminder');
      s.dayStart = +fd.get('dayStart'); s.dayEnd = +fd.get('dayEnd');
      s.morning = +fd.get('morning');
      s.theme = fd.get('theme') || 'auto';
      s.pictures = fd.get('pictures') === 'on';
      s.aiApp = fd.get('aiApp');
      keep();
      const keysBefore = keysNow();
      if (s.aiKey !== keys.google) s.aiFreeSince = 0; // a new key may have Google's own search
      const { google, claude, ...otherKeys } = keys, { tavily, ...otherFinders } = findKeys;
      const filled = map => Object.fromEntries(Object.entries(map).filter(([, v]) => v));
      s.aiKey = google; s.claudeKey = claude; s.aiKeys = filled(otherKeys); s.aiModels = filled(models);
      s.searchKey = tavily; s.searchKeys = filled(otherFinders);
      s.aiProvider = provider; s.searchProvider = finder;
      if (keysNow() !== keysBefore) s.keysAt = Date.now(); // the newest set of keys wins on your other devices
      s.aiAuto = fd.get('aiAuto') === 'on';
      const want = fd.get('planner'), share = fd.get('share') === 'on';
      save();
      applyTheme();
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
    device: () => openDeviceSetup(),
    connect: () => connect(),
    teams: () => openTeams(),
    backup() {
      const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), tasks: state.tasks }, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `planner-backup-${todayYmd()}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
    },
  }, 'settings');

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
  const setTag = (id, on) => { const t = part(id); t.textContent = on ? 'Saved' : 'Not added'; t.className = `stag ${on ? 'ok' : ''}`; };
  function keep() { // what is typed in the boxes right now
    keys[provider] = box('aiKey').value.trim();
    models[provider] = box('aiModel').value.trim();
    findKeys[finder] = box('searchKey').value.trim();
  }
  function showStates() {
    const [label, kind] = factsState(), t = part('factsState');
    t.textContent = label; t.className = `stag ${kind}`;
    setTag('aiKeyTag', keys[provider]); setTag('searchKeyTag', findKeys[finder]);
  }
  function showServices() {
    const svc = S.aiService(provider), find = S.searchService(finder);
    part('aiKeyPart').hidden = !!svc.noKey;
    part('aiKeyLabel').textContent = svc.label || '';
    part('aiRecTag').hidden = !svc.recommended;
    part('searchRecTag').hidden = !find.recommended;
    box('aiKey').value = keys[provider] || '';
    part('aiHelpTitle').textContent = `${svc.noKey ? `How to set ${svc.name} up` : 'How to get this key'} · ${svc.setup}`;
    part('searchHelpTitle').textContent = `How to get this key · ${find.setup}`;
    part('aiKeyHelp').innerHTML = svc.help;
    part('aiHelpBox').open = !!svc.noKey;
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
function notify(title, body, ev) {
  toast(`${title} · ${body}`, ev ? { go: ['Brief me', () => openBrief(ev)] } : {});
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const note = new Notification(title, { body: ev ? `${body}. Press to see your brief.` : body, icon: 'icon-192.png' });
      if (ev) note.onclick = () => { window.focus(); note.close(); openBrief(ev); };
    } catch { /* not supported here */ }
  }
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
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification('Your day', { body: `${meets} meeting${meets === 1 ? '' : 's'} and ${todo} task${todo === 1 ? '' : 's'} today`, icon: 'icon-192.png' }); } catch { /* not supported here */ }
  }
  if (meets) openToday(); else openPlan();
}

function tick() {
  const now = new Date(), today = ymd(now), nowM = nowMinutes();
  if (today !== renderedDay) { topUpSeries(); save(); render(); scheduleFlush(); } else { updateNowLine(); renderUpNext(); }
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
      due.push({ key: `${today}:e:${ev.key}:${ev.s}`, title: ev.title, body: when(mins, fmtTime(s.getHours() * 60 + s.getMinutes())), ev: outsiders(ev).length ? ev : null });
    }
  }
  let changed = false;
  for (const k of Object.keys(state.notified)) if (!k.startsWith(today)) { delete state.notified[k]; changed = true; }
  for (const d of due) {
    if (state.notified[d.key]) continue;
    state.notified[d.key] = 1; changed = true;
    notify(d.title, d.body, d.ev);
  }
  if (changed) save();
  askHowItWent(now, today);
  morningBrief(now, today);
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
    open: x => openEvent(events.get(x.dataset.ev)),
    brief: x => openBrief(events.get(x.dataset.ev)),
    person(x) {
      const ev = events.get(x.dataset.ev);
      openPerson((ev.att || []).find(g => (g.email || '').toLowerCase() === x.dataset.email), ev);
    },
    plan: () => openPlan(),
    // Looks up everyone in today's meetings who has no profile yet, then shows the day again.
    async fill(btn) {
      const job = aiJob = new AbortController(), list = [...missing.values()].slice(0, 8);
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
  Promise.all(emails.slice(0, 6).map(e => meetingsWith(e).catch(() => []))).then(lists => {
    const box = $('#firmMeets', el.dlg);
    if (!box) return;
    const all = [...new Map(lists.flat().map(m => [m.nk, m])).values()].sort((a, b) => b.s - a.s);
    const now = Date.now(), next = all.filter(m => m.s >= now).reverse(), past = all.filter(m => m.s < now);
    const row = m => `<div><i>${esc(dayLabel(new Date(m.s)))}</i> ${esc(m.title || '')}${N.has(m.nk) ? ' ✎' : ''}</div>`;
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
        || '<div class="note">Nobody matches. People appear here once they are in one of your meetings.</div>';
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
  if (innerWidth >= 760) find.focus();
}

// ---------------------------------------------------------------- share my free times
// Loads the meetings of some days that may not be on screen.
async function loadDays(from, to) {
  if (DEMO) {
    for (let ws = startOfWeek(from); ws < to; ws = addDays(ws, 7)) for (const ev of demoEvents(ws)) events.set(ev.key, ev);
    return;
  }
  const jobs = [];
  for (const a of state.accounts.filter(a => !a.needsReconnect)) for (const c of a.calendars) {
    if (!c.enabled || isPlannerCal(a, c)) continue;
    jobs.push(G.listEvents(a, c.id, from, to).then(items => {
      for (const e of items) {
        if (e.status === 'cancelled' || !e.start || e.eventType === 'workingLocation') continue;
        const ev = normalize(e, a, c);
        events.set(ev.key, ev);
      }
    }));
  }
  await Promise.all(jobs);
  if (plannerReady()) await sync(() => pullPlanner(from, to)).catch(() => {});
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
function openFreeTimes() {
  let days = 5, length = 30;
  const zone = new Date().toLocaleTimeString('en-GB', { timeZoneName: 'short' }).split(' ').pop();
  const seg = (name, list, cur) => `<div class="seg">${list.map(([v, l]) => `<button type="button" data-x="${name}" data-v="${v}" class="${v === cur ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  dialog(`<div class="dbody">
    <h3>Share my free times</h3>
    <p class="note">The times you are free across all your calendars, inside your working day. Copy them into an email or a chat.</p>
    <div class="rowline"><span class="note">Look ahead</span><span id="ftDays"></span></div>
    <div class="rowline"><span class="note">Meeting length</span><span id="ftLen"></span></div>
    <textarea id="ftText" rows="9" spellcheck="false">Checking your calendars…</textarea>
    <div class="actions"><span class="note" id="ftNote"></span><span class="sp"></span><button type="button" class="btn ghost" data-x="close">Close</button><button type="button" class="btn primary" data-x="copy">Copy</button></div></div>`, {
    days(x) { days = +x.dataset.v; paint(true); },
    len(x) { length = +x.dataset.v; paint(false); },
    async copy() {
      const box = $('#ftText', el.dlg);
      try { await navigator.clipboard.writeText(box.value); toast('Copied. Paste it into your email.'); }
      catch { box.select(); toast('Press Cmd+C to copy.'); }
    },
  });
  const workDays = () => { // the next working days, starting today
    const out = [];
    for (let d = startOfDay(new Date()); out.length < days; d = addDays(d, 1)) if (d.getDay() % 6) out.push(d);
    return out;
  };
  async function paint(load) {
    $('#ftDays', el.dlg).innerHTML = seg('days', [[3, '3 days'], [5, '5 days'], [10, '2 weeks']], days);
    $('#ftLen', el.dlg).innerHTML = seg('len', [[30, '30 min'], [45, '45 min'], [60, '1 hour']], length);
    const list = workDays(), box = $('#ftText', el.dlg);
    if (load) {
      try { await loadDays(list[0], addDays(list[list.length - 1], 1)); }
      catch { if (box.isConnected) { box.value = 'Your calendars could not be read. Check your connection and try again.'; } return; }
      if (!box.isConnected) return;
    }
    const lines = workDays().map(d => [d, freeSlots(d, length)]).filter(([, slots]) => slots.length)
      .map(([d, slots]) => `• ${dayLabel(d)}: ${slots.map(([s, e]) => (s === 0 && e === 1440 ? 'all day' : `${fmtTime(s)} – ${e === 1440 ? 'midnight' : fmtTime(e)}`)).join(', ')}`);
    box.value = lines.length ? `Here are some times that work for me (${zone}):\n${lines.join('\n')}` : 'No free time in your working hours on these days.';
    $('#ftNote', el.dlg).textContent = `${state.accounts.length || 'Sample'} calendar account${state.accounts.length === 1 ? '' : 's'} checked`;
  }
  paint(true);
}

// ---------------------------------------------------------------- sample data (?demo)
const DEMO_ACCOUNTS = [
  { id: 'work@example.com', email: 'work@example.com', color: '#2f6fed', calendars: [{ id: 'work', summary: 'Work', primary: true, accessRole: 'owner', enabled: true }] },
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
  return [
    mk(0, 0, 10, 0, 30, 'Weekly team sync', invite('accepted')),
    mk(0, 0, 14, 0, 60, 'Client call: Acme', { location: 'Google Meet', meet: 'https://meet.google.com/', att: [
      { email: 'ravi.menon@acme.com', displayName: 'Ravi Menon', organizer: true, responseStatus: 'accepted' },
      { email: 'lena@acme.com', responseStatus: 'tentative' },
      { email: 'work@example.com', displayName: 'You', self: true, responseStatus: 'accepted' }],
      links: [{ label: 'Fireflies notes', url: 'https://app.fireflies.ai/' }] }),
    mk(1, 0, 18, 30, 60, 'Dinner with Meera'),
    mk(0, 1, 11, 0, 45, 'Pipeline review', invite('needsAction')),
    mk(0, 1, 11, 30, 30, 'Quick check-in with Arjun'),
    mk(1, 1, 7, 0, 60, 'Dentist', { location: 'City Dental' }),
    mk(0, 2, 9, 30, 60, 'Product demo', invite('accepted')),
    mk(0, 2, 15, 0, 30, 'Vendor intro', invite('declined')),
    mk(0, 4, 10, 0, 30, 'Weekly wrap-up'),
    mk(1, 4, 19, 0, 120, 'Movie night'),
    mk(1, 5, 9, 0, 90, 'Football'),
    mk(0, 3, 0, 0, 1440, 'Team offsite', { allDay: true }),
  ];
}
function seedDemo() {
  state.accounts = structuredClone(DEMO_ACCOUNTS);
  if (state.tasks.length) return;
  const today = startOfDay(new Date()), d = n => ymd(addDays(today, n));
  state.tasks.push(
    newTask({ title: 'Write proposal for Acme', date: d(0), start: 9 * 60, duration: 90, tag: 'work', priority: 'high' }),
    newTask({ title: 'Reply to investor email', date: d(0), start: 12 * 60, duration: 30, tag: 'work' }),
    newTask({ title: 'Gym', date: d(0), start: 17 * 60, duration: 60, tag: 'health' }),
    newTask({ title: 'Pay electricity bill', date: d(0), tag: 'personal' }),
    newTask({ title: 'Prepare demo script', date: d(1), start: 15 * 60, duration: 60, tag: 'work' }),
    newTask({ title: 'Send invoice to client', date: d(-1), start: 16 * 60, duration: 30, tag: 'work' }),
    newTask({ title: 'Book flights for Goa', duration: 30, tag: 'personal' }),
    newTask({ title: 'Read contract draft', duration: 45, tag: 'work' }),
  );
  save();
}

// ---------------------------------------------------------------- start
async function boot() {
  applyTheme();
  bind();
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
  if (homeFromLink) await adoptHome(homeFromLink);
  else if (gotKeys) toast('Keys added. Now press “+ Connect Google account”.');
  try {
    const a = await G.finishConnect();
    if (a) await onConnected(a);
  } catch (err) { toast(err.message, true); }
  if (!DEMO) {
    await Promise.all(state.accounts.filter(a => !a.needsReconnect).map(a => G.refreshCalendars(a).catch(err => console.warn(a.email, err))));
    renderSide();
    scheduleFlush();
    await shareSync();
  }
  await refresh();
  tick();
  setInterval(tick, 30000);
  const catchUp = () => { checkForUpdate(); return shareSync().then(refresh); };
  checkForUpdate();
  setInterval(() => { if (!document.hidden) catchUp(); }, 5 * 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); catchUp(); } });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
