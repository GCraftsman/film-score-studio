export type SoundFontBank = {
  /** Stable identifier used by catalog preset mappings. */
  id: string;
  /** Short human-readable name shown while this bank is fetched. */
  label?: string;
  /** A same-origin URL, normally under `${import.meta.env.BASE_URL}soundfonts/`. */
  url: string;
  /** MIDI bank offset used to keep presets in separate SF2 files unambiguous. */
  bankOffset?: number;
};

export type SoundFontPreset = {
  bankId: string;
  bank: number;
  program: number;
  isDrum?: boolean;
  /** A fixed General MIDI percussion key, when this catalog sound is a single hit. */
  drumKey?: number;
};

export type TimedMidiEvent = { time?: number };

export type SoundFontSynthesizer = {
  readonly isReady: Promise<unknown>;
  readonly channelCount: number;
  readonly voiceCount?: number;
  readonly midiChannels: ReadonlyArray<{ setDrums(isDrum: boolean): void }>;
  readonly presetList: unknown[];
  soundBankManager: {
    addSoundBank(bytes: ArrayBuffer, id: string, bankOffset?: number): Promise<unknown>;
    priorityOrder: string[];
  };
  connect(destination: AudioNode): AudioNode;
  addNewChannel(): void;
  controllerChange(channel: number, controller: number, value: number, options?: TimedMidiEvent): void;
  programChange(channel: number, program: number, options?: TimedMidiEvent): void;
  noteOn(channel: number, note: number, velocity: number, options?: TimedMidiEvent): void;
  noteOff(channel: number, note: number, options?: TimedMidiEvent): void;
  stopAll(force?: boolean): void;
  reset(): void;
  destroy?(): void;
};

