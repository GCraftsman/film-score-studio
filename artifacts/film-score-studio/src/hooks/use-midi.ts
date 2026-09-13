import { useState, useEffect, useRef, useCallback } from 'react';

export type MidiNote = {
  note: number;
  velocity: number;
  startTime: number;
  duration?: number;
};

export type MidiPhrase = MidiNote[];

export function useMidi(onPhrase: (phrase: MidiPhrase) => void) {
  const [isSupported, setIsSupported] = useState(true);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [activeNotes, setActiveNotes] = useState<Set<number>>(new Set());

  const phraseBuffer = useRef<MidiNote[]>([]);
  const activeNoteData = useRef<Map<number, MidiNote>>(new Map());
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const startTimeRef = useRef<number>(0);

  const commitPhrase = useCallback(() => {
    if (phraseBuffer.current.length > 0) {
      const now = performance.now();
      const finalPhrase = phraseBuffer.current.map(n => {
        if (!n.duration) {
          return { ...n, duration: (now - startTimeRef.current) - n.startTime };
        }
        return n;
      });
      onPhrase(finalPhrase);
      phraseBuffer.current = [];
      activeNoteData.current.clear();
      setActiveNotes(new Set());
    }
  }, [onPhrase]);

  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (activeNoteData.current.size === 0) {
        commitPhrase();
      }
    }, 1500); // 1.5s of silence commits the phrase
  }, [commitPhrase]);

  useEffect(() => {
    const nav = navigator as any;
    if (typeof nav === 'undefined' || !nav.requestMIDIAccess) {
      setIsSupported(false);
      return;
    }

    const onMIDIMessage = (event: any) => {
      const [status, data1, data2] = event.data;
      const cmd = status >> 4;
      const note = data1;
      const velocity = data2;
      const now = performance.now();

      if (phraseBuffer.current.length === 0 && activeNoteData.current.size === 0) {
        startTimeRef.current = now;
      }

      if (cmd === 9 && velocity > 0) {
        // Note on
        const newNote = { note, velocity, startTime: now - startTimeRef.current };
        activeNoteData.current.set(note, newNote);
        phraseBuffer.current.push(newNote);
        setActiveNotes(new Set(activeNoteData.current.keys()));
        resetTimer();
      } else if (cmd === 8 || (cmd === 9 && velocity === 0)) {
        // Note off
        const active = activeNoteData.current.get(note);
        if (active) {
          active.duration = (now - startTimeRef.current) - active.startTime;
          activeNoteData.current.delete(note);
          setActiveNotes(new Set(activeNoteData.current.keys()));
        }
        resetTimer();
      }
    };

    let midiAccessObj: any = null;

    nav.requestMIDIAccess().then(
      (midiAccess: any) => {
        midiAccessObj = midiAccess;
        setHasPermission(true);
        const inputs = midiAccess.inputs.values();
        let connected = false;
        for (let input = inputs.next(); input && !input.done; input = inputs.next()) {
          input.value.onmidimessage = onMIDIMessage;
          connected = true;
        }
        setIsConnected(connected);

        midiAccess.onstatechange = (e: any) => {
          const allInputs = e.currentTarget.inputs.values();
          let anyConnected = false;
          for (let i = allInputs.next(); i && !i.done; i = allInputs.next()) {
            i.value.onmidimessage = onMIDIMessage;
            anyConnected = true;
          }
          setIsConnected(anyConnected);
        };
      },
      () => {
        setHasPermission(false);
      }
    );

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [resetTimer]);

  const simulatePhrase = useCallback(() => {
    const fakePhrase: MidiPhrase = [
      { note: 60, velocity: 80, startTime: 0, duration: 1000 },
      { note: 64, velocity: 75, startTime: 150, duration: 850 },
      { note: 67, velocity: 70, startTime: 300, duration: 700 },
      { note: 71, velocity: 85, startTime: 450, duration: 550 },
      { note: 65, velocity: 80, startTime: 2000, duration: 1000 },
      { note: 69, velocity: 75, startTime: 2150, duration: 850 },
      { note: 72, velocity: 70, startTime: 2300, duration: 700 },
      { note: 76, velocity: 85, startTime: 2450, duration: 550 },
    ];
    onPhrase(fakePhrase);
  }, [onPhrase]);

  return { isSupported, hasPermission, isConnected, activeNotes, simulatePhrase };
}
