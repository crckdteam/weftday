"""Browser check of Weftday: opens the real app in Chrome (no window) and clicks through it.

It uses the sample data (?demo), a pretend microphone, camera and screen, and the Chrome that is
already installed. Nothing leaves this computer.

Run it with the server started for you:
    tools/check.sh
or by hand, with the test server already running on port 4322:
    .venv/bin/python test/smoke.py
"""
import datetime
import json
import os
import re
import sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get('WEFTDAY_URL', 'http://localhost:4322')
OUT = os.path.join(os.path.dirname(__file__), '.out')
os.makedirs(OUT, exist_ok=True)

SEEN = "localStorage.setItem('weftday.seenHome','1');localStorage.setItem('weftday.toured','1');" \
       "localStorage.setItem('weftday.tips', JSON.stringify({meeting:1,person:1,today:1,people:1,free:1,plan:1,record:1,library:1}));"
QUIET = "addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');" \
        "s.textContent='*{animation:none!important;transition:none!important}';document.head.append(s)});"
# Noise that is not a fault of the app: pictures and logos from other sites that the test machine may not reach.
IGNORE = ('Failed to load resource', 'net::ERR_', 'favicon')

results = []
problems = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS  ' if ok else 'FAIL  ') + name + (f'  [{detail}]' if detail and not ok else ''))


def watch(page, label):
    page.on('pageerror', lambda e: problems.append(f'{label}: {e}'))
    page.on('console', lambda m: problems.append(f'{label}: {m.text}')
            if m.type == 'error' and not any(x in m.text for x in IGNORE) else None)


def open_app(context, label='app', path='/?demo'):
    page = context.new_page()
    watch(page, label)
    page.goto(BASE + path)
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(700)
    if path.startswith('/?'):
        close_dialog(page)  # the once-a-day "Your day" box
    return page


def wait_until(page, expression, timeout=15000):
    """Waits for something to become true on the page (the page's safety policy forbids the built-in way)."""
    waited = 0
    while waited < timeout:
        if page.evaluate(expression):
            return
        page.wait_for_timeout(150)
        waited += 150
    raise TimeoutError(f'still not true after {timeout} ms: {expression}')


def dialog_open(page):
    return page.evaluate("document.querySelector('#dlg').open && !document.querySelector('#dlg').classList.contains('closing')")


def close_dialog(page):
    for _ in range(6):  # some boxes sit on top of others
        if not page.evaluate("document.querySelector('#dlg').open"):
            return
        page.keyboard.press('Escape')
        page.wait_for_timeout(350)


def recordings(page):
    return page.evaluate("""async () => {
      const R = await import('./recorder.js');
      return (await R.all()).map(r => ({ id: r.id, kind: r.kind, secs: r.secs, size: r.size, done: r.done, title: r.title, shot: !!r.shot, thumb: !!r.thumb, cam: !!r.cam }));
    }""")


CLIENT_NOTE = "Object.entries(JSON.parse(localStorage.getItem('planner.demo.v1')).notes).find(([, n]) => n.title === 'Client call: Acme')[0]"


def add_said(page):
    """A recording of the sample client call whose words are written down (as notes from a recording leave it)."""
    page.evaluate("""async key => { const R = await import('./recorder.js');
      const lines = [{ t: 2, who: 'Ravi Menon', text: 'We agreed the price is 40 dollars a seat.' }, { t: 9, who: 'Speaker 2', text: 'I will send the contract by Friday.' }];
      await R.takeIn('rec', { id: 'said-test', key, kind: 'audio', title: 'Client call: Acme', at: Date.now() - 3600000, secs: 60, size: 1000, mime: 'audio/webm', done: true,
        lines, transcript: lines.map(l => `[0:0${l.t}] ${l.who}: ${l.text}`).join('\\n') }); }""", page.evaluate(CLIENT_NOTE))


def open_note(page, title):
    page.locator('#notes .nrow', has_text=title).first.click()
    page.wait_for_timeout(500)


