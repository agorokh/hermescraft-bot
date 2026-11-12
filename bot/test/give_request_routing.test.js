import test from 'node:test';
import assert from 'node:assert/strict';
import { tryRoute as regexRoute } from '../lib/intent_router.js';
import { tryRoute as nlpRoute } from '../lib/intent_router_nlp.js';

function bot({ stocked = true } = {}) {
  return {
    username: 'Rosie',
    entity: { position: { x: 0, y: 64, z: 0 } },
    players: { Arsenyzzz: { entity: { username: 'Arsenyzzz', type: 'player', position: { x: 1, y: 64, z: 0 } } } },
    entities: {},
    registry: { itemsByName: { oak_planks: {}, spruce_planks: {}, oak_log: {}, stone: {}, torch: {} } },
    inventory: { items: () => stocked ? [{ name: 'oak_planks', count: 64 }, { name: 'spruce_planks', count: 16 }] : [] },
    blockAt: () => ({ name: 'air' }),
  };
}

test('regex stop remains ahead of a compound give request', async () => {
  const result = await regexRoute(bot(), 'give me 8 oak planks but stop building', 'Arsenyzzz');
  assert.equal(result.action, 'stop');
});

for (const [name, route] of [['regex', regexRoute], ['NLP', nlpRoute]]) {
  test(`${name}: exact live singular/plural give requests preserve planks and eight`, async () => {
    for (const text of ['Rosie give me 8 oak plank', 'Rosie give me 8 oak planks', 'give me 8 oak plank', 'give me 8 oak planks']) {
      const result = await route(bot(), text, 'Arsenyzzz');
      assert.equal(result.matched, true, text);
      assert.equal(result.action, 'give_to_player', text);
      assert.deepEqual(result.body, { player: 'Arsenyzzz', item: 'oak_planks', count: 8 }, text);
    }
  });

  test(`${name}: missing inventory never changes a give request into gathering logs`, async () => {
    const result = await route(bot({ stocked: false }), 'Rosie give me 8 oak plank', 'Arsenyzzz');
    assert.equal(result.action, 'give_to_player');
    assert.deepEqual(result.body, { player: 'Arsenyzzz', item: 'oak_planks', count: 8 });
  });

  test(`${name}: canonical item and explicit quantity survive polite give phrasing`, async () => {
    const result = await route(bot(), 'Could you please give me 32 spruce planks?', 'Arsenyzzz');
    assert.equal(result.action, 'give_to_player');
    assert.deepEqual(result.body, { player: 'Arsenyzzz', item: 'spruce_planks', count: 32 });
  });

  test(`${name}: an unknown explicit give item falls through instead of mining its material word`, async () => {
    const result = await route(bot(), 'give me 8 oak moon blocks', 'Arsenyzzz');
    assert.equal(result.matched, false);
  });

  test(`${name}: invalid explicit give quantities cannot become gifts or mining`, async () => {
    for (const count of [0, -1, 1.5]) {
      const result = await route(bot(), `give me ${count} oak planks`, 'Arsenyzzz');
      assert.equal(result.matched, false);
    }
  });

  test(`${name}: extending a stone platform is not an instruction to gather stone`, async () => {
    const result = await route(bot(), 'please extend my island with a flat stone platform beside me', 'Arsenyzzz');
    assert.notEqual(result.action, 'collect');
    assert.notEqual(result.action, 'bg_collect');
  });

  test(`${name}: actual gathering requests still gather the named resource`, async () => {
    const result = await route(bot(), 'mine 8 oak logs', 'Arsenyzzz');
    assert.equal(result.action, 'collect');
    assert.deepEqual(result.body, { block: 'oak_log', count: 8 });
  });

  test(`${name}: negated or recalled give text cannot mutate inventory or mine`, async () => {
    for (const text of ["don't give me 8 oak planks", 'remember when you gave me 8 oak planks', 'if I asked you to give me 8 oak planks, what would you do?']) {
      const result = await route(bot(), text, 'Arsenyzzz');
      assert.notEqual(result.action, 'give_to_player', text);
      assert.notEqual(result.action, 'collect', text);
      assert.notEqual(result.action, 'bg_collect', text);
    }
  });
}
