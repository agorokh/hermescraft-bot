import test from 'node:test';
import assert from 'node:assert/strict';
import { isArrival, arrivalNote, skyNote } from '../lib/perception.js';

// The #592 live check: Rosie spent her session in a cave at 1658,59,1718,
// was teleported onto open grass in scenario_world, and still told the child
// "we're deep underground", though every status line said open sky.
const cave = { x: 1658.5, y: 59, z: 1718.7, world: 'world' };
const site = { x: 3.5, y: -60, z: -65.5, world: 'scenario_world' };

test('a change of world is an arrival, however close the coordinates', () => {
  assert.equal(isArrival(cave, site), true);
  assert.equal(isArrival({ ...site, world: 'world' }, site), true);
});

test('a far jump in one world is an arrival; a step or a fall is not', () => {
  const here = { x: 0, y: 64, z: 0, world: 'world' };
  assert.equal(isArrival(here, { ...here, x: 30 }), true);
  assert.equal(isArrival(here, { ...here, x: 3, y: 60 }), false);
  assert.equal(isArrival(here, { ...here, y: 41 }), false);
});

test('nothing known before or after is not an arrival', () => {
  assert.equal(isArrival(null, site), false);
  assert.equal(isArrival(cave, null), false);
  assert.equal(isArrival({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }), false);
});

test('the note names where the bot came from and what is here now', () => {
  assert.equal(
    arrivalNote(cave, skyNote(-60, 'open')),
    'You were just moved here from 1658,59,1718 in world; what you saw before no longer applies. '
      + 'Here: Open sky (ground level, not underground).',
  );
  assert.equal(
    arrivalNote({ x: -0.5, y: 70, z: 2 }, null),
    'You were just moved here from -1,70,2; what you saw before no longer applies.',
  );
});
