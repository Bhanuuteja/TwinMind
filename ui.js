/* ── ui.js ─────────────────────────────────────────────────────────────────
   All DOM interaction lives here. No API calls, no business logic.
   Exposes named render/bind functions that app.js wires together.
───────────────────────────────────────────────────────────────────────────── */

// marked + DOMPurify are loaded via CDN <script> tags in index.html
// and are available on window. We reference them here for clarity.
const { marked, DOMPurify } = window;

// Configure marked: GitHub-flavoured, sanitised via DOMPurify
marked.use({ gfm: true, breaks: false });
function renderMarkdown(md) {
  const raw = marked.parse(md || '');
  return DOMPurify.sanitize(raw, { FORCE_BODY: false });
}

// ── DOM refs ──────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

export const dom = {
  // settings
  btnOpenSettings:     $('btnOpenSettings'),
  btnModalClose:       $('btnModalClose'),
  settingsModal:       $('settingsModal'),
  settingsApiKey:      $('settingsApiKey'),
  settingsForm:        $('settingsForm'),
  settingsLivePrompt:  $('settingsLivePrompt'),
  settingsChatPrompt:  $('settingsChatPrompt'),
  settingsClickPrompt: $('settingsClickPrompt'),
  settingsSuggChars:   $('settingsSuggestionChars'),
  settingsSuggCharsRange: $('settingsSuggestionCharsRange'),
  settingsSuggCharsValue: $('settingsSuggestionCharsValue'),
  settingsChatChars:   $('settingsChatChars'),
  settingsChatCharsRange: $('settingsChatCharsRange'),
  settingsChatCharsValue: $('settingsChatCharsValue'),
  settingsMemWindow:   $('settingsMemoryWindow'),
  settingsMemWindowRange: $('settingsMemoryWindowRange'),
  settingsMemWindowValue: $('settingsMemoryWindowValue'),
  presetFast:          $('presetFast'),
  presetBalanced:      $('presetBalanced'),
  presetDeep:          $('presetDeep'),
  settingsImpactChip:  $('settingsImpactChip'),
  settingsImpactHint:  $('settingsImpactHint'),
  settingsDirtyBadge:  $('settingsDirtyBadge'),
  btnResetDefaults:    $('btnResetDefaults'),
  btnSaveSettings:     $('btnSaveSettings'),
  // recorder
  recordBtn:           $('recordBtn'),
  statusLabel:         $('statusLabel'),
  statusSub:           $('statusSub'),
  timerEl:             $('timer'),
  chunkBarWrap:        $('chunkBarWrap'),
  chunkBarFill:        $('chunkBarFill'),
  chunkCountdown:      $('chunkCountdown'),
  tipBanner:           $('tipBanner'),
  sourceSelect:        $('sourceSelect'),
  // transcript
  transcriptBody:      $('transcriptBody'),
  emptyState:          $('emptyState'),
  transcriptDot:       $('transcriptDot'),
  btnCopy:             $('btnCopy'),
  btnDownload:         $('btnDownload'),
  btnClear:            $('btnClear'),
  segCountEl:          $('segCount'),
  wordCountEl:         $('wordCount'),
  durationStatEl:      $('durationStat'),
  toastContainer:      $('toastContainer'),
  // suggestions
  sugBody:             $('sugBody'),
  sugDot:              $('sugDot'),
  sugEmpty:            $('sugEmpty'),
  btnRefresh:          $('btnRefresh'),
  // chat
  chatMessages:        $('chatMessages'),
  chatEmpty:           $('chatEmpty'),
  chatInput:           $('chatInput'),
  btnChatSend:         $('btnChatSend'),
  btnExportSession:    $('btnExportSession'),
  // waveform
  waveform:            $('waveform'),
};

// ── Toast ─────────────────────────────────────────────────────────────────

const TOAST_ICONS = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };

export function showToast(msg, type = 'info', durationMs = 3500) {
  const t    = document.createElement('div');
  t.className = `toast ${type}`;
  const icon = document.createElement('span');
  icon.textContent = TOAST_ICONS[type] || TOAST_ICONS.info;
  const text = document.createElement('span');
  text.textContent = String(msg || '');
  t.append(icon, text);
  dom.toastContainer.appendChild(t);
  setTimeout(() => {
    t.style.cssText += 'opacity:0;transform:translateY(8px);transition:all .3s';
    setTimeout(() => t.remove(), 300);
  }, durationMs);
}

