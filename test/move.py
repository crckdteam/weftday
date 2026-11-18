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
  tx.objectStore('recs').put({ id: 'rec1', at: 1700000000000, title: 'Old recording', mime: 'video/webm', ms: 4000, size: 350000 });
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

    # 3. the same, answered no: nothing changes at the new address and the old page says it did not work
    c, old, new, asked = move(b, existing=True, accept=False)
    new.wait_for_selector('.movein h2:has-text("Nothing was moved")', timeout=15000)
    got = new.evaluate(ARRIVED)
    check('move: after a no, the things at the new address are untouched', got['old'] and not got['task'] and not got['recs'], json.dumps(got))
    check('move: the new tab says so and offers the app', new.is_visible('.movein a.btn') and got['hash'] == '')
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
