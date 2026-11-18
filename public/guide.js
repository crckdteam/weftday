// The guide's pages: which step is showing, the dots, and the arrow keys.
const ico = d => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const SPARK = '<path d="M11 3.500l1.900 5.100L18 10.500l-5.100 1.900L11 17.500l-1.900-5.100L4 10.500l5.100-1.900z"/>';
const STEPS = [
  { name: 'Connect', title: 'Bring your calendars together',
    say: 'Press <b>+ Connect Google account</b> once for each account you use. Work, personal, a side project: they all show in one view, each in its own colour.',
    tip: 'The very first time, Weftday needs your own Google keys. Settings → Advanced walks you through it, or scan a setup link from a device that is already set up.',
    art: `<div class="wf"><span class="lbl">Calendars</span>
      <div class="row"><i class="dotc"></i><b>work@company.com</b><span class="sp"></span><span class="chip ok">Connected</span></div>
      <div class="row"><i class="dotc" style="background:var(--c2)"></i><b>me@gmail.com</b><span class="sp"></span><span class="chip ok">Connected</span></div>
      <div class="row"><i class="dotc" style="background:var(--c3)"></i><b>side@project.io</b><span class="sp"></span><span class="chip ok">Connected</span></div>
      <span class="mini go" style="justify-content:center;height:34px">+ Connect Google account</span></div>` },
  { name: 'Your week', title: 'See everything in one place',
    say: 'Switch between <b>Day, Week, Month and List</b>. Tick a calendar off in the side panel to hide it. Drag the edge of the side panel to make it wider.',
    tip: 'Shortcuts: <kbd>T</kbd> today, <kbd>D</kbd> <kbd>W</kbd> <kbd>M</kbd> <kbd>L</kbd> for the views, <kbd>/</kbd> to search tasks, meetings, people and companies.',
    art: `<div class="wf"><div class="row"><span class="bar ink" style="width:96px"></span><span class="sp"></span><span class="mini">Day</span><span class="mini go">Week</span><span class="mini">Month</span></div>
      <div class="grid5"><div><span class="ev" style="--c:var(--c1);top:14px;height:30px">Stand-up</span><span class="ev" style="--c:var(--c3);top:96px;height:34px">Dentist</span></div>
        <div><span class="ev" style="--c:var(--c4);top:38px;height:46px">Pricing call</span><span class="ev" style="--c:var(--c2);top:104px;height:34px">Dinner</span></div>
        <div><span class="ev" style="--c:var(--c2);top:20px;height:28px">School run</span><span class="ev" style="--c:var(--c1);top:62px;height:52px">Design review</span></div>
        <div><span class="ev" style="--c:var(--c1);top:14px;height:30px">Stand-up</span><span class="ev" style="--c:var(--c3);top:78px;height:44px">Flight</span></div>
        <div><span class="ev" style="--c:var(--c4);top:44px;height:40px">Intro</span></div></div></div>` },
  { name: 'Add a task', title: 'Add a task in one line',
    say: 'Type it the way you would say it: <b>gym tomorrow 7am 1h</b>. Weftday reads the day, the time, the length and repeats like <b>except Sundays</b>. For a whole sentence with several things in it, press <b>✦</b> and AI splits it into tasks.',
    tip: 'You always see what was understood before it is added, and every add has an Undo.',
    art: `<div class="wf"><div class="box"><span>gym 7:30pm except sundays</span><i>✦</i></div>
      <div class="row" style="flex-wrap:wrap;gap:5px"><span class="chip">Tomorrow</span><span class="chip">7:30pm</span><span class="chip">every day except Sun</span></div>
      <span class="lbl" style="margin-top:4px">Or say several at once</span>
      <div class="note"><p class="mut">“call the bank tomorrow morning, then send the proposal on Friday”</p></div>
      <div class="tpill">Call the bank <span class="sp"></span><span class="mut" style="font-weight:500">Tomorrow · 9am</span></div>
      <div class="tpill">Send the proposal <span class="sp"></span><span class="mut" style="font-weight:500">Fri · 3pm</span></div></div>` },
  { name: 'Plan', title: 'Give every task a time',
    say: 'A task with no day waits in your <b>Inbox</b>. Drag it onto the calendar, press <b>→ Today</b>, or open <b>Plan my day</b> and let Weftday fit your tasks around your meetings.',
    tip: 'On the calendar: click an empty time to add a task there, drag a task to move it, and drag its bottom edge to make it longer.',
    art: `<div class="wf"><div class="row" style="align-items:stretch;gap:12px"><div style="flex:0 0 42%;display:grid;gap:7px;align-content:start"><span class="lbl">Inbox</span>
        <div class="tpill">Send pricing</div><div class="tpill">Book flights</div><div class="tpill" style="opacity:.45">Read contract</div></div>
      <div class="grid5" style="flex:1;grid-template-columns:repeat(2,1fr);height:164px"><div><span class="ev" style="--c:var(--c1);top:12px;height:34px">Stand-up</span><span class="slot" style="top:58px;height:38px"></span><span class="ev" style="--c:var(--c4);top:108px;height:40px">Call</span></div>
        <div><span class="ev t" style="top:30px;height:34px">Read contract</span><span class="ev" style="--c:var(--c2);top:92px;height:44px">Lunch</span></div></div></div></div>` },
  { name: 'Prepare', title: 'Walk into every meeting prepared',
    say: '<b>Prepare</b> lays out today’s meetings: who is coming, what you talked about last time, what is still open, and one thing worth asking. <b>Brief me</b> does the same for a single meeting.',
    tip: 'Ten minutes before a meeting, the reminder carries a Brief me button, so the brief is one press away.',
    art: `<div class="wf"><div class="row"><span class="mut" style="font-size:12px">7:00 – 7:45pm</span><span class="chip">in 25 min</span><span class="sp"></span><span class="mini go">Join</span></div>
      <b style="font-size:15px">Acme · pricing call</b>
      <div class="row"><span class="ava">JD</span><div><b>Jane Doe</b><p class="mut">VP Operations · Acme</p></div></div>
      <div class="lines"><span class="lbl">Last time</span><p>Liked the demo. Wants pricing for 50 seats.</p>
        <span class="lbl">Still open</span><p>Send pricing <span class="mut">· 9 days ago</span></p>
        <span class="lbl">Worth asking</span><p>How the March pilot fits their peak season.</p></div>
      <div class="row"><span class="mini">Brief me</span></div></div>` },
  { name: 'People', title: 'Know who you are meeting',
    say: '<b>Get facts</b> looks a guest up on the web and fills in their profile: role, background, their company, its funding and team, and a photo. <b>People</b> lists everyone you meet, and every company gets its own page.',
    tip: 'This uses a key of your own. Google AI with a Tavily search key is free and takes about three minutes to set up in Settings → AI.',
    art: `<div class="wf"><div class="row"><span class="ava" style="width:44px;height:44px;font-size:15px">JD</span><div><b style="font-size:15px">Jane Doe</b><p>VP Operations at Acme</p><p class="mut">Berlin</p></div></div>
      <div class="note"><span class="lbl">Background</span><p>Fifteen years in logistics. Led the Hamburg hub.</p>
        <span class="lbl" style="margin-top:5px">Acme</span><p>Delivery robots for warehouses. About 120 people. Series B, $40M.</p>
        <div class="row" style="gap:5px;margin-top:4px"><span class="chip plain">DHL</span><span class="chip plain">Zalando</span><span class="chip plain">robotics</span></div></div>
      <div class="row"><span class="mini">LinkedIn</span><span class="mini">Acme</span><span class="mini">Ask AI</span></div></div>` },
  { name: 'Notes', title: 'Notes that turn into action',
    say: 'Write private notes on any meeting; guests never see them. <b>Tidy my notes</b> turns them into a summary, decisions and action points, with your AI key, or on your own device where the browser has its own AI. Then <b>Make tasks</b>, or open a <b>Follow-up email</b> draft in Gmail.',
    tip: 'After a meeting with outside guests, Weftday asks once how it went, so the notes actually get written.',
    art: `<div class="wf"><span class="lbl">Your notes · only you can see these</span>
      <div class="note"><b>Summary</b><p class="mut">Jane accepted the price. Legal still has to check the contract.</p>
        <b style="margin-top:5px">Action points</b><p>– Get legal to check the contract by Friday</p><p>– Book the demo</p></div>
      <div class="row" style="flex-wrap:wrap;gap:6px"><span class="mini">Tidy my notes</span><span class="mini go">Make 2 tasks</span><span class="mini">Follow-up email</span></div></div>` },
  { name: 'Record', title: 'Let the meeting write its own notes',
    say: 'Press <b>Record</b> on a meeting. Weftday listens (no bot joins the call) while you jot a few words. When it ends, the notes are written for you: a summary, decisions, what you owe and what others owe you, with who said what.',
    tip: 'Ask any recording a question, or ask all your meetings at once. Record can also keep a video of your screen, with your camera in a corner, and screenshots.',
    art: `<div class="wf"><div class="screenblock">
        <span class="bar" style="position:absolute;left:14px;top:16px;width:40%;opacity:.5"></span><span class="bar" style="position:absolute;left:14px;top:32px;width:62%;opacity:.3"></span><span class="bar" style="position:absolute;left:14px;top:48px;width:50%;opacity:.3"></span>
        <span class="ava" style="position:absolute;right:12px;bottom:12px;width:46px;height:46px;font-size:13px;box-shadow:0 0 0 2px #fff">You</span></div>
      <div class="row"><i class="dotc" style="background:var(--now);border-radius:50%"></i><b>12:48</b><span class="sp"></span><span class="mini">Pause</span><span class="mini go">Stop</span></div>
      <div class="row" style="flex-wrap:wrap;gap:5px"><span class="chip ok">Stays in your browser</span><span class="chip">Make notes</span><span class="chip plain">Screenshot</span></div></div>` },
  { name: 'Free times', title: 'Share when you are free',
    say: '<b>Free times</b> writes out your open slots across every calendar, ready to paste into an email, in any time zone you pick. The <b>globe</b> in the top bar shows a second time zone next to your own on the calendar.',
    tip: 'When you write for another zone, Weftday keeps only their daytime, so you never offer someone 4am.',
    art: `<div class="wf"><div class="row"><span class="mut" style="font-size:12.5px">Written in</span><span class="sp"></span><span class="mini">Central Europe (CET)</span></div>
      <div class="note"><p>Here are some times that work for me (CET):</p><p>• Wed 18 Nov: 8am – 10:30am, 11:30am – 1:30pm</p><p>• Thu 19 Nov: 8am – 1:30pm</p><p>• Fri 20 Nov: 8am – 1:30pm</p></div>
      <div class="row"><span class="sp"></span><span class="mini go">Copy</span></div></div>` },
  { name: 'Devices', title: 'Take it everywhere',
    say: 'Open <b>Set up a device</b> and scan the square with your phone. Your accounts and keys follow you, locked inside your own Google account. Add Weftday to your home screen and it opens like an app.',
    tip: 'Tasks are kept in a calendar called “Weftday” in your Google account, so your phone’s own calendar can remind you even when Weftday is closed.',
    art: `<div class="wf"><div class="row" style="justify-content:center;gap:26px"><div class="qr"></div>
      <div class="phone"><span class="bar ink w60"></span><span class="tpill" style="font-size:9.5px;padding:4px 6px">Gym</span><span class="ev" style="--c:var(--c1);position:static;display:block;height:26px">Stand-up</span><span class="ev" style="--c:var(--c4);position:static;display:block;height:34px">Call</span></div></div>
      <p class="mut" style="text-align:center">Scan once. No Google login on the new device.</p></div>` },
  { name: 'Private', title: 'Yours alone',
    say: 'There is <b>no Weftday server</b>. Your browser talks to Google directly, the AI features use keys that belong to you, and you can host the whole app yourself. <b>Settings</b> holds every choice in six short sections.',
    tip: 'That is the whole tour. Open Weftday and try it, or use the demo to play with sample data first.',
    art: `<div class="wf"><div class="flow"><div class="node">${ico('<rect x="3.500" y="5" width="17" height="12" rx="2.500"/><path d="M8 20.500h8"/>')}Your browser</div>
        <div class="wire"><i></i>direct</div><div class="node">${ico('<rect x="3.500" y="5" width="17" height="15" rx="3"/><path d="M3.500 10h17M8 3v4M16 3v4"/>')}Your Google account</div></div>
      <p class="no">a server in the middle</p>
      <div class="row" style="justify-content:center;flex-wrap:wrap;gap:6px"><span class="chip ok">Your own keys</span><span class="chip ok">Self-hostable</span><span class="chip ok">No tracking</span></div></div>` },
];

