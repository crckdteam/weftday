"""Makes the short clip on the website's home page from the real app with its sample data.
Run by hand after a change to how the app looks. The app must be open at http://localhost:4398
(PORT=4398 node test/mock-google.mjs):

    .venv/bin/python tools/site-clip.py          (both cuts, about seven minutes)
    .venv/bin/python tools/site-clip.py wide     (only the wide cut; or: phone)

It writes six files:

    site/video/tour.mp4, tour.webm                    the wide cut, 1920 x 1080
    site/video/tour-phone.mp4, tour-phone.webm        the phone cut, 1080 x 1350
    site/img/tour-poster.jpg, tour-phone-poster.jpg   the first frame of each, shown before the clip plays

How it works. Chrome opens two pages: the real app, and tools/clip/stage.html, which is the website's
green ground with a window, the words, the cursor and the closing card. The story further down is
played one frame at a time. For each frame the stage says which part of the app the camera is looking
at, a sharp picture of just that part is taken and put in the stage's window, and the whole stage is
photographed. Nothing depends on how fast the computer is, so no frame is dropped or half drawn.
The frames are then packed into video by the encoders that are built into Chrome (tools/clip/pack.html)
and written out as .mp4 and .webm files by the last part of this file. Nothing has to be installed:
Chrome and Playwright, which the other tools already need, are enough. The clip has no sound track."""
import base64, datetime, hashlib, math, os, shutil, struct, sys, tempfile, time
from playwright.sync_api import sync_playwright

BASE = os.environ.get('WEFTDAY_URL', 'http://localhost:4398')
HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(HERE, '..', 'site'); IMG, VID = os.path.join(SITE, 'img'), os.path.join(SITE, 'video')
STAGE = 'http://clip.localhost/'   # a made-up address: Chrome is handed the files in tools/clip/ under it
FPS = 30
LIMIT = 3.5e6      # no file may be larger than this, in bytes
AIM = 3.2e6        # the size each video file is aimed at
CUTS = {           # the size of each cut, what its files are called, and the size of the app's own page while it is made
    'wide': {'size': (1920, 1080), 'name': 'tour', 'app': (1300, 900)},
    'phone': {'size': (1080, 1350), 'name': 'tour-phone', 'app': (1300, 952)},   # a little taller, to suit its taller window
}
SEEN = "localStorage.setItem('weftday.seenHome','1');localStorage.setItem('weftday.toured','1');localStorage.setItem('weftday.tips', JSON.stringify({meeting:1,person:1,today:1,people:1,free:1,plan:1,record:1,library:1}));"
# As in site-media.py: it is mid-morning on the Wednesday of this week, so the day looks alive.
today = datetime.date.today(); wed = today - datetime.timedelta(days=today.weekday()) + datetime.timedelta(days=2)
NOW = datetime.datetime.combine(wed, datetime.time(9, 12))
BEGIN = NOW + datetime.timedelta(seconds=20)   # what the app's clock says on the first frame, and again on the last
FIRST_TASK = 'Send the pilot plan and timeline'   # the action point that is ticked in the notes, and unticked again at the end


