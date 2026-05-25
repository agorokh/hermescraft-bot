import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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

test('Foreman approves stocked grand_hotel plans', async () => {
  const fakeBot = {
    inventory: {
      items: () => [
        { name: 'cobblestone', count: 215 },
        { name: 'oak_planks', count: 449 },
        { name: 'glass_pane', count: 32 },
        { name: 'torch', count: 9 },
        { name: 'oak_fence', count: 47 },
      ],
    },
  };
  const actions = registerHighLevelSkills({}, () => fakeBot);

  const result = await actions.plan_advanced_build({ name: 'grand_hotel', x: 10, y: 64, z: 10 });
  assert.match(result.result, /Foreman approved "grand_hotel"/);
  assert.match(result.result, /752 blocks/);
  assert.match(result.result, /outside-footprint scaffold cells/);
});

test('trusted setblock auth bypasses survival material checks for op companions', async () => {
  const prior = process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH;
  process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH = '1';
  try {
    const fakeBot = {
      inventory: {
        items: () => [],
      },
    };
    const actions = registerHighLevelSkills({}, () => fakeBot);

    const result = await actions.plan_advanced_build({ name: 'grand_hotel', x: 10, y: 64, z: 10 });
    assert.match(result.result, /Foreman approved "grand_hotel"/);
    assert.doesNotMatch(result.result, /missing materials/);
  } finally {
    if (prior == null) {
      delete process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH;
    } else {
      process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH = prior;
    }
  }
});

test('setblock verification ignores unrelated generic command failures', async () => {
  const prior = process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH;
  process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH = '1';
  const blocks = new Map();
  class FakeBot extends EventEmitter {
    constructor() {
      super();
      this.inventory = { items: () => [] };
      this.entity = { position: { x: 0, y: 64, z: 0 } };
      this.username = 'Hermes';
      this._stopGeneration = 0;
    }

    chat(command) {
      const match = command.match(/^\/setblock\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)/);
      if (!match) return;
      const [, x, y, z, block] = match;
      queueMicrotask(() => {
        this.emit('message', { toString: () => 'Some unrelated task failed and is not allowed' }, 'system');
      });
      setTimeout(() => {
        blocks.set(`${x},${y},${z}`, block);
        this.emit('message', { toString: () => `Changed the block at ${x}, ${y}, ${z}` }, 'system');
      }, 5);
    }

    blockAt(pos) {
      return { name: blocks.get(`${pos.x},${pos.y},${pos.z}`) || 'air', boundingBox: 'empty' };
    }
  }

  try {
    const fakeBot = new FakeBot();
    const actions = registerHighLevelSkills({}, () => fakeBot);

    const result = await actions.build_schematic({ name: 'well', x: 10, y: 64, z: 10 });
    assert.match(result.result, /Built schematic "well"/);
  } finally {
    if (prior == null) {
      delete process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH;
    } else {
      process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH = prior;
    }
  }
});
