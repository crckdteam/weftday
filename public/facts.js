// "Get facts": looks a person up on the web with Google's AI, using your own Google AI key.
// It only runs when you press the button. Your browser talks to Google directly; the person's name,
// their company and the meeting's title are what is sent.

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MODEL = 'gemini-3.8-flash';
export const MARK = '— Facts from the web'; // what follows this line in a note is replaced on the next run

function question(who, meeting) {
  return [
    'Use web search to find out who this person is. I am about to meet them.',
    `Name: ${who.name}`,
    who.company ? `Company (taken from their email address): ${who.company}, website ${who.domain}` : '',
    meeting ? `Meeting title: "${meeting}"` : '',
    '',
    'Write a short brief in plain text. No markdown, no asterisks, no headings other than these labels:',
    'Role: their current job title and company.',
    'Background: two or three short lines on their career and what they are known for.',
    'Company: one line on what the company does.',
    'Recent: up to three recent, relevant things (news, posts, launches), one line each.',
    'LinkedIn: the address of their LinkedIn profile, if you find it.',
    '',
    'Only say what the search results support. If you cannot tell which person this is, say so plainly and name the most likely matches instead of guessing.',
  ].filter(line => line !== '').join('\n');
}

// Google's reply is a list of steps. The answer text and its sources are picked out wherever they sit,
// leaving out the model's private reasoning.
function readAnswer(data) {
  const texts = [], sources = new Map(), queries = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === 'thought') return;
    if (node.type === 'google_search_call') { for (const q of node.arguments?.queries || []) if (typeof q === 'string') queries.push(q); return; }
    if (node.type === 'google_search_result') return;
    if (node.type === 'text' && typeof node.text === 'string') texts.push(node.text);
    if (node.type === 'url_citation' && /^https:\/\//.test(node.url || '') && !sources.has(node.url)) sources.set(node.url, String(node.title || '').slice(0, 80));
    for (const value of Object.values(node)) walk(value);
  })(data);
  const text = texts.join('\n').replace(/\*\*/g, '').replace(/^#+\s*/gm, '').replace(/^\s*[*•]\s+/gm, '- ').replace(/\n{3,}/g, '\n\n').trim();
  return { text, sources: [...sources].slice(0, 5).map(([url, title]) => ({ url, title })), queries: queries.slice(0, 3) };
}

function problem(status, error) {
  const message = String(error?.message || '').slice(0, 200);
  let text;
  if (/API key not valid/i.test(message) || error?.status === 'UNAUTHENTICATED') text = 'Google did not accept that AI key. Check it in Settings.';
  else if (status === 429) text = 'Google says this key has reached its limit for now. Try again later.';
  else if (status === 403) text = `Google refused this request. The key may need billing switched on for web search. ${message}`;
  else text = message ? `Google’s AI could not answer: ${message}` : 'Google’s AI could not answer. Please try again.';
  return Object.assign(new Error(text.trim()), { status });
}

// Returns { text, sources: [{ url, title }], queries: [..] }.
export async function personFacts(who, meeting, key, signal) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ model: MODEL, input: question(who, meeting), tools: [{ type: 'google_search' }], store: false }),
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

// Puts the facts at the end of what you already wrote about the person, replacing an older set of facts.
export function mergeInto(existing, answer, dayText) {
  const at = existing.indexOf(MARK);
  const own = (at < 0 ? existing : existing.slice(0, at)).trim();
  const lines = [`${MARK} · ${dayText} —`, answer.text];
  if (answer.sources.length) lines.push('', 'Sources:', ...answer.sources.map(s => `- ${s.title ? `${s.title}: ` : ''}${s.url}`));
  return `${own ? `${own}\n\n` : ''}${lines.join('\n')}`;
}
