import { useState } from 'react';
import { AlertTriangle, Check, Plus, Trash2 } from 'lucide-react';
import type { ScoreTrack } from '@workspace/api-client-react';
import { findInstrument } from '@/lib/instrument-catalog';

export type TrackCatalogEntry = {
  id: string;
  name: string;
  role: string;
  midiProgram: number;
  suite?: string;
};

type TrackControlsProps = {
  tracks: ScoreTrack[];
  catalog: readonly TrackCatalogEntry[];
  onReplaceTrack: (trackId: string, instrumentId: string) => void;
};

export function TrackControls({ tracks, catalog, onReplaceTrack }: TrackControlsProps) {
  const [replacementByTrack, setReplacementByTrack] = useState<Record<string, string>>({});

  const unsupportedTracks = tracks.filter((track) => !findInstrument(track.instrument));

  if (unsupportedTracks.length === 0) return null;

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
      <div className="mb-2 text-[9px] font-bold uppercase tracking-widest text-amber-200">Unsupported Tracks</div>
      <div className="space-y-1.5">
        {unsupportedTracks.map((track) => {
          const replacement = replacementByTrack[track.id] ?? catalog[0]?.id ?? '';
          return (
            <div key={track.id} className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-black/20 px-2 py-1.5">
              <span className="min-w-0 truncate text-[10px] text-amber-200">{track.instrument}</span>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="flex items-center gap-1 text-[9px] leading-tight text-amber-200/90">
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  Notes are preserved.
                </span>
                <select
                  value={replacement}
                  onChange={(event) => setReplacementByTrack((current) => ({ ...current, [track.id]: event.target.value }))}
                  aria-label={`Replacement instrument for ${track.instrument}`}
                  className="min-w-0 flex-1 rounded border border-amber-500/30 bg-background px-1.5 py-1 text-[10px] text-foreground"
                >
                  {catalog.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                </select>
                <button
                  type="button"
                  onClick={() => onReplaceTrack(track.id, replacement)}
                  className="flex items-center gap-1 rounded border border-emerald-500/40 px-1.5 py-1 text-[9px] font-bold text-emerald-300 hover:bg-emerald-500/10"
                >
                  <Check className="h-3 w-3" /> Replace
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}