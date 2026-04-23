/* ── suggestionEngine.js ───────────────────────────────────────────────────
   Owns suggestion generation, JSON parsing/repair, deduplication, and the
   rolling summary + retry queue. No direct DOM manipulation — it fires
   callbacks instead, keeping the rendering concern in ui.js.
───────────────────────────────────────────────────────────────────────────── */

import {
  SUGGESTIONS_MODEL, CHAT_MODEL,
  SUGGESTION_MAX_TOKENS, SUGGESTION_REPAIR_MAX_TOKENS,
  SUMMARY_MAX_TOKENS, SUMMARY_EVERY_N_CHUNKS,
  SUMMARY_MAX_RETRIES, SUMMARY_RETRY_DELAY_MS,
  SUGGESTION_DEDUPE_LIMIT, MIN_NEW_WORDS_FOR_SUGGESTION, SUGGESTION_COOLDOWN_MS,
} from './config.js';
import { session, settings, isActiveSession } from './state.js';
import { chatCompletion, logTokenEstimate } from './groqApi.js';
import { buildSuggestionContext, buildSuggestionSystemPrompt } from './promptManager.js';

// ── Public entry points ───────────────────────────────────────────────────

/**
 * Decide whether to auto-trigger suggestions after a new transcript chunk.
 * Returns {shouldGenerate: bool, reason: string}.
 */
export function shouldAutoGenerate(chunkText, chunkWordCount) {
  if (chunkWordCount < 10) {
    return { shouldGenerate: false, reason: 'chunk too short (<10 words)' };
  }
  const msSinceLast = Date.now() - session.lastSuggestionCompletedAt;
  if (session.lastSuggestionCompletedAt > 0 && msSinceLast < SUGGESTION_COOLDOWN_MS) {
    return { shouldGenerate: false, reason: `cooldown — ${Math.ceil((SUGGESTION_COOLDOWN_MS - msSinceLast) / 1000)}s remaining` };
  }
  const newWords = session.wordTotal - session.wordCountAtLastSuggestion;
  if (newWords < MIN_NEW_WORDS_FOR_SUGGESTION) {
    return { shouldGenerate: false, reason: `debounced — ${newWords} new words (need ${MIN_NEW_WORDS_FOR_SUGGESTION})` };
  }
  return { shouldGenerate: true, reason: `${newWords} new words since last run` };
}

/**
 * Generate exactly 3 suggestions from the current transcript context.
 * Calls onResult(suggestions[]) on success, onError(message) on failure.
 * Updates session rate-limit state before/after the API call.
 *
 * @param {number}   sessionId
 * @param {string[]} existingPreviews  — currently visible card previews for deduplication
 * @param {(s: object[]) => void} onResult
 * @param {(msg: string, isRateLimit: bool) => void} onError
 */
