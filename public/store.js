// Everything the app remembers lives in this browser's local storage.
// Opening the app with ?demo uses a separate store filled with sample data.

export const DEMO = new URLSearchParams(location.search).has('demo');
const KEY = DEMO ? 'planner.demo.v1' : 'planner.v1';

const base = () => ({
  settings: {
    clientId: '', clientSecret: '', plannerAccountId: '', plannerCalendarId: '', reminder: 10, view: '',
    theme: 'auto', dayStart: 9 * 60, dayEnd: 18 * 60, morning: 8 * 60, // minutes after midnight; morning -1 = off
  },
  accounts: [],     // connected Google accounts
  tasks: [],        // your tasks and time blocks
  tombstones: [],   // Google event ids waiting to be deleted
  notified: {},     // reminders already shown
  lastBrief: '',    // the day the morning summary was last shown
});

function load() {
  const b = base();
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s) { Object.assign(b, s); b.settings = { ...base().settings, ...(s.settings || {}) }; }
  } catch { /* start fresh */ }
  return b;
}

export const state = load();

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { console.warn('Could not save', e); }
}

const EVKEY = KEY + '.events';
export function loadEventCache() {
  try { return JSON.parse(localStorage.getItem(EVKEY) || 'null'); } catch { return null; }
}
export function saveEventCache(week, events) {
  try { localStorage.setItem(EVKEY, JSON.stringify({ week, events })); } catch { /* cache is optional */ }
}