# ---------------------------------------------------------------------------------------------
# The story. One function, read from top to bottom, played once for each cut. "t.play(2)" lets two
# seconds of the clip go by; every other line starts something and returns at once. t.show(left, top,
# width) points the camera at a part of the app, given in the app's own pixels: the wide cut looks at
# larger parts, the phone cut stays close so the words can be read on a small screen.
# The camera moves seldom and briefly, and rests in between: a moving picture cannot be read, and it
# is what makes a video file large. The words are the website's own (site/index.html).
# ---------------------------------------------------------------------------------------------
def story(t):
    wide = t.cut == 'wide'

    # 1. The day at a glance.
    first = (0, 0, 1300) if wide else (330, 84, 560)
    opening = ('One calm place for your day.', 'Your calendar, your meetings and your notes.')
    t.start(first, *opening)
    t.play(1.4)
    if wide: t.show(0, 0, 880, over=1.3)                    # in towards the day and the Record button
    else: t.show(0, 0, 520, over=1.3)
    t.play(1.9)
    t.cursor_at(*((560, 400) if wide else (400, 330))); t.cursor(True)
    t.point('#recBtn', over=1.1, fx=.3)
    t.play(1.6)

    # 2. Press Record: the simple Record box.
    t.say('Press Record.', 'No bot joins the call. Nobody has to be invited.', 'record')
    t.click()
    t.play(0.3)
    if wide: t.centre('#dlg', zoom=1.72, over=1.1)
    else: t.centre('#dlg .rpick', zoom=2.1, over=1.1)       # close on the four cards, so their words can be read on a phone
    t.play(2.0)
    t.point('#dlg .rpick label', text='Meeting', over=.9, fx=.5, fy=.72)
    t.play(1.9)
    if not wide: t.centre('#dlg .recgo', zoom=2.1, over=1.0)
    t.point('#dlg .recgo', over=1.0, fx=.62, fy=.6)
    t.play(2.4)

    # 3. The notes that wrote themselves. (Each change of scene is a cross-fade: a still picture of the
    #    window covers it while the app changes underneath, then fades away.)
    t.cover()
    t.cursor(False, at_once=True)
    t.app("document.querySelector('#dlg[open]')?.close()")
    t.app("document.querySelector('#mainNav [data-nav=notes]').click()"); t.settle()
    t.app("[...document.querySelectorAll('#notes .nrow')].find(e => e.textContent.includes('Client call')).click()"); t.settle()
    note = t.box('#notes .ndoc')
    if wide: t.show(note['x'] + 3, 80, 660, at_once=True)   # the title, the summary, the decisions and the action points
    else:                                                   # decisions and action points, large enough to read (the summary's long lines would not fit)
        todo = t.box('#notes .b.todo', FIRST_TASK); t.show(note['x'] + 20, todo['y'] - 175, 500, at_once=True)
    t.say('The notes write themselves.', 'The summary, the decisions and who does what.', 'notes')
    t.uncover(0.6)
    t.play(2.8)
    if wide: t.cursor_at(1120, 470)
    else: t.cursor_at(todo['x'] + 250, todo['y'] + 70)
    t.cursor(True)
    t.point('#notes .b.todo', text=FIRST_TASK, over=1.1, fx=.017, fy=.45)
    t.play(1.5)
    t.click()                                               # tick the first action point
    t.play(2.2)

    # 4. Every calendar in one week.
    t.cover()
    t.cursor(False, at_once=True)
    t.app("document.querySelector('#mainNav [data-nav=calendar]').click()"); t.settle()
    t.app("document.querySelector('#grid').scrollTop = 52 * 8.6"); t.settle()
    if wide: t.show(305, 65, 800, at_once=True)
    else: t.show(305, 66, 470, at_once=True)
    t.say('Every calendar. One day.', 'Work, personal, a client\u2019s. Each in its own colour.', 'calendar')
    t.uncover(0.6)
    t.play(1.2)
    if wide: t.show(305, 65, 1000, over=3.0)                # out to the whole week: the day names and the hours stay in shot
    else: t.show(600, 66, 470, over=3.0)
    t.play(5.0)

    # 5. Who you are meeting.
    t.cover()
    t.app("document.querySelector('#mainNav [data-nav=people]').click()"); t.settle()
    left = t.box('#dlg')['x']                               # the panel's own left edge, so no strip of the calendar shows beside it
    t.show(left, 0, 640 if wide else 420, at_once=True)     # the list
    t.say('Walk in knowing who you are meeting.', 'What you discussed, and what is still open.', 'people')
    t.uncover(0.6)
    t.play(1.3)
    t.cursor_at(*((1150, 190) if wide else (left + 330, 190))); t.cursor(True)
    if not wide:                                            # Lena is below the first names: the camera goes down to her
        lena = t.box('#pplList .prow2', text='Lena'); t.show(left, lena['y'] - 262, 420, over=1.0)
    t.point('#pplList .prow2', text='Lena', over=1.0, fx=.16)
    t.play(1.4)
    t.cover()                                               # the click changes the whole panel, so it happens under a still picture
    t.click()
    t.play(0.4)
    t.cursor(False, at_once=True)
    t.settle()
    left = t.box('#dlg')['x']
    meetings = t.box('#dlg h4', text='Your meetings')       # her meetings and your notes on her; the page's top ("No facts yet") is skipped
    width = 500 if wide else 470
    t.show(left, meetings['y'] - 12, width, at_once=True)
    t.uncover(0.5)
    t.play(2.6)
    page = t.box('#dlg h4', text='Still open')
    t.show(left, page['y'] - 12, width, over=1.2)           # down to what is still open with them, and the notes from the last meeting
    t.play(4.2)

    # 6. The closing card, then back to where the clip began so that it loops without a jump.
    t.card(True, 0.6)
    t.play(0.8)
    t.reset_app()
    t.start(first, *opening)
    t.play(2.5)
    t.card(False, 0.7)
    t.play(1.2)
    t.end()

