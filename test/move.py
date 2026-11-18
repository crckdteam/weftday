"""Browser check of the move from Weftday's old address to its new one.

Two addresses on this computer stand in for the real ones: the page left at the old address
(the legacy/ folder) and the app (public/). Things are saved at the "old" one, the button is
pressed, and they must turn up at the "new" one: settings, tasks, notes and a recording.

Run it with both servers started for you:   tools/check.sh
"""
import json
import os
import sys
from playwright.sync_api import sync_playwright

NEW = os.environ.get('WEFTDAY_URL', 'http://localhost:4399')
OLD = os.environ.get('WEFTDAY_OLD_URL', 'http://localhost:4396')
results, problems = [], []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS  ' if ok else 'FAIL  ') + name + (f'  [{detail}]' if detail and not ok else ''))


SAVED = {
    'settings': {'clientId': 'abc.apps.googleusercontent.com', 'clientSecret': 'pretend', 'aiKey': 'pretend-key', 'theme': 'auto'},
    'accounts': [], 'notes': {'note:moved': {'title': 'Came across', 'text': 'A note from the old address', 'when': 1700000000000, 't': 1700000000000}},
    'tasks': [{'id': 'moved1', 'title': 'Carried across', 'date': None, 'start': None, 'duration': 30, 'tag': '', 'priority': 'normal', 'done': False, 'created': 1700000000000, 'updated': 1700000000000}],
}
SEED = """async saved => {
  localStorage.setItem('planner.v1', JSON.stringify(saved));
  localStorage.setItem('weftday.toured', '1');
  const db = await new Promise((done, fail) => { const r = indexedDB.open('weftday-recordings', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('recs', { keyPath: 'id' }); r.result.createObjectStore('parts', { keyPath: ['id', 'kind', 'n'] }); };
    r.onsuccess = () => done(r.result); r.onerror = () => fail(r.error); });
  const tx = db.transaction(['recs', 'parts'], 'readwrite');
  tx.objectStore('recs').put({ id: 'rec1', at: 1700000000000, kind: 'video', done: true, title: 'Old recording', mime: 'video/webm', ms: 4000, size: 350000 });
  tx.objectStore('parts').put({ id: 'rec1', kind: 'm', n: 0, blob: new Blob([new Uint8Array(300000).fill(7)], { type: 'video/webm' }) });
  tx.objectStore('parts').put({ id: 'rec1', kind: 'q', n: 0, blob: new Blob([new Uint8Array(50000).fill(9)], { type: 'audio/webm' }) });
  await new Promise((done, fail) => { tx.oncomplete = done; tx.onerror = () => fail(tx.error); });
  db.close();
}"""
ARRIVED = """async () => {
  const s = JSON.parse(localStorage.getItem('planner.v1') || 'null');
  const db = await new Promise((done, fail) => { const r = indexedDB.open('weftday-recordings'); r.onsuccess = () => done(r.result); r.onerror = () => fail(r.error); });
  const all = store => new Promise((done, fail) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => done(r.result); r.onerror = () => fail(r.error); });
  const recs = db.objectStoreNames.contains('recs') ? await all('recs') : [], parts = db.objectStoreNames.contains('parts') ? await all('parts') : [];
  const first = parts.length ? new Uint8Array(await parts.find(p => p.kind === 'm').blob.arrayBuffer())[1234] : null;
  return { task: s?.tasks?.some(t => t.title === 'Carried across'), note: s?.notes?.['note:moved']?.text, key: s?.settings?.aiKey === 'pretend-key', client: s?.settings?.clientId,
    old: s?.tasks?.some(t => t.title === 'Was here before'), toured: localStorage.getItem('weftday.toured'), recs: recs.map(r => r.title),
    parts: parts.map(p => `${p.kind}${p.n}:${p.blob.size}:${p.blob.type}`).sort(), first, hash: location.hash, moved: localStorage.getItem('weftday.moved') };
}"""


def watch(page, label):
    page.on('pageerror', lambda e: problems.append(f'{label}: {e}'))


def move(b, existing=False, accept=True):
    c = b.new_context()
    if existing:  # the new address already has things of its own
        n = c.new_page(); n.goto(NEW + '/icon.svg')
        n.evaluate("localStorage.setItem('planner.v1', JSON.stringify({ settings: {}, accounts: [], notes: {}, tasks: [{ id: 'here1', title: 'Was here before', done: false, duration: 30 }] }))")
        n.close()
    asked = []
    def on_page(pg):
        watch(pg, 'new')
        pg.on('dialog', lambda d: (asked.append(d.message), d.accept() if accept else d.dismiss()))
    c.on('page', on_page)
    old = c.new_page(); watch(old, 'old')
    old.goto(OLD + '/icon.svg'); old.evaluate(SEED, SAVED)
    old.goto(OLD + '/'); old.wait_for_selector('#card:not([hidden])')
    old.screenshot(path=os.path.join(os.path.dirname(__file__), '.out', 'move-start.png'))
    with c.expect_page() as opened:
        old.click('#move')
    new = opened.value
    return c, old, new, asked


