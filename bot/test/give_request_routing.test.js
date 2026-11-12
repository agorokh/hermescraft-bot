import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tryRoute as regexRoute } from '../lib/intent_router.js';
import { tryRoute as nlpRoute, resetContextBuffer } from '../lib/intent_router_nlp.js';

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
  test(`${name}: stop wins over a compound give request`, async () => {
    const result = await route(bot(), 'give me 8 oak planks but stop building', 'Arsenyzzz', { dryRun: true });
    assert.equal(result.action, 'stop');
  });

  test(`${name}: retrieving crafted items preserves handoff item and count without mining`, async () => {
    for (const text of ['get me 8 oak planks', 'bring me 8 oak plank', 'fetch me 8 oak planks', 'grab me 8 oak planks', 'go get me 8 oak planks', "let's get me 8 oak planks", 'lets get me 8 oak planks']) {
      const result = await route(bot({ stocked: false }), text, 'Arsenyzzz', { dryRun: true });
      assert.equal(result.action, 'give_to_player', text);
      assert.deepEqual(result.body, { player: 'Arsenyzzz', item: 'oak_planks', count: 8 }, text);
    }
  });

  test(`${name}: explicit give cannot fall back to gathering or building`, async () => {
    for (const text of ['give me 8 oak moon blocks', 'give me a house built from stone', 'give me 0 poppy', 'give me -1 poppy', 'give me 1.5 poppy']) {
      const result = await route(bot(), text, 'Arsenyzzz', { dryRun: true });
      assert.equal(result.matched, false, text);
    }
  });

  test(`${name}: raw-resource retrieval still gathers`, async () => {
    for (const text of ['get me 8 oak logs', 'bring me 8 stone']) {
      const result = await route(bot(), text, 'Arsenyzzz', { dryRun: true });
      assert.equal(result.action, 'collect', text);
      assert.equal(result.body.count, 8, text);
    }
  });

  test(`${name}: raw-resource retrieval keeps corpus quantity modifiers`, async () => {
    for (const [text, block, count] of [
      ['bring me a few stone', 'stone', 4],
      ['get me like 5 wood', 'oak_log', 5],
      ['get me a bunch of wood', 'oak_log', 4],
      ['get me a stack of wood', 'oak_log', 4],
      ['get a stack of wood', 'oak_log', 4],
    ]) {
      const result = await route(bot(), text, 'Arsenyzzz', { dryRun: true });
      assert.equal(result.action, 'collect', text);
      assert.deepEqual(result.body, { block, count }, text);
    }
  });

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

  test(`${name}: explicit canonical flower quantity survives the default flower helper`, async () => {
    const b = bot();
    b.registry.itemsByName.poppy = {};
    const result = await route(b, 'give me 8 poppy', 'Arsenyzzz', { dryRun: true });
    assert.deepEqual(result.body, { player: 'Arsenyzzz', item: 'poppy', count: 8 });
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
    for (const text of ['please extend my island with a flat stone platform beside me', 'i need a flat stone platform beside me']) {
      const result = await route(bot(), text, 'Arsenyzzz');
      assert.notEqual(result.action, 'collect', text);
      assert.notEqual(result.action, 'bg_collect', text);
    }
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

test('NLP: dedicated give phrasing keeps position, light and stocked-flower routes', async () => {
  const cases = [
    ['give me ur position', 'chat', { text: 'at 0 64 0' }],
    ['give me lightttt', 'place_near_player', { player: 'Arsenyzzz', item: 'torch', direction: 'side' }],
    ...['a rose', 'a tulip', 'a flowerr', 'the pretty one', 'alll the flowers', 'a poppy'].map(phrase =>
      [`give me ${phrase}`, 'give_to_player', { player: 'Arsenyzzz', item: 'rose_bush', count: 1 }]),
  ];
  for (const [text, action, body] of cases) {
    const b = bot();
    b.registry.itemsByName.poppy = {};
    b.inventory.items = () => [{ name: 'rose_bush', count: 3 }];
    resetContextBuffer();
    const result = await nlpRoute(b, text, 'Arsenyzzz', { dryRun: true });
    assert.equal(result.action, action, text);
    assert.deepEqual(result.body, body, text);
  }
});

test('NLP: previously supported gathering survives kid stretching and polite shorthand', async () => {
  const cases = [
    ['go get wood', 'oak_log'], ['go chop wood', 'oak_log'],
    ['i need wooood', 'oak_log'], ['i need logsss', 'oak_log'],
    ['i need stoneee', 'stone'], ['i need lottttts of wood', 'oak_log'],
    ['wood pls', 'oak_log'], ['cobble pls', 'cobblestone'], ['sand pls', 'sand'],
    ['wood wood wood', 'oak_log'],
  ];
  for (const [text, block] of cases) {
    resetContextBuffer();
    const result = await nlpRoute(bot(), text, 'Arsenyzzz', { dryRun: true });
    assert.equal(result.action, 'collect', text);
    assert.deepEqual(result.body, { block, count: 4 }, text);
  }
});

test('NLP: unsupported tree-only requests still defer without inventing a resource', async () => {
  for (const text of ['go chop trees', 'go chop a tree']) {
    resetContextBuffer();
    const result = await nlpRoute(bot(), text, 'Arsenyzzz', { dryRun: true });
    assert.equal(result.matched, false, text);
  }
});

test('NLP: preserve every baseline-positive gather_block training utterance', async () => {
  const corpus = JSON.parse(readFileSync(new URL('../lib/intent_corpus.json', import.meta.url), 'utf8'));
  // a983's extractor could not resolve these two tree-only phrases. Every
  // other utterance in this intent dispatched collect on that baseline.
  const unresolvedAtBaseline = new Set(['go chop trees', 'go chop a tree']);
  for (const text of corpus.data.find(entry => entry.intent === 'gather_block').utterances) {
    resetContextBuffer();
    const result = await nlpRoute(bot(), text, 'Arsenyzzz', { dryRun: true });
    if (unresolvedAtBaseline.has(text)) assert.equal(result.matched, false, text);
    else assert.equal(result.action, 'collect', text);
  }
});
