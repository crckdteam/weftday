"""Makes the website's pictures and its short clip from the real app with its sample data.
Run by hand after a change to how the app looks:

    PORT=4398 node test/mock-google.mjs &
    .venv/bin/python tools/site-media.py            (pictures and the clip)
    .venv/bin/python tools/site-media.py pictures   (pictures only)

Pictures go to site/img/ at twice the size they are shown, the clip to site/video/tour.webm."""
import os, shutil, sys, datetime
from playwright.sync_api import sync_playwright
BASE = os.environ.get('WEFTDAY_URL', 'http://localhost:4398')
ROOT = os.path.join(os.path.dirname(__file__), '..', 'site')
IMG, VID = os.path.join(ROOT, 'img'), os.path.join(ROOT, 'video')
SEEN = "localStorage.setItem('weftday.seenHome','1');localStorage.setItem('weftday.toured','1');localStorage.setItem('weftday.tips', JSON.stringify({meeting:1,person:1,today:1,people:1,free:1,plan:1,record:1,library:1}));"
only = sys.argv[1] if len(sys.argv) > 1 else ''
# The pictures are taken as if it were mid-morning on the Wednesday of this week, so the day looks alive.
today = datetime.date.today(); wed = today - datetime.timedelta(days=today.weekday()) + datetime.timedelta(days=2)
NOW = datetime.datetime.combine(wed, datetime.time(9, 12))

def ready(c):
    c.add_init_script(SEEN); c.clock.install(time=NOW)
    p = c.new_page(); p.goto(BASE + '/?demo'); p.wait_for_timeout(1500)
    p.evaluate("document.querySelector('#dlg[open]')?.close()"); p.wait_for_timeout(300)
    return p
def nav(p, name): p.evaluate(f"document.querySelector('#mainNav [data-nav={name}]').click()"); p.wait_for_timeout(500)
def week(p): nav(p, 'calendar'); p.evaluate("document.querySelector('#grid').scrollTop = 52 * 8.6"); p.wait_for_timeout(300)

