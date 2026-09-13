import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkletSynthesizer } from 'spessasynth_lib';
import { BasicSoundBank, SoundBankLoader, SpessaSynthProcessor } from 'spessasynth_core';
import { SoundFontEngine, type SoundFontSynthesizer } from './soundfont-engine.ts';
import { unlockAudioContextFromGesture } from './soundfont-audio-context.ts';

function fakeSynth(): SoundFontSynthesizer & { calls: unknown[]; mutableChannelCount: number } {
  const calls: unknown[] = [];
  const synth = {
    calls,
    mutableChannelCount: 16,
    get channelCount() { return this.mutableChannelCount; },
    midiChannels: Array.from({ length: 32 }, (_, channel) => ({ setDrums: (drums: boolean) => calls.push(['drums', channel, drums]) })),
    presetList: [{ bank: 0, program: 48, isDrum: false }, { bank: 0, program: 0, isDrum: true }],
    isReady: Promise.resolve(),
    soundBankManager: {
      addSoundBank: async (bytes: ArrayBuffer, id: string, offset?: number) => { calls.push(['load', id, bytes.byteLength, offset]); },
      get priorityOrder() { return []; },
      set priorityOrder(value: string[]) { calls.push(['priority', value]); },
    },
    connect: (_destination: AudioNode) => { calls.push(['connect']); return _destination; },
    addNewChannel() {
      this.mutableChannelCount += 1;
      calls.push(['add-channel']);
    },
    controllerChange: (...args: unknown[]) => calls.push(['cc', ...args]),
    programChange: (...args: unknown[]) => calls.push(['program', ...args]),
    noteOn: (...args: unknown[]) => calls.push(['on', ...args]),
    noteOff: (...args: unknown[]) => calls.push(['off', ...args]),
    stopAll: (...args: unknown[]) => calls.push(['panic', ...args]),
    reset: () => calls.push(['reset']),
    destroy: () => calls.push(['destroy']),
  } as unknown as SoundFontSynthesizer & { calls: unknown[]; mutableChannelCount: number };
  return synth;
}

function engineFor(synth = fakeSynth(), fetcher = async () => ({
  ok: true,
  arrayBuffer: async () => new ArrayBuffer(32),
})) {
  const engine = new SoundFontEngine({
    banks: [{ id: 'gm', url: '/studio/soundfonts/gm.sf2' }],
    destination: {} as AudioNode,
    createSynthesizer: async () => synth,
    fetcher,
  });
  return { engine, synth };
}

test('uses the installed SpessaSynth WorkletSynthesizer API', () => {
  assert.equal(typeof WorkletSynthesizer, 'function');
});

test('compatibility path renders a real core SoundFont signal', () => {
  const processor = new SpessaSynthProcessor(44_100);
  const soundBank = SoundBankLoader.fromArrayBuffer(BasicSoundBank.getSampleSoundBankFile());
  processor.soundBankManager.addSoundBank(soundBank, 'test');
  processor.programChange(0, 0);
  processor.noteOn(0, 60, 100);
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  processor.process(left, right);
  processor.destroySynthProcessor();

  assert.ok(left.some((sample) => sample !== 0));
});

test('loads a bank and schedules true MIDI program, velocity, note lifecycle', async () => {
  const { engine, synth } = engineFor();
  await engine.initialize();
  const preset = { bankId: 'gm', bank: 0, program: 48 };
  await engine.preparePreset(preset);
  engine.noteOn('track:a', preset, 93, 111, { time: 5.25 });
  engine.noteOff('track:a', preset, 93, { time: 6.5 });

  assert.deepEqual(synth.calls.find((call) => call[0] === 'load'), ['load', 'gm', 32, 0]);
  assert.deepEqual(synth.calls.find((call) => call[0] === 'program'), ['program', 0, 48, { time: 5.25 }]);
  assert.deepEqual(synth.calls.find((call) => call[0] === 'on'), ['on', 0, 93, 111, { time: 5.25 }]);
  assert.deepEqual(synth.calls.find((call) => call[0] === 'off'), ['off', 0, 93, { time: 6.5 }]);
});

test('uses GM percussion bank/key map and creates extra independent channels', async () => {
  const { engine, synth } = engineFor();
  await engine.initialize();
  const drums = { bankId: 'gm', bank: 128, program: 0, isDrum: true, drumKey: 38 };
  await engine.preparePreset(drums);
  engine.noteOn('drums', drums, 71, 96);
  for (let index = 0; index < 17; index += 1) engine.channelFor(`track:${index}`);

  assert.ok(synth.calls.some((call) => call[0] === 'drums' && call[2] === true));
  assert.deepEqual(synth.calls.find((call) => call[0] === 'on'), ['on', 9, 38, 96, undefined]);
  assert.ok(synth.calls.some((call) => call[0] === 'add-channel'));
});

