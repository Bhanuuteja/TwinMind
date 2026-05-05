/* ── app.js ────────────────────────────────────────────────────────────────
   Thin orchestration layer. Imports all modules, wires event listeners,
   and coordinates the recording → transcription → suggestion pipeline.

   Module responsibilities:
     config.js          — constants & prompt templates
     state.js           — shared mutable session state
     groqApi.js         — Groq API calls (transcription, chat, streaming)
     audioManager.js    — MediaRecorder + native timeslice chunk scheduling
     promptManager.js   — context builders, signal detection, prompt assembly
     suggestionEngine.js — suggestion generation, summary retry queue
     settingsManager.js — localStorage persistence
     ui.js              — all DOM reads/writes, rendering
───────────────────────────────────────────────────────────────────────────── */

import { CHUNK_DURATION_MS, WHISPER_MODEL, SUGGESTIONS_MODEL, CHAT_MODEL } from './config.js';
import {
  DEFAULT_LIVE_PROMPT_TEMPLATE,
  DEFAULT_CHAT_PROMPT_TEMPLATE,
  DEFAULT_CLICK_ANSWER_PROMPT_TEMPLATE,
  DEFAULT_SUGGESTION_CONTEXT_CHARS,
  DEFAULT_CHAT_CONTEXT_CHARS,
  DEFAULT_MEMORY_WINDOW_MS,
} from './config.js';
import { session, settings, isActiveSession, resetSession, pruneRecentBuffer } from './state.js';
import { transcribeBlob, chatCompletionStream, logTokenEstimate } from './groqApi.js';
import { AudioManager } from './audioManager.js';
import { buildChatContext } from './promptManager.js';
import { buildChatSystemPrompt, ingestTranscriptChunk } from './promptManager.js';
import { shouldAutoGenerate, generateSuggestions, scheduleSummaryIfDue } from './suggestionEngine.js';
import { loadSettings, saveSettings } from './settingsManager.js';
import {
  dom, showToast, formatTime,
  startTimer, stopTimer, startChunkBar, stopChunkBar, resetChunkBar,
  setRecordingActive, setRecordingStopped, setIdle, setStatusSub,
  applyMode, resetSessionUI,
  addProcessingSegment, updateSegmentText, updateSegmentError,
  scrollTranscript, setTranscriptActionsEnabled, updateWordAndSegCounts,
  getTranscriptText,
  renderSuggestionBatch, setSuggestionRefreshState,
  appendChatMessage, finaliseAssistantBubble,
  populateSettingsForm, readSettingsForm, showSettingsModal, hideSettingsModal,
  initSettingsUX, setSettingsDirty, resetSettingsToDefaultsUI,
} from './ui.js';

// ── Initialise ────────────────────────────────────────────────────────────

loadSettings();
initSettingsUX();

let audioManager = null;
let lastSavedSettingsSnapshot = '';

const snapshotSettingsForm = () => JSON.stringify(readSettingsForm());

function refreshSettingsDirtyState() {
  const isDirty = snapshotSettingsForm() !== lastSavedSettingsSnapshot;
  setSettingsDirty(isDirty);
}

// ── Source mode toggle ────────────────────────────────────────────────────

applyMode(session.audioMode);

dom.sourceSelect?.addEventListener('change', () => {
  if (session.isRecording) return;
  session.audioMode = dom.sourceSelect.value;
  applyMode(session.audioMode);
});

// ── Settings modal ────────────────────────────────────────────────────────

dom.btnOpenSettings?.addEventListener('click', () => {
  populateSettingsForm(settings);
  lastSavedSettingsSnapshot = snapshotSettingsForm();
  setSettingsDirty(false);
  showSettingsModal();
});
dom.btnModalClose?.addEventListener('click', hideSettingsModal);
dom.settingsModal?.addEventListener('click', e => { if (e.target === dom.settingsModal) hideSettingsModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideSettingsModal(); });

