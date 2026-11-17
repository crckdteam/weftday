// Test helper only: serves the app together with a pretend Google Calendar that lives in memory,
// so the sync code can be exercised without a real Google account.
// Run:  node planner/test/mock-google.mjs   then open http://localhost:4322
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const port = Number(process.env.PORT) || 4322;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

let seq = 0, clock = Date.parse('2026-01-01T00:00:00Z');
const stamp = () => new Date(clock += 1000).toISOString();
// Each pretend account has its own calendars. An access token of the form "at:<email>" picks the account;
// any other token means me@test.dev. A refresh token "rt:<email>" can be swapped for "at:<email>".
const fresh = () => ({ users: {}, revoked: [], log: [] });
let db = fresh();
function user(email) {
  return db.users[email] ||= { calendars: [{ id: email, summary: email, primary: true, accessRole: 'owner', selected: true }], events: { [email]: [] } };
}
const who = req => { const m = /^Bearer at:(.+)$/.exec(req.headers.authorization || ''); return m ? m[1] : 'me@test.dev'; };

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(body == null ? '' : JSON.stringify(body)); };
const readBody = req => new Promise(r => { let s = ''; req.on('data', c => s += c); req.on('end', () => r(s ? JSON.parse(s) : {})); });
const span = e => [Date.parse(e.start.dateTime || e.start.date + 'T00:00:00Z'), Date.parse(e.end.dateTime || e.end.date + 'T00:00:00Z')];

async function api(req, res, url) {
  const parts = url.pathname.replace('/mock/calendar/v3/', '').split('/').map(decodeURIComponent);
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : null;
  const u = user(who(req));
  db.log.push(`${who(req)} ${req.method} ${parts.join('/')}`);
  if (parts[0] === 'users') return json(res, 200, { items: u.calendars });
  if (parts.length === 1 && req.method === 'POST') {
    const cal = { id: `cal${++seq}`, summary: body.summary, primary: false, accessRole: 'owner' };
    u.calendars.push(cal); u.events[cal.id] = [];
    return json(res, 200, cal);
  }
  if (parts.length === 2) { // one calendar's own details (name, description)
    const cal = u.calendars.find(c => c.id === parts[1]);
    if (!cal) return json(res, 404, { error: { message: 'Calendar not found' } });
    if (req.method === 'PATCH') Object.assign(cal, body);
    return json(res, 200, cal);
  }
  const list = u.events[parts[1]];
  if (!list) return json(res, 404, { error: { message: 'Calendar not found' } });
  if (parts.length === 3 && req.method === 'GET') {
    const min = Date.parse(url.searchParams.get('timeMin')), max = Date.parse(url.searchParams.get('timeMax'));
    return json(res, 200, { items: list.filter(e => e.status !== 'cancelled' && span(e)[1] > min && span(e)[0] < max) });
  }
  if (parts.length === 3 && req.method === 'POST') {
    const e = { ...body, id: `ev${++seq}`, status: 'confirmed', updated: stamp() };
    list.push(e);
    return json(res, 200, e);
  }
  const e = list.find(x => x.id === parts[3]);
  if (!e || e.status === 'cancelled') return json(res, e ? 410 : 404, { error: { message: 'Not found' } });
  if (req.method === 'DELETE') { e.status = 'cancelled'; e.updated = stamp(); res.writeHead(204); return res.end(); }
  if (req.method === 'PUT') { for (const k of Object.keys(e)) if (!['id', 'status'].includes(k)) delete e[k]; }
  Object.assign(e, body, { updated: stamp() });
  return json(res, 200, e);
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let p = decodeURIComponent(url.pathname);
    if (p === '/mock/reset') { db = fresh(); return json(res, 200, { ok: true }); }
    if (p === '/mock/dump') return json(res, 200, db);
    if (p === '/mock/token') { // pretend sign-in server: swaps a lasting sign-in for a short-lived one
      const b = new URLSearchParams(await new Promise(r => { let t = ''; req.on('data', c => t += c); req.on('end', () => r(t)); }));
      const rt = b.get('refresh_token') || '';
      if (!rt.startsWith('rt:') || db.revoked.includes(rt)) return json(res, 400, { error: 'invalid_grant' });
      return json(res, 200, { access_token: 'at:' + rt.slice(3).replace(/#.*$/, ''), expires_in: 3600 });
    }
    if (p === '/mock/revoke') { db.revoked.push((await readBody(req)).token); return json(res, 200, { ok: true }); }
    if (p === '/mock/edit') { // pretend another device changed something: { acct?, cal, id?, patch?, add?, remove? }
      const b = await readBody(req), list = user(b.acct || 'me@test.dev').events[b.cal];
      if (b.add) list.push({ ...b.add, id: `ev${++seq}`, status: 'confirmed', updated: stamp() });
      const e = list.find(x => x.id === b.id);
      if (e && b.patch) Object.assign(e, b.patch, { updated: stamp() });
      if (e && b.remove) e.status = 'cancelled';
      return json(res, 200, { ok: true });
    }
    if (p.startsWith('/mock/calendar/v3/')) return await api(req, res, url);
    if (p === '/') p = '/index.html';
    const file = path.join(root, path.normalize(p));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end('Forbidden'); return; }
    let data = await readFile(file);
    if (p === '/google.js') { // point the app at the pretend Google instead of the real one
      const src = data.toString().replace("const API = 'https://www.googleapis.com/calendar/v3';", "const API = location.origin + '/mock/calendar/v3';")
        .replace("const TOKEN = 'https://oauth2.googleapis.com/token';", "const TOKEN = location.origin + '/mock/token';");
      if (!src.includes('/mock/calendar/v3') || !src.includes('/mock/token')) throw new Error('google.js changed: update the mock');
      data = Buffer.from(src);
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err));
  }
}).listen(port, '127.0.0.1', () => console.log(`Weftday with pretend Google at http://localhost:${port}`));
