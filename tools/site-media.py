"""Makes the website's pictures and its share cards from the real app with its sample data.
Run by hand after a change to how the app looks. The app must be open at http://localhost:4398
(PORT=4398 node test/mock-google.mjs) and the website at http://localhost:4380
(python3 -m http.server 4380 --directory site):

    .venv/bin/python tools/site-media.py            (the pictures, then the share cards)
    .venv/bin/python tools/site-media.py pictures   (the pictures only)
    .venv/bin/python tools/site-media.py card       (the share cards only)

Each picture is one part of the app, taken at the size it is shown on the website, so that the
words in it can be read: a wide one for computers and a second one, taken from the app on a
phone-sized screen, for phones. They go to site/img/ at twice their shown size, and the sizes
written in site/index.html are brought up to date.

The share cards are the picture shown when the website's address is passed around (site/og.png)
and the one at the top of the GitHub page (site/img/cover.png). They are drawn with the website's
own stylesheet around a fresh picture of the app's Home screen.

The short clip and its two stills are made by tools/site-clip.py."""
import base64, datetime, math, os, re, struct, sys
from playwright.sync_api import sync_playwright
BASE = os.environ.get('WEFTDAY_URL', 'http://localhost:4398')
SITE = os.environ.get('WEFTDAY_SITE_URL', 'http://localhost:4380')
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'site')
IMG = os.path.join(ROOT, 'img')
SEEN = "localStorage.setItem('weftday.seenHome','1');localStorage.setItem('weftday.toured','1');localStorage.setItem('weftday.tips', JSON.stringify({meeting:1,person:1,today:1,people:1,free:1,plan:1,record:1,library:1}));"
# A box is taken without the dimmed page behind it and without its own edge: the website draws the corners and the shadow.
BARE = "dialog::backdrop { background: transparent !important; backdrop-filter: none !important; } #dlg { border: 0 !important; border-radius: 0 !important; box-shadow: none !important; animation: none !important; }"
# The dot that says "you have notes on this one" is 7px in the app's own rule, but a wider rule for the dates beside it
# stretches it into a bar. Until that is put right in public/styles.css, the pictures show the dot as it is meant to be.
BARE += " .plist2 .nmark { min-width: 0 !important; }"
WIDE, PHONE = (1360, 850), (390, 900)   # the two screens the app is shown on
CAL_DAYS = 3                            # the calendar picture runs from Monday to Wednesday
only = sys.argv[1] if len(sys.argv) > 1 else ''
# The pictures are taken as if it were mid-morning on the Wednesday of this week, so the day looks alive.
today = datetime.date.today(); wed = today - datetime.timedelta(days=today.weekday()) + datetime.timedelta(days=2)
NOW = datetime.datetime.combine(wed, datetime.time(9, 12))
# The week is pictured a little later the same day, when the line that marks the time crosses an empty stretch, not a title.
LUNCH = datetime.datetime.combine(wed, datetime.time(12, 48))

def ready(c, now=NOW):
    c.add_init_script(SEEN); c.clock.install(time=now)
    c.route(lambda url: not url.startswith(BASE), lambda route: route.abort())   # nothing is fetched from outside while the pictures are taken
    p = c.new_page(); p.goto(BASE + '/?demo'); p.wait_for_timeout(1500)
    shut(p); p.add_style_tag(content=BARE)
    return p
def shut(p): p.evaluate("document.querySelector('#dlg[open]')?.close()"); p.wait_for_timeout(300)
def nav(p, name): p.evaluate(f"document.querySelector('#mainNav [data-nav={name}]').click()"); p.wait_for_timeout(500)
def tall(p, h): p.set_viewport_size({'width': p.viewport_size['width'], 'height': h}); p.wait_for_timeout(400)
def cut(p, name, x, y, w, h):
    # whole pixels only, a hair inside the edge, so that no sliver of what is behind comes along
    x2, y2 = math.floor(x + w), math.floor(y + h); x, y = math.ceil(x), math.ceil(y)
    p.wait_for_timeout(350); p.screenshot(path=os.path.join(IMG, name + '.png'), clip={'x': x, 'y': y, 'width': x2 - x, 'height': y2 - y})
