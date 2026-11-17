// Weftday's own recorder. It runs in the browser: no app to install and no server.
//
// What it records: a browser tab, a window or the whole screen with its sound, your microphone, your
// camera (alone, or as a round picture in the corner of the screen), and single screenshots.
// Nothing leaves this device: everything is kept in this browser's own storage.
//
// How it stays safe: the recording is written to storage every second while it runs, so a crash or a
// closed tab loses a moment at most. Next to the main recording, the sound is also kept as separate
// short pieces (a few minutes each, each one a complete little file). Those pieces are what is later
// sent to an AI to write meeting notes, one at a time, however long the meeting was.

const DB = 'weftday-recordings', RECS = 'recs', PARTS = 'parts';
const PIECE_MS = 20 * 60000;  // length of one sound piece for the AI (it tells voices apart within one piece, so longer is better)
const PIECE_SLICE_MS = 5000;  // a piece is written to storage as it grows, so a crash keeps it too
const SLICE_MS = 1000;        // how often the main recording is written to storage
const BEAT_MS = 15000;        // how often a running recording notes that it is still alive
const DEAD_MS = 180000;       // silent for this long: it was cut off (a hidden tab's clock can run a minute late)
const STOP_WAIT_MS = 8000;    // how long to wait for the browser to hand over the last part
const THUMB_W = 480;

const has = name => typeof globalThis[name] !== 'undefined';
export const canCaptureScreen = () => !!navigator.mediaDevices?.getDisplayMedia && has('MediaRecorder');
export const canCaptureMic = () => !!navigator.mediaDevices?.getUserMedia && has('MediaRecorder');
export const canCaptureCamera = canCaptureMic;
// Drawing the camera into the picture of the screen needs these two newer browser parts.
export const canDrawCamera = () => has('MediaStreamTrackProcessor') && has('MediaStreamTrackGenerator') && has('OffscreenCanvas') && has('VideoFrame');
export const supported = () => canCaptureScreen() || canCaptureMic();

