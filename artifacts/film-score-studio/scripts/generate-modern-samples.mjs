/**
 * Generate the original modern-suite PCM WAV sources used by the browser
 * sampler. This is intentionally a tiny offline renderer, not a runtime
 * synthesizer: the application ships and plays the resulting WAV files.
 *
 * Run from artifacts/film-score-studio:
 *   node scripts/generate-modern-samples.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sampleRate = 22050;
const outputDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets', 'audio');

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const midiFrequency = (midi) => 440 * 2 ** ((midi - 69) / 12);

function createNoise(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return (state / 0x100000000) * 2 - 1;
  };
}

function writePcmWav(name, samples) {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // PCM format chunk
  buffer.writeUInt16LE(1, 20); // linear PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  samples.forEach((sample, index) => buffer.writeInt16LE(Math.round(clamp(sample, -1, 1) * 32767), 44 + index * 2));
  writeFileSync(join(outputDirectory, name), buffer);
}

function envelope(time, duration, attack, release, sustain = 1) {
  if (time < attack) return time / attack;
  if (time > duration - release) return Math.max(0, (duration - time) / release);
  return sustain;
}

function periodicVoice({ duration, rootMidi, voice, seed }) {
  const random = createNoise(seed);
  const length = Math.floor(duration * sampleRate);
  const fundamental = midiFrequency(rootMidi);
  const samples = new Float32Array(length);
  let previousNoise = 0;
  for (let index = 0; index < length; index += 1) {
    const time = index / sampleRate;
    const phase = fundamental * time;
    const e = envelope(time, duration, voice.attack, voice.release, voice.sustain ?? 1);
    const vibrato = voice.vibrato
      ? Math.sin(2 * Math.PI * voice.vibrato.rate * time) * voice.vibrato.depth
      : 0;
    const frequencyScale = 1 + vibrato;
    const harmonic = (multiple, weight) => Math.sin(2 * Math.PI * phase * multiple * frequencyScale) * weight;
    let value = 0;

    if (voice.kind === 'bass') {
      value = harmonic(1, 0.78) + harmonic(2, 0.32) + harmonic(3, 0.18) + harmonic(5, 0.08);
      value += Math.tanh(harmonic(1, 1.6)) * 0.2;
    } else if (voice.kind === 'lead') {
      const saw = ((phase % 1) * 2) - 1;
      value = saw * 0.62 + harmonic(2, 0.25) + harmonic(3, 0.12) + harmonic(7, 0.06);
      value += harmonic(1, 0.18) * Math.sin(2 * Math.PI * 5 * time);
    } else if (voice.kind === 'pad') {
      value = harmonic(1, 0.44) + harmonic(2, 0.21) + harmonic(3, 0.12) + harmonic(5, 0.08);
      value += Math.sin(2 * Math.PI * (fundamental * 1.003) * time) * 0.2;
      value += Math.sin(2 * Math.PI * (fundamental * 0.997) * time) * 0.2;
    } else if (voice.kind === 'pluck') {
      value = harmonic(1, 0.72) + harmonic(2, 0.3) + harmonic(4, 0.18) + harmonic(8, 0.07);
      value *= Math.exp(-time * 4.8);
    } else if (voice.kind === 'keys') {
      // Bell-like electric-key partials with a short mechanical attack.
      value = harmonic(1, 0.63) + harmonic(2, 0.32) + harmonic(3, 0.18) + harmonic(5, 0.11);
      value += harmonic(7, 0.08) * Math.exp(-time * 2.2);
      value *= 0.8 + 0.2 * Math.exp(-time * 16);
    } else if (voice.kind === 'guitar') {
      value = harmonic(1, 0.65) + harmonic(2, 0.23) + harmonic(3, 0.13) + harmonic(6, 0.06);
      value += random() * 0.018 * Math.exp(-time * 28);
      value *= Math.exp(-time * 1.3);
    } else if (voice.kind === 'noise-tone') {
      // A small tonal body and deterministic noise tail for a compact kit hit.
      const noisy = random() * 0.7;
      const highPassed = noisy - previousNoise * 0.92;
      previousNoise = noisy;
      value = harmonic(1, 0.4) + highPassed * 0.68;
    } else if (voice.kind === 'kick') {
      const fallingPitch = fundamental * (1 + Math.exp(-time * 24) * 1.7);
      value = Math.sin(2 * Math.PI * fallingPitch * time) * Math.exp(-time * 8.5);
    } else if (voice.kind === 'hat') {
      const noisy = random();
      const highPassed = noisy - previousNoise * 0.96;
      previousNoise = noisy;
      value = highPassed * Math.exp(-time * 26);
    }
    samples[index] = value * e * (voice.level ?? 0.7);
  }
  return samples;
}

const samples = [
  ['modern-electronic-bass.wav', periodicVoice({
    duration: 2.1, rootMidi: 36, seed: 11,
    voice: { kind: 'bass', attack: 0.008, release: 0.42, sustain: 0.72, level: 0.75 },
  })],
  ['modern-electronic-lead.wav', periodicVoice({
    duration: 1.8, rootMidi: 60, seed: 17,
    voice: { kind: 'lead', attack: 0.012, release: 0.22, sustain: 0.65, level: 0.62, vibrato: { rate: 5.4, depth: 0.006 } },
  })],
  ['modern-atmospheric-pad.wav', periodicVoice({
    duration: 4.4, rootMidi: 60, seed: 23,
    voice: { kind: 'pad', attack: 0.72, release: 1.4, sustain: 0.7, level: 0.68, vibrato: { rate: 0.22, depth: 0.003 } },
  })],
  ['modern-digital-pluck.wav', periodicVoice({
    duration: 1.25, rootMidi: 72, seed: 29,
    voice: { kind: 'pluck', attack: 0.002, release: 0.3, sustain: 0.5, level: 0.72 },
  })],
  ['modern-electric-keys.wav', periodicVoice({
    duration: 2.2, rootMidi: 60, seed: 31,
    voice: { kind: 'keys', attack: 0.004, release: 0.7, sustain: 0.62, level: 0.7 },
  })],
  ['modern-electric-bass.wav', periodicVoice({
    duration: 2, rootMidi: 36, seed: 37,
    voice: { kind: 'bass', attack: 0.006, release: 0.55, sustain: 0.66, level: 0.68 },
  })],
  ['modern-tape-guitar.wav', periodicVoice({
    duration: 2.3, rootMidi: 60, seed: 41,
    voice: { kind: 'guitar', attack: 0.006, release: 0.78, sustain: 0.56, level: 0.64 },
  })],
  ['modern-drum-kit.wav', periodicVoice({
    duration: 1.05, rootMidi: 36, seed: 43,
    voice: { kind: 'noise-tone', attack: 0.001, release: 0.96, sustain: 0.8, level: 0.68 },
  })],
  ['modern-kick.wav', periodicVoice({
    duration: 0.9, rootMidi: 36, seed: 47,
    voice: { kind: 'kick', attack: 0.001, release: 0.85, sustain: 1, level: 0.82 },
  })],
  ['modern-snare.wav', periodicVoice({
    duration: 0.62, rootMidi: 38, seed: 53,
    voice: { kind: 'noise-tone', attack: 0.001, release: 0.58, sustain: 0.7, level: 0.76 },
  })],
  ['modern-hats.wav', periodicVoice({
    duration: 0.34, rootMidi: 42, seed: 59,
    voice: { kind: 'hat', attack: 0.001, release: 0.32, sustain: 1, level: 0.54 },
  })],
];

mkdirSync(outputDirectory, { recursive: true });
for (const [name, samplesForFile] of samples) writePcmWav(name, samplesForFile);
console.log(`Generated ${samples.length} original mono PCM WAV samples in ${outputDirectory}`);