# ---------------------------------------------------------------------------------------------
# The take: Chrome with the app and the stage open, played and photographed frame by frame.
# ---------------------------------------------------------------------------------------------
def serve(frames):
    """Hands Chrome the files of the stage: tools/clip/, the website's fonts and mark, and the frames."""
    def handle(route):
        name = route.request.url.split('://', 1)[1].split('/', 1)[1].split('?')[0]
        if name.startswith('fonts/') or name == 'icon.svg': path = os.path.join(SITE, name)
        elif name.startswith('frames/'): path = os.path.join(frames, name[len('frames/'):])
        else: path = os.path.join(HERE, 'clip', name)
        route.fulfill(path=path) if os.path.isfile(path) else route.fulfill(status=404, body='not found')
    return handle

def chrome(pw):
    """Chrome, with its pages drawn by the processor instead of the graphics card: the graphics card draws the same
    page a hair differently each time, and frames that should be the same picture would each come out different."""
    return pw.chromium.launch(channel='chrome', headless=True, args=['--disable-gpu-rasterization'])

def photo(cdp, part):
    """A picture of one part of a page, drawn at the zoom that part asks for (so it stays sharp)."""
    return base64.b64decode(cdp.send('Page.captureScreenshot', {'format': 'png', 'optimizeForSpeed': True, 'clip': part})['data'])

STILL, SOME, MOST = 0, 1, 2   # how much of the picture changed since the frame before: nothing, a part, most of it

