"""Pictures of the main screens, for looking at a design change. Run by hand:
    PORT=4398 node test/mock-google.mjs &   then   .venv/bin/python test/shots.py [name ...]
They are saved in test/.out/shots/."""
import os, sys
from playwright.sync_api import sync_playwright
BASE = os.environ.get('WEFTDAY_URL', 'http://localhost:4398')
OUT = os.path.join(os.path.dirname(__file__), '.out', 'shots'); os.makedirs(OUT, exist_ok=True)
SEEN = "localStorage.setItem('weftday.seenHome','1');localStorage.setItem('weftday.toured','1');localStorage.setItem('weftday.tips', JSON.stringify({meeting:1,person:1,today:1,people:1,free:1,plan:1,record:1,library:1}));"
want = set(sys.argv[1:])
def on(name): return not want or name in want

def app(b, vp=(1440, 860), scheme='light', seen=True, path='/?demo'):
    c = b.new_context(viewport={'width': vp[0], 'height': vp[1]}, color_scheme=scheme, device_scale_factor=2 if os.environ.get('RETINA') else 1)
    if seen: c.add_init_script(SEEN)
    p = c.new_page(); p.goto(BASE + path); p.wait_for_timeout(1300)
    return c, p
def snap(p, name): p.wait_for_timeout(350); p.screenshot(path=os.path.join(OUT, name + '.png'))
def js(p, code): return p.evaluate(code)
def shut(p): js(p, "document.querySelector('#dlg[open]')?.close()"); p.wait_for_timeout(150)

with sync_playwright() as pw:
    b = pw.chromium.launch(channel='chrome', headless=True)
    for scheme in ('light', 'dark'):
        s = '' if scheme == 'light' else '-dark'
        c, p = app(b, scheme=scheme); shut(p)
        if on('home'): snap(p, 'home' + s)
        if on('calendar'):
            js(p, "document.querySelector('#mainNav [data-nav=calendar]').click()"); p.wait_for_timeout(400)
            js(p, "document.querySelector('#grid').scrollTop = 52*8.4"); snap(p, 'calendar' + s)
            js(p, "document.querySelector('#gridBody .blk.ev')?.click()"); snap(p, 'meeting' + s); shut(p)
        if on('notes'):
            js(p, "document.querySelector('#mainNav [data-nav=notes]').click()"); snap(p, 'notes' + s)
        if on('settings'):
            js(p, "[...document.querySelectorAll('#side button, #side a')].find(x => /Settings/.test(x.textContent))?.click()"); snap(p, 'settings' + s)
            for i in range(1, 6):
                ok = js(p, f"(() => {{ const t = document.querySelectorAll('#dlg .stabs button, #dlg [data-tab], #dlg .snav button')[{i}]; if (!t) return false; t.click(); return true; }})()")
                if not ok: break
                snap(p, f'settings{i}' + s)
            shut(p)
        if on('help'):
            js(p, "document.querySelector('#helpBtn')?.click() ?? [...document.querySelectorAll('#side button')].find(x => /Shortcuts/.test(x.textContent))?.click()"); snap(p, 'help' + s); shut(p)
        if on('record'):
            js(p, "document.querySelector('[data-act=record]')?.click()"); snap(p, 'record' + s); shut(p)
        if on('people'):
            js(p, "document.querySelector('[data-act=people]')?.click()"); snap(p, 'people' + s); shut(p)
        c.close()
    if on('tour'):
        c, p = app(b, seen=False); snap(p, 'first-visit'); c.close()
    if on('phone'):
        c, p = app(b, vp=(390, 800)); shut(p); snap(p, 'phone-home')
        js(p, "document.querySelector('[data-nav=notes]')?.click()"); snap(p, 'phone-notes'); c.close()
    b.close()