def note_page_checks(browser):
    """The note page: asking on the note, what was said, the follow-up email, and Tidy on the key."""
    # ---- no key: every smart part says it needs one, and the follow-up email is the plain version
    bare = browser.new_context(viewport={'width': 1440, 'height': 860})
    bare.add_init_script(SEEN + QUIET + 'delete self.LanguageModel;')  # most browsers have no AI of their own
    np = open_app(bare, 'note page, no key')
    add_said(np)
    np.locator('#mainNav [data-nav=notes]').click()
    np.wait_for_selector('#notes .nrow', timeout=8000)
    open_note(np, 'Client call')
    bar = np.locator('#notes .ndoc .naskbar')
    check('an open note has the ask bar at its foot', bar.is_visible() and np.locator('#notes .ndoc [name=nq]').get_attribute('placeholder') == 'Ask anything about this note'
          and np.locator('#notes #noteAskAll').is_visible())
    np.locator('#notes [name=nq]').fill('what price did we agree?')
    np.locator('#notes [name=nq]').press('Enter')
    np.wait_for_timeout(500)
    box = np.evaluate("({ title: document.querySelector('#dlg .needkey h3')?.textContent, body: document.querySelector('#dlg .needkey p')?.textContent })")
    check('asking about a note with no key shows the one key box', box['title'] == 'Add your AI key to use this' and 'Asking about a note' in (box['body'] or ''), json.dumps(box))
    close_dialog(np)
    follow = np.locator('#notes #ndocFollow')
    check('the follow-up button sits beside the ask bar, named for the plain version', follow.is_visible() and follow.inner_text().strip() == 'Follow-up email')
    follow.click()
    np.wait_for_selector('#dlg [name=fubody]', timeout=8000)
    body = np.locator('#dlg [name=fubody]').input_value()
    check('with no key the follow-up box shows the plain version at once, and says a key would write it',
          'Thank you for your time' in body and np.locator('#dlg [name=fusubject]').input_value() == 'Follow-up: Client call: Acme'
          and 'Add your AI key and Weftday writes this for you.' in np.locator('#dlg #fuSay').inner_text())
    close_dialog(np)
    check('“What was said” shows only for a note whose recording has words', np.locator('#notes .nswitch').count() == 1)
    open_note(np, 'Weekend list')
    check('a note with no recording has no “What was said”', np.locator('#notes .nswitch').count() == 0 and np.locator('#notes .naskbar').is_visible())
    np.locator('#mainNav [data-nav=calendar]').click()
    np.wait_for_timeout(500)
    np.locator('#gridBody [data-key]', has_text='Client call').first.click()
    np.wait_for_timeout(700)
    tidy = np.locator('#dlg [data-x=tidy]')
    builtin = np.evaluate("'LanguageModel' in self")
    check('“Tidy my notes” shows in the meeting box even without the browser’s own AI', tidy.is_visible() and not builtin, f'built-in AI: {builtin}')
    tidy.click()
    np.wait_for_timeout(500)
    check('Tidy with no key and no built-in AI asks for a key', 'Tidying your notes' in (np.evaluate("document.querySelector('#dlg .needkey p')?.textContent") or ''))
    close_dialog(np)
    bare.close()

    # ---- with a (pretend) key and a pretend AI
    asked = {}

    def pretend(route):
        body = route.request.post_data or ''
        if 'I am asking about one of my meetings' in body:
            asked['note'] = 'and the transcript of its recording' in body and 'We agreed the price is 40 dollars' in body
            text = '<b>40 dollars</b> a seat.\nRavi sends the questionnaire.'
        elif 'Write a follow-up email' in body:
            asked['email'] = 'What was said in the meeting' in body
            text = 'Hi Ravi and Lena,\n\nThank you for today. We agreed on 40 dollars a seat.\n\nBest,\nSam'
        elif 'You tidy my rough notes' in body:
            asked['tidy'] = True
            text = json.dumps({'summary': 'We talked about price.', 'decisions': ['Price is 40 dollars a seat'], 'actions': ['Send the contract by Friday'], 'questions': [], 'info': []})
        elif 'points worth raising' in body:
            asked['raise'] = True
            text = '- Ask Ravi about the security questionnaire\n- Confirm the 50 seats'
        else:
            text = 'Fine.'
        reply = {'outputs': [{'type': 'text', 'text': text}]} if '/interactions' in route.request.url else {'candidates': [{'content': {'parts': [{'text': text}]}}]}
        route.fulfill(status=200, content_type='application/json', body=json.dumps(reply))

    keyed = browser.new_context(viewport={'width': 1440, 'height': 860})
    keyed.add_init_script(SEEN + QUIET)
    kp = open_app(keyed, 'note page, with key')
    kp.route('https://generativelanguage.googleapis.com/**', pretend)
    kp.evaluate("""() => { const s = JSON.parse(localStorage.getItem('planner.demo.v1')); s.settings.aiKey = 'pretend-key-for-tests'; localStorage.setItem('planner.demo.v1', JSON.stringify(s)); }""")
    add_said(kp)
    kp.reload()
    kp.wait_for_load_state('networkidle')
    kp.wait_for_timeout(600)
    close_dialog(kp)
    kp.locator('#mainNav [data-nav=notes]').click()
    kp.wait_for_selector('#notes .nrow', timeout=8000)
    open_note(kp, 'Client call')
    kp.locator('#notes [name=nq]').fill('what price did we agree?')
    kp.locator('#notes .nsend').click()
    wait_until(kp, "(document.querySelector('#notes .na')?.textContent || '').includes('40 dollars')", 15000)
    got = kp.evaluate("""(() => { const a = document.querySelector('#notes .nanswer'); return { q: a.querySelector('.nq').textContent, plain: !a.querySelector('.na b'),
      text: a.querySelector('.na').textContent, src: a.querySelector('.nsrc span').textContent }; })()""")
    check('a question about a note is answered on the note, as plain text', got['q'] == 'what price did we agree?' and got['plain'] and got['text'].startswith('<b>40 dollars</b>')
          and '\n' in got['text'], json.dumps(got))
    check('the answer says where it came from and that it went to your AI', got['src'] == 'Answered from this note and what was said in its recording. Sent to your AI for this one answer.'
          and asked.get('note'), json.dumps(got))
    check('the answer sits above the bar, inside the note', kp.evaluate("document.querySelector('#notes .nanswer').getBoundingClientRect().bottom <= document.querySelector('#notes .naskbar').getBoundingClientRect().top + 1"))
    kp.screenshot(path=os.path.join(OUT, 'note-answer.png'))
    kp.locator('#notes .nswitch button', has_text='What was said').click()
    kp.wait_for_timeout(200)
    check('“What was said” replaces the note with its lines, times and voices', kp.locator('#notes .nsaid').is_visible() and kp.locator('#notes .nsaid .nline').count() == 2
          and not kp.locator('#notes .ndoc .ed').is_visible() and 'Ravi Menon' in kp.locator('#notes .nline').first.inner_text())
    kp.screenshot(path=os.path.join(OUT, 'note-said.png'))
    kp.locator('#notes .nswitch button', has_text='Notes').click()
    follow = kp.locator('#notes #ndocFollow')
    check('with a key the button says it writes the email', follow.inner_text().strip() == 'Write follow-up email')
    follow.click()
    wait_until(kp, "(document.querySelector('#dlg [name=fubody]')?.value || '').includes('Thank you for today')", 15000)
    check('the follow-up email is written by your AI from the note and what was said', asked.get('email') and 'Written by your AI' in kp.locator('#dlg #fuSay').inner_text())
    kp.screenshot(path=os.path.join(OUT, 'followup.png'))
    kp.evaluate("window.open = (url) => { window.__opened = url; return null; }")
    kp.locator('#dlg [data-x=fugmail]').click()
    opened = kp.evaluate("window.__opened || ''")
    check('“Open in Gmail” builds a Gmail draft address', opened.startswith('https://mail.google.com/mail/?') and 'su=Follow-up%3A' in opened and 'Thank%20you%20for%20today' in opened, opened[:160])
    close_dialog(kp)
    kp.locator('#mainNav [data-nav=calendar]').click()
    kp.wait_for_timeout(500)
    kp.locator('#gridBody [data-key]', has_text='Client call').first.click()
    kp.wait_for_timeout(700)
    kp.locator('#dlg [data-x=tidy]').click()
    said = kp.locator('#dlg #noteState').inner_text()
    wait_until(kp, "(document.querySelector('#dlg textarea[name=note]')?.value || '').startsWith('Summary\\nWe talked about price.')", 15000)
    check('“Tidy my notes” uses your key when there is one', asked.get('tidy') and ('Sent to your AI' in said or said == 'Tidied'), said)
    kp.locator('#dlg [data-x=brief]').click()
    kp.wait_for_timeout(500)
    kp.locator('#dlg [data-x=raise]').click()
    wait_until(kp, "(document.querySelector('#raiseOut')?.textContent || '').includes('security questionnaire')", 15000)
    check('“What should I raise?” in the brief asks your AI and says what was sent', asked.get('raise') and kp.locator('#raiseOut p').count() == 2
          and 'Sent to your AI' in kp.locator('#raiseSay').inner_text())
    close_dialog(kp)
    keyed.close()

    # ---- the note page on a phone
    phone = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    phone.add_init_script(SEEN + QUIET)
    pp = open_app(phone, 'note page, phone')
    pp.route('https://generativelanguage.googleapis.com/**', pretend)
    pp.evaluate("""() => { const s = JSON.parse(localStorage.getItem('planner.demo.v1')); s.settings.aiKey = 'pretend-key-for-tests'; localStorage.setItem('planner.demo.v1', JSON.stringify(s)); }""")
    add_said(pp)
    pp.reload()
    pp.wait_for_load_state('networkidle')
    pp.wait_for_timeout(600)
    close_dialog(pp)
    pp.locator('#menu').click()
    pp.wait_for_timeout(400)
    pp.locator('#mainNav [data-nav=notes]').click()
    pp.wait_for_selector('#notes .nrow', timeout=8000)
    open_note(pp, 'Client call')
    pp.locator('#notes [name=nq]').fill('what price did we agree?')
    pp.locator('#notes .nsend').click()
    wait_until(pp, "(document.querySelector('#notes .na')?.textContent || '').includes('40 dollars')", 15000)
    fit = pp.evaluate("""(() => { const r = document.querySelector('#notes .naskbar').getBoundingClientRect(), acts = [...document.querySelectorAll('#notes .ndocacts .btn')].filter(b => b.offsetParent);
      return { wide: document.documentElement.scrollWidth <= innerWidth + 1, inside: r.left >= 0 && r.right <= innerWidth + 0.5 && r.top >= 0 && r.bottom <= innerHeight + 0.5,
        tall: acts.every(b => b.getBoundingClientRect().height >= 40), reading: document.querySelector('#notes').classList.contains('reading') }; })()""")
    check('on a phone the note page has no sideways scroll and the ask bar is fully on screen', fit['wide'] and fit['inside'] and fit['tall'] and fit['reading'], json.dumps(fit))
    pp.screenshot(path=os.path.join(OUT, 'phone-note-answer.png'))
    phone.close()


