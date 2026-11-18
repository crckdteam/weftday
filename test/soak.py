"""A long-meeting check for the recorder. It takes about fifty minutes and is run by hand:

    PORT=4397 node test/mock-google.mjs &      (the app, served locally)
    WEFTDAY_URL=http://localhost:4397 .venv/bin/python test/soak.py [minutes]

(Wrap it in `caffeinate -i` so the computer does not go to sleep half way.)
It records a pretend meeting's sound for 42 minutes (three sound pieces) with Weftday's tab in the
background, the way it is during a real meeting, then a short screen video with the camera in the
corner, then cuts a recording off on purpose to see it rescued. What it measures is written to
test/.out/soak.json as it goes.
"""
import json
import os
import sys
import time
from playwright.sync_api import sync_playwright

BASE = os.environ.get('WEFTDAY_URL', 'http://localhost:4397')
MINUTES = float(sys.argv[1]) if len(sys.argv) > 1 else 42
OUT = os.path.join(os.path.dirname(__file__), '.out', 'soak.json')
os.makedirs(os.path.dirname(OUT), exist_ok=True)
report = {'started': time.strftime('%H:%M:%S'), 'minutes': MINUTES, 'samples': [], 'errors': []}


def keep():
    with open(OUT, 'w') as f:
        json.dump(report, f, indent=1)


START = """async (want) => {
  const R = await import('./recorder.js');
  for (const r of await R.all()) await R.remove(r.id);
  const streams = await R.ask(want.ask);
  window.__problems = [];
  window.__s = await R.start(streams, { ...want.opts, onProblem: k => window.__problems.push(k) });
  return { id: window.__s.id, mime: window.__s.rec.mime, pieceMime: window.__s.rec.pieceMime };
}"""
SAMPLE = """async () => {
  const e = await navigator.storage.estimate();
  return { secs: window.__s.seconds(), state: window.__s.state, hidden: document.hidden, heapMB: Math.round((performance.memory?.usedJSHeapSize || 0) / 1048576),
    storedMB: Math.round((e.usage || 0) / 1048576 * 10) / 10, size: window.__s.rec.size, awake: window.__s.awake(), problems: window.__problems };
}"""
STOP = """async () => {
  const R = await import('./recorder.js');
  const t0 = performance.now(), rec = await window.__s.stop(), stopMs = Math.round(performance.now() - t0);
  const parts = await R.pieces(rec.id), blob = await R.file(rec.id);
  const el = document.createElement(rec.kind === 'video' ? 'video' : 'audio'); el.muted = true; el.src = URL.createObjectURL(blob);
  await new Promise((d, f) => { el.onloadedmetadata = d; el.onerror = () => f(new Error('cannot play')); });
  const far = Math.max(1, el.duration - 90);
  el.currentTime = far; await new Promise(d => { el.onseeked = d; setTimeout(d, 8000); });
  const seekOk = Math.abs(el.currentTime - far) < 2;
  await el.play(); await new Promise(d => setTimeout(d, 1500)); el.pause();
  const played = el.currentTime - far;
  let trim = null;
  if (R.canTrim(rec) && rec.secs > 400) { const t1 = performance.now(), copy = await R.trim(rec.id, 120, 300); const cb = await R.file(copy.id);
    const c = document.createElement(rec.kind === 'video' ? 'video' : 'audio'); c.muted = true; c.src = URL.createObjectURL(cb); await new Promise(d => { c.onloadedmetadata = d; });
    trim = { ms: Math.round(performance.now() - t1), secs: copy.secs, duration: c.duration, bytes: cb.size }; await R.remove(copy.id); }
  return { stopMs, rec: { kind: rec.kind, mime: rec.mime, secs: rec.secs, sizeMB: Math.round(rec.size / 1048576 * 10) / 10, cut: !!rec.cut, thumb: rec.thumb?.size || 0, pieceAt: rec.pieceAt },
    pieces: parts.map(p => ({ at: p.at, MB: Math.round(p.blob.size / 1048576 * 100) / 100 })), fileMB: Math.round(blob.size / 1048576 * 10) / 10,
    duration: el.duration, seekOk, played: Math.round(played * 10) / 10, width: el.videoWidth || 0, trim, problems: window.__problems };
}"""

with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True, args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-tab-capture-source-by-title=Weftday', '--autoplay-policy=no-user-gesture-required'])
    context = browser.new_context(permissions=['microphone', 'camera'])
    page = context.new_page()
    page.on('pageerror', lambda e: report['errors'].append(str(e)[:300]))
    page.on('console', lambda m: report['errors'].append(m.text[:300]) if m.type == 'error' else None)
    page.goto(BASE + '/terms.html')

    # ---- 1. a long meeting: its sound and the microphone, Weftday's tab in the background
    report['long'] = {'start': page.evaluate(START, {'ask': {'screen': True, 'mic': True}, 'opts': {'title': 'Soak test, sound'}})}
    other = context.new_page()   # like switching to the meeting's own tab
    other.goto(BASE + '/privacy.html')
    other.bring_to_front()
    keep()
    until = time.time() + MINUTES * 60
    while time.time() < until:
        time.sleep(min(300, max(1, until - time.time())))
        report['samples'].append(page.evaluate(SAMPLE))
        keep()
    page.bring_to_front()
    report['long']['end'] = page.evaluate(STOP)
    keep()

    # ---- 2. a screen video with the camera in the corner, eight minutes
    report['video'] = {'start': page.evaluate(START, {'ask': {'screen': True, 'mic': True, 'cam': True}, 'opts': {'keepVideo': True, 'title': 'Soak test, video'}})}
    other.bring_to_front()
    for _ in range(2):
        time.sleep(240)
        report['samples'].append(page.evaluate(SAMPLE))
        keep()
    page.bring_to_front()
    report['video']['end'] = page.evaluate(STOP)
    keep()

    # ---- 3. cut off on purpose: the tab is closed while recording, then the app is opened again
    page.evaluate(START, {'ask': {'screen': True, 'mic': True}, 'opts': {'title': 'Soak test, cut off'}})
    time.sleep(40)
    page.close()
    again = context.new_page()
    again.goto(BASE + '/terms.html')
    report['rescue'] = again.evaluate("""async () => {
      const R = await import('./recorder.js');
      const fixed = await R.recover(), rec = (await R.all()).find(r => r.title === 'Soak test, cut off');
      const blob = rec && await R.file(rec.id), parts = rec ? await R.pieces(rec.id) : [];
      const a = new Audio(blob ? URL.createObjectURL(blob) : ''); let duration = null;
      if (blob) { await new Promise(d => { a.onloadedmetadata = d; a.onerror = d; setTimeout(d, 5000); }); duration = a.duration; }
      return { fixed, found: !!rec, cut: !!rec?.cut, secs: rec?.secs, duration, pieces: parts.map(p => p.blob.size) };
    }""")
    report['finished'] = time.strftime('%H:%M:%S')
    keep()
    browser.close()

print(json.dumps(report, indent=1)[:6000])
