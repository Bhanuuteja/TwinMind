/* ── settingsManager.js ────────────────────────────────────────────────────
   Handles loading and saving user settings to localStorage.
   Keeps storage key names in one place to avoid scattered magic strings.
───────────────────────────────────────────────────────────────────────────── */

import {
  DEFAULT_LIVE_PROMPT_TEMPLATE,
  DEFAULT_CHAT_PROMPT_TEMPLATE,
  DEFAULT_CLICK_ANSWER_PROMPT_TEMPLATE,
  DEFAULT_SUGGESTION_CONTEXT_CHARS,
  DEFAULT_CHAT_CONTEXT_CHARS,
  DEFAULT_MEMORY_WINDOW_MS,
  DEFAULT_CHAT_RAW_CHUNKS,
} from './config.js';
import { settings } from './state.js';

const KEYS = {
  apiKey:       'twinmind_groq_key',
  livePrompt:   'twinmind_live_prompt_v2',
  chatPrompt:   'twinmind_chat_prompt_v2',
  clickPrompt:  'twinmind_click_prompt_v1',
  suggChars:    'twinmind_suggestion_chars_v1',
  chatChars:    'twinmind_chat_chars_v1',
  memWindow:    'twinmind_memory_window_ms_v1',
};

export function loadSettings() {
  settings.apiKey = localStorage.getItem(KEYS.apiKey) || '';

  settings.livePromptTemplate         = pickPrompt(localStorage.getItem(KEYS.livePrompt),   DEFAULT_LIVE_PROMPT_TEMPLATE);
  settings.chatPromptTemplate         = pickPrompt(localStorage.getItem(KEYS.chatPrompt),   DEFAULT_CHAT_PROMPT_TEMPLATE);
  settings.clickAnswerPromptTemplate  = pickPrompt(localStorage.getItem(KEYS.clickPrompt),  DEFAULT_CLICK_ANSWER_PROMPT_TEMPLATE);

  const sc = parseInt(localStorage.getItem(KEYS.suggChars) || '', 10);
  settings.suggestionContextChars = Number.isFinite(sc) && sc >= 400 ? sc : DEFAULT_SUGGESTION_CONTEXT_CHARS;

  const cc = parseInt(localStorage.getItem(KEYS.chatChars) || '', 10);
  settings.chatContextChars = Number.isFinite(cc) && cc >= 800 ? cc : DEFAULT_CHAT_CONTEXT_CHARS;

  const mw = parseInt(localStorage.getItem(KEYS.memWindow) || '', 10);
  settings.memoryWindowMs = Number.isFinite(mw) && mw >= 15_000 ? mw : DEFAULT_MEMORY_WINDOW_MS;

  settings.chatRawChunksWindow = DEFAULT_CHAT_RAW_CHUNKS;
}

/**
 * Persist a partial settings object (from readSettingsForm) and apply to
 * the shared settings object.
 * @param {Partial<typeof settings>} incoming
 * @returns {string|null} validation error message, or null on success
 */
export function saveSettings(incoming) {
  if (incoming.apiKey && !incoming.apiKey.startsWith('gsk_')) {
    return 'Invalid API key — must start with gsk_';
  }

  Object.assign(settings, incoming);

  if (settings.apiKey) localStorage.setItem(KEYS.apiKey, settings.apiKey);
  else                 localStorage.removeItem(KEYS.apiKey);

  localStorage.setItem(KEYS.livePrompt,  settings.livePromptTemplate  || DEFAULT_LIVE_PROMPT_TEMPLATE);
  localStorage.setItem(KEYS.chatPrompt,  settings.chatPromptTemplate   || DEFAULT_CHAT_PROMPT_TEMPLATE);
  localStorage.setItem(KEYS.clickPrompt, settings.clickAnswerPromptTemplate || DEFAULT_CLICK_ANSWER_PROMPT_TEMPLATE);
  localStorage.setItem(KEYS.suggChars,   String(settings.suggestionContextChars));
  localStorage.setItem(KEYS.chatChars,   String(settings.chatContextChars));
  localStorage.setItem(KEYS.memWindow,   String(settings.memoryWindowMs));

  return null; // success
}

// ── Helpers ───────────────────────────────────────────────────────────────

function pickPrompt(saved, defaultValue) {
  if (!saved || isCorrupted(saved)) return defaultValue;
  return saved;
}

/** Guard against accidental JS code being saved into a prompt field. */
function isCorrupted(value) {
  const CODE_PATTERNS = [
    /(?:^|\n)\s*(const|let|var)\s+\w+/,
    /(?:^|\n)\s*function\s+\w+\s*\(/,
    /localStorage\./,
    /sendToChat\(/,
    /mediaRecorder|btnSaveSettings|chatHistory/,
  ];
  return CODE_PATTERNS.some(re => re.test(value));
}
