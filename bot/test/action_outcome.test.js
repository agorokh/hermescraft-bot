import test from 'node:test';
import assert from 'node:assert/strict';

import { actionOutcomeFailed, publicActionResult } from '../lib/action_outcome.js';

test('advanced build rejections are failures with kid-safe public text', () => {
  const result = {
    result: 'Foreman rejected "well" at 10,65,10: missing materials - stone:12.',
  };

  assert.equal(actionOutcomeFailed(result), true);
  assert.equal(
    publicActionResult('build_schematic_advanced', result, { failed: true }),
    "I can't build that yet - I'm missing materials.",
  );
});

test('sentry pauses are failures with kid-safe public text', () => {
  const result = {
    result: 'Build "tower" paused for Sentry Mode: zombie nearby. Resume with build_schematic_advanced resume=true.',
  };

  assert.equal(actionOutcomeFailed(result), true);
  assert.equal(
    publicActionResult('build_schematic_advanced', result, { failed: true }),
    'I paused the build because the area did not look safe.',
  );
});

test('already-complete advanced builds produce bounded public feedback', () => {
  const result = {
    result: 'Build "tower" at 10,65,10 is already complete (40/40 blocks).',
  };

  assert.equal(actionOutcomeFailed(result), false);
  assert.equal(
    publicActionResult('build_schematic_advanced', result),
    '"tower" is already complete at 10,65,10.',
  );
});

test('clean survival and movement successes reach the kid', () => {
  assert.equal(
    publicActionResult('fish_for_food', { result: 'Caught 2 fish! Fresh food ready.' }),
    'Caught 2 fish! Fresh food ready.',
  );
  assert.equal(
    publicActionResult('build_shelter_for_night', { result: 'Shelter built at 1,64,2! Get inside - torched it up.' }),
    'Shelter built at 1,64,2! Get inside - torched it up.',
  );
  assert.equal(
    publicActionResult('follow_player_v2', { result: 'Following Adalynn (will stay within 3 blocks). Use mc stop to stop.' }),
    'Following Adalynn (will stay within 3 blocks). Use mc stop to stop.',
  );
  assert.equal(
    publicActionResult('build_tower', { result: 'Built 5-tall oak_log tower at 1702,63,1722.' }),
    'Built 5-tall oak_log tower at 1702,63,1722.',
  );
});

test('partial tower outcomes stay failures', () => {
  assert.equal(
    actionOutcomeFailed({ result: 'Built 1/5 oak_log blocks of the tower at 1702,63,1722.' }),
    true,
  );
  assert.equal(
    actionOutcomeFailed({ result: 'Built 5-tall oak_log tower at 1702,63,1722.' }),
    false,
  );
});

test('public action feedback refuses command leaks', () => {
  assert.equal(
    publicActionResult('light_area', { result: 'Changed block at 1,64,2 via /setblock (op).' }),
    null,
  );
  assert.equal(
    publicActionResult('give_to_player', { result: 'Done: /give FieldKid diamond 1' }),
    null,
  );
});