// ── Timer + chunk bar ─────────────────────────────────────────────────────

let timerInterval   = null;
let chunkBarId      = null;
let chunkBarStartMs = 0;
let recordingStartMs = 0;

export function startTimer(onTick) {
  recordingStartMs = Date.now();
  dom.timerEl.classList.remove('hidden');
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - recordingStartMs) / 1000);
    onTick(s);
    dom.timerEl.textContent     = formatTime(s);
    dom.durationStatEl.textContent = formatTime(s);
  }, 500);
}

export function stopTimer() {
  clearInterval(timerInterval);
  dom.timerEl.classList.add('hidden');
}

export function startChunkBar(durationMs) {
  dom.chunkBarWrap.classList.remove('hidden');
  chunkBarStartMs = Date.now();
  chunkBarId = setInterval(() => {
    const elapsed   = Date.now() - chunkBarStartMs;
    const pct       = Math.min((elapsed / durationMs) * 100, 100);
    const remaining = Math.max(0, Math.ceil((durationMs - elapsed) / 1000));
    dom.chunkBarFill.style.width   = pct + '%';
    dom.chunkCountdown.textContent = remaining + 's';
  }, 250);
}

export function resetChunkBar() {
  chunkBarStartMs = Date.now();
}

export function stopChunkBar() {
  clearInterval(chunkBarId);
  dom.chunkBarWrap.classList.add('hidden');
  dom.chunkBarFill.style.width   = '0%';
  dom.chunkCountdown.textContent = '30s';
}

// ── Recording UI state ────────────────────────────────────────────────────

export function setRecordingActive(modeLabel) {
  dom.recordBtn.classList.add('recording');
  dom.sugDot.classList.add('live');
  dom.transcriptDot.classList.add('live');
  if (dom.sourceSelect) {
    dom.sourceSelect.disabled = true;
    dom.sourceSelect.style.opacity = '0.5';
  }
  dom.statusLabel.textContent = 'Recording…';
  dom.statusSub.textContent   = `Capturing ${modeLabel} · transcript every 30s`;
}

export function setRecordingStopped() {
  dom.recordBtn.classList.remove('recording');
  dom.sugDot.classList.remove('live');
  dom.transcriptDot.classList.remove('live');
  if (dom.sourceSelect) {
    dom.sourceSelect.disabled = false;
    dom.sourceSelect.style.opacity = '';
  }
  dom.statusLabel.textContent = 'Processing…';
  dom.statusSub.textContent   = 'Transcribing final audio chunk…';
}

export function setIdle() {
  dom.statusLabel.textContent = 'Ready to Record';
  dom.statusSub.textContent   = 'Click the button above to start transcribing';
}

export function setStatusSub(msg) {
  dom.statusSub.textContent = msg;
}

// ── Source toggle ─────────────────────────────────────────────────────────

export function applyMode(mode) {
  if (dom.sourceSelect) dom.sourceSelect.value = mode;
  if (dom.tipBanner) dom.tipBanner.classList.toggle('hidden', mode === 'mic');
}

// ── Session reset ─────────────────────────────────────────────────────────

export function resetSessionUI() {
  dom.transcriptBody.querySelectorAll('.segment').forEach(el => el.remove());
  dom.emptyState.style.display = '';
  dom.sugBody.querySelectorAll('.sug-batch').forEach(el => el.remove());
  dom.sugEmpty.style.display = '';
  dom.chatMessages.querySelectorAll('.chat-msg').forEach(el => el.remove());
  dom.chatEmpty.style.display = '';
  dom.segCountEl.textContent     = '0';
  dom.wordCountEl.textContent    = '0';
  dom.durationStatEl.textContent = '—';
  setTranscriptActionsEnabled(false);
}

// ── Transcript segments ───────────────────────────────────────────────────

export function addProcessingSegment(id, timestamp) {
  dom.emptyState.style.display = 'none';
  const seg = document.createElement('div');
  seg.className = 'segment processing';
  seg.id = `seg-${id}`;
  seg.innerHTML = `
    <div class="segment-meta">
      <div class="segment-num">${id}</div>
      <div class="segment-line"></div>
    </div>
    <div class="segment-content">
      <div class="segment-ts">${timestamp}</div>
      <div class="segment-text">Transcribing<span class="processing-dots"><span>.</span><span>.</span><span>.</span></span></div>
    </div>`;
  dom.transcriptBody.appendChild(seg);
  scrollTranscript();
}

