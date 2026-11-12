import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tryRoute as regexRoute } from '../lib/intent_router.js';
import { tryRoute as nlpRoute, resetContextBuffer, recordLastSkill } from '../lib/intent_router_nlp.js';

// Frozen descriptors from a983155: every mine_iron utterance and every
// corpus get/grab/fetch/bring-me phrase, with the same fixture below.
const baseline = JSON.parse(readFileSync(new URL('./fixtures/retrieval-a983.json', import.meta.url), 'utf8'));
function bot() {
  return { username: 'Rosie', entity: { position: { x: 0, y: 64, z: 0 } },
    players: { Kid: { entity: { username: 'Kid', type: 'player', position: { x: 1, y: 64, z: 0 } } } },
    entities: {}, blockAt: () => ({ name: 'air' }),
    inventory: { items: () => ['coal', 'diamond', 'bread', 'torch'].map(name => ({ name, count: 8 })).concat({ name: 'rose_bush', count: 3 }) },
    registry: { itemsByName: Object.fromEntries(['oak_log', 'stone', 'oak_planks', 'iron_ingot', 'gold_ingot', 'coal', 'diamond', 'raw_iron', 'raw_gold'].map(name => [name, {}])) } };
}

for (const router of ['regex', 'nlp']) {
  test(`${router}: preserve affected corpus descriptors from a983`, async () => {
    for (const { text, base } of baseline.filter(row => row.router === router)) {
      const b = bot();
      resetContextBuffer(b);
      const result = await (router === 'nlp' ? nlpRoute : regexRoute)(b, text, 'Kid', { dryRun: true });
      const descriptor = { matched: result.matched, ...(result.action ? { action: result.action, body: result.body } : {}) };
      // The new canonical-item handoff intentionally fills this formerly
      // unmatched regex case. NLP retains its existing stocked-food helper.
      const expected = router === 'regex' && text === 'bring me bread'
        ? { matched: true, action: 'give_to_player', body: { player: 'Kid', item: 'bread', count: 1 } } : base;
      assert.deepEqual(descriptor, expected, text);
    }
  });

  test(`${router}: crafted ore products remain exact handoffs, unknown products do not mine`, async () => {
    for (const [text, item] of [
      ['get me 8 iron ingots', 'iron_ingot'], ['bring me 8 gold ingot', 'gold_ingot'],
      ['give me 8 iron ingots', 'iron_ingot'], ['bring me 8 bread', 'bread'],
      ['get me 8 torch', 'torch'], ['fetch me 8 rose bush', 'rose_bush'],
    ]) {
      const result = await (router === 'nlp' ? nlpRoute : regexRoute)(bot(), text, 'Kid', { dryRun: true });
      assert.equal(result.action, 'give_to_player', text);
      assert.equal(result.body.count, 8, text);
      assert.equal(result.body.item, item, text);
    }
    for (const text of ['get me 8 oak moon blocks', 'bring me 8 iron moon blocks', 'give me 8 oak moon blocks']) {
      const result = await (router === 'nlp' ? nlpRoute : regexRoute)(bot(), text, 'Kid', { dryRun: true });
      assert.equal(result.matched, false, text);
    }
  });
}

test('NLP direct give route performs one emote pass and records one skill', async () => {
  const b = bot();
  let swings = 0;
  b.swingArm = () => { swings++; };
  const seed = recordLastSkill(b, 'give_items', 'give_to_player', { item: 'oak_planks', count: 1 }, 'seed');
  const result = await nlpRoute(b, 'give me a wave', 'Kid');
  assert.equal(swings, 3, 'one wave is three swings; dispatching twice would produce six');
  assert.equal(result.action, 'chat');
  assert.equal(result.skill_id, seed + 1, 'only one skill was recorded after the direct regex match');
});
