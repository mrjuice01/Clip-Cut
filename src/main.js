import { AudioEngine } from './audioEngine.js';
import { WaveformView } from './waveform.js';
import { buildClipBlob, triggerDownload, downloadClipsAsZip } from './audioExport.js';

const engine = new AudioEngine();

const state = {
  fileName: '',
  fileStem: 'audio',
  selStart: 0,
  selEnd: 0,
  loopSelection: false,
  exportFormat: 'wav',
  applyFade: true,
  clips: [],
  nextClipNumber: 1,
  isZipping: false,
};

// DOM references
const el = {
  topbarActions: document.getElementById('topbarActions'),
  fileNameBadge: document.getElementById('fileNameBadge'),
  changeFileBtn: document.getElementById('changeFileBtn'),
  errorBanner: document.getElementById('errorBanner'),
  errorText: document.getElementById('errorText'),
  dismissErrorBtn: document.getElementById('dismissErrorBtn'),
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('fileInput'),
  browseBtn: document.getElementById('browseBtn'),
  loadingCard: document.getElementById('loadingCard'),
  loadingText: document.getElementById('loadingText'),
  workspace: document.getElementById('workspace'),
  waveformScroll: document.getElementById('waveformScroll'),
  waveformCanvas: document.getElementById('waveformCanvas'),
  playheadReadout: document.getElementById('playheadReadout'),
  totalDurationReadout: document.getElementById('totalDurationReadout'),
  zoomSlider: document.getElementById('zoomSlider'),
  zoomOutBtn: document.getElementById('zoomOutBtn'),
  zoomInBtn: document.getElementById('zoomInBtn'),
  zoomFitBtn: document.getElementById('zoomFitBtn'),
  playPauseBtn: document.getElementById('playPauseBtn'),
  playPauseIcon: document.getElementById('playPauseIcon'),
  playPauseLabel: document.getElementById('playPauseLabel'),
  playSelectionBtn: document.getElementById('playSelectionBtn'),
  loopToggleBtn: document.getElementById('loopToggleBtn'),
  startInput: document.getElementById('startInput'),
  endInput: document.getElementById('endInput'),
  setInBtn: document.getElementById('setInBtn'),
  setOutBtn: document.getElementById('setOutBtn'),
  selectionDurationReadout: document.getElementById('selectionDurationReadout'),
  saveClipBtn: document.getElementById('saveClipBtn'),
  clipCountBadge: document.getElementById('clipCountBadge'),
  fadeCheckbox: document.getElementById('fadeCheckbox'),
  downloadAllBtn: document.getElementById('downloadAllBtn'),
  clipsEmpty: document.getElementById('clipsEmpty'),
  clipsList: document.getElementById('clipsList'),
};

const waveform = new WaveformView(el.waveformScroll, el.waveformCanvas, {
  onSelectionChange(start, end) {
    setSelection(start, end, false);
  },
  onSeek(timeSec) {
    engine.seek(timeSec);
    updatePlayheadUI(timeSec);
  },
  onZoomChange(z) {
    el.zoomSlider.value = String(z);
  },
});

engine.onStateChange = () => {
  updateTransportUI();
  renderClipsList();
};

