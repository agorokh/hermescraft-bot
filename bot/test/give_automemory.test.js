import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Exercise the actual server consumer without starting its network listeners.
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = server.indexOf('        const _origGiveToPlayer =');
const source = server.slice(start, server.indexOf('        const _origFindBlocks =', start));
const install = new Function('ACTIONS', 'autoRememberFact', source);

function transfer(tossed, pickup_confirmed) {
  return { result: 'Tossed items', item_transfer: { item: 'oak_planks', requested: 8, tossed, pickup_confirmed } };
}

for (const [label, receipt, expected] of [
  ['confirmed partial', transfer(3, true), 'Gave 3 oak_planks to Kid.'],
  ['unconfirmed partial', transfer(3, false), 'Tossed 3 oak_planks toward Kid. Pickup unconfirmed.'],
  ['default single item', transfer(1, true), 'Gave 1 oak_planks to Kid.'],
]) {
  test(`give automemory: ${label} records the performed transfer`, async () => {
    const facts = [];
    const actions = { give_to_player: async () => receipt };
    install(actions, fact => facts.push(fact));
    install(actions, fact => facts.push(fact));
    const body = { item: 'oak_planks', player: 'Kid', ...(label === 'default single item' ? {} : { count: 8 }) };
    assert.equal(await actions.give_to_player(body), receipt);
    assert.deepEqual(facts, [expected]);
  });
}

test('give automemory: missing, failed or invalid receipts do not invent a transfer', async () => {
  for (const receipt of [
    { result: 'Gave 8 oak_planks to Kid.' },
    { error: 'Could not toss' }, transfer(0, false), transfer(-1, true),
    transfer(1.5, true), transfer(3, undefined),
  ]) {
    const facts = [];
    const actions = { give_to_player: async () => receipt };
    install(actions, fact => facts.push(fact));
    assert.equal(await actions.give_to_player({ item: 'oak_planks', player: 'Kid', count: 8 }), receipt);
    assert.deepEqual(facts, [], JSON.stringify(receipt));
  }
});
