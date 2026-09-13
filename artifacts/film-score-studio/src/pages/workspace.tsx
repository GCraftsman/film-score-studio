import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Activity,
  Atom,
  AudioLines,
  ChevronDown,
  ChevronRight,
  Check,
  CircuitBoard,
  Clapperboard,
  Drum,
  Film,
  GitMerge,
  Globe2,
  Keyboard,
  Landmark,
  Layers3,
  Loader2,
  Mic2,
  Moon,
  Music2,
  Piano,
  Play,
  Repeat2,
  RotateCcw,
  Route,
  Send,
  SkipBack,
  SlidersHorizontal,
  Sparkles,
  Square,
  Timer,
  TrendingUp,
  Undo2,
  Volume2,
  VolumeX,
  Waves,
  Wind,
  X,
  Zap,
} from 'lucide-react';
import { useRecording } from '@/hooks/use-recording';
import { useWorkspace, LocalMessage, AgentState, Track, AudioAttachment } from '@/hooks/use-workspace';
import { AgentConsultation, MidiSnippet } from '@workspace/api-client-react';
import PianoKeyboard from '@/components/piano-keyboard';
import { findInstrument, INSTRUMENT_CATALOG } from '@/lib/instrument-catalog';

import { useMicrophone, RecordingResult } from '@/hooks/use-microphone';
import { analyzeAudioPitch } from '@/lib/pitch-analysis';
import { saveAudioBlob, getAudioBlob, deleteAudioBlob } from '@/lib/audio-storage';
import { ApprovalWorkflow } from '@/components/approval-workflow';
import { EditWorkflowSummary, TerminalAuditPanel, WorkflowProgress } from '@/components/edit-workflow';
import { TrackControls } from '@/components/track-controls';

const midiMarker = (id: string) => `[[midi:${id}]]`;

function InlineMidiSnippet({
  snippet,
  onPlay,
  onRemove,
  compact = false,
}: {
  snippet: MidiSnippet;
  onPlay: (snippet: MidiSnippet) => void;
  onRemove?: () => void;
  compact?: boolean;
}) {
  return (
    <span className={`inline-flex align-middle items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 ${compact ? 'px-2 py-1' : 'w-full p-2.5'} shadow-inner`}>
      <button type="button" onClick={() => onPlay(snippet)} className="p-1.5 rounded-full bg-primary/20 text-primary hover:bg-primary hover:text-primary-foreground transition-all flex-shrink-0" aria-label="Play MIDI idea">
        <Play className="w-3 h-3 fill-current ml-px" />
      </button>
      <span className="font-music text-xl leading-none text-primary" aria-hidden="true">&#xE1D5;</span>
      <span className="text-[10px] font-mono text-primary font-bold whitespace-nowrap">
        {snippet.notes.length} notes · {snippet.tempo} BPM
      </span>
      {!compact && <span className="min-w-[90px] flex-1"><MidiSnippetVisualizer snippet={snippet} /></span>}
      {onRemove && (
        <button type="button" onClick={onRemove} className="p-1 text-primary/60 hover:text-destructive transition-colors" aria-label="Remove MIDI idea">
          <X className="w-3 h-3" />
        </button>
      )}
    </span>
  );
}


function MidiSnippetVisualizer({ snippet }: { snippet: MidiSnippet }) {
  if (!snippet || snippet.notes.length === 0) return <div className="h-8 w-full bg-white/5 rounded" />;
  const minNote = Math.min(...snippet.notes.map(n => n.note)) - 2;
  const maxNote = Math.max(...snippet.notes.map(n => n.note)) + 2;
  const maxTime = Math.max(...snippet.notes.map(n => n.startMs + n.durationMs));

  return (
    <div className="h-10 w-full relative overflow-hidden my-1 rounded border border-white/5 bg-black/30 shadow-inner">
      <div className="absolute inset-0 flex flex-col justify-between opacity-10 pointer-events-none py-0.5">
        {[...Array(4)].map((_, i) => <div key={i} className="w-full h-px bg-white" />)}
      </div>

      {snippet.notes.map((n, i) => {
        const range = Math.max(1, maxNote - minNote);
        const top = 100 - (((n.note - minNote) / range) * 80 + 10);
        const left = (n.startMs / Math.max(1, maxTime)) * 100;
        const width = (n.durationMs / Math.max(1, maxTime)) * 100;
        return (
          <div
            key={i}
            className="absolute h-[3px] bg-primary rounded-full shadow-[0_0_6px_rgba(217,119,6,0.8)] opacity-90"
            style={{ top: `${top}%`, left: `${left}%`, width: `${Math.max(1.5, width)}%` }}
          />
        )
      })}
    </div>
  )
}