// ---- storage (IndexedDB)
let dbOpen = null;
function db() {
  dbOpen ||= new Promise((done, fail) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(RECS, { keyPath: 'id' });
      req.result.createObjectStore(PARTS, { keyPath: ['id', 'kind', 'n'] }); // kind: 'm' main recording, 'q' part of a sound piece ('p': a whole piece, first version)
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
const PIECE_STEP = 100000; // parts of sound piece k are numbered k * PIECE_STEP, k * PIECE_STEP + 1, …
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const putRec = rec => store(RECS, 'readwrite', s => wait(s.put(rec)));

export const all = async () => (await store(RECS, 'readonly', s => wait(s.getAll()))).sort((a, b) => b.at - a.at);
export const forMeeting = async key => (await all()).filter(r => r.key === key);
export const get = id => store(RECS, 'readonly', s => wait(s.get(id)));
export const update = (id, fields) => store(RECS, 'readwrite', async s => { const r = await wait(s.get(id)); if (r) await wait(s.put({ ...r, ...fields })); return r; });
// The whole recording as one file, for playing or downloading.
export async function file(id) {
  const rec = await get(id), parts = await store(PARTS, 'readonly', s => wait(s.getAll(range(id, 'm'))));
  return rec && parts.length ? new Blob(parts.map(p => p.blob), { type: rec.mime }) : null;
}
// The sound in pieces, in order: [{ blob, at }], where "at" is the second of the recording the piece starts at.
export async function pieces(id) {
  const rec = await get(id), grown = await store(PARTS, 'readonly', s => wait(s.getAll(range(id, 'q'))));
  if (!grown.length) { // made by the first version: every stored part is one whole six-minute piece
    return (await store(PARTS, 'readonly', s => wait(s.getAll(range(id, 'p'))))).map((p, i) => ({ blob: p.blob, at: i * 360 }));
  }
  const byPiece = new Map();
  for (const part of grown) { const k = Math.floor(part.n / PIECE_STEP); if (!byPiece.has(k)) byPiece.set(k, []); byPiece.get(k).push(part.blob); }
  return [...byPiece].sort((a, b) => a[0] - b[0]).map(([k, blobs]) => ({ blob: new Blob(blobs, { type: rec?.pieceMime || 'audio/webm' }), at: rec?.pieceAt?.[k] ?? k * PIECE_MS / 1000 }));
}
export async function remove(id) {
  await store(PARTS, 'readwrite', async s => { for (const kind of ['m', 'p', 'q']) await wait(s.delete(range(id, kind))); });
  await store(RECS, 'readwrite', s => wait(s.delete(id)));
}
// Space used by recordings, in bytes, and what the browser still has free (null when it will not say).
export const used = async () => (await all()).reduce((n, r) => n + (r.size || 0), 0);
export async function room() {
  try { const e = await navigator.storage.estimate(); return Math.max(0, (e.quota || 0) - (e.usage || 0)); } catch { return null; }
}

// ---- microphones and cameras
// The names stay empty until the person has allowed the browser to use them once.
export async function devices() {
  try {
    const list = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.deviceId);
    const of = kind => list.filter(d => d.kind === kind).map((d, i) => ({ id: d.deviceId, label: d.label || `${kind === 'audioinput' ? 'Microphone' : 'Camera'} ${i + 1}` }));
    return { mics: of('audioinput'), cams: of('videoinput'), named: list.some(d => d.label) };
  } catch { return { mics: [], cams: [], named: false }; }
}

// ---- asking the browser for what to record
const cancelled = err => err?.name === 'NotAllowedError' || err?.name === 'AbortError';
const stopAll = (...streams) => { for (const s of streams) s?.getTracks().forEach(t => t.stop()); };

// want = { screen, sound, mic, micId, cam, camId }. Returns { display, mic, cam } (each may be null) and
// what could not be had: noSystemSound, micFailed, camFailed.
export async function ask(want) {
  let display = null, mic = null, cam = null, micFailed = false, camFailed = false;
  if (want.screen) {
    // This must be the very first thing after the press: the browser only opens its chooser straight
    // from a click. Each step asks for a little less, for browsers that refuse the fuller request.
    const video = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
    const sound = want.sound === false ? false : { echoCancellation: false, noiseSuppression: false, autoGainControl: false }; // a meeting's sound is kept as it is
    const extras = { systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include', monitorTypeSurfaces: 'include' };
    const steps = [{ video, audio: sound, ...extras }, { video, audio: sound }, { video: true, audio: !!sound }, { video: true, audio: false }];
    let last = null;
    for (const step of steps) {
      try { display = await navigator.mediaDevices.getDisplayMedia(step); break; }
      catch (err) { if (cancelled(err)) throw err; last = err; }
    }
    if (!display) throw last;
  }
  const media = async (kind, wanted, id) => {
    try { return await navigator.mediaDevices.getUserMedia({ [kind]: id ? { ...wanted, deviceId: { exact: id } } : wanted }); }
    catch (err) { if (!id) throw err; return navigator.mediaDevices.getUserMedia({ [kind]: wanted }); } // the remembered one is gone: any will do
  };
  try {
    if (want.mic) {
      try { mic = await media('audio', { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, want.micId); } // a voice is cleaned up
      catch (err) { if (!display && !want.cam) throw err; micFailed = true; }
    }
    if (want.cam) {
      const size = want.screen ? { width: { ideal: 640 }, height: { ideal: 480 } } : { width: { ideal: 1280 }, height: { ideal: 720 } };
      try { cam = await media('video', { ...size, frameRate: { ideal: 30 } }, want.camId); }
      catch (err) { if (!display) throw err; camFailed = true; }
    }
  } catch (err) { stopAll(display, mic, cam); throw err; }
  return { display, mic, cam, micFailed, camFailed, noSystemSound: !!display && want.sound !== false && !display.getAudioTracks().length };
}

// ---- pictures: a still of a track, and small preview pictures
const even = n => Math.max(2, Math.round(n / 2) * 2);
async function grab(track) {
  if (has('ImageCapture')) { try { return await new ImageCapture(track).grabFrame(); } catch { /* fall through */ } }
  const video = Object.assign(document.createElement('video'), { muted: true, srcObject: new MediaStream([track]) });
  await video.play();
  await new Promise(done => (video.readyState >= 2 ? done() : video.addEventListener('loadeddata', done, { once: true })));
  const bitmap = await createImageBitmap(video);
  video.srcObject = null;
  return bitmap;
}
async function toBlob(source, width, type, quality) {
  const w0 = source.width || source.videoWidth, h0 = source.height || source.videoHeight;
  if (!w0 || !h0) return null;
  const w = width ? Math.min(width, w0) : w0, h = Math.round(h0 * w / w0);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(source, 0, 0, w, h);
  return { blob: await canvas.convertToBlob({ type, quality }), w: w0, h: h0 };
}
const smallPicture = async source => (await toBlob(source, THUMB_W, 'image/jpeg', 0.72))?.blob || null;

async function saveStill(bitmap, fields) {
  const full = await toBlob(bitmap, 0, 'image/png');
  if (!full) throw new Error('The screen gave no picture.');
  const id = newId(), rec = {
    id, key: '', title: 'Screenshot', at: Date.now(), secs: 0, size: full.blob.size, kind: 'shot', mime: 'image/png',
    w: full.w, h: full.h, thumb: await smallPicture(bitmap), done: true, ...fields,
  };
  await store(PARTS, 'readwrite', s => wait(s.put({ id, kind: 'm', n: 0, blob: full.blob })));
  await putRec(rec);
  return rec;
}
// One screenshot: the browser asks what to show, a single picture is taken, and sharing ends at once.
export async function shot(fields = {}) {
  const display = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false });
  try {
    await new Promise(done => setTimeout(done, 450)); // let the browser's own chooser leave the picture
    return await saveStill(await grab(display.getVideoTracks()[0]), fields);
  } finally { stopAll(display); }
}
// A small picture for a video that has none yet (one that was cut off, or made by an older version).
export async function makeThumb(id) {
  const rec = await get(id), blob = rec?.kind === 'video' && !rec.thumb ? await file(id) : null;
  if (!blob) return rec?.thumb || null;
  const url = URL.createObjectURL(blob), video = Object.assign(document.createElement('video'), { muted: true, preload: 'auto', src: url });
  try {
    await new Promise((done, fail) => { video.onloadeddata = done; video.onerror = fail; setTimeout(fail, 8000); });
    video.currentTime = Math.min(1, (rec.secs || 2) / 4);
    await new Promise(done => { video.onseeked = done; setTimeout(done, 3000); });
    const thumb = await smallPicture(video);
    if (thumb) await update(id, { thumb });
    return thumb;
  } catch { return null; } finally { URL.revokeObjectURL(url); video.removeAttribute('src'); video.load(); }
}

// ---- trimming: a copy of a recording from one moment to another
// An MP4 from the recorder is a short opening (what kind of file this is) followed by pieces of about
// two seconds, each complete in itself. A trimmed copy is the opening plus the pieces that are wanted,
// with their clocks set back so the copy starts at zero. Nothing is re-made, so it takes no time at
// all and loses no quality; the cut lands on the start of a piece.
function boxesIn(view, start, end) {
  const out = [];
  for (let at = start; at + 8 <= end;) {
    let size = view.getUint32(at), head = 8;
    if (size === 1) { size = Number(view.getBigUint64(at + 8)); head = 16; } else if (size === 0) size = end - at;
    if (size < head || at + size > end) break; // not a well-formed file: stop reading rather than guess
    out.push({ type: String.fromCharCode(view.getUint8(at + 4), view.getUint8(at + 5), view.getUint8(at + 6), view.getUint8(at + 7)), at, size, body: at + head });
    at += size;
  }
  return out;
}
const inside = (view, box) => boxesIn(view, box.body, box.at + box.size);
export const canTrim = rec => !!rec && rec.kind !== 'shot' && /mp4/.test(rec.mime || '');
// Returns the new recording (the original is left as it is).
export async function trim(id, from, to) {
  const rec = await get(id), blob = canTrim(rec) ? await file(id) : null;
  const fail = () => Object.assign(new Error('This recording cannot be trimmed.'), { kind: 'notrim' });
  if (!blob) throw fail();
  const buf = await blob.arrayBuffer(), view = new DataView(buf), top = boxesIn(view, 0, buf.byteLength);
  const moov = top.find(b => b.type === 'moov');
  if (!moov) throw fail();
  // how each track counts time
  const scale = new Map();
  for (const trak of inside(view, moov).filter(b => b.type === 'trak')) {
    const parts = inside(view, trak), tkhd = parts.find(b => b.type === 'tkhd'), mdia = parts.find(b => b.type === 'mdia');
    const mdhd = mdia && inside(view, mdia).find(b => b.type === 'mdhd');
    if (!tkhd || !mdhd) continue;
    scale.set(view.getUint32(tkhd.body + (view.getUint8(tkhd.body) ? 20 : 12)), view.getUint32(mdhd.body + (view.getUint8(mdhd.body) ? 20 : 12)));
  }
  // the pieces: each "moof" (its clock) with the "mdat" (its sound and picture) that follows it
  const pieces = [];
  for (let i = 0; i < top.length - 1; i++) {
    if (top[i].type !== 'moof' || top[i + 1].type !== 'mdat') continue;
    const clocks = [];
    for (const traf of inside(view, top[i]).filter(b => b.type === 'traf')) {
      const parts = inside(view, traf), tfhd = parts.find(b => b.type === 'tfhd'), tfdt = parts.find(b => b.type === 'tfdt');
      if (!tfhd || !tfdt) continue;
      const track = view.getUint32(tfhd.body + 4), wide = view.getUint8(tfdt.body) === 1, pos = tfdt.body + 4;
      clocks.push({ track, wide, pos, time: wide ? Number(view.getBigUint64(pos)) : view.getUint32(pos) });
    }
    if (!clocks.length || clocks.some(c => !scale.get(c.track))) throw fail();
    pieces.push({ at: top[i].at, size: top[i].size + top[i + 1].size, clocks, start: Math.min(...clocks.map(c => c.time / scale.get(c.track))) });
  }
  if (pieces.length < 2) throw fail();
  // keep the piece that holds "from" up to the piece that holds "to"
  let first = 0, last = pieces.length;
  for (let i = 0; i < pieces.length; i++) if (pieces[i].start <= from + 0.01) first = i;
  for (let i = pieces.length - 1; i > first; i--) if (pieces[i].start >= to - 0.01) last = i;
  const kept = pieces.slice(first, last), offset = kept[0].start, opening = pieces[0].at;
  const end = last < pieces.length ? pieces[last].start : Math.max(rec.secs || 0, pieces[pieces.length - 1].start + 0.5);
  const out = new Uint8Array(opening + kept.reduce((n, piece) => n + piece.size, 0)), src = new Uint8Array(buf), outView = new DataView(out.buffer);
  out.set(src.subarray(0, opening), 0);
  let at = opening;
  for (const piece of kept) {
    out.set(src.subarray(piece.at, piece.at + piece.size), at);
    for (const c of piece.clocks) { // this piece's clock, set back by what was cut off the front
      const time = Math.max(0, c.time - Math.round(offset * scale.get(c.track))), pos = at + (c.pos - piece.at);
      if (c.wide) outView.setBigUint64(pos, BigInt(time)); else outView.setUint32(pos, time);
    }
    at += piece.size;
  }
  const moved = list => (Array.isArray(list) ? list.filter(x => x.t >= offset - 0.5 && x.t < end).map(x => ({ ...x, t: Math.max(0, Math.round((x.t - offset) * 10) / 10) })) : undefined);
  const copy = {
    ...rec, id: newId(), title: `${rec.title} (trimmed)`.slice(0, 120), at: rec.at + 1, secs: Math.max(1, Math.round(end - offset)), size: out.byteLength,
    thumb: null, done: true, cut: false, pieceMime: '', pieceAt: undefined, trimmedFrom: rec.id, lines: moved(rec.lines), chapters: moved(rec.chapters),
  };
  await store(PARTS, 'readwrite', s => wait(s.put({ id: copy.id, kind: 'm', n: 0, blob: new Blob([out], { type: rec.mime }) })));
  await putRec(copy);
  return copy;
}

// ---- the camera drawn into the corner of the screen's picture
// Every picture of the screen and of the camera is read as it arrives and drawn onto one canvas, and
// that canvas is what gets recorded. It is driven by the arriving pictures, not by a timer, so it keeps
// running while Weftday's own tab is in the background (which is where it is during a meeting).
export const CAMERA_SIZES = { small: 0.18, medium: 0.25, large: 0.34 };
function compose(screenTrack, camTrack, look) {
  const out = new MediaStreamTrackGenerator({ kind: 'video' }), writer = out.writable.getWriter();
  const screen = new MediaStreamTrackProcessor({ track: screenTrack }).readable.getReader();
  const camera = new MediaStreamTrackProcessor({ track: camTrack }).readable.getReader();
  let canvas = null, g = null, base = null, bg = null, face = null, fg = null; // the picture, the last screen, the last camera
  let W = 0, H = 0, lastOut = 0, busy = false, ended = false, haveFace = false;
  const began = performance.now();

  const size = frame => { // set once, from the first picture of the screen; at most Full HD wide
    const scale = Math.min(1, 1920 / frame.displayWidth);
    W = even(frame.displayWidth * scale); H = even(frame.displayHeight * scale);
    canvas = new OffscreenCanvas(W, H); g = canvas.getContext('2d', { alpha: false });
    base = new OffscreenCanvas(W, H); bg = base.getContext('2d', { alpha: false });
    face = new OffscreenCanvas(512, 512); fg = face.getContext('2d', { alpha: false });
  };
  const bubble = () => {
    const d = Math.round(Math.min(W, H) * (CAMERA_SIZES[look.size] || CAMERA_SIZES.medium)), r = d / 2, m = Math.round(Math.min(W, H) * 0.035);
    const cx = look.corner?.includes('l') ? m + r : W - m - r, cy = look.corner?.includes('t') ? m + r : H - m - r;
    g.save();
    g.shadowColor = 'rgba(0,0,0,.4)'; g.shadowBlur = r * 0.22; g.shadowOffsetY = r * 0.05;
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fillStyle = '#111'; g.fill();
    g.restore();
    g.save();
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.clip();
    g.drawImage(face, cx - r, cy - r, d, d);
    g.restore();
    g.beginPath(); g.arc(cx, cy, r - 1.5, 0, Math.PI * 2); g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,.92)'; g.stroke();
  };
  const paint = async () => {
    const now = performance.now();
    if (ended || busy || !canvas || look.paused || now - lastOut < 31) return; // about thirty pictures a second, never more
    busy = true; lastOut = now;
    g.drawImage(base, 0, 0);
    if (look.on && haveFace) bubble();
    const frame = new VideoFrame(canvas, { timestamp: Math.round((now - began) * 1000) });
    try { if (writer.desiredSize > 0) await writer.write(frame); } catch { /* the recording has ended */ } finally { frame.close(); busy = false; }
  };
  const read = async (reader, each) => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || ended) { value?.close(); break; }
        try { each(value); } finally { value.close(); }
        paint();
      }
    } catch { /* the track ended */ }
  };
  read(screen, frame => {
    if (!canvas) size(frame);
    const w = frame.displayWidth, h = frame.displayHeight, k = Math.min(W / w, H / h), dw = w * k, dh = h * k; // a resized window is fitted in, never stretched
    if (Math.abs(dw - W) > 1 || Math.abs(dh - H) > 1) { bg.fillStyle = '#000'; bg.fillRect(0, 0, W, H); }
    bg.drawImage(frame, (W - dw) / 2, (H - dh) / 2, dw, dh);
  });
  read(camera, frame => {
    if (!face) return;
    const w = frame.displayWidth, h = frame.displayHeight, side = Math.min(w, h); // the middle square of the camera, like a mirror
    fg.save(); fg.translate(512, 0); fg.scale(-1, 1);
    fg.drawImage(frame, (w - side) / 2, (h - side) / 2, side, side, 0, 0, 512, 512);
    fg.restore();
    haveFace = true;
  });
  return {
    track: out,
    still: () => (canvas ? smallPicture(canvas) : null),
    stop() { ended = true; screen.cancel().catch(() => {}); camera.cancel().catch(() => {}); writer.close().catch(() => {}); out.stop(); },
  };
}