// Five things are enough to start. The rest explains itself in the app, where you meet it.
const FIRST_FIVE = ['Connect', 'Record', 'Notes', 'Add a task', 'Private'];
STEPS.splice(0, STEPS.length, ...FIRST_FIVE.map(name => STEPS.find(s => s.name === name)).filter(Boolean));

const $ = id => document.getElementById(id);
let at = Math.min(Math.max((parseInt(location.hash.slice(1), 10) || 1) - 1, 0), STEPS.length - 1);
$('rail').innerHTML = STEPS.map((s, i) => `<button type="button" data-i="${i}"><i>${i + 1}</i><span>${s.name}</span></button>`).join('');
function show(i, quiet) {
  at = Math.min(Math.max(i, 0), STEPS.length - 1);
  const s = STEPS[at], last = at === STEPS.length - 1;
  $('count').textContent = `Step ${at + 1} of ${STEPS.length}`;
  $('title').textContent = s.title;
  $('say').innerHTML = s.say;
  $('tip').innerHTML = s.tip;
  $('art').innerHTML = s.art;
  $('back').disabled = at === 0;
  $('back').hidden = at === 0 || last;
  $('demo').hidden = !last;
  $('skip').hidden = last;
  $('next').textContent = last ? 'Open Weftday' : 'Next';
  $('bar').style.width = `${(at + 1) / STEPS.length * 100}%`;
  $('where').textContent = s.name;
  for (const b of $('rail').children) { const n = +b.dataset.i; b.className = n === at ? 'on' : n < at ? 'done' : ''; if (n === at) b.scrollIntoView({ block: 'nearest', inline: 'center' }); }
  if (!quiet) { history.replaceState(null, '', `#${at + 1}`); for (const el of [$('step'), $('art')]) { el.classList.remove('swap'); void el.offsetWidth; el.classList.add('swap'); } }
}
$('rail').onclick = e => { const b = e.target.closest('button'); if (b) show(+b.dataset.i); };
$('back').onclick = () => show(at - 1);
$('next').onclick = () => (at === STEPS.length - 1 ? location.assign('./') : show(at + 1));
addEventListener('keydown', e => { if (e.key === 'ArrowRight') show(at + 1); else if (e.key === 'ArrowLeft') show(at - 1); });
show(at, true);
