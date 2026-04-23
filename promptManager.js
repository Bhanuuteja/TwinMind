/* ── promptManager.js ──────────────────────────────────────────────────────
   Builds all prompt strings and context windows. No API calls, no DOM access.
   Pure functions that take data and return strings — fully unit-testable.

   CONTEXT STRATEGY (token-optimised)
   ────────────────────────────────────
   Suggestions  →  buildCompressedSuggestionContext  (~350-500 tokens)
     • Current topic thread (3 sentences)
     • High-signal key facts: decisions, questions, risks, deadlines, numbers
     • Action map (last 5 items)
     • Last ~300 raw chars for exact-word grounding

   Chat         →  buildCompressedChatContext  (~600-900 tokens)
     • Full key facts (25 items, all types, priority-sorted)
     • Complete action map (10 items)
     • Rolling summaries (compressed history)
     • Topic thread
     • Last 2 raw chunks capped at 800 chars for exact-quote grounding

   Raw transcript is never passed wholesale — only semantic extractions
   plus a small recency tail for grounding.
───────────────────────────────────────────────────────────────────────────── */

import { pruneRecentBuffer } from './state.js';
import {
  buildCompressedSuggestionContext,
  buildCompressedChatContext,
  ingestChunk,
} from './Contextmemory.js';

// ── Context builders ──────────────────────────────────────────────────────

/**
 * Trim text to at most maxChars, breaking only at sentence boundaries so the
 * model always sees complete thoughts rather than mid-sentence truncation.
 */
export function trimToSentenceWindow(text, maxChars) {
  const raw = String(text || '').trim();
  if (raw.length <= maxChars) return raw;

  const sentences = raw.match(/[^.!?]+[.!?]?/g) || [raw];
  const picked = [];
  let total = 0;
  for (let i = sentences.length - 1; i >= 0; i--) {
    const s = sentences[i].trim();
    if (!s) continue;
    if (total + s.length + 1 > maxChars && picked.length > 0) break;
    picked.unshift(s);
    total += s.length + 1;
    if (total >= maxChars) break;
  }
  return picked.join(' ').trim() || raw.slice(-maxChars);
}

/**
 * Ingest a new transcript chunk into the contextMemory pipeline.
 * Call this from app.js immediately after a successful transcription,
 * before buildSuggestionContext / buildChatContext.
 */
export function ingestTranscriptChunk(session, text) {
  if (!text?.trim() || !session.contextMemory) return;
  ingestChunk(session.contextMemory, text, session.segmentCounter);
}

/**
 * Build the compressed context string for suggestion generation.
 * Uses semantic memory layers — NOT raw transcript wholesale.
 */
export function buildSuggestionContext(session, settings) {
  pruneRecentBuffer();

  // Recency tail: last 300 chars from the rolling buffer for exact-word grounding
  const recentRaw = session.recentBuffer
    .map(item => item.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-300);

  const compressed = buildCompressedSuggestionContext(session.contextMemory, recentRaw);

  // If contextMemory is empty (e.g. very first chunk), fall back to raw window
  if (!compressed.trim()) {
    return trimToSentenceWindow(
      session.allChunks.map(c => c.text).join(' '),
      settings.suggestionContextChars
    );
  }

  // Respect the user-configured char cap (compressed form is dense so allow 2× headroom)
  return compressed.slice(0, settings.suggestionContextChars * 2);
}

/**
 * Build the compressed context string for chat responses.
 * Combines full key facts, action map, rolling summaries, and a recency tail.
 */
export function buildChatContext(session, settings) {
  pruneRecentBuffer();

  const compressed = buildCompressedChatContext(
    session.contextMemory,
    session.summaryBuffer,
    session.allChunks,
    800  // raw tail cap in chars
  );

  if (compressed.length > settings.chatContextChars) {
    return compressed.slice(-settings.chatContextChars);
  }
  return compressed;
}

// ── Context signal detection ──────────────────────────────────────────────

/** Detect semantic signals in transcript text to tune prompt priorities. */
export function detectSignals(text) {
  const t     = String(text || '');
  const lower = t.toLowerCase();
  return {
    hasQuestions:  /\?/.test(t),
    hasNumbers:    /\b\d+(?:\.\d+)?%?\b/.test(t),
    hasDecision:   /\b(decide|decision|approve|approved|go with|choose|chosen)\b/.test(lower),
    hasActionItems:/\b(action item|owner|deadline|due|follow up|next step|todo|task)\b/.test(lower),
    hasRisk:       /\b(risk|blocker|issue|problem|concern|dependency)\b/.test(lower),
  };
}

// ── Prompt assembly ───────────────────────────────────────────────────────

/**
 * Augment the live suggestion system prompt with signal-derived priorities
 * so the model focuses on what's actually happening right now.
 */
export function buildSuggestionSystemPrompt(basePrompt, transcriptContext) {
  const s = detectSignals(transcriptContext);
  const hints = [];

  if (s.hasDecision)    hints.push('- A decision was mentioned — include one ACTION naming the specific decision and ideally an owner.');
  if (s.hasActionItems) hints.push('- Action items were mentioned — include one suggestion referencing the specific task by name.');
  if (s.hasRisk)        hints.push('- A risk or blocker was mentioned — include one FACT_CHECK or CLARIFICATION referencing it directly.');
  if (s.hasNumbers)     hints.push('- Specific numbers were mentioned — include one FACT_CHECK naming the exact number/metric and asking for source/date.');
  if (s.hasQuestions)   hints.push('- A question was just asked — include one ANSWER that directly addresses it.');

  if (!hints.length) return basePrompt;
  return `${basePrompt}\n\nTRANSCRIPT SIGNALS (use only if confirmed in transcript):\n${hints.join('\n')}`;
}

/**
 * Augment the chat system prompt with intent-derived formatting instructions.
 */
export function buildChatSystemPrompt(basePrompt, userMessage, transcriptContext) {
  const q = String(userMessage || '').toLowerCase();
  const s = detectSignals(transcriptContext);
  const rules = [];

  if (/\b(how|steps|process|workflow|walk\s*through)\b/.test(q))
    rules.push('- Format as clear numbered steps with owners/deadlines where relevant.');
  if (/\b(table|compare|comparison|matrix)\b/.test(q))
    rules.push('- Include a compact markdown table if it improves clarity.');
  if (/\b(quick|brief|short|tldr|summary)\b/.test(q))
    rules.push('- Keep the answer very brief (under 120 words).');
  if (/\b(why|reason|cause)\b/.test(q))
    rules.push('- State the root cause first, then supporting points from the transcript.');
  if (s.hasActionItems)
    rules.push('- Highlight any owners, deadlines, or action items from the transcript.');
  if (s.hasDecision)
    rules.push('- Clearly distinguish decisions already made vs. pending ones.');
  if (!rules.length)
    rules.push('- Keep the response practical and immediately useful.');

  return `${basePrompt}\n\nADDITIONAL RESPONSE RULES:\n${rules.join('\n')}\n- Do not claim transcript evidence unless it is explicitly present.`;
}