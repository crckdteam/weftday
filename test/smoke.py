"""Browser check of Weftday: opens the real app in Chrome (no window) and clicks through it.

It uses the sample data (?demo), a pretend microphone, camera and screen, and the Chrome that is
already installed. Nothing leaves this computer.

Run it with the server started for you:
    tools/check.sh
or by hand, with the test server already running on port 4322:
    .venv/bin/python test/smoke.py
"""
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
        page.locator(f'#dlg input[name=what][value={kind}]').check()
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
    check('the library can show videos only', page.locator('#dlg .rcard').count() == 2)
    page.locator(f'#dlg .rcard[data-id="{video["id"]}"]').click()
    page.wait_for_selector('#dlg video.rplay', timeout=8000)
    wait_until(page, "Number.isFinite(document.querySelector('#dlg video.rplay').duration)", 8000)
    length = page.evaluate("document.querySelector('#dlg video.rplay').duration")
    check('the video knows its own length', 2 <= length <= 12, str(length))
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

    page.screenshot(path=os.path.join(OUT, 'desktop.png'))
    page.close()

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
    check('the guide shows the Record step and moves on', 'Record it' in guide.locator('body').inner_text())
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
