import test from 'node:test';
import assert from 'node:assert/strict';
import { roofDistanceAbove, skyExposure, describeHeight } from '../lib/perception.js';

// A column world: `solid` maps y -> block name; everything else in range is air.
function column({ solid = {}, loadedUpTo = 400 } = {}) {
  return (_x, y, _z) => (y > loadedUpTo ? null : { name: solid[y] || 'air' });
}

test('a flat world at Y -60 with nothing overhead is open sky, not underground', () => {
  const roof = roofDistanceAbove(column(), { x: 0.5, y: -60, z: -63.5 }, { worldTop: 320 });
  assert.equal(roof, null);
  const exposure = skyExposure({ roofDistance: roof, skyLight: 15 });
  assert.equal(exposure, 'open');
  const text = describeHeight(-60, exposure);
  assert.match(text, /open sky/);
  assert.match(text, /not underground/);
  assert.doesNotMatch(text, /^Underground/);
});

test('rock overhead with no skylight is underground at any Y', () => {
  const roof = roofDistanceAbove(column({ solid: { 15: 'stone' } }), { x: 0, y: 11, z: 0 });
  assert.equal(roof, 3);
  assert.equal(skyExposure({ roofDistance: roof, skyLight: 0 }), 'underground');
  assert.equal(describeHeight(11, 'underground'), 'Underground (Y:11).');
  assert.equal(skyExposure({ roofDistance: 2, skyLight: undefined }), 'underground');
});

test('a roof with daylight reaching in is covered, not underground', () => {
  assert.equal(skyExposure({ roofDistance: 4, skyLight: 13 }), 'covered');
  assert.match(describeHeight(-60, 'covered'), /^Under cover/);
});

test('blocks the character can see through do not count as a roof', () => {
  const solid = { [-57]: 'cave_air', [-50]: 'light', [-40]: 'structure_void' };
  assert.equal(roofDistanceAbove(column({ solid }), { x: 0, y: -60, z: 0 }), null);
});

test('an unloaded column falls back to skylight, and unknown says only Y', () => {
  const roof = roofDistanceAbove(column({ loadedUpTo: -50 }), { x: 0, y: -60, z: 0 });
  assert.equal(roof, undefined);
  assert.equal(skyExposure({ roofDistance: roof, skyLight: 15 }), 'open');
  assert.equal(skyExposure({ roofDistance: roof, skyLight: 0 }), 'underground');
  assert.equal(skyExposure({ roofDistance: roof, skyLight: undefined }), 'unknown');
  assert.equal(describeHeight(-60.4, 'unknown'), 'Y:-61.');
});

test('the scan stops at the world top', () => {
  const roof = roofDistanceAbove(column({ solid: { 330: 'stone' } }), { x: 0, y: 300, z: 0 }, { worldTop: 320 });
  assert.equal(roof, null);
  assert.match(describeHeight(300, 'open'), /^High up, open sky/);
  assert.equal(describeHeight(70, 'open'), 'Outdoors under open sky (Y:70).');
});

test('water or lava overhead is not a roof', () => {
  const solid = { 63: 'water', 64: 'flowing_water', 70: 'lava', 71: 'bubble_column' };
  const roof = roofDistanceAbove(column({ solid }), { x: 0, y: 60, z: 0 });
  assert.equal(roof, null);
  assert.equal(skyExposure({ roofDistance: roof, skyLight: 12 }), 'open');
  const iced = roofDistanceAbove(column({ solid: { 63: 'water', 64: 'ice' } }), { x: 0, y: 60, z: 0 });
  assert.equal(iced, 3);
});