class Take:
    def __init__(self, browser, cut, frames):
        self.cut, self.frames, self.n, self.names, self.changes, self.last, self.inside, self.ms, self.mouse, self.loops = cut, frames, 0, [], [], None, None, 0.0, False, False
        (w, h), self.size = CUTS[cut]['size'], CUTS[cut]['app']; self.whole = {'x': 0, 'y': 0, 'width': w, 'height': h, 'scale': 1}
        # The app, as in site-media.py: sample data, the welcome box closed.
        c = self.context = browser.new_context(viewport={'width': self.size[0], 'height': self.size[1]}, device_scale_factor=1, service_workers='block')
        c.add_init_script(SEEN); c.add_init_script(path=os.path.join(HERE, 'clip', 'inside.js')); c.clock.install(time=NOW)
        a = self.page = c.new_page()
        try: a.goto(BASE + '/?demo')
        except Exception: raise SystemExit('The app is not answering at %s. Start it first:  PORT=4398 node test/mock-google.mjs &' % BASE)
        a.wait_for_timeout(1500); self.app("document.querySelector('#dlg[open]')?.close()"); a.wait_for_timeout(400)
        # The stage, at the size of the finished clip.
        c2 = self.context2 = browser.new_context(viewport={'width': w, 'height': h}, device_scale_factor=1)
        c2.route(STAGE + '**', serve(frames)); s = self.stage = c2.new_page()
        # Both pages are pinned to their size here as well: without this, the first photograph lets a page
        # fall back to the size of this computer's screen, and the app would be laid out again, shorter.
        self.see_app, self.see_stage = c.new_cdp_session(a), c2.new_cdp_session(s)
        self.see_app.send('Emulation.setDeviceMetricsOverride', {'width': self.size[0], 'height': self.size[1], 'deviceScaleFactor': 1, 'mobile': False})
        self.see_stage.send('Emulation.setDeviceMetricsOverride', {'width': w, 'height': h, 'deviceScaleFactor': 1, 'mobile': False})
        s.goto(STAGE + 'stage.html?cut=' + cut)
        self.lens = s.evaluate('a => stage.setup(...a)', list(self.size))
        # From here on the app's clock stands still and is moved on by hand, one frame at a time.
        a.clock.pause_at(BEGIN)
        a.mouse.move(1, 1)

    @property
    def t(self): return self.n / FPS     # the time in the clip, in seconds

    def app(self, js): return self.page.evaluate(js)
    def ask(self, what, *args): return self.stage.evaluate('a => stage.%s(...a)' % what, list(args))
    def box(self, sel, text=None):
        b = self.page.evaluate('a => clip.rect(...a)', [sel, text])
        if not b: raise SystemExit('The clip could not find "%s" in the app. Has that screen changed?' % (sel + (' with the words "%s"' % text if text else '')))
        return b

    # ---- the camera
    def show(self, left, top, width, over=1.2, at_once=False):
        zoom = self.lens['w'] / width
        self.ask('cam', self.t, 0 if at_once else over, left + width / 2, top + self.lens['h'] / zoom / 2, zoom)
    def centre(self, sel, zoom, over=1.2):
        b = self.box(sel); self.ask('cam', self.t, over, b['x'] + b['w'] / 2, b['y'] + b['h'] / 2, zoom)

    # ---- the cursor. point() moves it to something in the app; fx and fy say where on that thing (0 to 1).
    def cursor(self, on, at_once=False): self.ask('cursorShow', self.t - (1 if at_once else 0), on)
    def cursor_at(self, x, y): self.ask('cursor', self.t, 0, x, y)
    def point(self, sel, text=None, over=1.0, fx=.5, fy=.5):
        b = self.box(sel, text); self.ask('cursor', self.t, over, b['x'] + b['w'] * fx, b['y'] + b['h'] * fy)
    def click(self):
        """A real press of the mouse in the app, exactly where the drawn cursor points."""
        at = self.ask('frame', self.t)
        self.page.mouse.move(at['x'], at['y']); self.page.mouse.down(); self.page.mouse.up(); self.mouse = True
        self.ask('click', self.t)

    # ---- the words, the cross-fade between scenes, the closing card
    def start(self, view, head, sub):
        left, top, width = view; zoom = self.lens['w'] / width
        self.ask('start', self.t, [left + width / 2, top + self.lens['h'] / zoom / 2, zoom], head, sub)
    def say(self, head, sub, tab=None): self.ask('say', self.t, head, sub, tab)
    def cover(self): self.ask('hold', self.t)
    def uncover(self, over): self.ask('release', self.t, over)
    def card(self, on, over): self.ask('card', self.t, over, on)

    def settle(self):
        """After a change made out of sight: lets the app finish redrawing, its animations skipped."""
        for _ in range(4):
            self.page.clock.run_for(250); self.app('clip.finish()'); self.page.wait_for_timeout(60)
    def reset_app(self):
        """Puts the app back exactly as it was at the start: nothing newly ticked, Home on screen, no box open, the same time of day."""
        self.cursor(False, at_once=True)
        self.app("document.querySelector('#dlg[open]')?.close()"); self.settle()
        self.app("document.querySelector('#mainNav [data-nav=notes]').click()"); self.settle()
        if self.app("clip.ticked('#notes .b.todo', %r)" % FIRST_TASK):
            b = self.box('#notes .b.todo', FIRST_TASK); self.page.mouse.click(b['x'] + b['w'] * .017, b['y'] + b['h'] * .45); self.settle()
        self.page.mouse.move(1, 1); self.mouse = False
        self.page.clock.set_system_time(BEGIN)
        self.app("document.querySelector('#mainNav [data-nav=home]').click()"); self.settle()
        self.page.clock.set_system_time(BEGIN)

    # ---- time
    def play(self, seconds):
        for _ in range(round(seconds * FPS)): self.frame()
    def frame(self):
        self.ms += 1000 / FPS; step = int(self.ms); self.ms -= step
        self.page.clock.run_for(step)                              # the app's own timers move on by one frame
        at = self.ask('frame', self.t)                             # the stage draws this moment
        self.app('clip.step(%r)' % self.t)                         # the app's animations move to this moment
        if at['on']: self.page.mouse.move(at['x'], at['y']); self.mouse = True     # the real mouse follows the drawn cursor
        elif self.mouse: self.page.mouse.move(1, 1); self.mouse = False
        part = photo(self.see_app, at['view'])
        if part != self.inside: self.inside = part; self.ask('put', 'data:image/png;base64,' + base64.b64encode(part).decode())
        png = photo(self.see_stage, self.whole)
        if struct.unpack('>II', png[16:24]) != CUTS[self.cut]['size']: raise SystemExit('A frame came out %d x %d instead of %d x %d.' % (struct.unpack('>II', png[16:24]) + CUTS[self.cut]['size']))
        mark = hashlib.md5(png).hexdigest()                        # a frame that is the same as the one before is not saved twice
        if mark != self.last:
            self.last = mark; self.names.append('%05d.png' % self.n); self.changes.append(MOST if at['busy'] else SOME)
            with open(os.path.join(self.frames, self.names[-1]), 'wb') as f: f.write(png)
        else: self.names.append(self.names[-1]); self.changes.append(STILL)
        self.n += 1
        if self.n % FPS == 0 and self.app('innerWidth + " " + innerHeight') != '%d %d' % self.size: raise SystemExit('The app changed size while it was being photographed.')
    def end(self):
        """The clip has to end on its first picture. A screen that was drawn again can differ from the first time by
        a hair that no eye can see (a step or two of brightness, out of 255, on the edge of a shadow or a letter);
        the first picture itself then closes the clip. A real difference, such as a changed word, is far larger."""
        last = self.names[-1]
        self.loops = last == self.names[0] or self.ask('alike', self.names[0], last) <= 8
        if self.loops: self.names = [self.names[0] if name == last else name for name in self.names]