test('reports SoundFont loading and missing-preset errors without a piano fallback', async () => {
  const failed = engineFor(fakeSynth(), async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer() }));
  await failed.engine.initialize();
  await assert.rejects(failed.engine.preparePreset({ bankId: 'gm', bank: 0, program: 48 }), /Could not load SoundFont bank "gm" \(404\)/);

  const { engine } = engineFor();
  await engine.initialize();
  await engine.preparePreset({ bankId: 'gm', bank: 0, program: 48 });
  assert.throws(() => engine.noteOn('missing', { bankId: 'gm', bank: 0, program: 1 }, 60, 80), /does not contain/);
});

test('cancelAll panics and resets queued worklet events', async () => {
  const { engine, synth } = engineFor();
  await engine.initialize();
  engine.cancelScheduled();
  assert.ok(synth.calls.some((call) => call[0] === 'panic' && call[1] === true));
  assert.ok(synth.calls.some((call) => call[0] === 'reset'));
  assert.ok(synth.calls.some((call) => call[0] === 'destroy'));
});

test('replay panic retains the initialized worklet and decoded bank', async () => {
  const { engine, synth } = engineFor();
  const preset = { bankId: 'gm', bank: 0, program: 48 };
  await engine.preparePreset(preset);
  engine.cancelAll();
  await engine.preparePreset(preset);
  engine.noteOn('replay', preset, 60, 90);

  assert.equal(synth.calls.filter((call) => call[0] === 'load').length, 1);
  assert.equal(synth.calls.filter((call) => call[0] === 'destroy').length, 0);
  assert.ok(synth.calls.some((call) => call[0] === 'on'));
});

test('cancelling during an asynchronous bank fetch cannot resurrect the worklet', async () => {
  let resolveFetch: ((response: { ok: boolean; arrayBuffer(): Promise<ArrayBuffer> }) => void) | undefined;
  const synth = fakeSynth();
  const { engine } = engineFor(synth, () => new Promise((resolve) => { resolveFetch = resolve; }));
  await engine.initialize();
  const loading = engine.preparePreset({ bankId: 'gm', bank: 0, program: 48 });
  await Promise.resolve();
  engine.cancelScheduled();
  resolveFetch?.({ ok: true, arrayBuffer: async () => new ArrayBuffer(32) });
  await assert.rejects(loading, /cancelled/);
  assert.equal(synth.calls.filter((call) => call[0] === 'load').length, 0);
  assert.throws(() => engine.noteOn('late', { bankId: 'gm', bank: 0, program: 48 }, 60, 80), /not ready/);
});

test('an old deferred initialization cannot clear its replacement engine', async () => {
  let resolveFirst: ((synth: SoundFontSynthesizer) => void) | undefined;
  const first = fakeSynth();
  const second = fakeSynth();
  let creates = 0;
  const engine = new SoundFontEngine({
    banks: [{ id: 'gm', url: '/soundfonts/gm.sf2' }],
    destination: {} as AudioNode,
    createSynthesizer: () => {
      creates += 1;
      return creates === 1
        ? new Promise((resolve) => { resolveFirst = resolve; })
        : Promise.resolve(second);
    },
    fetcher: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(32) }),
  });

  const oldInitialization = engine.initialize();
  engine.cancelScheduled();
  await engine.initialize();
  resolveFirst?.(first);
  await assert.rejects(oldInitialization, /cancelled/);
  await engine.preparePreset({ bankId: 'gm', bank: 0, program: 48 });

  assert.ok(first.calls.some((call) => call[0] === 'destroy'));
  assert.ok(second.calls.some((call) => call[0] === 'connect'));
});

test('reports a visible error when the worklet never becomes ready', { timeout: 1_000 }, async () => {
  const synth = fakeSynth();
  (synth as { isReady: Promise<unknown> }).isReady = new Promise(() => undefined);
  const engine = new SoundFontEngine({
    banks: [{ id: 'gm', url: '/soundfonts/gm.sf2' }],
    destination: {} as AudioNode,
    createSynthesizer: async () => synth,
    initializationTimeoutMs: 1,
  });
  await assert.rejects(engine.initialize(), /did not become ready within 1 seconds/);
});

test('iOS unlock starts silent audio synchronously before resume', async () => {
  const calls: string[] = [];
  const source = {
    buffer: null as AudioBuffer | null,
    connect: () => calls.push('connect'),
    start: () => calls.push('start'),
  };
  const context = {
    state: 'suspended' as AudioContextState,
    sampleRate: 44100,
    destination: {} as AudioDestinationNode,
    createBuffer: () => ({} as AudioBuffer),
    createBufferSource: () => source,
    resume: async () => { calls.push('resume'); },
  };
  const resume = unlockAudioContextFromGesture(context);
  assert.deepEqual(calls, ['connect', 'start', 'resume']);
  await resume;
});
