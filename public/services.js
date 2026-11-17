// The outside services "Get facts" can use, each with a key of your own: an AI that writes the brief
// and a search service that finds the pages. Your browser talks to them directly.
//
// Every service here was checked to accept calls from a web page (no server in between).

const link = (url, text) => `<a href="${url}" target="_blank" rel="noopener">${text}</a>`;
const keySteps = (url, site, extra = '') => `<li>Open ${link(url, site)} and create an API key.</li>${extra}
  <li>Copy the key, paste it above and press Save. It is kept only in this browser.</li>`;

// setup: roughly how long it takes to get the key (or, for Ollama, to install it), shown in Settings.
// recommended: the easiest good choice, marked in Settings (one free, one paid, one search service).
// kind: 'google' (Gemini), 'claude' (Anthropic) or 'chat' (the common chat format most AI services
// share). model is the first one tried; if the service no longer has it, one is picked from the
// service's own list, in the order of "prefer". A service with "responses" can search the web by
// itself: that is the address asked, with the models in searchModels, the first that works.
// Prices and model names were checked on each service's own pages in November 2026.
export const AI_SERVICES = {
  google: {
    name: 'Google AI', cost: 'free', setup: 'about 1 minute', recommended: true, kind: 'google', label: 'Google AI key',
    help: `<li>Open ${link('https://aistudio.google.com/apikey', 'Google AI Studio')} and press <b>Create API key</b>.</li>
      <li>Copy the key, paste it above and press Save. It is kept only in this browser. The key is free.</li>
      <li>On its own this key reads the company’s website. Add a free search key below to also find facts about the person.</li>`,
  },
  groq: {
    name: 'Groq', cost: 'free', setup: 'about 2 minutes', kind: 'chat', label: 'Groq key', base: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-120b', prefer: [/gpt-oss-120b/, /gpt-oss-20b/, /gpt-oss/, /qwen/, /llama/],
    help: keySteps('https://console.groq.com/keys', 'the Groq Console', '<li>Groq has a free plan with daily limits. It runs open models very fast.</li>'),
  },
  openrouter: {
    name: 'OpenRouter', cost: 'free', setup: 'about 2 minutes', kind: 'chat', label: 'OpenRouter key', base: 'https://openrouter.ai/api/v1',
    model: 'openrouter/free', prefer: [/^openrouter\/free$/, /:free$/],
    help: keySteps('https://openrouter.ai/keys', 'OpenRouter', '<li>Weftday uses its free models: about 50 lookups a day. To use a paid model, type its name under “Choose a model”.</li>'),
  },
  ollama: {
    name: 'Ollama', cost: 'free, runs on your computer', setup: 'about 15 minutes', kind: 'chat', local: true, noKey: true, base: 'http://localhost:11434/v1',
    model: '', prefer: [/^gpt-oss/, /^qwen/, /^llama/, /^gemma/, /^mistral/],
    help: `<li>Install ${link('https://ollama.com/download', 'Ollama')} on this computer and open it.</li>
      <li>Open the Terminal app and run <code>ollama pull gpt-oss:20b</code> to download a model. It is large (about 14 GB); <code>ollama pull qwen3:8b</code> is a smaller one.</li>
      <li>Allow Weftday to talk to it: run <code>launchctl setenv OLLAMA_ORIGINS "${typeof location === 'undefined' ? '' : location.origin}"</code> in Terminal, then quit Ollama and open it again. This has to be done again after the computer restarts.</li>
      <li>The first time, Chrome asks if Weftday may reach apps on this device. Choose Allow.</li>
      <li>It works on the computer Ollama is installed on, in Chrome, not on a phone. No key is needed, and nothing leaves your computer except the web search.</li>`,
  },
  mistral: {
    name: 'Mistral', cost: 'free to try', setup: 'about 3 minutes', kind: 'chat', label: 'Mistral key', base: 'https://api.mistral.ai/v1',
    model: 'mistral-small-latest', prefer: [/^mistral-small-latest$/, /^mistral-medium-latest$/, /^mistral-small/, /^mistral/],
    help: keySteps('https://console.mistral.ai/api-keys', 'the Mistral Console', '<li>New accounts start in a free mode with limits. Heavier use is paid.</li>'),
  },
  openai: {
    name: 'OpenAI', cost: 'paid', setup: 'about 5 minutes', kind: 'chat', ownSearch: true, label: 'OpenAI key', base: 'https://api.openai.com/v1',
    model: 'gpt-6-luna', prefer: [/^gpt-6-luna$/, /^gpt-5-nano$/, /^gpt-\d[\w.-]*(luna|nano|mini)$/, /^gpt-\d/],
    responses: 'https://api.openai.com/v1/responses', searchModels: ['gpt-6-luna', 'gpt-6-astra'],
    help: keySteps('https://platform.openai.com/api-keys', 'the OpenAI Platform', '<li>OpenAI keys are paid: add a little credit under Billing. Each lookup costs a few cents, because it searches the web by itself.</li>'),
  },
  claude: {
    name: 'Claude', cost: 'paid', setup: 'about 5 minutes', recommended: true, kind: 'claude', ownSearch: true, label: 'Claude (Anthropic) key',
    help: `<li>Open the ${link('https://platform.claude.com/settings/keys', 'Anthropic Console')} and create an API key.</li>
      <li>Claude keys are paid: add a little credit in the Console. Each lookup uses a small amount of it.</li>
      <li>Copy the key, paste it above and press Save. It is kept only in this browser.</li>`,
  },
  perplexity: {
    name: 'Perplexity', cost: 'paid', setup: 'about 5 minutes', kind: 'chat', ownSearch: true, label: 'Perplexity key',
    responses: 'https://api.perplexity.ai/v1/agent', searchModels: ['perplexity/sonar'],
    help: keySteps('https://console.perplexity.ai', 'the Perplexity console', '<li>Perplexity keys are paid: add a little credit there. Each lookup uses a small amount of it.</li>'),
  },
  xai: {
    name: 'xAI Grok', cost: 'paid', setup: 'about 5 minutes', kind: 'chat', ownSearch: true, label: 'xAI key', base: 'https://api.x.ai/v1',
    model: 'grok-4.3', prefer: [/^grok-4\.3/, /^grok-\d/],
    responses: 'https://api.x.ai/v1/responses', searchModels: ['grok-4.3', 'grok-4.7'],
    help: keySteps('https://console.x.ai', 'the xAI Console', '<li>xAI keys are paid: add a little credit there. Each lookup uses a small amount of it.</li>'),
  },
  deepseek: {
    name: 'DeepSeek', cost: 'paid', setup: 'about 5 minutes', kind: 'chat', label: 'DeepSeek key', base: 'https://api.deepseek.com',
    model: 'deepseek-flash', prefer: [/^deepseek-flash$/, /flash/, /^deepseek/],
    help: keySteps('https://platform.deepseek.com/api_keys', 'the DeepSeek Platform', '<li>DeepSeek keys are paid, and among the cheapest: add a little credit there.</li>'),
  },
};
for (const [id, svc] of Object.entries(AI_SERVICES)) svc.id = id;
export const aiService = id => AI_SERVICES[id] || AI_SERVICES.google;

