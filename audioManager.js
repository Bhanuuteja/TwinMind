/* ── audioManager.js ───────────────────────────────────────────────────────
   Owns all MediaRecorder and AudioContext lifecycle logic.

  CHUNK SCHEDULING:
  We rotate MediaRecorder every CHUNK_DURATION_MS by calling stop() and
  immediately creating a new recorder. Each stop emits a finalized chunk
  container that can be uploaded independently.
───────────────────────────────────────────────────────────────────────────── */

import { CHUNK_DURATION_MS } from './config.js';

export class AudioManager {
  #stream       = null;
  #audioCtx     = null;
  #analyser     = null;
  #recorder     = null;
  #animFrameId  = null;
  #waveBars     = [];
  #onChunk      = null;        // async (blob, mimeType, isFinal) => void
  #mimeType     = '';
  #sessionAlive = () => true;  // injected predicate — returns false once session ends
  #isStopping   = false;
  #chunkTimerId = null;
  #stopResolve  = null;
  #flushResolve = null;

  /** @param {HTMLElement} waveformEl  @param {(blob, mimeType, isFinal) => void} onChunk */
  constructor(waveformEl, onChunk) {
    this.#onChunk = onChunk;
    this.#buildWaveBars(waveformEl);
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Acquire the audio stream, wire up the analyser, and start recording.
   * @param {'mic'|'system'|'both'} mode
   * @param {() => boolean} sessionAlive  — injected session-id guard
   */
  async start(mode, sessionAlive) {
    this.#sessionAlive = sessionAlive;
    this.#stream   = await this.#getStream(mode);
    this.#audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source   = this.#audioCtx.createMediaStreamSource(this.#stream);
    this.#analyser = this.#audioCtx.createAnalyser();
    this.#analyser.fftSize = 256;
    source.connect(this.#analyser);

    this.#mimeType    = getSupportedMimeType();
    this.#isStopping   = false;

    this.#startRecorder();
    this.#animateWave();
  }

  /**
   * Stop recording gracefully, flushing the last in-progress chunk.
   * Resolves once the final chunk has been handed to the onChunk callback.
   */
  stop() {
    return new Promise(resolve => {
      if (!this.#recorder || this.#recorder.state === 'inactive') {
        this.#teardown();
        resolve();
        return;
      }
      this.#isStopping = true;
      clearTimeout(this.#chunkTimerId);
      this.#stopResolve = resolve;
      try {
        this.#recorder.stop();
      } catch {
        const done = this.#stopResolve;
        this.#stopResolve = null;
        this.#teardown();
        done?.();
      }
    });
  }

  get analyser() { return this.#analyser; }

  // ── Private ───────────────────────────────────────────────────────────

  #startRecorder() {
    const opts = this.#mimeType ? { mimeType: this.#mimeType } : {};
    this.#recorder = new MediaRecorder(this.#stream, opts);

    this.#recorder.ondataavailable = async e => {
      if (!e.data || e.data.size === 0) return;

      const isFinal = this.#isStopping;
      if (this.#sessionAlive() || isFinal) {
        await this.#onChunk?.(e.data, this.#mimeType || e.data.type || 'audio/webm', isFinal);
        const flushDone = this.#flushResolve;
        this.#flushResolve = null;
        flushDone?.();
      }
    };

    this.#recorder.onstop = () => {
      if (this.#isStopping || !this.#sessionAlive()) {
        const done = this.#stopResolve;
        this.#stopResolve = null;
        this.#teardown();
        done?.();
        return;
      }
      this.#startRecorder();
    };

    this.#recorder.onerror = err => {
      console.error('[AudioManager] MediaRecorder error:', err);
    };

    // Start an open-ended recorder; we finalize each chunk by rotating recorder.
    this.#recorder.start();
    this.#scheduleChunkRotate();
  }

  flushCurrentChunk() {
    return new Promise(resolve => {
      if (!this.#recorder || this.#recorder.state !== 'recording') {
        resolve(false);
        return;
      }

      clearTimeout(this.#chunkTimerId);
      this.#flushResolve = () => resolve(true);

      try {
        this.#recorder.stop();
      } catch {
        const flushDone = this.#flushResolve;
        this.#flushResolve = null;
        flushDone?.();
      }
    });
  }

  #scheduleChunkRotate() {
    clearTimeout(this.#chunkTimerId);
    this.#chunkTimerId = setTimeout(() => {
      if (!this.#recorder || this.#recorder.state !== 'recording') return;
      if (!this.#isStopping && this.#sessionAlive()) {
        this.#recorder.stop();
      }
    }, CHUNK_DURATION_MS);
  }

  #teardown() {
    cancelAnimationFrame(this.#animFrameId);
    clearTimeout(this.#chunkTimerId);
    this.#waveBars.forEach(b => { b.style.height = '6px'; b.classList.remove('active'); });
    this.#stream?.getTracks().forEach(t => t.stop());
    this.#audioCtx?.close();
    this.#audioCtx  = null;
    this.#analyser  = null;
    this.#recorder  = null;
    this.#stream    = null;
  }

  // ── Stream acquisition ────────────────────────────────────────────────

  async #getStream(mode) {
    const audioConstraints = { echoCancellation: false, noiseSuppression: false, sampleRate: 48_000 };

    if (mode === 'mic') {
      return navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    }

    let displayStream;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: audioConstraints });
    } catch {
      throw new Error('Screen share cancelled or denied. Please try again and check "Share system audio".');
    }
    displayStream.getVideoTracks().forEach(t => t.stop());

    const sysTracks = displayStream.getAudioTracks();
    if (sysTracks.length === 0) {
      throw new Error('No system audio captured. In the share dialog, check "Share system audio" and try again.');
    }

    if (mode === 'system') return new MediaStream(sysTracks);

    // 'both' — mix system + mic
    let micStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    } catch {
      // mic unavailable — fall back to system-only
      return new MediaStream(sysTracks);
    }
    const ctx  = this.#audioCtx || new AudioContext();
    this.#audioCtx = ctx;
    const dest = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(new MediaStream(sysTracks)).connect(dest);
    ctx.createMediaStreamSource(micStream).connect(dest);
    return dest.stream;
  }

  // ── Waveform ──────────────────────────────────────────────────────────

  #buildWaveBars(container) {
    const BAR_COUNT = 40;
    for (let i = 0; i < BAR_COUNT; i++) {
      const b = document.createElement('div');
      b.className = 'wave-bar';
      container.appendChild(b);
      this.#waveBars.push(b);
    }
  }

  #animateWave() {
    if (!this.#analyser) return;
    const data = new Uint8Array(this.#analyser.frequencyBinCount);
    this.#analyser.getByteFrequencyData(data);
    const step = Math.floor(data.length / this.#waveBars.length);
    this.#waveBars.forEach((b, i) => {
      const v = data[i * step] / 255;
      b.style.height = Math.max(6, v * 56) + 'px';
      b.classList.toggle('active', v > 0.05);
    });
    this.#animFrameId = requestAnimationFrame(() => this.#animateWave());
  }
}

function getSupportedMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
}
