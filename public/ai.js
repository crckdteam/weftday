// AI that runs inside your own browser: Chrome's built-in model on a computer.
// Your notes are never sent anywhere. Where the browser has no built-in model (phones, other
// browsers), these features simply say so.

const SYSTEM = `You tidy a person's rough meeting notes. The notes are given as numbered lines.
Go through every line in order and turn it into one or more items. Each item has:
- "line": the number of the line it came from
- "kind": "action" (somebody still has to do something: send, ask, check, book, follow up, get approval, introduce, set up), "decision" (something agreed or settled), "question" (something unsure or left open), or "info" (anything else)
- "text": the point rewritten plainly and briefly. Actions start with a verb and keep any name or deadline from the notes.
A line can give two items, for example a decision and an action.
Rules: use only what is written. Never add facts, names, dates or tasks. Do not skip any line.
Also give "summary": one or two short sentences on what the meeting was about and where things stand.

Example notes:
1. anna ok w price but legal must check contract by fri
2. me to book demo
3. ask ravi abt onsite - not sure they want it
Example answer:
{"summary":"Anna accepted the price. The contract still needs a legal check.","items":[{"line":1,"kind":"decision","text":"Anna is fine with the price"},{"line":1,"kind":"action","text":"Get legal to check the contract by Friday"},{"line":2,"kind":"action","text":"Book the demo"},{"line":3,"kind":"action","text":"Ask Ravi whether they want it onsite"}]}`;

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    items: { type: 'array', items: {
      type: 'object',
      properties: { line: { type: 'integer' }, kind: { type: 'string', enum: ['action', 'decision', 'question', 'info'] }, text: { type: 'string' } },
      required: ['line', 'kind', 'text'], additionalProperties: false,
    } },
  },
  required: ['summary', 'items'], additionalProperties: false,
};
const LANG = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };

export const supported = () => 'LanguageModel' in self;

// 'ready' (can be used now), 'download' (works after a one-time download), or 'no'.
export async function status() {
  if (!supported()) return 'no';
  try {
    const a = await self.LanguageModel.availability(LANG);
    return a === 'available' ? 'ready' : a === 'unavailable' ? 'no' : 'download';
  } catch { return 'no'; }
}

// The model is loaded once and kept for as long as the page is open; each request works on a copy.
let base = null;
function model(onProgress) {
  base ||= self.LanguageModel.create({
    ...LANG, initialPrompts: [{ role: 'system', content: SYSTEM }],
    monitor(m) { m.addEventListener('downloadprogress', e => onProgress?.(e.loaded)); },
  }).catch(err => { base = null; throw err; });
  return base;
}

// Turns rough notes into { summary, decisions, actions, questions, info } (lists of short strings).
export async function tidy({ title, people, text }, { signal, onProgress } = {}) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const session = await (await model(onProgress)).clone({ signal });
  try {
    const ask = `Meeting: ${title || 'Meeting'}\nPeople: ${people || 'not listed'}\n\nNotes:\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}`;
    const answer = JSON.parse(await session.prompt(ask, { responseConstraint: SCHEMA, signal }));
    const out = { summary: String(answer.summary || '').trim(), decisions: [], actions: [], questions: [], info: [] };
    const list = { action: out.actions, decision: out.decisions, question: out.questions, info: out.info };
    const seen = new Set();
    for (const it of answer.items || []) {
      const point = String(it.text || '').replace(/\s+/g, ' ').trim();
      if (!point || !list[it.kind] || seen.has(point.toLowerCase())) continue;
      seen.add(point.toLowerCase());
      list[it.kind].push(point);
    }
    return out;
  } finally { session.destroy(); }
}

// A plain sentence for when something goes wrong.
export function explain(err) {
  if (err?.name === 'NotSupportedError' || err?.name === 'NotAllowedError') return 'The built-in AI is not available in this browser.';
  if (err?.name === 'QuotaExceededError') return 'These notes are too long for the built-in AI. Shorten them a little and try again.';
  if (err instanceof SyntaxError) return 'The AI gave an answer that could not be read. Please try again.';
  return 'The AI could not tidy these notes. Please try again.';
}

// ---- the tidy layout, shared by every device (also read back to make tasks)
export const ORIGINAL_MARK = '— Your notes —';
const SECTIONS = [['decisions', 'Decisions'], ['actions', 'Action points'], ['questions', 'Open questions'], ['info', 'Also noted']];

export function layout(r, original) {
  const parts = [];
  if (r.summary) parts.push(`Summary\n${r.summary}`);
  for (const [key, heading] of SECTIONS) if (r[key].length) parts.push(`${heading}\n${r[key].map(x => `- ${x}`).join('\n')}`);
  return `${parts.join('\n\n')}\n\n${ORIGINAL_MARK}\n${original.trim()}`;
}

// The notes as first written (the part under the mark, if they were tidied before).
export function originalOf(text) {
  const at = text.indexOf(ORIGINAL_MARK);
  return at < 0 ? text : text.slice(at + ORIGINAL_MARK.length).trim();
}

// The "Action points" list in a note, whether the AI wrote it or you did.
export function actionsIn(text) {
  const out = [];
  let inside = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^action (points|items)\s*:?$/i.test(line)) { inside = true; continue; }
    if (!inside) continue;
    const item = /^[-*•]\s*(?:\[[ x]?\]\s*)?(.+)$/i.exec(line);
    if (item) out.push(item[1].trim());
    else if (line) break; // the next heading ends the list
  }
  return out;
}
