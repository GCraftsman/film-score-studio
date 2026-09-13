import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { ChevronDown, Volume2 } from 'lucide-react';
import { findInstrument, INSTRUMENT_CATALOG } from '@/lib/instrument-catalog';
import { getTouchVelocity } from '@/lib/keyboard-velocity';

export type PianoKeyboardProps = {
  onNoteOn: (note: number, velocity?: number) => void;
  onNoteOff: (note: number) => void;
  /**
   * Accepts either a catalog ID or a legacy display name. The recording hook
   * intentionally supports both while saved projects migrate.
   */
  activeInstrument?: string;
  onInstrumentChange?: (instrumentId: string) => void;
  className?: string;
};

function velocityLabel(velocity: number | null) {
  if (velocity === null) return 'Play a key to see velocity';
  if (velocity < 55) return 'Soft';
  if (velocity < 96) return 'Medium';
  return 'Loud';
}

const DRUM_KEY_LABELS: Record<number, string> = {
  36: 'Kick',
  38: 'Snare',
  42: 'Closed hat',
};

/**
 * A two-octave touch keyboard. Finger touches use the vertical key position
 * because iPadOS commonly reports the same synthetic pressure (0.5) for every
 * finger. A non-constant pressure value from a pressure-capable pen or touch
 * device is blended in only when it is genuinely available.
 */
