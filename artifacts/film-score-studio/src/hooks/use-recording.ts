import { useState, useEffect, useRef, useCallback } from 'react';
import { MidiNote, MidiSnippet, Score } from '@workspace/api-client-react';
import metronomeClickUrl from '@/assets/audio/metronome-click.wav';
import { getScoreSchedule } from '@/lib/score-scheduling';
import {
  SoundFontEngine,
  SoundFontEngineCancelledError,
  type SoundFontPreset,
} from '@/lib/soundfont-engine';
import { SOUNDFONT_BANKS, soundFontPresetForInstrument } from '@/lib/soundfont-manifest';
import { createSpessaSynthesizer, type SoundFontAudioMode } from '@/lib/spessasynth-worklet';
import { unlockAudioContextFromGesture } from '@/lib/soundfont-audio-context';
import { findInstrument } from '@/lib/instrument-catalog';
import { snapshotRecordedMidi } from '@/lib/recorded-midi';

type AudioStatus = 'loading' | 'locked' | 'ready' | 'error';
type ScheduledMidiEvent = {
  atSeconds: number;
  type: 'on' | 'off';
  channelKey: string;
  preset: SoundFontPreset;
  note: number;
  velocity?: number;
};

type AudioDiagnosticsSnapshot = Readonly<{
  contextState: AudioContextState | 'uninitialized';
  contextTime: number | null;
  mode: SoundFontAudioMode;
  engine: ReturnType<SoundFontEngine['diagnostics']> | null;
  schedulerSession: number;
  schedulerNoteOnCount: number;
  schedulerEventCount: number;
  outputRms: number | null;
  outputPeak: number | null;
}>;

function withAudioTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
}

