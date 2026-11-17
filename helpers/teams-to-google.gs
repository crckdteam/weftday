/**
 * Weftday helper: copies the meetings from a published Outlook / Teams calendar into a Google
 * calendar, so Weftday (and Google Calendar) can show them.
 *
 * - One way only: Teams -> Google. Nothing is ever changed in Teams or Outlook.
 * - It runs inside your own Google account (Google Apps Script). No other server is involved.
 * - Setup steps are in helpers/README.md.
 */

// ---------------------------------------------------------------- settings
const ICS_URL = 'PASTE YOUR OUTLOOK CALENDAR LINK HERE'; // the link from Outlook that ends in .ics
const CALENDAR_NAME = 'Teams'; // the Google calendar the meetings are copied into (made for you if missing)
const EVERY_MINUTES = 15;      // how often to check: 1, 5, 10, 15 or 30

// ---------------------------------------------------------------- run these from the editor
/** Run once: checks now, then keeps checking every EVERY_MINUTES minutes. */
function install() {
  removeTriggers_();
  ScriptApp.newTrigger('sync').timeBased().everyMinutes(EVERY_MINUTES).create();
  PropertiesService.getScriptProperties().deleteProperty('lastFeed');
  sync();
}

/** Run to stop the helper. The copied meetings stay in the Google calendar until you delete it. */
function uninstall() {
  removeTriggers_();
}

/** One check: reads the Outlook link and brings the Google calendar into step with it. */
function sync() {
  if (!/^(https|webcal):\/\//i.test(ICS_URL)) throw new Error('Paste your Outlook calendar link into ICS_URL at the top first.');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // an earlier check is still running
  try {
    const res = UrlFetchApp.fetch(ICS_URL.replace(/^webcal:/i, 'https:'), { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('Could not read the Outlook calendar link (error ' + res.getResponseCode() + ').');
    const text = res.getContentText();
    if (text.indexOf('BEGIN:VCALENDAR') < 0) throw new Error('That link did not return a calendar.');

    const props = PropertiesService.getScriptProperties();
    const calendarId = targetCalendarId_(props);
    const stamp = digest_(text.replace(/^DTSTAMP:.*$/gm, '')) + '|' + calendarId;
    if (props.getProperty('lastFeed') === stamp) return; // nothing has changed since the last check

    const result = apply_(calendarId, buildEvents(text, Session.getScriptTimeZone()));
    if (!result.failed) props.setProperty('lastFeed', stamp);
    console.log('Teams -> Google: ' + result.added + ' added, ' + result.changed + ' changed, ' + result.removed + ' removed' +
      (result.failed ? ', ' + result.failed + ' could not be copied (will retry)' : ''));
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- Google side
function removeTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'sync') ScriptApp.deleteTrigger(t); });
}

function targetCalendarId_(props) {
  const saved = props.getProperty('calendarId');
  if (saved && CalendarApp.getCalendarById(saved)) return saved;
  const cal = CalendarApp.getOwnedCalendarsByName(CALENDAR_NAME)[0] || CalendarApp.createCalendar(CALENDAR_NAME);
  props.setProperty('calendarId', cal.getId());
  return cal.getId();
}

// Makes the Google calendar match the list: adds what is new, updates what changed, removes what is gone.
function apply_(calendarId, wanted) {
  const result = { added: 0, changed: 0, removed: 0, failed: 0 };
  const attempt = function (what, fn) {
    try { fn(); return true; } catch (err) { result.failed++; console.warn('Could not ' + what + ': ' + err); return false; }
  };

  const have = {};
  let pageToken;
  do {
    const page = Calendar.Events.list(calendarId, {
      privateExtendedProperty: 'weftdayTeams=1', showDeleted: false, singleEvents: false, maxResults: 2500, pageToken: pageToken,
    });
    (page.items || []).forEach(function (e) {
      const key = e.extendedProperties.private.key;
      if (have[key]) attempt('remove a duplicate', function () { Calendar.Events.remove(calendarId, e.id); });
      else have[key] = e;
    });
    pageToken = page.nextPageToken;
  } while (pageToken);

  wanted.forEach(function (w) {
    const old = have[w.key];
    delete have[w.key];
    if (!old) {
      if (attempt('add "' + w.resource.summary + '"', function () { Calendar.Events.insert(w.resource, calendarId); })) result.added++;
    } else if (old.extendedProperties.private.sig !== w.sig) {
      if (attempt('update "' + w.resource.summary + '"', function () { Calendar.Events.update(w.resource, calendarId, old.id); })) result.changed++;
    }
  });

  // Whatever is left is no longer in Teams. Past one-off meetings are kept as a record.
  const now = Date.now();
  Object.keys(have).forEach(function (key) {
    const e = have[key], end = e.end && (e.end.dateTime || e.end.date);
    if (e.recurrence || !end || new Date(end).getTime() > now) {
      if (attempt('remove "' + e.summary + '"', function () { Calendar.Events.remove(calendarId, e.id); })) result.removed++;
    }
  });
  return result;
}

function digest_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text, Utilities.Charset.UTF_8)
    .map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); }).join('');
}

