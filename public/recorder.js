// Weftday's own recorder. It runs in the browser: no app to install and no server.
//
// What it records: a browser tab, a window or the whole screen with its sound, your microphone, or
// both mixed together. Nothing leaves this device: recordings are kept in this browser's own storage.
//
// How it stays safe: the recording is written to storage in small parts while it runs, so a crash or
// a closed tab loses a few seconds at most. Next to the main recording, the sound is also kept as
// separate short pieces (a few minutes each, each one a complete little file). Those pieces are what
// is later sent to an AI to write meeting notes, one at a time, however long the meeting was.

const DB = 'weftday-recordings', RECS = 'recs', PARTS = 'parts';
const PIECE_MS = 6 * 60000;  // length of one sound piece for the AI
const SLICE_MS = 5000;       // how often the main recording is written to storage

export const canCaptureScreen = () => !!navigator.mediaDevices?.getDisplayMedia && typeof MediaRecorder !== 'undefined';
export const canCaptureMic = () => !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
export const supported = () => canCaptureScreen() || canCaptureMic();

// ---- storage (IndexedDB)
let dbOpen = null;
function db() {
  dbOpen ||= new Promise((done, fail) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(RECS, { keyPath: 'id' });
      req.result.createObjectStore(PARTS, { keyPath: ['id', 'kind', 'n'] }); // kind: 'm' main recording, 'p' sound piece
    };
    req.onsuccess = () => done(req.result);
    req.onerror = () => { dbOpen = null; fail(req.error); };
  });
  return dbOpen;
}
const wait = req => new Promise((done, fail) => { req.onsuccess = () => done(req.result); req.onerror = () => fail(req.error); });
async function store(name, mode, fn) {
  const tx = (await db()).transaction(name, mode);
  const out = await fn(tx.objectStore(name));
  await new Promise((done, fail) => { tx.oncomplete = done; tx.onerror = () => fail(tx.error); tx.onabort = () => fail(tx.error); });
  return out;
}
const range = (id, kind) => IDBKeyRange.bound([id, kind, 0], [id, kind, Infinity]);

export const all = async () => (await store(RECS, 'readonly', s => wait(s.getAll()))).sort((a, b) => b.at - a.at);
export const forMeeting = async key => (await all()).filter(r => r.key === key);
export const get = id => store(RECS, 'readonly', s => wait(s.get(id)));
export const update = (id, fields) => store(RECS, 'readwrite', async s => { const r = await wait(s.get(id)); if (r) await wait(s.put({ ...r, ...fields })); return r; });
// The whole recording as one file, for playing or downloading.
export async function file(id) {
  const rec = await get(id), parts = await store(PARTS, 'readonly', s => wait(s.getAll(range(id, 'm'))));
  return rec ? new Blob(parts.map(p => p.blob), { type: rec.mime }) : null;
}
// The sound in short pieces, each a complete file, in order.
export const pieces = async id => (await store(PARTS, 'readonly', s => wait(s.getAll(range(id, 'p'))))).map(p => p.blob);
export async function remove(id) {
  await store(PARTS, 'readwrite', async s => { await wait(s.delete(range(id, 'm'))); await wait(s.delete(range(id, 'p'))); });
  await store(RECS, 'readwrite', s => wait(s.delete(id)));
}
// Space used by recordings, in bytes.
export const used = async () => (await all()).reduce((n, r) => n + (r.size || 0), 0);

// ---- recording
const pick = list => list.find(t => MediaRecorder.isTypeSupported(t)) || '';
const AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'];
const VIDEO_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/mp4', 'video/webm'];

let live = null; // the recording in progress, if any
export const current = () => live;

// Asks the browser for what to record. want = { screen: true|false, mic: true|false }.
// Returns { display, mic }: the streams the person agreed to (either may be null).
export async function ask(want) {
  let display = null, mic = null;
  if (want.screen) {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 }, audio: true,
      systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include', monitorTypeSurfaces: 'include',
    });
  }
  if (want.mic) {
    try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch (err) { if (!display) throw err; } // the screen alone still works without a microphone
  }
  return { display, mic };
}

