"""Does a long sound recording still play when it is stopped?  Run by hand:
    PORT=4396 node test/mock-google.mjs &
    WEFTDAY_URL=http://localhost:4396 .venv/bin/python test/longplay.py <minutes> <mic|tab> [ended]
"ended" stops it the way the browser does when sharing ends, instead of pressing Stop.
Writes test/.out/longplay-<name>.json, and the file itself when it will not play."""
import base64, json, os, sys, time
from playwright.sync_api import sync_playwright
BASE = os.environ.get('WEFTDAY_URL', 'http://localhost:4396')
MIN, WHAT, HOW = float(sys.argv[1]), sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else 'stop')
NAME = f'{WHAT}-{HOW}-{int(MIN)}'
OUT = os.path.join(os.path.dirname(__file__), '.out')
with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome', headless=True, args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-tab-capture-source-by-title=Weftday', '--autoplay-policy=no-user-gesture-required'])
    c = b.new_context(permissions=['microphone', 'camera']); page = c.new_page(); errs = []
    page.on('console', lambda m: errs.append(m.text[:200]) if m.type == 'error' else None)
    page.goto(BASE + '/?demo')
    start = page.evaluate("""async (what) => { const R = await import('./recorder.js'); for (const r of await R.all()) await R.remove(r.id);
      const streams = await R.ask(what === 'mic' ? { mic: true } : { screen: true, mic: true });
      window.__d = streams.display; window.__s = await R.start(streams, { title: 'long play' }); return { mime: window.__s.rec.mime, piece: window.__s.rec.pieceMime }; }""", WHAT)
    time.sleep(MIN * 60)
    if HOW == 'ended': page.evaluate("window.__d.getTracks()[0].dispatchEvent(new Event('ended'))"); time.sleep(4)
    out = page.evaluate("""async () => { const R = await import('./recorder.js'); const rec = await window.__s.stop(); const blob = await R.file(rec.id);
      const boxes = []; const buf = new Uint8Array(await blob.arrayBuffer()); const dv = new DataView(buf.buffer); let at = 0;
      while (at + 8 <= buf.length && boxes.length < 4000) { let size = dv.getUint32(at); const type = String.fromCharCode(...buf.subarray(at + 4, at + 8)); if (size === 1) size = Number(dv.getBigUint64(at + 8)); if (size < 8) { boxes.push([type, 'bad size ' + size, at]); break; } boxes.push([type, size]); at += size; }
      const el = new Audio(URL.createObjectURL(blob)); el.muted = true;
      const played = await new Promise(d => { el.onloadedmetadata = () => d({ ok: true, duration: el.duration }); el.onerror = () => d({ ok: false, code: el.error?.code, msg: el.error?.message }); setTimeout(() => d({ ok: false, msg: 'timeout' }), 15000); });
      const counts = {}; for (const [t] of boxes) counts[t] = (counts[t] || 0) + 1;
      window.__blob = blob;
      return { rec: { secs: rec.secs, size: rec.size, mime: rec.mime, cut: !!rec.cut }, bytes: buf.length, parsed: at, first: boxes.slice(0, 6), last: boxes.slice(-4), counts, played, pieces: (await R.pieces(rec.id)).map(x => [x.at, x.blob.size]) }; }""")
    out['start'] = start; out['errors'] = errs[:5]
    if not out['played'].get('ok'):
        data = page.evaluate("""async () => { const a = new Uint8Array(await window.__blob.arrayBuffer()); let s = ''; for (let i = 0; i < a.length; i += 32768) s += String.fromCharCode(...a.subarray(i, i + 32768)); return btoa(s); }""")
        open(os.path.join(OUT, f'longplay-{NAME}.bin'), 'wb').write(base64.b64decode(data))
    json.dump(out, open(os.path.join(OUT, f'longplay-{NAME}.json'), 'w'), indent=1)
    print(json.dumps(out)[:1800]); b.close()