// ---------------------------------------------------------------- reading the Outlook calendar
// Turns the calendar text into Google events: [{ key, sig, resource }]
function buildEvents(text, defaultZone) {
  const cal = parseIcs(text);
  const zone = toIana(cal.zone) || defaultZone;
  const usable = cal.events.filter(function (v) { return v.UID && v.DTSTART; });
  const masters = {}, out = [];

  usable.forEach(function (v) { // ordinary meetings and the main entry of repeating ones
    if (v['RECURRENCE-ID'] || cancelled(v)) return;
    const ev = toEvent(v, zone, v.UID.value);
    const lines = recurrenceLines(v, ev.allDay, zone);
    if (lines.length) ev.resource.recurrence = lines;
    masters[v.UID.value] = ev;
    out.push(ev);
  });
  usable.forEach(function (v) { // one occurrence of a repeating meeting that was moved, edited or cancelled
    const rid = v['RECURRENCE-ID'];
    if (!rid) return;
    const master = masters[v.UID.value];
    if (master && master.resource.recurrence) master.resource.recurrence.push(dateLine('EXDATE', rid, master.allDay, zone));
    if (!cancelled(v)) out.push(toEvent(v, zone, v.UID.value + '|' + rid.value));
  });

  out.forEach(function (ev) {
    ev.sig = digest_(JSON.stringify(ev.resource));
    ev.resource.extendedProperties = { private: { weftdayTeams: '1', key: ev.key, sig: ev.sig } };
  });
  return out;
}

const cancelled = function (v) { return !!v.STATUS && v.STATUS.value.toUpperCase() === 'CANCELLED'; };