def arrived(old, new):
    # (the pages forbid code made from text, so these wait on what is on screen rather than on a typed-in test)
    old.wait_for_selector('#title:has-text("have moved")', timeout=30000)
    new.wait_for_selector('#mainNav', timeout=30000)
    for _ in range(40):
        if new.evaluate("location.hash === '' && !document.querySelector('.movein')"): break
        new.wait_for_timeout(250)
    new.wait_for_timeout(800)


def run(pw):
    b = pw.chromium.launch(channel='chrome', headless=True)

    # 1. the plain case: nothing at the new address yet
    c, old, new, asked = move(b)
    arrived(old, new)
    new.wait_for_timeout(1200)
    got = new.evaluate(ARRIVED)
    check('move: the page at the old address says the things have moved', old.inner_text('#title') == 'Your things have moved' and not old.is_visible('#move'))
    check('move: tasks, notes and keys arrive at the new address', got['task'] and got['note'] == 'A note from the old address' and got['key'] and got['client'] == 'abc.apps.googleusercontent.com', json.dumps(got))
    check('move: the recording arrives whole', got['recs'] == ['Old recording'] and got['parts'] == ['m0:300000:video/webm', 'q0:50000:audio/webm'] and got['first'] == 7, json.dumps(got))
    check('move: the app starts normally afterwards, with no question asked', new.url.rstrip('/') == NEW and not asked and new.locator('.movein').count() == 0, f'{new.url} {asked}')
    check('move: the moved task shows in the app', new.locator('text=Carried across').count() > 0)
    left = old.evaluate("({ still: !!localStorage.getItem('planner.v1'), moved: !!localStorage.getItem('weftday.moved') })")
    check('move: nothing is deleted at the old address, and it remembers the move', left['still'] and left['moved'], json.dumps(left))
    # ... until the person asks: one button, one question, and then nothing of theirs is left there
    # (the question it asks is answered yes by the handler set up in move())
    check('move: afterwards the old address offers to remove its copy', old.is_visible('#forget'))
    old.screenshot(path=os.path.join(os.path.dirname(__file__), '.out', 'move-done.png'))
    old.click('#forget'); old.wait_for_selector('#forget', state='hidden', timeout=10000)
    gone = old.evaluate("""async () => ({ keys: Object.keys(localStorage).sort(), dbs: (await indexedDB.databases()).map(d => d.name) })""")
    check('move: that removes the saved things, sign-ins and recordings from the old address', gone['keys'] == ['weftday.moved'] and 'weftday-recordings' not in gone['dbs'], json.dumps(gone))
    still = new.evaluate(ARRIVED)
    check('move: and leaves the new address untouched', still['task'] and still['recs'] == ['Old recording'], json.dumps(still))
    old.goto(OLD + '/'); old.wait_for_url(NEW + '/**', timeout=10000)
    check('move: the old address then goes straight to the new one', old.url.startswith(NEW))
    old.goto(OLD + '/?again'); old.wait_for_selector('#card:not([hidden])')
    check('move: "?again" brings the page back for another go', old.is_visible('#move'))
    c.close()

    # 2. the new address already has things: it asks first, and yes replaces them
    c, old, new, asked = move(b, existing=True, accept=True)
    arrived(old, new)
    got = new.evaluate(ARRIVED)
    check('move: it asks before replacing things already at the new address', len(asked) == 1 and 'Replace them' in asked[0], str(asked))
    check('move: after a yes the old address’s things are the ones kept', got['task'] and not got['old'], json.dumps(got))
    c.close()

    # 3. the same, answered no: the things at the new address stay, and the recordings still come over
    c, old, new, asked = move(b, existing=True, accept=False)
    arrived(old, new)
    got = new.evaluate(ARRIVED)
    check('move: after a no, the things at the new address are kept', got['old'] and not got['task'], json.dumps(got))
    check('move: and the recordings are brought over all the same', got['recs'] == ['Old recording'] and len(got['parts']) == 2, json.dumps(got))
    check('move: the old address says what happened', 'kept what the new address already had' in old.inner_text('#lede'))
    c.close()

    # 3b. keys alone count as "things of your own": the question is asked for them too
    c = b.new_context(); n = c.new_page(); n.goto(NEW + '/icon.svg')
    n.evaluate("localStorage.setItem('planner.v1', JSON.stringify({ settings: { aiKey: 'mine' }, accounts: [], notes: {}, tasks: [] }))"); n.close()
    asked = []
    c.on('page', lambda pg: pg.on('dialog', lambda d: (asked.append(d.message), d.dismiss())))
    old = c.new_page(); old.goto(OLD + '/icon.svg'); old.evaluate(SEED, SAVED); old.goto(OLD + '/'); old.wait_for_selector('#card:not([hidden])')
    with c.expect_page() as opened: old.click('#move')
    new = opened.value; arrived(old, new)
    check('move: it asks before replacing a key that was typed in at the new address', len(asked) == 1 and new.evaluate("JSON.parse(localStorage.getItem('planner.v1')).settings.aiKey") == 'mine', str(asked))
    c.close()

    # 3c. another copy of the app, open and in view at the new address, loads afresh instead of saving its old state back
    c = b.new_context()
    other = c.new_page(); other.goto(NEW + '/'); other.wait_for_selector('#mainNav'); other.wait_for_timeout(800)
    other.evaluate("window.__same = true")
    old = c.new_page(); old.goto(OLD + '/icon.svg'); old.evaluate(SEED, SAVED); old.goto(OLD + '/'); old.wait_for_selector('#card:not([hidden])')
    with c.expect_page() as opened: old.click('#move')
    new = opened.value; arrived(old, new)
    other.wait_for_timeout(1500)
    check('move: another open copy of the app loads afresh with the moved things', other.evaluate("window.__same !== true && JSON.parse(localStorage.getItem('planner.v1')).tasks.some(t => t.title === 'Carried across')"))
    c.close()

    # 3d. parts of a recording that never finished arriving are cleared when the app next starts
    c = b.new_context(); n = c.new_page(); n.goto(NEW + '/icon.svg')
    n.evaluate("""async () => { const db = await new Promise((done, fail) => { const r = indexedDB.open('weftday-recordings', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('recs', { keyPath: 'id' }); r.result.createObjectStore('parts', { keyPath: ['id', 'kind', 'n'] }); };
      r.onsuccess = () => done(r.result); r.onerror = () => fail(r.error); });
      const tx = db.transaction(['recs', 'parts'], 'readwrite');
      tx.objectStore('recs').put({ id: 'whole', at: 1, kind: 'audio', done: true, title: 'Whole' });
      tx.objectStore('parts').put({ id: 'whole', kind: 'm', n: 0, blob: new Blob(['x']) });
      tx.objectStore('parts').put({ id: 'half', kind: 'm', n: 0, blob: new Blob(['y']) });
      await new Promise(done => { tx.oncomplete = done; }); db.close(); }""")
    n.goto(NEW + '/'); n.wait_for_selector('#mainNav'); n.wait_for_timeout(1500)
    left = n.evaluate("""async () => { const db = await new Promise(done => { const r = indexedDB.open('weftday-recordings'); r.onsuccess = () => done(r.result); });
      return await new Promise(done => { const r = db.transaction('parts').objectStore('parts').getAllKeys(); r.onsuccess = () => done(r.result.map(k => k[0])); }); }""")
    check('move: leftovers of a recording that never arrived whole are cleared, whole ones are kept', left == ['whole'], str(left))
    c.close()

    # 4. nothing saved at the old address: straight to the new one
    c = b.new_context(); p = c.new_page(); watch(p, 'empty')
    p.goto(OLD + '/'); p.wait_for_url(NEW + '/**', timeout=10000)
    check('move: with nothing saved, the old address goes straight to the new one', p.url.startswith(NEW))
    # 5. "#movein" typed by hand, with no tab behind it, is simply the app
    p.goto(NEW + '/#movein'); p.wait_for_selector('#mainNav')
    check('move: “#movein” with no old tab behind it just opens the app', p.locator('.movein').count() == 0)
    # 6. the old addresses of the pages forward to the right places
    for path, to in (('/guide.html', '/guide.html'), ('/privacy.html', '/privacy.html'), ('/terms.html', '/terms.html')):
        html = p.request.get(OLD + path).text()
        check(f'move: the old {path} forwards to the new one', f'url=https://app.weftday.crckd.live{to}"' in html)
    sw = p.request.get(OLD + '/sw.js').text()
    check('move: the old address only clears Weftday’s own kept files, and tells an open old tab to refresh', "startsWith('planner-shell-')" in sw and 'planner-shell-v9999' in sw)
    p.goto(OLD + '/?demo'); p.wait_for_url(NEW + '/**', timeout=10000)
    check('move: an old link to the sample data still opens the sample data', p.url.rstrip('/').endswith('?demo'), p.url)
    for path in ('/home.html', '/about.html', '/404.html'):
        html = p.request.get(OLD + path).text()
        check(f'move: the old {path} forwards to the website', 'url=https://weftday.crckd.live/"' in html)
    c.close()
    check('move: no errors in either tab', not problems, ' | '.join(problems[:4]))
    b.close()


with sync_playwright() as p:
    run(p)

failed = [r for r in results if not r[1]]
print(f'\n{len(results) - len(failed)} of {len(results)} move checks passed')
sys.exit(1 if failed else 0)