export async function generateSuggestions(sessionId, existingPreviews, onResult, onError) {
  if (session.suggestionInFlight) return;
  session.suggestionInFlight        = true;
  session.wordCountAtLastSuggestion = session.wordTotal;

  const context = buildSuggestionContext(session, settings);
  if (!context) {
    session.suggestionInFlight = false;
    return;
  }

  const dupesText   = existingPreviews.length ? existingPreviews.map(p => `- ${p}`).join('\n') : 'None';
  const basePrompt  = settings.livePromptTemplate.replace('{{DUPES}}', dupesText);
  const sysPrompt   = buildSuggestionSystemPrompt(basePrompt, context);
  const messages    = [
    { role: 'system', content: sysPrompt },
    { role: 'user',   content: `Recent transcript:\n${context}` },
  ];
  logTokenEstimate('suggestions', messages, SUGGESTION_MAX_TOKENS);

  try {
    const raw    = await chatCompletion({ model: SUGGESTIONS_MODEL, messages, maxTokens: SUGGESTION_MAX_TOKENS, temperature: 0, apiKey: settings.apiKey });
    if (!isActiveSession(sessionId)) return;

    let parsed = parseSuggestions(raw);

    // One repair pass if JSON was malformed
    if (!parsed) {
      console.warn('[Suggestions] Malformed JSON — attempting repair');
      const repairMsgs = [
        { role: 'system', content: 'Rewrite as strict JSON only, no prose, no markdown. Shape: {"suggestions":[{"type":"...","preview":"...","detail":"..."},{"type":"...","preview":"...","detail":"..."},{"type":"...","preview":"...","detail":"..."}]}' },
        { role: 'user',   content: raw },
      ];
      logTokenEstimate('suggestions-repair', repairMsgs, SUGGESTION_REPAIR_MAX_TOKENS);
      const repaired = await chatCompletion({ model: SUGGESTIONS_MODEL, messages: repairMsgs, maxTokens: SUGGESTION_REPAIR_MAX_TOKENS, temperature: 0, apiKey: settings.apiKey });
      if (!isActiveSession(sessionId)) return;
      parsed = parseSuggestions(repaired);
    }

    const modelItems = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
    const batch = assembleBatch(modelItems, existingPreviews, context);

    if (batch.length >= 1) {
      session.suggestionHistory.push({ timestamp: new Date().toISOString(), suggestions: batch });
      onResult(batch);
    }
  } catch (err) {
    const msg = err.message || '';
    const isRate = msg.includes('429') || /rate.?limit/i.test(msg);
    if (isRate) {
      const retryMatch = msg.match(/try again in (\d+(?:\.\d+)?)s/i);
      const retrySec   = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : 60;
      // Push the cooldown clock forward so auto-trigger skips correctly
      session.lastSuggestionCompletedAt = Date.now() + retrySec * 1000 - SUGGESTION_COOLDOWN_MS;
      console.warn(`[Suggestions] 429 — backing off ${retrySec}s`);
    }
    onError(msg, isRate);
  } finally {
    session.suggestionInFlight        = false;
    session.lastSuggestionCompletedAt = Math.max(session.lastSuggestionCompletedAt, Date.now());
  }
}

// ── Rolling summary + retry queue ─────────────────────────────────────────

/**
 * Schedule a rolling summary for the batch of chunks that just crossed the
 * N-chunk threshold. Delayed 3 s to avoid colliding with a simultaneous
 * suggestion call on the same chunk.
 */
export function scheduleSummaryIfDue(sessionId) {
  if (session.allChunks.length % SUMMARY_EVERY_N_CHUNKS !== 0) return;
  const batchStart = session.allChunks.length - SUMMARY_EVERY_N_CHUNKS;
  const batchText  = session.allChunks.slice(batchStart).map(c => c.text).join('\n\n');
  setTimeout(() => enqueueSummary(sessionId, batchStart, batchText, 0), 3_000);
}

async function enqueueSummary(sessionId, batchStart, batchText, attempt) {
  if (!isActiveSession(sessionId) || !settings.apiKey) return;

  const messages = [
    { role: 'system', content: 'Summarize this meeting segment in 2 short sentences: decisions, actions, risks.' },
    { role: 'user',   content: batchText },
  ];
  logTokenEstimate('rolling-summary', messages, SUMMARY_MAX_TOKENS);

  try {
    const summary = await chatCompletion({ model: CHAT_MODEL, messages, maxTokens: SUMMARY_MAX_TOKENS, temperature: 0.1, apiKey: settings.apiKey });
    if (!isActiveSession(sessionId)) return;
    if (summary?.trim()) {
      session.summaryBuffer.push(summary.trim());
      console.info(`[Summary] Added #${session.summaryBuffer.length}: ${summary.slice(0, 80)}…`);
    }
  } catch (err) {
    console.warn(`[Summary] Attempt ${attempt + 1} failed:`, err.message);
    if (attempt < SUMMARY_MAX_RETRIES - 1) {
      // Queue retry — this ensures chunks 12-24 are never permanently lost
      // even if the network blips during the first attempt
      console.info(`[Summary] Scheduling retry ${attempt + 2} in ${SUMMARY_RETRY_DELAY_MS / 1000}s`);
      setTimeout(() => enqueueSummary(sessionId, batchStart, batchText, attempt + 1), SUMMARY_RETRY_DELAY_MS);
    } else {
      console.error(`[Summary] Permanently failed after ${SUMMARY_MAX_RETRIES} attempts — batch starting at chunk ${batchStart} lost`);
    }
  }
}

// ── Batch assembly ────────────────────────────────────────────────────────