// Search services. request() gives what to send; read() picks the results out of the reply.
const json = (url, headers, body) => [url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }];
export const SEARCH_SERVICES = {
  tavily: {
    name: 'Tavily', cost: 'free', setup: 'about 2 minutes', recommended: true,
    request: (q, key) => json('https://api.tavily.com/search', { authorization: `Bearer ${key}` }, { query: q, search_depth: 'basic', max_results: 5, include_answer: false }),
    read: d => (d?.results || []).map(r => ({ title: r.title, url: r.url, content: r.content })),
    help: `<li>Open ${link('https://app.tavily.com', 'Tavily')}, a search service made for AI tools, and sign up. It is free and asks for no card.</li>
      <li>Copy your API key, paste it above and press Save. It gives 1,000 searches a month; one lookup uses five. It also finds a photo of the person.</li>`,
  },
  firecrawl: {
    name: 'Firecrawl', cost: 'free', setup: 'about 2 minutes',
    request: (q, key) => json('https://api.firecrawl.dev/v2/search', { authorization: `Bearer ${key}` }, { query: q, limit: 5 }),
    read: d => (Array.isArray(d?.data) ? d.data : d?.data?.web || []).map(r => ({ title: r.title, url: r.url, content: r.description || r.markdown })),
    help: `<li>Open ${link('https://www.firecrawl.dev', 'Firecrawl')} and sign up. It is free and asks for no card.</li>
      <li>Copy your API key, paste it above and press Save. The free plan refills every month and covers about 125 lookups.</li>`,
  },
  linkup: {
    name: 'Linkup', cost: 'free with a work email', setup: 'about 2 minutes',
    request: (q, key) => json('https://api.linkup.so/v1/search', { authorization: `Bearer ${key}` }, { q, depth: 'standard', outputType: 'searchResults' }),
    read: d => (d?.results || []).filter(r => r?.type !== 'image').map(r => ({ title: r.name, url: r.url, content: r.content })),
    help: `<li>Open ${link('https://app.linkup.so', 'Linkup')} and sign up with a work email address.</li>
      <li>Copy your API key, paste it above and press Save. The free credit refills every month and covers about 1,000 lookups.</li>`,
  },
  serper: {
    name: 'Serper', cost: 'free to start', setup: 'about 2 minutes',
    request: (q, key) => json('https://google.serper.dev/search', { 'x-api-key': key }, { q, num: 5 }),
    read: d => (d?.organic || []).map(r => ({ title: r.title, url: r.link, content: r.snippet })),
    help: `<li>Open ${link('https://serper.dev', 'Serper')}, which gives Google’s search results, and sign up. No card is needed.</li>
      <li>Copy your API key, paste it above and press Save. New accounts get 2,500 free searches (about 600 lookups), once; after that it is paid.</li>`,
  },
  jina: {
    name: 'Jina', cost: 'free to start', setup: 'about 1 minute',
    request: (q, key) => [`https://s.jina.ai/?q=${encodeURIComponent(q)}`, { headers: { authorization: `Bearer ${key}`, accept: 'application/json', 'x-respond-with': 'no-content' } }],
    read: d => (d?.data || []).map(r => ({ title: r.title, url: r.url, content: r.description || r.content })),
    help: `<li>Open ${link('https://jina.ai/api-dashboard', 'Jina')} and copy the API key it shows. No card is needed.</li>
      <li>Paste it above and press Save. A new key comes with free credit for about 250 lookups, once; after that it is paid.</li>`,
  },
};
for (const [id, svc] of Object.entries(SEARCH_SERVICES)) svc.id = id;
export const searchService = id => SEARCH_SERVICES[id] || SEARCH_SERVICES.tavily;