dom.btnSaveSettings?.addEventListener('click', () => {
  const formValues = readSettingsForm();
  const error = saveSettings({
    ...formValues,
    livePromptTemplate:        formValues.livePromptTemplate        || settings.livePromptTemplate,
    chatPromptTemplate:        formValues.chatPromptTemplate        || settings.chatPromptTemplate,
    clickAnswerPromptTemplate: formValues.clickAnswerPromptTemplate || settings.clickAnswerPromptTemplate,
  });
  if (error) { showToast(error, 'error'); return; }
  lastSavedSettingsSnapshot = snapshotSettingsForm();
  setSettingsDirty(false);
  hideSettingsModal();
  showToast('Settings saved!', 'success');
});

dom.settingsForm?.addEventListener('input', refreshSettingsDirtyState);
dom.settingsForm?.addEventListener('change', refreshSettingsDirtyState);

dom.btnResetDefaults?.addEventListener('click', () => {
  resetSettingsToDefaultsUI({
    suggestionContextChars: DEFAULT_SUGGESTION_CONTEXT_CHARS,
    chatContextChars: DEFAULT_CHAT_CONTEXT_CHARS,
    memoryWindowSeconds: Math.round(DEFAULT_MEMORY_WINDOW_MS / 1000),
    livePromptTemplate: DEFAULT_LIVE_PROMPT_TEMPLATE,
    chatPromptTemplate: DEFAULT_CHAT_PROMPT_TEMPLATE,
    clickAnswerPromptTemplate: DEFAULT_CLICK_ANSWER_PROMPT_TEMPLATE,
  });
  refreshSettingsDirtyState();
  showToast('Defaults restored in form (not saved yet).', 'info');
});

// ── Recording ─────────────────────────────────────────────────────────────

dom.recordBtn.addEventListener('click', async () => {
  if (!settings.apiKey) {
    showToast('Please save your Groq API key first.', 'warning');
    showSettingsModal();
    return;
  }
  if (session.isRecording) stopRecording();
  else                     await startRecording();
});

async function startRecording() {
  try {
    // Increment session id first — any stale async callbacks from the previous
    // session will see isActiveSession() return false and bail out.
    session.id       = ++session.id;
    session.recorderId = session.id;
    const sessionId  = session.id;

    resetSession();
    session.id = sessionId; // restore after reset

    resetSessionUI();
    session.isRecording = true;

    audioManager = new AudioManager(dom.waveform, (blob, mimeType, isFinal) => {
      handleChunk(blob, mimeType, isFinal, sessionId);
    });

    await audioManager.start(session.audioMode, () => isActiveSession(sessionId));

    const modeLabel = { system: 'System Audio', both: 'System + Mic', mic: 'Microphone' }[session.audioMode] || 'Audio';
    setRecordingActive(modeLabel);
    startTimer(s => { session.totalSeconds = s; });
    startChunkBar(CHUNK_DURATION_MS);

    showToast(`🎙️ Recording ${modeLabel}`, 'success');
  } catch (err) {
    console.error(err);
    session.isRecording = false;
    showToast(err.message || 'Could not start recording. Check permissions.', 'error', 6000);
    setIdle();
  }
}

async function stopRecording() {
  session.isRecording = false;
  setRecordingStopped();
  stopTimer();
  stopChunkBar();
  await audioManager?.stop();
  audioManager = null;
}

// ── Chunk pipeline ────────────────────────────────────────────────────────

async function handleChunk(blob, mimeType, isFinal, sessionId) {
  if (!isActiveSession(sessionId)) return;

  resetChunkBar();

  const segId     = ++session.segmentCounter;
  const timestamp = formatTime(session.totalSeconds);
  addProcessingSegment(segId, timestamp);

  try {
    const text    = await transcribeBlob(blob, mimeType, settings.apiKey, setStatusSub);
    if (!isActiveSession(sessionId)) return;
    const trimmed = text?.trim();

    if (trimmed) {
      const now = Date.now();
      session.allChunks.push({ index: segId, timestamp, text: trimmed });
      session.recentBuffer.push({ text: trimmed, ts: now });
      pruneRecentBuffer(now);

      const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
      session.wordTotal += wordCount;
      updateWordAndSegCounts(session.wordTotal, session.segmentCounter);
      updateSegmentText(segId, trimmed);
      setTranscriptActionsEnabled(true);
      scrollTranscript();

      // Ingest into semantic memory pipeline (zero API calls — pure regex extraction)
      ingestTranscriptChunk(session, trimmed);

      // Rolling summary (delayed 3s to avoid simultaneous API calls)
      scheduleSummaryIfDue(sessionId);

      // Auto-trigger suggestions
      const { shouldGenerate, reason } = shouldAutoGenerate(trimmed, wordCount);
      if (shouldGenerate) {
        console.info(`[Suggestions] Triggered — ${reason}`);
        runSuggestions(sessionId);
      } else {
        console.info(`[Suggestions] Skipped — ${reason}`);
      }
    } else {
      updateSegmentText(segId, '[silence / inaudible]', true);
    }
  } catch (err) {
    console.error('Transcription error:', err);
    updateSegmentError(segId, err.message);
    showToast('Transcription failed: ' + err.message, 'error', 5000);
  }

  if (isFinal) {
    showToast('Recording stopped.', 'info');
    setIdle();
  }
}