function toEvent(v, zone, keySource) {
  const start = toTime(v.DTSTART, zone), allDay = !!start.date;
  let end = v.DTEND ? toTime(v.DTEND, zone) : null;
  if (!end) end = allDay ? { date: shiftDate(start.date, 1) } : { dateTime: addDuration(start.dateTime, v.DURATION && v.DURATION.value), timeZone: start.timeZone };

  let description = unescapeText(v.DESCRIPTION && v.DESCRIPTION.value).trim();
  const link = [v['X-MICROSOFT-SKYPETEAMSMEETINGURL'], v['X-MICROSOFT-ONLINEMEETINGCONFLINK']]
    .map(function (p) { return p ? unescapeText(p.value).trim() : ''; })
    .filter(function (u) { return /^https:\/\//.test(u); })[0];
  if (link && description.indexOf(link) < 0) description = 'Join: ' + link + (description ? '\n\n' + description : '');

  const resource = {
    summary: unescapeText(v.SUMMARY && v.SUMMARY.value).trim() || '(No title)',
    location: unescapeText(v.LOCATION && v.LOCATION.value).trim(),
    description: description.slice(0, 6000),
    start: start, end: end,
  };
  const busy = v['X-MICROSOFT-CDO-BUSYSTATUS'] && v['X-MICROSOFT-CDO-BUSYSTATUS'].value.toUpperCase();
  if (busy === 'FREE' || (v.TRANSP && v.TRANSP.value.toUpperCase() === 'TRANSPARENT')) resource.transparency = 'transparent';
  if (v.CLASS && /^(PRIVATE|CONFIDENTIAL)$/i.test(v.CLASS.value)) resource.visibility = 'private';
  return { key: digest_(keySource), allDay: allDay, resource: resource };
}

// "20261118T100000" (+ zone) -> what Google expects
function toTime(prop, zone) {
  const val = prop.value.trim();
  if (prop.params.VALUE === 'DATE' || /^\d{8}$/.test(val)) return { date: val.slice(0, 4) + '-' + val.slice(4, 6) + '-' + val.slice(6, 8) };
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z?)$/.exec(val);
  if (!m) throw new Error('Unreadable date: ' + val);
  const local = m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + (m[6] || '00');
  return m[7] ? { dateTime: local + 'Z', timeZone: 'UTC' } : { dateTime: local, timeZone: toIana(prop.params.TZID) || zone };
}

function shiftDate(ymd, days) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Adds a length such as "PT1H30M" to a clock time. With no length, the meeting ends when it starts.
function addDuration(dateTime, duration) {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(duration || '');
  if (!m) return dateTime;
  const secs = (+m[1] || 0) * 604800 + (+m[2] || 0) * 86400 + (+m[3] || 0) * 3600 + (+m[4] || 0) * 60 + (+m[5] || 0);
  const utc = /Z$/.test(dateTime), d = new Date(dateTime.replace(/Z$/, '') + 'Z');
  d.setUTCSeconds(d.getUTCSeconds() + secs);
  return d.toISOString().slice(0, 19) + (utc ? 'Z' : '');
}

function recurrenceLines(v, allDay, zone) {
  const lines = [];
  (v.all.RRULE || []).forEach(function (r) { lines.push('RRULE:' + fixUntil(r.value.trim(), allDay)); });
  ['EXDATE', 'RDATE'].forEach(function (name) {
    (v.all[name] || []).forEach(function (p) { lines.push(dateLine(name, p, allDay, zone)); });
  });
  return lines;
}

// Google wants the "repeat until" date as a plain date for all-day events, and as UTC otherwise.
function fixUntil(rule, allDay) {
  return rule.replace(/UNTIL=(\d{8})(T\d{6}Z?)?/i, function (_, day, time) {
    if (allDay) return 'UNTIL=' + day;
    if (!time) return 'UNTIL=' + day + 'T235959Z';
    return 'UNTIL=' + day + (/Z$/i.test(time) ? time : time + 'Z');
  });
}

// One "skip these dates" (or "also these dates") line in the form Google accepts.
function dateLine(name, prop, allDay, zone) {
  const values = prop.value.split(',').map(function (s) { return s.trim(); }).filter(String);
  if (allDay || prop.params.VALUE === 'DATE') return name + ';VALUE=DATE:' + values.map(function (s) { return s.slice(0, 8); }).join(',');
  if (/Z$/.test(values[0])) return name + ':' + values.join(',');
  return name + ';TZID=' + (toIana(prop.params.TZID) || zone) + ':' + values.join(',');
}

const unescapeText = function (s) {
  return (s || '').replace(/\\([nN,;\\])/g, function (_, c) { return c === 'n' || c === 'N' ? '\n' : c; });
};

// Splits the calendar text into meetings. Each meeting is { NAME: { params, value }, all: { NAME: [..] } }.
function parseIcs(text) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const cal = { zone: '', events: [] };
  let cur = null, skip = 0;
  lines.forEach(function (line) {
    if (!line) return;
    const colon = splitAtColon(line);
    if (colon < 0) return;
    const head = line.slice(0, colon).split(';'), value = line.slice(colon + 1), name = head[0].toUpperCase();
    if (name === 'BEGIN' && value.toUpperCase() === 'VEVENT') { cur = { all: {} }; return; }
    if (name === 'END' && value.toUpperCase() === 'VEVENT') { if (cur) cal.events.push(cur); cur = null; return; }
    if (cur && name === 'BEGIN') { skip++; return; } // reminders and other parts inside a meeting are not needed
    if (cur && name === 'END') { skip = Math.max(0, skip - 1); return; }
    if (!cur) { if (name === 'X-WR-TIMEZONE') cal.zone = value.trim(); return; }
    if (skip) return;
    const params = {};
    head.slice(1).forEach(function (p) {
      const eq = p.indexOf('=');
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
    });
    const prop = { params: params, value: value };
    if (!cur[name]) cur[name] = prop;
    (cur.all[name] = cur.all[name] || []).push(prop);
  });
  return cal;
}