/**
 * Deduplicate model suggestions against existing visible cards, then pad to
 * 3 using transcript-derived sentence-based questions if needed.
 * Padding is always grounded in actual words from the transcript.
 */
function assembleBatch(modelItems, existingPreviews, transcriptContext) {
  const existingPreviewKeys = new Set(existingPreviews.map(p => toKey(p)));
  const chosen              = [];
  const chosenItemKeys      = new Set();
  const chosenAnchorKeys    = new Set();

  const tryAdd = item => {
    const n = normalise([item])[0];
    if (!n) return false;

    const anchorKey  = toKey(item?._anchor || '');
    const previewKey = toKey(n.preview);
    const detailKey  = toKey(n.detail);
    const itemKey    = `${previewKey}|${detailKey}`;

    if (!previewKey) return false;
    if (existingPreviewKeys.has(previewKey)) return false;
    if (chosenItemKeys.has(itemKey)) return false;
    if (anchorKey && chosenAnchorKeys.has(anchorKey)) return false;

    chosen.push(n);
    chosenItemKeys.add(itemKey);
    if (anchorKey) chosenAnchorKeys.add(anchorKey);
    return true;
  };

  for (const item of modelItems) {
    if (chosen.length >= 3) break;
    tryAdd(item);
  }

  if (chosen.length < 3 && transcriptContext) {
    const fallbackItems = buildFallbackSuggestions(transcriptContext);
    for (const item of fallbackItems) {
      if (chosen.length >= 3) break;
      tryAdd(item);
    }
  }

  // Hard guarantee: always return exactly 3 distinct suggestions.
  while (chosen.length < 3) {
    const anchor = pickFallbackAnchor(transcriptContext);
    const i = chosen.length + 1;
    tryAdd({
      type: 'CLARIFICATION',
      preview: anchor === 'the latest discussion point'
        ? `Clarify the latest discussion point (${i})`
        : `Clarify the point about "${anchor}" (${i})`,
      detail: anchor === 'the latest discussion point'
        ? 'Can we confirm exactly what is being decided before moving on?'
        : `Can we confirm exactly what we mean by "${anchor}" before moving on?`,
    });
  }

  return chosen.slice(0, 3);
}

function buildFallbackSuggestions(transcriptContext) {
  const candidates = [];
  const anchors = (transcriptContext.match(/[^.!?\n]+[.!?]?/g) || [])
    .map(s => s.trim())
    .filter(isCompleteSentenceAnchor)
    .reverse();

  // Round-robin by type so we avoid a repetitive triple from one anchor.
  for (const sentence of anchors) {
    const anchor = shortSnippet(sentence, 72);
    candidates.push({
      type: 'QUESTION_TO_ASK',
      preview: `Ask for specifics on "${anchor}"`,
      detail: `Could you add concrete detail behind "${anchor}"?`,
      _anchor: anchor,
    });
  }

  const keywords = extractKeywords(transcriptContext, 6);
  for (const kw of keywords) {
    candidates.push({
      type: 'FACT_CHECK',
      preview: `Validate the claim related to "${kw}"`,
      detail: `Can we verify the source, date, or metric behind "${kw}"?`,
      _anchor: kw,
    });
  }

  for (const sentence of anchors) {
    const anchor = shortSnippet(sentence, 72);
    candidates.push({
      type: 'CLARIFICATION',
      preview: `Clarify intent behind "${anchor}"`,
      detail: `Just to clarify, what is the intended outcome of "${anchor}"?`,
      _anchor: anchor,
    });
  }

  for (const sentence of anchors) {
    const anchor = shortSnippet(sentence, 72);
    candidates.push({
      type: 'ACTION',
      preview: `Capture a next step from "${anchor}"`,
      detail: `Let's lock one owner and due date related to "${anchor}".`,
      _anchor: anchor,
    });
  }

  return candidates;
}

function pickFallbackAnchor(transcriptContext) {
  const sentences = (transcriptContext.match(/[^.!?\n]+[.!?]?/g) || [])
    .map(s => s.trim())
    .filter(isCompleteSentenceAnchor)
    .reverse();

  if (sentences.length > 0) {
    return shortSnippet(sentences[0], 48);
  }

  const keywords = extractKeywords(transcriptContext, 1);
  if (keywords.length > 0) {
    return keywords[0];
  }

  return 'the latest discussion point';
}

