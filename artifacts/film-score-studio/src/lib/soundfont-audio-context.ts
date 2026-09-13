export type UnlockableAudioContext = Pick<AudioContext, 'state' | 'sampleRate' | 'destination' | 'createBuffer' | 'createBufferSource' | 'resume'>;

/**
 * Safari/iPadOS only associates an audio unlock with the original gesture
 * call stack. Do this before awaiting a SoundFont network/decode operation.
 */
export function unlockAudioContextFromGesture(context: UnlockableAudioContext): Promise<void> {
  const source = context.createBufferSource();
  source.buffer = context.createBuffer(1, 1, context.sampleRate);
  source.connect(context.destination);
  source.start(0);
  return context.state === 'running' ? Promise.resolve() : context.resume();
}