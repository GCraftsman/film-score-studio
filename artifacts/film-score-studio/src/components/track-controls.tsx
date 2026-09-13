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
  onAddTrack: (track: ScoreTrack) => void;
  onDeleteTrack: (trackId: string) => void;
  onReplaceTrack: (trackId: string, instrumentId: string) => void;
};

export function TrackControls({ tracks, catalog, onAddTrack, onDeleteTrack, onReplaceTrack }: TrackControlsProps) {
  const [selectedInstrument, setSelectedInstrument] = useState(catalog[0]?.id ?? '');
  const [deleteConfirmation, setDeleteConfirmation] = useState<string | null>(null);
  const [replacementByTrack, setReplacementByTrack] = useState<Record<string, string>>({});

  const add = () => {
    const entry = catalog.find((item) => item.id === selectedInstrument);
    if (!entry || tracks.some((track) => findInstrument(track.instrument)?.id === entry.id)) return;
    onAddTrack({
      id: `manual-${entry.id}-${Date.now()}`,
      name: entry.name,
      role: entry.role,
      instrument: entry.name,
      midiProgram: entry.midiProgram,
      regions: [],
    });
  };

  const remove = (track: ScoreTrack) => {
    const hasMusic = track.regions.some((region) => region.notes.length > 0);
    if (!hasMusic) {
      onDeleteTrack(track.id);
      return;
    }
    if (deleteConfirmation === track.id) {
      setDeleteConfirmation(null);
      onDeleteTrack(track.id);
      return;
    }
    setDeleteConfirmation(track.id);
  };

  return (
    <div className="rounded-lg border border-border bg-black/20 p-3">
      <div className="mb-2 text-[9px] font-bold uppercase tracking-widest text-muted-foreground">Track controls</div>
      <div className="flex gap-2">
        <select
          value={selectedInstrument}
          onChange={(event) => setSelectedInstrument(event.target.value)}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-[11px] text-foreground"
          aria-label="Instrument to add"
        >
          {catalog.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
        <button type="button" onClick={add} className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-[10px] font-bold text-primary-foreground">
          <Plus className="h-3 w-3" /> Add
        </button>
      </div>
      {tracks.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {tracks.map((track) => {
            const hasMusic = track.regions.some((region) => region.notes.length > 0);
            const playable = findInstrument(track.instrument);
            const supported = Boolean(playable);
            const replacement = replacementByTrack[track.id] ?? catalog[0]?.id ?? '';
            const confirming = deleteConfirmation === track.id;
            return (
              <div key={track.id} className={`flex flex-col gap-2 rounded-md border px-2 py-1.5 ${supported ? 'border-border/60' : 'border-amber-500/40 bg-amber-500/5'}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className={`min-w-0 truncate text-[10px] ${supported ? 'text-muted-foreground' : 'text-amber-200'}`}>{playable?.name ?? track.instrument}</span>
                  <button
                    type="button"
                    onClick={() => remove(track)}
                    className={`flex items-center gap-1 text-[9px] font-bold ${confirming ? 'text-amber-300' : 'text-muted-foreground hover:text-destructive'}`}
                    aria-label={hasMusic ? `Delete ${track.instrument}; click again to confirm` : `Delete ${track.instrument}`}
                  >
                    <Trash2 className="h-3 w-3" />
                    {confirming ? 'Confirm delete' : hasMusic ? 'Delete' : 'Remove'}
                  </button>
                </div>
                {!supported && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="flex items-center gap-1 text-[9px] leading-tight text-amber-200/90">
                      <AlertTriangle className="h-3 w-3 shrink-0" />
                      Unsupported saved sound; notes are preserved.
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
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}