import type { MidiNote, MidiSnippet } from '@workspace/api-client-react';

/** Capture a take before its mutable recording buffers are reset. */
export function snapshotRecordedMidi(
  id: string,
  tempo: number,
  durationMs: number,
  notes: readonly MidiNote[],
): MidiSnippet {
  return {
    id,
    tempo,
    durationMs: Math.max(1, Math.round(durationMs)),
    notes: notes.map((note) => ({
      ...note,
      startMs: Math.round(note.startMs),
      durationMs: Math.max(1, Math.round(note.durationMs)),
    })),
  };
}