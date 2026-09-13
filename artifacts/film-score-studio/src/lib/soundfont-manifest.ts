import type { SoundFontBank, SoundFontPreset } from './soundfont-engine';
import type { InstrumentDefinition } from './instrument-catalog';

/**
 * The catalog owns the preset identity. This exported type is retained for
 * consumers that need to describe a catalog mapping without importing the
 * complete instrument definition.
 */
export type CatalogSoundFontMapping = InstrumentDefinition['soundfont'] & {
  drumKey?: number;
};

const basePath = (import.meta.env?.BASE_URL ?? '/').replace(/\/?$/, '/');

/**
 * The SF2 files are supplied under public/soundfonts by the asset owner.
 * URLs are BASE_URL-aware, so this also works below the artifact proxy prefix.
 */
export const SOUNDFONT_BANKS: SoundFontBank[] = [
  { id: 'upright-piano-kw', label: 'Upright Piano', url: `${basePath}soundfonts/upright-piano-kw.sf2`, bankOffset: 1 },
  { id: 'gm', label: 'General MIDI', url: `${basePath}soundfonts/fluidr3-gm.sf2`, bankOffset: 0 },
];

/**
 * Catalog mappings are intentionally explicit. No unavailable preset is
 * substituted with piano, an oscillator, or an unrelated MIDI program.
 */
export function soundFontPresetForInstrument(
  instrument: Pick<InstrumentDefinition, 'id' | 'soundfont'>,
): SoundFontPreset {
  if (!instrument.soundfont) {
    throw new Error(`Instrument "${instrument.id}" has no SoundFont program mapping.`);
  }
  return {
    bankId: instrument.soundfont.bankId,
    bank: instrument.soundfont.bank,
    program: instrument.soundfont.program,
    isDrum: instrument.soundfont.isDrum,
    ...(instrument.soundfont.drumKey === undefined ? {} : { drumKey: instrument.soundfont.drumKey }),
  };
}