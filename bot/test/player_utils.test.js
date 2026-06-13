import test from 'node:test';
import assert from 'node:assert/strict';
import {
  explicitSchematicBaseY,
  findPlayerEntity,
  normalizeBuildBaseY,
  normalizePlayerName,
  playerNameMatches,
  playerNameMatchesResolvedCollector,
  schematicBuildBaseY,
} from '../lib/player_utils.js';

function mockBot(blockAtFn) {
  return { blockAt: blockAtFn };
}

test('normalizePlayerName ignores Floodgate leading dot prefixes', () => {
  assert.equal(normalizePlayerName('DanceO3677'), 'danceo3677');
  assert.equal(normalizePlayerName('.DanceO3677'), 'danceo3677');
});

test('playerNameMatches only strips Floodgate prefix for bare requests', () => {
  assert.equal(playerNameMatches('.DanceO3677', 'DanceO3677'), true);
  assert.equal(playerNameMatches('DanceO3677', '.DanceO3677'), false);
});

test('playerNameMatchesResolvedCollector requires exact pickup confirmation after resolution', () => {
  assert.equal(playerNameMatchesResolvedCollector('.Alex', 'Alex', 'Alex'), false);
  assert.equal(playerNameMatchesResolvedCollector('Alex', 'Alex', 'Alex'), true);
  assert.equal(playerNameMatchesResolvedCollector('DanceO3677', 'DanceO3677', '.DanceO3677'), true);
  assert.equal(playerNameMatchesResolvedCollector('DanceO3677', '.DanceO3677', '.DanceO3677'), false);
  assert.equal(playerNameMatchesResolvedCollector('.DanceO3677', '.DanceO3677', '.DanceO3677'), true);
});

test('findPlayerEntity matches Floodgate-prefixed player roster names from bare input', () => {
  const entity = { username: '.DanceO3677', type: 'player' };
  const bot = {
    username: 'Rosie',
    players: {
      Rosie: { entity: { username: 'Rosie' } },
      '.DanceO3677': { entity },
    },
    entities: {},
  };
  assert.equal(findPlayerEntity(bot, 'DanceO3677'), entity);
});

test('findPlayerEntity prefers exact bare match over Floodgate fallback', () => {
  const bare = { username: 'Alex', type: 'player' };
  const floodgate = { username: '.Alex', type: 'player' };
  const bot = {
    username: 'Rosie',
    players: {
      Rosie: { entity: { username: 'Rosie' } },
      '.Alex': { entity: floodgate },
      Alex: { entity: bare },
    },
    entities: {},
  };
  assert.equal(findPlayerEntity(bot, 'Alex'), bare);
});

test('findPlayerEntity preserves explicit Floodgate prefix in collisions', () => {
  const bare = { username: 'Alex', type: 'player' };
  const floodgate = { username: '.Alex', type: 'player' };
  const bot = {
    username: 'Rosie',
    players: {
      Rosie: { entity: { username: 'Rosie' } },
      Alex: { entity: bare },
      '.Alex': { entity: floodgate },
    },
    entities: {},
  };
  assert.equal(findPlayerEntity(bot, '.Alex'), floodgate);
});

test('findPlayerEntity ignores null roster and entity entries', () => {
  const entity = { username: '.DanceO3677', type: 'player' };
  const bot = {
    username: 'Rosie',
    entity: null,
    players: {
      Rosie: { entity: { username: 'Rosie' } },
      Ghost: null,
    },
    entities: { 1: null, 2: entity },
  };
  assert.equal(findPlayerEntity(bot, 'DanceO3677'), entity);
});

test('findPlayerEntity matches bare player roster names from Floodgate-prefixed input', () => {
  const entity = { username: 'DanceO3677', type: 'player' };
  const bot = {
    username: 'Rosie',
    players: {
      Rosie: { entity: { username: 'Rosie' } },
      DanceO3677: { entity },
    },
    entities: {},
  };
  assert.equal(findPlayerEntity(bot, '.DanceO3677'), entity);
});

test('findPlayerEntity falls back to Floodgate-prefixed entity usernames', () => {
  const entity = { username: '.DanceO3677', type: 'player' };
  const bot = {
    entity: { username: 'Rosie' },
    username: 'Rosie',
    players: {},
    entities: { 42: entity },
  };
  assert.equal(findPlayerEntity(bot, 'DanceO3677'), entity);
});