export function useRecording() {
  const [activeInstrument, setActiveInstrumentState] = useState<string>('Piano');
  const [tempo, setTempoState] = useState(120);
  const [isMetronomeOn, setIsMetronomeOnState] = useState(false);
  const [draftSnippets, setDraftSnippets] = useState<MidiSnippet[]>([]);
  const [audioStatus, setAudioStatus] = useState<AudioStatus>('locked');
  const [soundFontLoadLabel, setSoundFontLoadLabel] = useState<string | null>(null);
  const [soundFontAudioMode, setSoundFontAudioMode] = useState<SoundFontAudioMode>('worklet');

  const ctxRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const engineRef = useRef<SoundFontEngine | null>(null);
  const enginePromiseRef = useRef<Promise<SoundFontEngine> | null>(null);
  const clickBufferRef = useRef<AudioBuffer | null>(null);
  const clickLoadPromiseRef = useRef<Promise<void> | null>(null);
  const clickSourcesRef = useRef<AudioScheduledSourceNode[]>([]);
  const pendingPreviewNotes = useRef<Map<number, number>>(new Map());
  const activePreviewNotes = useRef<Map<number, ReturnType<typeof soundFontPresetForInstrument>>>(new Map());
  const previewRequestId = useRef(0);
  const scoreScheduleId = useRef(0);
  const scoreScheduleTimerId = useRef<number | null>(null);
  const schedulerNoteOnCount = useRef(0);
  const schedulerEventCount = useRef(0);
  const audioModeRef = useRef<SoundFontAudioMode>('worklet');

  const recordingStartTime = useRef<number | null>(null);
  const activeNotes = useRef<Map<number, { velocity: number; startMs: number }>>(new Map());
  const recordedNotes = useRef<MidiNote[]>([]);
  const nextClickTime = useRef(0);
  const metronomeTimerId = useRef<number | null>(null);
  const tapTimes = useRef<number[]>([]);

  const getCtx = useCallback(() => {
    if (!ctxRef.current) {
      const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) throw new Error('Web Audio is not supported in this browser.');
      const context = new AudioContextCtor();
      const masterGain = context.createGain();
      const outputAnalyser = context.createAnalyser();
      masterGain.gain.value = 0.9;
      outputAnalyser.fftSize = 1024;
      masterGain.connect(outputAnalyser);
      outputAnalyser.connect(context.destination);
      ctxRef.current = context;
      masterGainRef.current = masterGain;
      outputAnalyserRef.current = outputAnalyser;
    }
    return ctxRef.current;
  }, []);

  const ensureEngine = useCallback((context: AudioContext) => {
    if (!enginePromiseRef.current) {
      const engine = new SoundFontEngine({
        banks: SOUNDFONT_BANKS,
        destination: masterGainRef.current!,
        createSynthesizer: () => createSpessaSynthesizer(context, (mode) => {
          audioModeRef.current = mode;
          setSoundFontAudioMode(mode);
        }),
        onBankStatus: (bank, status) => {
          setSoundFontLoadLabel(status === 'loading' ? `Loading ${bank.label ?? bank.id} samples` : null);
          setAudioStatus(status === 'loading' ? 'loading' : 'ready');
        },
      });
      engineRef.current = engine;
      const ready = engine.initialize()
        .then(() => engine)
        .catch((error) => {
          // An earlier initialization may fail after Stop/Play has already
          // installed a replacement engine. Never erase that newer instance.
          if (engineRef.current === engine) engineRef.current = null;
          if (enginePromiseRef.current === ready) enginePromiseRef.current = null;
          throw error;
        });
      enginePromiseRef.current = ready;
    }
    return enginePromiseRef.current;
  }, []);

  const loadClick = useCallback((context: AudioContext) => {
    if (!clickLoadPromiseRef.current) {
      clickLoadPromiseRef.current = fetch(metronomeClickUrl)
        .then((response) => {
          if (!response.ok) throw new Error('Could not load metronome click.');
          return response.arrayBuffer();
        })
        .then((bytes) => context.decodeAudioData(bytes))
        .then((buffer) => { clickBufferRef.current = buffer; });
    }
    return clickLoadPromiseRef.current;
  }, []);

  const enableAudio = useCallback(async (presetToPrepare?: SoundFontPreset) => {
    try {
      const context = getCtx();
      // Must remain before the first await: this function is called directly
      // from pointer/touch/MIDI handlers so iPadOS recognizes the gesture.
      const resumePromise = unlockAudioContextFromGesture(context);
      setAudioStatus('loading');
      setSoundFontLoadLabel('Enabling audio output');
      // An embedded/blocked context can leave resume() pending indefinitely.
      // Surface that condition instead of keeping the control at Loading sound.
      await withAudioTimeout(
        resumePromise,
        8_000,
        'Audio output could not be enabled within 8 seconds. Check browser sound permissions and try again.',
      );
      setSoundFontLoadLabel('Starting SoundFont audio');
      const engine = await ensureEngine(context);
      if (presetToPrepare) {
        const bank = SOUNDFONT_BANKS.find((candidate) => candidate.id === presetToPrepare.bankId);
        setSoundFontLoadLabel(`Preparing ${bank?.label ?? presetToPrepare.bankId} samples`);
        await engine.preparePreset(presetToPrepare);
      }
      setSoundFontLoadLabel(null);
      setAudioStatus('ready');
      return { context, engine };
    } catch (error) {
      setSoundFontLoadLabel(null);
      setAudioStatus('error');
      throw error;
    }
  }, [ensureEngine, getCtx]);

  const setTempo = useCallback((value: number) => {
    setTempoState(Math.max(30, Math.min(300, Math.round(value))));
  }, []);

  const setActiveInstrument = useCallback((instrument: string) => {
    const definition = findInstrument(instrument);
    setActiveInstrumentState(definition?.name ?? instrument);
    if (!definition) return;
    // Changing sound is itself a user gesture. Prepare only its owning bank,
    // never FluidR3 eagerly for piano, so the following key-down is audible.
    void enableAudio(soundFontPresetForInstrument(definition)).catch((error) => {
      console.error('Could not prepare selected SoundFont', error);
      setAudioStatus('error');
    });
  }, [enableAudio]);

  const playClick = useCallback((time: number) => {
    const context = ctxRef.current;
    const buffer = clickBufferRef.current;
    if (!context || !buffer || !masterGainRef.current) return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(masterGainRef.current);
    source.start(time);
    source.stop(time + Math.min(buffer.duration, 0.18));
    clickSourcesRef.current.push(source);
    source.onended = () => {
      clickSourcesRef.current = clickSourcesRef.current.filter((candidate) => candidate !== source);
    };
  }, []);

  const previewAudio = useCallback(async () => {
    const { context } = await enableAudio();
    await loadClick(context);
    playClick(context.currentTime + 0.02);
  }, [enableAudio, loadClick, playClick]);

  const scheduleMetronome = useCallback(() => {
    if (!isMetronomeOn) return;
    const context = ctxRef.current;
    if (!context) return;
    while (nextClickTime.current < context.currentTime + 0.1) {
      playClick(nextClickTime.current);
      nextClickTime.current += 60 / tempo;
    }
    metronomeTimerId.current = window.setTimeout(scheduleMetronome, 25);
  }, [isMetronomeOn, playClick, tempo]);

  const setIsMetronomeOn = useCallback((value: boolean) => {
    if (value) {
      // Start the iOS unlock synchronously in the control's click handler.
      void enableAudio()
        .then(({ context }) => loadClick(context))
        .catch((error) => {
          console.error('Could not enable the metronome audio', error);
          setAudioStatus('error');
        });
    }
    setIsMetronomeOnState(value);
  }, [enableAudio, loadClick]);

  useEffect(() => {
    if (isMetronomeOn) {
      const context = getCtx();
      nextClickTime.current = context.currentTime + 0.05;
      if (!recordingStartTime.current) recordingStartTime.current = performance.now();
      scheduleMetronome();
    } else {
      if (metronomeTimerId.current !== null) window.clearTimeout(metronomeTimerId.current);
      metronomeTimerId.current = null;
      if (recordingStartTime.current) {
        const durationMs = performance.now() - recordingStartTime.current;
        for (const [note, active] of activeNotes.current) {
          recordedNotes.current.push({ note, velocity: active.velocity, startMs: active.startMs, durationMs: Math.max(1, durationMs - active.startMs) });
        }
        activeNotes.current.clear();
        if (recordedNotes.current.length) {
          // React may run the updater after the recording refs below are reset.
          // Never read mutable recording buffers inside that deferred updater.
          const snippet = snapshotRecordedMidi(
            crypto.randomUUID(), tempo, durationMs, recordedNotes.current,
          );
          setDraftSnippets((previous) => [...previous, snippet]);
        }
        recordingStartTime.current = null;
        recordedNotes.current = [];
      }
    }
    return () => {
      if (metronomeTimerId.current !== null) window.clearTimeout(metronomeTimerId.current);
    };
  }, [getCtx, isMetronomeOn, scheduleMetronome, tempo]);

  const onNoteOn = useCallback((note: number, velocity = 80) => {
    const definition = findInstrument(activeInstrument);
    if (!definition) {
      setAudioStatus('error');
      return;
    }
    const actualVelocity = Math.max(1, Math.min(127, Math.round(velocity)));
    // A repeated key-down can have the same pitch and velocity. A monotonically
    // increasing request token, rather than velocity equality, prevents an
    // older asynchronous bank load from starting a second voice.
    const requestId = ++previewRequestId.current;
    const activePreset = activePreviewNotes.current.get(note);
    if (activePreset && engineRef.current) {
      try {
        engineRef.current.noteOff('live-preview', activePreset, note);
      } catch {
        // Stop/unmount may have invalidated the engine between pointer events.
      }
      activePreviewNotes.current.delete(note);
    }
    pendingPreviewNotes.current.set(note, requestId);
    if (recordingStartTime.current) {
      activeNotes.current.set(note, { velocity: actualVelocity, startMs: performance.now() - recordingStartTime.current });
    }
    // Call immediately, not from a timeout, to retain an iPad gesture unlock.
    const preset = soundFontPresetForInstrument(definition);
    void enableAudio(preset)
      .then(({ engine }) => {
        if (pendingPreviewNotes.current.get(note) !== requestId) return;
        engine.noteOn('live-preview', preset, note, actualVelocity);
        activePreviewNotes.current.set(note, preset);
        pendingPreviewNotes.current.delete(note);
      })
      .catch((error) => {
        if (error instanceof SoundFontEngineCancelledError) return;
        console.error('Could not start SoundFont note preview', error);
        setAudioStatus('error');
      });
  }, [activeInstrument, enableAudio]);

  const onNoteOff = useCallback((note: number) => {
    pendingPreviewNotes.current.delete(note);
    const preset = activePreviewNotes.current.get(note);
    if (preset && engineRef.current) {
      engineRef.current.noteOff('live-preview', preset, note);
      activePreviewNotes.current.delete(note);
    }
    const recorded = activeNotes.current.get(note);
    if (recorded && recordingStartTime.current) {
      const elapsed = performance.now() - recordingStartTime.current;
      recordedNotes.current.push({ note, velocity: recorded.velocity, startMs: recorded.startMs, durationMs: Math.max(1, elapsed - recorded.startMs) });
      activeNotes.current.delete(note);
    }
  }, []);

  useEffect(() => {
    const nav = navigator as Navigator & { requestMIDIAccess?: () => Promise<any> };
    if (!nav.requestMIDIAccess) return;
    let access: any;
    const onMIDIMessage = (event: any) => {
      const [status, note, velocity = 0] = event.data;
      const command = status >> 4;
      if (command === 9 && velocity > 0) onNoteOn(note, velocity);
      if (command === 8 || (command === 9 && velocity === 0)) onNoteOff(note);
    };
    void nav.requestMIDIAccess().then((midiAccess) => {
      access = midiAccess;
      const attach = () => midiAccess.inputs.forEach((input) => { input.onmidimessage = onMIDIMessage; });
      attach();
      midiAccess.onstatechange = attach;
    }).catch(() => undefined);
    return () => {
      access?.inputs.forEach((input: any) => { input.onmidimessage = null; });
      if (access) access.onstatechange = null;
    };
  }, [onNoteOff, onNoteOn]);

  const cancelScoreSchedule = useCallback(() => {
    scoreScheduleId.current += 1;
    if (scoreScheduleTimerId.current !== null) {
      window.clearTimeout(scoreScheduleTimerId.current);
      scoreScheduleTimerId.current = null;
    }
  }, []);

  const scheduleScoreEvents = useCallback((
    context: AudioContext,
    engine: SoundFontEngine,
    events: ScheduledMidiEvent[],
  ) => {
    cancelScoreSchedule();
    const scheduleId = scoreScheduleId.current;
    const start = context.currentTime + 0.03;
    const sorted = [...events].sort((left, right) =>
      left.atSeconds - right.atSeconds || (left.type === 'on' ? -1 : 1));
    let nextEvent = 0;
    schedulerNoteOnCount.current = 0;
    schedulerEventCount.current = 0;
    const tick = () => {
      if (scheduleId !== scoreScheduleId.current) return;
      const elapsed = context.currentTime - start;
      try {
        // Post MIDI only when due. Unlike sending every future event to the
        // worklet, Stop can now invalidate the JS scheduler with no latent
        // note-on messages left on the audio thread.
        while (nextEvent < sorted.length && sorted[nextEvent].atSeconds <= elapsed + 0.003) {
          const event = sorted[nextEvent++];
          schedulerEventCount.current += 1;
          if (event.type === 'on') {
            engine.noteOn(event.channelKey, event.preset, event.note, event.velocity ?? 80);
            schedulerNoteOnCount.current += 1;
          } else {
            engine.noteOff(event.channelKey, event.preset, event.note);
          }
        }
      } catch (error) {
        if (!(error instanceof SoundFontEngineCancelledError)) {
          console.error('Could not schedule SoundFont score event', error);
          setAudioStatus('error');
        }
        cancelScoreSchedule();
        return;
      }
      if (nextEvent < sorted.length && scheduleId === scoreScheduleId.current) {
        scoreScheduleTimerId.current = window.setTimeout(tick, 15);
      } else {
        scoreScheduleTimerId.current = null;
      }
    };
    tick();
  }, [cancelScoreSchedule]);

  const stopScore = useCallback(() => {
    cancelScoreSchedule();
    // Keep the initialized worklet and transferred SF2 banks warm for Replay,
    // but clear all current voices and live-key bookkeeping.
    pendingPreviewNotes.current.clear();
    activePreviewNotes.current.clear();
    engineRef.current?.cancelAll();
    clickSourcesRef.current.forEach((source) => {
      try { source.stop(); } catch { /* source already ended */ }
    });
    clickSourcesRef.current = [];
  }, [cancelScoreSchedule]);

  const playSnippet = useCallback(async (snippet: MidiSnippet) => {
    const definition = findInstrument(activeInstrument);
    if (!definition) throw new Error(`No catalog instrument matches "${activeInstrument}".`);
    stopScore();
    const scheduleId = scoreScheduleId.current;
    const { context, engine } = await enableAudio();
    const preset = soundFontPresetForInstrument(definition);
    setAudioStatus('loading');
    try {
      await engine.preparePreset(preset);
    } catch (error) {
      setAudioStatus('error');
      throw error;
    }
    if (scheduleId !== scoreScheduleId.current) return;
    setAudioStatus('ready');
    scheduleScoreEvents(context, engine, snippet.notes.flatMap((midiNote) => {
      const startSeconds = midiNote.startMs / 1000;
      return [
        { atSeconds: startSeconds, type: 'on' as const, channelKey: `snippet:${snippet.id}`, preset, note: midiNote.note, velocity: midiNote.velocity },
        { atSeconds: startSeconds + Math.max(0.03, midiNote.durationMs / 1000), type: 'off' as const, channelKey: `snippet:${snippet.id}`, preset, note: midiNote.note },
      ];
    }));
  }, [activeInstrument, enableAudio, scheduleScoreEvents, stopScore]);

  const playScore = useCallback(async (score: Score, fromBeat = 0) => {
    stopScore();
    const scheduleId = scoreScheduleId.current;
    const { context, engine } = await enableAudio();
    const schedule = getScoreSchedule(score, fromBeat);
    const presetsByTrack = new Map<string, ReturnType<typeof soundFontPresetForInstrument>>();
    for (const note of schedule) {
      if (presetsByTrack.has(note.trackId)) continue;
      const instrument = findInstrument(note.instrument) ?? findInstrument(note.midiProgram);
      if (!instrument) throw new Error(`No catalog instrument matches score instrument "${note.instrument}" (MIDI ${note.midiProgram}).`);
      presetsByTrack.set(note.trackId, soundFontPresetForInstrument(instrument));
    }
    setAudioStatus('loading');
    try {
      await Promise.all([...presetsByTrack.values()].map((preset) => engine.preparePreset(preset)));
    } catch (error) {
      setAudioStatus('error');
      throw error;
    }
    if (scheduleId !== scoreScheduleId.current) return 0;
    setAudioStatus('ready');
    const events: ScheduledMidiEvent[] = [];
    for (const note of schedule) {
      const preset = presetsByTrack.get(note.trackId);
      if (!preset) throw new Error(`No SoundFont preset is mapped for track "${note.trackId}".`);
      const channelKey = `track:${note.trackId}`;
      events.push(
        { atSeconds: note.startSeconds, type: 'on', channelKey, preset, note: note.pitch, velocity: note.velocity },
        { atSeconds: note.startSeconds + note.durationSeconds, type: 'off', channelKey, preset, note: note.pitch },
      );
    }
    scheduleScoreEvents(context, engine, events);
    return Math.max(0, score.durationBeats - fromBeat) * (60 / score.tempo);
  }, [enableAudio, scheduleScoreEvents, stopScore]);

  useEffect(() => () => {
    if (metronomeTimerId.current !== null) window.clearTimeout(metronomeTimerId.current);
    cancelScoreSchedule();
    pendingPreviewNotes.current.clear();
    activePreviewNotes.current.clear();
    engineRef.current?.destroy();
    engineRef.current = null;
    enginePromiseRef.current = null;
    if (ctxRef.current) {
      void ctxRef.current.close();
      ctxRef.current = null;
      masterGainRef.current = null;
      outputAnalyserRef.current = null;
    }
  }, [cancelScoreSchedule]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const diagnosticsWindow = window as Window & {
      __filmScoreAudioDiagnostics?: () => AudioDiagnosticsSnapshot;
    };
    const diagnostics = (): AudioDiagnosticsSnapshot => {
      const context = ctxRef.current;
      const analyser = outputAnalyserRef.current;
      let outputRms: number | null = null;
      let outputPeak: number | null = null;
      if (analyser) {
        // Allocate only for this caller; raw audio samples are never retained.
        const samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples);
        let sumSquares = 0;
        let peak = 0;
        for (const sample of samples) {
          sumSquares += sample * sample;
          peak = Math.max(peak, Math.abs(sample));
        }
        outputRms = Math.sqrt(sumSquares / samples.length);
        outputPeak = peak;
      }
      return Object.freeze({
        contextState: context?.state ?? 'uninitialized',
        contextTime: context?.currentTime ?? null,
        mode: audioModeRef.current,
        engine: engineRef.current?.diagnostics() ?? null,
        schedulerSession: scoreScheduleId.current,
        schedulerNoteOnCount: schedulerNoteOnCount.current,
        schedulerEventCount: schedulerEventCount.current,
        outputRms,
        outputPeak,
      });
    };
    diagnosticsWindow.__filmScoreAudioDiagnostics = diagnostics;
    return () => {
      if (diagnosticsWindow.__filmScoreAudioDiagnostics === diagnostics) {
        delete diagnosticsWindow.__filmScoreAudioDiagnostics;
      }
    };
  }, []);

  const removeDraftSnippet = useCallback((id: string) => setDraftSnippets((items) => items.filter((snippet) => snippet.id !== id)), []);
  const clearDraftSnippets = useCallback(() => setDraftSnippets([]), []);
  const tapTempo = useCallback(() => {
    const now = performance.now();
    tapTimes.current.push(now);
    if (tapTimes.current.length > 4) tapTimes.current.shift();
    if (tapTimes.current.length > 1) {
      const intervals = tapTimes.current.slice(1).map((time, index) => time - tapTimes.current[index]);
      const nextTempo = Math.round(60000 / (intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length));
      if (nextTempo >= 30 && nextTempo <= 300) setTempo(nextTempo);
    }
  }, [setTempo]);

  return {
    tempo, setTempo, tapTempo,
    activeInstrument, setActiveInstrument,
    isMetronomeOn, setIsMetronomeOn,
    audioStatus, soundFontAudioMode, previewAudio,
    soundFontLoadLabel,
    draftSnippets, removeDraftSnippet, clearDraftSnippets,
    onNoteOn, onNoteOff,
    playSnippet, playScore, stopScore,
  };
}