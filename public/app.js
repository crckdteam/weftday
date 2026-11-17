import { state, save, DEMO, loadEventCache, saveEventCache } from './store.js';
import * as G from './google.js';
import * as V from './vault.js';
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

let toastTimer;
function toast(msg, o = {}) {
  if (o === true) o = { err: true };
  (el.dlg.open ? el.dlg : document.body).append(el.toast);
  el.toast.innerHTML = `<span>${esc(msg)}</span>${o.undo ? '<button data-act="undo">Undo</button>' : ''}`;
  el.toast.className = 'show' + (o.err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.className = ''; }, o.err || o.undo ? 6000 : 3200);
}
function setStatus(text, isErr) {
  el.status.textContent = text;
  el.status.className = isErr ? 'err' : '';
}

let dlgOpenedAt = 0;
function dialog(html, handlers = {}, cls = '') {
  document.body.append(el.toast);
  el.dlg.className = cls;
  el.dlg.innerHTML = html;
  dlgOpenedAt = Date.now();
  if (!el.dlg.open) el.dlg.showModal();
  el.dlg.onclick = e => {
    if (e.target === el.dlg) { if (Date.now() - dlgOpenedAt > 250) el.dlg.close(); return; }
    const x = e.target.closest('[data-x]');
    if (!x) return;
    if (x.dataset.x === 'close') return el.dlg.close();
    handlers[x.dataset.x]?.(x, e);
  };
  const f = $('form', el.dlg);
  if (f) f.onsubmit = e => { e.preventDefault(); handlers.submit?.(new FormData(f), f); };
}
const closeDialog = () => { if (el.dlg.open) el.dlg.close(); };
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
  toast(t.start != null ? `Scheduled today at ${fmtTime(t.start)}` : 'Moved to today', { undo: true });
}

