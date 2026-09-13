import type { Score } from '@workspace/api-client-react';

export type ScheduledScoreNote = {
  trackId: string;
  pitch: number;
  velocity: number;
  role: Score['tracks'][number]['role'];
  instrument: Score['tracks'][number]['instrument'];
  midiProgram: Score['tracks'][number]['midiProgram'];
  dynamics: Score['tracks'][number]['regions'][number]['dynamics'];
  articulation: Score['tracks'][number]['regions'][number]['articulation'];
  startSeconds: number;
  durationSeconds: number;
};

export function getScoreSchedule(score: Score, fromBeat = 0): ScheduledScoreNote[] {
  const secondsPerBeat = 60 / score.tempo;
  return score.tracks.flatMap(track => track.regions.flatMap(region =>
    region.notes.flatMap(note => {
      const absoluteBeat = region.startBeat + note.startBeat;
      const absoluteEndBeat = absoluteBeat + note.durationBeats;
      if (absoluteEndBeat <= fromBeat) return [];
      const audibleStartBeat = Math.max(absoluteBeat, fromBeat);
      return [{
        trackId: track.id,
        pitch: note.pitch,
        velocity: note.velocity,
        role: track.role,
        instrument: track.instrument,
        midiProgram: track.midiProgram,
        dynamics: region.dynamics,
        articulation: note.articulation,
        startSeconds: (audibleStartBeat - fromBeat) * secondsPerBeat,
        durationSeconds: Math.max(0.04, (absoluteEndBeat - audibleStartBeat) * secondsPerBeat),
      }];
    }),
  ));
}