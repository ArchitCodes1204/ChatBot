// Models Groq serves that are not usable for chat (speech, moderation, etc.)
const NON_CHAT_MODEL_PATTERNS = [/whisper/i, /tts/i, /orpheus/i, /guard/i];

// Preferred defaults, best first. The first one that the account can actually
// reach is used; otherwise we fall back to whatever chat model is available.
// compound-mini leads because it carries a far larger tokens-per-minute budget
// on the free tier (70k TPM vs 8k for the gpt-oss models), which is what keeps
// file-heavy chats from tripping the rate limiter.
const PREFERRED_MODELS = [
  'groq/compound-mini',
  'groq/compound',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
];

// Assumed tokens-per-minute budget before the API has told us the real one.
const DEFAULT_TPM = 8000;

// The compound models advertise a 70k TPM limit in their response headers, but
// they proxy to llama-3.3-70b-versatile and are actually governed by *that*
// model's much smaller limit. Trusting the header produces requests that are
// guaranteed to be rejected, so cap these at the real observed ceiling.
const ADVERTISED_LIMIT_CEILING = {
  'groq/compound-mini': 12000,
  'groq/compound': 12000,
};
// Ceiling on the reply so output tokens cannot eat the whole minute's budget.
export const MAX_OUTPUT_TOKENS = 1024;

// Learned from x-ratelimit-* response headers, keyed by model id.
const observedLimits = new Map();

export function getModelLimits(model) {
  return observedLimits.get(model) || null;
}

// Groq bills roughly 4 characters per token; deliberately pessimistic so the
// estimate errs on the side of sending less.
export function estimateTokens(text) {
  return Math.ceil((text || '').length / 3.6);
}

// How many input tokens we can afford to send for this model in one request.
export function inputTokenBudget(model) {
  const limit = observedLimits.get(model)?.limitTokens || DEFAULT_TPM;
  // Leave room for the reply plus headroom for a second message in the same
  // minute, so back-to-back turns do not trip the per-minute limit.
  return Math.max(1000, Math.floor(limit * 0.35) - MAX_OUTPUT_TOKENS);
}

function truncateToTokens(text, maxTokens) {
  const maxChars = Math.floor(maxTokens * 3.6);
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: text.slice(0, maxChars) + '\n\n[...truncated to stay within the model rate limit...]',
    truncated: true,
  };
}

/**
 * Fit a system prompt plus chat history into the model's per-request budget:
 * trim the (usually huge) file context first, then drop the oldest turns.
 * Returns the messages to send and what had to be cut.
 */
export function fitToBudget({ systemPrompt = '', history = [], model }) {
  const budget = inputTokenBudget(model);
  const notes = [];

  let system = systemPrompt;
  if (system) {
    // Give the file context at most half the budget.
    const result = truncateToTokens(system, Math.floor(budget * 0.5));
    system = result.text;
    if (result.truncated) notes.push('file content was shortened');
  }

  let remaining = budget - estimateTokens(system);
  const kept = [];
  // Walk newest first so recent turns survive.
  for (let i = history.length - 1; i >= 0; i--) {
    const cost = estimateTokens(history[i].content) + 4;
    if (cost > remaining && kept.length > 0) {
      notes.push('older messages were dropped');
      break;
    }
    remaining -= cost;
    kept.unshift(history[i]);
  }

  // The newest user turn alone can exceed the budget; clip it rather than
  // sending a request that is guaranteed to be rejected.
  if (kept.length === 1 && estimateTokens(kept[0].content) > budget) {
    const result = truncateToTokens(kept[0].content, budget - estimateTokens(system));
    kept[0] = { ...kept[0], content: result.text };
    if (result.truncated) notes.push('your message was shortened');
  }

  const messages = system ? [{ role: 'system', content: system }, ...kept] : kept;
  return { messages, notes };
}

function recordLimits(model, headers) {
  // A limit parsed from a rate-limit error is ground truth; never let the
  // (possibly inflated) advertised header overwrite it.
  if (observedLimits.get(model)?.authoritative) return;

  const num = (name) => {
    const raw = headers.get(name);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const limitTokens = num('x-ratelimit-limit-tokens');
  if (limitTokens) {
    const ceiling = ADVERTISED_LIMIT_CEILING[model];
    observedLimits.set(model, {
      limitTokens: ceiling ? Math.min(limitTokens, ceiling) : limitTokens,
      remainingTokens: num('x-ratelimit-remaining-tokens'),
    });
  }
}

// Rate-limit errors state the real ceiling ("...(TPM): Limit 12000, Used..."),
// which for proxied models is the only place the true number appears.
function recordLimitFromError(model, message) {
  const match = /\(TPM\):\s*Limit\s+(\d+)/i.exec(message || '');
  if (!match) return;
  observedLimits.set(model, {
    limitTokens: Number(match[1]),
    remainingTokens: null,
    authoritative: true,
  });
}

// Groq reports the wait as a `retry-after` header and inside the error text
// ("Please try again in 6.0675s"). Prefer the header, fall back to the message.
function retryDelaySeconds(headers, message) {
  const header = Number(headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return header;
  const match = /try again in ([\d.]+)\s*s/i.exec(message || '');
  if (match) return Number(match[1]);
  return null;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Ask the API for a model's rate limits with a throwaway 1-token request, so
 * the very first real message is budgeted against the true limit rather than
 * the pessimistic default. Cheap, and failure is harmless.
 */
export async function probeModelLimits(model, apiKey) {
  if (!apiKey || observedLimits.has(model)) return getModelLimits(model);
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 })
    });
    recordLimits(model, response.headers);
  } catch {
    // keep the conservative default budget
  }
  return getModelLimits(model);
}