// One web search. Returns [{ title, url, content }].
export async function webSearch(kind, query, key, signal) {
  const svc = searchService(kind);
  const [url, init] = svc.request(query, key);
  let res, data;
  try {
    res = await fetch(url, { ...init, signal });
    data = await res.json().catch(() => null);
  } catch (err) {
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    throw new Error(`Could not reach ${svc.name}. Check the search key in Settings and your connection.`);
  }
  if (res.status === 401 || res.status === 403) throw new Error(`${svc.name} did not accept that search key. Check it in Settings.`);
  if ([402, 429, 432, 433].includes(res.status)) throw new Error(`The ${svc.name} search key has used up its searches for now.`);
  if (!res.ok) throw new Error(`${svc.name} could not answer. Please try again.`);
  return svc.read(data).filter(r => r && r.url).slice(0, 5)
    .map(r => ({ title: String(r.title || ''), url: String(r.url), content: String(r.content || '').replace(/\s+/g, ' ').slice(0, 700) }));
}

// Pictures the search finds for a name. Only Tavily offers this. Returns [{ url, title, description }].
export async function photoSearch(query, key, signal) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, search_depth: 'basic', max_results: 5, include_answer: false, include_images: true, include_image_descriptions: true }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) return [];
  return (data?.images || []).map(i => (typeof i === 'string' ? { url: i } : { url: String(i?.url || ''), title: String(i?.title || ''), description: String(i?.description || '') }));
}

