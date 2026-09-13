import assert from 'node:assert/strict';
import test from 'node:test';
import type { Score } from '@workspace/api-client-react';
import { getScoreSchedule } from './score-scheduling.ts';

const score: Score = {
  tempo: 120,
  durationBeats: 16,
  tracks: [{
    id: 'track', name: 'Track', role: 'strings', instrument: 'Strings', midiProgram: 48,
    regions: [{
      id: 'region', name: 'Region', startBeat: 2, durationBeats: 8, dynamics: 'mf', articulation: 'sustain',
      notes: [{ pitch: 60, velocity: 80, startBeat: 1, durationBeats: 4, articulation: 'sustain' }],
    }],
  }],
};

test('schedules playback from the beginning at the absolute note time', () => {
  assert.deepEqual(getScoreSchedule(score, 0).map(({ startSeconds, durationSeconds }) => ({ startSeconds, durationSeconds })), [
    { startSeconds: 1.5, durationSeconds: 2 },
  ]);
});

test('seeking into a sustained note starts immediately and trims elapsed duration', () => {
  assert.deepEqual(getScoreSchedule(score, 5).map(({ startSeconds, durationSeconds }) => ({ startSeconds, durationSeconds })), [
    { startSeconds: 0, durationSeconds: 1 },
  ]);
});

test('preserves track instrument identity for deterministic sample routing', () => {
  const [scheduled] = getScoreSchedule(score, 0);
  assert.equal(scheduled.trackId, 'track');
  assert.equal(scheduled.instrument, 'Strings');
  assert.equal(scheduled.midiProgram, 48);
  assert.equal(scheduled.articulation, 'sustain');
});