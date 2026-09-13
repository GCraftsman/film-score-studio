import test from 'node:test';
import assert from 'node:assert/strict';
import { getTouchVelocity } from './keyboard-velocity.ts';

test('touch position maps soft at the top to loud at the bottom', () => {
  const soft = getTouchVelocity({
    clientY: 0,
    boundsTop: 0,
    boundsHeight: 100,
    pressure: 0.5,
    pointerType: 'touch',
  });
  const loud = getTouchVelocity({
    clientY: 100,
    boundsTop: 0,
    boundsHeight: 100,
    pressure: 0.5,
    pointerType: 'touch',
  });
  assert.equal(soft, 28);
  assert.equal(loud, 127);
});

test('constant iPad touch pressure is ignored, measured pen pressure is blended', () => {
  const positionOnly = getTouchVelocity({
    clientY: 50,
    boundsTop: 0,
    boundsHeight: 100,
    pressure: 0.5,
    pointerType: 'touch',
  });
  const measured = getTouchVelocity({
    clientY: 50,
    boundsTop: 0,
    boundsHeight: 100,
    pressure: 0.8,
    pointerType: 'pen',
  });
  assert.equal(positionOnly, 78);
  assert.ok(measured > positionOnly);
});