// ── Suggestion orchestration ──────────────────────────────────────────────

async function runSuggestions(sessionId, opts = {}) {
  if (!settings.apiKey || !isActiveSession(sessionId)) return;
  setSuggestionRefreshState(true);

  const existingPreviews = session.suggestionHistory.flatMap(batch =>
    Array.isArray(batch.suggestions)
      ? batch.suggestions.map(s => s.preview)
      : []
  );

  await generateSuggestions(
    sessionId,
    existingPreviews,
    // onResult
    batch => {
      if (isActiveSession(sessionId)) {
        renderSuggestionBatch(batch, (preview, detail) => sendToChat(preview, detail));
      }
    },
    // onError
    (msg, isRateLimit) => {
      if (isRateLimit) {
        showToast(`Rate limit — suggestions paused briefly`, 'warning', 4000);
      } else {
        showToast(`Suggestion error: ${msg}`, 'error');
      }
    }
  );

  if (!opts.keepRefreshDisabled) setSuggestionRefreshState(false);
}

// ── Refresh button ────────────────────────────────────────────────────────

dom.btnRefresh.addEventListener('click', async () => {
  const sessionId = session.id;
  if (!sessionId) { showToast('No active session.', 'warning'); return; }

  setSuggestionRefreshState(true);
  try {
    if (session.isRecording) {
      await audioManager?.flushCurrentChunk?.();
    }
    await runSuggestions(sessionId, { keepRefreshDisabled: true });
  } finally {
    setSuggestionRefreshState(false);
  }
});

// ── Chat ──────────────────────────────────────────────────────────────────

async function generateChatResponse(userMessage, systemOverride = null) {
  if (!settings.apiKey) { showToast('Save your Groq API key first.', 'warning'); return; }

  dom.btnChatSend.disabled = true;

  const transcript     = buildChatContext(session, settings);
  const basePrompt     = systemOverride || settings.chatPromptTemplate;
  const groundedBase   = basePrompt
    .replace('{{TRANSCRIPT}}', transcript)
    .replace('{{ACTION}}',     userMessage)
    .replace('{{HINT}}',       '');
  const systemPrompt   = buildChatSystemPrompt(groundedBase, userMessage, transcript);

  session.chatHistory.push({ role: 'user', content: userMessage, timestamp: new Date().toISOString() });

  const payload = [
    { role: 'system', content: systemPrompt },
    ...session.chatHistory.slice(-12).map(m => ({ role: m.role, content: m.content })),
  ];
  logTokenEstimate('chat', payload, 800);

  appendChatMessage('user', userMessage);
  const { wrap, bubble } = appendChatMessage('assistant', '', true);
  bubble.classList.add('streaming');

  let fullReply = '';

  try {
    fullReply = await chatCompletionStream({
      model:       CHAT_MODEL,
      messages:    payload,
      maxTokens:   1200,
      temperature: 0.2,
      apiKey:      settings.apiKey,
      onToken:     (_delta, acc) => {
        bubble.textContent = acc;
        dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
      },
    });

    wrap.classList.remove('loading');
    session.chatHistory.push({ role: 'assistant', content: fullReply, timestamp: new Date().toISOString() });
    finaliseAssistantBubble(bubble, fullReply);
  } catch (err) {
    bubble.textContent = `Error: ${err.message}`;
    wrap.classList.remove('loading');
    session.chatHistory.pop();
  } finally {
    bubble.classList.remove('streaming');
    dom.btnChatSend.disabled   = false;
    dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
  }
}

