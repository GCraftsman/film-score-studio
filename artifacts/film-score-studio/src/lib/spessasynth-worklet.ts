import { WorkletSynthesizer } from 'spessasynth_lib';
import { SoundBankLoader, SpessaSynthProcessor } from 'spessasynth_core';
import type { SoundFontSynthesizer } from './soundfont-engine';

const MODULE_LOAD_TIMEOUT_MS = 5_000;
const PROCESSOR_FILE = 'audio-engine/spessasynth_processor-4.3.14.min.js';
const processorUrl = `${import.meta.env.BASE_URL}${PROCESSOR_FILE}`;
export type SoundFontAudioMode = 'worklet' | 'compatibility';

function withTimeout<T>(operation: Promise<T>, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(message)), MODULE_LOAD_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
}

async function fetchProcessorSource(url: string): Promise<string> {
  let response: Response;
  try {
    response = await withTimeout(
      fetch(url, { cache: 'no-store' }),
      `SoundFont processor fetch timed out after 5 seconds (${url}).`,
    );
  } catch (error) {
    throw new Error(`Could not fetch the SoundFont processor (${url}).`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(`SoundFont processor fetch failed (${response.status} at ${url}).`);
  }
  try {
    return await withTimeout(
      response.text(),
      `SoundFont processor download timed out after 5 seconds (${url}).`,
    );
  } catch (error) {
    throw new Error(`Could not read the SoundFont processor response (${url}).`, { cause: error });
  }
}

/**
 * Main-thread fallback for browsers where AudioWorklet cannot register at all.
 * It renders the same SpessaSynth core, SF2 parser, presets, MIDI channels and
 * voices into a ScriptProcessorNode; it is deliberately not an oscillator,
 * WAV sampler, or a transposition substitute.
 */
function createCompatibilitySynthesizer(context: AudioContext): SoundFontSynthesizer {
  const processor = new SpessaSynthProcessor(context.sampleRate);
  const node = context.createScriptProcessor(1_024, 0, 2);
  let destroyed = false;
  node.onaudioprocess = (event) => {
    if (destroyed) return;
    const left = event.outputBuffer.getChannelData(0);
    const right = event.outputBuffer.getChannelData(1);
    // The core's real-time process API accepts at most 128 samples, while
    // ScriptProcessorNode callbacks are commonly 1024 samples.
    for (let offset = 0; offset < left.length; offset += 128) {
      processor.process(left, right, offset, Math.min(128, left.length - offset));
    }
  };
  const soundBankManager = {
    addSoundBank: async (bytes: ArrayBuffer, id: string, bankOffset = 0) => {
      const soundBank = SoundBankLoader.fromArrayBuffer(bytes);
      processor.soundBankManager.addSoundBank(soundBank, id, bankOffset);
    },
    get priorityOrder() {
      return processor.soundBankManager.priorityOrder;
    },
    set priorityOrder(order: string[]) {
      processor.soundBankManager.priorityOrder = order;
    },
  };
  return {
    // processorInitialized is for optional decoder initialization. SF2 parsing
    // and the real-time renderer above are synchronous and usable immediately.
    isReady: Promise.resolve(),
    get channelCount() { return processor.midiChannels.length; },
    get voiceCount() { return processor.voiceCount; },
    get midiChannels() { return processor.midiChannels; },
    get presetList() { return processor.soundBankManager.presetList; },
    soundBankManager,
    connect(destination: AudioNode) {
      return node.connect(destination);
    },
    addNewChannel() {
      processor.createMIDIChannel();
    },
    controllerChange(channel, controller, value) {
      processor.controllerChange(
        channel,
        controller as Parameters<typeof processor.controllerChange>[1],
        value,
      );
    },
    programChange(channel, program) {
      processor.programChange(channel, program);
    },
    noteOn(channel, note, velocity) {
      processor.noteOn(channel, note, velocity);
    },
    noteOff(channel, note) {
      processor.noteOff(channel, note);
    },
    stopAll(force) {
      processor.stopAllChannels(force);
    },
    reset() {
      processor.reset();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      node.onaudioprocess = null;
      node.disconnect();
      processor.destroySynthProcessor();
    },
  };
}

async function createWorkletSynthesizer(context: AudioContext): Promise<SoundFontSynthesizer> {
  if (globalThis.isSecureContext === false) {
    throw new Error('SoundFont AudioWorklet requires a secure (HTTPS) browser context.');
  }
  if (!context.audioWorklet) {
    throw new Error('AudioWorklet is not supported in this browser.');
  }
  const source = await fetchProcessorSource(processorUrl);
  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    await withTimeout(
      context.audioWorklet.addModule(blobUrl),
      `SoundFont processor registration timed out after 5 seconds (source: ${processorUrl}).`,
    );
    const synth = new WorkletSynthesizer(context);
    const adapter = synth as unknown as SoundFontSynthesizer;
    const destroy = synth.destroy.bind(synth);
    adapter.destroy = () => {
      try {
        destroy();
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    };
    return adapter;
  } catch (error) {
    URL.revokeObjectURL(blobUrl);
    throw error;
  }
}

/**
 * The processor is deliberately fetched from a static versioned asset and
 * registered from a Blob URL. This avoids executing Vite's dev `/@fs` module
 * transform inside AudioWorklet while keeping the exact failing stage and URL
 * visible to the user.
 */
export async function createSpessaSynthesizer(
  context: AudioContext,
  onMode?: (mode: SoundFontAudioMode) => void,
): Promise<SoundFontSynthesizer> {
  try {
    const synth = await createWorkletSynthesizer(context);
    onMode?.('worklet');
    return synth;
  } catch (error) {
    // Chrome instances in this environment can fetch processor source but
    // leave addModule unresolved. Keep audio usable with real SpessaSynth SF2
    // synthesis rather than waiting forever or falling back to fake samples.
    console.warn('AudioWorklet unavailable; using compatibility MIDI audio.', error);
    onMode?.('compatibility');
    return createCompatibilitySynthesizer(context);
  }
}