# ---------------------------------------------------------------------------------------------
# Packing: Chrome encodes the frames, and the two kinds of video file are written here by hand.
# Both are simple once the frames are encoded: a list of what is inside, then the frames.
# ---------------------------------------------------------------------------------------------
COLOUR = {  # the numbers the video standards use for the names Chrome gives
    'primaries': {'bt709': 1, 'bt470bg': 5, 'smpte170m': 6}, 'transfer': {'bt709': 1, 'smpte170m': 6, 'iec61966-2-1': 13},
    'matrix': {'rgb': 0, 'bt709': 1, 'bt470bg': 5, 'smpte170m': 6},
}
def colour_numbers(c):
    c = c or {}
    return [COLOUR[k].get(c.get(k), 1 if k != 'matrix' else 6) for k in ('primaries', 'transfer', 'matrix')] + [1 if c.get('full') else 0]

def mp4_file(frames, keys, size, setup, colour):
    """An .mp4 with the list of contents at the front (so it starts playing before it has all arrived)."""
    def box(kind, *parts): body = b''.join(parts); return struct.pack('>I4s', 8 + len(body), kind) + body
    def full(kind, flags, *parts): return box(kind, struct.pack('>I', flags), *parts)
    (w, h), n, tick, group = size, len(frames), 512, FPS       # tick: one frame, in 1/15360 of a second; group: frames kept together
    turn = struct.pack('>9I', 0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000)
    long = n * 1000 // FPS
    def contents(where):
        counts = [min(group, n - i) for i in range(0, n, group)]
        runs = [(1, counts[0])] + ([(len(counts), counts[-1])] if counts[-1] != counts[0] else [])
        video = box(b'avc1', bytes(6), struct.pack('>H', 1), bytes(16), struct.pack('>HHIIIH', w, h, 0x480000, 0x480000, 0, 1), bytes(32), struct.pack('>Hh', 24, -1),
                    box(b'avcC', setup), box(b'colr', b'nclx', struct.pack('>HHHB', *(colour[:3] + [colour[3] << 7]))), box(b'pasp', struct.pack('>II', 1, 1)))
        table = box(b'stbl',
            full(b'stsd', 0, struct.pack('>I', 1), video),
            full(b'stts', 0, struct.pack('>III', 1, n, tick)),
            full(b'stss', 0, struct.pack('>I', len(keys)), *[struct.pack('>I', k + 1) for k in keys]),
            full(b'stsc', 0, struct.pack('>I', len(runs)), *[struct.pack('>III', first, count, 1) for first, count in runs]),
            full(b'stsz', 0, struct.pack('>II', 0, n), *[struct.pack('>I', len(f)) for f in frames]),
            full(b'stco', 0, struct.pack('>I', len(where)), *[struct.pack('>I', x) for x in where]))
        media = box(b'mdia',
            full(b'mdhd', 0, struct.pack('>IIIIHH', 0, 0, FPS * tick, n * tick, 0x55c4, 0)),
            full(b'hdlr', 0, bytes(4), b'vide', bytes(12), b'VideoHandler\0'),
            box(b'minf', full(b'vmhd', 1, bytes(8)), box(b'dinf', full(b'dref', 0, struct.pack('>I', 1), full(b'url ', 1))), table))
        track = box(b'trak', full(b'tkhd', 3, struct.pack('>IIIII', 0, 0, 1, 0, long), bytes(8), struct.pack('>hhhH', 0, 0, 0, 0), turn, struct.pack('>II', w << 16, h << 16)), media)
        return box(b'moov', full(b'mvhd', 0, struct.pack('>IIIIIH', 0, 0, 1000, long, 0x10000, 0x100), bytes(10), turn, bytes(24), struct.pack('>I', 2)), track)
    head = box(b'ftyp', b'isom', struct.pack('>I', 512), b'isomiso2avc1mp41')
    starts, at = [], 0
    for i, f in enumerate(frames):
        if i % group == 0: starts.append(at)
        at += len(f)
    before = len(head) + len(contents(starts)) + 8             # where the frames begin in the file
    return head + contents([before + x for x in starts]) + struct.pack('>I4s', 8 + at, b'mdat') + b''.join(frames)