// Starts recording the given streams. opts = { keepVideo, title, key, onTick(seconds), onEnd(record) }.
// streams.sound may be given instead of display/mic: a ready-made sound stream (used by the tests).
export async function start(streams, opts = {}) {
  if (live) throw new Error('A recording is already running.');
  const { display = null, mic = null } = streams;
  const ctx = new AudioContext();
  await ctx.resume().catch(() => {});
  const mix = ctx.createMediaStreamDestination();
  const sources = [display, mic, streams.sound].filter(s => s && s.getAudioTracks().length);
  if (!sources.length) {
    for (const s of [display, mic]) s?.getTracks().forEach(t => t.stop());
    ctx.close();
    throw Object.assign(new Error('No sound to record. In the box the browser shows, tick “Also share tab audio”, or switch your microphone on.'), { kind: 'nosound' });
  }
  for (const s of sources) ctx.createMediaStreamSource(new MediaStream(s.getAudioTracks())).connect(mix);
  const soundTrack = mix.stream.getAudioTracks()[0];
  const videoTrack = opts.keepVideo ? display?.getVideoTracks()[0] : null;
  const mime = videoTrack ? pick(VIDEO_TYPES) : pick(AUDIO_TYPES), pieceMime = pick(AUDIO_TYPES);
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const rec = {
    id, key: opts.key || '', title: opts.title || 'Recording', at: Date.now(), secs: 0, size: 0,
    kind: videoTrack ? 'video' : 'audio', mime: mime.split(';')[0], pieceMime: pieceMime.split(';')[0],
    heard: [display?.getAudioTracks().length ? 'the meeting' : '', mic ? 'your microphone' : ''].filter(Boolean), done: false,
  };
  await store(RECS, 'readwrite', s => wait(s.put(rec)));
  navigator.storage?.persist?.().catch(() => {}); // ask the browser not to clear this storage by itself

  const writes = []; // every write to storage, so "stop" can wait for them
  let n = 0, pn = 0;
  const save = (kind, num, blob) => { rec.size += kind === 'm' ? blob.size : 0; writes.push(store(PARTS, 'readwrite', s => wait(s.put({ id, kind, n: num, blob }))).catch(() => {})); };

  // the main recording, written out every few seconds
  const main = new MediaRecorder(new MediaStream(videoTrack ? [videoTrack, soundTrack] : [soundTrack]),
    { mimeType: mime, audioBitsPerSecond: videoTrack ? 64000 : 40000, ...(videoTrack ? { videoBitsPerSecond: 2500000 } : {}) });
  main.ondataavailable = e => { if (e.data.size) save('m', n++, e.data); };
  main.start(SLICE_MS);

  // the sound again, as short complete files for the AI: one recorder after another
  let piece = null, pieceTimer = 0, pieceStops = [];
  const startPiece = () => {
    const chunks = [], r = new MediaRecorder(new MediaStream([soundTrack]), { mimeType: pieceMime, audioBitsPerSecond: 32000 }), num = pn++;
    r.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    pieceStops.push(new Promise(done => { r.onstop = () => { if (chunks.length) save('p', num, new Blob(chunks, { type: pieceMime.split(';')[0] })); done(); }; }));
    r.start();
    piece = r;
    pieceTimer = setTimeout(() => { if (session.state === 'recording') { const old = piece; startPiece(); old.stop(); } }, PIECE_MS);
  };
  startPiece();

  // the clock only runs while recording, not while paused
  let ran = 0, since = Date.now();
  const seconds = () => Math.round((ran + (session.state === 'recording' ? Date.now() - since : 0)) / 1000);
  const ticker = setInterval(() => opts.onTick?.(seconds()), 1000);

  const session = {
    id, rec, state: 'recording', seconds,
    pause() {
      if (session.state !== 'recording') return;
      ran += Date.now() - since; session.state = 'paused';
      main.pause(); piece.pause(); clearTimeout(pieceTimer);
    },
    resume() {
      if (session.state !== 'paused') return;
      since = Date.now(); session.state = 'recording';
      main.resume(); piece.resume();
      pieceTimer = setTimeout(() => { if (session.state === 'recording') { const old = piece; startPiece(); old.stop(); } }, PIECE_MS);
    },
    async stop() {
      if (session.state === 'stopped') return rec;
      if (session.state === 'recording') ran += Date.now() - since;
      session.state = 'stopped';
      clearInterval(ticker); clearTimeout(pieceTimer);
      const ended = new Promise(done => { main.onstop = done; });
      if (main.state !== 'inactive') main.stop(); else main.onstop?.();
      if (piece.state !== 'inactive') piece.stop();
      await Promise.all([ended, ...pieceStops]);
      await Promise.all(writes);
      for (const s of [display, mic, streams.sound]) s?.getTracks().forEach(t => t.stop());
      ctx.close().catch(() => {});
      Object.assign(rec, { secs: Math.round(ran / 1000), done: true });
      await store(RECS, 'readwrite', s => wait(s.put(rec)));
      live = null;
      opts.onEnd?.(rec);
      return rec;
    },
  };
  // Pressing the browser's own "Stop sharing", or closing the shared tab, ends the recording.
  for (const t of display?.getTracks() || []) t.addEventListener('ended', () => session.stop());
  live = session;
  return session;
}

// A recording that was cut off (the tab closed, the browser crashed) keeps what was written.
// Called when the app opens: marks such recordings as finished so they can be played and used.
export async function recover() {
  if (live) return 0;
  let fixed = 0;
  for (const r of await all()) {
    if (r.done) continue;
    const parts = await store(PARTS, 'readonly', s => wait(s.getAll(range(r.id, 'm'))));
    if (!parts.length) { await remove(r.id); continue; }
    await update(r.id, { done: true, cut: true, size: parts.reduce((n, p) => n + p.blob.size, 0), secs: r.secs || parts.length * Math.round(SLICE_MS / 1000) });
    fixed++;
  }
  return fixed;
}