// ---- AI services that share the common chat format
const NOT_FOR_CHAT = /embed|whisper|tts|audio|image|moderation|guard|rerank|dall-e|sora|realtime|transcri|speech|search-preview|ocr/i;
const working = new Map(); // the model that last answered for each service, while the page is open

function chatProblem(svc, status, data, model) {
  const said = String(data?.error?.message || (typeof data?.error === 'string' ? data.error : '') || data?.message || '').slice(0, 200);
  let text, kind = '';
  if (status === 401 || status === 403 || /(incorrect|invalid|wrong) api key|unauthori/i.test(said)) text = `${svc.name} did not accept that key. Check it in Settings.`;
  else if (status === 402 || /insufficient|credit|balance|billing|payment/i.test(said)) { kind = 'credit'; text = `${svc.name} says this key has no credit left.`; }
  else if (status === 404 || (status === 400 && /model/i.test(said))) { kind = 'model'; text = `${svc.name} does not have the model “${model}”. Choose another in Settings → AI.`; }
  else if (status === 429) { kind = 'busy'; text = `${svc.name} says this key has reached its limit for now. Try again in a minute.`; }
  else if (status >= 500) { kind = 'busy'; text = `${svc.name} is very busy right now. Please try again in a minute.`; }
  else text = said ? `${svc.name} could not answer: ${said}` : `${svc.name} could not answer. Please try again.`;
  return Object.assign(new Error(text), { status, kind });
}
const unreachable = svc => new Error(svc.local
  ? 'Could not reach Ollama on this computer. Check that it is open and allowed to talk to Weftday (Settings → AI shows how).'
  : `Could not reach ${svc.name}. Check your connection and try again.`);
const auth = key => (key ? { authorization: `Bearer ${key}` } : {});

// The models a service offers that can hold a conversation.
export async function listModels(svc, key, signal) {
  let res, data;
  try {
    res = await fetch(`${svc.base}/models`, { signal, headers: auth(key) });
    data = await res.json().catch(() => null);
  } catch (err) {
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    throw unreachable(svc);
  }
  if (!res.ok) throw chatProblem(svc, res.status, data, '');
  return (data?.data || []).map(m => String(m?.id || '')).filter(id => id && !NOT_FOR_CHAT.test(id));
}
async function pickModel(svc, key, signal, not = '') {
  const ids = svc.noList ? [] : (await listModels(svc, key, signal)).filter(id => id !== not);
  for (const want of svc.prefer || []) { const hit = ids.find(id => want.test(id)); if (hit) return hit; }
  if (ids.length) return ids[0];
  throw new Error(svc.local ? 'Ollama has no model yet. In the Terminal app, run: ollama pull llama3.2' : `${svc.name} has no model this key can use.`);
}

