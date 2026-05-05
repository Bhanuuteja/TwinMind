/* ── groqApi.js ────────────────────────────────────────────────────────────
   All Groq API calls. No DOM access, no state mutation — pure async
   functions that take explicit inputs and return data or throw errors.
   The token estimator is also here since it exists to guard API payloads.
───────────────────────────────────────────────────────────────────────────── */

import {
  GROQ_ENDPOINT,
  GROQ_CHAT_ENDPOINT,
  WHISPER_MODEL,
  WHISPER_MAX_RETRIES,
  WHISPER_RETRY_DELAY_MS,
} from './config.js';

// ── Token estimation ─────────────────────────────────────────────────────

/**
 * Estimate token count for a string.
 *
 * The old "chars / 4" heuristic breaks down for non-Latin scripts:
 *   - Japanese/Chinese characters are typically 1 token each (not 4 chars)
 *   - Spanish/French are close to the English heuristic but diacritics add ~10%
 *
 * This implementation uses a simple tiered heuristic that is directionally
 * correct across the most common language groups without adding a tokeniser
 * dependency. It is used only for console logging (not hard limits), so
 * approximate accuracy is acceptable.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  // Count CJK characters (each ≈ 1 token)
  const cjkMatches = text.match(/[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff]/g);
  const cjkCount   = cjkMatches ? cjkMatches.length : 0;
  // Remaining (Latin/Cyrillic/Arabic etc.) ≈ chars / 4
  const remaining  = text.length - cjkCount;
  return cjkCount + Math.ceil(remaining / 4);
}

export function logTokenEstimate(label, messages, maxOutputTokens) {
  const inputChars   = (messages || []).reduce((sum, m) => sum + (m?.content?.length || 0), 0);
  const inputTokens  = messages.reduce((sum, m) => sum + estimateTokens(m?.content || ''), 0);
  console.info(
    `[Tokens] ${label}  input_chars=${inputChars}  input_tokens≈${inputTokens}  max_out=${maxOutputTokens}  total≈${inputTokens + maxOutputTokens}`
  );
}

// ── Whisper transcription ─────────────────────────────────────────────────

/**
 * Transcribe an audio Blob via Whisper Large V3.
 * Retries on 5xx errors up to WHISPER_MAX_RETRIES.
 * On 429, waits for the Retry-After duration then retries once.
 * Throws on unrecoverable errors.
 *
 * @param {Blob}   blob
 * @param {string} mimeType
 * @param {string} apiKey
 * @param {(msg: string) => void} onStatusUpdate  — called with user-visible status messages
 * @param {number} attempt
 * @returns {Promise<string>}
 */
export async function transcribeBlob(blob, mimeType, apiKey, onStatusUpdate, attempt = 0, mediaRetryAttempt = 0) {
  if (!blob || blob.size < 2_000) {
    throw new Error('Captured audio chunk was too small to transcribe.');
  }

  const normalizedMime = normalizeMimeType(mimeType || blob?.type || 'audio/webm');
  const ext  = mimeTypeToExt(normalizedMime);
  const file = new File([blob], `audio.${ext}`, { type: normalizedMime });
  const form = new FormData();
  form.append('file', file);
  form.append('model', WHISPER_MODEL);
  form.append('response_format', 'text');

  const res = await fetch(GROQ_ENDPOINT, {
    method:  'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body:    form,
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    const msg     = errData?.error?.message || `HTTP ${res.status}`;

    if (/valid media file|could not process file/i.test(msg)) {
      console.warn('[Whisper] Invalid media payload', {
        status: res.status,
        mimeType,
        normalizedMime,
        ext,
        size: blob?.size,
        attempt,
        mediaRetryAttempt,
      });

      // Some backends reject container metadata with codec suffixes.
      // Retry once with a normalized MIME label while keeping the same bytes.
      if (mediaRetryAttempt < 1) {
        return transcribeBlob(blob, normalizedMime, apiKey, onStatusUpdate, attempt, mediaRetryAttempt + 1);
      }
    }

    if (res.status === 429) {
      const match  = msg.match(/try again in (\d+(?:\.\d+)?)s/i);
      const waitMs = match ? Math.ceil(parseFloat(match[1])) * 1000 : 65_000;
      if (waitMs <= 360_000) {
        const endAt = Date.now() + waitMs;
        const tick  = setInterval(() => {
          const left = Math.ceil((endAt - Date.now()) / 1000);
          if (left > 0) onStatusUpdate?.(`Rate limit — retrying in ${left}s…`);
          else          clearInterval(tick);
        }, 1_000);
        onStatusUpdate?.(`Rate limit — retrying in ${Math.ceil(waitMs / 1000)}s…`);
        await delay(waitMs);
        clearInterval(tick);
        return transcribeBlob(blob, mimeType, apiKey, onStatusUpdate, attempt, mediaRetryAttempt);
      }
      throw new Error('Groq audio quota exhausted. Upgrade at console.groq.com or wait ~1 hour.');
    }

    if (res.status >= 500 && attempt < WHISPER_MAX_RETRIES) {
      const wait = WHISPER_RETRY_DELAY_MS * (attempt + 1);
      onStatusUpdate?.(`Server busy, retrying in ${wait / 1000}s… (${attempt + 1}/${WHISPER_MAX_RETRIES})`);
      await delay(wait);
      return transcribeBlob(blob, mimeType, apiKey, onStatusUpdate, attempt + 1, mediaRetryAttempt);
    }

    throw new Error(msg);
  }

  return res.text();
}

// ── Chat completions ──────────────────────────────────────────────────────

/**
 * Non-streaming chat completion. Returns the response content string.
 * Throws on API errors.
 */
export async function chatCompletion({ model, messages, maxTokens, temperature = 0.1, apiKey }) {
  const res = await fetch(GROQ_CHAT_ENDPOINT, {
    method:  'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

/**
 * Streaming chat completion. Calls onToken(delta) for each streamed token.
 * Returns the full accumulated response string.
 * Throws on API errors.
 */
export async function chatCompletionStream({ model, messages, maxTokens, temperature = 0.2, apiKey, onToken }) {
  const res = await fetch(GROQ_CHAT_ENDPOINT, {
    method:  'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, stream: true }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let   buffer  = '';
  let   full    = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // last possibly-incomplete line stays in buffer

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') break;
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content || '';
        full += delta;
        onToken?.(delta, full);
      } catch { /* malformed SSE chunk — skip */ }
    }
  }

  return full;
}

// ── Helpers ───────────────────────────────────────────────────────────────

export function getSupportedMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

export function mimeTypeToExt(mimeType) {
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('ogg'))  return 'ogg';
  if (mimeType.includes('mp4'))  return 'mp4';
  if (mimeType.includes('wav'))  return 'wav';
  return 'webm';
}

function normalizeMimeType(mimeType) {
  const base = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (!base) return 'audio/webm';
  if (base === 'audio/x-m4a') return 'audio/mp4';
  return base;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}
