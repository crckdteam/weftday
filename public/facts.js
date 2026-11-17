// "Get facts": looks a person and their company up on the web with an AI service of your choice, using
// your own key. It only runs when asked. Your browser talks to the services directly; the person's
// name, their company and the meeting's title are what is sent.
//
// How the facts are found, best first:
// 1. The AI searches the web by itself (Claude, OpenAI, Perplexity, or Google with billing on).
// 2. A search service (your own key, see services.js) finds pages, and the AI writes from those results.
// 3. Google's AI only, no search key: it reads the company's own website, with Wikipedia's summary of
//    the company. This covers the company well and the person only if the site mentions them.
import { aiService, webSearch, chat, searchChat } from './services.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const SEARCH_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']; // the next is tried when one is too busy
const READ_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.6-flash'];
export const MARK = '— Facts from the web'; // what follows this line in a note is replaced on the next run

const FORMAT = 'Write in plain text. No markdown, no asterisks. Use exactly these labels, each starting its own line, and leave a label out completely when you found nothing for it:';
const PERSON = [
  'Role: their current job title and company, in a few words.',
  'Location: the city or country they are based in.',
  'Background: two or three short lines on their career and what they are known for, each on its own line starting with "- ".',
  'Education: where they studied and what, in one line.',
  'Expertise: three to six short topics they are an expert in, separated by commas.',
  'Recent: up to three recent, relevant things about them or their company (news, posts, launches), each on its own line starting with "- ".',
  'Ideas: up to two short things worth asking them about in this meeting, based only on what you found, each on its own line starting with "- ".',
  'LinkedIn: the address of their LinkedIn profile, if you find it.',
];
const COMPANY = [
  'Company: one line on what the company does.',
  'Team size: roughly how many people work at the company, with the year if known.',
  'Funding: the company\'s funding rounds, most recent first, each on its own line starting with "- ", with the round, amount, year and lead investors when known. If it is bootstrapped, public or part of a larger company, say that in one line instead.',
  'Key people: up to five senior people at the company with their roles, each on its own line starting with "- ".',
  'Clients: notable customers or clients of the company, separated by commas.',
];
const CARE = 'Only say what you actually found. If you cannot tell which person this is, say so plainly and name the most likely matches instead of guessing.';
const SOURCES = 'Sources: up to four web addresses you relied on, one per line starting with "- ".';
const about = (who, meeting, hint) => [
  `Name: ${who.name}`,
  who.company ? `Company (taken from their email address): ${who.company}, website ${who.domain}` : '',
  hint ? `What I already know about them: ${hint}` : '',
  meeting ? `Meeting title: "${meeting}"` : '',
].filter(Boolean);

// With a real web search (Google's or Claude's), one question covers everything.
// who.skipFirm leaves the company out: its facts are already saved from a colleague's profile.
export function searchQuestion(who, meeting, hint) {
  return ['Use web search to find out who this person is and about their company. I am about to meet them.',
    ...about(who, meeting, hint), FORMAT, ...PERSON, ...(who.company && !who.skipFirm ? COMPANY : []), CARE].join('\n');
}
// Free way with a search key: the searches are done first, and the AI writes from what they returned.
function resultsQuestion(who, meeting, hint, digest) {
  return ['Below are web search results about a person I am about to meet and their company. Using only these results, tell me who they are.',
    ...about(who, meeting, hint), FORMAT, ...PERSON, ...(who.company && !who.skipFirm ? COMPANY : []), SOURCES, CARE, '', 'Search results:', digest].join('\n');
}
// Free way without a search key: the company's own pages.
function websiteQuestion(who, meeting, wiki) {
  const site = `https://${who.domain}`;
  return [`Read the company's own website, then tell me about ${who.company} and, if the site mentions them, about ${who.name}, who works there. I am about to meet them.`,
    `Pages to read (some may not exist; use the ones that do): ${site} ${site}/about ${site}/company ${site}/team ${site}/customers`,
    wiki ? `Wikipedia says about the company: ${wiki}` : '',
    ...about(who, meeting, ''), FORMAT,
    'Role: their job title at the company, only if the website states it.',
    ...COMPANY,
    'Recent: up to three recent things the website mentions (launches, news), each on its own line starting with "- ".',
    'Ideas: up to two short things worth asking them about in this meeting, based only on what you found, each on its own line starting with "- ".',
    SOURCES, 'Only say what you actually found.', 'If the website could not be read at all, answer with exactly: COULD NOT READ'].filter(Boolean).join('\n');
}

