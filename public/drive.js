// Share links: a copy of a recording is put in your own Google Drive, in a folder called
// "Weftday recordings", and Google gives it a link that anyone you send it to can open.
// Weftday asks Google only for the files it creates itself; it cannot see anything else in your Drive.
import * as G from './google.js';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'Weftday recordings', FOLDER_TYPE = 'application/vnd.google-apps.folder';

// What went wrong, in a form the screens can act on.
//   kind 'scope': Google has not been asked yet whether Weftday may add files to Drive
//   kind 'off':   Google Drive is not switched on for the Google project the keys belong to (err.link opens the switch)
//   kind 'policy': the organisation does not allow links that anyone can open
//   kind 'full':  the Drive has no room left
function problem(status, body) {
  const error = body?.error || {}, reason = `${error.errors?.[0]?.reason || ''} ${error.status || ''} ${(error.details || []).map(d => d.reason || '').join(' ')}`;
  const message = String(error.message || '').slice(0, 400);
  let kind = '', text = message || `Google Drive returned an error (${status}).`;
  if (status === 403 && /accessNotConfigured|SERVICE_DISABLED/i.test(reason) || /has not been used in project|it is disabled/i.test(message)) { kind = 'off'; text = 'Google Drive is not switched on for your Google project yet.'; }
  else if (status === 403 && /insufficient|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(`${reason} ${message}`)) { kind = 'scope'; text = 'Google has not been asked yet whether Weftday may add files to your Drive.'; }
  else if (status === 403 && /storageQuotaExceeded|quota/i.test(`${reason} ${message}`) && /storage/i.test(`${reason} ${message}`)) { kind = 'full'; text = 'Your Google Drive is full. Make some room there and try again.'; }
  else if (status === 403 || status === 400) kind = 'policy';
  else if (status === 404) kind = 'gone';
  const link = /https:\/\/console\.(?:developers|cloud)\.google\.com\/[^\s"'<>]+/.exec(message)?.[0] || '';
  return Object.assign(new Error(text), { status, kind, link });
}
async function call(acct, url, init = {}) {
  for (let attempt = 0; ; attempt++) {
    const token = await G.accessToken(acct);
    let res;
    try { res = await fetch(url, { ...init, cache: 'no-store', headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } }); }
    catch { throw Object.assign(new Error('Google Drive could not be reached. Check your connection and try again.'), { kind: 'offline' }); }
    if (res.status === 401 && attempt === 0) { acct.expiresAt = 0; continue; }
    if (res.status === 204) return null;
    const body = await res.json().catch(() => null);
    if (!res.ok) throw problem(res.status, body);
    return body;
  }
}

// The folder the copies go into. known: its id from last time, if any.
export async function folder(acct, known) {
  if (known) {
    try { const f = await call(acct, `${DRIVE}/files/${G.enc(known)}?fields=id,trashed`); if (f && !f.trashed) return f.id; }
    catch (err) { if (err.kind !== 'gone') throw err; } // deleted in Drive meanwhile: make a new one
  }
  const q = `name='${FOLDER}' and mimeType='${FOLDER_TYPE}' and trashed=false`;
  const found = await call(acct, `${DRIVE}/files?q=${G.enc(q)}&fields=${G.enc('files(id)')}&pageSize=1`);
  if (found?.files?.[0]) return found.files[0].id;
  return (await call(acct, `${DRIVE}/files?fields=id`, { method: 'POST', body: JSON.stringify({ name: FOLDER, mimeType: FOLDER_TYPE }) })).id;
}

// Puts one file in the folder. onProgress(0..1) is called as it goes up. Returns the file's id.
export async function upload(acct, blob, name, folderId, onProgress, signal) {
  const token = await G.accessToken(acct), edge = `weftday${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const type = blob.type || 'application/octet-stream';
  const body = new Blob([
    `--${edge}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folderId], mimeType: type })}\r\n--${edge}\r\nContent-Type: ${type}\r\n\r\n`,
    blob, `\r\n--${edge}--`,
  ]);
  return new Promise((done, fail) => {
    const xhr = new XMLHttpRequest(); // not fetch: this one can say how far the upload has got
    xhr.open('POST', `${UPLOAD}/files?uploadType=multipart&fields=id`);
    xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.setRequestHeader('content-type', `multipart/related; boundary=${edge}`);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onerror = () => fail(Object.assign(new Error('The upload was cut off. Check your connection and try again.'), { kind: 'offline' }));
    xhr.onabort = () => fail(new DOMException('Stopped', 'AbortError'));
    xhr.onload = () => {
      let answer = null;
      try { answer = JSON.parse(xhr.responseText); } catch { /* no answer to read */ }
      if (xhr.status >= 200 && xhr.status < 300 && answer?.id) done(answer.id); else fail(problem(xhr.status, answer));
    };
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

// Lets anyone who has the link open the file. Throws kind 'policy' when the organisation forbids that.
export const publish = (acct, id) => call(acct, `${DRIVE}/files/${G.enc(id)}/permissions`, { method: 'POST', body: JSON.stringify({ role: 'reader', type: 'anyone' }) });
export const linkTo = id => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;
// Takes the copy out of Drive, which also ends the link.
export async function remove(acct, id) {
  try { await call(acct, `${DRIVE}/files/${G.enc(id)}`, { method: 'DELETE' }); }
  catch (err) { if (err.kind !== 'gone') throw err; }
}
