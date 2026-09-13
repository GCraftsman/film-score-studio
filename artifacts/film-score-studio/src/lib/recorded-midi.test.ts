import assert from 'node:assert/strict';
import test from 'node:test';
import type { MidiNote, MidiSnippet } from '@workspace/api-client-react';
import { snapshotRecordedMidi } from './recorded-midi.ts';

test('deferred chat update retains notes after recording buffers are cleared', () => {
  const buffer = { current: [
    { note: 60, velocity: 91, startMs: 100.4, durationMs: 250.7 },
    { note: 64, velocity: 73, startMs: 170.6, durationMs: 800.2 },
  ] as MidiNote[] };
  const snippet = snapshotRecordedMidi('take-1', 96, 1000.3, buffer.current);
  const queuedUpdate = (previous: MidiSnippet[]) => [...previous, snippet];

  // Simulate both buffer reuse and ref reset before React runs the updater.
  buffer.current[0].note = 72;
  buffer.current.length = 0;
  buffer.current = [];
  const [attached] = queuedUpdate([]);
  assert.equal(attached.tempo, 96);
  assert.equal(attached.durationMs, 1000);
  assert.deepEqual(attached.notes, [
    { note: 60, velocity: 91, startMs: 100, durationMs: 251 },
    { note: 64, velocity: 73, startMs: 171, durationMs: 800 },
  ]);
  assert.deepEqual(queuedUpdate([]), queuedUpdate([]), 'React updater replay is stable');
});

test('separate takes preserve repeated pitches, order, and minimum note duration', () => {
  const notes = [
    { note: 60, velocity: 50, startMs: 0, durationMs: 0.1 },
    { note: 60, velocity: 100, startMs: 300, durationMs: 200 },
  ];
  const first = snapshotRecordedMidi('first', 120, 500, notes);
  notes.push({ note: 67, velocity: 80, startMs: 500, durationMs: 100 });
  const second = snapshotRecordedMidi('second', 120, 600, notes);
  assert.equal(first.notes.length, 2);
  assert.equal(second.notes.length, 3);
  assert.equal(first.notes[0].durationMs, 1);
  assert.deepEqual(first.notes.map(({ note, velocity }) => [note, velocity]), [[60, 50], [60, 100]]);
});