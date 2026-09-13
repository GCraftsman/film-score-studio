import type { MidiSnippet, MidiNote } from '@workspace/api-client-react';

export function analyzeAudioPitch(audioData: Float32Array, sampleRate: number): { snippet?: MidiSnippet, description: string } {
    const blockSize = 2048;
    const stepSize = 1024;

    const notes: MidiNote[] = [];
    let currentNote: { pitch: number, start: number, frames: number } | null = null;
    let framesWithPitch = 0;

    for (let i = 0; i < audioData.length - blockSize; i += stepSize) {
        const block = audioData.subarray(i, i + blockSize);
        let maxAcf = 0;
        let maxLag = -1;
        const minLag = Math.floor(sampleRate / 1000);
        const maxSearchLag = Math.floor(sampleRate / 60);

        let energy = 0;
        for (let j = 0; j < blockSize; j++) {
            energy += block[j] * block[j];
        }

        if (energy < 0.01) {
            if (currentNote) {
                notes.push({
                   note: currentNote.pitch,
                   velocity: 80,
                   startMs: (currentNote.start * stepSize / sampleRate) * 1000,
                   durationMs: (currentNote.frames * stepSize / sampleRate) * 1000
                });
                currentNote = null;
            }
            continue;
        }

        for (let lag = minLag; lag <= maxSearchLag; lag++) {
            let sum = 0;
            for (let j = 0; j < blockSize - lag; j++) {
                sum += block[j] * block[j + lag];
            }
            if (sum > maxAcf) {
                maxAcf = sum;
                maxLag = lag;
            }
        }

        const confidence = energy > 0 ? maxAcf / energy : 0;

        if (confidence > 0.45 && maxLag > 0) {
            framesWithPitch++;
            const freq = sampleRate / maxLag;
            const pitch = Math.round(69 + 12 * Math.log2(freq / 440));

            if (currentNote) {
                if (currentNote.pitch === pitch) {
                    currentNote.frames++;
                } else {
                    notes.push({
                       note: currentNote.pitch,
                       velocity: 80,
                       startMs: (currentNote.start * stepSize / sampleRate) * 1000,
                       durationMs: (currentNote.frames * stepSize / sampleRate) * 1000
                    });
                    currentNote = { pitch, start: Math.floor(i / stepSize), frames: 1 };
                }
            } else {
                currentNote = { pitch, start: Math.floor(i / stepSize), frames: 1 };
            }
        } else {
            if (currentNote) {
                notes.push({
                   note: currentNote.pitch,
                   velocity: 80,
                   startMs: (currentNote.start * stepSize / sampleRate) * 1000,
                   durationMs: (currentNote.frames * stepSize / sampleRate) * 1000
                });
                currentNote = null;
            }
        }
    }

    if (currentNote) {
        notes.push({
           note: currentNote.pitch,
           velocity: 80,
           startMs: (currentNote.start * stepSize / sampleRate) * 1000,
           durationMs: (currentNote.frames * stepSize / sampleRate) * 1000
        });
    }

    const filteredNotes = notes.filter(n => n.durationMs >= 50);
    const durationMs = (audioData.length / sampleRate) * 1000;

    if (filteredNotes.length === 0 || framesWithPitch < 5) {
        return { description: "Analysis was inconclusive. No clear pitches detected." };
    }

    const confidenceScore = framesWithPitch / (audioData.length / stepSize);
    let desc = "";
    if (confidenceScore > 0.3) {
        desc = `Detected ${filteredNotes.length} clear notes from audio input.`;
    } else {
        desc = `Detected ${filteredNotes.length} notes, but confidence is low.`;
    }

    return {
        snippet: {
            id: 'derived-' + Date.now(),
            tempo: 120,
            durationMs: Math.max(1, Math.round(durationMs)),
            notes: filteredNotes.map(n => ({...n, startMs: Math.round(n.startMs), durationMs: Math.max(1, Math.round(n.durationMs))}))
        },
        description: desc
    };
}
