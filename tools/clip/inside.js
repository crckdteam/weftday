// The clip's helpers inside the app's own page. tools/site-clip.py adds this file to the app as it opens
// it in Chrome; the app's files are not changed. It lets the clip find things on the screen and makes the
// app's short animations keep the clip's time instead of the computer's.
window.clip = (() => {
  return {
    // The box around every element that matches, in the app's pixels. "text" keeps the first that contains it.
    rect(sel, text) {
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, n = 0;
      for (const el of document.querySelectorAll(sel)) {
        if (text && !el.textContent.includes(text)) continue;
        const r = el.getBoundingClientRect(); if (!r.width && !r.height) continue;
        x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom); n++;
        if (text) break;
      }
      return n ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
    },
    // Whether the action point with these words in the notes is ticked.
    ticked(sel, text) { return [...document.querySelectorAll(sel)].some(el => el.textContent.includes(text) && el.hasAttribute('data-done')); },
    // Called once for every frame with the clip's time in seconds. The app's own animations (a box opening,
    // a page sliding in) are held still and moved on by hand, so they play at the right speed in the clip.
    step(t) {
      for (const a of document.getAnimations()) {
        if (a.playState === 'finished') continue;
        if (a.clipT0 === undefined) { a.clipT0 = t; a.pause(); }
        const at = (t - a.clipT0) * 1000, end = a.effect ? a.effect.getComputedTiming().endTime : 0;
        try { if (at >= end) a.finish(); else a.currentTime = at; } catch (e) { /* already over */ }
      }
    },
    // Used after a change made out of sight: every short animation jumps to its end.
    finish() {
      for (const a of document.getAnimations()) { try { if (isFinite(a.effect.getComputedTiming().endTime)) a.finish(); } catch (e) { /* already over */ } }
    },
  };
})();