export type SoundFontFetch = (url: string) => Promise<{
  ok: boolean;
  status?: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export type SoundFontEngineOptions = {
  banks: SoundFontBank[];
  destination: AudioNode;
  createSynthesizer(): Promise<SoundFontSynthesizer>;
  fetcher?: SoundFontFetch;
  onBankStatus?: (bank: SoundFontBank, status: 'loading' | 'ready') => void;
  /** Fail visibly instead of leaving an unavailable worklet loading forever. */
  initializationTimeoutMs?: number;
};

const clampMidi = (value: number) => Math.max(0, Math.min(127, Math.round(value)));
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 12_000;

export class SoundFontEngineCancelledError extends Error {
  constructor() {
    super('SoundFont engine operation was cancelled.');
    this.name = 'SoundFontEngineCancelledError';
  }
}

/**
 * A small scheduling adapter over SpessaSynth's AudioWorklet synthesizer.
 * It deliberately sends MIDI events rather than resampling/transposing WAV
 * files: the SF2 processor owns sample zones, envelopes, loops, and velocity.
 */
export class SoundFontEngine {
  private readonly options: SoundFontEngineOptions;
  private synth?: SoundFontSynthesizer;
  private initialized?: Promise<void>;
  private bankLoads = new Map<string, Promise<void>>();
  private loadedBanks = new Set<string>();
  private generation = 0;
  private channels = new Map<string, number>();

  constructor(options: SoundFontEngineOptions) {
    this.options = options;
  }

  initialize(): Promise<void> {
    if (!this.initialized) {
      const generation = this.generation;
      this.initialized = this.initializeInternal(generation).catch((error) => {
        if (generation !== this.generation) throw error;
        this.synth?.destroy?.();
        this.initialized = undefined;
        this.synth = undefined;
        throw error;
      });
    }
    return this.initialized;
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.generation) throw new SoundFontEngineCancelledError();
  }

  private async initializeInternal(generation: number): Promise<void> {
    if (this.options.banks.length === 0) {
      throw new Error('No SoundFont banks are configured.');
    }
    const synth = await this.options.createSynthesizer();
    if (generation !== this.generation) {
      synth.destroy?.();
      throw new SoundFontEngineCancelledError();
    }
    this.synth = synth;
    await this.waitForReady(synth);
    if (generation !== this.generation) {
      synth.destroy?.();
      throw new SoundFontEngineCancelledError();
    }
    synth.connect(this.options.destination);
  }

  private async waitForReady(synth: SoundFontSynthesizer): Promise<void> {
    const timeoutMs = this.options.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        synth.isReady.then(() => undefined),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(
              `SoundFont audio worklet did not become ready within ${Math.ceil(timeoutMs / 1000)} seconds. Reload and try again.`,
            ));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  private loadBank(bankId: string): Promise<void> {
    const existing = this.bankLoads.get(bankId);
    if (existing) return existing;
    const bank = this.options.banks.find((candidate) => candidate.id === bankId);
    if (!bank) return Promise.reject(new Error(`SoundFont bank "${bankId}" is not configured.`));
    const fetcher = this.options.fetcher ?? ((url: string) => fetch(url));
    const generation = this.generation;
    const loading = (async () => {
      this.options.onBankStatus?.(bank, 'loading');
      const response = await fetcher(bank.url);
      this.assertCurrent(generation);
      if (!response.ok) {
        throw new Error(`Could not load SoundFont bank "${bank.id}" (${response.status ?? 'network error'}).`);
      }
      const synth = this.requireSynth();
      // addSoundBank transfers this ArrayBuffer to the worklet; do not cache it.
      const bytes = await response.arrayBuffer();
      this.assertCurrent(generation);
      await synth.soundBankManager.addSoundBank(bytes, bank.id, bank.bankOffset ?? 0);
      this.assertCurrent(generation);
      this.loadedBanks.add(bank.id);
      synth.soundBankManager.priorityOrder = this.options.banks
        .filter((candidate) => this.loadedBanks.has(candidate.id))
        .map((candidate) => candidate.id);
      this.options.onBankStatus?.(bank, 'ready');
    })().catch((error) => {
      this.bankLoads.delete(bankId);
      throw error;
    });
    this.bankLoads.set(bankId, loading);
    return loading;
  }

  private requireSynth(): SoundFontSynthesizer {
    if (!this.synth) throw new Error('SoundFont engine is not ready.');
    return this.synth;
  }

  /**
   * Allocates one independent MIDI channel per track/preview source. SpessaSynth
   * supports additional virtual channels; no modulo-16 channel collision occurs.
   */
  channelFor(key: string, preferredChannel?: number): number {
    const existing = this.channels.get(key);
    if (existing !== undefined) return existing;
    const synth = this.requireSynth();
    const occupied = new Set(this.channels.values());
    const channel = preferredChannel !== undefined && !occupied.has(preferredChannel)
      ? preferredChannel
      : Array.from({ length: Math.max(synth.channelCount, occupied.size + 1) }, (_, index) => index)
        // Keep MIDI channel 10 available for a real GM percussion track.
        .find((index) => !occupied.has(index) && index !== 9);
    if (channel === undefined) throw new Error(`SoundFont engine could not allocate a MIDI channel for "${key}".`);
    while (synth.channelCount <= channel) synth.addNewChannel();
    if (synth.channelCount <= channel) {
      throw new Error(`SoundFont engine could not allocate MIDI channel ${channel} for "${key}".`);
    }
    this.channels.set(key, channel);
    return channel;
  }

  private assertPreset(preset: SoundFontPreset): void {
    const synth = this.requireSynth();
    if (!this.bankLoads.has(preset.bankId)) throw new Error(`SoundFont bank "${preset.bankId}" is not loaded.`);
    const presets = synth.presetList;
    if (presets.length === 0) {
      throw new Error('SoundFont loaded without any playable presets.');
    }
    const hasPreset = presets.some((entry) => {
      const value = entry as Record<string, unknown>;
      const program = value.program ?? value.programNumber;
      const drum = value.isDrum ?? value.isGMGSDrum ?? value.drum;
      if (Number(program) !== preset.program) return false;
      // GM/GS percussion is selected through the channel's drum flag. Its
      // SoundFont bank number is intentionally not compared to melodic banks.
      if (preset.isDrum) return Boolean(drum);
      const bank = value.bank ?? value.bankNumber ?? (
        Number(value.bankMSB ?? 0) * 128 + Number(value.bankLSB ?? 0)
      );
      return Number(bank) === preset.bank && !Boolean(drum);
    });
    if (!hasPreset) {
      throw new Error(
        `SoundFont bank "${preset.bankId}" does not contain ${preset.isDrum ? 'drum ' : ''}preset ${preset.bank}:${preset.program}.`,
      );
    }
  }

  /** Lazily fetches exactly the SF2 which owns this catalog preset. */
  async preparePreset(preset: SoundFontPreset): Promise<void> {
    await this.initialize();
    await this.loadBank(preset.bankId);
    this.assertPreset(preset);
  }

  selectPreset(channelKey: string, preset: SoundFontPreset, options?: TimedMidiEvent): number {
    this.assertPreset(preset);
    const synth = this.requireSynth();
    // Reserve the conventional MIDI channel 10 (zero-based 9) for the first
    // percussion track. Additional independent drum tracks get virtual channels.
    const channel = this.channelFor(channelKey, preset.isDrum ? 9 : undefined);
    const channelState = synth.midiChannels[channel];
    if (!channelState) throw new Error(`SoundFont MIDI channel ${channel} is unavailable.`);
    channelState.setDrums(Boolean(preset.isDrum));
    // SpessaSynth maps its drum channel flag to the SF2's bank-128 GM/GS kit.
    // Bank-select CCs therefore remain 0 for a drum channel, rather than
    // attempting to encode impossible MIDI controller value 128.
    const selectedBank = preset.isDrum ? 0 : preset.bank;
    synth.controllerChange(channel, 0, (selectedBank >> 7) & 0x7f, options);
    synth.controllerChange(channel, 32, selectedBank & 0x7f, options);
    synth.programChange(channel, clampMidi(preset.program), options);
    return channel;
  }

  noteOn(channelKey: string, preset: SoundFontPreset, note: number, velocity: number, options?: TimedMidiEvent): void {
    const channel = this.selectPreset(channelKey, preset, options);
    this.requireSynth().noteOn(channel, preset.drumKey ?? clampMidi(note), clampMidi(velocity), options);
  }

  noteOff(channelKey: string, preset: SoundFontPreset, note: number, options?: TimedMidiEvent): void {
    const channel = this.selectPreset(channelKey, preset, options);
    this.requireSynth().noteOff(channel, preset.drumKey ?? clampMidi(note), options);
  }

  /** Force-panic sounding SoundFont voices and restore MIDI controller state. */
  cancelAll(): void {
    if (!this.synth) return;
    this.synth.stopAll(true);
    this.synth.reset();
    this.channels.clear();
  }

  /**
   * A Web Audio worklet has no public "unschedule future MIDI" primitive.
   * Destroying this processor after panic/reset is the only way to guarantee
   * that already-posted future note-ons cannot reach the audio thread.
   */
  cancelScheduled(): void {
    this.generation += 1;
    this.cancelAll();
    this.synth?.destroy?.();
    this.synth = undefined;
    this.initialized = undefined;
    this.bankLoads.clear();
    this.loadedBanks.clear();
  }

  destroy(): void {
    this.cancelScheduled();
  }

  /** Read-only operational state for development diagnostics. */
  diagnostics(): Readonly<{
    initialized: boolean;
    loadedBanks: readonly string[];
    allocatedChannels: number;
    voiceCount: number | null;
  }> {
    return Object.freeze({
      initialized: Boolean(this.synth && this.initialized),
      loadedBanks: Object.freeze([...this.loadedBanks]),
      allocatedChannels: this.channels.size,
      voiceCount: this.synth?.voiceCount ?? null,
    });
  }
}