// Checks the Teams -> Google helper (public/helpers/teams-to-google.gs) with a pretend Outlook calendar
// and a pretend Google. Run:  node test/teams-helper.test.mjs
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const untouched = readFileSync(path.join(here, '..', 'public', 'helpers', 'teams-to-google.gs'), 'utf8');
const source = untouched.replace("'PASTE YOUR OUTLOOK CALENDAR LINK HERE'", "'https://outlook.example/calendar.ics'");
assert.notEqual(source, untouched);

// ---- pretend Google
let feed = '', feedCode = 200, seq = 0;
const store = new Map(); // event id -> event
const ops = { list: 0, insert: 0, update: 0, remove: 0, fetch: 0 };
const props = new Map();
const triggers = [];
const g = {
  console: { log() {}, warn(m) { warnings.push(m); } },
  UrlFetchApp: { fetch() { ops.fetch++; return { getResponseCode: () => feedCode, getContentText: () => feed }; } },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v), deleteProperty: k => props.delete(k) }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  Session: { getScriptTimeZone: () => 'Asia/Kolkata' },
  Utilities: {
    DigestAlgorithm: { MD5: 'md5' }, Charset: { UTF_8: 'utf8' },
    computeDigest: (_, text) => [...createHash('md5').update(text, 'utf8').digest()].map(b => (b > 127 ? b - 256 : b)),
  },
  CalendarApp: {
    getCalendarById: id => (id === 'teams-cal' ? { getId: () => id } : null),
    getOwnedCalendarsByName: () => [],
    createCalendar: () => ({ getId: () => 'teams-cal' }),
  },
  ScriptApp: {
    getProjectTriggers: () => triggers.map(t => ({ getHandlerFunction: () => t.fn, _t: t })),
    deleteTrigger: t => triggers.splice(triggers.indexOf(t._t), 1),
    newTrigger: fn => ({ timeBased: () => ({ everyMinutes: n => ({ create: () => triggers.push({ fn, n }) }) }) }),
  },
  Calendar: { Events: {
    list() { ops.list++; return { items: [...store.values()] }; },
    insert(res) { ops.insert++; if (res.summary === 'REJECT ME') throw new Error('pretend Google refused'); const id = 'g' + ++seq; store.set(id, { ...structuredClone(res), id }); },
    update(res, _cal, id) { ops.update++; store.set(id, { ...structuredClone(res), id }); },
    remove(_cal, id) { ops.remove++; store.delete(id); },
  } },
};
const warnings = [];
vm.createContext(g);
vm.runInContext(source, g, { filename: 'teams-to-google.gs' });
const resetOps = () => { for (const k of Object.keys(ops)) ops[k] = 0; };
const byTitle = t => [...store.values()].find(e => e.summary === t);
const plain = v => JSON.parse(JSON.stringify(v));

// ---- a pretend Outlook calendar, in the shape Outlook publishes
const ics = events => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:Microsoft Exchange Server 2010', 'X-WR-CALNAME:Calendar',
  'BEGIN:VTIMEZONE', 'TZID:India Standard Time', 'BEGIN:STANDARD', 'DTSTART:16010101T000000', 'TZOFFSETFROM:+0530', 'TZOFFSETTO:+0530', 'END:STANDARD', 'END:VTIMEZONE',
  ...events.flat(), 'END:VCALENDAR'].join('\r\n');
const stamp = n => `DTSTAMP:20260101T0${n}0000Z`;
const standup = (extra = []) => ['BEGIN:VEVENT', 'UID:040000008200E00074C5B7101A82E008-STANDUP', stamp(1),
  'SUMMARY:Daily stand-up', 'DTSTART;TZID=India Standard Time:20991116T100000', 'DTEND;TZID=India Standard Time:20991116T101500',
  'RRULE:FREQ=WEEKLY;UNTIL=21000331T043000Z;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR;WKST=MO',
  'EXDATE;TZID=India Standard Time:20991119T100000', 'LOCATION:Microsoft Teams Meeting',
  'X-MICROSOFT-SKYPETEAMSMEETINGURL:https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=x',
  'X-MICROSOFT-CDO-BUSYSTATUS:BUSY', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:REMINDER', 'TRIGGER;RELATED=START:-PT15M', 'END:VALARM',
  ...extra, 'END:VEVENT'];
const moved = ['BEGIN:VEVENT', 'UID:040000008200E00074C5B7101A82E008-STANDUP', 'RECURRENCE-ID;TZID=India Standard Time:20991120T100000', stamp(1),
  'SUMMARY:Daily stand-up (moved)', 'DTSTART;TZID=India Standard Time:20991120T150000', 'DTEND;TZID=India Standard Time:20991120T151500', 'END:VEVENT'];