export function updateSegmentText(id, text, muted = false) {
  const seg = document.getElementById(`seg-${id}`);
  if (!seg) return;
  seg.classList.remove('processing');
  const node = seg.querySelector('.segment-text');
  node.textContent   = text;
  node.style.color   = muted ? 'var(--text-muted)' : '';
  node.style.fontStyle = muted ? 'italic' : '';
}

export function updateSegmentError(id, msg) {
  const seg = document.getElementById(`seg-${id}`);
  if (!seg) return;
  seg.querySelector('.segment-num').style.cssText += 'background:rgba(252,129,129,.1);color:var(--accent-red)';
  seg.querySelector('.segment-text').textContent   = `[Error: ${msg}]`;
  seg.classList.remove('processing');
}

export function scrollTranscript() {
  dom.transcriptBody.scrollTo({ top: dom.transcriptBody.scrollHeight, behavior: 'smooth' });
}

export function setTranscriptActionsEnabled(enabled) {
  dom.btnCopy.disabled     = !enabled;
  dom.btnDownload.disabled = !enabled;
  dom.btnClear.disabled    = !enabled;
}

export function updateWordAndSegCounts(wordTotal, segCount) {
  dom.wordCountEl.textContent = wordTotal;
  dom.segCountEl.textContent  = segCount;
}

export function getTranscriptText() {
  return Array.from(dom.transcriptBody.querySelectorAll('.segment:not(.processing)'))
    .map(s => `[${s.querySelector('.segment-ts')?.textContent || ''}] ${s.querySelector('.segment-text')?.textContent || ''}`)
    .join('\n\n');
}

// ── Suggestions ───────────────────────────────────────────────────────────

export const SUGGESTION_TYPES = {
  QUESTION_TO_ASK: { label: 'Question to Ask', color: '#63b3ed', bg: 'rgba(99,179,237,0.12)',  border: 'rgba(99,179,237,0.35)'  },
  TALKING_POINT:   { label: 'Talking Point',    color: '#9f7aea', bg: 'rgba(159,122,234,0.12)', border: 'rgba(159,122,234,0.35)' },
  FACT_CHECK:      { label: 'Fact Check',       color: '#f6ad55', bg: 'rgba(246,173,85,0.12)',  border: 'rgba(246,173,85,0.35)'  },
  ANSWER:          { label: 'Answer',           color: '#68d391', bg: 'rgba(104,211,145,0.12)', border: 'rgba(104,211,145,0.35)' },
  CLARIFICATION:   { label: 'Clarification',    color: '#a0aec0', bg: 'rgba(160,174,192,0.12)', border: 'rgba(160,174,192,0.35)' },
  ACTION:          { label: 'Action',           color: '#f56565', bg: 'rgba(245,101,101,0.12)', border: 'rgba(245,101,101,0.35)' },
};

/**
 * Render a new batch of suggestions at the top of the suggestions panel.
 * @param {object[]} suggestions
 * @param {(preview: string, detail: string) => void} onCardClick
 */
export function renderSuggestionBatch(suggestions, onCardClick) {
  if (!suggestions?.length) return;
  dom.sugEmpty.style.display = 'none';

  const now   = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const batch = document.createElement('div');
  batch.className = 'sug-batch';

  const ts = document.createElement('div');
  ts.className   = 'sug-batch-ts';
  ts.textContent = suggestions.length < 3 ? `${now} · ${suggestions.length} suggestion${suggestions.length > 1 ? 's' : ''}` : now;
  batch.appendChild(ts);

  suggestions.forEach(s => {
    const cfg     = SUGGESTION_TYPES[s.type] ?? SUGGESTION_TYPES.TALKING_POINT;
    const card    = document.createElement('div');
    card.className = 'sug-card';

    const top = document.createElement('div');
    top.className = 'sug-card-top';

    const badge = document.createElement('span');
    badge.className = 'sug-type-badge';
    Object.assign(badge.style, { background: cfg.bg, borderColor: cfg.border, color: cfg.color });
    badge.textContent = cfg.label;

    const preview = document.createElement('div');
    preview.className   = 'sug-preview';
    preview.textContent = s.preview;

    top.appendChild(badge);
    card.append(top, preview);

    // Show detail directly on the card — value without requiring a click
    if (s.detail && s.detail.trim() && s.detail.trim() !== s.preview.trim()) {
      const detail = document.createElement('div');
      detail.className   = 'sug-detail';
      detail.textContent = s.detail;
      card.appendChild(detail);
    }

    card.addEventListener('click', () => onCardClick(s.preview, s.detail));
    batch.appendChild(card);
  });

  dom.sugBody.insertBefore(batch, dom.sugBody.firstChild);
}