// Wikipedia's short summary of the company, if it has one. Free and open to web pages.
async function wikiSummary(who, signal) {
  try {
    const api = 'https://en.wikipedia.org/w/api.php?format=json&origin=*&action=query';
    const found = await fetch(`${api}&list=search&srlimit=1&srsearch=${encodeURIComponent(`${who.company} company ${who.domain}`)}`, { signal }).then(r => r.json());
    const title = found?.query?.search?.[0]?.title;
    if (!title || !title.toLowerCase().includes(who.company.toLowerCase().slice(0, 5))) return '';
    const page = await fetch(`${api}&prop=extracts&exintro=1&explaintext=1&titles=${encodeURIComponent(title)}`, { signal }).then(r => r.json());
    return String(Object.values(page?.query?.pages || {})[0]?.extract || '').replace(/\s+/g, ' ').slice(0, 900);
  } catch { return ''; }
}

// Strips any markdown the model slipped in, so the labels can be read back.
const LABEL_WORDS = '(role|location|background|education|expertise|recent|ideas|linkedin|company|team size|funding|key people|clients|sources)';
export function tidyText(text) {
  const lines = text.replace(/\*\*/g, '').replace(/^#+\s*/gm, '').split('\n');
  // Some models write every label as a list item ("- Role: …"). Those are turned back into labels.
  // When labels are written plainly, a list item that happens to start with a label word
  // ("- Funding: raised $20M") is left alone: it belongs to the list it is in.
  const asBullet = new RegExp(`^(\\s*)[-*•]\\s+${LABEL_WORDS}\\s*:`, 'i');
  const first = lines.find(l => l.trim()) || '', bulleted = asBullet.test(first) && first.search(/\S/) < 2;
  return lines.map(line => {
    const m = asBullet.exec(line);
    if (m && bulleted && m[1].length < 2) return line.replace(/^\s*[-*•]\s+/, '');
    return line.replace(/^\s*[*•]\s+/, '- ');
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Google's reply is a list of steps. The answer text and its sources are picked out wherever they sit,
// leaving out the model's private reasoning and the raw pages it read.
function readAnswer(data) {
  const texts = [], sources = new Map(), queries = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (['thought', 'google_search_result', 'url_context_call', 'url_context_result'].includes(node.type)) return;
    if (node.type === 'google_search_call') { for (const q of node.arguments?.queries || []) if (typeof q === 'string') queries.push(q); return; }
    if (node.type === 'text' && typeof node.text === 'string') texts.push(node.text);
    if (node.type === 'url_citation' && /^https:\/\//.test(node.url || '') && !sources.has(node.url)) sources.set(node.url, String(node.title || '').slice(0, 80));
    for (const value of Object.values(node)) walk(value);
  })(data);
  const text = tidyText(texts.join('\n'));
  return { text, sources: [...sources].slice(0, 5).map(([url, title]) => ({ url, title })), queries: queries.slice(0, 3) };
}

function problem(status, error) {
  const message = String(error?.message || '').slice(0, 200);
  let text, kind = '', sure = false; // sure: Google said outright that this key has no web search
  if (/API key not valid/i.test(message) || error?.status === 'UNAUTHENTICATED') { kind = 'key'; text = 'Google did not accept that AI key. Check it in Settings.'; }
  else if (status === 429 && /quota|billing|plan/i.test(message)) { kind = 'billing'; sure = /limit:\s*0\b|free[_ -]?tier/i.test(message); text = 'Google says this key has used up what it is allowed for now. Try again later.'; }
  else if (status === 429) { kind = 'credit'; text = 'Google says this key has reached its limit for now. Try again later.'; }
  else if (status === 503 || /high demand|overloaded/i.test(message)) { kind = 'busy'; text = 'Google’s AI is very busy right now. Please try again in a minute.'; }
  else if (status === 404) { kind = 'busy'; text = 'Google’s AI could not answer. Please try again.'; } // a model that was withdrawn: try the next
  else text = message ? `Google’s AI could not answer: ${message}` : 'Google’s AI could not answer. Please try again.';
  return Object.assign(new Error(text.trim()), { status, kind, sure });
}

const TIME_LIMIT = 45000; // a lookup that takes longer than this is given up on

async function ask(model, input, tool, key, signal) { // tool: 'google_search', 'url_context' or '' for none
  const stop = new AbortController(), giveUp = () => stop.abort();
  signal?.addEventListener('abort', giveUp);
  const timer = setTimeout(giveUp, TIME_LIMIT);
  let res, data;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST', signal: stop.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ model, input, ...(tool ? { tools: [{ type: tool }] } : {}), store: false }),
    });
    data = await res.json().catch(() => null);
  } catch (err) {
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    if (stop.signal.aborted) throw Object.assign(new Error('Google’s AI took too long. Please try again.'), { kind: 'slow' });
    throw Object.assign(new Error('Could not reach Google’s AI. Check your connection and try again.'), { kind: 'offline' });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', giveUp);
  }
  if (Array.isArray(data)) data = data[0];
  if (!res.ok || data?.error) throw problem(res.status, data?.error);
  const answer = readAnswer(data);
  if (!answer.text) throw new Error('Google’s AI gave no answer. Please try again.');
  return answer;
}
async function firstThatAnswers(models, run) {
  let last;
  const order = [...models, models[0]]; // all busy at once is usually over in seconds: the first gets one more go
  for (let i = 0; i < order.length; i++) {
    if (i === models.length) await new Promise(done => setTimeout(done, 2500));
    try { return await run(order[i]); }
    catch (err) { last = err; if (err.kind !== 'busy') throw err; }
  }
  throw last;
}

