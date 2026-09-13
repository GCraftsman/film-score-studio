/**
 * The sound selector and the score renderer use the same instrument identity.
 *
 * `id` is the persisted/routing identity. `name` is the human-facing name
 * retained for compatibility with score tracks created before the catalog was
 * introduced. Keep both stable: score playback resolves either value.
 */
export type InstrumentDefinition = {
  id: string;
  name: string;
  role: string;
  midiProgram: number;
  suite: string;
  /**
   * The exact preset selected in the licensed SoundFont bank.  This is kept
   * on the catalog entry (rather than inferred from midiProgram at playback
   * time) so a drum bank/program cannot accidentally resolve to a melodic
   * patch with the same program number.
   */
  soundfont: {
    bankId: string;
    bank: number;
    program: number;
    isDrum?: boolean;
    drumKey?: number;
  };
  /** Names that were persisted by older score versions. */
  aliases?: readonly string[];
};

export const INSTRUMENT_CATALOG = [
  {
    id: 'piano',
    name: 'Upright Piano',
    aliases: ['Piano'],
    role: 'keyboards',
    midiProgram: 0,
    suite: 'FreePats KW',
    soundfont: { bankId: 'upright-piano-kw', bank: 128, program: 0 },
  },
  {
    id: 'string-ensemble',
    name: 'String Ensemble',
    role: 'strings',
    midiProgram: 48,
    suite: 'FluidR3 GM',
    soundfont: { bankId: 'gm', bank: 0, program: 48 },
  },
  {
    id: 'violin',
    name: 'Violin',
    role: 'strings',
    midiProgram: 40,
    suite: 'FluidR3 GM',
    soundfont: { bankId: 'gm', bank: 0, program: 40 },
  },
  {
    id: 'cello',
    name: 'Cello',
    role: 'strings',
    midiProgram: 42,
    suite: 'FluidR3 GM',
    soundfont: { bankId: 'gm', bank: 0, program: 42 },
  },
  {
    id: 'french-horn',
    name: 'French Horn',
    role: 'brass',
    midiProgram: 60,
    suite: 'FluidR3 GM',
    soundfont: { bankId: 'gm', bank: 0, program: 60 },
  },
  {
    id: 'trombone',
    name: 'Trombone',
    role: 'brass',
    midiProgram: 57,
    suite: 'FluidR3 GM',
    soundfont: { bankId: 'gm', bank: 0, program: 57 },
  },
  {
    id: 'flute',
    name: 'Flute',
    role: 'woodwinds',
    midiProgram: 73,
    suite: 'FluidR3 GM',
    soundfont: { bankId: 'gm', bank: 0, program: 73 },
  },
  {
    id: 'timpani',
    name: 'Timpani',
    role: 'percussion',
    midiProgram: 47,
    suite: 'FluidR3 GM',
    soundfont: { bankId: 'gm', bank: 0, program: 47 },
  },

  { id: 'synth-bass', name: 'Electronic Bass', role: 'synths', midiProgram: 38, suite: 'FluidR3 GM', soundfont: { bankId: 'gm', bank: 0, program: 38 } },
  { id: 'synth-lead', name: 'Electronic Lead', role: 'synths', midiProgram: 81, suite: 'FluidR3 GM', soundfont: { bankId: 'gm', bank: 0, program: 81 } },
  { id: 'synth-pad', name: 'Atmospheric Pad', role: 'synths', midiProgram: 89, suite: 'FluidR3 GM', soundfont: { bankId: 'gm', bank: 0, program: 89 } },

  { id: 'electric-keys', name: 'Electric Keys', role: 'keyboards', midiProgram: 4, suite: 'FluidR3 GM', soundfont: { bankId: 'gm', bank: 0, program: 4 } },
  { id: 'electric-bass', name: 'Electric Bass', role: 'bass', midiProgram: 33, suite: 'FluidR3 GM', soundfont: { bankId: 'gm', bank: 0, program: 33 } },

  {
    id: 'modern-drum-kit',
    name: 'Modern Drum Kit',
    role: 'percussion',
    // The drum kit is a GM bank 128 preset 0, not a melodic program 118.
    midiProgram: 0,
    suite: 'FluidR3 GM',
    soundfont: { bankId: 'gm', bank: 128, program: 0, isDrum: true },
  },
] as const satisfies readonly InstrumentDefinition[];

export type InstrumentId = (typeof INSTRUMENT_CATALOG)[number]['id'];

const normalizeInstrumentKey = (value: string) =>
  value.trim().toLocaleLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Resolve both catalog IDs and legacy display names found in saved scores.
 * MIDI program matching is intentionally opt-in through a numeric input so
 * callers can recover a catalog sound for imported MIDI tracks.
 */
export function findInstrument(
  value: string | number | null | undefined,
): (typeof INSTRUMENT_CATALOG)[number] | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return INSTRUMENT_CATALOG.find((instrument) => instrument.midiProgram === value);
  }
  if (typeof value !== 'string' || value.trim() === '') return undefined;

  const key = normalizeInstrumentKey(value);
  return INSTRUMENT_CATALOG.find((instrument) =>
    normalizeInstrumentKey(instrument.id) === key ||
    normalizeInstrumentKey(instrument.name) === key ||
    ('aliases' in instrument && instrument.aliases.some((alias) => normalizeInstrumentKey(alias) === key)),
  );
}

/**
 * Resolve a persisted identity without interpreting its MIDI program. This
 * distinction matters for legacy tracks: MIDI program 0 is shared by the
 * upright piano and the GM percussion bank, so an unsupported instrument
 * must never be silently reassigned from its stored program.
 */
export function findInstrumentByIdentity(
  value: string | null | undefined,
): (typeof INSTRUMENT_CATALOG)[number] | undefined {
  return typeof value === 'string' ? findInstrument(value) : undefined;
}

export function isSupportedInstrument(value: string | null | undefined): boolean {
  return Boolean(findInstrumentByIdentity(value));
}

export function getInstrumentById(id: string): (typeof INSTRUMENT_CATALOG)[number] | undefined {
  return INSTRUMENT_CATALOG.find((instrument) => instrument.id === id);
}

export function instrumentName(value: string | number | null | undefined): string {
  return findInstrument(value)?.name ?? (typeof value === 'string' ? value : 'Unknown instrument');
}