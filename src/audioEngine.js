/**
 * Web Audio API playback engine with sample-accurate A-B looping,
 * variable playback speed, and independent clip previewing.
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffer = null;
    this.source = null;

    this.isPlaying = false;
    this.playbackRate = 1;
    this.loopEnabled = false;

    // Tracking playhead accurately across speed changes & loops
    this.startedAtCtxTime = 0;
    this.startOffset = 0;
    this.playEnd = 0;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.currentTime = 0;

    // Previewing a specific saved clip ID (or null for main editor playback)
    this.previewClipId = null;

    this.onStateChange = null;
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  async decodeFile(file) {
    this.stop();
    const ctx = this.ensureContext();
    const arrayBuffer = await file.arrayBuffer();
    try {
      const decoded = await ctx.decodeAudioData(arrayBuffer);
      this.buffer = decoded;
      this.currentTime = 0;
      this.notify();
      return decoded;
    } catch (err) {
      throw new Error(
        `Could not decode audio from "${file.name}". Your browser may not support this codec or container.`
      );
    }
  }

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  getCurrentTime() {
    if (!this.buffer) return 0;
    if (!this.isPlaying || !this.ctx) return this.currentTime;

    const elapsed = (this.ctx.currentTime - this.startedAtCtxTime) * this.playbackRate;
    let pos = this.startOffset + elapsed;

    if (this.loopEnabled && this.loopEnd > this.loopStart) {
      const loopLen = this.loopEnd - this.loopStart;
      if (pos >= this.loopEnd) {
        pos = this.loopStart + ((pos - this.loopStart) % loopLen);
      }
      return Math.max(this.loopStart, Math.min(this.loopEnd, pos));
    }

    return Math.max(0, Math.min(this.playEnd || this.duration, pos));
  }

  play({ start = 0, end = null, loop = false, previewClipId = null } = {}) {
    if (!this.buffer) return;
    this.stop(false);

    const ctx = this.ensureContext();
    const duration = this.buffer.duration;
    const clampedStart = Math.max(0, Math.min(duration - 0.001, start));
    const clampedEnd =
      end !== null && end > clampedStart ? Math.min(duration, end) : duration;

    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = this.playbackRate;

    this.loopEnabled = Boolean(loop && clampedEnd > clampedStart);
    this.loopStart = clampedStart;
    this.loopEnd = clampedEnd;
    this.startOffset = clampedStart;
    this.playEnd = clampedEnd;
    this.previewClipId = previewClipId;

    if (this.loopEnabled) {
      source.loop = true;
      source.loopStart = clampedStart;
      source.loopEnd = clampedEnd;
    }

    source.connect(ctx.destination);
    this.startedAtCtxTime = ctx.currentTime;
    this.isPlaying = true;
    this.source = source;

    source.onended = () => {
      if (this.source === source) {
        this.source = null;
        this.isPlaying = false;
        this.currentTime = this.loopEnabled ? this.loopStart : this.playEnd;
        this.previewClipId = null;
        this.notify();
      }
    };

    if (this.loopEnabled) {
      source.start(0, clampedStart);
    } else {
      const playDuration = Math.max(0.001, clampedEnd - clampedStart);
      source.start(0, clampedStart, playDuration);
    }

    this.notify();
  }

  pause() {
    if (!this.isPlaying) return;
    this.currentTime = this.getCurrentTime();
    this.stop(false);
    this.notify();
  }

  stop(resetNotify = true) {
    if (this.source) {
      const old = this.source;
      this.source = null;
      old.onended = null;
      try {
        old.stop();
        old.disconnect();
      } catch {
        // Already stopped
      }
    }
    this.isPlaying = false;
    this.previewClipId = null;
    if (resetNotify) {
      this.notify();
    }
  }

  seek(timeSec) {
    if (!this.buffer) return;
    const clamped = Math.max(0, Math.min(this.duration, timeSec));
    this.currentTime = clamped;
    if (this.isPlaying && !this.previewClipId) {
      const wasLooping = this.loopEnabled;
      const loopStart = this.loopStart;
      const loopEnd = this.loopEnd;
      if (wasLooping && clamped >= loopStart && clamped < loopEnd) {
        // Restart at new position inside loop
        this.stop(false);
        const ctx = this.ensureContext();
        const source = ctx.createBufferSource();
        source.buffer = this.buffer;
        source.playbackRate.value = this.playbackRate;
        source.loop = true;
        source.loopStart = loopStart;
        source.loopEnd = loopEnd;
        source.connect(ctx.destination);
        this.startedAtCtxTime = ctx.currentTime;
        this.startOffset = clamped;
        this.loopEnabled = true;
        this.loopStart = loopStart;
        this.loopEnd = loopEnd;
        this.isPlaying = true;
        this.source = source;
        source.start(0, clamped);
      } else {
        this.play({ start: clamped, end: this.duration, loop: false });
      }
    }
    this.notify();
  }

  setPlaybackRate(rate) {
    const newRate = Number(rate) || 1;
    if (this.isPlaying && this.ctx && this.source) {
      const currentPos = this.getCurrentTime();
      this.playbackRate = newRate;
      this.startedAtCtxTime = this.ctx.currentTime;
      this.startOffset = currentPos;
      this.source.playbackRate.setValueAtTime(newRate, this.ctx.currentTime);
    } else {
      this.playbackRate = newRate;
    }
    this.notify();
  }

  updateLoopBounds(start, end) {
    if (!this.isPlaying || !this.loopEnabled || !this.source || this.previewClipId) return;
    if (end <= start) return;
    const currentPos = this.getCurrentTime();
    this.loopStart = start;
    this.loopEnd = end;
    this.source.loopStart = start;
    this.source.loopEnd = end;
    if (currentPos < start || currentPos >= end) {
      this.play({ start, end, loop: true });
    }
  }

  notify() {
    if (this.onStateChange) this.onStateChange();
  }
}
