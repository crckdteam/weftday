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
const SOURCES = 'Sources: up to three web addresses you relied on. Give the real site addresses (for example linkedin.com/in/...), never a duckduckgo.com address.';
const UNREADABLE = 'If none of the pages could be read, answer with exactly: COULD NOT READ';
const about = (who, meeting, hint) => [
  `Name: ${who.name}`,
  who.company ? `Company (taken from their email address): ${who.company}, website ${who.domain}` : '',
  hint ? `What I already know about them: ${hint}` : '',
  meeting ? `Meeting title: "${meeting}"` : '',
].filter(Boolean);
const results = words => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(words)}`;

// With a real web search (Google's or Claude's), one question covers everything.
export function searchQuestion(who, meeting, hint) {
  return ['Use web search to find out who this person is and about their company. I am about to meet them.',
    ...about(who, meeting, hint), FORMAT, ...PERSON, ...(who.company ? COMPANY : []), CARE].join('\n');
}
// The free way is asked as two smaller questions, so neither has too many pages to read.
function personQuestion(who, meeting, hint) {
  const person = `${who.fullName ? `"${who.name}"` : who.name}${who.company ? ` ${who.company}` : ''}${hint ? ` ${hint}` : ''}`;
  return ['Read these pages, then tell me who this person is. I am about to meet them.',
    `Search results about the person: ${results(person)}`,
    `Search results for their profile: ${results(`${person} linkedin`)}`,
    `Search results for their education and career: ${results(`${person} education career`)}`,
    ...about(who, meeting, hint), FORMAT, ...PERSON, SOURCES, CARE, UNREADABLE].join('\n');
}
function companyQuestion(who) {
  const firm = `${who.company} ${who.domain}`;
  return [`Read these pages, then tell me about the company ${who.company} (website ${who.domain}).`,
    `The company's website: https://${who.domain}`,
    `Search results for its funding: ${results(`${firm} funding rounds investors raised`)}`,
    `Search results for its team: ${results(`${firm} founders leadership team number of employees`)}`,
    `Search results for its clients: ${results(`${firm} customers clients case studies`)}`,
    FORMAT, ...COMPANY, SOURCES, 'Only say what you actually found.', UNREADABLE].join('\n');
}

// Strips any markdown the model slipped in, so the labels can be read back.
export const tidyText = text => text.replace(/\*\*/g, '').replace(/^#+\s*/gm, '').replace(/^\s*[*•]\s+/gm, '- ').replace(/\n{3,}/g, '\n\n').trim();

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
  let text, kind = '';
  if (/API key not valid/i.test(message) || error?.status === 'UNAUTHENTICATED') text = 'Google did not accept that AI key. Check it in Settings.';
  else if (status === 429 && /quota|billing|plan/i.test(message)) { kind = 'billing'; text = 'Google says this key has used up what it is allowed for now. Try again later.'; }
  else if (status === 429) text = 'Google says this key has reached its limit for now. Try again later.';
  else if (status === 503 || /high demand|overloaded/i.test(message)) { kind = 'busy'; text = 'Google’s AI is very busy right now. Please try again in a minute.'; }
  else if (status === 404) { kind = 'busy'; text = 'Google’s AI could not answer. Please try again.'; } // a model that was withdrawn: try the next
  else text = message ? `Google’s AI could not answer: ${message}` : 'Google’s AI could not answer. Please try again.';
  return Object.assign(new Error(text.trim()), { status, kind });
}

const TIME_LIMIT = 45000; // a lookup that takes longer than this is given up on

async function ask(model, input, tool, key, signal) {
  const stop = new AbortController(), giveUp = () => stop.abort();
  signal?.addEventListener('abort', giveUp);
  const timer = setTimeout(giveUp, TIME_LIMIT);
  let res, data;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST', signal: stop.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ model, input, tools: [{ type: tool }], store: false }),
    });
    data = await res.json().catch(() => null);
  } catch (err) {
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    if (stop.signal.aborted) throw Object.assign(new Error('Google’s AI took too long. Please try again.'), { kind: 'slow' });
    throw new Error('Could not reach Google’s AI. Check your connection and try again.');
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
  for (const model of models) {
    try { return await run(model); }
    catch (err) { last = err; if (err.kind !== 'busy') throw err; }
  }
  throw last;
}