// Position of the ":" that ends the property name (a ":" inside quotes does not count).
function splitAtColon(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) return i;
  }
  return -1;
}

// Outlook names time zones the Windows way. Google needs the standard names.
const WINDOWS_ZONES = {
  'Dateline Standard Time': 'Etc/GMT+12', 'UTC-11': 'Etc/GMT+11', 'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage', 'Pacific Standard Time': 'America/Los_Angeles',
  'Mountain Standard Time': 'America/Denver', 'US Mountain Standard Time': 'America/Phoenix',
  'Central Standard Time': 'America/Chicago', 'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Canada Central Standard Time': 'America/Regina', 'Central America Standard Time': 'America/Guatemala',
  'Eastern Standard Time': 'America/New_York', 'SA Pacific Standard Time': 'America/Bogota',
  'Venezuela Standard Time': 'America/Caracas', 'Atlantic Standard Time': 'America/Halifax',
  'Pacific SA Standard Time': 'America/Santiago', 'Newfoundland Standard Time': 'America/St_Johns',
  'E. South America Standard Time': 'America/Sao_Paulo', 'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  'UTC': 'UTC', 'Coordinated Universal Time': 'UTC', 'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik', 'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest', 'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw', 'W. Central Africa Standard Time': 'Africa/Lagos',
  'GTB Standard Time': 'Europe/Bucharest', 'E. Europe Standard Time': 'Europe/Chisinau', 'FLE Standard Time': 'Europe/Kiev',
  'Egypt Standard Time': 'Africa/Cairo', 'South Africa Standard Time': 'Africa/Johannesburg',
  'Israel Standard Time': 'Asia/Jerusalem', 'Turkey Standard Time': 'Europe/Istanbul', 'Arab Standard Time': 'Asia/Riyadh',
  'Arabic Standard Time': 'Asia/Baghdad', 'Russian Standard Time': 'Europe/Moscow', 'E. Africa Standard Time': 'Africa/Nairobi',
  'Iran Standard Time': 'Asia/Tehran', 'Arabian Standard Time': 'Asia/Dubai', 'Azerbaijan Standard Time': 'Asia/Baku',
  'Afghanistan Standard Time': 'Asia/Kabul', 'Pakistan Standard Time': 'Asia/Karachi', 'West Asia Standard Time': 'Asia/Tashkent',
  'India Standard Time': 'Asia/Kolkata', 'Sri Lanka Standard Time': 'Asia/Colombo', 'Nepal Standard Time': 'Asia/Kathmandu',
  'Bangladesh Standard Time': 'Asia/Dhaka', 'Central Asia Standard Time': 'Asia/Almaty', 'Myanmar Standard Time': 'Asia/Yangon',
  'SE Asia Standard Time': 'Asia/Bangkok', 'China Standard Time': 'Asia/Shanghai', 'Singapore Standard Time': 'Asia/Singapore',
  'W. Australia Standard Time': 'Australia/Perth', 'Taipei Standard Time': 'Asia/Taipei', 'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul', 'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Central Standard Time': 'Australia/Darwin', 'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Eastern Standard Time': 'Australia/Sydney', 'Tasmania Standard Time': 'Australia/Hobart',
  'New Zealand Standard Time': 'Pacific/Auckland', 'Fiji Standard Time': 'Pacific/Fiji',
};
function toIana(name) {
  if (!name) return '';
  name = name.trim();
  if (WINDOWS_ZONES[name]) return WINDOWS_ZONES[name];
  if (/^[A-Za-z_]+\/[A-Za-z_\/+-]+$/.test(name)) return name; // already a standard name such as Asia/Kolkata
  return '';
}