def edge(p, css, text='', side='top'):
    # where on the screen the first thing matching `css` (and starting with `text`) begins or ends; 0 if it is not there
    return p.evaluate("([css, text, side]) => { const e = [...document.querySelectorAll(css)].find(e => e.textContent.trim().startsWith(text)); return e ? e.getBoundingClientRect()[side] : 0 }", [css, text, side])
def box(p, name, end=0):
    # the open box or panel; `end` stops the picture early, at a gap between two parts, so that no line is cut in half
    r = p.locator('#dlg').bounding_box(); cut(p, name, r['x'], r['y'], r['width'], end - r['y'] if end else r['height'])
def panel(p, name, css, text):
    # a side panel, made just tall enough to end above the heading that says `text`; its Close button stays at the foot
    top, foot = edge(p, css, text), p.locator('#dlg .actions').bounding_box()
    if top and foot: tall(p, round(top - 10 + foot['height']))
    p.evaluate("document.querySelector('#dlg').scrollTop = 0"); box(p, name)
def meeting(p): p.locator('#gridBody [data-key]', has_text='Client call').first.click(); p.wait_for_timeout(900)
def person(p):
    p.evaluate("document.querySelector('#mainNav [data-act=people]').click()"); p.wait_for_timeout(1000)
    p.locator('#dlg [data-x=person]', has_text='Ravi Menon').click(); p.wait_for_timeout(1000)
    p.locator('#dlg textarea[name=about]').fill('Decides on the budget. Likes a written plan before a call.'); p.wait_for_timeout(300)
    p.evaluate("document.activeElement.blur()"); p.wait_for_timeout(300)
def png_size(path):
    with open(path, 'rb') as f: return struct.unpack('>II', f.read(24)[16:24])
def sizes_into_page():
    # the width and height beside each picture in index.html, so that the page keeps room for it before it loads
    page = os.path.join(ROOT, 'index.html'); html = open(page, encoding='utf-8').read()
    def fix(m):
        w, h = png_size(os.path.join(ROOT, m.group(2)))
        return f'{m.group(1)}="{m.group(2)}" width="{w}" height="{h}"'
    new = re.sub(r'\b(src|srcset)="(img/[a-z-]+\.png)" width="\d+" height="\d+"', fix, html)
    if new != html: open(page, 'w', encoding='utf-8').write(new)

