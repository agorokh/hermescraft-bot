import test from 'node:test';
import assert from 'node:assert/strict';
import { formatStuckPos } from '../lib/survival.js';

// Regression: unstuck loop crashed with `pos.toFloor is not a function`
// because Vec3's method is `.floored()`, not `.toFloor()`. The format
// helper sidesteps the Vec3 method-name trap entirely.
test('formatStuckPos floors plain {x,y,z} without calling Vec3 methods', () => {
  assert.equal(formatStuckPos({ x: 10.7, y: 64.2, z: -3.9 }), '10,64,-4');
});

test('formatStuckPos works on a Vec3-like instance', () => {
  const vec = { x: 0.1, y: 65.99, z: 0.0 };
  assert.equal(formatStuckPos(vec), '0,65,0');
});
