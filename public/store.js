// Everything the app remembers lives in this browser's local storage.
// Opening the app with ?demo uses a separate store filled with sample data.

export const DEMO = new URLSearchParams(location.search).has('demo');
const KEY = DEMO ? 'planner.demo.v1' : 'planner.v1';

const base = () => ({
  settings: {
    clientId: '', clientSecret: '', plannerAccountId: '', plannerCalendarId: '', reminder: 10, view: '',
    zone2: '',        // a second time zone shown next to your own on the calendar ('' = none)
    freeZone: '', freeDaytime: true, zonesUsed: [], // "Share my free times": the zone it is written in, and the zones you used before
    sideWidth: 0, // width of the side panel on a computer, if you dragged it; 0 = the usual width
    theme: 'auto', dayStart: 9 * 60, dayEnd: 18 * 60, morning: 8 * 60, // minutes after midnight; morning -1 = off
    shareAccounts: false, // keep the account list the same on all devices (see vault.js)
    pictures: true,       // show people's photos (Gravatar) and company logos (site icons)
    aiApp: 'claude',      // which AI app the "Ask AI" link about a person opens
    aiKey: '',            // your own Google AI key, for "Get facts" (kept only in this browser)
    aiFreeSince: 0,       // when this key was last found to have no Google web search (free plan)
    aiProvider: 'google', // which AI service "Get facts" uses (see services.js)
    searchKey: '',        // your own free search key (Tavily), used with the Google key to find facts about a person
    claudeKey: '',        // your own Anthropic key, when Claude is chosen (kept only in this browser)
    aiKeys: {},           // keys for the other AI services, by service name (see services.js)
    aiModels: {},         // a model you chose yourself for a service; empty means the usual one
    searchProvider: 'tavily', // which search service the search key is for
    searchKeys: {},       // keys for search services other than Tavily, by service name
    keysAt: 0,            // when the AI and search keys last changed here, so the newest set wins across devices
    recAsk: true,         // offer to record as a meeting with other people begins
    aiAuto: false,        // get facts by itself for the people in today's meetings
    aiQuick: true,        // "Add a task": Enter hands a sentence to your AI when the simple reader cannot take it
  },
  accounts: [],     // connected Google accounts
  tasks: [],        // your tasks and time blocks
  tombstones: [],   // Google event ids waiting to be deleted
  seriesUntil: {},  // for each repeating task, the last day already written out as real tasks
  notified: {},     // reminders already shown
  lastBrief: '',    // the day the morning summary was last shown
  goneAccounts: [], // accounts removed here, so other devices drop them too
  notes: {},        // your private notes on meetings (see notes.js)
  names: {},        // full names of people seen in your calendars, by email address
  factsTried: {},   // when each person was last looked up automatically, by email address
  sharedSeen: false, // the shared account list has been found in Google at least once
});

function load() {
  const b = base();
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s) { Object.assign(b, s); b.settings = { ...base().settings, ...(s.settings || {}) }; }
    const st = b.settings; // keys added before they could travel between devices count as the oldest set
    if (!st.keysAt && (st.aiKey || st.claudeKey || st.searchKey || Object.keys(st.aiKeys || {}).length || Object.keys(st.searchKeys || {}).length)) st.keysAt = 1;
  } catch { /* start fresh */ }
  return b;
}

export const state = load();

// Two copies of Weftday open at once (two tabs, or a tab and the installed app) each hold their own
// copy of everything. The one in the background stops saving as soon as the other one saves, so it
// can never write old data over new, and it loads afresh when you come back to it.
let stale = false;
export const isStale = () => stale;
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('storage', e => { if (e.key === KEY && document.hidden) stale = true; });
  document.addEventListener('visibilitychange', () => { if (stale && !document.hidden) location.reload(); });
}

export function save() {
  if (stale) return;
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch (e) { console.warn('Could not save', e); if (typeof window !== 'undefined') window.dispatchEvent(new Event('weftday-save-failed')); }
}

const EVKEY = KEY + '.events';
export function loadEventCache() {
  try { return JSON.parse(localStorage.getItem(EVKEY) || 'null'); } catch { return null; }
}
export function saveEventCache(week, events) {
  try { localStorage.setItem(EVKEY, JSON.stringify({ week, events })); } catch { /* cache is optional */ }
}