with sync_playwright() as pw:
    b = pw.chromium.launch(channel='chrome', headless=True)
    if only in ('', 'pictures'):
        # on a computer
        c = b.new_context(viewport={'width': WIDE[0], 'height': WIDE[1]}, device_scale_factor=2); p = ready(c)
        p.evaluate("document.querySelector('#recBtn').click()"); p.wait_for_timeout(700); box(p, 'record'); shut(p)
        nav(p, 'calendar'); tall(p, 1100); meeting(p); panel(p, 'notes', '#dlg .ed .sec', 'Open questions'); shut(p)
        tall(p, 1100); person(p); panel(p, 'people', '#dlg h4', 'Your notes from meetings'); shut(p)
        c.close()
        c = b.new_context(viewport={'width': WIDE[0], 'height': WIDE[1]}, device_scale_factor=2); p = ready(c, LUNCH)
        # the calendar: Monday to Wednesday, from nine in the morning to nine at night, where both accounts and the tasks show.
        # The nine o'clock line is brought just under the row of days, so that no meeting is cut in half at the top.
        nav(p, 'calendar'); tall(p, 820)
        p.evaluate("""() => { const grid = document.querySelector('#grid'), head = document.querySelector('#gridHead').getBoundingClientRect().bottom;
            const nine = [...grid.querySelectorAll('.gutter *')].find(e => e.textContent.trim() === '9am');
            if (nine) { const r = nine.getBoundingClientRect(); grid.scrollTop += r.top + r.height / 2 - head - 12; } }"""); p.wait_for_timeout(300)
        pane = p.locator('main').bounding_box(); day = p.locator('#gridBody .col').nth(CAL_DAYS - 1).bounding_box()
        night = edge(p, '#grid .gutter *', '9pm')
        cut(p, 'calendar', pane['x'] + 1, pane['y'] + 1, day['x'] + day['width'] - pane['x'] - 1, (night - 6 if night else pane['y'] + 760) - pane['y'] - 1)
        c.close()
        # on a phone
        c = b.new_context(viewport={'width': PHONE[0], 'height': PHONE[1]}, device_scale_factor=2, is_mobile=True, has_touch=True); p = ready(c)
        p.evaluate("document.querySelector('#recBtn').click()"); p.wait_for_timeout(700); box(p, 'record-phone'); shut(p)
        nav(p, 'calendar'); p.locator('#viewSeg [data-view=list]').click(); p.wait_for_timeout(600)
        cut(p, 'calendar-phone', 0, 0, PHONE[0], (edge(p, '#list .lday', '', 'bottom') or 700) + 6)
        p.locator('#viewSeg [data-view=day]').click(); p.evaluate("document.querySelector('#prev').click(); document.querySelector('#prev').click()"); p.wait_for_timeout(500)
        meeting(p); box(p, 'notes-phone', (edge(p, '#dlg .airow', '', 'bottom') or 0) + 16); shut(p)
        person(p); box(p, 'people-phone', edge(p, '#dlg h4', 'Your notes from meetings') - 12); shut(p)
        c.close()
        sizes_into_page()
    if only in ('', 'card'):
        # The app's Home screen, as it is on a computer.
        c = b.new_context(viewport={'width': WIDE[0], 'height': WIDE[1]}, device_scale_factor=2); p = ready(c)
        home = base64.b64encode(p.screenshot()).decode(); c.close()
        # The card: the website's own headline on its green ground, and beside it a card from the drawer, with its
        # tabs, holding that picture. It is drawn by the website's stylesheet, so the website must be being served.
        page = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
        tabs = ''.join(f'<a class="t-{name}"><svg><use href="#i-{name}"/></svg></a>' for name in ('record', 'notes', 'calendar', 'people', 'yours', 'open'))
        html = f"""<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/site.css"><style>
          body {{ width: 100vw; height: 100vh; overflow: hidden; position: relative; }}
          .c {{ position: absolute; left: 72px; top: 66px; right: 60px; }}
          .m {{ display: flex; align-items: center; gap: 14px; font: 700 34px/1 var(--display); letter-spacing: -.02em; }}
          h1 {{ font: 700 78px/.98 var(--display); letter-spacing: -.03em; margin-top: 58px; }}
          p {{ font-size: 27px; line-height: 1.35; color: var(--on-box-soft); margin-top: 26px; max-width: 15em; }}
          .s {{ position: absolute; left: 60%; top: 210px; width: 900px; }}
          .s .card {{ margin: 0; padding: 12px; }}
          .s .frame {{ border-radius: 14px; }}</style>
          {re.search(r'<svg class="sprite".*?</svg>', page, re.S).group(0)}
          <div class="c"><div class="m"><img src="/icon.svg" width="50" height="50" alt="">Weftday</div><h1>Your day,<br>woven together.</h1><p>Calendar, meeting recorder and notes that write themselves. Free and open source.</p></div>
          <div class="s"><section class="card first"><div class="dividers">{tabs}</div><div class="frame"><img src="data:image/png;base64,{home}" alt=""></div></section></div>"""
        for name, w, h in (('og.png', 1200, 630), (os.path.join('img', 'cover.png'), 1280, 640)):
            c = b.new_context(viewport={'width': w, 'height': h}, reduced_motion='reduce')
            c.route(SITE + '/share-card', lambda route: route.fulfill(body=html, content_type='text/html; charset=utf-8'))
            p = c.new_page(); p.goto(SITE + '/share-card'); p.evaluate('document.fonts.ready'); p.wait_for_timeout(800)
            p.screenshot(path=os.path.join(ROOT, name)); c.close()
    b.close()
print('done')
