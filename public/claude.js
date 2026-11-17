// "Get facts" with Claude: the better-results choice, for people who bring their own Anthropic key.
// It uses the official Anthropic SDK (vendor/anthropic-sdk.js), loaded only when it is needed, and
// Claude's own web search. Your browser talks to Anthropic directly; the person's name, their company
// and the meeting's title are what is sent, and only when you press the button.
import { searchQuestion, tidyText } from './facts.js';

const MODEL = 'claude-opus-5-5';
let Anthropic = null;

// Returns { text, sources: [{ url, title }], queries: [], how: 'search' }, the same shape as facts.js.
export async function personFacts(who, meeting, key, signal, hint = '') {
  Anthropic ||= (await import('./vendor/anthropic-sdk.js')).default;
  // The key belongs to the person using the app and stays in their own browser, which is the case
  // the SDK's browser switch exists for.
  const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 120000 });
  const messages = [{ role: 'user', content: searchQuestion(who, meeting, hint) }];
  try {
    for (let turn = 0; turn < 5; turn++) {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        // If the model declines a request, Anthropic re-runs it on a fallback model inside the same call.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
        messages,
      }, { signal });

      if (response.stop_reason === 'pause_turn') { // a long search paused: hand the turn back so it continues
        messages.push({ role: 'assistant', content: response.content });
        continue;
      }
      if (response.stop_reason === 'refusal') throw new Error('Claude declined to look this person up.');

      const parts = [], sources = new Map();
      for (const block of response.content) {
        if (block.type !== 'text') continue;
        parts.push(block.text);
        for (const cite of block.citations || []) if (cite.url && !sources.has(cite.url)) sources.set(cite.url, String(cite.title || '').slice(0, 80));
      }
      const text = tidyText(parts.join(''));
      if (!text) throw new Error('Claude gave no answer. Please try again.');
      return { text, sources: [...sources].slice(0, 5).map(([url, title]) => ({ url, title })), queries: [], how: 'search' };
    }
    throw new Error('Claude did not finish in time. Please try again.');
  } catch (err) {
    if (signal?.aborted || err instanceof Anthropic.APIUserAbortError) throw new DOMException('Stopped', 'AbortError');
    if (err instanceof Anthropic.AuthenticationError) throw new Error('Anthropic did not accept that Claude key. Check it in Settings.');
    if (err instanceof Anthropic.PermissionDeniedError) throw new Error('This Claude key is not allowed to do that. Check the key in the Anthropic Console.');
    if (err instanceof Anthropic.RateLimitError) throw new Error('This Claude key has reached its limit for now. Try again in a minute.');
    if (err instanceof Anthropic.APIConnectionError) throw new Error('Could not reach Claude. Check your connection and try again.');
    if (err instanceof Anthropic.APIError) {
      const said = String(err.error?.error?.message || err.message || '').slice(0, 200);
      throw new Error(/credit|billing/i.test(said) ? 'This Claude key has no credit. Add credit in the Anthropic Console, then try again.' : `Claude could not answer: ${said}`);
    }
    throw err;
  }
}
