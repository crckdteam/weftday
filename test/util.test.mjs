// Checks the small pure helpers the whole app leans on: reading a task typed in plain words,
// repeating tasks, and making text safe to put on the page.  Run:  node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuick, repeatDays, repeatsOn, repeatLabel, firstRepeatDay, esc, ymd, fromYmd, addDays, startOfWeek, hhmm, parseHhmm, fmtDur } from '../public/util.js';

const NOW = new Date(2026, 10, 17, 10, 0); // Tuesday 17 November 2026, 10:00
const quick = text => parseQuick(text, NOW);

test('a plain task has a title and nothing else', () => {
  assert.deepEqual(quick('buy milk'), { title: 'buy milk', date: null, start: null, duration: null, tag: '', priority: 'normal', repeat: null });
});

test('day and time words are read and taken out of the title', () => {
  const t = quick('call the bank tomorrow 3pm');
  assert.equal(t.title, 'call the bank');
  assert.equal(t.date, '2026-11-18');
  assert.equal(t.start, 15 * 60);
});

test('a time without a colon is understood: "730 pm"', () => {
  const t = quick('gym 730 pm except sundays');
  assert.equal(t.title, 'gym');
  assert.equal(t.start, 19 * 60 + 30);
  assert.equal(t.repeat, 'd123456'); // every day but Sunday
});

test('chosen weekdays repeat on those days and start on the next one', () => {
  const t = quick('standup every mon wed fri 9am');
  assert.equal(t.repeat, 'd135');
  assert.equal(t.date, '2026-11-18'); // Wednesday: today is Tuesday
});

test('weekends, a date with a month name, next week, length and tag', () => {
  assert.equal(quick('read book weekends').repeat, 'd06');
  assert.equal(quick('pay rent 1 dec').date, '2026-12-01');
  const t = quick('review deck next week tue 2pm for 45m #work');
  assert.deepEqual([t.title, t.date, t.start, t.duration, t.tag], ['review deck', '2026-11-24', 14 * 60, 45, 'work']);
});

test('a daily task whose time has passed today starts tomorrow', () => {
  const t = quick('yoga daily 7am');
  assert.deepEqual([t.repeat, t.date, t.start], ['daily', '2026-11-18', 7 * 60]);
});

test('repeat helpers agree with each other', () => {
  assert.deepEqual(repeatDays('d135'), [1, 3, 5]);
  assert.equal(repeatDays('weekly'), null);
  assert.equal(repeatsOn('d123456', 0), false);
  assert.equal(repeatsOn('d123456', 6), true);
  assert.equal(repeatsOn('weekdays', 6), false);
  assert.equal(repeatsOn('weekly', 2, 2), true);
  assert.equal(repeatLabel('d123456'), 'every day except Sun');
  assert.equal(repeatLabel('d12345'), 'Mon – Fri');
  assert.equal(repeatLabel('d06'), 'weekends');
  assert.equal(firstRepeatDay('2026-11-17', 'd06'), '2026-11-21');
});

test('text is made safe before it is put on the page', () => {
  assert.equal(esc(`<img src=x onerror="alert('1')">&`), '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;');
  assert.equal(esc(null), '');
  assert.equal(esc(0), '0');
});

test('dates and clock times round-trip', () => {
  assert.equal(ymd(fromYmd('2026-03-01')), '2026-03-01');
  assert.equal(ymd(addDays(fromYmd('2026-02-28'), 1)), '2026-03-01');
  assert.equal(ymd(startOfWeek(NOW)), '2026-11-16'); // weeks start on Monday
  assert.equal(hhmm(parseHhmm('07:05')), '07:05');
  assert.equal(fmtDur(90), '1h 30m');
});

// ---- safety: text from an invite or an AI answer that turns into a link or a colour
import { VIDEO_RE, webLink, hue } from '../public/util.js';

test('a meeting link is only taken from the meeting service’s own site', () => {
  const find = text => text.match(VIDEO_RE)?.[0] || null;
  assert.equal(find('join https://us02web.zoom.us/j/8123?pwd=x now'), 'https://us02web.zoom.us/j/8123?pwd=x');
  assert.equal(find('https://meet.google.com/abc-defg-hij'), 'https://meet.google.com/abc-defg-hij');
  assert.equal(find('https://teams.microsoft.com/l/meetup-join/19%3ameeting'), 'https://teams.microsoft.com/l/meetup-join/19%3ameeting');
  assert.equal(find('https://acme.webex.com/meet/jo'), 'https://acme.webex.com/meet/jo');
  assert.equal(find('https://evil.example/login?next=zoom.us/j/123'), null); // a look-alike
  assert.equal(find('https://zoom.us.evil.com/j/1'), null);
  assert.equal(find('https://evilzoom.us/j/1'), null);
});

test('only real web addresses become links, only colour codes become colours', () => {
  assert.equal(webLink('https://calendar.google.com/x'), 'https://calendar.google.com/x');
  assert.equal(webLink('javascript:alert(1)'), '');
  assert.equal(webLink('data:text/html,x'), '');
  assert.equal(webLink(undefined), '');
  assert.equal(hue('#2f6fed'), '#2f6fed');
  assert.equal(hue('red;background:url(//evil.example)'), '#888');
  assert.equal(hue('#fff" onmouseover="x'), '#888');
});

test('a deadline word leaves no dangling “by”', () => {
  const t = quick('Send the contract by Friday');
  assert.deepEqual([t.title, t.date], ['Send the contract', '2026-11-20']);
  assert.equal(quick('Stand by for the call').title, 'Stand by for the call'); // no date was read: nothing is cut
});

test('a point ticked off in a note is not listed as still open', async () => {
  const { actionsIn, openActionsIn } = await import('../public/ai.js');
  const note = 'Summary\nFine.\n\nAction points\n- [ ] Send the plan\n- [x] Share the one-pager\n- [X] Call Ravi\n- Book the kickoff\n\nOpen questions\n- [ ] not an action';
  assert.deepEqual(actionsIn(note), ['Send the plan', 'Share the one-pager', 'Call Ravi', 'Book the kickoff']);
  assert.deepEqual(openActionsIn(note), ['Send the plan', 'Book the kickoff']);
});

test('a sentence the listening model wrote twice in a row is kept once', async () => {
  const { saidOnce } = await import('../public/facts.js');
  assert.equal(saidOnce('What if we keep the old price for six months? What if we keep the old price for six months? Zainab ran the numbers.'), 'What if we keep the old price for six months? Zainab ran the numbers.');
  assert.equal(saidOnce('Yes. Yes. Okay then.'), 'Yes. Yes. Okay then.', 'short echoes are how people talk and stay');
  assert.equal(saidOnce('2.41 crore to be exact. 2.41 crore to be exact. I will send the sheet'), '2.41 crore to be exact. I will send the sheet');
  assert.equal(saidOnce('One sentence only'), 'One sentence only');
  assert.equal(saidOnce(''), '');
});