function ExpandableConsultation({ c }: { c: AgentConsultation }) {
    const [open, setOpen] = useState(false);
    return (
        <div className="flex flex-col border border-border rounded-lg bg-black/20 overflow-hidden shadow-sm">
            <button
                onClick={() => setOpen(!open)}
                className="flex items-center justify-between p-2.5 text-left hover:bg-white/5 transition-colors group"
                aria-expanded={open}
            >
                <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full ${open ? 'bg-primary' : 'bg-primary/50 group-hover:bg-primary/80'} transition-colors`} />
                    <span className="font-bold text-[11px] uppercase tracking-widest text-foreground/90">{c.agent}</span>
                </div>
                {open ? <ChevronDown className="w-3 h-3 text-muted-foreground" /> : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
            </button>
            {open && (
                <div className="p-3.5 pt-2 text-xs border-t border-border bg-black/40">
                    <div className="mb-3 pb-3 border-b border-border/50">
                        <span className="text-[9px] uppercase tracking-widest text-muted-foreground/60 font-bold mb-1.5 block">Orchestrator Query</span>
                        <p className="text-muted-foreground italic leading-relaxed font-sans">
                            {c.question}
                        </p>
                    </div>
                    <div>
                        <span className="text-[9px] uppercase tracking-widest text-primary/70 font-bold mb-1.5 block">Specialist Response</span>
                        <p className="text-foreground/90 leading-relaxed font-sans">{c.insight}</p>
                    </div>
                </div>
            )}
        </div>
    )
}

function AudioAttachmentView({
    attachment,
    compact = false
}: {
    attachment: AudioAttachment;
    compact?: boolean;
}) {
    const [isPlaying, setIsPlaying] = useState(false);
    const [audioUrl, setAudioUrl] = useState<string | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);

    useEffect(() => {
        let active = true;
        let url = '';
        getAudioBlob(attachment.id).then(blob => {
            if (!active || !blob) return;
            url = URL.createObjectURL(blob);
            setAudioUrl(url);
        });
        return () => {
            active = false;
            if (url) URL.revokeObjectURL(url);
        };
    }, [attachment.id]);

    useEffect(() => {
        if (audioUrl && !audioRef.current) {
            audioRef.current = new Audio(audioUrl);
            audioRef.current.onended = () => setIsPlaying(false);
        }
        return () => {
            if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current = null;
            }
        };
    }, [audioUrl]);

    const togglePlayback = () => {
        if (!audioRef.current) return;
        if (isPlaying) {
            audioRef.current.pause();
            audioRef.current.currentTime = 0;
            setIsPlaying(false);
        } else {
            audioRef.current.play();
            setIsPlaying(true);
        }
    };

    return (
        <span className={`inline-flex align-middle items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 ${compact ? 'px-2 py-1' : 'w-full p-2.5'} shadow-inner`}>
            <button type="button" onClick={togglePlayback} disabled={!audioUrl} className="p-1.5 rounded-full bg-primary/20 text-primary hover:bg-primary hover:text-primary-foreground transition-all flex-shrink-0 disabled:opacity-50" aria-label={isPlaying ? "Stop audio" : "Play audio"}>
                {isPlaying ? <Square className="w-3 h-3 fill-current" /> : <Play className="w-3 h-3 fill-current ml-px" />}
            </button>
            <Mic2 className="w-4 h-4 text-primary opacity-80" />
            <span className="text-[10px] font-mono text-primary font-bold whitespace-nowrap">
                {(attachment.durationMs / 1000).toFixed(1)}s
            </span>
            <div className="flex-1 min-w-0 truncate text-xs text-primary/80 italic font-mono px-2">
                {attachment.analysisDescription}
            </div>
        </span>
    );
}

function MessageBubble({
  message,
  tracks,
  pendingProposalIds,
  onPlaySnippet,
  onApply,
  onReject,
  onSelectStyle,
  onApproveTracks,
  onRejectTracks,
  onRetry,
}: {
  message: LocalMessage;
  tracks: Track[];
  pendingProposalIds: Set<string>;
  onPlaySnippet: (s: MidiSnippet) => void;
  onApply: (id: string) => void;
  onReject: (id: string) => void;
  onSelectStyle: (proposalId: string, style: string) => void;
  onApproveTracks: (proposalId: string, ids: string[]) => void;
  onRejectTracks: (proposalId: string) => void;
  onRetry: (message: LocalMessage) => void;
}) {
  const isUser = message.role === 'user';
  const snippetsById = new Map(message.snippets?.map((snippet) => [snippet.id, snippet]));
  const orderedParts = message.content.split(/(\[\[midi:[^\]]+\]\])/g).filter(Boolean);
  const hasOrderedMidi = orderedParts.some((part) => part.startsWith('[[midi:'));

  return (
    <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} w-full`}>
      <div className={`max-w-[95%] flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
        {!isUser && <span className="text-[10px] text-primary/90 mb-1.5 uppercase tracking-widest font-bold ml-1 flex items-center gap-1.5"><Sparkles className="w-3 h-3" /> Orchestrator</span>}
        <div className={`p-4 rounded-xl ${isUser ? 'bg-primary/10 text-primary-foreground border border-primary/20 rounded-tr-sm shadow-sm' : 'bg-card text-foreground border border-border rounded-tl-sm shadow-md'}`}>

           <div className="flex flex-col gap-2.5">
               {message.content && (
                 <div className="text-[13px] leading-relaxed font-sans whitespace-pre-wrap">
                   {orderedParts.map((part, index) => {
                     const match = part.match(/^\[\[midi:([^\]]+)\]\]$/);
                     if (!match) return <span key={index}>{part}</span>;
                     const snippet = snippetsById.get(match[1]);
                     return snippet ? (
                       <span key={match[1]} className="block my-2">
                         <InlineMidiSnippet snippet={snippet} onPlay={onPlaySnippet} />
                       </span>
                     ) : null;
                   })}
                 </div>
               )}

               {!hasOrderedMidi && message.snippets && message.snippets.length > 0 && (
                 <div className="flex flex-col gap-2 w-full mt-1">
                    {message.snippets.map(s => (
                       <div key={s.id} className="flex items-center gap-3 p-2.5 rounded-lg bg-black/40 border border-border w-full shadow-inner">
                          <button onClick={() => onPlaySnippet(s)} className="p-2.5 rounded-full bg-primary/20 text-primary hover:bg-primary hover:text-primary-foreground transition-all shadow-sm flex-shrink-0" aria-label="Play snippet">
                             <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
                          </button>
                          <div className="flex-1 flex flex-col min-w-0">
                             <div className="flex items-center gap-2 mb-1">
                                 <Activity className="w-3 h-3 text-muted-foreground/80" />
                                 <span className="text-[9px] font-bold font-mono text-muted-foreground uppercase tracking-widest">Draft · {s.tempo} BPM</span>
                             </div>
                             <MidiSnippetVisualizer snippet={s} />
                          </div>
                       </div>
                    ))}
                 </div>
               )}

               {message.audioAttachments && message.audioAttachments.length > 0 && (
                  <div className="flex flex-col gap-2 w-full mt-1">
                      {message.audioAttachments.map(a => (
                         <div key={a.id} className="mt-2">
                            <AudioAttachmentView attachment={a} />
                         </div>
                      ))}
                  </div>
               )}
          </div>

          {message.consultations && message.consultations.length > 0 && (
              <div className="mt-4 pt-3 border-t border-border flex flex-col gap-2.5">
                 <span className="text-[9px] uppercase tracking-widest text-muted-foreground/60 font-bold mb-0.5 px-1">Consultation Log</span>
                 <div className="flex flex-col gap-2">
                     {message.consultations.map((c, i) => (
                        <ExpandableConsultation key={i} c={c} />
                     ))}
                 </div>
              </div>
          )}
           {message.editWorkflow && <EditWorkflowSummary workflow={message.editWorkflow} />}
            {message.editWorkflow?.status === 'verified' && (message.trackProposals?.length ?? 0) > 0 && (
              <div className="mt-4 border-t border-border pt-3" aria-label="Verified membership changes">
               <div className="mb-2 flex items-center justify-between">
                  <span className="text-[9px] font-bold uppercase tracking-widest text-primary">Approved membership</span>
                  <span className="text-[9px] uppercase tracking-wider text-emerald-400">Applied atomically with verified score</span>
               </div>
               <div className="space-y-1.5">
                  {message.trackProposals?.map((proposal) => (
                   <div key={proposal.id} className="rounded-md border border-primary/20 bg-primary/5 px-2.5 py-2 text-[11px]">
                      <span className="font-semibold">{proposal.action === 'add' ? 'Added' : 'Removed'} {proposal.instrument}</span>
                     <span className="ml-2 text-muted-foreground">{proposal.summary}</span>
                   </div>
                 ))}
               </div>
             </div>
           )}
          {message.operations && message.operations.length > 0 && (
            <div className="mt-4 border-t border-border pt-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[9px] font-bold uppercase tracking-widest text-primary">Playable score proposal</span>
                <span className={`text-[9px] uppercase tracking-wider ${message.operationStatus === 'applied' ? 'text-emerald-400' : 'text-muted-foreground'}`}>
                  {message.operationStatus === 'applied'
                    ? 'Applied to score'
                    : message.operationStatus === 'pending'
                      ? 'Waiting for approval'
                      : message.operationStatus === 'blocked'
                        ? 'Discussion only — not applied'
                      : message.operationStatus}
                </span>
              </div>
              <div className="space-y-1.5">
                {message.operations.map(operation => (
                  <div key={operation.id} className="rounded-md border border-primary/20 bg-primary/5 px-2.5 py-2 text-[11px]">
                    <span className="font-semibold">{operation.summary}</span>
                    <span className="ml-2 text-muted-foreground">{operation.type === 'add-region' ? `${operation.region.notes.length} notes · ${operation.region.dynamics} · ${operation.region.articulation}` : 'Remove region'}</span>
                  </div>
                ))}
              </div>
              {message.operationStatus === 'pending' && (
                <div className="mt-2.5 flex gap-2">
                  <button onClick={() => onApply(message.id)} className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[10px] font-bold text-primary-foreground"><Check className="h-3 w-3" /> Apply edits</button>
                  <button onClick={() => onReject(message.id)} className="rounded-md border border-border px-3 py-1.5 text-[10px] font-bold text-muted-foreground hover:text-foreground">Reject</button>
                </div>
              )}
              {message.operationStatus === 'conflicted' && (
                <p className="mt-2.5 rounded-md border border-amber-500/25 bg-amber-500/5 px-2.5 py-2 text-[10px] leading-relaxed text-amber-300">
                  The score changed after this proposal was prepared, so these edits were not applied. Ask the Orchestrator to revise them against the current score.
                </p>
              )}
            </div>
          )}
          {message.workflowProposalId && pendingProposalIds.has(message.workflowProposalId) && message.workflow && (
            <ApprovalWorkflow
              workflow={message.workflow}
              styleSuggestions={message.styleSuggestions}
              trackProposals={message.trackProposals}
              tracks={tracks}
              onSelectStyle={(style) => onSelectStyle(message.workflowProposalId!, style)}
              onApproveTracks={(ids) => onApproveTracks(message.workflowProposalId!, ids)}
              onRejectTracks={() => onRejectTracks(message.workflowProposalId!)}
              disabled={false}
            />
          )}
           {message.retry && (
             <button
               type="button"
               onClick={() => onRetry(message)}
               className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[10px] font-bold text-amber-300 hover:bg-amber-500/20"
             >
                <RotateCcw className="h-3 w-3" /> {message.retry.freshPlan ? 'Create a fresh plan with the original MIDI and style' : 'Retry with the original MIDI and style'}
             </button>
           )}
           {message.operationStatus === 'blocked' && (
             <p className="mt-2.5 rounded-md border border-primary/25 bg-primary/5 px-2.5 py-2 text-[10px] leading-relaxed text-muted-foreground">
               {message.editWorkflow?.intent === 'discussion'
                 ? 'This response was routed as discussion, not a verified score edit. No MIDI content was changed.'
                 : 'This response did not include verified edit metadata. No MIDI content was changed; retry to request a verified edit.'}
             </p>
           )}
        </div>
      </div>
    </div>
  )
}

function InputArea({
    onSend,
    isComposing,
    draftSnippets,
    removeDraftSnippet,
    playSnippet
}: {
    onSend: (text: string, audioAttachments: AudioAttachment[]) => void,
    isComposing: boolean,
    draftSnippets: MidiSnippet[],
    removeDraftSnippet: (id: string) => void,
    playSnippet: (s: MidiSnippet) => void
}) {
  const [textSegments, setTextSegments] = useState<string[]>(['']);
  const previousSnippetIds = useRef<string[]>([]);
  const textareaRefs = useRef<Array<HTMLTextAreaElement | null>>([]);
  const [audioDrafts, setAudioDrafts] = useState<AudioAttachment[]>([]);
  const [reviewResult, setReviewResult] = useState<RecordingResult | null>(null);
  const reviewAudioRef = useRef<{ url: string, audio: HTMLAudioElement } | null>(null);

  const { micState, countdown, elapsed, errorMsg, waveform, startRecording, stopRecording, cancelRecording, setMicState } = useMicrophone();

  const cleanupReviewAudio = useCallback(() => {
      if (reviewAudioRef.current) {
          reviewAudioRef.current.audio.pause();
          URL.revokeObjectURL(reviewAudioRef.current.url);
          reviewAudioRef.current = null;
      }
  }, []);

  useEffect(() => {
      return () => cleanupReviewAudio();
  }, [cleanupReviewAudio]);

  useEffect(() => {
    const currentIds = draftSnippets.map((snippet) => snippet.id);
    const previousIds = previousSnippetIds.current;
    if (currentIds.length === 0 && previousIds.length > 0) {
      setTextSegments(['']);
    } else if (
      currentIds.length > previousIds.length &&
      previousIds.every((id, index) => currentIds[index] === id)
    ) {
      const additions = currentIds.length - previousIds.length;
      setTextSegments((segments) => [...segments, ...Array(additions).fill('')]);
      requestAnimationFrame(() => textareaRefs.current[currentIds.length]?.focus());
    }
    previousSnippetIds.current = currentIds;
  }, [draftSnippets]);

  const hasText = textSegments.some((segment) => segment.trim());
  const combinedContent = () => draftSnippets.reduce(
    (content, snippet, index) => `${content}${textSegments[index] || ''}\n${midiMarker(snippet.id)}\n`,
    '',
  ) + (textSegments[draftSnippets.length] || '');

  const handleSend = () => {
    if (hasText || draftSnippets.length > 0 || audioDrafts.length > 0) {
      onSend(combinedContent().trim(), audioDrafts);
      setTextSegments(['']);
      setAudioDrafts([]);
    }
  };

  const handleMicAction = async () => {
      if (micState === 'idle' || micState === 'review') {
          cleanupReviewAudio();
          setReviewResult(null);
          startRecording();
      } else if (micState === 'recording') {
          try {
              const result = await stopRecording();
              setReviewResult(result);
          } catch (e) {
              // handled by hook state
          }
      }
  };

  const playReview = () => {
      if (!reviewResult) return;
      cleanupReviewAudio();
      const url = URL.createObjectURL(reviewResult.blob);
      const audio = new Audio(url);
      reviewAudioRef.current = { url, audio };
      audio.onended = () => {
          URL.revokeObjectURL(url);
          reviewAudioRef.current = null;
      };
      audio.play();
  };

  const handleAddToChat = async () => {
      if (!reviewResult) return;
      cleanupReviewAudio();

      const audioId = `audio-${Date.now()}`;
      await saveAudioBlob(audioId, reviewResult.blob);

      let attachment: AudioAttachment = {
          id: audioId,
          durationMs: reviewResult.durationMs,
          analysisDescription: 'Analysis was inconclusive. No clear monophonic pitches were detected.',
      };
      try {
          const analysis = analyzeAudioPitch(reviewResult.pcm, reviewResult.sampleRate);
          attachment = {
              id: audioId,
              durationMs: reviewResult.durationMs,
              derivedMidi: analysis.snippet,
              analysisDescription: analysis.description,
          };
      } catch (e) {
          console.error("Analysis failed", e);
      }
      setAudioDrafts(prev => [...prev, attachment]);
      setMicState('idle');
      setReviewResult(null);
  };

  const cancelMic = () => {
      cleanupReviewAudio();
      cancelRecording();
      setReviewResult(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (index: number, e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setTextSegments((segments) => segments.map((segment, segmentIndex) => segmentIndex === index ? e.target.value : segment));
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 96)}px`;
  };

  const handleRemove = (index: number) => {
    const snippet = draftSnippets[index];
    setTextSegments((segments) => [
      ...segments.slice(0, index),
      `${segments[index] || ''}${segments[index] && segments[index + 1] ? '\n' : ''}${segments[index + 1] || ''}`,
      ...segments.slice(index + 2),
    ]);
    removeDraftSnippet(snippet.id);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className={`relative flex flex-col gap-2 bg-black/40 p-3 rounded-xl border transition-all duration-300 shadow-inner ${isComposing ? 'border-primary/50 shadow-[0_0_15px_rgba(217,119,6,0.15)]' : 'border-border focus-within:border-primary/50 focus-within:bg-black/60'}`}>

        <div className="flex items-end gap-2">
          <div className="flex-1 flex flex-col gap-2 min-w-0 max-h-[240px] overflow-y-auto no-scrollbar">
            {textSegments.map((segment, index) => (
              <div key={`segment-${index}`} className="contents">
                <textarea
                  ref={(node) => { textareaRefs.current[index] = node; }}
                  value={segment}
                  onChange={(event) => handleInput(index, event)}
                  onKeyDown={handleKeyDown}
                  placeholder={isComposing ? "Orchestrator is drafting..." : index === 0 ? "Direct the team..." : "Continue discussing this idea..."}
                  className="w-full bg-transparent resize-none border-none focus:outline-none text-sm py-1 min-h-8 max-h-24 placeholder:text-muted-foreground/50 font-sans leading-relaxed text-foreground"
                  rows={1}
                  disabled={isComposing}
                  aria-label={index === 0 ? "Composer input" : `Composer input after MIDI idea ${index}`}
                />
                {draftSnippets[index] && (
                  <InlineMidiSnippet
                    snippet={draftSnippets[index]}
                    onPlay={playSnippet}
                    onRemove={() => handleRemove(index)}
                  />
                )}
              </div>
            ))}
          </div>
            <button
                onClick={handleMicAction}
                disabled={isComposing || micState === 'requesting' || micState === 'countdown'}
                className={`p-2.5 rounded-full flex-shrink-0 transition-all ${
                    micState === 'recording' ? 'bg-destructive/20 text-destructive shadow-[0_0_12px_rgba(220,38,38,0.4)] animate-pulse' :
                    micState === 'idle' || micState === 'review' ? 'text-primary hover:bg-primary/15' : 'text-muted-foreground opacity-50'
                }`}
                aria-label={micState === 'recording' ? "Stop recording" : "Record audio"}
            >
                {micState === 'recording' ? <Square className="w-4 h-4" /> : <Mic2 className="w-4 h-4" />}
            </button>
            <button
                onClick={handleSend}
                disabled={(!hasText && draftSnippets.length === 0 && audioDrafts.length === 0) || isComposing}
                className="p-2.5 text-primary disabled:opacity-30 disabled:text-muted-foreground transition-all hover:bg-primary/15 rounded-full flex-shrink-0"
                aria-label="Send message"
            >
                {isComposing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
        </div>
      </div>

      {micState === 'countdown' && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm rounded-xl">
              <span className="text-6xl font-display font-bold text-primary animate-pulse">{countdown}</span>
          </div>
      )}

      {micState === 'recording' && (
          <div className="absolute left-0 right-14 -top-12 h-10 bg-black/60 rounded-lg border border-destructive/30 flex items-center px-4 gap-4 shadow-lg backdrop-blur-md">
             <div className="flex items-center gap-2">
                 <div className="w-2.5 h-2.5 rounded-full bg-destructive animate-pulse" />
                 <span className="text-xs font-mono font-bold text-destructive">
                    {Math.floor(elapsed / 60).toString().padStart(2, '0')}:{(elapsed % 60).toString().padStart(2, '0')}
                 </span>
             </div>
             <div className="flex-1 flex items-center gap-0.5 h-full overflow-hidden opacity-80">
                 {waveform.map((val, i) => (
                    <div key={i} className="w-1 bg-destructive/60 rounded-full transition-all duration-75" style={{ height: `${Math.max(10, val * 100)}%` }} />
                 ))}
             </div>
             <button onClick={cancelMic} className="text-muted-foreground hover:text-foreground p-1"><X className="w-4 h-4" /></button>
          </div>
      )}

      {micState === 'review' && reviewResult && (
          <div className="absolute left-0 right-14 -top-12 h-10 bg-black/60 rounded-lg border border-primary/30 flex items-center px-4 gap-3 shadow-lg backdrop-blur-md">
              <span className="text-[10px] font-bold uppercase tracking-widest text-primary/70">Audio Review</span>
              <div className="flex-1 flex items-center gap-2 justify-end">
                  <button onClick={playReview} className="text-xs font-bold text-foreground hover:text-primary transition-colors flex items-center gap-1.5 px-2 py-1 rounded bg-white/5 hover:bg-white/10">
                      <Play className="w-3 h-3" /> Preview
                  </button>
                  <button onClick={() => {
                      cleanupReviewAudio();
                      setReviewResult(null);
                      startRecording();
                  }} className="text-xs font-bold text-foreground hover:text-primary transition-colors px-2 py-1 rounded bg-white/5 hover:bg-white/10">
                      Redo
                  </button>
                  <button onClick={handleAddToChat} className="text-xs font-bold bg-primary text-primary-foreground transition-colors px-2.5 py-1 rounded hover:opacity-90 shadow-[0_0_8px_rgba(217,119,6,0.3)]">
                      Add to chat
                  </button>
              </div>
              <button onClick={cancelMic} className="text-muted-foreground hover:text-destructive p-1 transition-colors"><X className="w-4 h-4" /></button>
          </div>
      )}

      {micState === 'error' && (
          <div className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded border border-destructive/20 mt-2 flex items-center justify-between">
              <span>{errorMsg}</span>
              <button onClick={() => setMicState('idle')}><X className="w-3 h-3" /></button>
          </div>
      )}

      {audioDrafts.length > 0 && (
          <div className="flex flex-col gap-2 mt-2">
              {audioDrafts.map(draft => (
                  <div key={draft.id} className="relative group">
                      <AudioAttachmentView attachment={draft} />
                       <button onClick={() => {
                           setAudioDrafts(prev => prev.filter(d => d.id !== draft.id));
                           void deleteAudioBlob(draft.id);
                       }} className="absolute -top-2 -right-2 w-5 h-5 bg-background border border-border rounded-full flex items-center justify-center text-muted-foreground hover:text-destructive hover:border-destructive transition-colors opacity-0 group-hover:opacity-100 shadow-md">
                          <X className="w-3 h-3" />
                      </button>
                  </div>
              ))}
          </div>
      )}
    </div>
  )
}

