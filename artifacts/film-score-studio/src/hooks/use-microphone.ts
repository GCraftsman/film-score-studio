import { useState, useRef, useCallback, useEffect } from 'react';

export interface RecordingResult {
    blob: Blob;
    pcm: Float32Array;
    sampleRate: number;
    durationMs: number;
}

export function useMicrophone() {
  const [micState, setMicState] = useState<'idle' | 'requesting' | 'countdown' | 'recording' | 'review' | 'error'>('idle');
  const [countdown, setCountdown] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');

  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const pcmChunksRef = useRef<Float32Array[]>([]);
  const isRecordingPcmRef = useRef(false);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyzerRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const sessionRef = useRef(0);

  const [waveform, setWaveform] = useState<number[]>([]);

  const cleanup = useCallback(() => {
      isRecordingPcmRef.current = false;
      if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.onstop = null;
          try { mediaRecorderRef.current.stop(); } catch {}
      }
      mediaRecorderRef.current = null;

      if (processorRef.current) {
          processorRef.current.onaudioprocess = null;
          processorRef.current.disconnect();
          processorRef.current = null;
      }
      if (sourceRef.current) {
          sourceRef.current.disconnect();
          sourceRef.current = null;
      }
      if (analyzerRef.current) {
          analyzerRef.current.disconnect();
          analyzerRef.current = null;
      }
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
          audioCtxRef.current.close().catch(() => {});
      }
      audioCtxRef.current = null;

      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
      setWaveform([]);
  }, []);

  useEffect(() => {
      return () => cleanup();
  }, [cleanup]);

  const startRecording = useCallback(async () => {
    try {
      if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('MEDIA_RECORDER_UNAVAILABLE');
      }
      const session = ++sessionRef.current;
      setErrorMsg('');
      setCountdown(0);
      setMicState('requesting');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (sessionRef.current !== session) {
          stream.getTracks().forEach(t => t.stop());
          return;
      }
      streamRef.current = stream;

      const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioContextCtor();
      audioCtxRef.current = ctx;

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      const analyzer = ctx.createAnalyser();
      analyzer.fftSize = 256;
      source.connect(analyzer);
      analyzerRef.current = analyzer;

      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
          const input = e.inputBuffer.getChannelData(0);
          const output = e.outputBuffer.getChannelData(0);
          if (isRecordingPcmRef.current) {
              pcmChunksRef.current.push(new Float32Array(input));
          }
          // Mute output to prevent feedback
          for (let i = 0; i < output.length; i++) {
              output[i] = 0;
          }
      };
      source.connect(processor);
      processor.connect(ctx.destination);
      processorRef.current = processor;

      setMicState('countdown');
      for (let i = 4; i > 0; i--) {
        setCountdown(i);
        await new Promise(r => setTimeout(r, 1000));
        if (sessionRef.current !== session) return;
      }

      setMicState('recording');
      setElapsed(0);
      chunksRef.current = [];
      pcmChunksRef.current = [];
      isRecordingPcmRef.current = true;

      const mimeTypes = ['audio/webm', 'audio/mp4', 'audio/ogg'];
      let options = {};
      for (const t of mimeTypes) {
         if (MediaRecorder.isTypeSupported(t)) {
            options = { mimeType: t };
            break;
         }
      }

      const recorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = e => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start(100);

      const startTime = performance.now();
      let lastUpdate = startTime;

      const update = () => {
        const now = performance.now();
        setElapsed(Math.floor((now - startTime) / 1000));

        if (now - lastUpdate > 50 && analyzerRef.current) {
           const data = new Uint8Array(analyzerRef.current.frequencyBinCount);
           analyzerRef.current.getByteTimeDomainData(data);
           const rms = Math.sqrt(data.reduce((acc, val) => acc + Math.pow((val - 128) / 128, 2), 0) / data.length);
           setWaveform(prev => [...prev.slice(-49), rms]);
           lastUpdate = now;
        }
        rafRef.current = requestAnimationFrame(update);
      };
      rafRef.current = requestAnimationFrame(update);

    } catch (error: unknown) {
      sessionRef.current += 1;
      cleanup();
      setMicState('error');
      setErrorMsg(error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'Microphone permission denied.'
        : 'Microphone recording is not supported or is unavailable.');
    }
  }, [cleanup]);

  const stopRecording = useCallback((): Promise<RecordingResult> => {
    return new Promise((resolve, reject) => {
      isRecordingPcmRef.current = false;
      if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
      }

      const finalize = () => {
          const mimeType = mediaRecorderRef.current?.mimeType || 'audio/webm';
          const blob = new Blob(chunksRef.current, { type: mimeType });

          if (blob.size === 0) {
              cleanup();
              setMicState('error');
              setErrorMsg('Recording failed: captured audio is empty.');
              reject(new Error('Empty audio blob'));
              return;
          }

          const sampleRate = audioCtxRef.current?.sampleRate || 44100;
          const totalLength = pcmChunksRef.current.reduce((acc, arr) => acc + arr.length, 0);
          const pcm = new Float32Array(totalLength);
          let offset = 0;
          for (const arr of pcmChunksRef.current) {
              pcm.set(arr, offset);
              offset += arr.length;
          }
          const durationMs = (totalLength / sampleRate) * 1000;

          cleanup();
          setMicState('review');
          resolve({ blob, pcm, sampleRate, durationMs });
      };

      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.onstop = finalize;
        mediaRecorderRef.current.stop();
      } else {
        finalize();
      }
    });
  }, [cleanup]);

  const cancelRecording = useCallback(() => {
      sessionRef.current += 1;
      cleanup();
      setMicState('idle');
  }, [cleanup]);

  return { micState, countdown, elapsed, errorMsg, waveform, startRecording, stopRecording, cancelRecording, setMicState };
}