// ---- recording
const can = type => { try { return MediaRecorder.isTypeSupported(type); } catch { return false; } };
const pick = list => list.find(can) || '';
// MP4 first: it plays everywhere (phones, chat apps) and knows its own length. WebM where MP4 is missing.
const videoTypes = sound => (sound
  ? ['video/mp4;codecs="avc1.640028,mp4a.40.2"', 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
  : ['video/mp4;codecs="avc1.640028"', 'video/mp4;codecs="avc1.42E01E"', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']);
const AUDIO_TYPES = ['audio/mp4;codecs="mp4a.40.2"', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
const PIECE_TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'];

let live = null; // the recording in progress, if any
export const current = () => live;

// Starts recording the given streams.
// opts = { keepVideo, camera: { corner, size }, title, key, onTick(seconds), onEnd(record), onProblem(kind) }.
// streams.sound may be given instead of display/mic: a ready-made sound stream (used by the tests).
export async function start(streams, opts = {}) {
  if (live) throw new Error('A recording is already running.');
  const { display = null, mic = null, cam = null } = streams;
  const given = [display, mic, cam, streams.sound];
  const sources = [display, mic, streams.sound].filter(s => s && s.getAudioTracks().length);
  const screenTrack = opts.keepVideo ? display?.getVideoTracks()[0] || null : null;
  let camTrack = cam?.getVideoTracks()[0] || null;
  if (!sources.length && !screenTrack && !camTrack) {
    stopAll(...given);
    throw Object.assign(new Error('No sound to record. In the box the browser shows, switch on “Share with tab audio” (or “Share with system audio” for Entire screen), or switch your microphone on.'), { kind: 'nosound' });
  }

  // sound: everything goes through one limiter into one track, so loud moments do not crackle
  let ctx = null, soundTrack = null, analyser = null;
  if (sources.length) {
    ctx = new AudioContext();
    await Promise.race([ctx.resume(), new Promise(done => setTimeout(done, 10000))]).catch(() => {});
    const limiter = ctx.createDynamicsCompressor(), mixed = ctx.createMediaStreamDestination();
    limiter.threshold.value = -3; limiter.knee.value = 2; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.05;
    analyser = ctx.createAnalyser(); analyser.fftSize = 256;
    limiter.connect(mixed); limiter.connect(analyser);
    for (const s of sources) ctx.createMediaStreamSource(new MediaStream(s.getAudioTracks())).connect(limiter);
    soundTrack = mixed.stream.getAudioTracks()[0];
  }

  // picture: the screen, the screen with the camera in a corner, or the camera alone
  const look = { on: true, paused: false, corner: opts.camera?.corner || 'br', size: opts.camera?.size || 'medium' };
  let stage = null, videoTrack = screenTrack || camTrack;
  if (screenTrack && camTrack) {
    if (canDrawCamera()) { stage = compose(screenTrack, camTrack, look); videoTrack = stage.track; }
    else { stopAll(cam); camTrack = null; } // this browser cannot draw it in: the screen is recorded without it
  }

  const mime = videoTrack ? pick(videoTypes(!!soundTrack)) : pick(AUDIO_TYPES), pieceMime = soundTrack ? pick(PIECE_TYPES) : '';
  const id = newId();
  const rec = {
    id, key: opts.key || '', title: opts.title || 'Recording', at: Date.now(), secs: 0, size: 0,
    kind: videoTrack ? 'video' : 'audio', mime: mime.split(';')[0], pieceMime: pieceMime.split(';')[0],
    heard: [display?.getAudioTracks().length ? 'the meeting' : '', mic?.getAudioTracks().length ? 'your microphone' : ''].filter(Boolean),
    cam: !!camTrack, surface: screenTrack?.getSettings?.().displaySurface || '', beat: Date.now(), done: false,
  };
  await putRec(rec);
  navigator.storage?.persist?.().catch(() => {}); // ask the browser not to clear this storage by itself
  // While this is held, other open copies of Weftday know the recording is alive and leave it alone.
  let release = () => {};
  navigator.locks?.request(`weftday-rec-${id}`, () => new Promise(done => { release = done; })).catch(() => {});

  // writing to storage: one part after another, in order
  let queue = Promise.resolve(), broken = false, n = 0, pn = 0, session = null;
  const save = (kind, num, blob) => {
    if (kind === 'm') rec.size += blob.size;
    queue = queue.then(() => store(PARTS, 'readwrite', s => wait(s.put({ id, kind, n: num, blob })))).catch(() => {
      if (broken) return;
      broken = true; // storage is full or gone: stop now and keep what is already safe
      opts.onProblem?.('storage');
      session?.stop();
    });
  };

  // the main recording
  const tracks = [videoTrack, soundTrack].filter(Boolean);
  const main = new MediaRecorder(new MediaStream(tracks), {
    mimeType: mime, videoKeyFrameIntervalDuration: 2000, // a full picture every two seconds: easy to jump around in, and to rescue
    ...(soundTrack ? { audioBitsPerSecond: videoTrack ? 96000 : 64000 } : {}), ...(videoTrack ? { videoBitsPerSecond: 3000000 } : {}),
  });
  let gotData = false, pull = 0, failure = null;
  main.ondataavailable = e => { if (e.data.size) { gotData = true; save('m', n++, e.data); } };
  main.onerror = e => { failure = e.error || new Error('recorder'); session?.stop(); };
  main.start(SLICE_MS);
  // Some browsers hand nothing over on their own: then ask for each part.
  const guard = setTimeout(() => { if (!gotData) pull = setInterval(() => { if (main.state === 'recording') main.requestData(); }, SLICE_MS); }, 3500);

  // the clock only runs while recording, not while paused
  let ran = 0, since = performance.now();
  const seconds = () => Math.round((ran + (session?.state === 'recording' ? performance.now() - since : 0)) / 1000);
  // the sound again, as separate files for the AI: one recorder after another
  let piece = null, pieceTimer = 0;
  const pieceStops = [];
  const nextPiece = () => { pieceTimer = setTimeout(() => { if (session.state === 'recording') { const old = piece; startPiece(); old.stop(); } }, PIECE_MS); };
  const startPiece = () => {
    const num = pn++, r = new MediaRecorder(new MediaStream([soundTrack]), { mimeType: pieceMime, audioBitsPerSecond: 32000 });
    let part = 0;
    (rec.pieceAt ||= [])[num] = seconds(); // where in the recording this piece begins
    r.ondataavailable = e => { if (e.data.size) save('q', num * PIECE_STEP + part++, e.data); };
    pieceStops.push(new Promise(done => { r.onstop = done; r.onerror = done; }));
    r.start(PIECE_SLICE_MS);
    piece = r;
    nextPiece();
  };
  if (soundTrack && pieceMime) startPiece();

  const ticker = setInterval(() => opts.onTick?.(seconds()), 500);
  const beat = setInterval(() => { Object.assign(rec, { beat: Date.now(), secs: seconds() }); putRec(rec).catch(() => {}); }, BEAT_MS);
  // a small picture for the list, taken a moment in
  const thumb = async () => {
    if (rec.thumb || !videoTrack) return;
    try { rec.thumb = stage ? await stage.still() : await smallPicture(await grab(videoTrack)); } catch { /* tried again at the end */ }
  };
  const thumbTimer = setTimeout(thumb, 1500);
  const levels = analyser ? new Float32Array(analyser.fftSize) : null;

  session = {
    id, rec, state: 'recording', seconds, look,
    video: !!videoTrack, camera: !!camTrack && !!screenTrack, cam, // cam: the camera's stream, for showing it on screen
    // How loud it is right now, from 0 to 1.
    level() {
      if (!analyser || session.state !== 'recording') return 0;
      analyser.getFloatTimeDomainData(levels);
      let sum = 0;
      for (const v of levels) sum += v * v;
      return Math.min(1, Math.sqrt(sum / levels.length) * 3);
    },
    pause() {
      if (session.state !== 'recording') return;
      ran += performance.now() - since; session.state = 'paused'; look.paused = true;
      main.pause(); if (piece?.state === 'recording') piece.pause(); clearTimeout(pieceTimer);
    },
    resume() {
      if (session.state !== 'paused') return;
      since = performance.now(); session.state = 'recording'; look.paused = false;
      main.resume(); if (piece?.state === 'paused') { piece.resume(); nextPiece(); }
    },
    // Shows or hides the camera, or moves it, while recording.
    setCamera(change) { Object.assign(look, change); },
    // A still picture of what is being recorded right now, kept as its own screenshot.
    async snap() {
      const track = screenTrack || camTrack;
      if (!track) return null;
      return saveStill(await grab(track), { key: rec.key, title: `Still from ${rec.title}` });
    },
    async stop() {
      if (session.state === 'stopped') return rec;
      if (session.state === 'recording') ran += performance.now() - since;
      session.state = 'stopped';
      clearInterval(ticker); clearInterval(beat); clearInterval(pull); clearTimeout(guard); clearTimeout(pieceTimer); clearTimeout(thumbTimer);
      await thumb();
      const ended = new Promise(done => { main.onstop = done; });
      if (main.state !== 'inactive') main.stop(); else main.onstop?.();
      if (piece && piece.state !== 'inactive') piece.stop();
      // the browser normally hands over the last part at once; if it never does, what is stored is kept
      await Promise.race([Promise.all([ended, ...pieceStops]), new Promise(done => setTimeout(done, STOP_WAIT_MS))]);
      await queue;
      stage?.stop();
      stopAll(...given);
      ctx?.close().catch(() => {});
      Object.assign(rec, { secs: Math.round(ran / 1000), done: true, beat: Date.now(), ...(failure || broken ? { cut: true } : {}) });
      await putRec(rec).catch(() => {});
      release();
      live = null;
      opts.onEnd?.(rec);
      return rec;
    },
  };
  // Pressing the browser's own "Stop sharing", closing the shared tab, or unplugging the camera ends the recording.
  for (const t of [...(display?.getTracks() || []), ...(screenTrack ? [] : cam?.getTracks() || [])]) t.addEventListener('ended', () => session.stop());
  live = session;
  return session;
}

// A recording that was cut off (the tab closed, the browser crashed) keeps what was written.
// Called when the app opens: marks such recordings as finished so they can be played and used.
// One that is still running in another open copy of Weftday is left alone.
export async function recover() {
  let held = null;
  try { held = new Set((await navigator.locks.query()).held.map(l => l.name)); } catch { /* older browser: go by the clock */ }
  let fixed = 0;
  for (const r of await all()) {
    if (r.done || r.id === live?.id) continue;
    if (held ? held.has(`weftday-rec-${r.id}`) : Date.now() - (r.beat || r.at) < DEAD_MS) continue;
    const parts = await store(PARTS, 'readonly', s => wait(s.getAll(range(r.id, 'm'))));
    if (!parts.length) { await remove(r.id); continue; } // nothing was written: there is nothing to keep
    await update(r.id, { done: true, cut: true, size: parts.reduce((n, p) => n + p.blob.size, 0), secs: r.secs || parts.length * Math.round(SLICE_MS / 1000) });
    fixed++;
  }
  return fixed;
}
