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


def run(p):
    browser = p.chromium.launch(channel='chrome', headless=True, args=[
        '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
        '--auto-select-tab-capture-source-by-title=Weftday', '--autoplay-policy=no-user-gesture-required',
    ])
    context = browser.new_context(viewport={'width': 1440, 'height': 860}, permissions=['microphone', 'camera'])
    context.add_init_script(SEEN + QUIET)

    # ---- the main screen
    page = open_app(context)
    check('app opens with the sample data', page.locator('#gridBody .ev, #gridBody [data-key]').count() > 0 or page.locator('#grid').is_visible())
    check('no sideways scrolling on a computer', page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'))

    # ---- every tool in the side panel opens its box
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
    ev = page.locator('#gridBody [data-key]').first
    if ev.count():
        ev.click()
        page.wait_for_timeout(600)
        check('a meeting opens', dialog_open(page))
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
    box.fill('ask about the pilot')
    page.wait_for_timeout(5600)
    page.screenshot(path=os.path.join(OUT, 'meeting-recording.png'))
    page.locator('#recBar [data-r=stop]').click()
    try:
        wait_until(page, "document.querySelector('#toast').innerText.includes('Notes written')", 30000)
        written = box.input_value()
        check('notes are written by themselves when the recording ends', 'Summary' in written and 'Send the contract by Friday' in written, written[:200])
        check('what you typed is blended in and kept', seen.get('rough') and written.rstrip().endswith('ask about the pilot'), written[-120:])
        check('the AI is told who was in the meeting', seen.get('people'))
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

    page.screenshot(path=os.path.join(OUT, 'desktop.png'))
    page.close()

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

    # ---- a phone
    phone = browser.new_context(viewport={'width': 375, 'height': 812}, is_mobile=True, has_touch=True)
    phone.add_init_script(SEEN + QUIET)
    pp = open_app(phone, 'phone')
    check('no sideways scrolling on a phone', pp.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'))
    pp.screenshot(path=os.path.join(OUT, 'phone.png'))
    pp.evaluate("document.querySelector('[data-act=record]').click()")
    pp.wait_for_timeout(600)
    check('the Record box fits a phone', dialog_open(pp) and pp.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
          and pp.evaluate("document.querySelector('#dlg').getBoundingClientRect().width <= innerWidth"))
    pp.screenshot(path=os.path.join(OUT, 'phone-record.png'))
    close_dialog(pp)
    pp.close()

    # ---- the other pages
    guide = open_app(context, 'guide', '/guide.html#8')
    check('the guide shows the Record step and moves on', 'write its own notes' in guide.locator('body').inner_text())
    guide.locator('#next').click()
    guide.wait_for_timeout(400)
    check('the guide’s buttons work', 'Share when you are free' in guide.locator('body').inner_text())
    guide.screenshot(path=os.path.join(OUT, 'guide-record.png'))
    guide.close()
    for path in ['/home.html', '/guide.html', '/about.html', '/privacy.html']:
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
