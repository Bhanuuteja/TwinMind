/* ── state.js ──────────────────────────────────────────────────────────────
   Centralised mutable session state. All modules import `state` and mutate
   it directly. This makes data flow explicit and testable: tests can reset
   state by calling resetSession() rather than hunting scattered globals.
───────────────────────────────────────────────────────────────────────────── */

import {
  DEFAULT_SUGGESTION_CONTEXT_CHARS,
  DEFAULT_CHAT_CONTEXT_CHARS,
  DEFAULT_CHAT_RAW_CHUNKS,
  DEFAULT_MEMORY_WINDOW_MS,
} from './config.js';
import { makeContextMemory } from './Contextmemory.js';

// ── Per-session data (cleared on every new recording) ────────────────────

export const session = {
  id: 0,               // incremented on each startRecording(); guards stale async callbacks
  recorderId: 0,       // id of the currently active MediaRecorder session

  allChunks: [],       // full raw transcript chunks [{index, text}]
  summaryBuffer: [],   // compressed summaries from rolling summariser
  summaryRetryQueue: [],  // [{batchStart, batchText, attempts}] — failed summaries awaiting retry
  recentBuffer: [],    // [{text, ts}] — rolling recent-context window (pruned by memoryWindow)
  contextMemory: makeContextMemory(), // semantic compression layers (keyFacts, topicThread, actionMap)

  chatHistory: [],     // [{role, content, timestamp}]
  suggestionHistory: [],

  segmentCounter: 0,
  wordTotal: 0,
  totalSeconds: 0,

  isRecording: false,
  audioMode: 'system',

  // suggestion rate-limiting
  wordCountAtLastSuggestion: 0,
  lastSuggestionCompletedAt: 0,
  suggestionInFlight: false,
};

// ── User settings (persisted in localStorage, survive across sessions) ───

export const settings = {
  apiKey: '',
  livePromptTemplate: '',
  chatPromptTemplate: '',
  clickAnswerPromptTemplate: '',
  suggestionContextChars: DEFAULT_SUGGESTION_CONTEXT_CHARS,
  chatContextChars: DEFAULT_CHAT_CONTEXT_CHARS,
  chatRawChunksWindow: DEFAULT_CHAT_RAW_CHUNKS,
  memoryWindowMs: DEFAULT_MEMORY_WINDOW_MS,
};

// ── Helpers ───────────────────────────────────────────────────────────────

/** True if the given sessionId matches the current active session. */
export function isActiveSession(id) {
  return id === session.id;
}

/** Reset all per-recording state for a fresh session. */
export function resetSession() {
  session.allChunks                 = [];
  session.summaryBuffer             = [];
  session.summaryRetryQueue         = [];
  session.recentBuffer              = [];
  session.contextMemory             = makeContextMemory();
  session.chatHistory               = [];
  session.suggestionHistory         = [];
  session.segmentCounter            = 0;
  session.wordTotal                 = 0;
  session.totalSeconds              = 0;
  session.isRecording               = false;
  session.wordCountAtLastSuggestion = 0;
  session.lastSuggestionCompletedAt = 0;
  session.suggestionInFlight        = false;
}

/** Prune the recentBuffer to the configured memory window. */
export function pruneRecentBuffer(nowMs = Date.now()) {
  const cutoff = nowMs - settings.memoryWindowMs;
  session.recentBuffer = session.recentBuffer.filter(item => item.ts >= cutoff);
}