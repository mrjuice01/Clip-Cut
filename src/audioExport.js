import JSZip from 'jszip';
import { Mp3Encoder } from '@breezystack/lamejs';

const FADE_DURATION_SEC = 0.01; // 10ms anti-click fade

/**
 * Slices a region out of an AudioBuffer and optionally applies a short fade-in/out.
 */
export function sliceAudioBuffer(buffer, startSec, endSec, applyFade = true) {
  const sampleRate = buffer.sampleRate;
  const numChannels = buffer.numberOfChannels;
  const totalSamples = buffer.length;

  const startSample = Math.max(0, Math.min(totalSamples - 1, Math.floor(startSec * sampleRate)));
  const endSample = Math.max(startSample + 1, Math.min(totalSamples, Math.ceil(endSec * sampleRate)));
  const frameCount = endSample - startSample;

  const channels = [];
  const fadeSamples = applyFade
    ? Math.min(Math.floor(FADE_DURATION_SEC * sampleRate), Math.floor(frameCount / 2))
    : 0;

  for (let ch = 0; ch < numChannels; ch++) {
    const sourceData = buffer.getChannelData(ch);
    const sliced = new Float32Array(frameCount);
    sliced.set(sourceData.subarray(startSample, endSample));

    if (fadeSamples > 0) {
      for (let i = 0; i < fadeSamples; i++) {
        const gainIn = i / fadeSamples;
        sliced[i] *= gainIn;
        const gainOut = (fadeSamples - 1 - i) / fadeSamples;
        sliced[frameCount - fadeSamples + i] *= gainOut;
      }
    }

    channels.push(sliced);
  }

  return {
    sampleRate,
    numberOfChannels: numChannels,
    length: frameCount,
    channels,
  };
}

/**
 * Encodes sliced audio data as a 16-bit PCM WAV Blob.
 */
export function encodeWav(sliced) {
  const { sampleRate, numberOfChannels, length, channels } = sliced;
  const bytesPerSample = 2;
  const blockAlign = numberOfChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, int16, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Encodes sliced audio data as an MP3 Blob using lamejs.
 */
export function encodeMp3(sliced, kbps = 192) {
  const { sampleRate, numberOfChannels, length, channels } = sliced;
  const outChannels = numberOfChannels >= 2 ? 2 : 1;
  const encoder = new Mp3Encoder(outChannels, sampleRate, kbps);

  const left = floatToInt16(channels[0]);
  const right = outChannels === 2 ? floatToInt16(channels[1]) : null;

  const blockSize = 1152;
  const mp3Chunks = [];

  for (let i = 0; i < length; i += blockSize) {
    const leftChunk = left.subarray(i, i + blockSize);
    const mp3buf =
      outChannels === 2
        ? encoder.encodeBuffer(leftChunk, right.subarray(i, i + blockSize))
        : encoder.encodeBuffer(leftChunk);

    if (mp3buf.length > 0) {
      mp3Chunks.push(new Uint8Array(mp3buf));
    }
  }

  const endBuf = encoder.flush();
  if (endBuf.length > 0) {
    mp3Chunks.push(new Uint8Array(endBuf));
  }

  return new Blob(mp3Chunks, { type: 'audio/mpeg' });
}

function floatToInt16(float32) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

export function sanitizeFilename(name) {
  const cleaned = (name || 'clip')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ');
  return cleaned || 'clip';
}

export function buildClipBlob(audioBuffer, clip, { format = 'wav', fade = true } = {}) {
  const sliced = sliceAudioBuffer(audioBuffer, clip.start, clip.end, fade);
  const ext = format === 'mp3' ? 'mp3' : 'wav';
  const blob = format === 'mp3' ? encodeMp3(sliced) : encodeWav(sliced);
  const filename = `${sanitizeFilename(clip.name)}.${ext}`;
  return { blob, filename };
}

export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadClipsAsZip(audioBuffer, clips, baseName, options, onProgress) {
  const zip = new JSZip();
  const usedNames = new Map();

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const { blob, filename } = buildClipBlob(audioBuffer, clip, options);

    // Ensure unique filenames inside the zip
    let finalName = filename;
    const count = usedNames.get(filename.toLowerCase()) || 0;
    if (count > 0) {
      const dot = filename.lastIndexOf('.');
      const stem = dot > 0 ? filename.slice(0, dot) : filename;
      const ext = dot > 0 ? filename.slice(dot) : '';
      finalName = `${stem}-${count + 1}${ext}`;
    }
    usedNames.set(filename.toLowerCase(), count + 1);

    zip.file(finalName, blob);
    if (onProgress) onProgress(i + 1, clips.length);
    // Yield briefly so UI remains responsive on large batches
    await new Promise((r) => setTimeout(r, 0));
  }

  const zipBlob = await zip.generateAsync({ type: 'blob' });
  const zipName = `${sanitizeFilename(baseName || 'audio-clips')}-clips.zip`;
  triggerDownload(zipBlob, zipName);
}
