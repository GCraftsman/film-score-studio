/**
 * Instrument playback is MIDI-to-SF2 through SpessaSynth's AudioWorklet.
 * The processor reads the SoundFont's sampled zones, envelopes, velocity
 * layers, sustain loops, and drum key map itself. It is not a WAV transposer.
 *
 * spessasynth_lib 4.3 is Apache-2.0 licensed.
 */
export {
  SOUNDFONT_BANKS,
  soundFontPresetForInstrument,
  type CatalogSoundFontMapping,
} from './soundfont-manifest';
export {
  SoundFontEngine,
  type SoundFontBank,
  type SoundFontPreset,
  type SoundFontSynthesizer,
} from './soundfont-engine';
export { createSpessaSynthesizer } from './spessasynth-worklet';