function AgentBadge({ agent }: { agent: AgentState }) {
  const isActive = agent.status === 'active';
  const iconMap = {
    strings: Waves,
    brass: AudioLines,
    woodwinds: Wind,
    percussion: Drum,
    keyboards: Piano,
    choir: Mic2,
    synths: CircuitBoard,
    classical: Landmark,
    modernist: Atom,
    jazz: Music2,
    electronic: Zap,
    folk: Globe2,
    minimalism: Moon,
    cinematic: Clapperboard,
    arc: TrendingUp,
    theme: Repeat2,
    harmony: GitMerge,
    rhythm: Activity,
    texture: Layers3,
    continuity: Route,
    pacing: Timer,
  } as const;
  const AgentIcon = iconMap[agent.id as keyof typeof iconMap] ?? SlidersHorizontal;

  return (
    <div className={`flex flex-col items-center gap-1.5 w-[58px] transition-all duration-300 ${isActive ? 'opacity-100 scale-105' : 'opacity-60 hover:opacity-100'}`} title={isActive ? `${agent.name} is consulting` : agent.name}>
       <div className={`w-9 h-9 rounded-full relative flex items-center justify-center border shadow-sm transition-all duration-300 ${isActive ? 'border-primary bg-primary/15 shadow-[0_0_14px_rgba(217,119,6,0.65)]' : 'border-border bg-black/25'}`}>
         {isActive && <span className="absolute inset-0 rounded-full animate-ping bg-primary/20 duration-1000" />}
         <AgentIcon className={`w-4 h-4 relative z-10 ${isActive ? 'text-primary' : 'text-muted-foreground'}`} aria-hidden="true" />
       </div>
       <div className="flex flex-col items-center text-center">
          <span className={`text-[7.5px] uppercase tracking-widest font-bold leading-[1.1] ${isActive ? 'text-primary' : 'text-muted-foreground'}`}>{agent.name}</span>
       </div>
    </div>
  )
}