export const FALLBACK_MODEL = PREFERRED_MODELS[0];

function isChatModel(id) {
  return !NON_CHAT_MODEL_PATTERNS.some(re => re.test(id));
}

export function pickDefaultModel(models) {
  const ids = models.map(m => m.id);
  return PREFERRED_MODELS.find(id => ids.includes(id)) || ids[0] || FALLBACK_MODEL;
}

export async function fetchModels(apiKey) {
  const fallbackModels = PREFERRED_MODELS.map(id => ({ name: id, id }));

  if (!apiKey) return fallbackModels;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (!response.ok) throw new Error('Bad response');
    const data = await response.json();
    const models = data.data
      .filter(m => m.active !== false && isChatModel(m.id))
      .map(m => ({ name: m.name || m.id, id: m.id }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return models.length > 0 ? models : fallbackModels;
  } catch (e) {
    console.error('Failed to fetch models', e);
    return fallbackModels; // fallback if fetching fails
  }
}

class RateLimitError extends Error {
  constructor(message, seconds) {
    super(message);
    this.name = 'RateLimitError';
    this.isRateLimit = true;
    this.seconds = seconds;
  }
}

const RATE_LIMIT_ADVICE =
  'Rate limit still reached after several retries. Remove a large attachment, ' +
  'start a new chat to drop older messages, or wait a minute before retrying.';

function extractErrorMessage(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message || text;
  } catch {
    return text;
  }
}

export async function* streamChat(messages, model = FALLBACK_MODEL, apiKey, options = {}) {
  if (!apiKey) {
    throw new Error('API Key configuration is missing. Please add your Groq API key in the sidebar.');
  }

  const { onRetry, maxRetries = 3, signal } = options;

  for (let attempt = 0; ; attempt++) {
    let yieldedAny = false;
    try {
      // Delegate a single attempt so an in-stream failure before any output
      // can be retried the same way an HTTP-level failure is.
      for await (const chunk of attemptStream(messages, model, apiKey, signal)) {
        yieldedAny = true;
        yield chunk;
      }
      return;
    } catch (err) {
      if (err?.isRateLimit) {
        recordLimitFromError(model, err.message);
        // Retrying after partial output would duplicate text, so only retry a
        // request that has produced nothing yet.
        if (!yieldedAny && attempt < maxRetries) {
          const seconds = Math.min(Math.ceil((err.seconds ?? 2 ** attempt) + 0.5), 30);
          onRetry?.({ attempt: attempt + 1, maxRetries, seconds });
          await sleep(seconds * 1000);
          continue;
        }
        throw new Error(RATE_LIMIT_ADVICE);
      }
      throw err;
    }
  }
}

/** One request/response cycle. Throws RateLimitError on any 429, however it arrives. */
async function* attemptStream(messages, model, apiKey, signal) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      max_tokens: MAX_OUTPUT_TOKENS
    }),
    signal
  });

  recordLimits(model, response.headers);

  if (!response.ok) {
    const errMsg = extractErrorMessage(await response.text());
    if (response.status === 429) {
      throw new RateLimitError(errMsg, retryDelaySeconds(response.headers, errMsg));
    }
    throw new Error('Groq API Error: ' + errMsg);
  }

  if (!response.body) {
    throw new Error('Groq API Error: streaming is not supported in this browser.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  // A network chunk can end mid-line, so hold the tail until the next read
  // completes it. Without this, tokens get dropped from the reply.
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;

      const payload = trimmed.slice(6);
      if (payload === '[DONE]') return;

      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue; // ignore malformed keep-alive or partial frames
      }

      // The compound models report failures as an error frame inside an
      // otherwise-successful 200 stream. Left unhandled this yields a silently
      // blank reply, so treat it as the terminal error it is.
      if (parsed.error) {
        const message = parsed.error.message || 'Unknown streaming error';
        if (parsed.error.code === 'rate_limit_exceeded' || parsed.error.status_code === 429) {
          throw new RateLimitError(message, retryDelaySeconds(response.headers, message));
        }
        throw new Error('Groq API Error: ' + message);
      }

      const content = parsed.choices?.[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  }
}
