import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHighLevelSkills } from '../lib/skills.js';

test('advanced build actions are registered and Foreman rejects missing materials', async () => {
  const fakeBot = {
    inventory: {
      items: () => [{ name: 'cobblestone', count: 2 }],
    },
  };
  const actions = registerHighLevelSkills({}, () => fakeBot);

  assert.equal(typeof actions.plan_advanced_build, 'function');
  assert.equal(typeof actions.build_schematic_advanced, 'function');

  const result = await actions.plan_advanced_build({ name: 'well', x: 10, y: 64, z: 10 });
  assert.match(result.result, /Foreman rejected "well"/);
  assert.match(result.result, /cobblestone need 24, have 2/);
});