function TrackRow({ track, playhead, durationBeats }: { track: Track; playhead: number; durationBeats: number }) {
  const playable = findInstrument(track.instrument);
  return (
    <div className={`group flex items-stretch gap-4 min-h-[60px] w-full ${playable ? '' : 'opacity-75'}`}>
      <div className="w-48 flex-shrink-0 flex flex-col justify-center border-r border-border pr-4">
        <span className="text-sm font-display font-medium text-muted-foreground group-hover:text-foreground transition-colors">{track.name}</span>
        <span className={`text-[9px] uppercase tracking-widest font-bold ${playable ? 'text-muted-foreground/40' : 'text-amber-300/80'}`}>
          {playable?.name ?? track.instrument} · MIDI {track.midiProgram}
        </span>
        {!playable && <span className="text-[9px] text-amber-300/80">Unsupported · replace below</span>}
      </div>
      <div className={`flex-1 bg-black/20 rounded-md relative overflow-hidden border mx-2 my-1 shadow-inner ${playable ? 'border-white/5' : 'border-amber-500/30'}`}>
        <div className="absolute inset-0 flex">
           {[...Array(10)].map((_, i) => (
             <div key={i} className="flex-1 border-r border-white/5 last:border-0" />
           ))}
        </div>

        {track.regions.map(r => (
          <div
            key={r.id}
            className="absolute top-1 bottom-1 bg-amber-500/75 rounded shadow-[0_2px_8px_rgba(0,0,0,0.5)] border border-white/10 transition-all duration-700 ease-out flex items-center justify-center overflow-hidden"
            style={{ left: `${(r.startBeat / durationBeats) * 100}%`, width: `${(r.durationBeats / durationBeats) * 100}%` }}
            title={`${r.name}: ${r.notes.length} notes, ${r.dynamics}, ${r.articulation}`}
          >
             <div className="w-full h-full opacity-20" style={{ background: 'repeating-linear-gradient(45deg, transparent, transparent 5px, rgba(255,255,255,0.1) 5px, rgba(255,255,255,0.1) 10px)' }} />
          </div>
        ))}

        <div className="absolute top-0 bottom-0 w-px bg-primary z-10 shadow-[0_0_12px_rgba(217,119,6,0.9)] transition-all duration-100 ease-linear" style={{ left: `${playhead}%` }} />
      </div>
    </div>
  )
}