const dropped = ['BEGIN:VEVENT', 'UID:040000008200E00074C5B7101A82E008-STANDUP', 'RECURRENCE-ID;TZID=India Standard Time:20991123T100000', stamp(1),
  'SUMMARY:Canceled: Daily stand-up', 'STATUS:CANCELLED', 'DTSTART;TZID=India Standard Time:20991123T100000', 'DTEND;TZID=India Standard Time:20991123T101500', 'END:VEVENT'];
const review = (title = 'Design review\\, round 2', when = '20991201T140000') => ['BEGIN:VEVENT', 'UID:REVIEW-1', stamp(1), `SUMMARY:${title}`,
  `DTSTART;TZID="India Standard Time":${when}`, `DTEND;TZID="India Standard Time":${when.slice(0, 9)}150000`,
  'DESCRIPTION:Agenda:\\n1. Colours\\; fonts\\n2. A very long line that Outlook folds across two lines of the file so tha',
  ' t it never passes seventy-five characters', 'CLASS:PRIVATE', 'END:VEVENT'];
const offsite = ['BEGIN:VEVENT', 'UID:OFFSITE-1', stamp(1), 'SUMMARY:Team offsite', 'DTSTART;VALUE=DATE:20991210', 'DTEND;VALUE=DATE:20991212',
  'X-MICROSOFT-CDO-BUSYSTATUS:FREE', 'END:VEVENT'];
const holiday = ['BEGIN:VEVENT', 'UID:HOLIDAY-1', stamp(1), 'SUMMARY:Founders day', 'DTSTART;VALUE=DATE:20260105', 'DTEND;VALUE=DATE:20260106',
  'RRULE:FREQ=YEARLY;UNTIL=20300105T000000Z', 'EXDATE;TZID=India Standard Time:20280105T000000', 'END:VEVENT'];
const utcCall = ['BEGIN:VEVENT', 'UID:UTC-1', stamp(1), 'SUMMARY:Investor call', 'DTSTART:20991205T093000Z', 'DURATION:PT1H30M', 'END:VEVENT'];
const scrapped = ['BEGIN:VEVENT', 'UID:GONE-1', stamp(1), 'SUMMARY:Cancelled meeting', 'STATUS:CANCELLED', 'DTSTART:20991206T093000Z', 'DTEND:20991206T100000Z', 'END:VEVENT'];
const oldOne = ['BEGIN:VEVENT', 'UID:OLD-1', stamp(1), 'SUMMARY:Last year kickoff', 'DTSTART:20250106T093000Z', 'DTEND:20250106T100000Z', 'END:VEVENT'];
const all = [standup(), moved, dropped, review(), offsite, holiday, utcCall, scrapped, oldOne];

// ---- 0. installed before the Outlook link is pasted in: the calendar is made and it waits quietly
const waiting = vm.createContext({ ...g });
vm.runInContext(untouched, waiting, { filename: 'teams-to-google.gs' });
waiting.install();
assert.equal(ops.fetch, 0, 'nothing is read while there is no link');
assert.equal(props.get('calendarId'), 'teams-cal', 'the Teams calendar exists already');
assert.equal(triggers.length, 1);
waiting.sync();
assert.equal(store.size, 0);
props.clear(); triggers.length = 0; resetOps();

// ---- 1. first run
feed = ics(all);
g.install();
assert.deepEqual(triggers, [{ fn: 'sync', n: 15 }], 'checks every 15 minutes');
assert.equal(store.size, 7, 'seven meetings copied (cancelled ones left out)');

