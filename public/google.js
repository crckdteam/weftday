// Talks to Google directly from this device: sign-in and Calendar requests.
// There is no server in between. Sign-in keys are kept in this browser only.
import { state, save } from './store.js';

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
const SCOPE = 'https://www.googleapis.com/auth/calendar';
const PENDING = 'planner.oauth';
export const COLORS = ['#2f6fed', '#1a9a6c', '#8e5bd6', '#e07a1f', '#d6457f', '#0e9aa7'];

// The address Google sends you back to: the folder this app is served from.
export const redirectUri = () => location.origin + location.pathname.replace(/[^/]*$/, '');
export const enc = encodeURIComponent;

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Step 1: send the user to Google's sign-in page.
export async function startConnect(loginHint) {
  const { clientId } = state.settings;
  if (!clientId) throw new Error('Add your Google Client ID in Settings first.');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const st = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  localStorage.setItem(PENDING, JSON.stringify({ verifier, st }));
  const p = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent select_account',
    code_challenge: challenge, code_challenge_method: 'S256', state: st,
  });
  if (loginHint) p.set('login_hint', loginHint);
  location.assign(`${AUTH}?${p}`);
}

// Step 2: back from Google. Swap the one-time code for long-lived access.
export async function finishConnect() {
  const q = new URLSearchParams(location.search);
  const code = q.get('code'), st = q.get('state'), error = q.get('error');
  if (!code && !error) return null;
  history.replaceState(null, '', location.pathname);
  const pending = JSON.parse(localStorage.getItem(PENDING) || 'null');
  localStorage.removeItem(PENDING);
  if (error) throw new Error(error === 'access_denied' ? 'Google sign-in was cancelled.' : `Google sign-in failed: ${error}`);
  if (!pending || pending.st !== st) throw new Error('Sign-in could not be verified. Please try again.');

  const tok = await tokenRequest({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: pending.verifier,
  });
  if (!tok.refresh_token) throw new Error('Google did not grant lasting access. Please try connecting again.');
  const creds = { accessToken: tok.access_token, expiresAt: Date.now() + tok.expires_in * 1000, refreshToken: tok.refresh_token };

  const list = await api(creds, '/users/me/calendarList', { params: { maxResults: 250 } });
  const primary = (list.items || []).find(c => c.primary);
  if (!primary) throw new Error('Could not read this account\'s calendars.');
  let acct = state.accounts.find(a => a.id === primary.id);
  if (!acct) {
    acct = { id: primary.id, email: primary.id, color: COLORS[state.accounts.length % COLORS.length], calendars: [] };
    state.accounts.push(acct);
  }
  Object.assign(acct, creds, { needsReconnect: false });
  mergeCalendars(acct, list.items || []);
  save();
  return acct;
}

async function tokenRequest(params) {
  const { clientId, clientSecret } = state.settings;
  const body = new URLSearchParams({ client_id: clientId, ...params });
  if (clientSecret) body.set('client_secret', clientSecret);
  const r = await fetch(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error_description || j.error || 'Google sign-in request failed');
    e.code = j.error;
    throw e;
  }
  return j;
}

const refreshing = new Map();
async function token(acct) {
  if (acct.accessToken && acct.expiresAt - 60000 > Date.now()) return acct.accessToken;
  const key = acct.id || acct.refreshToken;
  if (!refreshing.has(key)) {
    refreshing.set(key, tokenRequest({ grant_type: 'refresh_token', refresh_token: acct.refreshToken })
      .then(t => {
        acct.accessToken = t.access_token;
        acct.expiresAt = Date.now() + t.expires_in * 1000;
        acct.needsReconnect = false;
        save();
      })
      .catch(e => {
        if (e.code === 'invalid_grant') { acct.needsReconnect = true; save(); }
        throw e;
      })
      .finally(() => refreshing.delete(key)));
  }
  await refreshing.get(key);
  return acct.accessToken;
}

// One Calendar request for one account.
export async function api(acct, path, { method = 'GET', params, body } = {}) {
  const url = new URL(API + path);
  if (params) for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    const tk = await token(acct);
    const r = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${tk}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401 && attempt === 0) { acct.expiresAt = 0; continue; }
    if (r.status === 204) return null;
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      const e = new Error(j?.error?.message || `Google returned an error (${r.status})`);
      e.status = r.status;
      throw e;
    }
    return j;
  }
}

export async function listEvents(acct, calId, from, to) {
  const items = [];
  let pageToken;
  do {
    const j = await api(acct, `/calendars/${enc(calId)}/events`, {
      params: {
        timeMin: from.toISOString(), timeMax: to.toISOString(),
        singleEvents: true, orderBy: 'startTime', maxResults: 2500, pageToken,
      },
    });
    items.push(...(j.items || []));
    pageToken = j.nextPageToken;
  } while (pageToken);
  return items;
}

export function mergeCalendars(acct, items) {
  const old = new Map((acct.calendars || []).map(c => [c.id, c]));
  acct.calendars = items.map(c => ({
    id: c.id,
    summary: c.summaryOverride || c.summary || c.id,
    primary: !!c.primary,
    accessRole: c.accessRole,
    enabled: old.has(c.id) ? old.get(c.id).enabled : (!!c.primary || !!c.selected),
  }));
}

export async function refreshCalendars(acct) {
  const list = await api(acct, '/users/me/calendarList', { params: { maxResults: 250 } });
  mergeCalendars(acct, list.items || []);
  save();
}

// Finds or creates the "My Planner" calendar that holds your task blocks.
export async function ensurePlannerCalendar(acct) {
  await refreshCalendars(acct);
  let cal = acct.calendars.find(c => c.summary === 'My Planner' && c.accessRole === 'owner');
  if (!cal) {
    const made = await api(acct, '/calendars', {
      method: 'POST',
      body: { summary: 'My Planner', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    });
    cal = { id: made.id, summary: 'My Planner', primary: false, accessRole: 'owner', enabled: true };
    acct.calendars.push(cal);
    save();
  }
  return cal.id;
}