export default function Workspace({
  userId,
  projectId,
}: {
  userId?: string | null;
  projectId?: string | null;
} = {}) {
  const {
      score, tracks, agents, messages, sendMessage,
      pendingProposals, selectStyle, approveTrackProposals, rejectTrackProposals,
      addTrack, deleteTrack, replaceTrack,
      playhead, setPlayhead, isPlaying, setIsPlaying, isComposing,
       applyOperations, rejectOperations, undo, canUndo, workflowProgress,
       retryMessage, terminalAudits,
   } = useWorkspace(userId, projectId);

  const {
      tempo, setTempo, tapTempo,
      activeInstrument, setActiveInstrument,
      isMetronomeOn, setIsMetronomeOn,
       audioStatus, soundFontAudioMode, soundFontLoadLabel, previewAudio,
      draftSnippets, removeDraftSnippet, clearDraftSnippets,
      onNoteOn, onNoteOff, playSnippet, playScore, stopScore
  } = useRecording();

  const [showKeyboard, setShowKeyboard] = useState(false);
  const [playbackError, setPlaybackError] = useState('');
  const [isPlaybackStarting, setIsPlaybackStarting] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const playbackSessionRef = useRef(0);

  const trackCatalog = INSTRUMENT_CATALOG;
  const pendingProposalIds = new Set(
    pendingProposals.filter((proposal) => proposal.status === 'pending').map((proposal) => proposal.id),
  );
  const scoreBars = Math.max(1, Math.ceil(score.durationBeats / 4));
  const currentBar = Math.min(
    scoreBars,
    Math.floor((playhead / 100 * score.durationBeats) / 4) + 1,
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, workflowProgress]);

  const togglePlayback = async () => {
    if (isPlaying || isPlaybackStarting) {
      playbackSessionRef.current += 1;
      stopScore();
      setIsPlaying(false);
      setIsPlaybackStarting(false);
      return;
    }
    const unsupported = tracks.filter((track) => !findInstrument(track.instrument));
    if (unsupported.length > 0) {
      stopScore();
      setPlaybackError(`Playback is muted until unsupported saved instruments are replaced: ${unsupported.map((track) => track.instrument).join(', ')}.`);
      return;
    }
    setPlaybackError('');
    const session = ++playbackSessionRef.current;
    // A completed score leaves the playhead at 100%. Replay must begin at
    // zero rather than scheduling an empty score with duration zero.
    const replayFromBeginning = playhead >= 99.9;
    const fromBeat = replayFromBeginning ? 0 : playhead / 100 * score.durationBeats;
    if (replayFromBeginning) setPlayhead(0);
    setIsPlaybackStarting(true);
    let duration: number;
    try {
      duration = await playScore(score, fromBeat);
    } catch (error) {
      if (session === playbackSessionRef.current) {
        setIsPlaying(false);
        setPlaybackError(error instanceof Error ? error.message : 'Could not start SoundFont playback.');
      }
      return;
    } finally {
      if (session === playbackSessionRef.current) setIsPlaybackStarting(false);
    }
    if (session !== playbackSessionRef.current) return;
    const started = performance.now();
    setIsPlaying(true);
    const animate = () => {
      if (session !== playbackSessionRef.current) return;
      const elapsedBeats = (performance.now() - started) / 1000 * score.tempo / 60;
      const nextBeat = fromBeat + elapsedBeats;
      if (nextBeat >= score.durationBeats) {
        setPlayhead(100);
        setIsPlaying(false);
        playbackSessionRef.current += 1;
        stopScore();
        return;
      }
      setPlayhead(nextBeat / score.durationBeats * 100);
      requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
    window.setTimeout(() => {
      if (session === playbackSessionRef.current) setIsPlaying(false);
    }, duration * 1000 + 100);
  };

  return (
    <div className="flex flex-col md:flex-row h-[100dvh] bg-background text-foreground overflow-hidden selection:bg-primary/30">

      {/* Left: Workspace & Tracks */}
      <div className="flex flex-col flex-1 border-r border-border bg-card/40 relative min-w-0">

        <header className="h-16 flex items-center px-6 border-b border-border justify-between bg-card z-10 flex-shrink-0 shadow-sm">
           <div className="flex items-center gap-4">
             <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center border border-primary/20 shadow-inner">
               <Film className="w-5 h-5 text-primary" />
             </div>
             <div className="flex flex-col justify-center">
               <h1 className="font-display font-medium text-lg tracking-wide leading-tight">1M3 - The Ascent</h1>
               <p className="text-[9px] text-muted-foreground uppercase tracking-widest font-bold mt-0.5">Project: Leviathan</p>
             </div>
           </div>
           <div className="font-mono text-sm text-primary bg-primary/5 px-3 py-1.5 rounded border border-primary/20 flex items-center gap-2.5 shadow-inner">
             <span className={`w-1.5 h-1.5 rounded-full bg-primary ${isPlaying ? 'animate-pulse shadow-[0_0_8px_rgba(217,119,6,0.8)]' : 'opacity-50'}`} />
             01:23:45:12
           </div>
        </header>

        <div className="h-14 border-b border-border flex items-center px-6 justify-between bg-card/80 backdrop-blur-sm z-10 flex-shrink-0 overflow-x-auto no-scrollbar gap-4">
            <div className="flex items-center gap-5 flex-shrink-0">
                <div className="flex items-center gap-2.5">
                    <button onClick={() => setPlayhead(0)} aria-label="Skip to beginning" className="w-8 h-8 rounded-full flex items-center justify-center text-muted-foreground hover:bg-white/5 transition-colors">
                        <SkipBack className="w-4 h-4 fill-current" />
                    </button>
                    <button
                        onClick={togglePlayback}
                         aria-label={isPlaying || isPlaybackStarting ? "Stop score playback" : "Play score"}
                          title="Play the current structured score"
                        className="w-10 h-10 rounded-full flex items-center justify-center bg-primary text-primary-foreground hover:bg-primary/90 transition-all duration-300 shadow-[0_0_15px_rgba(217,119,6,0.25)] hover:scale-105"
                    >
                        {isPlaying || isPlaybackStarting ? <Square className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-1" />}
                    </button>
                </div>
                <button onClick={undo} disabled={!canUndo} aria-label="Undo last applied score proposal" className="w-8 h-8 rounded-full flex items-center justify-center text-muted-foreground hover:bg-white/5 disabled:opacity-30">
                  <Undo2 className="w-4 h-4" />
                </button>

                <div className="h-5 w-px bg-border" />

                <div className="flex items-center gap-3">
                    <button
                        onClick={() => void previewAudio().catch((error) => {
                          setPlaybackError(error instanceof Error ? error.message : 'Could not enable audio output.');
                        })}
                        aria-label={audioStatus === 'ready' ? 'Preview audio output' : 'Enable audio output'}
                        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-[10px] font-bold transition-colors ${
                          audioStatus === 'ready'
                            ? 'border-emerald-500/40 text-emerald-400 bg-emerald-500/10'
                            : audioStatus === 'error'
                              ? 'border-red-500/40 text-red-400 bg-red-500/10'
                              : 'border-primary/40 text-primary bg-primary/10 hover:bg-primary/20'
                        }`}
                    >
                        {audioStatus === 'error' ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                        {audioStatus === 'ready'
                          ? soundFontAudioMode === 'compatibility' ? 'Compatibility MIDI audio' : 'Sound on'
                          : audioStatus === 'loading'
                            ? soundFontLoadLabel ?? 'Starting SoundFont worklet'
                            : audioStatus === 'error' ? 'Audio error' : 'Enable sound'}
                    </button>
                     <a
                       href="https://freepats.zenvoid.org/"
                       target="_blank"
                       rel="noreferrer"
                       className="text-[9px] font-semibold text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground"
                     >
                       SoundFont credits
                     </a>
                     <a
                       href="https://github.com/FluidSynth/fluidsynth"
                       target="_blank"
                       rel="noreferrer"
                       className="hidden text-[9px] font-semibold text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground lg:inline"
                     >
                       FluidR3
                     </a>
                    <button
                        onClick={() => setIsMetronomeOn(!isMetronomeOn)}
                        aria-label="Toggle Metronome and Recording"
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-bold transition-colors ${isMetronomeOn ? 'bg-red-500/20 border-red-500/50 text-red-500 shadow-[0_0_10px_rgba(239,68,68,0.2)]' : 'bg-transparent border-border text-muted-foreground hover:text-foreground hover:bg-white/5'}`}
                    >
                        <div className={`w-2 h-2 rounded-full ${isMetronomeOn ? 'bg-red-500 animate-pulse' : 'bg-muted-foreground'}`} />
                        Metronome / Rec
                    </button>
                    <div className="flex items-center border border-border rounded-md overflow-hidden bg-black/20 focus-within:border-primary/50 transition-colors shadow-inner">
                        <input
                            type="number"
                            value={tempo}
                            onChange={(e) => setTempo(Number(e.target.value) || 120)}
                            aria-label="Tempo BPM"
                            className="w-12 bg-transparent text-sm text-center py-1 outline-none font-mono text-foreground font-bold"
                        />
                        <span className="text-[9px] text-muted-foreground pr-2 border-r border-border font-bold">BPM</span>
                        <button onClick={tapTempo} aria-label="Tap Tempo" className="px-3 text-[10px] font-bold text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors active:bg-white/10 h-full">TAP</button>
                    </div>
                </div>
            </div>

            <div className="flex items-center gap-5 flex-shrink-0">
                <div className="flex items-center border border-border rounded-md overflow-hidden bg-black/20 shadow-inner">
                    <select
                      value={findInstrument(activeInstrument)?.id ?? activeInstrument}
                      onChange={(e) => setActiveInstrument(e.target.value)}
                      aria-label="Keyboard Instrument"
                      className="bg-transparent text-xs font-bold text-foreground outline-none px-3 py-1.5 cursor-pointer appearance-none min-w-[120px]"
                    >
                        {INSTRUMENT_CATALOG.map((instrument) => (
                            <option key={instrument.id} value={instrument.id}>{instrument.name}</option>
                        ))}
                    </select>
                </div>
                <button
                    onClick={() => setShowKeyboard(!showKeyboard)}
                    aria-pressed={showKeyboard}
                    className={`flex items-center gap-2 text-xs font-bold px-3 py-1.5 rounded-md border transition-colors ${showKeyboard ? 'bg-primary/20 border-primary/50 text-primary' : 'border-transparent text-muted-foreground hover:bg-white/5 hover:text-foreground'}`}
                >
                    <Keyboard className="w-4 h-4" />
                    MIDI Keyboard
                </button>
                <div className="flex flex-col items-end">
                    <span className="text-[8px] text-muted-foreground uppercase tracking-widest font-bold mb-0.5">Current Position</span>
                    <span className="font-mono text-[11px] bg-black/30 px-2 py-0.5 rounded border border-white/5 text-primary/90">
                      Bar {currentBar} of {scoreBars}
                    </span>
                </div>
            </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 md:p-8 space-y-3 no-scrollbar z-0 relative">
          <div className="absolute top-0 left-0 right-0 h-40 bg-gradient-to-b from-black/20 to-transparent pointer-events-none" />
           {playbackError && (
             <div className="relative flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[10px] text-amber-200" role="alert">
               <VolumeX className="mt-0.5 h-3.5 w-3.5 shrink-0" />
               <span>{playbackError}</span>
             </div>
           )}
           <div className="relative flex items-center justify-between pb-2 text-[9px] uppercase tracking-[0.16em] font-bold text-muted-foreground/70">
              <span>Read-only structured score · {score.tempo} BPM</span>
              <span className="rounded-full border border-emerald-500/25 bg-emerald-500/5 px-2.5 py-1 text-emerald-400/80">{tracks.reduce((sum, track) => sum + track.regions.reduce((notes, region) => notes + region.notes.length, 0), 0)} playable MIDI events</span>
           </div>
          {tracks.map(track => (
              <TrackRow key={track.id} track={track} playhead={playhead} durationBeats={score.durationBeats} />
          ))}
           <TrackControls
             tracks={tracks}
             catalog={trackCatalog}
             onAddTrack={addTrack}
             onDeleteTrack={deleteTrack}
             onReplaceTrack={replaceTrack}
           />
        </div>

        {showKeyboard && (
            <div className="h-56 border-t border-border shadow-[0_-10px_30px_rgba(0,0,0,0.5)] z-20 flex-shrink-0 animate-in slide-in-from-bottom-4 duration-300 overflow-x-auto no-scrollbar">
                 <PianoKeyboard
                   activeInstrument={activeInstrument}
                   onInstrumentChange={setActiveInstrument}
                   onNoteOn={onNoteOn}
                   onNoteOff={onNoteOff}
                 />
            </div>
        )}
      </div>

      {/* Right: Agents & Conversation */}
      <div className="w-full md:w-[480px] h-[50vh] md:h-full flex flex-col bg-card/95 relative z-20 shadow-2xl border-l border-border flex-shrink-0">

        <div className="p-4 px-5 border-b border-border bg-card backdrop-blur-md z-20 flex-shrink-0 shadow-sm">
           <div className="flex items-center justify-between mb-4">
               <h2 className="text-[10px] uppercase tracking-widest text-foreground font-bold flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500/80 animate-pulse shadow-[0_0_5px_rgba(34,197,94,0.5)]" />
                  Scoring Team
               </h2>
           </div>

           <div className="flex flex-col gap-4">
               {(['instrument', 'style', 'concept'] as const).map(group => (
                  <div key={group} className="flex flex-col gap-1.5">
                     <span className="text-[8px] uppercase tracking-widest text-muted-foreground/60 font-bold ml-1">{group}</span>
                     <div className="flex justify-between items-start w-full px-1">
                       {agents.filter(a => a.group === group).map(a => (
                         <AgentBadge key={a.id} agent={a} />
                       ))}
                     </div>
                  </div>
               ))}
           </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-6 scroll-smooth bg-gradient-to-b from-card to-background">
            {terminalAudits.length > 0 && <TerminalAuditPanel audits={terminalAudits} />}
           {messages.map(m => (
               <MessageBubble
                 key={m.id}
                 message={m}
                 tracks={tracks}
                 pendingProposalIds={pendingProposalIds}
                 onPlaySnippet={playSnippet}
                 onApply={applyOperations}
                 onReject={rejectOperations}
                 onSelectStyle={selectStyle}
                 onApproveTracks={approveTrackProposals}
                 onRejectTracks={rejectTrackProposals}
                  onRetry={retryMessage}
               />
           ))}
            {isComposing && workflowProgress.length > 0 && (
              <WorkflowProgress events={workflowProgress} live />
            )}
           <div ref={messagesEndRef} className="h-4" />
        </div>

        <div className="p-5 border-t border-border bg-card relative z-20 shadow-[0_-10px_40px_rgba(0,0,0,0.5)] flex-shrink-0">
           <InputArea
              onSend={(text, audioAttachments) => {
                  void sendMessage(text, draftSnippets, audioAttachments);
                 clearDraftSnippets();
             }}
             isComposing={isComposing}
             draftSnippets={draftSnippets}
             removeDraftSnippet={removeDraftSnippet}
             playSnippet={playSnippet}
           />
        </div>
      </div>
    </div>
  )
}