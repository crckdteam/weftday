// "Get facts": looks a person up on the web with Google's AI, using your own Google AI key.
// It only runs when you press the button. Your browser talks to Google directly; the person's name,
// their company and the meeting's title are what is sent.
//
// Two ways, tried in this order:
// 1. Google's own web search. Google only allows this for keys with billing switched on.
// 2. Free: the AI reads a page of search results (DuckDuckGo) and the company's website. This works
//    with a free key. It is a little less thorough, and it stops working if those pages stop being readable.

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const SEARCH_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']; // the next is tried when one is too busy
const READ_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.6-flash'];
export const MARK = '— Facts from the web'; // what follows this line in a note is replaced on the next run

const BRIEF = [
  'Write a short brief in plain text. No markdown, no asterisks. Use exactly these labels, each starting its own line, and leave out a label when you found nothing for it:',
  'Role: their current job title and company, in a few words.',
  'Location: the city or country they are based in.',
  'Background: two or three short lines on their career and what they are known for, each on its own line starting with "- ".',
  'Company: one line on what the company does.',
  'Recent: up to three recent, relevant things (news, posts, launches), each on its own line starting with "- ".',
  'Ideas: up to two short things worth asking them about in this meeting, based only on what you found, each on its own line starting with "- ".',
  'LinkedIn: the address of their LinkedIn profile, if you find it.',
];
const CARE = 'Only say what you actually found. If you cannot tell which person this is, say so plainly and name the most likely matches instead of guessing.';
const about = (who, meeting) => [
  `Name: ${who.name}`,
  who.company ? `Company (taken from their email address): ${who.company}, website ${who.domain}` : '',
  meeting ? `Meeting title: "${meeting}"` : '',
].filter(Boolean);

function searchQuestion(who, meeting) {
  return ['Use web search to find out who this person is. I am about to meet them.', ...about(who, meeting), ...BRIEF, CARE].join('\n');
}

function readQuestion(who, meeting) {
  const words = `${who.fullName ? `"${who.name}"` : who.name}${who.company ? ` ${who.company}` : ''}`;
  const results = extra => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(words + extra)}`;
  return [
    'Read these pages, then tell me who this person is. I am about to meet them.',
    `Search results: ${results('')}`,
    `Search results for their profile: ${results(' linkedin')}`,
    who.company ? `Their company's website: https://${who.domain}` : '',
    ...about(who, meeting),
    ...BRIEF,
    'Sources: up to three web addresses you relied on. Give the real site addresses (for example linkedin.com/in/...), never a duckduckgo.com address.',
    CARE,
    'If none of the pages could be read, answer with exactly: COULD NOT READ',
  ].filter(Boolean).join('\n');
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
  const text = texts.join('\n').replace(/\*\*/g, '').replace(/^#+\s*/gm, '').replace(/^\s*[*•]\s+/gm, '- ').replace(/\n{3,}/g, '\n\n').trim();
  return { text, sources: [...sources].slice(0, 5).map(([url, title]) => ({ url, title })), queries: queries.slice(0, 3) };
}

function problem(status, error) {
  const message = String(error?.message || '').slice(0, 200);
  let text, kind = '';
  if (/API key not valid/i.test(message) || error?.status === 'UNAUTHENTICATED') text = 'Google did not accept that AI key. Check it in Settings.';
  else if (status === 429 && /quota|billing|plan/i.test(message)) { kind = 'billing'; text = 'Google says this key has used up what it is allowed for now. Try again later.'; }
  else if (status === 429) text = 'Google says this key has reached its limit for now. Try again later.';
  else if (status === 503 || /high demand|overloaded/i.test(message)) { kind = 'busy'; text = 'Google’s AI is very busy right now. Please try again in a minute.'; }
  else if (status === 404) { kind = 'busy'; text = 'Google’s AI could not answer. Please try again.'; } // a model that was withdrawn: try the next
  else text = message ? `Google’s AI could not answer: ${message}` : 'Google’s AI could not answer. Please try again.';
  return Object.assign(new Error(text.trim()), { status, kind });
}