export function PianoKeyboard({
  onNoteOn,
  onNoteOff,
  activeInstrument,
  onInstrumentChange,
  className = '',
}: PianoKeyboardProps) {
  const [baseOctave, setBaseOctave] = useState(3);
  const [activeKeys, setActiveKeys] = useState<Set<number>>(new Set());
  const [lastVelocity, setLastVelocity] = useState<number | null>(null);
  const [selectedInstrument, setSelectedInstrument] = useState(
    activeInstrument ?? INSTRUMENT_CATALOG[0].id,
  );
  const keyboardScrollRef = useRef<HTMLDivElement>(null);
  const pointerNotesRef = useRef<Map<number, { note: number; velocity: number }>>(new Map());
  const velocityFeedbackTimerRef = useRef<number | null>(null);
  const octaves = 2;
  const whiteKeyWidth = 44;
  const blackKeyWidth = 24;

  const selectedDefinition =
    findInstrument(activeInstrument ?? selectedInstrument) ?? INSTRUMENT_CATALOG[0];
  const selectedValue =
    findInstrument(activeInstrument ?? selectedInstrument)?.id ?? selectedInstrument;
  const isDrumKit = (selectedDefinition.soundfont as { isDrum?: boolean }).isDrum === true;

  useEffect(() => {
    // GM percussion lives at MIDI 36–61. The normal keyboard starts at 48,
    // which hides the kick and snare, so put the useful drum range on screen
    // whenever the drum kit is selected.
    if (isDrumKit) setBaseOctave(2);
  }, [isDrumKit]);

  useEffect(() => {
    if (activeInstrument && findInstrument(activeInstrument)) {
      setSelectedInstrument(findInstrument(activeInstrument)!.id);
    }
  }, [activeInstrument]);

  useEffect(() => () => {
    if (velocityFeedbackTimerRef.current !== null) {
      window.clearTimeout(velocityFeedbackTimerRef.current);
    }
    for (const { note } of pointerNotesRef.current.values()) onNoteOff(note);
    pointerNotesRef.current.clear();
  }, [onNoteOff]);

  useEffect(() => {
    const scroller = keyboardScrollRef.current;
    if (!scroller) return;
    const centerMiddleC = () => {
      scroller.scrollLeft = Math.max(
        0,
        (7 * whiteKeyWidth) - (scroller.clientWidth / 2) + (whiteKeyWidth / 2),
      );
    };
    centerMiddleC();
    window.addEventListener('resize', centerMiddleC);
    return () => window.removeEventListener('resize', centerMiddleC);
  }, [baseOctave]);

  const velocityForPointer = (event: ReactPointerEvent<HTMLElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return getTouchVelocity({
      clientY: event.clientY,
      boundsTop: bounds.top,
      boundsHeight: bounds.height,
      pressure: event.pressure,
      pointerType: event.pointerType,
    });
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>, note: number) => {
    event.preventDefault();
    if (pointerNotesRef.current.has(event.pointerId)) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Some test and embedded browser pointer shims do not expose capture.
    }
    const velocity = velocityForPointer(event);
    pointerNotesRef.current.set(event.pointerId, { note, velocity });
    setActiveKeys((previous) => new Set(previous).add(note));
    setLastVelocity(velocity);
    if (velocityFeedbackTimerRef.current !== null) {
      window.clearTimeout(velocityFeedbackTimerRef.current);
    }
    velocityFeedbackTimerRef.current = window.setTimeout(() => setLastVelocity(null), 1400);
    onNoteOn(note, velocity);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
    const pointerNote = pointerNotesRef.current.get(event.pointerId);
    if (!pointerNote) return;
    pointerNotesRef.current.delete(event.pointerId);
    const noteStillPressed = [...pointerNotesRef.current.values()].some(
      ({ note }) => note === pointerNote.note,
    );
    setActiveKeys((previous) => {
      const next = new Set(previous);
      if (!noteStillPressed) next.delete(pointerNote.note);
      return next;
    });
    if (!noteStillPressed) onNoteOff(pointerNote.note);
  };

  const keys: ReactNode[] = [];
  let currentWhiteIndex = 0;
  const totalNotes = octaves * 12 + 1;

  for (let i = 0; i < totalNotes; i += 1) {
    const midiNote = (baseOctave + 1) * 12 + i;
    const noteInOctave = i % 12;
    const isBlack = [1, 3, 6, 8, 10].includes(noteInOctave);
    const label = noteInOctave === 0 ? `C${Math.floor(midiNote / 12) - 1}` : '';
    const isActive = activeKeys.has(midiNote);
    const pointerProps = {
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => handlePointerDown(event, midiNote),
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerUp,
      onLostPointerCapture: handlePointerUp,
    };

    if (!isBlack) {
      keys.push(
        <div
          key={`w-${midiNote}`}
          {...pointerProps}
          className={`border-x border-b border-black/20 rounded-b flex items-end justify-center pb-2 touch-none select-none transition-colors duration-75 cursor-pointer ${
            isActive ? 'bg-primary/20 shadow-inner' : 'bg-[#e5e5e5] hover:bg-white'
          }`}
          style={{ width: whiteKeyWidth, height: 140, flexShrink: 0 }}
           aria-label={`MIDI ${midiNote}${isDrumKit && DRUM_KEY_LABELS[midiNote] ? ` ${DRUM_KEY_LABELS[midiNote]}` : ''}`}
          role="button"
        >
          {label && <span className="text-neutral-400 text-[10px] font-bold pointer-events-none">{label}</span>}
        </div>,
      );
      currentWhiteIndex += 1;
    } else {
      keys.push(
        <div
          key={`b-${midiNote}`}
          {...pointerProps}
          className={`border-x border-b border-black rounded-b touch-none select-none absolute z-10 transition-colors duration-75 cursor-pointer ${
            isActive ? 'bg-primary shadow-[0_0_12px_rgba(217,119,6,0.8)]' : 'bg-[#111] hover:bg-black shadow-md'
          }`}
          style={{
            width: blackKeyWidth,
            height: 85,
            left: currentWhiteIndex * whiteKeyWidth - (blackKeyWidth / 2),
          }}
           aria-label={`MIDI ${midiNote}${isDrumKit && DRUM_KEY_LABELS[midiNote] ? ` ${DRUM_KEY_LABELS[midiNote]}` : ' Black'}`}
          role="button"
        />,
      );
    }
  }

  const handleInstrumentChange = (instrumentId: string) => {
    setSelectedInstrument(instrumentId);
    onInstrumentChange?.(instrumentId);
  };

  return (
    <div className={`flex flex-col gap-2 p-3 w-full h-full min-w-0 bg-black/40 shadow-inner ${className}`}>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2">
        <Volume2 className="h-4 w-4 text-primary" aria-hidden="true" />
        <div className="flex min-w-[132px] flex-1 flex-col gap-0.5">
          <label htmlFor="keyboard-sound-select" className="text-[9px] uppercase tracking-[0.16em] font-bold text-primary">
            Keyboard sound
          </label>
          <span className="text-[10px] text-muted-foreground">
            {selectedDefinition.name} · {selectedDefinition.suite}
          </span>
           {isDrumKit && (
             <span className="text-[9px] font-semibold text-primary/90">
               Kit keys: MIDI 36 Kick · 38 Snare · 42 Closed Hat
             </span>
           )}
        </div>
        <div className="relative min-w-[190px]">
          <select
            id="keyboard-sound-select"
            value={selectedValue}
            onChange={(event) => handleInstrumentChange(event.target.value)}
            aria-label="Keyboard sound"
            className="w-full appearance-none rounded-md border border-primary/50 bg-black/50 px-3 py-2 pr-8 text-xs font-bold text-foreground outline-none focus:ring-2 focus:ring-primary/50"
          >
            {[...new Set(INSTRUMENT_CATALOG.map((instrument) => instrument.suite))].map((suite) => (
              <optgroup key={suite} label={suite}>
                {INSTRUMENT_CATALOG.filter((instrument) => instrument.suite === suite).map((instrument) => (
                  <option key={instrument.id} value={instrument.id}>
                    {instrument.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-primary" aria-hidden="true" />
        </div>
        <div className="flex min-w-[165px] flex-col gap-1" aria-live="polite">
          <div className="flex items-center justify-between text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
            <span>Touch velocity</span>
            <span className="text-primary">{lastVelocity === null ? '—' : `${lastVelocity} · ${velocityLabel(lastVelocity)}`}</span>
          </div>
          <div className="flex items-center gap-1 text-[8px] uppercase tracking-widest text-muted-foreground">
            <span>Soft · top</span>
            <div className="h-1.5 flex-1 rounded-full bg-gradient-to-r from-sky-400/60 via-primary/70 to-orange-400" />
            <span>bottom · loud</span>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 items-center gap-4 md:gap-8">
        <div className="flex flex-col items-center gap-2 rounded-xl border border-white/5 bg-black/40 px-3 py-2 shadow-inner">
          <span className="text-[9px] uppercase tracking-widest text-muted-foreground font-bold">Octave</span>
          <button type="button" onClick={() => setBaseOctave((octave) => Math.min(octave + 1, 7))} className="h-8 w-10 rounded bg-white/5 text-muted-foreground transition-colors hover:bg-white/10">+</button>
          <span className="font-mono text-sm font-bold text-primary">{baseOctave}</span>
          <button type="button" onClick={() => setBaseOctave((octave) => Math.max(octave - 1, 0))} className="h-8 w-10 rounded bg-white/5 text-muted-foreground transition-colors hover:bg-white/10">−</button>
        </div>
        <div ref={keyboardScrollRef} className="min-w-0 flex-1 overflow-x-auto no-scrollbar">
          <div className="relative mx-auto flex w-max touch-none rounded-b shadow-2xl" style={{ touchAction: 'none' }} onContextMenu={(event) => event.preventDefault()}>
            {keys}
          </div>
        </div>
      </div>
    </div>
  );
}

export default PianoKeyboard;