// Returns { text, sources: [{ url, title }], queries: [..], how: 'search' | 'reading' }.
// trySearch = false skips Google's own search (for keys already known not to have it).
// hint is anything you already know about the person, used to find the right one.
export async function personFacts(who, meeting, key, signal, trySearch = true, hint = '') {
  if (trySearch) {
    try {
      const found = await firstThatAnswers(SEARCH_MODELS, m => ask(m, searchQuestion(who, meeting, hint), 'google_search', key, signal));
      return { ...found, how: 'search' };
    } catch (err) { if (err.kind !== 'billing') throw err; } // no web search on this key: use the free way
  }
  const read = question => firstThatAnswers(READ_MODELS, m => ask(m, question, 'url_context', key, signal));
  const [person, company] = await Promise.allSettled([
    read(personQuestion(who, meeting, hint)),
    who.company ? read(companyQuestion(who)) : Promise.reject(new Error('no company')),
  ]);
  if (person.status === 'rejected') throw person.reason;
  if (/COULD NOT READ/.test(person.value.text)) throw new Error('The search pages could not be read just now. Please try again in a minute.');
  const extra = company.status === 'fulfilled' && !/COULD NOT READ/.test(company.value.text) ? `\n${company.value.text}` : '';
  return { text: person.value.text + extra, sources: [], queries: [], how: 'reading' };
}

// Puts the facts at the end of what you already wrote about the person, replacing an older set of facts.
export function mergeInto(existing, answer, dayText) {
  const at = existing.indexOf(MARK);
  const own = (at < 0 ? existing : existing.slice(0, at)).trim();
  const lines = [`${MARK} · ${dayText} —`, ...(answer.hint ? [`Hint: ${answer.hint}`] : []), answer.text];
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

// Label (lower case, spaces removed) -> where it goes in the parsed facts.
const LABELS = {
  role: 'role', location: 'location', background: 'background', education: 'education', expertise: 'expertise',
  company: 'company', teamsize: 'teamSize', team: 'teamSize', employees: 'teamSize', funding: 'funding',
  keypeople: 'people', people: 'people', leadership: 'people', clients: 'clients', customers: 'clients',
  recent: 'recent', ideas: 'ideas', linkedin: 'linkedin', sources: 'sources', hint: 'hint',
};
const TAG_LISTS = ['expertise', 'clients']; // shown as small tags, so a comma-separated line is split up
const asLink = text => {
  const found = /(https?:\/\/)?((?:[\w-]+\.)+[a-z]{2,}(?:\/[^\s,;)]*)?)/i.exec(text);
  if (!found) return null;
  const url = `https://${found[2].replace(/[.,;]+$/, '')}`;
  try { return { url, host: new URL(url).hostname.replace(/^www\./, '') }; } catch { return null; }
};
// { role, location, education, company, teamSize, linkedin,
//   background: [], expertise: [], funding: [], people: [], clients: [], recent: [], ideas: [], sources: [{ url, host }], other: [] }
export function parse(raw) {
  const out = {
    role: '', location: '', education: '', company: '', teamSize: '', linkedin: '', hint: '',
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
    if (!line || /^(none|n\/a|not found|unknown|not available|no information( available| found)?)\.?$/i.test(line)) continue;
    if (section === 'sources') {
      const link = asLink(line);
      if (link && !/duckduckgo\.com$/.test(link.host) && !out.sources.some(x => x.url === link.url)) out.sources.push(link);
    } else if (section === 'linkedin') {
      const link = asLink(line);
      if (link && /linkedin\.com$/.test(link.host)) out.linkedin = link.url;
    } else if (TAG_LISTS.includes(section)) {
      for (const tag of line.split(/[,;]| and (?=[A-Z])/)) { const t = tag.trim().replace(/\.$/, ''); if (t && out[section].length < 10) out[section].push(t); }
    } else if (Array.isArray(out[section])) out[section].push(line);
    else out[section] = out[section] ? `${out[section]} ${line}` : line;
  }
  out.role = out.role.replace(/\.$/, '');
  return out;
}