async function chatOnce(svc, key, model, input, signal) {
  const stop = new AbortController(), giveUp = () => stop.abort();
  signal?.addEventListener('abort', giveUp);
  const timer = setTimeout(giveUp, svc.local ? 180000 : 60000); // a model on your own computer may be slow
  let res, data;
  try {
    res = await fetch(`${svc.base}/chat/completions`, {
      method: 'POST', signal: stop.signal,
      headers: { 'content-type': 'application/json', ...auth(key) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: input }], stream: false }),
    });
    data = await res.json().catch(() => null);
  } catch (err) {
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    if (stop.signal.aborted) throw Object.assign(new Error(`${svc.name} took too long. Please try again.`), { kind: 'slow' });
    throw unreachable(svc);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', giveUp);
  }
  if (!res.ok || data?.error) throw chatProblem(svc, res.status, data, model);
  const said = data?.choices?.[0]?.message?.content;
  const text = (Array.isArray(said) ? said.map(p => p?.text || '').join('') : String(said || ''))
    .replace(/<think>[\s\S]*?<\/think>/gi, '').trim(); // some models show their thinking first
  if (!text) throw new Error(`${svc.name} gave no answer. Please try again.`);
  const pages = [...(data.search_results || []), ...(data.citations || []).map(url => ({ url }))]; // services that search by themselves
  const sources = [...new Map(pages.filter(p => /^https:\/\//.test(p?.url || '')).map(p => [p.url, String(p.title || '').slice(0, 80)]))]
    .slice(0, 5).map(([url, title]) => ({ url, title }));
  return { text, sources, queries: [], model };
}

// Asks a chat service. wanted is the model you chose in Settings; without one, the usual model is
// tried and, if the service no longer has it, one from its own list.
export async function chat(svc, key, wanted, input, signal) {
  let model = wanted || working.get(svc.id) || svc.model || await pickModel(svc, key, signal);
  try {
    const answer = await chatOnce(svc, key, model, input, signal);
    working.set(svc.id, model);
    return answer;
  } catch (err) {
    if (err.kind !== 'model' || wanted) throw err;
    working.delete(svc.id);
    model = await pickModel(svc, key, signal, model);
    const answer = await chatOnce(svc, key, model, input, signal);
    working.set(svc.id, model);
    return answer;
  }
}

// ---- AI services that search the web by themselves (OpenAI, Perplexity, xAI share one format)
// Citation marks the services weave into the text are taken out, so the labels can be read back.
const plain = text => text
  .replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, '')                                   // ([site](address))
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, label, url) => (/\s/.test(label) ? label : url)) // [label](address)
  .replace(/\s*(\[(web:)?\d+\]|【[^】]*】)/g, '');

async function searchOnce(svc, key, model, input, signal) {
  const stop = new AbortController(), giveUp = () => stop.abort();
  signal?.addEventListener('abort', giveUp);
  const timer = setTimeout(giveUp, 90000); // searching and reading pages takes a while
  let res, data;
  try {
    res = await fetch(svc.responses, {
      method: 'POST', signal: stop.signal,
      headers: { 'content-type': 'application/json', ...auth(key) },
      body: JSON.stringify({ model, input, tools: [{ type: 'web_search' }] }),
    });
    data = await res.json().catch(() => null);
  } catch (err) {
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    if (stop.signal.aborted) throw Object.assign(new Error(`${svc.name} took too long. Please try again.`), { kind: 'slow' });
    throw unreachable(svc);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', giveUp);
  }
  if (!res.ok || data?.error) {
    const problem = chatProblem(svc, res.status, data, model);
    if (res.status === 400 && /web_search|tool/i.test(problem.message)) problem.kind = 'nosearch'; // this model cannot search
    throw problem;
  }
  const texts = [], sources = new Map();
  const add = (url, title) => { if (/^https:\/\//.test(url || '') && !sources.has(url)) sources.set(url, String(title || '').slice(0, 80)); };
  for (const item of data?.output || []) {
    if (item?.type === 'search_results') for (const r of item.results || []) add(r?.url, r?.title);
    if (item?.type !== 'message') continue;
    for (const part of item.content || []) {
      if (part?.type === 'output_text' && part.text) texts.push(part.text);
      for (const note of part?.annotations || []) if (note?.type === 'url_citation') add(note.url, note.title);
    }
  }
  const text = plain(texts.join('\n')).trim();
  if (!text) throw new Error(`${svc.name} gave no answer. Please try again.`);
  return { text, sources: [...sources].slice(0, 5).map(([url, title]) => ({ url, title })), queries: [], model };
}

// Asks a service that searches the web by itself. If its usual model cannot search, the next is tried.
export async function searchChat(svc, key, wanted, input, signal) {
  let last;
  for (const model of wanted ? [wanted] : svc.searchModels) {
    try { return await searchOnce(svc, key, model, input, signal); }
    catch (err) { last = err; if (!['model', 'nosearch'].includes(err.kind)) throw err; }
  }
  throw last;
}