function toggleDone(t) {
  mark();
  t.done = !t.done;
  if (t.done && !t.date) { t.date = todayYmd(); t.start = null; toast('Done. Logged on today.', { undo: true }); }
  touch(t);
  commit();
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
  let h = todayCardHtml() + `<div id="upnext">${upNextHtml()}</div>`;
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
  return `<div class="blk ev${evClass(ev)}${sm}" data-key="${esc(ev.key)}" style="${style}--c:${evColor(ev)}">
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
function scrollToNow() {
  el.grid.scrollTop = Math.max(0, (nowMinutes() - 120) * PXM);
}

// ---------------------------------------------------------------- navigation
function setView(v) { view = v; state.settings.view = v; save(); nav(); }
function nav() { render(); refresh(); }
function step(n) {
  cursor = view === 'month' ? new Date(cursor.getFullYear(), cursor.getMonth() + n, 1) : addDays(cursor, n * (view === 'day' ? 1 : 7));
  miniMonth = null;
  nav();
}
function goTo(d, v) {
  cursor = startOfDay(d);
  miniMonth = null;
  if (v && v !== view) setView(v); else nav();
}
function goToday() { goTo(new Date()); if (!el.grid.hidden) scrollToNow(); }

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
  if (act === 'plan') return openPlan();
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
  el.dlg.addEventListener('close', () => document.body.append(el.toast));
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
    ['Go to today', goToday], ['Plan my day', openPlan], ['New task', newTaskHere], ['New event', () => openEventForm(null)],
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

function openEvent(ev) {
  const a = acct(ev.accountId), c = a?.calendars.find(c => c.id === ev.calendarId);
  const people = (ev.att || []).filter(p => !p.resource);
  dialog(`<div class="dbody">
    <h3>${esc(ev.title)}</h3>
    <div class="meta">${esc(eventWhen(ev))}</div>
    <div class="meta"><span class="dot" style="background:${a?.color || '#888'}"></span>${esc(a?.email || '')}${c && !c.primary ? ' · ' + esc(c.summary) : ''}</div>
    ${ev.location ? `<div class="meta">${esc(ev.location)}</div>` : ''}
    ${ev.meet ? `<div><a class="btn primary" href="${esc(ev.meet)}" target="_blank" rel="noopener">Join video call</a></div>` : ''}
    ${people.length ? `<div class="people">${people.slice(0, 40).map(p => `<div>${esc(p.displayName || p.email)}${p.organizer ? ' <i>(organiser)</i>' : ''} <i>· ${STATUS_LABEL[p.responseStatus] || ''}</i></div>`).join('')}${people.length > 40 ? `<div><i>and ${people.length - 40} more</i></div>` : ''}</div>` : ''}
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
  if (!targets.length) return openSettings('Connect a Google account first, then you can add events to it.');
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
  const allDay = !!e.start?.date;
  const self = (e.attendees || []).find(p => p.self);
  const calWritable = ['owner', 'writer'].includes(c.accessRole);
  const entry = (e.conferenceData?.entryPoints || []).find(p => p.entryPointType === 'video' && /^https:\/\//.test(p.uri || ''))?.uri;
  return {
    key: `${a.id}|${c.id}|${e.id}`, id: e.id, accountId: a.id, calendarId: c.id,
    title: e.summary || '(No title)',
    s: allDay ? fromYmd(e.start.date).getTime() : Date.parse(e.start.dateTime),
    e: allDay ? fromYmd(e.end.date).getTime() : Date.parse(e.end.dateTime),
    allDay, location: e.location || '', htmlLink: e.htmlLink || '',
    meet: e.hangoutLink || entry || `${e.location || ''} ${e.description || ''}`.match(VIDEO_RE)?.[0] || '',
    description: (e.description || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').slice(0, 2000),
    att: e.attendees || [], selfStatus: self?.responseStatus || null,
    organizerSelf: !!e.organizer?.self, calWritable,
    canEdit: calWritable && (!!e.organizer?.self || !(e.attendees || []).length),
  };
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
    if (state.tombstones.length || state.tasks.some(t => t.dirty)) scheduleFlush();
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
      if (e.status === 'cancelled' || !e.start || V.isShared(e)) continue;
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
  if (changed) { state.tombstones = []; for (const t of state.tasks) { t.gEventId = null; t.remoteUpdated = null; } }
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

function openSettings(msg) {
  const s = state.settings;
  const perm = !('Notification' in window) ? 'not available in this browser' : { granted: 'on', denied: 'blocked in browser settings', default: 'off' }[Notification.permission];
  const hours = Array.from({ length: 24 }, (_, h) => [h * 60, fmtTime(h * 60)]);
  dialog(`<form class="dbody">
    <h3>Settings</h3>
    ${msg ? `<p class="note warn">${esc(msg)}</p>` : ''}
    <h4>Google connection</h4>
    <label>Client ID<input name="clientId" value="${esc(s.clientId)}" placeholder="…apps.googleusercontent.com" autocomplete="off" spellcheck="false"></label>
    <label>Client secret<input name="clientSecret" type="password" value="${esc(s.clientSecret)}" autocomplete="off"></label>
    <details><summary>How to get these (one time, about 10 minutes)</summary><ol>
      <li>Open <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">console.cloud.google.com</a> and create a project called “Weftday”.</li>
      <li>Go to <b>APIs &amp; Services → Library</b>, find <b>Google Calendar API</b> and press Enable.</li>
      <li>Go to <b>Google Auth Platform</b> (OAuth consent screen). Choose <b>External</b>, give it a name and your email.</li>
      <li>Under <b>Audience</b>, press <b>Publish app</b>. This stops Google signing you out every 7 days. Only you can use it.</li>
      <li>Under <b>Clients</b>, create a client of type <b>Web application</b>. Add <code>${esc(location.origin)}</code> under “Authorised JavaScript origins” and <code>${esc(G.redirectUri())}</code> under “Authorised redirect URIs”.</li>
      <li>Copy the Client ID and Client secret into the boxes above and press Save.</li>
      <li>When you connect an account, Google shows a “not verified” warning. Choose <b>Advanced → Go to Weftday</b>. That is expected for a private app.</li>
    </ol></details>
    <div class="rowline"><span class="note">Phone, tablet or another computer</span><button type="button" class="btn" data-x="device">Set up another device</button></div>
    <h4>Where tasks are saved</h4>
    <label>Save tasks to a “Weftday” calendar in<select name="planner">${opts([['', 'This device only'], ...state.accounts.map(a => [a.id, a.email])], s.plannerAccountId)}</select></label>
    <label class="check"><input type="checkbox" name="share"${s.shareAccounts ? ' checked' : ''}>Keep my accounts the same on all my devices</label>
    <p class="note">Saves the sign-ins for your accounts, locked, inside the account chosen above. A new device then needs no Google login, and accounts you add or remove follow you everywhere. Keep that account safe.</p>
    <h4>Your day</h4>
    <div class="row two">
      <label>Working day starts<select name="dayStart">${opts(hours, s.dayStart)}</select></label>
      <label>Working day ends<select name="dayEnd">${opts(hours.slice(1).concat([[1440, 'midnight']]), s.dayEnd)}</select></label>
    </div>
    <div class="row two">
      <label>Morning summary<select name="morning">${opts([[-1, 'Off'], ...hours.slice(5, 12).map(([m, l]) => [m, `From ${l}`])], s.morning)}</select></label>
      <label>Remind me<select name="reminder">${reminderOptions(s.reminder, false)}</select></label>
    </div>
    <div class="rowline"><span class="note">Notifications on this device: <b>${perm}</b></span>${perm === 'off' ? '<button type="button" class="btn" data-x="notif">Turn on</button>' : ''}</div>
    <h4>Look</h4>
    <label>Theme<select name="theme">${opts([['auto', 'Match this device'], ['light', 'Light'], ['dark', 'Dark']], s.theme)}</select></label>
    <h4>Your data</h4>
    <div class="rowline"><span class="note">${state.tasks.length} tasks stored on this device</span><button type="button" class="btn" data-x="backup">Download backup</button></div>
    <div class="actions"><span class="sp"></span>
      <button type="button" class="btn ghost" data-x="close">Cancel</button>
      <button class="btn primary">Save</button></div></form>`, {
    async submit(fd, form) {
      if (+fd.get('dayEnd') <= +fd.get('dayStart')) return toast('Your working day must end after it starts.', true);
      s.clientId = fd.get('clientId').trim();
      s.clientSecret = fd.get('clientSecret').trim();
      s.reminder = +fd.get('reminder');
      s.dayStart = +fd.get('dayStart'); s.dayEnd = +fd.get('dayEnd');
      s.morning = +fd.get('morning');
      s.theme = fd.get('theme');
      const want = fd.get('planner'), share = fd.get('share') === 'on';
      save();
      applyTheme();
      if (share && !want) return toast('To keep your accounts the same everywhere, first choose an account to save tasks in.', true);
      if (share && !s.clientSecret) return toast('To keep your accounts the same everywhere, add the Client secret first.', true);
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
    async notif() { await Notification.requestPermission(); openSettings(); },
    device: () => openDeviceSetup(),
    backup() {
      const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), tasks: state.tasks }, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `planner-backup-${todayYmd()}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
    },
  });
}

// ---------------------------------------------------------------- reminders
function notify(title, body) {
  toast(`${title} · ${body}`);
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: 'icon-192.png' }); } catch { /* not supported here */ }
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
  openPlan();
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
      due.push({ key: `${today}:e:${ev.key}:${ev.s}`, title: ev.title, body: when(mins, fmtTime(s.getHours() * 60 + s.getMinutes())) });
    }
  }
  let changed = false;
  for (const k of Object.keys(state.notified)) if (!k.startsWith(today)) { delete state.notified[k]; changed = true; }
  for (const d of due) {
    if (state.notified[d.key]) continue;
    state.notified[d.key] = 1; changed = true;
    notify(d.title, d.body);
  }
  if (changed) save();
  morningBrief(now, today);
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
      att: [], selfStatus: null, organizerSelf: true, calWritable: false, canEdit: false, ...extra,
    };
  };
  const invite = status => ({ selfStatus: status, organizerSelf: false, att: [
    { email: 'priya@example.com', displayName: 'Priya Shah', organizer: true, responseStatus: 'accepted' },
    { email: 'work@example.com', displayName: 'You', self: true, responseStatus: status }] });
  return [
    mk(0, 0, 10, 0, 30, 'Weekly team sync', invite('accepted')),
    mk(0, 0, 14, 0, 60, 'Client call: Acme', { location: 'Google Meet', meet: 'https://meet.google.com/' }),
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
  const catchUp = () => shareSync().then(refresh);
  setInterval(() => { if (!document.hidden) catchUp(); }, 5 * 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); catchUp(); } });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