/** Read all currently displayed suggestion previews (for deduplication). */
export function getVisiblePreviews(limit) {
  return Array.from(dom.sugBody.querySelectorAll('.sug-preview'))
    .map(el => el.textContent.trim())
    .filter(Boolean)
    .slice(0, limit);
}

export function setSuggestionRefreshState(spinning) {
  dom.btnRefresh.disabled = spinning;
  dom.btnRefresh.classList.toggle('spinning', spinning);
}

// ── Chat ──────────────────────────────────────────────────────────────────

/**
 * Append a user or assistant message bubble.
 * Returns { wrap, bubble } so the caller can update the bubble during streaming.
 */
export function appendChatMessage(role, text, loading = false) {
  dom.chatEmpty.style.display = 'none';
  const wrap   = document.createElement('div');
  wrap.className = `chat-msg ${role}${loading ? ' loading' : ''}`;
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  if (role === 'assistant' && !loading) bubble.innerHTML = renderMarkdown(text);
  else                                   bubble.textContent = text;
  wrap.appendChild(bubble);
  dom.chatMessages.appendChild(wrap);
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
  return { wrap, bubble };
}

export function finaliseAssistantBubble(bubble, text) {
  bubble.classList.remove('streaming');
  bubble.innerHTML = renderMarkdown(text);
}

// ── Settings form ─────────────────────────────────────────────────────────

export function populateSettingsForm(settings) {
  dom.settingsApiKey.value      = settings.apiKey;
  dom.settingsLivePrompt.value  = settings.livePromptTemplate;
  dom.settingsChatPrompt.value  = settings.chatPromptTemplate;
  dom.settingsClickPrompt.value = settings.clickAnswerPromptTemplate;
  dom.settingsSuggChars.value   = String(settings.suggestionContextChars);
  if (dom.settingsSuggCharsRange) dom.settingsSuggCharsRange.value = String(settings.suggestionContextChars);
  if (dom.settingsSuggCharsValue) dom.settingsSuggCharsValue.textContent = String(settings.suggestionContextChars);
  dom.settingsChatChars.value   = String(settings.chatContextChars);
  if (dom.settingsChatCharsRange) dom.settingsChatCharsRange.value = String(settings.chatContextChars);
  if (dom.settingsChatCharsValue) dom.settingsChatCharsValue.textContent = String(settings.chatContextChars);
  dom.settingsMemWindow.value   = String(Math.round(settings.memoryWindowMs / 1000));
  if (dom.settingsMemWindowRange) dom.settingsMemWindowRange.value = String(Math.round(settings.memoryWindowMs / 1000));
  if (dom.settingsMemWindowValue) dom.settingsMemWindowValue.textContent = String(Math.round(settings.memoryWindowMs / 1000));
  updateContextImpact();
}

export function readSettingsForm() {
  return {
    apiKey:                dom.settingsApiKey.value.trim(),
    livePromptTemplate:    dom.settingsLivePrompt.value.trim(),
    chatPromptTemplate:    dom.settingsChatPrompt.value.trim(),
    clickAnswerPromptTemplate: dom.settingsClickPrompt.value.trim(),
    suggestionContextChars: Math.max(400, parseInt(dom.settingsSuggChars.value, 10) || 0),
    chatContextChars:       Math.max(800, parseInt(dom.settingsChatChars.value, 10) || 0),
    memoryWindowMs:         Math.max(15, parseInt(dom.settingsMemWindow.value, 10) || 0) * 1000,
  };
}

function bindLinkedInputs(numberEl, rangeEl, valueEl, suffix = '') {
  if (!numberEl) return;
  const sync = source => {
    const val = source.value;
    numberEl.value = val;
    if (rangeEl) rangeEl.value = val;
    if (valueEl) valueEl.textContent = `${val}${suffix}`;
  };
  numberEl.addEventListener('input', () => sync(numberEl));
  if (rangeEl) rangeEl.addEventListener('input', () => sync(rangeEl));
  sync(numberEl);
}