// Returns { text, sources: [{ url, title }], queries: [..], how: 'search' | 'results' | 'website' }.
// keys = { provider, key, model, google, search, searchKind }: the AI service chosen in Settings with
// its key and (optional) model, your Google AI key, and your search key with the service it is for.
// trySearch = false skips Google's own search (for keys already known not to have it).
// hint is anything you already know about the person, used to find the right one.
export async function personFacts(who, meeting, keys, signal, trySearch = true, hint = '') {
  const svc = aiService(keys.provider), google = svc.kind === 'google';
  const write = input => (google
    ? firstThatAnswers(READ_MODELS, m => ask(m, input, '', keys.google, signal))
    : chat(svc, keys.key, keys.model, input, signal).then(a => ({ ...a, text: tidyText(a.text) })));
  let noSearch = false; // Google said for certain that this key has no web search of its own
  if (google && trySearch) {
    try {
      const found = await firstThatAnswers(SEARCH_MODELS, m => ask(m, searchQuestion(who, meeting, hint), 'google_search', keys.google, signal));
      return { ...found, how: 'search' };
    } catch (err) { if (err.kind !== 'billing') throw err; noSearch = !!err.sure; } // no web search on this key (or not right now): use a free way
  }
  if (!google && svc.ownSearch) { // an AI that searches the web by itself
    try {
      const found = await searchChat(svc, keys.key, keys.model, `${searchQuestion(who, meeting, hint)}\n${SOURCES}`, signal);
      return { ...found, text: tidyText(found.text), how: 'search' };
    } catch (err) { if (!['model', 'nosearch'].includes(err.kind) || !keys.search || !svc.base) throw err; } // no model of theirs can search: use the search key
  }
  if (keys.search) {
    const person = `${who.fullName ? `"${who.name}"` : who.name}${who.company ? ` ${who.company}` : ''}${hint ? ` ${hint}` : ''}`;
    const queries = [person, `${person} LinkedIn education career`];
    if (who.company && !who.skipFirm) queries.push(`${who.company} ${who.domain} funding rounds investors number of employees`, `${who.company} ${who.domain} customers clients leadership team`);
    const found = (await Promise.all(queries.map(q => webSearch(keys.searchKind, q, keys.search, signal)))).flat();
    const pages = [...new Map(found.map(r => [r.url, r])).values()].slice(0, 16);
    if (!pages.length) throw new Error('The search found nothing about this person. Try “Not them?” with a hint.');
    const digest = pages.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content}`).join('\n\n');
    const answer = await write(resultsQuestion(who, meeting, hint, digest));
    return { ...answer, queries, how: 'results', noSearch };
  }
  if (!google) throw Object.assign(new Error(`${svc.name} cannot search the web by itself. Add a free search key in Settings → AI.`), { kind: 'needsSearch' });
  if (!who.company) throw Object.assign(new Error('To look up a person without a company website, add a free search key in Settings → AI.'), { kind: 'needsSearch' });
  const wiki = await wikiSummary(who, signal);
  const answer = await firstThatAnswers(READ_MODELS, m => ask(m, websiteQuestion(who, meeting, wiki), 'url_context', keys.google, signal));
  if (/COULD NOT READ/.test(answer.text)) throw new Error('The company’s website could not be read. Add a free search key in Settings → AI to look them up another way.');
  return { text: `${answer.text}\nCoverage: company website only`, sources: [], queries: [], how: 'website', noSearch };
}

// Puts the facts at the end of what you already wrote about the person, replacing an older set of facts.
export function mergeInto(existing, answer, dayText) {
  const at = existing.indexOf(MARK);
  const own = (at < 0 ? existing : existing.slice(0, at)).trim();
  const lines = [`${MARK} · ${dayText} —`, ...(answer.hint ? [`Hint: ${answer.hint}`] : []), answer.text];
  if (answer.sources.length) lines.push('', 'Sources:', ...answer.sources.map(s => `- ${s.title ? `${s.title}: ` : ''}${s.url}`));
  return `${own ? `${own}\n\n` : ''}${lines.join('\n')}`;
}

// A plain question to the chosen AI service, with no web search. Returns the answer as text.
export async function askPlain(input, keys, signal) {
  const svc = aiService(keys.provider);
  if (svc.kind === 'google') return (await firstThatAnswers(READ_MODELS, m => ask(m, input, '', keys.google, signal))).text;
  if (svc.kind === 'chat' && svc.base) return (await chat(svc, keys.key, keys.model, input, signal)).text;
  throw Object.assign(new Error(`${svc.name} cannot be used for this.`), { kind: 'noplain' });
}

// ---- photos found on the web
// Puts the pictures a search returned in order, most likely to be this person first, and marks the
// ones with real evidence (their name in the picture's caption or address) as "sure". A picture is
// only shown by itself when it is sure; the rest are offered for you to pick from.
const EXPIRING = /licdn\.com|fbcdn\.net|fbsbx\.com|cdninstagram\.com|twimg\.com\/profile_banners/i; // addresses that stop working after a while
export function rankPhotos(images, who) {
  const words = who.name.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const first = words[0] || '', last = words.length > 1 ? words[words.length - 1] : '';
  const firm = (who.company || '').toLowerCase();
  const seen = new Set(), out = [];
  for (const img of images) {
    const url = String(img?.url || '');
    if (!/^https:\/\//.test(url) || url.length > 320 || seen.has(url) || EXPIRING.test(url) || /\.(svg|gif)(\?|$)/i.test(url)) continue;
    seen.add(url);
    let path = url.toLowerCase();
    try { path = decodeURIComponent(path); } catch { /* keep as is */ }
    const text = `${img.title || ''} ${img.description || ''}`.toLowerCase();
    // whole words only: "ann" must not match "Joanne", nor "stan" + "ford" match "stanford"
    const has = (where, word) => !!word && new RegExp(`(^|[^a-z])${word.replace(/[^a-z0-9]/g, '.')}([^a-z]|$)`).test(where);
    const named = last ? has(text, first) && has(text, last) : has(text, first) && (!!firm && text.includes(firm));
    const inPath = last ? has(path, first) && has(path, last) : has(path, first) && (!!who.domain && path.includes(who.domain.split('.')[0]));
    let score = (named ? 5 : 0) + (inPath ? 4 : 0) + (last && has(path, last) ? 1 : 0);
    if (/portrait|headshot|smil|profile (photo|picture)/.test(text)) score += 1;
    if (/\b(two|three|four|five|several|group|team|crowd|panel|audience)\b/.test(text)) score -= 3;
    if (/logo|icon|banner|chart|graph|screenshot|diagram|infographic|illustration|cartoon|building|skyline|product|book cover|poster/.test(text) || /logo|icon|sprite|banner|placeholder|default[-_]?(avatar|profile)/.test(path)) score -= 6;
    if (score > -3) out.push({ url, sure: (named || inPath) && score >= 4, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 6).map(({ url, sure }) => ({ url, sure }));
}
// Sets the photo shown for a person in their saved note ('' removes it).
export function setPhoto(note, url) {
  const { own, raw, day } = split(note);
  if (!raw) return note;
  const lines = raw.split('\n').filter(l => !/^photo\s*:/i.test(l.trim()));
  return join(own, [`Photo: ${url || 'none'}`, ...lines].join('\n'), day);
}

// ---- reading a saved note back: your own words, and the facts as tidy parts for display
// A person's note is "<what you wrote>\n\n— Facts from the web · <day> —\n<the brief>".
export function split(note) {
  const at = note.indexOf(MARK);
  if (at < 0) return { own: note, raw: '', day: '' };
  const rest = note.slice(at), firstLine = rest.split('\n', 1)[0];
  return { own: note.slice(0, at).trim(), raw: rest.slice(firstLine.length).trim(), day: (/·\s*(.+?)\s*—\s*$/.exec(firstLine) || [])[1] || '' };
}
export const join = (own, raw, day) => `${own.trim()}${raw ? `${own.trim() ? '\n\n' : ''}${MARK} · ${day} —\n${raw}` : ''}`;

// Label (lower case, spaces removed) -> where it goes in the parsed facts.
const LABELS = {
  role: 'role', location: 'location', background: 'background', education: 'education', expertise: 'expertise',
  company: 'company', teamsize: 'teamSize', team: 'teamSize', employees: 'teamSize', funding: 'funding',
  keypeople: 'people', people: 'people', leadership: 'people', clients: 'clients', customers: 'clients',
  recent: 'recent', ideas: 'ideas', linkedin: 'linkedin', sources: 'sources', hint: 'hint', coverage: 'coverage',
  photo: 'photo', photos: 'photos',
};
const SINGLE = new Set(['role', 'location', 'education', 'company', 'teamSize', 'linkedin', 'hint', 'coverage']); // one line each
const TAG_LISTS = ['expertise', 'clients']; // shown as small tags, so a comma-separated line is split up
const asLink = text => {
  // a written-out address wins over a word that merely looks like one ("Acme.io raises…: https://…")
  const found = /https?:\/\/((?:[\w-]+\.)+[a-z]{2,}(?:\/[^\s,;]*)?)/i.exec(text) || /()((?:[\w-]+\.)+[a-z]{2,}(?:\/[^\s,;]*)?)/i.exec(text);
  if (!found) return null;
  let rest = (found[2] || found[1]).replace(/[.,;]+$/, '');
  if (rest.endsWith(')') && !rest.includes('(')) rest = rest.slice(0, -1); // a closing bracket of the sentence, not of the address
  const url = `https://${rest}`;
  try { return { url, host: new URL(url).hostname.replace(/^www\./, '') }; } catch { return null; }
};
// { role, location, education, company, teamSize, linkedin,
//   background: [], expertise: [], funding: [], people: [], clients: [], recent: [], ideas: [], sources: [{ url, host }], other: [] }
export function parse(raw) {
  const out = {
    role: '', location: '', education: '', company: '', teamSize: '', linkedin: '', hint: '', coverage: '',
    photo: '', photoSet: false, photos: [], // the picture shown (photoSet: one was chosen, even if it is "none") and the others found
    background: [], expertise: [], funding: [], people: [], clients: [], recent: [], ideas: [], sources: [], other: [],
  };
  let section = 'other';
  for (const line0 of raw.split('\n')) {
    let line = line0.trim();
    if (!line) continue;
    const label = /^([A-Za-z][A-Za-z ]{1,18}?)\s*:\s*(.*)$/.exec(line);
    const known = label && LABELS[label[1].toLowerCase().replace(/\s+/g, '')];
    if (known) { section = known; line = label[2].trim(); if (!line) continue; }
    line = line.replace(/^[-•*]\s*/, '').trim();
    if (section === 'photo') { out.photoSet = true; out.photo = /^https:\/\//.test(line) ? line : ''; section = 'other'; continue; }
    if (section === 'photos') { if (/^https:\/\//.test(line) && out.photos.length < 8) out.photos.push(line); continue; }
    if (!line || /^(none|n\/a|not found|unknown|not available|no information( available| found)?)\.?$/i.test(line)) continue;
    if (section === 'sources') {
      const link = asLink(line);
      if (!link) { section = 'other'; out.other.push(line); continue; } // a closing remark after the list
      if (!out.sources.some(x => x.host === link.host)) out.sources.push(link); // one tag per site
    } else if (section === 'linkedin') {
      const link = asLink(line);
      if (link && /linkedin\.com$/.test(link.host)) out.linkedin = link.url; else out.other.push(line);
      section = 'other';
    } else if (TAG_LISTS.includes(section)) {
      for (const tag of line.split(/[,;]| and (?=[A-Z])/)) { const t = tag.trim().replace(/\.$/, ''); if (t && out[section].length < 10) out[section].push(t); }
    } else if (Array.isArray(out[section])) out[section].push(line);
    else {
      out[section] = out[section] ? `${out[section]} ${line}` : line;
      if (SINGLE.has(section)) section = 'other'; // what follows without a label is a remark of its own
    }
  }
  out.role = out.role.replace(/\.$/, '');
  return out;
}