// --- Time formatting & parsing ---
function formatTime(sec) {
  const safe = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const mins = Math.floor(safe / 60);
  const rem = safe - mins * 60;
  const secsInt = Math.floor(rem);
  const hundredths = Math.floor((rem - secsInt) * 100);
  return `${mins}:${String(secsInt).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
}

function parseTime(str) {
  const trimmed = (str || '').trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return parseFloat(trimmed);
  }
  const parts = trimmed.split(':').map((p) => p.trim());
  if (parts.length === 2) {
    const mins = parseFloat(parts[0]);
    const secs = parseFloat(parts[1]);
    if (Number.isFinite(mins) && Number.isFinite(secs)) {
      return mins * 60 + secs;
    }
  } else if (parts.length === 3) {
    const hrs = parseFloat(parts[0]);
    const mins = parseFloat(parts[1]);
    const secs = parseFloat(parts[2]);
    if (Number.isFinite(hrs) && Number.isFinite(mins) && Number.isFinite(secs)) {
      return hrs * 3600 + mins * 60 + secs;
    }
  }
  return null;
}

// --- Error handling ---
function showError(message) {
  el.errorText.textContent = message;
  el.errorBanner.hidden = false;
}

function clearError() {
  el.errorBanner.hidden = true;
  el.errorText.textContent = '';
}

el.dismissErrorBtn.addEventListener('click', clearError);

// --- File Loading ---
async function handleFile(file) {
  if (!file) return;
  clearError();

  el.dropzone.hidden = true;
  el.workspace.hidden = true;
  el.loadingCard.hidden = false;
  el.loadingText.textContent = `Decoding audio from "${file.name}"...`;

  try {
    const buffer = await engine.decodeFile(file);
    state.fileName = file.name;
    state.fileStem = file.name.replace(/\.[^.]+$/, '') || 'audio';
    state.clips = [];
    state.nextClipNumber = 1;
    state.loopSelection = false;

    el.fileNameBadge.textContent = file.name;
    el.fileNameBadge.title = file.name;
    el.topbarActions.hidden = false;
    el.totalDurationReadout.textContent = formatTime(buffer.duration);
    el.zoomSlider.value = '1';

    el.loadingCard.hidden = true;
    el.workspace.hidden = false;

    waveform.setBuffer(buffer);
    waveform.setSavedRegions([]);
    setSelection(0, Math.min(buffer.duration, Math.max(1, buffer.duration * 0.2)), true);
    updatePlayheadUI(0);
    updateTransportUI();
    renderClipsList();
  } catch (err) {
    el.loadingCard.hidden = true;
    if (engine.buffer) {
      el.workspace.hidden = false;
    } else {
      el.dropzone.hidden = false;
    }
    showError(err.message || 'Failed to decode this file.');
  }
}

el.browseBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  el.fileInput.click();
});

el.dropzone.addEventListener('click', () => el.fileInput.click());
el.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    el.fileInput.click();
  }
});

el.changeFileBtn.addEventListener('click', () => el.fileInput.click());

el.fileInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) handleFile(file);
  el.fileInput.value = '';
});

// Drag & drop on dropzone and whole window
['dragenter', 'dragover'].forEach((evt) => {
  window.addEventListener(evt, (e) => {
    e.preventDefault();
    el.dropzone.classList.add('drag-over');
  });
});

['dragleave', 'drop'].forEach((evt) => {
  window.addEventListener(evt, (e) => {
    e.preventDefault();
    el.dropzone.classList.remove('drag-over');
  });
});

window.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

// --- Selection Management ---
function setSelection(start, end, syncWaveform = true) {
  const dur = engine.duration;
  if (!dur) return;

  let s = Math.max(0, Math.min(dur, start));
  let e = Math.max(0, Math.min(dur, end));
  if (e < s) [s, e] = [e, s];
  if (e - s < 0.05) {
    e = Math.min(dur, s + 0.05);
    if (e - s < 0.05) s = Math.max(0, e - 0.05);
  }

  state.selStart = s;
  state.selEnd = e;

  if (document.activeElement !== el.startInput) {
    el.startInput.value = formatTime(s);
  }
  if (document.activeElement !== el.endInput) {
    el.endInput.value = formatTime(e);
  }
  el.selectionDurationReadout.textContent = formatTime(e - s);

  if (syncWaveform) {
    waveform.setSelection(s, e);
  }

  engine.updateLoopBounds(s, e);
}

el.startInput.addEventListener('change', () => {
  const parsed = parseTime(el.startInput.value);
  if (parsed !== null) {
    setSelection(parsed, Math.max(parsed + 0.05, state.selEnd), true);
  } else {
    el.startInput.value = formatTime(state.selStart);
  }
});

el.endInput.addEventListener('change', () => {
  const parsed = parseTime(el.endInput.value);
  if (parsed !== null) {
    setSelection(Math.min(state.selStart, parsed - 0.05), parsed, true);
  } else {
    el.endInput.value = formatTime(state.selEnd);
  }
});

document.querySelectorAll('.nudge-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.target;
    const delta = parseFloat(btn.dataset.delta);
    if (target === 'start') {
      const nextStart = Math.max(0, Math.min(state.selEnd - 0.05, state.selStart + delta));
      setSelection(nextStart, state.selEnd, true);
    } else {
      const nextEnd = Math.min(engine.duration, Math.max(state.selStart + 0.05, state.selEnd + delta));
      setSelection(state.selStart, nextEnd, true);
    }
  });
});

function setInAtPlayhead() {
  if (!engine.buffer) return;
  const now = engine.getCurrentTime();
  const nextEnd = now >= state.selEnd - 0.05 ? Math.min(engine.duration, now + 1) : state.selEnd;
  setSelection(now, nextEnd, true);
}

function setOutAtPlayhead() {
  if (!engine.buffer) return;
  const now = engine.getCurrentTime();
  const nextStart = now <= state.selStart + 0.05 ? Math.max(0, now - 1) : state.selStart;
  setSelection(nextStart, now, true);
}

el.setInBtn.addEventListener('click', setInAtPlayhead);
el.setOutBtn.addEventListener('click', setOutAtPlayhead);

// --- Transport Controls ---
function togglePlayPause() {
  if (!engine.buffer) return;
  if (engine.isPlaying) {
    engine.pause();
  } else if (state.loopSelection) {
    engine.play({ start: state.selStart, end: state.selEnd, loop: true });
  } else {
    const startAt = engine.currentTime >= engine.duration - 0.05 ? 0 : engine.currentTime;
    engine.play({ start: startAt, end: engine.duration, loop: false });
  }
}

function playSelection() {
  if (!engine.buffer) return;
  engine.play({
    start: state.selStart,
    end: state.selEnd,
    loop: state.loopSelection,
  });
}

function toggleLoop() {
  state.loopSelection = !state.loopSelection;
  if (engine.isPlaying && !engine.previewClipId) {
    if (state.loopSelection) {
      engine.play({ start: state.selStart, end: state.selEnd, loop: true });
    } else {
      const now = engine.getCurrentTime();
      engine.play({ start: now, end: engine.duration, loop: false });
    }
  }
  updateTransportUI();
}

function updateTransportUI() {
  const playingMain = engine.isPlaying && !engine.previewClipId;
  el.playPauseIcon.textContent = playingMain ? '❚❚' : '▶';
  el.playPauseLabel.textContent = playingMain ? 'Pause' : 'Play';

  el.loopToggleBtn.setAttribute('aria-pressed', String(state.loopSelection));
  el.loopToggleBtn.textContent = state.loopSelection ? '↻ Loop: On' : '↻ Loop: Off';
}

el.playPauseBtn.addEventListener('click', togglePlayPause);
el.playSelectionBtn.addEventListener('click', playSelection);
el.loopToggleBtn.addEventListener('click', toggleLoop);

document.querySelectorAll('.speed-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const rate = parseFloat(btn.dataset.rate);
    engine.setPlaybackRate(rate);
    document.querySelectorAll('.speed-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// --- Zoom Controls ---
function applyZoom(nextZoom) {
  const clamped = Math.max(1, Math.min(40, nextZoom));
  el.zoomSlider.value = String(clamped);
  waveform.setZoom(clamped, engine.getCurrentTime());
}

el.zoomSlider.addEventListener('input', () => applyZoom(parseFloat(el.zoomSlider.value)));
el.zoomOutBtn.addEventListener('click', () => applyZoom(waveform.zoom / 1.5));
el.zoomInBtn.addEventListener('click', () => applyZoom(waveform.zoom * 1.5));
el.zoomFitBtn.addEventListener('click', () => applyZoom(1));

// --- Saved Clips Queue ---
function saveCurrentClip() {
  if (!engine.buffer) return;
  if (state.selEnd - state.selStart < 0.05) return;

  const num = String(state.nextClipNumber++).padStart(2, '0');
  const clip = {
    id: crypto.randomUUID ? crypto.randomUUID() : `clip-${Date.now()}-${num}`,
    name: `clip-${num}`,
    start: state.selStart,
    end: state.selEnd,
  };

  state.clips.push(clip);
  waveform.setSavedRegions(state.clips);
  renderClipsList();

  // Brief confirmation on button
  const orig = el.saveClipBtn.textContent;
  el.saveClipBtn.textContent = '✓ Saved';
  setTimeout(() => {
    el.saveClipBtn.textContent = orig;
  }, 650);
}

el.saveClipBtn.addEventListener('click', saveCurrentClip);

function renderClipsList() {
  el.clipCountBadge.textContent = String(state.clips.length);
  el.clipsEmpty.hidden = state.clips.length > 0;
  el.downloadAllBtn.disabled = state.clips.length === 0 || state.isZipping;

  el.clipsList.innerHTML = '';

  for (const clip of state.clips) {
    const isPreviewing = engine.isPlaying && engine.previewClipId === clip.id;
    const li = document.createElement('li');
    li.className = `clip-item${isPreviewing ? ' playing' : ''}`;

    // Preview play/stop button
    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'clip-play-btn';
    playBtn.title = isPreviewing ? 'Stop preview' : 'Preview clip';
    playBtn.textContent = isPreviewing ? '■' : '▶';
    playBtn.addEventListener('click', () => {
      if (isPreviewing) {
        engine.stop();
      } else {
        engine.play({
          start: clip.start,
          end: clip.end,
          loop: false,
          previewClipId: clip.id,
        });
      }
    });

    // Editable clip name
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'clip-name-input';
    nameInput.value = clip.name;
    nameInput.setAttribute('aria-label', 'Clip name');
    nameInput.addEventListener('input', () => {
      clip.name = nameInput.value;
    });

    // Timestamps & duration
    const meta = document.createElement('div');
    meta.className = 'clip-meta mono';
    const dur = clip.end - clip.start;
    meta.innerHTML = `${formatTime(clip.start)} – ${formatTime(clip.end)}<strong>${formatTime(dur)}</strong>`;

    // Actions
    const actions = document.createElement('div');
    actions.className = 'clip-actions';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-ghost btn-xs';
    editBtn.textContent = 'Select';
    editBtn.title = 'Load this clip range back onto the waveform';
    editBtn.addEventListener('click', () => {
      setSelection(clip.start, clip.end, true);
      engine.seek(clip.start);
      updatePlayheadUI(clip.start);
    });

    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'btn btn-secondary btn-xs';
    dlBtn.textContent = `Download .${state.exportFormat}`;
    dlBtn.addEventListener('click', () => {
      try {
        const { blob, filename } = buildClipBlob(engine.buffer, clip, {
          format: state.exportFormat,
          fade: state.applyFade,
        });
        triggerDownload(blob, filename);
      } catch (err) {
        showError(`Export failed: ${err.message}`);
      }
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-danger-ghost btn-xs';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => {
      if (engine.previewClipId === clip.id) {
        engine.stop();
      }
      state.clips = state.clips.filter((c) => c.id !== clip.id);
      waveform.setSavedRegions(state.clips);
      renderClipsList();
    });

    actions.append(editBtn, dlBtn, delBtn);
    li.append(playBtn, nameInput, meta, actions);
    el.clipsList.appendChild(li);
  }
}

// Export format & fade controls
document.querySelectorAll('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.exportFormat = btn.dataset.format;
    document.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    renderClipsList();
  });
});

el.fadeCheckbox.addEventListener('change', () => {
  state.applyFade = el.fadeCheckbox.checked;
});

el.downloadAllBtn.addEventListener('click', async () => {
  if (!engine.buffer || state.clips.length === 0 || state.isZipping) return;
  state.isZipping = true;
  el.downloadAllBtn.disabled = true;
  const origLabel = el.downloadAllBtn.textContent;

  try {
    await downloadClipsAsZip(
      engine.buffer,
      state.clips,
      state.fileStem,
      { format: state.exportFormat, fade: state.applyFade },
      (done, total) => {
        el.downloadAllBtn.textContent = `Exporting ${done}/${total}...`;
      }
    );
  } catch (err) {
    showError(`Batch export failed: ${err.message}`);
  } finally {
    state.isZipping = false;
    el.downloadAllBtn.textContent = origLabel;
    el.downloadAllBtn.disabled = state.clips.length === 0;
  }
});

// --- Keyboard Shortcuts ---
window.addEventListener('keydown', (e) => {
  if (!engine.buffer) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.code === 'Space') {
    e.preventDefault();
    togglePlayPause();
  } else if (e.key === 'l' || e.key === 'L') {
    e.preventDefault();
    toggleLoop();
  } else if (e.key === 'i' || e.key === 'I') {
    e.preventDefault();
    setInAtPlayhead();
  } else if (e.key === 'o' || e.key === 'O') {
    e.preventDefault();
    setOutAtPlayhead();
  } else if (e.key === 's' || e.key === 'S') {
    e.preventDefault();
    saveCurrentClip();
  }
});

// --- Animation Loop for Playhead ---
function updatePlayheadUI(timeSec) {
  el.playheadReadout.textContent = formatTime(timeSec);
  waveform.setPlayhead(timeSec);
}

function tick() {
  if (engine.isPlaying && engine.buffer) {
    const now = engine.getCurrentTime();
    updatePlayheadUI(now);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