def webm_file(frames, keys, size, colour):
    """A .webm: the same idea in the Matroska way, where every part is a number, a length and its contents."""
    def length(n):
        for wide in range(1, 9):
            if n < (1 << 7 * wide) - 1: return (n | 1 << 7 * wide).to_bytes(wide, 'big')
    def part(name, body): return bytes.fromhex(name) + length(len(body)) + body
    def num(name, n, wide=0): return part(name, n.to_bytes(wide or max(1, (n.bit_length() + 7) // 8), 'big'))
    (w, h), n, keyset = size, len(frames), set(keys)
    when = [round(i * 1000 / FPS) for i in range(n)]            # when each frame is shown, in thousandths of a second
    info = part('1549A966', num('2AD7B1', 1000000) + part('4489', struct.pack('>d', n * 1000 / FPS)) + part('4D80', b'Weftday site-clip') + part('5741', b'Weftday site-clip'))
    tint = part('55B0', num('55B1', colour[2]) + num('55B9', 2 if colour[3] else 1) + num('55BA', colour[1]) + num('55BB', colour[0]))
    tracks = part('1654AE6B', part('AE', num('D7', 1) + num('73C5', 1) + num('83', 1) + num('9C', 0) + part('86', b'V_VP9') + num('23E383', round(1e9 / FPS))
                                   + part('E0', num('B0', w) + num('BA', h) + tint)))
    # The frames go in groups; each group starts with a whole picture or after a second at most.
    groups, start = [], 0
    for i in range(1, n + 1):
        if i == n or i in keyset or i - start >= FPS:
            body = num('E7', when[start]) + b''.join(part('A3', b'\x81' + struct.pack('>hB', when[j] - when[start], 0x80 if j in keyset else 0) + frames[j]) for j in range(start, i))
            groups.append((start, part('1F43B675', body))); start = i
    index_size = len(part('114D9B74', b''.join(part('4DBB', part('53AB', bytes(4)) + num('53AC', 0, 8)) for _ in range(3))))
    at, places = index_size + len(info) + len(tracks), {}
    for first, g in groups: places[first] = at; at += len(g)
    cues = part('1C53BB6B', b''.join(part('BB', num('B3', when[first]) + part('B7', num('F7', 1) + num('F1', places[first]))) for first, _ in groups if first in keyset))
    index = part('114D9B74', b''.join(part('4DBB', part('53AB', bytes.fromhex(name)) + num('53AC', place, 8))
                                      for name, place in (('1549A966', index_size), ('1654AE6B', index_size + len(info)), ('1C53BB6B', at))))
    body = index + info + tracks + b''.join(g for _, g in groups) + cues
    head = part('1A45DFA3', num('4286', 1) + num('42F7', 1) + num('42F2', 4) + num('42F3', 8) + part('4282', b'webm') + num('4287', 4) + num('4285', 2))
    return head + part('18538067', body)

# H.264 is told, frame by frame, how much detail to keep: a number from 0 to 51, where a lower number keeps
# more and costs more bytes. A frame in which most of the picture moves gets little (it cannot be read); the
# first frames after things come to rest get the most (they are the ones that are looked at); and the frames
# that only repeat a resting picture are told to add nothing. "soft" moves every level up together until the
# file fits. LEVELS are the numbers at their best: for a resting picture, for a part of it changing (the
# cursor, the words), and for most of it changing. IDLE is for a frame that repeats the one before.
LEVELS, IDLE = (22, 27, 31), 46
def detail(changes, soft):
    rest, some, most = (min(51, q + soft) for q in LEVELS)
    out, quiet = [], 0                                       # quiet: how many frames in a row nothing has changed
    for i, change in enumerate(changes):
        quiet = quiet + 1 if change == STILL else 0
        if i == 0 or (change != MOST and changes[i - 1] == MOST): out.append(rest)     # the opening frame, and the first after the camera stops
        elif change == MOST: out.append(most)
        elif change == SOME: out.append(some)
        else: out.append(rest if quiet <= 2 else IDLE)
    return out

def pack(browser, cut, frames, names, changes):
    """Turns the frames of one cut into its two video files and its still. Answers with the files written."""
    size, name = CUTS[cut]['size'], CUTS[cut]['name']
    c = browser.new_context(); c.route(STAGE + '**', serve(frames)); p = c.new_page(); p.goto(STAGE + 'pack.html')
    ask = {'names': names, 'width': size[0], 'height': size[1], 'fps': FPS}
    def one(kind, **how):
        try: got = p.evaluate('a => pack(a)', dict(ask, kind=kind, **how))
        except Exception as e: raise SystemExit('Chrome could not make the %s video: %s' % (kind, str(e).split('\n')[0].split('Error: ')[-1]))
        data, parts, at = base64.b64decode(got['data']), [], 0
        for n in got['sizes']: parts.append(data[at:at + n]); at += n
        colour = colour_numbers(got['colour'])
        return mp4_file(parts, got['keys'], size, base64.b64decode(got['setup']), colour) if kind == 'mp4' else webm_file(parts, got['keys'], size, colour)
    made = []
    for kind in ('mp4', 'webm'):
        best, low, high = None, None, None                  # low: the last try that fitted; high: the last that was too large
        if kind == 'mp4' and p.evaluate('a => exact(a)', ask):
            # Detail set frame by frame (Chrome can do this for H.264 on a Mac; its VP9 encoder takes the number
            # but stays far too large at any setting). Each step of "soft" makes the file about a twentieth smaller.
            soft = 3
            for _ in range(5):
                out = one(kind, detail=detail(changes, soft))
                if len(out) <= AIM: best, low = out, soft
                else: high = soft
                if len(out) <= AIM and (soft == 0 or len(out) > AIM * .93 or high == soft - 1): break
                steps = max(1, int(abs(math.log(len(out) / AIM)) / .06))
                soft = soft + steps if len(out) > AIM else max(0, soft - steps, (high if high is not None else -1) + 1)
                if soft in (low, high): break
        else:
            # A number of bits a second, which the encoder shares out by itself. It spends few on a resting
            # picture and many on a moving one, so the number is found by trying: a first guess, then where a
            # straight line through the last two tries says the file would come out at the size wanted.
            rate, tries = AIM * 8 / (len(names) / FPS) * .6, []
            for _ in range(6):
                out = one(kind, rate=round(rate)); tries.append((rate, len(out)))
                if len(out) <= AIM: low = rate if low is None else max(low, rate)
                else: high = rate if high is None else min(high, rate)
                if len(out) <= AIM and (best is None or len(out) > len(best)): best = out
                if AIM * .93 < len(out) <= AIM: break
                if len(tries) > 1 and tries[-1][1] != tries[-2][1]:
                    (r1, s1), (r2, s2) = tries[-2:]; rate = r2 + (AIM * .97 - s2) * (r2 - r1) / (s2 - s1)
                else: rate *= AIM * .97 / len(out)
                if low and high: rate = rate if low < rate < high else (low + high) / 2     # never outside what is already known
                elif high: rate = max(60e3, min(rate, high * .9))
                else: rate = max(rate, low * 1.1)
        if best is None or len(best) > LIMIT: raise SystemExit('The %s for the %s cut would not fit in %.1f MB.' % (kind, cut, LIMIT / 1e6))
        made.append(os.path.join(VID, name + '.' + kind))
        with open(made[-1], 'wb') as f: f.write(best)
    made.append(os.path.join(IMG, name + '-poster.jpg'))
    with open(made[-1], 'wb') as f: f.write(base64.b64decode(p.evaluate('a => still(...a)', [names[0], .9])))
    c.close()
    return made


if __name__ == '__main__':
    only = sys.argv[1] if len(sys.argv) > 1 else ''
    if only and only not in CUTS: raise SystemExit('Say "wide" or "phone", or nothing for both.')
    keep = os.environ.get('CLIP_FRAMES')   # set this to a folder to keep the frames there and look at them
    os.makedirs(VID, exist_ok=True); os.makedirs(IMG, exist_ok=True)
    made = []
    with sync_playwright() as pw:
        b = chrome(pw)
        for cut in CUTS:
            if only and only != cut: continue
            # The frames are kept outside the project, in a temporary folder that is removed afterwards.
            frames = os.path.join(keep, cut) if keep else tempfile.mkdtemp(prefix='weftday-clip-')
            try:
                shutil.rmtree(frames, ignore_errors=True); os.makedirs(frames)
                began = time.time(); t = Take(b, cut, frames); story(t); t.context.close(); t.context2.close()
                print('%s cut: %d frames (%.1f seconds), drawn in %.0f seconds%s' % (cut, t.n, t.n / FPS, time.time() - began,
                      '' if t.loops else '. Its last frame is not the same as its first: the loop will show a jump.'), flush=True)
                began = time.time(); made += pack(b, cut, frames, t.names, t.changes); print('%s cut: packed in %.0f seconds' % (cut, time.time() - began), flush=True)
            finally:
                if not keep: shutil.rmtree(frames, ignore_errors=True)
        b.close()
    for path in made: print('%8.2f MB  %s' % (os.path.getsize(path) / 1e6, os.path.relpath(path, os.path.join(HERE, '..'))))
    print('done')