async function ask(model, input, tool, key, signal) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ model, input, tools: [{ type: tool }], store: false }),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error('Could not reach Google’s AI. Check your connection and try again.');
  }
  let data = await res.json().catch(() => null);
  if (Array.isArray(data)) data = data[0];
  if (!res.ok || data?.error) throw problem(res.status, data?.error);
  const answer = readAnswer(data);
  if (!answer.text) throw new Error('Google’s AI gave no answer. Please try again.');
  return answer;
}
async function firstThatAnswers(models, run) {
  let last;
  for (const model of models) {
    try { return await run(model); }
    catch (err) { last = err; if (err.kind !== 'busy') throw err; }
  }
  throw last;
}

// Returns { text, sources: [{ url, title }], queries: [..], how: 'search' | 'reading' }.
// trySearch = false skips Google's own search (for keys already known not to have it).
export async function personFacts(who, meeting, key, signal, trySearch = true) {
  if (trySearch) {
    try {
      const found = await firstThatAnswers(SEARCH_MODELS, m => ask(m, searchQuestion(who, meeting), 'google_search', key, signal));
      return { ...found, how: 'search' };
    } catch (err) { if (err.kind !== 'billing') throw err; } // no web search on this key: use the free way
  }
  const read = await firstThatAnswers(READ_MODELS, m => ask(m, readQuestion(who, meeting), 'url_context', key, signal));
  if (/COULD NOT READ/.test(read.text)) throw new Error('The search pages could not be read just now. Please try again in a minute.');
  return { ...read, how: 'reading' };
}

// Puts the facts at the end of what you already wrote about the person, replacing an older set of facts.
export function mergeInto(existing, answer, dayText) {
  const at = existing.indexOf(MARK);
  const own = (at < 0 ? existing : existing.slice(0, at)).trim();
  const lines = [`${MARK} · ${dayText} —`, answer.text];
  if (answer.sources.length) lines.push('', 'Sources:', ...answer.sources.map(s => `- ${s.title ? `${s.title}: ` : ''}${s.url}`));
  return `${own ? `${own}\n\n` : ''}${lines.join('\n')}`;
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

const LABELS = { role: 'role', location: 'location', background: 'background', company: 'company', recent: 'recent', ideas: 'ideas', linkedin: 'linkedin', sources: 'sources' };
const asLink = text => {
  const found = /(https?:\/\/)?((?:[\w-]+\.)+[a-z]{2,}(?:\/[^\s,;)]*)?)/i.exec(text);
  if (!found) return null;
  const url = `https://${found[2].replace(/[.,;]+$/, '')}`;
  try { return { url, host: new URL(url).hostname.replace(/^www\./, '') }; } catch { return null; }
};
// { role, location, company, linkedin, background: [], recent: [], ideas: [], sources: [{ url, host }], other: [] }
export function parse(raw) {
  const out = { role: '', location: '', company: '', linkedin: '', background: [], recent: [], ideas: [], sources: [], other: [] };
  let section = 'other';
  for (const line0 of raw.split('\n')) {
    let line = line0.trim();
    if (!line) continue;
    const label = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(line);
    if (label && LABELS[label[1].toLowerCase()]) { section = LABELS[label[1].toLowerCase()]; line = label[2].trim(); if (!line) continue; }
    line = line.replace(/^[-•*]\s*/, '').trim();
    if (!line || /^(none|n\/a|not found|unknown)\.?$/i.test(line)) continue;
    if (section === 'sources') {
      const link = asLink(line);
      if (link && !/duckduckgo\.com$/.test(link.host) && !out.sources.some(x => x.url === link.url)) out.sources.push(link);
    } else if (section === 'linkedin') {
      const link = asLink(line);
      if (link && /linkedin\.com$/.test(link.host)) out.linkedin = link.url;
    } else if (Array.isArray(out[section])) out[section].push(line);
    else out[section] = out[section] ? `${out[section]} ${line}` : line;
  }
  out.role = out.role.replace(/\.$/, '');
  return out;
}