with sync_playwright() as pw:
    b = pw.chromium.launch(channel='chrome', headless=True)
    if only in ('', 'pictures'):
        for scheme in ('light', 'dark'):
            s = '' if scheme == 'light' else '-dark'
            c = b.new_context(viewport={'width': 1360, 'height': 850}, device_scale_factor=2, color_scheme=scheme); p = ready(c)
            shot = lambda name: (p.wait_for_timeout(350), p.screenshot(path=os.path.join(IMG, name + s + '.png')))
            shot('home')
            week(p); shot('calendar')
            p.locator('#gridBody [data-key]', has_text='Client call').first.click(); p.wait_for_timeout(900); shot('meeting')
            p.evaluate("document.querySelector('#dlg[open]')?.close()"); p.wait_for_timeout(300)
            nav(p, 'notes'); p.locator('#notes .nrow', has_text='Client call').click(); p.wait_for_timeout(600); shot('notes')
            box = lambda name: (p.wait_for_timeout(350), p.locator('#dlg').screenshot(path=os.path.join(IMG, name + s + '.png')))
            nav(p, 'home'); p.evaluate("document.querySelector('#recBtn').click()"); p.wait_for_timeout(600); box('record')
            p.evaluate("document.querySelector('#dlg[open]')?.close()")
            p.evaluate("document.querySelector('#mainNav [data-act=people]').click()"); p.wait_for_timeout(1200); box('people')
            c.close()
        c = b.new_context(viewport={'width': 390, 'height': 800}, device_scale_factor=2); p = ready(c)
        p.wait_for_timeout(300); p.screenshot(path=os.path.join(IMG, 'phone.png')); c.close()
    if only in ('', 'clip'):
        tmp = os.path.join(VID, '_tmp'); shutil.rmtree(tmp, ignore_errors=True)
        c = b.new_context(viewport={'width': 1280, 'height': 800}, record_video_dir=tmp, record_video_size={'width': 1280, 'height': 800})
        c.add_init_script("""addEventListener('DOMContentLoaded', () => { const d = document.createElement('div'); d.id = '__cur';
          d.style.cssText = 'position:fixed;z-index:2147483647;left:0;top:0;width:22px;height:22px;margin:-4px 0 0 -4px;pointer-events:none;transition:transform .08s linear;background:no-repeat center/contain url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27%3E%3Cpath d=%27M5 3l14 8-6.500 1.500L10 19z%27 fill=%27%2317201b%27 stroke=%27%23fff%27 stroke-width=%271.500%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E")';
          document.documentElement.append(d); addEventListener('mousemove', e => { d.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`; }, true); });""".replace('.500', '.5'))
        p = ready(c)
        def go(sel, wait=900, click=True, text=None):
            loc = p.locator(sel, has_text=text).first if text else p.locator(sel).first
            box = loc.bounding_box(); x, y = box['x'] + min(box['width'] / 2, 60), box['y'] + box['height'] / 2
            p.mouse.move(x, y, steps=28); p.wait_for_timeout(260)
            if click: p.mouse.click(x, y)
            p.wait_for_timeout(wait)
        p.mouse.move(640, 420, steps=4); p.wait_for_timeout(1400)
        go('#recBtn', 2300); p.keyboard.press('Escape'); p.wait_for_timeout(500)
        go('#mainNav [data-nav=calendar]', 400); p.evaluate("document.querySelector('#grid').scrollTo({ top: 52 * 8.6, behavior: 'smooth' })"); p.wait_for_timeout(2000)
        go('#gridBody [data-key]', 2600, text='Client call')
        go('#dlg .ed .b.todo', 1300)
        p.keyboard.press('Escape'); p.wait_for_timeout(500)
        go('#mainNav [data-nav=notes]', 1500)
        go('#notes .nrow', 2200, text='Weekend list')
        go('#mainNav [data-nav=home]', 1800)
        video = p.video; c.close()
        shutil.move(video.path(), os.path.join(VID, 'tour.webm')); shutil.rmtree(tmp, ignore_errors=True)
    if only in ('', 'card'):
        # The picture shown when the website is shared (og.png), and the one on the GitHub page (cover.png).
        # The website itself must be being served: python3 -m http.server 4380 --directory site
        html = """<base href="http://localhost:4380/"><link rel="stylesheet" href="site.css"><style>
          body { width: 100vw; height: 100vh; overflow: hidden; position: relative; }
          .c { position: absolute; left: 72px; top: 66px; right: 60px; }
          .m { display: flex; align-items: center; gap: 14px; font: 700 34px/1 var(--display); letter-spacing: -.02em; }
          h1 { font: 700 78px/.98 var(--display); letter-spacing: -.03em; margin-top: 58px; }
          p { font-size: 27px; line-height: 1.35; color: var(--on-box-soft); margin-top: 26px; max-width: 15em; }
          .s { position: absolute; left: 60%; top: 210px; width: 900px; }
          .s .card { margin: 0; padding: 12px; }
          .s img { border-radius: 14px; }</style>
          <div class="c"><div class="m"><img src="icon.svg" width="50" height="50">Weftday</div><h1>Your day,<br>woven together.</h1><p>Calendar, meeting recorder and notes that write themselves. Free and open source.</p></div>
          <div class="s"><section class="card first"><div class="dividers"><i class="t-record"></i><i class="t-notes"></i><i class="t-calendar"></i><i class="t-people"></i><i class="t-yours"></i></div><img src="img/home.png"></section></div>"""
        for name, w, h in (('og.png', 1200, 630), (os.path.join('img', 'cover.png'), 1280, 640)):
            c = b.new_context(viewport={'width': w, 'height': h}, reduced_motion='reduce'); p = c.new_page()
            p.goto('http://localhost:4380/404.html'); p.set_content(html); p.wait_for_timeout(1500); p.screenshot(path=os.path.join(ROOT, name)); c.close()
    b.close()
print('done')
