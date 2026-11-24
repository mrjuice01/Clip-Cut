/**
 * High-DPI HTML5 Canvas waveform renderer with time ruler,
 * zoom/scroll, draggable selection handles, and playhead.
 */
export class WaveformView {
  constructor(scrollContainer, canvas, callbacks = {}) {
    this.scrollContainer = scrollContainer;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.callbacks = callbacks;

    this.buffer = null;
    this.duration = 0;
    this.zoom = 1; // 1 = fit container width, up to 40x
    this.selStart = 0;
    this.selEnd = 0;
    this.playhead = 0;
    this.hoverTime = null;
    this.savedRegions = [];

    // Cached peak data for fast redraws
    this.peaks = null;
    this.peaksWidth = 0;

    // Interaction state
    this.dragMode = null; // 'create' | 'start' | 'end' | 'move'
    this.dragOriginTime = 0;
    this.dragStartOffset = 0;
    this.dragInitialStart = 0;
    this.dragInitialEnd = 0;
    this.pointerMoved = false;

    this.rulerHeight = 24;
    this.handleHitRadius = 10;

    this.bindEvents();
  }

  setBuffer(audioBuffer) {
    this.buffer = audioBuffer;
    this.duration = audioBuffer ? audioBuffer.duration : 0;
    this.zoom = 1;
    this.peaks = null;
    this.peaksWidth = 0;
    this.selStart = 0;
    this.selEnd = Math.min(this.duration, Math.max(1, this.duration * 0.2));
    this.playhead = 0;
    this.resize();
    this.render();
  }

  setSelection(start, end) {
    if (!this.duration) return;
    const s = Math.max(0, Math.min(this.duration, start));
    const e = Math.max(0, Math.min(this.duration, end));
    this.selStart = Math.min(s, e);
    this.selEnd = Math.max(s, e);
    this.render();
  }

  setPlayhead(timeSec) {
    this.playhead = Math.max(0, Math.min(this.duration, timeSec));
    this.render();
  }

  setSavedRegions(clips) {
    this.savedRegions = clips || [];
    this.render();
  }

  setZoom(zoomValue, anchorTime = null) {
    if (!this.buffer) return;
    const clampedZoom = Math.max(1, Math.min(40, zoomValue));
    const oldWidth = this.getCanvasCssWidth();
    const containerWidth = this.scrollContainer.clientWidth || 800;

    let anchorXRatio = 0.5;
    if (anchorTime !== null && this.duration > 0) {
      const oldPx = (anchorTime / this.duration) * oldWidth;
      anchorXRatio = (oldPx - this.scrollContainer.scrollLeft) / containerWidth;
    }

    this.zoom = clampedZoom;
    this.resize();

    if (anchorTime !== null && this.duration > 0) {
      const newWidth = this.getCanvasCssWidth();
      const newPx = (anchorTime / this.duration) * newWidth;
      this.scrollContainer.scrollLeft = Math.max(0, newPx - anchorXRatio * containerWidth);
    }

    this.render();
  }

  getCanvasCssWidth() {
    const base = Math.max(300, this.scrollContainer.clientWidth || 800);
    return Math.round(base * this.zoom);
  }

  getCanvasCssHeight() {
    return 184;
  }

  resize() {
    const cssW = this.getCanvasCssWidth();
    const cssH = this.getCanvasCssHeight();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);

