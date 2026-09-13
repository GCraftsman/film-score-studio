import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudioPitch } from './pitch-analysis.ts';

function generateSineWave(freq: number, sampleRate: number, durationSec: number) {
    const length = Math.floor(sampleRate * durationSec);
    const data = new Float32Array(length);
    for (let i = 0; i < length; i++) {
        data[i] = Math.sin(2 * Math.PI * freq * i / sampleRate);
    }
    return data;
}

describe('pitch-analysis', () => {
    it('detects a clear sine wave pitch', () => {
        const audio = generateSineWave(440, 44100, 1.0);
        const result = analyzeAudioPitch(audio, 44100);

        assert.ok(result.snippet);
        assert.ok(result.snippet.notes.length > 0);
        assert.equal(result.snippet.notes[0].note, 69);
        assert.ok(result.description.includes('clear notes'));
    });

    it('returns inconclusive for silence', () => {
        const audio = new Float32Array(44100);
        const result = analyzeAudioPitch(audio, 44100);

        assert.ok(result.description.includes('inconclusive'));
    });
});