function sendToChat(text, detail = null) {
  const last = session.chatHistory.filter(m => m.role === 'user').at(-1);
  if (last?.content?.trim() === text.trim()) return;
  dom.chatInput.value = '';

  // The preview is the user-visible message — clean and readable.
  // The detail is a hint for the LLM only — injected into the system prompt
  // so the model uses it as directional context, not something to parrot back.
  const transcript = buildChatContext(session, settings);
  const systemOverride = settings.clickAnswerPromptTemplate
    .replace('{{TRANSCRIPT}}', transcript)
    .replace('{{ACTION}}', text)
    .replace('{{HINT}}', detail || '');

  generateChatResponse(text, systemOverride);
}

dom.btnChatSend.addEventListener('click', () => {
  const q = dom.chatInput.value.trim();
  if (!q) return;
  dom.chatInput.value = '';
  dom.chatInput.style.height = '';
  generateChatResponse(q);
});

dom.chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); dom.btnChatSend.click(); }
});

dom.chatInput.addEventListener('input', () => {
  dom.chatInput.style.height = 'auto';
  dom.chatInput.style.height = Math.min(dom.chatInput.scrollHeight, 100) + 'px';
});

// ── Transcript actions ────────────────────────────────────────────────────

dom.btnCopy.addEventListener('click', () => {
  navigator.clipboard.writeText(getTranscriptText())
    .then(() => showToast('Copied to clipboard!', 'success'))
    .catch(() => showToast('Copy failed. Your browser blocked clipboard access.', 'error'));
});

dom.btnDownload.addEventListener('click', () => {
  const text = getTranscriptText();
  const date = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
  const blob = new Blob([text], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: `twinmind_transcript_${date}.txt` });
  a.click();
  URL.revokeObjectURL(url);
  showToast('Transcript downloaded!', 'success');
});

dom.btnClear.addEventListener('click', () => {
  if (!confirm('Clear the entire transcript?')) return;
  dom.transcriptBody.querySelectorAll('.segment').forEach(s => s.remove());
  dom.emptyState.style.display = '';
  session.allChunks                 = [];
  session.summaryBuffer             = [];
  session.recentBuffer              = [];
  session.wordTotal                 = 0;
  session.segmentCounter            = 0;
  session.wordCountAtLastSuggestion = 0;
  updateWordAndSegCounts(0, 0);
  setTranscriptActionsEnabled(false);
  showToast('Transcript cleared.', 'info');
});

// ── Export ────────────────────────────────────────────────────────────────

dom.btnExportSession?.addEventListener('click', () => {
  if (session.allChunks.length === 0) { showToast('No session data to export.', 'warning'); return; }

  const nowIso = new Date().toISOString();
  const data = {
    schemaVersion: '2.0.0',
    exportedAt: nowIso,
    app: { whisperModel: WHISPER_MODEL, suggestionsModel: SUGGESTIONS_MODEL, chatModel: CHAT_MODEL, chunkDurationMs: CHUNK_DURATION_MS, audioMode: session.audioMode },
    session: { segmentCount: session.segmentCounter, totalWords: session.wordTotal, durationSeconds: session.totalSeconds, durationFormatted: formatTime(session.totalSeconds) },
    transcript: { combinedText: getTranscriptText(), chunks: session.allChunks, rollingSummaries: session.summaryBuffer },
    ai: { suggestions: session.suggestionHistory, chat: session.chatHistory },
    prompts: { livePromptTemplate: settings.livePromptTemplate, chatPromptTemplate: settings.chatPromptTemplate, clickAnswerPromptTemplate: settings.clickAnswerPromptTemplate },
  };

  try {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
    const date = nowIso.slice(0, 19).replace('T', '_').replace(/:/g, '-');
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: `twinmind_session_export_${date}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Full session exported!', 'success');
  } catch (err) {
    console.error('[Export] Failed:', err);
    showToast('Export failed.', 'error');
  }
});