    if (this.buffer && this.peaksWidth !== cssW) {
      this.computePeaks(cssW);
    }
  }

  computePeaks(widthPx) {
    const numChannels = this.buffer.numberOfChannels;
    const left = this.buffer.getChannelData(0);
    const right = numChannels > 1 ? this.buffer.getChannelData(1) : null;
    const totalSamples = this.buffer.length;
    const samplesPerPixel = Math.max(1, totalSamples / widthPx);

    const mins = new Float32Array(widthPx);
    const maxs = new Float32Array(widthPx);

    // Subsample step for very long files so peak computation stays < 15ms
    const step = Math.max(1, Math.floor(samplesPerPixel / 64));

    for (let x = 0; x < widthPx; x++) {
      const start = Math.floor(x * samplesPerPixel);
      const end = Math.min(totalSamples, Math.floor((x + 1) * samplesPerPixel));
      let min = 1;
      let max = -1;

      for (let i = start; i < end; i += step) {
        const v = right ? (left[i] + right[i]) * 0.5 : left[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }

      if (min > max) {
        min = 0;
        max = 0;
      }
      mins[x] = min;
      maxs[x] = max;
    }

    this.peaks = { mins, maxs };
    this.peaksWidth = widthPx;
  }

  timeToX(timeSec) {
    if (!this.duration) return 0;
    return (timeSec / this.duration) * this.getCanvasCssWidth();
  }

  xToTime(x) {
    if (!this.duration) return 0;
    const w = this.getCanvasCssWidth();
    return Math.max(0, Math.min(this.duration, (x / w) * this.duration));
  }

  render() {
    const ctx = this.ctx;
    const cssW = this.getCanvasCssWidth();
    const cssH = this.getCanvasCssHeight();
    const dpr = this.canvas.width / cssW || 1;

    ctx.save();
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, cssW, cssH);

    // Ruler background
    ctx.fillStyle = '#131922';
    ctx.fillRect(0, 0, cssW, this.rulerHeight);
    ctx.strokeStyle = '#232c3b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, this.rulerHeight + 0.5);
    ctx.lineTo(cssW, this.rulerHeight + 0.5);
    ctx.stroke();

    const waveTop = this.rulerHeight;
    const waveHeight = cssH - waveTop;
    const midY = waveTop + waveHeight / 2;
    const amp = waveHeight * 0.44;

    // Center line
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(cssW, midY);
    ctx.stroke();

    // Draw time ruler ticks
    if (this.duration > 0) {
      this.drawRuler(ctx, cssW);
    }

    // Subtle markers for already-saved clips along the bottom
    if (this.savedRegions.length > 0 && this.duration > 0) {
      for (const clip of this.savedRegions) {
        const sx = this.timeToX(clip.start);
        const ex = this.timeToX(clip.end);
        ctx.fillStyle = 'rgba(16, 185, 129, 0.14)';
        ctx.fillRect(sx, cssH - 6, Math.max(2, ex - sx), 6);
      }
    }

    // Draw waveform
    if (this.peaks) {
      const { mins, maxs } = this.peaks;
      const selStartX = this.timeToX(this.selStart);
      const selEndX = this.timeToX(this.selEnd);

      // Draw unselected waveform
      ctx.fillStyle = '#475569';
      for (let x = 0; x < mins.length; x++) {
        if (x >= selStartX && x <= selEndX) continue;
        const yTop = midY - maxs[x] * amp;
        const yBot = midY - mins[x] * amp;
        ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
      }

      // Draw selected region background
      if (selEndX > selStartX) {
        ctx.fillStyle = 'rgba(56, 189, 248, 0.15)';
        ctx.fillRect(selStartX, waveTop, selEndX - selStartX, waveHeight);

        // Draw selected waveform in bright cyan
        ctx.fillStyle = '#38bdf8';
        const startPx = Math.max(0, Math.floor(selStartX));
        const endPx = Math.min(mins.length - 1, Math.ceil(selEndX));
        for (let x = startPx; x <= endPx; x++) {
          const yTop = midY - maxs[x] * amp;
          const yBot = midY - mins[x] * amp;
          ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
        }

        // Top drag bar on selection
        ctx.fillStyle = 'rgba(56, 189, 248, 0.35)';
        ctx.fillRect(selStartX, waveTop, selEndX - selStartX, 6);

        // Start & End handles
        this.drawHandle(ctx, selStartX, waveTop, waveHeight, 'left');
        this.drawHandle(ctx, selEndX, waveTop, waveHeight, 'right');
      }
    }

    // Hover guide
    if (this.hoverTime !== null && !this.dragMode) {
      const hx = this.timeToX(this.hoverTime);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hx + 0.5, waveTop);
      ctx.lineTo(hx + 0.5, cssH);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Playhead
    if (this.duration > 0) {
      const px = this.timeToX(this.playhead);
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, cssH);
      ctx.stroke();

      // Playhead triangle in ruler
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath();
      ctx.moveTo(px - 5, 0);
      ctx.lineTo(px + 5, 0);
      ctx.lineTo(px, 8);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }

  drawHandle(ctx, x, top, height, side) {
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, top + height);
    ctx.stroke();

    // Small pill grip
    const gripW = 8;
    const gripH = 26;
    const gripX = side === 'left' ? x : x - gripW;
    const gripY = top + (height - gripH) / 2;

    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.roundRect(gripX, gripY, gripW, gripH, 3);
    ctx.fill();

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(gripX + 3, gripY + 7, 2, 12);
  }

  drawRuler(ctx, cssW) {
    const pxPerSec = cssW / this.duration;
    const targetSpacingPx = 90;
    const rawStep = targetSpacingPx / pxPerSec;
    const niceSteps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = niceSteps.find((s) => s >= rawStep) || 600;

    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
    ctx.textBaseline = 'top';

    for (let t = 0; t <= this.duration; t += step) {
      const x = this.timeToX(t);
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, this.rulerHeight - 6);
      ctx.lineTo(x + 0.5, this.rulerHeight);
      ctx.stroke();

      const label = formatRulerTime(t, step < 1);
      if (x + 42 < cssW) {
        ctx.fillText(label, x + 4, 5);
      }
    }
  }

  getPointerPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  hitTest(x, y) {
    const sx = this.timeToX(this.selStart);
    const ex = this.timeToX(this.selEnd);

    if (Math.abs(x - sx) <= this.handleHitRadius) return 'start';
    if (Math.abs(x - ex) <= this.handleHitRadius) return 'end';
    if (y >= this.rulerHeight && y <= this.rulerHeight + 16 && x > sx && x < ex) {
      return 'move';
    }
    return 'create';
  }

  bindEvents() {
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.buffer || e.button !== 0) return;
      const { x, y } = this.getPointerPos(e);
      const time = this.xToTime(x);

      // Clicking in the ruler seeks directly
      if (y < this.rulerHeight) {
        this.playhead = time;
        this.render();
        if (this.callbacks.onSeek) this.callbacks.onSeek(time);
        return;
      }

      this.canvas.setPointerCapture(e.pointerId);
      this.dragMode = this.hitTest(x, y);
      this.dragOriginTime = time;
      this.dragInitialStart = this.selStart;
      this.dragInitialEnd = this.selEnd;
      this.pointerMoved = false;
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.buffer) return;
      const { x, y } = this.getPointerPos(e);
      const time = this.xToTime(x);
      this.hoverTime = time;

      if (!this.dragMode) {
        const hit = y < this.rulerHeight ? 'seek' : this.hitTest(x, y);
        if (hit === 'start' || hit === 'end') {
          this.canvas.style.cursor = 'ew-resize';
        } else if (hit === 'move') {
          this.canvas.style.cursor = 'grab';
        } else if (hit === 'seek') {
          this.canvas.style.cursor = 'pointer';
        } else {
          this.canvas.style.cursor = 'crosshair';
        }
        this.render();
        return;
      }

      if (Math.abs(time - this.dragOriginTime) > 0.005) {
        this.pointerMoved = true;
      }

      if (this.dragMode === 'create') {
        this.selStart = Math.min(this.dragOriginTime, time);
        this.selEnd = Math.max(this.dragOriginTime, time);
      } else if (this.dragMode === 'start') {
        this.selStart = Math.max(0, Math.min(this.selEnd - 0.05, time));
      } else if (this.dragMode === 'end') {
        this.selEnd = Math.min(this.duration, Math.max(this.selStart + 0.05, time));
      } else if (this.dragMode === 'move') {
        const delta = time - this.dragOriginTime;
        const len = this.dragInitialEnd - this.dragInitialStart;
        let nextStart = this.dragInitialStart + delta;
        if (nextStart < 0) nextStart = 0;
        if (nextStart + len > this.duration) nextStart = this.duration - len;
        this.selStart = nextStart;
        this.selEnd = nextStart + len;
      }

      this.render();
      if (this.callbacks.onSelectionChange) {
        this.callbacks.onSelectionChange(this.selStart, this.selEnd);
      }
    });

    const endDrag = (e) => {
      if (!this.dragMode) return;
      const mode = this.dragMode;
      const moved = this.pointerMoved;
      this.dragMode = null;

      if (this.canvas.hasPointerCapture(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }

      // Single click without drag seeks playhead instead of collapsing selection
      if (mode === 'create' && !moved) {
        this.selStart = this.dragInitialStart;
        this.selEnd = this.dragInitialEnd;
        this.playhead = this.dragOriginTime;
        this.render();
        if (this.callbacks.onSeek) this.callbacks.onSeek(this.dragOriginTime);
      } else if (this.selEnd - this.selStart < 0.05) {
        this.selStart = this.dragInitialStart;
        this.selEnd = this.dragInitialEnd;
        this.render();
      } else {
        if (this.callbacks.onSelectionChange) {
          this.callbacks.onSelectionChange(this.selStart, this.selEnd);
        }
      }
    };

    this.canvas.addEventListener('pointerup', endDrag);
    this.canvas.addEventListener('pointercancel', endDrag);
    this.canvas.addEventListener('pointerleave', () => {
      this.hoverTime = null;
      if (!this.dragMode) this.render();
    });

    // Wheel zoom when holding Ctrl/Meta or vertical wheel over canvas
    this.scrollContainer.addEventListener(
      'wheel',
      (e) => {
        if (!this.buffer) return;
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const factor = e.deltaY < 0 ? 1.25 : 0.8;
          const nextZoom = Math.max(1, Math.min(40, this.zoom * factor));
          this.setZoom(nextZoom, this.hoverTime ?? this.playhead);
          if (this.callbacks.onZoomChange) this.callbacks.onZoomChange(this.zoom);
        }
      },
      { passive: false }
    );

    window.addEventListener('resize', () => {
      if (this.buffer) {
        this.resize();
        this.render();
      }
    });
  }
}

function formatRulerTime(sec, showTenths) {
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  if (showTenths) {
    return `${mins}:${rem.toFixed(1).padStart(4, '0')}`;
  }
  return `${mins}:${Math.floor(rem).toString().padStart(2, '0')}`;
}
