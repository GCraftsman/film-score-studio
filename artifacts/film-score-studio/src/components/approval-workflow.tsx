import { useState } from 'react';
import { Check, ChevronRight, Music2, ShieldAlert, X } from 'lucide-react';
import type { StyleSuggestion, TrackProposal } from '@workspace/api-client-react';

type ApprovalWorkflowProps = {
  workflow: 'style-intake' | 'instrument-approval' | 'composition';
  styleSuggestions?: StyleSuggestion[];
  trackProposals?: TrackProposal[];
  tracks: Array<{ id: string; instrument: string; regions: Array<{ notes: unknown[] }> }>;
  onSelectStyle?: (style: string) => void;
  onApproveTracks?: (ids: string[]) => void;
  onRejectTracks?: () => void;
  disabled?: boolean;
};

export function ApprovalWorkflow({
  workflow,
  styleSuggestions = [],
  trackProposals = [],
  tracks,
  onSelectStyle,
  onApproveTracks,
  onRejectTracks,
  disabled = false,
}: ApprovalWorkflowProps) {
  const [selectedStyle, setSelectedStyle] = useState('');
  const [selectedTracks, setSelectedTracks] = useState<string[]>(
    trackProposals.map((proposal) => proposal.id),
  );
  const [confirmMusicDeletion, setConfirmMusicDeletion] = useState(false);

  if (workflow === 'style-intake' && styleSuggestions.length > 0) {
    return (
      <section className="mt-4 border-t border-primary/20 pt-3" aria-label="Style approval">
        <div className="mb-2 flex items-center gap-2">
          <Music2 className="h-3.5 w-3.5 text-primary" />
          <span className="text-[9px] font-bold uppercase tracking-widest text-primary">Choose a scoring style</span>
        </div>
        <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
          This is a proposal only. Pick a direction before any instrument tracks are created.
        </p>
        <div className="grid gap-2">
          {styleSuggestions.map((suggestion) => {
            const selected = selectedStyle === suggestion.id;
            return (
              <button
                key={suggestion.id}
                type="button"
                disabled={disabled}
                onClick={() => setSelectedStyle(suggestion.id)}
                className={`rounded-lg border p-3 text-left transition-colors ${selected ? 'border-primary bg-primary/10' : 'border-border bg-black/20 hover:border-primary/50'} disabled:cursor-not-allowed disabled:opacity-50`}
                aria-pressed={selected}
              >
                <span className="flex items-center justify-between gap-2 text-[11px] font-bold text-foreground">
                  {suggestion.name}
                  {selected && <Check className="h-3.5 w-3.5 text-primary" />}
                </span>
                <span className="mt-1 block text-[10px] leading-relaxed text-muted-foreground">{suggestion.description}</span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          disabled={disabled || !selectedStyle}
          onClick={() => {
            const suggestion = styleSuggestions.find((item) => item.id === selectedStyle);
            if (suggestion) onSelectStyle?.(`${suggestion.name}: ${suggestion.description}`);
          }}
          className="mt-3 flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-[10px] font-bold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          Continue with selected style <ChevronRight className="h-3 w-3" />
        </button>
      </section>
    );
  }

  if (trackProposals.length === 0 && workflow === 'instrument-approval') {
    return (
      <section className="mt-4 border-t border-primary/20 pt-3" aria-label="Instrument approval">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          No membership changes were suggested. You may add one manually, or continue with the current track set.
        </p>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onApproveTracks?.([])}
          className="mt-3 flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[10px] font-bold text-primary-foreground disabled:opacity-40"
        >
          Continue with current tracks <ChevronRight className="h-3 w-3" />
        </button>
      </section>
    );
  }
  if (trackProposals.length === 0) return null;

  return (
    <section className="mt-4 border-t border-primary/20 pt-3" aria-label="Instrument track approval">
      <div className="mb-2 flex items-center gap-2">
        <ShieldAlert className="h-3.5 w-3.5 text-primary" />
        <span className="text-[9px] font-bold uppercase tracking-widest text-primary">Instrument proposals</span>
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
          Review each proposed addition or removal. Approval authorizes a
          staged writer run; the live score changes only if its complete
          candidate verifies.
      </p>
      <div className="space-y-2">
        {trackProposals.map((proposal) => {
          const checked = selectedTracks.includes(proposal.id);
          const existing = proposal.trackId ? tracks.find((track) => track.id === proposal.trackId) : undefined;
          const musicBearing = Boolean(existing?.regions.some((region) => region.notes.length > 0));
          return (
            <label key={proposal.id} className={`flex cursor-pointer gap-2.5 rounded-lg border p-2.5 ${checked ? 'border-primary/40 bg-primary/5' : 'border-border bg-black/20'}`}>
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={() => setSelectedTracks((current) => checked ? current.filter((id) => id !== proposal.id) : [...current, proposal.id])}
                className="mt-0.5 accent-primary"
              />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
                  {proposal.action === 'add' ? 'Add' : 'Delete'} {proposal.instrument}
                  {proposal.action === 'delete' && musicBearing && <span className="text-[9px] uppercase text-amber-300">contains music</span>}
                </span>
                <span className="mt-0.5 block text-[10px] leading-relaxed text-muted-foreground">{proposal.reason}</span>
              </span>
            </label>
          );
        })}
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={disabled || selectedTracks.length === 0}
          onClick={() => {
            const needsConfirmation = trackProposals.some((proposal) => {
              const existing = proposal.trackId ? tracks.find((track) => track.id === proposal.trackId) : undefined;
              return selectedTracks.includes(proposal.id) &&
                proposal.action === 'delete' &&
                existing?.regions.some((region) => region.notes.length > 0);
            });
            if (needsConfirmation && !confirmMusicDeletion) {
              setConfirmMusicDeletion(true);
              return;
            }
            onApproveTracks?.(selectedTracks);
          }}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[10px] font-bold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Check className="h-3 w-3" /> {confirmMusicDeletion ? 'Confirm musical deletion' : 'Approve selected'}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onRejectTracks?.()}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[10px] font-bold text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          <X className="h-3 w-3" /> Reject all
        </button>
      </div>
    </section>
  );
}