function extractKeywords(text, max) {
  const STOP = new Set([
    'about', 'after', 'again', 'also', 'because', 'before', 'being', 'between', 'could', 'first', 'from', 'have',
    'into', 'just', 'maybe', 'more', 'much', 'only', 'other', 'should', 'since', 'some', 'than', 'that', 'their',
    'there', 'these', 'they', 'this', 'those', 'very', 'what', 'when', 'where', 'which', 'while', 'with', 'would',
  ]);
  const counts = new Map();
  const tokens = String(text || '').toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || [];
  for (const t of tokens) {
    if (STOP.has(t)) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([w]) => w);
}

function shortSnippet(text, maxLen) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'latest point';
  return clean.length <= maxLen ? clean : `${clean.slice(0, maxLen - 1)}…`;
}

function isCompleteSentenceAnchor(sentence) {
  const clean = String(sentence || '').replace(/\s+/g, ' ').trim();
  if (clean.split(/\s+/).length < 5) return false;

  // Reject obviously cut-off fragments that end mid-thought.
  if (/\b(and|or|but|so|because|then|when|while|if|the|a|an|to|of|in|on|at|for|with|by|from)$/i.test(clean)) {
    return false;
  }

  return true;
}

function toKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── JSON parsing / repair ─────────────────────────────────────────────────

function parseSuggestions(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const t = raw.trim();

  if (t && !t.endsWith('}') && !t.endsWith(']')) {
    console.warn('[Suggestions] Response appears truncated');
  }

  const candidates = [t];
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const obj = t.match(/\{[\s\S]*\}/);
  if (obj?.[0]) candidates.push(obj[0]);
  const arr = t.match(/\[[\s\S]*\]/);
  if (arr?.[0]) candidates.push(`{"suggestions":${arr[0]}}`);

  for (const c of candidates) {
    const direct = tryParse(c);
    if (direct) return direct;
    const repaired = tryParse(repairJson(c));
    if (repaired) return repaired;
  }

  const loose = extractLoosely(t);
  return loose.length ? { suggestions: loose } : null;
}

function tryParse(text) {
  if (!text) return null;
  try {
    const p = JSON.parse(text);
    if (Array.isArray(p))                       return { suggestions: normalise(p) };
    if (p && Array.isArray(p.suggestions))      return { suggestions: normalise(p.suggestions) };
  } catch { /* ignore */ }
  return null;
}

function repairJson(text) {
  return text
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/```(?:json)?/gi, '').replace(/```/g, '')
    .replace(/[\u0000-\u0019]+/g, ' ')
    .replace(/\b([a-zA-Z_]\w*)\s*:/g, '"$1":')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/\}\s*\{/g, '},{')
    .trim();
}

function extractLoosely(text) {
  return (text.match(/\{[\s\S]*?\}/g) || []).reduce((out, block) => {
    const type    = (block.match(/"type"\s*:\s*"([^"]+)"/)            || [])[1];
    const preview = (block.match(/"preview"\s*:\s*"([\s\S]*?)"\s*[,}]/) || [])[1];
    const detail  = (block.match(/"detail"\s*:\s*"([\s\S]*?)"\s*[,}]/)  || [])[1] || '';
    if (type && preview) {
      out.push({ type, preview: preview.replace(/\\n/g, ' ').trim(), detail: detail.replace(/\\n/g, ' ').trim() });
    }
    return out;
  }, []);
}

// ── Normalisation & quality filter ────────────────────────────────────────

const GENERIC_PHRASES = [
  /^clarify (owner|next step)/i,
  /^confirm (timeline|owner|deadline)/i,
  /^align on scope/i,
  /^next step.*clarify/i,
  /^follow-up check \d/i,
  /^refresh angle \d/i,
  /safety fallback/i,
  /keep accountability explicit/i,
];

function normalise(items) {
  return (items || [])
    .map(s => ({
      type:    String(s?.type    || '').trim().toUpperCase(),
      preview: String(s?.preview || '').trim(),
      detail:  String(s?.detail  || '').trim(),
    }))
    .filter(s => s.type && s.preview && s.preview.length >= 8)
    .filter(s => !GENERIC_PHRASES.some(re => re.test(s.preview)));
}