function setPresetButtonState(activeId) {
  [dom.presetFast, dom.presetBalanced, dom.presetDeep].forEach(btn => {
    if (!btn) return;
    btn.classList.toggle('active', btn.id === activeId);
  });
}

function updateContextImpact() {
  const s = parseInt(dom.settingsSuggChars?.value || '0', 10);
  const c = parseInt(dom.settingsChatChars?.value || '0', 10);
  const m = parseInt(dom.settingsMemWindow?.value || '0', 10);
  const score = s + c + (m * 20);

  if (!dom.settingsImpactChip || !dom.settingsImpactHint) return;

  dom.settingsImpactChip.classList.remove('fast', 'deep');
  if (score < 2400) {
    dom.settingsImpactChip.textContent = 'Fast';
    dom.settingsImpactChip.classList.add('fast');
    dom.settingsImpactHint.textContent = 'Lowest latency, lighter context grounding.';
  } else if (score > 4200) {
    dom.settingsImpactChip.textContent = 'Deep';
    dom.settingsImpactChip.classList.add('deep');
    dom.settingsImpactHint.textContent = 'Highest context quality, slower and costlier.';
  } else {
    dom.settingsImpactChip.textContent = 'Balanced';
    dom.settingsImpactHint.textContent = 'Good quality and response speed.';
  }
}

export function setSettingsDirty(isDirty) {
  if (dom.settingsDirtyBadge) dom.settingsDirtyBadge.classList.toggle('hidden', !isDirty);
}

export function resetSettingsToDefaultsUI(defaults) {
  if (!defaults) return;
  dom.settingsSuggChars.value = String(defaults.suggestionContextChars);
  dom.settingsChatChars.value = String(defaults.chatContextChars);
  dom.settingsMemWindow.value = String(defaults.memoryWindowSeconds);
  dom.settingsLivePrompt.value = defaults.livePromptTemplate;
  dom.settingsChatPrompt.value = defaults.chatPromptTemplate;
  dom.settingsClickPrompt.value = defaults.clickAnswerPromptTemplate;
  dom.settingsSuggChars.dispatchEvent(new Event('input', { bubbles: true }));
  dom.settingsChatChars.dispatchEvent(new Event('input', { bubbles: true }));
  dom.settingsMemWindow.dispatchEvent(new Event('input', { bubbles: true }));
}

export function initSettingsUX() {
  bindLinkedInputs(dom.settingsSuggChars, dom.settingsSuggCharsRange, dom.settingsSuggCharsValue);
  bindLinkedInputs(dom.settingsChatChars, dom.settingsChatCharsRange, dom.settingsChatCharsValue);
  bindLinkedInputs(dom.settingsMemWindow, dom.settingsMemWindowRange, dom.settingsMemWindowValue, 's');

  const applyPreset = (id, suggestionChars, chatChars, memorySeconds) => {
    dom.settingsSuggChars.value = String(suggestionChars);
    dom.settingsChatChars.value = String(chatChars);
    dom.settingsMemWindow.value = String(memorySeconds);
    dom.settingsSuggChars.dispatchEvent(new Event('input', { bubbles: true }));
    dom.settingsChatChars.dispatchEvent(new Event('input', { bubbles: true }));
    dom.settingsMemWindow.dispatchEvent(new Event('input', { bubbles: true }));
    setPresetButtonState(id);
    updateContextImpact();
  };

  dom.presetFast?.addEventListener('click', () => applyPreset('presetFast', 600, 800, 20));
  dom.presetBalanced?.addEventListener('click', () => applyPreset('presetBalanced', 800, 900, 30));
  dom.presetDeep?.addEventListener('click', () => applyPreset('presetDeep', 1400, 2200, 45));
  [dom.settingsSuggChars, dom.settingsChatChars, dom.settingsMemWindow].forEach(el => {
    el?.addEventListener('input', updateContextImpact);
  });

  updateContextImpact();
}

export function showSettingsModal()  { dom.settingsModal.classList.remove('hidden'); }
export function hideSettingsModal()  { dom.settingsModal.classList.add('hidden'); }

// ── Utilities ─────────────────────────────────────────────────────────────

export function formatTime(s) {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}