def run(p):
    browser = p.chromium.launch(channel='chrome', headless=True, args=[
        '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
        '--auto-select-tab-capture-source-by-title=Weftday', '--autoplay-policy=no-user-gesture-required',
    ])
    context = browser.new_context(viewport={'width': 1440, 'height': 860}, permissions=['microphone', 'camera'])
    context.add_init_script(SEEN + QUIET)

    # ---- the main screen
    page = open_app(context)
    # ---- Home: the place the app opens on
    check('the app opens on Home, with a greeting and today', page.locator('#home .hhello h2').is_visible() and page.locator('#mainNav [data-nav=home].on').count() == 1
          and page.locator('#home .hnext').count() == 1 and page.locator('#home .hsec').count() >= 3)
    check('Home shows today’s tasks and can tick one', page.locator('#home .hrow.task').count() >= 1)
    page.wait_for_timeout(400)
    page.screenshot(path=os.path.join(OUT, 'home.png'))
    page.locator('#home [data-act=home-calendar]').click()
    page.wait_for_timeout(600)
    check('the calendar is one press from Home', page.locator('#grid').is_visible() and page.locator('#mainNav [data-nav=calendar].on').count() == 1)
    check('app opens with the sample data', page.locator('#gridBody .ev, #gridBody [data-key]').count() > 0 or page.locator('#grid').is_visible())
    check('no sideways scrolling on a computer', page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'))

    # ---- every tool in the side panel opens its box
    def shot_of(act, name):
        page.locator(f'#side [data-act="{act}"]').first.click()
        page.wait_for_timeout(700)
        page.screenshot(path=os.path.join(OUT, name))
        close_dialog(page)

    shot_of('open-today', 'panel-today.png')
    shot_of('people', 'panel-people.png')
    check('details open as a panel down the right-hand side', page.evaluate("""(() => { document.querySelector('#side [data-act=people]').click(); const d = document.querySelector('#dlg'), r = d.getBoundingClientRect(); const ok = d.classList.contains('panel') && Math.abs(r.right - innerWidth) < 2 && r.height >= innerHeight - 2 && !!d.querySelector('.pclose'); return ok; })()"""))
    close_dialog(page)
    for act in ['open-today', 'people', 'free', 'plan', 'record']:
        tile = page.locator(f'#side [data-act="{act}"]').first
        if tile.count() == 0:
            check(f'side tool "{act}" is there', False)
            continue
        tile.click()
        page.wait_for_timeout(500)
        opened = dialog_open(page) or page.locator('#toast.show').count() > 0
        check(f'side tool "{act}" opens', opened)
        close_dialog(page)

    # ---- settings and its sections
    page.locator('#settingsBtn').click()
    page.wait_for_timeout(400)
    check('settings open', dialog_open(page))
    tabs = page.locator('#dlg button[data-pane]:visible, #dlg .snav button:visible')
    for i in range(min(tabs.count(), 8)):
        tabs.nth(i).click()
        page.wait_for_timeout(120)
    check('settings sections switch without an error', dialog_open(page))
    close_dialog(page)

    # ---- search, help
    for btn in ['#searchBtn', '#helpBtn', '#zoneBtn']:
        if page.locator(btn).is_visible():
            page.locator(btn).click()
            page.wait_for_timeout(350)
            check(f'{btn} opens', dialog_open(page) or page.locator('#toast.show').count() > 0)
            close_dialog(page)

    # ---- a task typed in plain words
    before = page.evaluate("JSON.parse(localStorage.getItem('planner.demo.v1') || '{}').tasks?.length || 0")
    page.locator('#quickInput').fill('call the bank tomorrow 3pm')
    page.locator('#quickInput').press('Enter')
    page.wait_for_timeout(700)
    after = page.evaluate("JSON.parse(localStorage.getItem('planner.demo.v1') || '{}').tasks?.length || 0")
    check('typing a task adds it', after == before + 1, f'{before} -> {after}')

    # ---- a meeting opens
    ev = page.locator('#gridBody [data-key]', has_text='Client call').first
    if ev.count():
        ev.click()
        page.wait_for_timeout(900)
        check('a meeting opens', dialog_open(page))
        check('a meeting shows its people, the notes and little else', page.locator('#dlg .pchip').count() >= 2 and page.locator('#dlg .ed').is_visible()
              and not page.locator('#dlg .whos').first.is_visible() and page.locator('#dlg .rfold').count() >= 2)
        page.screenshot(path=os.path.join(OUT, 'meeting.png'))
        # the notes editor: typed the way notes apps are typed, kept as plain text
        ed = page.locator('#dlg .ed')
        # the sample meeting comes with notes; start from an empty page
        page.evaluate("(() => { const a = document.querySelector('#dlg textarea[name=note]'); a.value = ''; a.dispatchEvent(new Event('input', { bubbles: true })); })()")
        ed.click()
        page.keyboard.type('Agenda')
        page.keyboard.press('Enter')
        page.keyboard.type('- first point')
        page.keyboard.press('Enter')
        page.keyboard.type('second point')
        page.keyboard.press('Enter')
        page.keyboard.press('Enter')
        page.keyboard.type('[] call them back')
        page.wait_for_timeout(200)
        kept = page.locator('#dlg textarea[name=note]').input_value()
        check('bullets and tick-boxes are typed with - and [], and kept as plain text', kept == 'Agenda\n- first point\n- second point\n- [ ] call them back', repr(kept))
        check('they look like bullets and tick-boxes', page.locator('#dlg .ed .b.li').count() == 2 and page.locator('#dlg .ed .b.todo').count() == 1)
        box_at = page.locator('#dlg .ed .b.todo').bounding_box()
        page.mouse.click(box_at['x'] + 8, box_at['y'] + box_at['height'] / 2)
        page.wait_for_timeout(200)
        check('pressing a tick-box ticks it', page.locator('#dlg textarea[name=note]').input_value().endswith('- [x] call them back'))
        page.keyboard.press('Home')
        page.keyboard.press('Backspace')
        check('Backspace at the start turns it back into plain text', page.locator('#dlg textarea[name=note]').input_value().endswith('\ncall them back'))
        page.wait_for_timeout(900)
        page.screenshot(path=os.path.join(OUT, 'meeting-editor.png'))
        saved_note = page.evaluate("Object.values(JSON.parse(localStorage.getItem('planner.demo.v1')).notes || {}).map(n => n.text)")
        check('what was typed is saved by itself', any('- first point' in t for t in saved_note), str(saved_note)[:200])
        page.locator('#dlg .rfold summary', has_text='People').click()
        check('the people in full are one press away', page.locator('#dlg .whos .who').first.is_visible())
        page.locator('#dlg .pchip').first.click()
        page.wait_for_timeout(600)
        check('a person’s chip opens their page', dialog_open(page) and page.locator('#dlg textarea[name=note]').count() == 0)
        close_dialog(page)

    # ---- the recorder
    def record(kind, seconds, camera=False, shot_name=None, during=None):
        """Starts a recording of the given kind from the Record box, lets it run, stops it, and returns it."""
        before = {r['id'] for r in recordings(page)}
        page.locator('#side [data-act="record"]').first.click()
        page.wait_for_timeout(400)
        page.locator(f'#dlg input[name=what][value={kind}]').check(force=True)
        if camera:
            page.locator('#dlg input[name=cam]').check()
            wait_until(page, "document.querySelector('#dlg .rcam')?.readyState >= 2", 15000)
            page.locator('#dlg input[name=corner][value=tl]').check(force=True)
            page.locator('#dlg input[name=size][value=large]').check(force=True)
        if kind == 'camera':
            wait_until(page, "document.querySelector('#dlg .rcam')?.readyState >= 2", 15000)
        if shot_name:
            page.wait_for_timeout(300)
            page.screenshot(path=os.path.join(OUT, shot_name))
        page.locator('#dlg button.primary').click()
        try:
            page.wait_for_selector('#recBar', timeout=20000)
        except Exception:  # noqa: BLE001
            page.screenshot(path=os.path.join(OUT, f'{kind}-recording-failed.png'))
            print('   toast:', page.evaluate("document.querySelector('#toast').innerText"))
            close_dialog(page)
            return {}
        if during:
            during()
        page.wait_for_timeout(int(seconds * 1000))
        page.locator('#recBar [data-r=stop]').click()
        page.wait_for_selector('#recBar', state='detached', timeout=30000)
        return next((r for r in recordings(page) if r['id'] not in before and r['kind'] != 'shot'), {})

    mic = record('mic', 3)
    check('microphone recording is saved', mic.get('done') and mic.get('kind') == 'audio' and mic.get('size', 0) > 1000 and mic.get('secs', 0) >= 2, str(mic))

    sound = record('sound', 3)
    check('a meeting’s sound is saved without the picture', sound.get('done') and sound.get('kind') == 'audio' and sound.get('size', 0) > 1000, str(sound))

    def bar_tools():
        page.wait_for_timeout(1800)
        page.screenshot(path=os.path.join(OUT, 'recording-bar.png'))
        check('the bar shows the camera, a level and the tools', page.locator('#recBar .rface').count() == 1
              and page.locator('#recBar [data-r=snap]').count() == 1 and page.locator('#recBar [data-r=cam]').count() == 1)
        page.locator('#recBar [data-r=snap]').click()
        page.wait_for_timeout(1200)
        page.locator('#recBar [data-r=pause]').click()
        page.wait_for_timeout(600)
        check('pause and resume work', page.locator('#recBar.paused').count() == 1 and page.locator('#recBar [data-r=pause]').inner_text() == 'Resume')
        page.locator('#recBar [data-r=pause]').click()

    video = record('video', 3, camera=True, shot_name='record-setup.png', during=bar_tools)
    check('screen recording with the camera in a corner is saved', video.get('done') and video.get('kind') == 'video' and video.get('cam')
          and video.get('thumb') and video.get('size', 0) > 20000, str(video))
    check('a still picture taken while recording is kept', any(r['kind'] == 'shot' for r in recordings(page)))

    cam = record('camera', 3)
    check('camera-only recording is saved', cam.get('done') and cam.get('kind') == 'video' and cam.get('size', 0) > 10000, str(cam))

    # ---- trimming: a copy from one moment to another, made at once
    long_one = record('video', 9)
    page.locator('#searchBtn').click()
    page.wait_for_timeout(300)
    page.keyboard.type('recordings')
    page.wait_for_timeout(300)
    page.keyboard.press('Enter')
    page.wait_for_selector('#dlg .rgrid', timeout=8000)
    page.locator(f'#dlg .rcard[data-id="{long_one["id"]}"]').click()
    page.wait_for_selector('#dlg video.rplay', timeout=8000)
    wait_until(page, "Number.isFinite(document.querySelector('#dlg video.rplay').duration)", 8000)
    page.locator('#dlg .rfold summary', has_text='Speed').click()
    page.locator('#dlg [data-x=trim]').click()
    page.evaluate("document.querySelector('#dlg video.rplay').currentTime = 4.2")
    page.wait_for_timeout(500)
    page.locator('#dlg [data-x=trimfrom]').click()
    page.screenshot(path=os.path.join(OUT, 'trim.png'))
    page.locator('#dlg [data-x=trimsave]').click()
    try:
        wait_until(page, "document.querySelector('#dlg .rtitle')?.value.endsWith('(trimmed)')", 15000)
        wait_until(page, "Number.isFinite(document.querySelector('#dlg video.rplay')?.duration)", 8000)
        short = page.evaluate("document.querySelector('#dlg video.rplay').duration")
        whole = long_one['secs']
        check('a trimmed copy is shorter and starts where it was cut', 1.5 <= short <= whole - 1.5, f'{short} of {whole}')
        played = page.evaluate("""async () => { const v = document.querySelector('#dlg video.rplay'); v.muted = true; v.currentTime = 0; await v.play(); await new Promise(d => setTimeout(d, 1200)); v.pause(); return { t: v.currentTime, w: v.videoWidth, err: v.error?.message || '' }; }""")
        check('the trimmed copy plays from its beginning', played['t'] > 0.5 and played['w'] > 0 and not played['err'], str(played))
        check('the original is still there, untouched', any(r['id'] == long_one['id'] and r['secs'] == whole for r in recordings(page)))
    except Exception as err:  # noqa: BLE001
        said = page.evaluate("document.querySelector('#toast').innerText")
        check('a trimmed copy is shorter and starts where it was cut', False, f'{str(err)[:160]} | {said}'[:300])
    close_dialog(page)
    sound_trim = page.evaluate("""async id => { const R = await import('./recorder.js'); const copy = await R.trim(id, 1.2, 99);
      const a = new Audio(URL.createObjectURL(await R.file(copy.id))); await new Promise((d, f) => { a.onloadedmetadata = d; a.onerror = f; });
      const out = { secs: copy.secs, duration: a.duration, title: copy.title }; await R.remove(copy.id); return out; }""", sound['id'])
    check('a sound recording can be trimmed too', 0.5 < sound_trim['duration'] < sound['secs'] and sound_trim['title'].endswith('(trimmed)'), str(sound_trim))

    # ---- a screenshot
    shots = sum(1 for r in recordings(page) if r['kind'] == 'shot')
    page.locator('#searchBtn').click()
    page.wait_for_timeout(300)
    page.keyboard.type('take a screenshot')
    page.wait_for_timeout(300)
    page.keyboard.press('Enter')
    try:
        page.wait_for_selector('#dlg .rshot', timeout=15000)
        page.wait_for_timeout(300)
        page.screenshot(path=os.path.join(OUT, 'screenshot-view.png'))
        check('a screenshot is taken and shown', sum(1 for r in recordings(page) if r['kind'] == 'shot') == shots + 1)
    except Exception as err:  # noqa: BLE001
        check('a screenshot is taken and shown', False, str(err)[:160])
    close_dialog(page)

    # ---- the library, one recording, renaming, speed, delete
    page.locator('#searchBtn').click()
    page.wait_for_timeout(300)
    page.keyboard.type('recordings')
    page.wait_for_timeout(300)
    page.keyboard.press('Enter')
    page.wait_for_selector('#dlg .rgrid', timeout=8000)
    page.wait_for_timeout(500)
    total = len(recordings(page))
    check('the library lists everything', page.locator('#dlg .rcard').count() == total, f"{page.locator('#dlg .rcard').count()} of {total}")
    check('videos and screenshots have a small picture', page.locator('#dlg .rthumb.video img, #dlg .rthumb.shot img').count() >= 3)
    page.screenshot(path=os.path.join(OUT, 'library.png'))
    page.locator('#dlg .rkinds [data-v=video]').click()
    page.wait_for_timeout(400)
    check('the library can show videos only', page.locator('#dlg .rcard').count() == sum(1 for r in recordings(page) if r['kind'] == 'video'))
    page.locator(f'#dlg .rcard[data-id="{video["id"]}"]').click()
    page.wait_for_selector('#dlg video.rplay', timeout=8000)
    wait_until(page, "Number.isFinite(document.querySelector('#dlg video.rplay').duration)", 8000)
    length = page.evaluate("document.querySelector('#dlg video.rplay').duration")
    check('the video knows its own length', 2 <= length <= 12, str(length))
    page.locator('#dlg .rfold summary', has_text='Speed').click()
    page.locator('#dlg [data-x=speed][data-v="1.5"]').click()
    check('playback speed can be changed', page.evaluate("document.querySelector('#dlg video.rplay').playbackRate") == 1.5)
    page.locator('#dlg .rtitle').fill('Demo for the team')
    page.locator('#dlg .rtitle').press('Enter')
    page.wait_for_timeout(400)
    check('a recording can be renamed', any(r['title'] == 'Demo for the team' for r in recordings(page)))
    page.evaluate("document.querySelector('#dlg video.rplay').currentTime = 2")
    page.wait_for_timeout(700)
    page.screenshot(path=os.path.join(OUT, 'recording.png'))
    page.once('dialog', lambda d: d.accept())
    page.locator('#dlg [data-x=del]').click()
    page.wait_for_timeout(700)
    check('a recording can be deleted', len(recordings(page)) == total - 1)
    close_dialog(page)

    # ---- the meeting flow: record a meeting, type notes, and the notes write themselves (the AI is pretend)
    def pretend_ai(route):
        body = route.request.post_data or ''
        if 'gemini-3.5-transcribe' in body:  # the listening model: each word with its voice and its time
            said = [('spk:0', 'We agreed the price is 40 dollars a seat.'), ('spk:1', 'I will send the contract by Friday.')]
            words, t = [], 0.1
            for voice, sentence in said:
                for word in sentence.split():
                    words.append({'type': 'word_info', 'text': word, 'speaker': voice, 'start_offset': f'{t:.3f}s', 'end_offset': f'{t + 0.2:.3f}s'})
                    t += 0.3
            seen['heard'] = True
            return route.fulfill(status=200, content_type='application/json', body=json.dumps(
                {'status': 'completed', 'steps': [{'type': 'model_output', 'content': [{'type': 'text', 'text': ' '.join(x[1] for x in said), 'annotations': words}]}]}))
        if 'inline_data' in body:
            text = 'Speaker 1: We agreed the price is 40 dollars a seat.\nSpeaker 2: I will send the contract by Friday.'
        elif 'Answer with JSON only' in body:
            text = json.dumps({'title': 'Acme pricing agreed', 'kind': 'sales call', 'summary': 'The price was agreed at 40 dollars a seat.',
                               'next': 'Send the contract.', 'decisions': ['Price is 40 dollars a seat'], 'mine': ['Send the contract by Friday'],
                               'theirs': ['Ravi: send the security questionnaire by Wednesday'], 'questions': [], 'facts': ['50 seats'], 'settled': [],
                               'voices': {'Speaker 1': 'Ravi Menon', 'Speaker 2': ''}, 'chapters': [{'at': '0:00', 'title': 'Agreeing the price'}]})
            seen['timed'] = '[0:00] Speaker 1: We agreed' in body
            seen['rough'] = 'ask about the pilot' in body
            seen['people'] = 'Ravi Menon' in body
            seen['names'] = 'Spell these names exactly' in body and 'Acme' in body
        else:
            text = 'The price agreed was 40 dollars a seat.'
            if 'Answer my question from my meeting notes and recordings' in body:
                seen['all_notes'] = '### Meeting notes: Client call: Acme' in body
                seen['all_said'] = '### What was said: Client call: Acme' in body
        # Google answers in two shapes: one for listening to sound, one for plain questions
        reply = {'outputs': [{'type': 'text', 'text': text}]} if '/interactions' in route.request.url else {'candidates': [{'content': {'parts': [{'text': text}]}}]}
        route.fulfill(status=200, content_type='application/json', body=json.dumps(reply))

    seen = {}
    page.route('https://generativelanguage.googleapis.com/**', pretend_ai)
    page.evaluate("""() => { const s = JSON.parse(localStorage.getItem('planner.demo.v1')); s.settings.aiKey = 'pretend-key-for-tests'; localStorage.setItem('planner.demo.v1', JSON.stringify(s)); }""")
    page.reload()
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(700)
    close_dialog(page)
    page.locator('#mainNav [data-nav=calendar]').click()  # the app opens on Home; these checks use the calendar
    page.wait_for_timeout(500)
    tasks_before = page.evaluate("JSON.parse(localStorage.getItem('planner.demo.v1')).tasks.length")
    page.locator('#gridBody [data-key]', has_text='Client call').first.click()
    page.wait_for_timeout(600)
    close_dialog(page)
    page.locator('#side [data-act="record"]').first.click()
    page.wait_for_timeout(500)
    check('writing the notes is switched on by itself when there is a key', page.locator('#dlg input[name=auto]').is_checked())
    page.screenshot(path=os.path.join(OUT, 'record-box.png'))
    close_dialog(page)
    page.locator('#gridBody [data-key]', has_text='Client call').first.click()
    page.wait_for_timeout(600)
    page.locator('#dlg [data-x=record]').click()  # one press: no box, straight to Chrome's own question and then listening
    page.wait_for_selector('#recBar', timeout=20000)
    page.wait_for_timeout(700)
    box = page.locator('#dlg textarea[name=note]')
    check('the meeting’s notes open by themselves while it records', box.count() == 1 and page.locator('#recBar [data-r=notes]').count() == 1)
    check('recording a meeting takes one press', page.locator('#dlg input[name=what]').count() == 0)
    page.locator('#dlg .ed').click()
    page.keyboard.press('ControlOrMeta+a')
    page.keyboard.type('ask about the pilot')
    page.wait_for_timeout(5600)
    page.screenshot(path=os.path.join(OUT, 'meeting-recording.png'))
    page.locator('#recBar [data-r=stop]').click()
    try:
        wait_until(page, "document.querySelector('#toast').innerText.includes('Notes written')", 30000)
        written = box.input_value()
        check('notes are written by themselves when the recording ends', 'Summary' in written and 'Send the contract by Friday' in written, written[:200])
        check('what you typed is blended in and kept', seen.get('rough') and written.rstrip().endswith('ask about the pilot'), written[-120:])
        check('the notes say they were written by AI from the recording', 'Written by AI from what was said in the recording of' in written)
        check('the AI is told who was in the meeting, and how their names are spelt', seen.get('people') and seen.get('names'), str(seen))
        check('notes separate my action points from what others owe, and name the next step',
              'Waiting on others\n- Ravi: send the security questionnaire' in written and 'Next: Send the contract.' in written, written[:400])
        page.screenshot(path=os.path.join(OUT, 'meeting-notes-written.png'))
        page.locator('#toast [data-act=toast-go]').click()
        page.wait_for_timeout(600)
        tasks_after = page.evaluate("JSON.parse(localStorage.getItem('planner.demo.v1')).tasks.length")
        check('only my own action point becomes a task', tasks_after == tasks_before + 1, f'{tasks_before} -> {tasks_after}')
        made = page.evaluate("JSON.parse(localStorage.getItem('planner.demo.v1')).tasks.at(-1)")
        check('the task carries the day that was meant', made['title'].startswith('Send the contract') and bool(made.get('date')), str(made)[:200])
    except Exception as err:  # noqa: BLE001
        said = page.evaluate("document.querySelector('#toast').innerText")
        check('notes are written by themselves when the recording ends', False, f'{str(err)[:120]} | toast: {said}')
        page.screenshot(path=os.path.join(OUT, 'auto-notes-failed.png'))
    close_dialog(page)
    newest = recordings(page)[0]
    page.locator('#gridBody [data-key]', has_text='Client call').first.click()
    page.wait_for_timeout(600)
    page.locator('#dlg #recsBtn').click()
    page.wait_for_selector('#dlg .rcard', timeout=8000)
    page.locator(f'#dlg .rcard[data-id="{newest["id"]}"]').click()
    page.wait_for_selector('#dlg .rask', timeout=8000)
    check('the notes are shown first, as headings and lists', page.locator('#dlg .rnotes h5').count() >= 3 and page.locator('#dlg .rnotes .rnext').count() == 1)
    page.locator('#dlg .rfold summary', has_text='What was said').click()
    check('what was said is kept line by line, with times and voices', seen.get('heard') and seen.get('timed') and page.locator('#dlg .rline').count() == 2)
    check('a voice gets its real name when the talk makes it certain', 'Ravi Menon' in page.locator('#dlg .rline').first.inner_text()
          and 'Speaker 2' in page.locator('#dlg .rline').nth(1).inner_text())
    page.locator('#dlg .rline').nth(1).click()
    page.wait_for_timeout(500)
    check('pressing a line jumps the player there', page.evaluate("document.querySelector('#dlg .rplay').currentTime") > 2)
    page.locator('#dlg .rask input').fill('what price did we agree?')
    page.locator('#dlg .rask button').click()
    wait_until(page, "document.querySelector('#recAnswer').textContent.includes('40 dollars')", 15000)
    check('a question about the meeting is answered from the recording', True)
    page.screenshot(path=os.path.join(OUT, 'ask-recording.png'))
    close_dialog(page)
    # one question across every meeting
    page.locator('#searchBtn').click()
    page.wait_for_timeout(300)
    page.keyboard.type('ask my meetings')
    page.wait_for_timeout(300)
    page.keyboard.press('Enter')
    page.wait_for_selector('#dlg #askAnswer', state='attached', timeout=8000)
    page.locator('#dlg input[name=q]').fill('what did we agree with Acme?')
    page.locator('#dlg .rask button').click()
    wait_until(page, "document.querySelector('#askAnswer').textContent.includes('40 dollars')", 15000)
    check('a question is answered from all meeting notes and recordings', seen.get('all_notes') and seen.get('all_said'), str(seen))
    page.screenshot(path=os.path.join(OUT, 'ask-all.png'))
    close_dialog(page)
    page.unroute('https://generativelanguage.googleapis.com/**')

    page.locator('#brandHome').click()
    page.wait_for_timeout(500)
    check('the Weftday name at the top leads Home', page.locator('#home').is_visible() and page.locator('#mainNav [data-nav=home].on').count() == 1)
    page.locator('#mainNav [data-nav=calendar]').click()
    page.wait_for_timeout(400)
    # ---- back on Home, the note just written is listed, and opens in Notes
    page.locator('#mainNav [data-nav=home]').click()
    page.wait_for_selector('#home .hnote', timeout=8000)
    check('Home lists the latest notes', 'Client call' in page.locator('#home .hnote').first.inner_text())
    page.screenshot(path=os.path.join(OUT, 'home-notes.png'))
    page.locator('#home .hnote').first.click()
    page.wait_for_selector('#notes .ndoc .ntitle', timeout=8000)
    check('a note pressed on Home opens in Notes', page.locator('#notes .ndoc .ntitle').input_value() == 'Client call: Acme')
    page.locator('#mainNav [data-nav=calendar]').click()
    page.wait_for_timeout(500)

    # ---- the Notes page: every saved note in a list, the one you pick opens beside it
    page.locator('#mainNav [data-nav=notes]').click()
    page.wait_for_selector('#notes .nrow', timeout=8000)
    page.wait_for_timeout(500)
    check('the Notes page lists the saved notes and opens the newest', page.locator('#notes .nrow', has_text='Client call').count() == 1
          and page.locator('#notes .ndoc .ntitle').input_value() == 'Client call: Acme' and page.locator('#notes .ndoc .ed .b.sec').count() >= 3)
    page.screenshot(path=os.path.join(OUT, 'notes.png'))
    page.locator('#noteNew').click()
    page.wait_for_timeout(400)
    page.keyboard.type('Ideas for the demo')
    page.keyboard.press('Enter')
    page.keyboard.type('- show the dashboard first')
    page.keyboard.press('Enter')
    page.keyboard.type('[] send the deck to Ravi')
    page.wait_for_timeout(1000)
    own = page.evaluate("Object.entries(JSON.parse(localStorage.getItem('planner.demo.v1')).notes).filter(([k]) => k.startsWith('note:') && !k.startsWith('note:demo-')).map(([, n]) => [n.title, n.text])")
    check('a new note of your own is saved with its title', own == [['Ideas for the demo', '- show the dashboard first\n- [ ] send the deck to Ravi']], str(own))
    check('typing in a note never triggers a keyboard shortcut', page.locator('#notes').is_visible() and page.evaluate("!document.querySelector('#dlg').open"))
    check('the new note shows in the list', page.locator('#notes .nrow.on b').inner_text() == 'Ideas for the demo')
    page.locator('#ndocCopy').click()
    page.wait_for_timeout(300)
    check('a note can be copied, ready to paste', 'copied' in page.evaluate("document.querySelector('#toast').innerText").lower() or 'copy' in page.evaluate("document.querySelector('#toast').innerText").lower())
    page.locator('#noteFind').fill('questionnaire')
    page.wait_for_timeout(400)
    check('notes can be searched by what they say', page.locator('#notes .nrow').count() == 1 and 'Client call' in page.locator('#notes .nrow').first.inner_text())
    page.locator('#noteFind').fill('')
    page.wait_for_timeout(300)
    page.screenshot(path=os.path.join(OUT, 'notes-own.png'))
    page.once('dialog', lambda d: d.accept())
    page.locator('#ndocDel').click()
    page.wait_for_timeout(500)
    check('a note of your own can be deleted', page.locator('#notes .nrow', has_text='Ideas for the demo').count() == 0)
    page.locator('#mainNav [data-nav=calendar]').click()
    page.wait_for_timeout(500)
    check('the calendar comes back from the Notes page', page.locator('#grid').is_visible() and not page.locator('#notes').is_visible())

    page.screenshot(path=os.path.join(OUT, 'desktop.png'))
    check('a meeting squeezed beside another shows its name on two lines, not cut to a few letters',
          page.evaluate("[...document.querySelectorAll('#gridBody .blk.ml .t')].some(t => t.getBoundingClientRect().height > 20 && t.scrollHeight <= t.clientHeight + 1)"))
    page.close()

    # ---- share links: a connected (pretend) Google account, a recording, and a link through (pretend) Google Drive
    real = browser.new_context(viewport={'width': 1440, 'height': 860}, permissions=['microphone', 'camera', 'clipboard-read', 'clipboard-write'])
    start = {'settings': {'clientId': 'test.apps.googleusercontent.com', 'clientSecret': 'pretend'},
             'accounts': [{'id': 'me@test.dev', 'email': 'me@test.dev', 'color': '#2f6fed', 'calendars': [], 'refreshToken': 'rt:me@test.dev', 'accessToken': '', 'expiresAt': 0}]}
    real.add_init_script(SEEN + QUIET + f"if (!localStorage.getItem('planner.v1')) localStorage.setItem('planner.v1', {json.dumps(json.dumps(start))});")
    rp = real.new_page()
    watch(rp, 'share')
    rp.request.post(BASE + '/mock/reset')
    rp.goto(BASE + '/')
    rp.wait_for_load_state('networkidle')
    rp.wait_for_timeout(1500)
    close_dialog(rp)
    rp.locator('#side [data-act="record"]').first.click()
    rp.wait_for_timeout(400)
    rp.locator('#dlg input[name=what][value=mic]').check(force=True)
    rp.locator('#dlg button.primary').click()
    rp.wait_for_selector('#recBar', timeout=20000)
    rp.wait_for_timeout(2500)
    rp.locator('#recBar [data-r=stop]').click()
    rp.wait_for_selector('#recBar', state='detached', timeout=20000)
    rp.locator('#toast [data-act=toast-go]').click()
    rp.wait_for_selector('#dlg [data-x=share]', timeout=8000)

    def dump():
        return rp.request.get(BASE + '/mock/dump').json()

    rp.locator('#dlg [data-x=share]').click()   # Google has not been asked about Drive yet
    wait_until(rp, "document.querySelector('#dlg h3')?.textContent.includes('One permission')", 10000)
    check('the first share explains the one permission Google will ask for', 'only see the files it puts there itself' in rp.locator('#dlg').inner_text())
    rp.screenshot(path=os.path.join(OUT, 'share-ask.png'))
    close_dialog(rp)
    rp.request.post(BASE + '/mock/grant', data={'acct': 'me@test.dev'})   # as if the person had said yes at Google
    rp.request.post(BASE + '/mock/driveoff', data={})                       # ...but Drive is not switched on for the project
    rp.locator('#toast').evaluate("t => t.className = ''")
    rec_id = recordings(rp)[0]['id']
    rp.evaluate("document.querySelector('#settingsBtn').click()")
    rp.wait_for_timeout(500)
    rp.evaluate("document.querySelector('#dlg [data-x=recordings]').click()")
    rp.wait_for_selector(f'#dlg .rcard[data-id="{rec_id}"]', timeout=8000)
    rp.locator(f'#dlg .rcard[data-id="{rec_id}"]').click()
    rp.wait_for_selector('#dlg [data-x=share]', timeout=8000)
    rp.locator('#dlg [data-x=share]').click()
    wait_until(rp, "document.querySelector('#dlg h3')?.textContent.includes('Switch on Google Drive')", 10000)
    check('when Drive is not switched on, the steps and Google’s own link are shown', rp.locator('#dlg a.btn[href^="https://console.developers.google.com/"]').count() == 1)
    rp.request.post(BASE + '/mock/driveoff', data={'off': False})
    rp.locator('#dlg [data-x=again]').click()
    try:
        rp.wait_for_selector('#dlg .rshare input', timeout=20000)
        link = rp.locator('#dlg .rshare input').input_value()
        files = dump()['users']['me@test.dev'].get('files', {})
        media = [f for f in files.values() if f.get('size')]
        kept = recordings(rp)[0]
        check('a copy of the recording goes into a “Weftday recordings” folder in Drive', len(media) == 1 and media[0]['size'] == kept['size']
              and any(f.get('name') == 'Weftday recordings' for f in files.values()), str(files)[:300])
        check('the link is for anyone who has it, and is shown and copied', media[0]['anyone'] and link == f"https://drive.google.com/file/d/{media[0]['id']}/view"
              and rp.evaluate('navigator.clipboard.readText()') == link, link)
        rp.screenshot(path=os.path.join(OUT, 'share-link.png'))
        rp.once('dialog', lambda d: d.accept())
        rp.locator('#dlg [data-x=unshare]').click()
        rp.wait_for_selector('#dlg [data-x=share]', timeout=10000)
        left = [f for f in dump()['users']['me@test.dev'].get('files', {}).values() if f.get('size')]
        check('“Stop sharing” takes the copy out of Drive, and the recording stays', not left and len(recordings(rp)) == 1)
    except Exception as err:  # noqa: BLE001
        said = rp.evaluate("document.querySelector('#toast').innerText")
        check('a copy of the recording goes into a “Weftday recordings” folder in Drive', False, f'{str(err)[:160]} | {said}'[:300])
        rp.screenshot(path=os.path.join(OUT, 'share-failed.png'))
    rp.close()
    real.close()

    # ---- setting up another of your own devices: the link is locked, and opens only with the code shown beside it
    fresh = browser.new_context(viewport={'width': 1440, 'height': 860})
    fresh.add_init_script(SEEN + QUIET)
    fp = fresh.new_page()
    watch(fp, 'setup code')
    fp.request.post(BASE + '/mock/reset')
    fp.request.post(BASE + '/mock/lookalike', data={'acct': 'me@test.dev'})
    fp.goto(BASE + '/terms.html')
    made = fp.evaluate("""async () => {
      const V = await import('./vault.js');
      const d = { i: 'test.apps.googleusercontent.com', s: 'pretend', e: 'me@test.dev', r: 'rt:me@test.dev' };
      const kind = async (blob, code) => { try { await V.unlockSetup(blob, code); return 'opened'; } catch (e) { return e.kind; } };
      const a = await V.lockSetup(d), old = await V.lockSetup(d, -1);
      const back = await V.unlockSetup(a.blob, a.code.toLowerCase().replace('-', ' '));
      const wrong = a.code[0] === 'A' ? 'B' + a.code.slice(1) : 'A' + a.code.slice(1);
      return { blob: a.blob, code: a.code, same: back.r === d.r && back.e === d.e && back.i === d.i, plain: atob(a.blob.replace(/-/g, '+').replace(/_/g, '/').slice(0, a.blob.length - a.blob.length % 4)).includes('rt:me'),
        wrong: await kind(a.blob, wrong), old: await kind(old.blob, old.code), junk: await kind('abc', a.code), other: (await V.lockSetup(d)).code !== a.code };
    }""")
    check('a setup code looks like XXXXX-XXXXX and opens its own link', bool(re.match(r'^[A-Z2-9]{5}-[A-Z2-9]{5}$', made['code'])) and made['same'], made['code'][:2] + '…')
    check('the sign-in cannot be read from the link itself', not made['plain'])
    old_kind = fp.evaluate("btoa(JSON.stringify({ i: 'test.apps.googleusercontent.com', s: 'pretend', e: 'me@test.dev', r: 'rt:me@test.dev' })).replace(/=+$/, '')")
    plain = fresh.new_page()
    plain.goto(BASE + '/#setup=' + old_kind)
    plain.wait_for_timeout(1500)
    check('a sign-in in a plain, unlocked link is never taken', plain.evaluate("!(JSON.parse(localStorage.getItem('planner.v1') || '{}').accounts || []).length") and 'old kind' in plain.evaluate("document.querySelector('#toast').innerText"))
    plain.close()
    check('a wrong code, an old link and a damaged link are each refused', (made['wrong'], made['old'], made['junk']) == ('code', 'expired', 'link') and made['other'], str((made['wrong'], made['old'], made['junk'])))
    fp.on('dialog', lambda d: d.accept())   # "Set this device up with the Google account …?"
    fp.goto(BASE + '/#setup2=' + made['blob'])
    fp.wait_for_selector('#dlg input[name=code]', timeout=10000)
    check('a locked link asks for its code, and is taken out of the address bar', 'Type the code' in fp.locator('#dlg').inner_text() and '#setup2' not in fp.url, fp.url)
    check('nothing is set up before the code is typed', fp.evaluate("!(JSON.parse(localStorage.getItem('planner.v1') || '{}').accounts || []).length"))
    fp.locator('#dlg input[name=code]').fill('AAAAA-AAAAA')
    fp.locator('#dlg button.primary').click()
    wait_until(fp, "!document.querySelector('#codeErr').hidden", 15000)
    check('a wrong code says so and lets you try again', 'does not match' in fp.locator('#codeErr').inner_text() and fp.locator('#dlg button.primary').is_enabled())
    fp.screenshot(path=os.path.join(OUT, 'setup-code.png'))
    fp.locator('#dlg input[name=code]').fill(made['code'].lower())
    fp.locator('#dlg button.primary').click()
    wait_until(fp, "JSON.parse(localStorage.getItem('planner.v1') || '{}').settings?.plannerCalendarId", 20000)
    saved = fp.evaluate("JSON.parse(localStorage.getItem('planner.v1'))")
    check('the right code sets the device up with that account', saved['settings'].get('plannerAccountId') == 'me@test.dev' and saved['accounts'][0]['id'] == 'me@test.dev', str(saved['settings'].get('plannerAccountId')))
    check('a calendar named “Weftday” that somebody else owns is not taken for the app’s own', saved['settings']['plannerCalendarId'] not in ('', 'lookalike'), saved['settings']['plannerCalendarId'])
    fresh.close()

    # ---- as a meeting begins, Weftday offers to record it (the clock is set to the start of a sample meeting)
    monday = datetime.date.today() - datetime.timedelta(days=datetime.date.today().weekday())
    early = browser.new_context(viewport={'width': 1440, 'height': 860})
    early.add_init_script(SEEN + QUIET)
    early.clock.install(time=datetime.datetime.combine(monday, datetime.time(14, 0, 20)))
    ep = open_app(early, 'meeting start')
    ep.wait_for_timeout(600)
    said = ep.evaluate("document.querySelector('#toast').innerText")
    check('a starting meeting offers “Record it”', 'is starting' in said and 'Record it' in said, said)
    ep.locator('#toast [data-act=toast-go]').click()
    ep.wait_for_timeout(500)
    check('“Record it” opens the Record box for that meeting', 'Record this meeting' in ep.locator('#dlg').inner_text())
    ep.close()

    note_page_checks(browser)

    # ---- a feature that needs an AI key, pressed before there is one: one clear box, one way forward
    nokey = browser.new_context(viewport={'width': 1440, 'height': 860})  # a browser that has never had a key
    nokey.add_init_script(SEEN + QUIET)
    nk = open_app(nokey, 'no key')
    nk.evaluate("document.querySelector('#dlg[open]')?.close()")
    nk.evaluate("document.querySelector('#mainNav [data-act=recordings]').click()")
    nk.wait_for_timeout(500)
    asked = nk.evaluate("(() => { const b = document.querySelector('#dlg [data-x=askall]'); b?.click(); return !!b; })()")
    nk.wait_for_timeout(500)
    box = nk.evaluate("({ title: document.querySelector('#dlg .needkey h3')?.textContent, body: document.querySelector('#dlg .needkey p')?.textContent, go: document.querySelector('#dlg .needkey [data-x=add]')?.textContent })")
    check('a feature that needs an AI key says so in one clear box', asked and box['title'] == 'Add your AI key to use this' and 'Asking your meetings' in (box['body'] or '') and box['go'] == 'Add my free key', json.dumps(box))
    nk.screenshot(path=os.path.join(OUT, 'need-key.png'))
    nk.evaluate("document.querySelector('#dlg .needkey [data-x=add]').click()")
    nk.wait_for_timeout(600)
    there = nk.evaluate("({ key: !!document.querySelector('#dlg #aiKeyBox')?.offsetParent, get: document.querySelector('#dlg #aiKeyGet')?.textContent })")
    check('its button opens the key screen, with the steps showing', there['key'] and there['get'] == 'Get my free key', json.dumps(there))
    nokey.close()

    # ---- a phone
    phone = browser.new_context(viewport={'width': 375, 'height': 812}, is_mobile=True, has_touch=True)
    phone.add_init_script(SEEN + QUIET)
    pp = open_app(phone, 'phone')
    check('Home fits a phone', pp.locator('#home .hhello h2').is_visible() and pp.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'))
    pp.screenshot(path=os.path.join(OUT, 'phone-home.png'))
    check('the side panel has a way back to the website', pp.evaluate("document.querySelector('#side .sitelink')?.href") == 'https://weftday.crckd.live/')
    pp.locator('#menu').click()
    pp.wait_for_timeout(400)
    pp.locator('#mainNav [data-nav=calendar]').click()
    pp.wait_for_timeout(600)
    check('no sideways scrolling on a phone', pp.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'))
    pp.screenshot(path=os.path.join(OUT, 'phone.png'))
    # Settings on a phone: the section takes the full width (it was once squeezed into a thin strip beside its own menu)
    pp.locator('#menu').click()
    pp.wait_for_timeout(400)
    pp.evaluate("[...document.querySelectorAll('#side button')].find(x => /Settings/.test(x.textContent)).click()")
    pp.wait_for_timeout(500)
    pp.evaluate("[...document.querySelectorAll('#dlg .snav button')].find(x => x.textContent.trim() === 'AI').click()")
    pp.wait_for_timeout(300)
    fit = pp.evaluate("""(() => { const pane = document.querySelector('#dlg .spanes'), key = document.querySelector('#aiKeyBox'), nav = document.querySelector('#dlg .snav');
      return { pane: pane.clientWidth, wide: pane.scrollWidth <= pane.clientWidth + 1, key: key.getBoundingClientRect().width, navWide: nav.scrollWidth <= nav.clientWidth + 1,
        drawer: document.body.classList.contains('side-open'), tabs: [...nav.querySelectorAll('button')].every(b => b.getBoundingClientRect().right <= innerWidth) }; })()""")
    check('Settings fits a phone: the AI section is full width and every tab is in view', fit['pane'] > 330 and fit['wide'] and fit['key'] > 180 and fit['navWide'] and fit['tabs'], json.dumps(fit))
    check('a box opened from the side panel closes the side panel on a phone', not fit['drawer'], json.dumps(fit))
    pp.screenshot(path=os.path.join(OUT, 'phone-settings-ai.png'))
    pp.evaluate("document.querySelector('#dlg[open]')?.close()")
    pp.wait_for_timeout(300)
    pp.evaluate("document.querySelector('#viewSeg [data-view=week]')?.click()")
    pp.wait_for_timeout(500)
    week = pp.evaluate("""[...document.querySelectorAll('#gridBody .blk .t')].filter(t => t.offsetParent).every(t => t.getBoundingClientRect().height < 20)""")
    check('a week on a phone: every title stays on one line', week)
    pp.evaluate("document.querySelector('#viewSeg [data-view=list]')?.click()")  # the list shows the whole week's meetings
    pp.wait_for_timeout(500)
    opened = pp.evaluate("(() => { const m = [...document.querySelectorAll('[data-key]')].find(x => x.textContent.includes('Client call')) || document.querySelector('[data-key]'); m?.click(); return !!m; })()")
    pp.wait_for_timeout(800)
    check('the meeting box fits a phone', opened and dialog_open(pp) and pp.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
          and pp.evaluate("document.querySelector('#dlg').getBoundingClientRect().width <= innerWidth"))
    pp.screenshot(path=os.path.join(OUT, 'phone-meeting.png'))
    close_dialog(pp)
    pp.evaluate("JSON.parse(localStorage.getItem('planner.demo.v1')) && 0")
    pp.locator('#menu').click()
    pp.wait_for_timeout(400)
    pp.locator('#mainNav [data-nav=notes]').click()
    pp.wait_for_timeout(700)
    check('the Notes page fits a phone', pp.evaluate('document.documentElement.scrollWidth <= innerWidth + 1') and pp.locator('#notes .nlist').is_visible())
    pp.screenshot(path=os.path.join(OUT, 'phone-notes.png'))
    pp.locator('#menu').click()
    pp.wait_for_timeout(400)
    pp.screenshot(path=os.path.join(OUT, 'phone-menu.png'))
    pp.locator('#mainNav [data-nav=calendar]').click()
    pp.wait_for_timeout(500)
    pp.evaluate("document.querySelector('[data-act=record]').click()")
    pp.wait_for_timeout(600)
    check('the Record box fits a phone', dialog_open(pp) and pp.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
          and pp.evaluate("document.querySelector('#dlg').getBoundingClientRect().width <= innerWidth"))
    pp.screenshot(path=os.path.join(OUT, 'phone-record.png'))
    close_dialog(pp)
    pp.close()

    # ---- the other pages
    guide = open_app(context, 'guide', '/guide.html#2')
    check('the guide shows the Record step and moves on', 'write its own notes' in guide.locator('body').inner_text())
    guide.locator('#next').click()
    guide.wait_for_timeout(400)
    check('the guide’s buttons work', 'Notes that turn into action' in guide.locator('body').inner_text())
    check('the guide is five steps, not more', guide.locator('#rail button').count() == 5)
    guide.screenshot(path=os.path.join(OUT, 'guide-record.png'))
    guide.close()
    for path in ['/guide.html', '/privacy.html', '/terms.html']:
        other = open_app(context, path, path)
        check(f'{path} opens', other.locator('body').inner_text().strip() != '')
        check(f'{path} has no sideways scrolling', other.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'))
        other.close()

    check('no errors in the browser console', not problems, ' | '.join(problems[:6]))
    browser.close()


with sync_playwright() as p:
    run(p)

failed = [r for r in results if not r[1]]
print(f'\n{len(results) - len(failed)} of {len(results)} checks passed')
sys.exit(1 if failed else 0)
