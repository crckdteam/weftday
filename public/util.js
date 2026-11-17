// Small date, formatting and parsing helpers.

export const pad = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fromYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const startOfWeek = d => { const x = startOfDay(d); return addDays(x, -((x.getDay() + 6) % 7)); }; // Monday
export const localIso = d => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
export const hhmm = m => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
export const parseHhmm = s => { if (!s) return null; const [h, m] = s.split(':').map(Number); return h * 60 + m; };
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const fmtTime = m => {
  const h = Math.floor(m / 60) % 24, mm = m % 60, h12 = h % 12 || 12;
  return `${h12}${mm ? ':' + pad(mm) : ''}${h < 12 ? 'am' : 'pm'}`;
};
export const fmtRange = (s, e) => `${fmtTime(s)} – ${fmtTime(e)}`;
export const fmtDur = m => m < 60 ? `${m}m` : (m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`);
export const dayLabel = (d, long) =>
  d.toLocaleDateString('en-GB', { weekday: long ? 'long' : 'short', day: 'numeric', month: 'short' });

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2))
    .replace(/-/g, '').slice(0, 20);

export const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const days = (from, n) => Array.from({ length: n }, (_, i) => addDays(from, i));
export const monthStart = d => new Date(d.getFullYear(), d.getMonth(), 1);

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const ORD = '(\\d{1,2})(?:st|nd|rd|th)?';

// ---- how a task repeats
// 'daily', 'weekdays' (Mon–Fri), 'weekly' (the weekday it starts on), or chosen days written as "d"
// plus the days of the week it falls on (0 = Sunday): "d123456" is every day except Sunday.
export const repeatDays = r => (/^d[0-6]+$/.test(r || '') ? [...r.slice(1)].map(Number) : null);
export const repeatsOn = (r, weekday, startWeekday) => r === 'daily' || (r === 'weekdays' && weekday >= 1 && weekday <= 5)
  || (r === 'weekly' && weekday === startWeekday) || !!repeatDays(r)?.includes(weekday);
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function repeatLabel(r) {
  const days = repeatDays(r);
  if (!days) return { daily: 'every day', weekdays: 'Mon – Fri', weekly: 'every week' }[r] || '';
  const set = new Set(days), off = [1, 2, 3, 4, 5, 6, 0].filter(d => !set.has(d));
  if (!off.length) return 'every day';
  if (off.length === 2 && !set.has(0) && !set.has(6)) return 'Mon – Fri';
  if (set.size === 2 && set.has(0) && set.has(6)) return 'weekends';
  if (off.length <= 2) return `every day except ${off.map(d => DAY_NAMES[d]).join(' and ')}`;
  return [1, 2, 3, 4, 5, 6, 0].filter(d => set.has(d)).map(d => DAY_NAMES[d]).join(', ');
}
// The first day, from the given one on, that a repeat falls on.
export function firstRepeatDay(dateYmd, r) {
  let d = fromYmd(dateYmd);
  const start = d.getDay();
  for (let i = 0; i < 7 && !repeatsOn(r, d.getDay(), start); i++) d = addDays(d, 1);
  return ymd(d);
}

// Turns "gym tomorrow 7am 1h #health !" into a structured task.
export function parseQuick(text, now = new Date()) {
  let s = ' ' + text.trim() + ' ';
  const out = { title: '', date: null, start: null, duration: null, tag: '', priority: 'normal', repeat: null };
  const today = startOfDay(now);
  // A day and month with no year means the next time that date comes round.
  const setDay = (d, m, year) => {
    if (m < 0 || m > 11) return false;
    for (let y = +year || today.getFullYear(), tries = year ? 1 : 9; tries; y++, tries--) { // 29 Feb: the next year that has one
      const x = new Date(y, m, d);
      if (x.getMonth() !== m || (!year && x < today)) continue;
      out.date = ymd(x);
      return true;
    }
    return false;
  };
  const monthOf = w => MONTHS.indexOf(w.slice(0, 3).toLowerCase());

  s = s.replace(/\s#([\w-]+)(?=\s)/, (_, t) => { out.tag = t; return ' '; });
  s = s.replace(/\s(!high|!!|!)(?=\s)/i, () => { out.priority = 'high'; return ' '; });

  // repeat on chosen days: "except sundays", "every mon wed fri", "weekends"
  const DAYW = '(?:mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)s?';
  const JOIN = '(?:\\s*,\\s*(?:and\\s+)?|\\s+and\\s+|\\s+or\\s+|\\s+)';
  const daysIn = words => {
    const set = new Set();
    for (const w of words.toLowerCase().match(/weekends?|[a-z]+/g) || []) {
      if (/^weekend/.test(w)) { set.add(0); set.add(6); continue; }
      const i = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(w.slice(0, 3));
      if (i >= 0) set.add(i);
    }
    return set;
  };
  const asRepeat = set => 'd' + [0, 1, 2, 3, 4, 5, 6].filter(d => set.has(d)).join('');
  s = s.replace(new RegExp(`\\s(?:(?:every\\s*day|daily)\\s+)?(?:except|excluding|but\\s+not(?:\\s+on)?|not\\s+on)\\s+((?:${DAYW}|weekends?)(?:${JOIN}(?:${DAYW}|weekends?))*)(?=\\s)`, 'i'), (all, list) => {
    const off = daysIn(list), on = new Set([0, 1, 2, 3, 4, 5, 6].filter(d => !off.has(d)));
    if (!off.size || !on.size) return all;
    out.repeat = asRepeat(on); return ' ';
  });
  if (out.repeat) s = s.replace(/\s(every\s*day|daily)(?=\s)/i, ' '); // "daily … except weekends": the "daily" is already said
  // "every mon wed fri", or "on mondays and fridays" (a plain "on monday and friday" is two one-off days, not a repeat)
  const DAYSP = '(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)days';
  for (const form of [`(?:every|each)\\s+(${DAYW}(?:${JOIN}${DAYW})+)`, `on\\s+(${DAYSP}(?:${JOIN}${DAYSP})+)`]) {
    if (!out.repeat) s = s.replace(new RegExp(`\\s${form}(?=\\s)`, 'i'), (all, list) => {
      const on = daysIn(list);
      if (on.size < 2) return all;
      out.repeat = asRepeat(on); return ' ';
    });
  }
  if (!out.repeat) s = s.replace(/\s(?:every\s+weekend|(?:on\s+)?weekends)(?=\s)/i, () => { out.repeat = 'd06'; return ' '; });
  // repeat: every day, daily, every weekday, weekly, every monday
  if (!out.repeat) s = s.replace(/\s(every\s*day|daily|every\s+weekday|weekdays|every\s+week|weekly)(?=\s)/i, (_, w) => {
    out.repeat = /weekday/i.test(w) ? 'weekdays' : /week/i.test(w) ? 'weekly' : 'daily'; return ' ';
  });
  if (!out.repeat) s = s.replace(/\severy(?=\s+(?:mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\s)/i, () => { out.repeat = 'weekly'; return ''; });

  // length: 1h, 1.5h, 1h30m, 90m, 45min
  s = s.replace(/\s(?:for\s+)?(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)(?:\s*(?:and\s+)?(\d+)\s*(?:m|min|mins|minutes?)?)?(?=\s)/i,
    (all, h, m) => { const mins = Math.round(parseFloat(h) * 60) + (m ? +m : 0); if (mins > 1440) return all; out.duration = mins; return ' '; }); // longer than a day is not a length
  if (out.duration == null) {
    s = s.replace(/\s(?:for\s+)?(\d+)\s*(?:m|min|mins|minutes)(?=\s)/i, (all, m) => { if (+m > 1440) return all; out.duration = +m; return ' '; });
  }

  // time: 7am, 7:30pm, 17:00, noon
  s = s.replace(/\s(?:at\s+)?(\d{1,2})(?:[:.]?([0-5]\d))?\s*(am|pm)(?=\s)/i, (all, h, m, ap) => { // 7pm, 7:30pm, 730 pm, 7.30pm
    if (+h > 12) return all;
    let hh = +h % 12; if (/pm/i.test(ap)) hh += 12;
    out.start = hh * 60 + (m ? +m : 0); return ' ';
  });
  if (out.start == null) {
    s = s.replace(/\s(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)(?=\s)/, (_, h, m) => { out.start = +h * 60 + +m; return ' '; });
  }
  if (out.start == null) s = s.replace(/\s(?:at\s+)?noon(?=\s)/i, () => { out.start = 720; return ' '; });

  // day: today, tomorrow, in 3 days, next week, 25 nov, nov 25, 25/11, mon..sun
  s = s.replace(/\s(today|tomorrow|tmrw|tmr)(?=\s)/i, (_, w) => {
    out.date = ymd(/^today$/i.test(w) ? today : addDays(today, 1)); return ' ';
  });
  if (!out.date) s = s.replace(/\sin\s+(\d{1,3})\s+days?(?=\s)/i, (_, n) => { out.date = ymd(addDays(today, +n)); return ' '; });
  const DAY = '(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)';
  const dayIndex = w => ({ sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }[w.slice(0, 3).toLowerCase()]);
  // "next week tue": that day of next week; plain "next week": its Monday
  if (!out.date) s = s.replace(new RegExp(`\\snext\\s+week(?:\\s+(?:on\\s+)?${DAY})?(?=\\s)`, 'i'), (_, w) => {
    out.date = ymd(addDays(startOfWeek(today), 7 + (w ? (dayIndex(w) + 6) % 7 : 0))); return ' ';
  });
  if (!out.date) s = s.replace(new RegExp(`\\s(?:on\\s+)?${ORD}\\s+${MON}(?:\\s+(20\\d\\d))?(?=\\s)`, 'i'), (all, d, m, y) => setDay(+d, monthOf(m), y) ? ' ' : all);
  if (!out.date) s = s.replace(new RegExp(`\\s(?:on\\s+)?${MON}\\s+${ORD}(?:,?\\s+(20\\d\\d))?(?=\\s)`, 'i'), (all, m, d, y) => setDay(+d, monthOf(m), y) ? ' ' : all);
  // 25/11, but not "24/7" or "1/2 of the deck"
  if (!out.date) s = s.replace(/\s(?:on\s+)?(\d{1,2})\/(\d{1,2})(?=\s)(?!\s+of\s)/, (all, d, m) => (/24\/7/.test(all) ? all : setDay(+d, +m - 1) ? ' ' : all));
  if (!out.date) {
    // "sat" and "sun" are also ordinary words ("sat down", "sun cream"): alone they only count as days
    // at the end, before a time or number, or after "on" / "next"
    s = s.replace(new RegExp(`\\s(on\\s+|next\\s+)?${DAY}(?=\\s)`, 'i'), (all, lead, w, at, whole) => {
      const rest = whole.slice(at + all.length).trim();
      if (/^(sat|sun)$/i.test(w) && !lead && rest && !/^(\d|at\b|#|!|every\b|for\b|morning|afternoon|evening|night)/i.test(rest)) return all;
      let diff = (dayIndex(w) - today.getDay() + 7) % 7; if (diff === 0) diff = 7;
      out.date = ymd(addDays(today, diff)); return ' ';
    });
  }

  out.title = s.replace(/\s+/g, ' ').trim();
  if (out.date || out.start != null) out.title = out.title.replace(/\s+(by|before|until|on|at)$/i, '') || out.title; // "send it by Friday" leaves no dangling "by"
  // A time with no day means today, or tomorrow if that time has already passed.
  if (out.start != null && !out.date) {
    const nowM = now.getHours() * 60 + now.getMinutes();
    out.date = ymd(out.start < nowM ? addDays(today, 1) : today);
  }
  if (out.repeat && !out.date) out.date = ymd(today);
  if (out.repeat && out.date) out.date = firstRepeatDay(out.date, out.repeat); // not on a day it skips
  return out;
}

// ---- text from outside that becomes a link or a colour
// A meeting link found in an invite's text. The site name must be the address's own host, so that
// "https://some-other-site/?next=zoom.us/j/1" is never taken for a Zoom link.
export const VIDEO_RE = /https:\/\/(?:[\w-]+\.)*(?:zoom\.us\/(?:j|my|w)\/|teams\.microsoft\.com\/(?:l\/meetup-join|meet\/)|teams\.live\.com\/meet\/|meet\.google\.com\/|webex\.com\/)[^\s"'<>]*/i;
export const webLink = u => (/^https:\/\//i.test(u || '') ? u : ''); // only a real web address may become a link
export const hue = c => (/^#[0-9a-f]{3,8}$/i.test(c || '') ? c : '#888'); // a colour is only ever a plain colour code