const s = byTitle('Daily stand-up');
assert.deepEqual(plain(s.start), { dateTime: '2099-11-16T10:00:00', timeZone: 'Asia/Kolkata' });
assert.deepEqual(plain(s.end), { dateTime: '2099-11-16T10:15:00', timeZone: 'Asia/Kolkata' });
assert.deepEqual(plain(s.recurrence), [
  'RRULE:FREQ=WEEKLY;UNTIL=21000331T043000Z;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR;WKST=MO',
  'EXDATE;TZID=Asia/Kolkata:20991119T100000',  // skipped by the organiser
  'EXDATE;TZID=Asia/Kolkata:20991120T100000',  // moved: shown as its own entry instead
  'EXDATE;TZID=Asia/Kolkata:20991123T100000',  // one day cancelled
]);
assert.match(s.description, /^Join: https:\/\/teams\.microsoft\.com\/l\/meetup-join\//, 'join link is in the notes');
assert.equal(s.location, 'Microsoft Teams Meeting');
assert.equal(s.extendedProperties.private.weftdayTeams, '1');

const m = byTitle('Daily stand-up (moved)');
assert.deepEqual(plain(m.start), { dateTime: '2099-11-20T15:00:00', timeZone: 'Asia/Kolkata' });
assert.equal(m.recurrence, undefined);
assert.equal(byTitle('Canceled: Daily stand-up'), undefined);
assert.equal(byTitle('Cancelled meeting'), undefined);

const r = byTitle('Design review, round 2');
assert.ok(r, 'escaped comma in a title is read correctly');
assert.equal(r.description, 'Agenda:\n1. Colours; fonts\n2. A very long line that Outlook folds across two lines of the file so that it never passes seventy-five characters');
assert.equal(r.visibility, 'private');
assert.deepEqual(plain(r.start), { dateTime: '2099-12-01T14:00:00', timeZone: 'Asia/Kolkata' });

const o = byTitle('Team offsite');
assert.deepEqual(plain([o.start, o.end]), [{ date: '2099-12-10' }, { date: '2099-12-12' }]);
assert.equal(o.transparency, 'transparent');

const h = byTitle('Founders day');
assert.deepEqual(plain(h.recurrence), ['RRULE:FREQ=YEARLY;UNTIL=20300105', 'EXDATE;VALUE=DATE:20280105']);

const u = byTitle('Investor call');
assert.deepEqual(plain([u.start, u.end]), [{ dateTime: '2099-12-05T09:30:00Z', timeZone: 'UTC' }, { dateTime: '2099-12-05T11:00:00Z', timeZone: 'UTC' }]);

// ---- 2. nothing changed (only Outlook's time stamps): no work at all
resetOps();
feed = ics(all).replace(/DTSTAMP:20260101T010000Z/g, 'DTSTAMP:20260101T020000Z');
g.sync();
assert.deepEqual(ops, { list: 0, insert: 0, update: 0, remove: 0, fetch: 1 }, 'an unchanged calendar costs one read and nothing else');

// ---- 3. one meeting renamed and moved, one new, one removed, one old meeting dropped out of the feed
resetOps();
const extra = ['BEGIN:VEVENT', 'UID:NEW-1', stamp(3), 'SUMMARY:Hiring sync', 'DTSTART;TZID=Pacific Standard Time:20991203T090000', 'DTEND;TZID=Pacific Standard Time:20991203T093000', 'END:VEVENT'];
feed = ics([standup(), moved, dropped, review('Design review (final)', '20991202T140000'), holiday, utcCall, scrapped, extra]);
g.sync();
assert.deepEqual(ops, { list: 1, insert: 1, update: 1, remove: 1, fetch: 1 }, 'one added, one updated, one removed');
assert.equal(byTitle('Design review, round 2'), undefined);
assert.deepEqual(plain(byTitle('Design review (final)').start), { dateTime: '2099-12-02T14:00:00', timeZone: 'Asia/Kolkata' });
assert.equal(byTitle('Team offsite'), undefined, 'a future meeting removed in Teams is removed here');
assert.ok(byTitle('Last year kickoff'), 'a past meeting that drops out of the feed is kept');
assert.deepEqual(plain(byTitle('Hiring sync').start), { dateTime: '2099-12-03T09:00:00', timeZone: 'America/Los_Angeles' });
assert.equal(store.size, 7);

// ---- 4. the whole repeating meeting is cancelled
resetOps();
feed = ics([review('Design review (final)', '20991202T140000'), holiday, utcCall, extra]);
g.sync();
assert.equal(byTitle('Daily stand-up'), undefined);
assert.equal(byTitle('Daily stand-up (moved)'), undefined, 'the moved day goes too (it is in the future)');
assert.equal(ops.remove, 2);

// ---- 5. Google refuses one meeting: the rest still go through, and it is tried again next time
resetOps();
const bad = ['BEGIN:VEVENT', 'UID:BAD-1', stamp(1), 'SUMMARY:REJECT ME', 'DTSTART:20991207T093000Z', 'DTEND:20991207T100000Z', 'END:VEVENT'];
const fine = ['BEGIN:VEVENT', 'UID:FINE-1', stamp(1), 'SUMMARY:Still copied', 'DTSTART:20991208T093000Z', 'DTEND:20991208T100000Z', 'END:VEVENT'];
feed = ics([review('Design review (final)', '20991202T140000'), holiday, utcCall, extra, bad, fine]);
g.sync();
assert.ok(byTitle('Still copied'));
assert.equal(warnings.length, 1);
resetOps();
g.sync();
assert.equal(ops.insert, 1, 'the refused meeting is tried again on the next check');

// ---- 6. a broken link or a non-calendar reply is reported and nothing is deleted
const before = store.size;
feedCode = 404;
assert.throws(() => g.sync(), /Could not read the Outlook calendar link/);
feedCode = 200; feed = '<html>Sign in</html>';
assert.throws(() => g.sync(), /did not return a calendar/);
assert.equal(store.size, before);

// ---- 7. stopping
g.uninstall();
assert.equal(triggers.length, 0);

console.log('All Teams helper checks passed.');