test('normalizeBuildBaseY does not return above world ceiling', () => {
  const bot = mockBot((pos) => {
    if (pos.y === 319) return { name: 'stone', boundingBox: 'block' };
    if (pos.y === 320) return { name: 'air' };
    return { name: 'air' };
  });
  assert.equal(normalizeBuildBaseY(bot, 10, 10, 319), 319);
});

test('normalizeBuildBaseY skips canopy leaves and logs', () => {
  const bot = mockBot((pos) => {
    if (pos.y === 70) return { name: 'oak_leaves', boundingBox: 'block' };
    if (pos.y === 68) return { name: 'oak_log', boundingBox: 'block' };
    if (pos.y === 64) return { name: 'dirt', boundingBox: 'block' };
    return { name: 'air' };
  });
  assert.equal(normalizeBuildBaseY(bot, 10, 10, 65), 65);
});

test('normalizeBuildBaseY accepts clear log platforms', () => {
  const bot = mockBot((pos) => {
    if (pos.y === 68) return { name: 'oak_log', boundingBox: 'block' };
    if (pos.y === 64) return { name: 'dirt', boundingBox: 'block' };
    return { name: 'air' };
  });
  assert.equal(normalizeBuildBaseY(bot, 10, 10, 65), 69);
});

test('raised sky bridge base Y is clamped to world ceiling', () => {
  const bot = mockBot((pos) => {
    if (pos.y === 318) return { name: 'stone', boundingBox: 'block' };
    if (pos.y === 319) return { name: 'air' };
    return { name: 'air' };
  });
  assert.equal(schematicBuildBaseY(bot, 'sky_bridge', 'raised sky bridge', 10, 10, 319), 319);
});

test('schematicBuildBaseY honors clear requested gallery floor below stale elevated blocks', () => {
  const bot = mockBot((pos) => {
    if (pos.y === 69) return { name: 'oak_planks', boundingBox: 'block' };
    if (pos.y === 64) return { name: 'grass_block', boundingBox: 'block' };
    return { name: 'air' };
  });
  assert.equal(schematicBuildBaseY(bot, 'market_square', 'set up a market square here', 290, 288, 65), 65);
});

test('schematicBuildBaseY skips requested tree-canopy footing', () => {
  const bot = mockBot((pos) => {
    if (pos.y === 68) return { name: 'oak_log', boundingBox: 'block' };
    if (pos.y === 69 && pos.x === 10 && pos.z === 10) return { name: 'air' };
    if (pos.y === 70 && Math.abs(pos.x - 10) <= 1 && Math.abs(pos.z - 10) <= 1) {
      return { name: 'oak_leaves', boundingBox: 'block' };
    }
    if (pos.y === 64) return { name: 'grass_block', boundingBox: 'block' };
    return { name: 'air' };
  });
  assert.equal(schematicBuildBaseY(bot, 'well', 'build a well here', 10, 10, 69), 65);
});

test('explicit schematic base Y overrides terrain normalization for prepared gallery prompts', () => {
  const bot = mockBot((pos) => {
    if (pos.y === 70) return { name: 'oak_planks', boundingBox: 'block' };
    if (pos.y === 64) return { name: 'grass_block', boundingBox: 'block' };
    return { name: 'air' };
  });
  assert.equal(explicitSchematicBaseY('set up a market square at base y 65'), 65);
  assert.equal(schematicBuildBaseY(bot, 'market_square', 'set up a market square at base y 65', 290, 288, 65), 65);
  assert.equal(schematicBuildBaseY(bot, 'sky_bridge', 'build a raised sky bridge at base y 69', 262, 286, 65), 69);
});

test('explicit schematic base Y rejects out-of-world values instead of clamping', () => {
  assert.equal(explicitSchematicBaseY('build a market square at base y 999'), null);
  assert.equal(explicitSchematicBaseY('build a market square at base y -99'), null);
});

test('explicit schematic base Y is ignored for non-gallery schematics', () => {
  const bot = mockBot((pos) => {
    if (pos.y === 64) return { name: 'grass_block', boundingBox: 'block' };
    return { name: 'air' };
  });
  assert.equal(schematicBuildBaseY(bot, 'small_house', 'build a small house at base y 70', 10, 10, 65), 65);
});
