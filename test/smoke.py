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

    # ---- the recorder: microphone only
    page.locator('#side [data-act="record"]').first.click()
    page.wait_for_timeout(400)
    page.locator('#dlg input[name=what][value=mic]').check()
    page.locator('#dlg button.primary').click()
    try:
        page.wait_for_selector('#recBar', timeout=15000)
    except Exception:  # noqa: BLE001
        page.screenshot(path=os.path.join(OUT, 'mic-recording-failed.png'))
        print('   toast:', page.evaluate("document.querySelector('#toast').innerText"), '| bar in page:', page.locator('#recBar').count(),
              '| box:', page.evaluate("document.querySelector('#dlg').innerText.slice(0, 200)"))
        raise
    check('recording starts (microphone)', page.locator('#recBar').is_visible())
    page.wait_for_timeout(3200)
    page.locator('#recBar [data-r=stop]').click()
    page.wait_for_selector('#recBar', state='detached', timeout=20000)
    recs = recordings(page)
    mic = recs[0] if recs else {}
    check('recording is saved', bool(recs) and mic.get('done') and mic.get('size', 0) > 1000 and mic.get('secs', 0) >= 2, str(mic))

    # ---- the recorder: a tab with its picture (the pretend screen is this very tab)
    if page.evaluate("!!navigator.mediaDevices.getDisplayMedia"):
        page.locator('#side [data-act="record"]').first.click()
        page.wait_for_timeout(400)
        page.locator('#dlg input[name=what][value=video]').check()
        page.locator('#dlg button.primary').click()
        try:
            page.wait_for_selector('#recBar', timeout=20000)
            page.wait_for_timeout(4200)
            page.locator('#recBar [data-r=stop]').click()
            page.wait_for_selector('#recBar', state='detached', timeout=30000)
            recs = recordings(page)
            vid = next((r for r in recs if r['kind'] == 'video'), {})
            check('screen recording is saved as a video', vid.get('done') and vid.get('size', 0) > 20000, str(vid))
        except Exception as err:  # noqa: BLE001
            check('screen recording is saved as a video', False, str(err)[:200])
            page.screenshot(path=os.path.join(OUT, 'screen-recording-failed.png'))
            close_dialog(page)

    # ---- the recordings list, one recording, and delete
    recs = recordings(page)
    if recs:
        page.locator('#searchBtn').click()
        page.wait_for_timeout(300)
        page.keyboard.type('recordings')
        page.wait_for_timeout(300)
        page.keyboard.press('Enter')
        page.wait_for_timeout(600)
        check('the recordings list opens', dialog_open(page) and page.locator('#dlg [data-id]').count() >= 1)
        page.locator('#dlg [data-id]').first.click()
        page.wait_for_timeout(900)
        check('a recording opens with a player', page.locator('#dlg .rplay').count() == 1)
        page.screenshot(path=os.path.join(OUT, 'recording.png'))
        close_dialog(page)

    page.screenshot(path=os.path.join(OUT, 'desktop.png'))
    page.close()

    # ---- a phone
    phone = browser.new_context(viewport={'width': 375, 'height': 812}, is_mobile=True, has_touch=True)
    phone.add_init_script(SEEN + QUIET)
    pp = open_app(phone, 'phone')
    check('no sideways scrolling on a phone', pp.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'))
    pp.screenshot(path=os.path.join(OUT, 'phone.png'))
    pp.close()

    # ---- the other pages
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
