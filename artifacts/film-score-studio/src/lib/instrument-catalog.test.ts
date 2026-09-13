import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findInstrument,
  findInstrumentByIdentity,
  INSTRUMENT_CATALOG,
  isSupportedInstrument,
} from './instrument-catalog.ts';

test('catalog has exactly the licensed stable playable entries', () => {
  const ids = INSTRUMENT_CATALOG.map((instrument) => instrument.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, [
    'piano',
    'string-ensemble',
    'violin',
    'cello',
    'french-horn',
    'trombone',
    'flute',
    'timpani',
    'synth-bass',
    'synth-lead',
    'synth-pad',
    'electric-keys',
    'electric-bass',
    'modern-drum-kit',
  ]);
  for (const instrument of INSTRUMENT_CATALOG) {
    assert.ok(instrument.name);
    assert.ok(instrument.suite);
    assert.ok(Number.isInteger(instrument.midiProgram));
    assert.ok(instrument.midiProgram >= 0 && instrument.midiProgram <= 127);
    assert.ok(instrument.soundfont.bankId);
    assert.ok(Number.isInteger(instrument.soundfont.bank));
    assert.ok(Number.isInteger(instrument.soundfont.program));
  }
});


test('catalog resolves modern IDs and legacy saved-score names', () => {
  assert.equal(findInstrument('synth-bass')?.name, 'Electronic Bass');
  assert.equal(findInstrument('Electronic Lead')?.id, 'synth-lead');
  assert.equal(findInstrument('Piano')?.name, 'Upright Piano');
  assert.equal(findInstrument('upright-piano')?.id, 'piano');
  assert.equal(findInstrument('modern-drum-kit')?.midiProgram, 0);
  assert.equal(findInstrument('String Ensemble')?.id, 'string-ensemble');
  assert.equal(findInstrument('Digital Pluck'), undefined);
  assert.equal(findInstrument(118), undefined);
});

test('licensed SoundFont bindings use explicit bank/program metadata', () => {
  assert.deepEqual(findInstrument('Piano')?.soundfont, {
    bankId: 'upright-piano-kw',
    bank: 128,
    program: 0,
  });
  assert.deepEqual(findInstrument('violin')?.soundfont, {
    bankId: 'gm',
    bank: 0,
    program: 40,
  });
  assert.deepEqual(findInstrument('String Ensemble')?.soundfont, {
    bankId: 'gm',
    bank: 0,
    program: 48,
  });
  assert.deepEqual(findInstrument('modern-drum-kit')?.soundfont, {
    bankId: 'gm',
    bank: 128,
    program: 0,
    isDrum: true,
  });
});

test('identity checks do not silently remap an unsupported saved instrument by MIDI program', () => {
  assert.equal(findInstrumentByIdentity('Tape Guitar'), undefined);
  assert.equal(isSupportedInstrument('Tape Guitar'), false);
  assert.equal(isSupportedInstrument('Piano'), true);
});