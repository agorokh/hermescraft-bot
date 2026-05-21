// Survival intent routing — pins review fixes for cook-before-fish ordering,
// return_home mark keys, and feed_player sender binding.

import test from 'node:test';
import assert from 'node:assert/strict';
import { tryRoute } from '../lib/intent_router.js';

function stubBot(senderName = 'Adalynn') {
  const senderEntity = {
    type: 'player',
    username: senderName,
    position: { x: 0, y: 64, z: 0 },
  };
  return {
    username: 'Rosie',
    entity: { position: { x: 5, y: 64, z: 5 }, yaw: 0 },
    players: { [senderName]: { entity: senderEntity } },
    entities: { '1': senderEntity },
    inventory: { items: () => [] },
    blockAt: () => ({ name: 'air' }),
  };
}

const CASES = [
  { body: 'cook some fish please', expect: 'cook_food' },
  { body: "let's fish", expect: 'fish_for_food' },
  { body: 'can you fish', expect: 'fish_for_food' },
  { body: 'go catch some fish', expect: 'fish_for_food' },
  { body: 'harvest the wheat', expect: 'farm_food' },
  { body: 'head home', expect: 'return_home' },
  { body: "i'm hungry", expect: 'feed_player', sender: 'Adalynn' },
  { body: "it's getting dark", expect: 'build_shelter_for_night' },
  { body: 'build a safe house', expect: 'build_shelter_for_night' },
  { body: 'build me a safe house', expect: 'build_shelter_for_night' },
  { body: 'harvest the carrots', expect: 'farm_food' },
];

for (const { body, expect, sender = 'Adalynn' } of CASES) {
  test(`routes "${body}" → ${expect}`, async () => {
    const route = await tryRoute(stubBot(sender), body, sender);
    assert.equal(route.matched, true, JSON.stringify(route));
    assert.equal(route.action, expect);
    if (expect === 'feed_player') {
      assert.equal(route.body.player, sender);
    }
  });
}

test('cook fish does not route to fish_for_food', async () => {
  const route = await tryRoute(stubBot(), 'cook fish for dinner', 'Adalynn');
  assert.equal(route.action, 'cook_food');
});
