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

// Turns "gym tomorrow 7am 1h #health !" into a structured task.
export function parseQuick(text, now = new Date()) {
  let s = ' ' + text.trim() + ' ';
  const out = { title: '', date: null, start: null, duration: null, tag: '', priority: 'normal', repeat: null };
  const today = startOfDay(now);
  // A day and month with no year means the next time that date comes round.
  const setDay = (d, m) => {
    let x = new Date(today.getFullYear(), m, d);
    if (m < 0 || x.getMonth() !== m) return false;
    if (x < today) x = new Date(today.getFullYear() + 1, m, d);
    out.date = ymd(x);
    return true;
  };
  const monthOf = w => MONTHS.indexOf(w.slice(0, 3).toLowerCase());

  s = s.replace(/\s#([\w-]+)(?=\s)/, (_, t) => { out.tag = t; return ' '; });
  s = s.replace(/\s(!high|!!|!)(?=\s)/i, () => { out.priority = 'high'; return ' '; });

  // repeat: every day, daily, every weekday, weekly, every monday
  s = s.replace(/\s(every\s*day|daily|every\s+weekday|weekdays|every\s+week|weekly)(?=\s)/i, (_, w) => {
    out.repeat = /weekday/i.test(w) ? 'weekdays' : /week/i.test(w) ? 'weekly' : 'daily'; return ' ';
  });
  if (!out.repeat) s = s.replace(/\severy(?=\s+(?:mon|tue|wed|thu|fri|sat|sun))/i, () => { out.repeat = 'weekly'; return ''; });

  // length: 1h, 1.5h, 1h30m, 90m, 45min
  s = s.replace(/\s(?:for\s+)?(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)(?:\s*(\d+)\s*(?:m|min|mins))?(?=\s)/i,
    (_, h, m) => { out.duration = Math.round(parseFloat(h) * 60) + (m ? +m : 0); return ' '; });
  if (out.duration == null) {
    s = s.replace(/\s(?:for\s+)?(\d+)\s*(?:m|min|mins|minutes)(?=\s)/i, (_, m) => { out.duration = +m; return ' '; });
  }

  // time: 7am, 7:30pm, 17:00, noon
  s = s.replace(/\s(?:at\s+)?(\d{1,2})(?::([0-5]\d))?\s*(am|pm)(?=\s)/i, (_, h, m, ap) => {
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
  if (!out.date) s = s.replace(/\snext\s+week(?=\s)/i, () => { out.date = ymd(addDays(startOfWeek(today), 7)); return ' '; });
  if (!out.date) s = s.replace(new RegExp(`\\s(?:on\\s+)?${ORD}\\s+${MON}(?=\\s)`, 'i'), (all, d, m) => setDay(+d, monthOf(m)) ? ' ' : all);
  if (!out.date) s = s.replace(new RegExp(`\\s(?:on\\s+)?${MON}\\s+${ORD}(?=\\s)`, 'i'), (all, m, d) => setDay(+d, monthOf(m)) ? ' ' : all);
  if (!out.date) s = s.replace(/\s(?:on\s+)?(\d{1,2})\/(\d{1,2})(?=\s)/, (all, d, m) => setDay(+d, +m - 1) ? ' ' : all);
  if (!out.date) {
    s = s.replace(/\s(?:on\s+|next\s+)?(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)(?=\s)/i, (_, w) => {
      const idx = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }[w.slice(0, 3).toLowerCase()];
      let diff = (idx - today.getDay() + 7) % 7; if (diff === 0) diff = 7;
      out.date = ymd(addDays(today, diff)); return ' ';
    });
  }

  out.title = s.replace(/\s+/g, ' ').trim();
  // A time with no day means today, or tomorrow if that time has already passed.
  if (out.start != null && !out.date) {
    const nowM = now.getHours() * 60 + now.getMinutes();
    out.date = ymd(out.start < nowM ? addDays(today, 1) : today);
  }
  if (out.repeat && !out.date) out.date = ymd(today);
  return out;
}
