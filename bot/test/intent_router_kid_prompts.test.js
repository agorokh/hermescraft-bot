// Pinpoint test: do the 6 kid build prompts from
// scripts/test_player_build_design.js actually route to real build verbs?
//
// Why this test exists (post-mortem A/B run 2026-05-17):
//   N=2 cycles showed tower/house/garden/treehouse all scoring 0.00 —
//   100% chat-theater. Root cause was NOT brain behavior, it was that
//   the intent router's regexes didn't actually match the kids' phrasing.
//   This test runs each prompt through tryRoute() with a stub bot world
//   so we can see exactly which patterns miss, without spawning Paper.

import test from 'node:test';
import assert from 'node:assert/strict';
import { tryRoute } from '../lib/intent_router.js';
import { broadcastMentionsMe, stripMentionPrefix } from '../lib/chat.js';

function stubBot(senderName, senderPos = { x: 0, y: 64, z: 0 }) {
  const senderEntity = {
    type: 'player',
    username: senderName,
    position: { x: senderPos.x, y: senderPos.y, z: senderPos.z },
  };
  return {
    username: 'Rosie',
    entity: { position: { x: 5, y: 64, z: 5 }, yaw: 0 },
    players: { [senderName]: { entity: senderEntity } },
    entities: { '1': senderEntity },
    inventory: {
      items: () => [
        { name: 'oak_planks', count: 64 },
        { name: 'oak_log', count: 32 },
        { name: 'cobblestone', count: 64 },
        { name: 'torch', count: 16 },
      ],
    },
    blockAt: () => ({ name: 'air' }),
  };
}

// The exact 6 prompts from scripts/test_player_build_design.js — pulled
// verbatim including the "[as Adalynn]"/"[as SwimmerJay1995]" persona prefix
// applied by say().
const PROMPTS = [
  {
    id: 'tower',
    sender: 'Adalynn',
    // The router gets called with the body AFTER mention-stripping ("Rosie ").
    body: '[as Adalynn] can you build a 5-tall stone tower right here? square base, stack it up please',
    expect_actions: ['build_tower', 'build_schematic'],
  },
  {
    id: 'house',
    sender: 'Adalynn',
    body: '[as Adalynn] can you build a small house for me here? cozy little one',
    expect_actions: ['build_schematic'],
  },
  {
    id: 'mine',
    sender: 'SwimmerJay1995',
    body: '[as SwimmerJay1995] can you mine 8 cobblestone and bring them to me please',
    expect_actions: ['collect', 'bg_collect'],
  },
  {
    id: 'torch',
    sender: 'Adalynn',
    body: '[as Adalynn] can you place a torch right in front of me? dark spot',
    expect_actions: ['place_near_player'],
  },
  {
    id: 'garden',
    sender: 'Adalynn',
    body: '[as Adalynn] design a small flower garden next to me — poppies and dandelions please',
    expect_actions: ['build_schematic'],
  },
  {
    id: 'treehouse',
    sender: 'Adalynn',
    body: '[as Adalynn] can you build a treehouse here? use the oak in your inventory',
    expect_actions: ['build_schematic'],
  },
];

// Full pipeline test: mention detection → strip → router. This is what
// actually happens in server.js for broadcast chats. The previous version
// of this file only tested tryRoute() in isolation; it passed while the
// live game still scored 0.00 because broadcastMentionsMe rejected every
// "[as Adalynn] Rosie ..." prompt and the router never even ran.
//
// Each prompt below is sent with "Rosie " or "Steve " prepended to mirror
// the test_player's say() format.
// Regression: build_tower + build_schematic must NOT return null just
// because the kid's player entity hasn't synced into bot.players yet
// (right after /tp, view-distance edge, server lag). Live A/B run on
// 2026-05-18 showed 4/5 build prompts falling through to the brain
// because senderEntity was null at handler time. The fix routes them
// to anchor on bot.entity.position as a fallback.
test('build handlers anchor on bot position when sender entity is unresolvable', async () => {
  const botNoPlayers = {
    username: 'Rosie',
    entity: { position: { x: 100, y: 64, z: 100 }, yaw: 0 },
    players: {}, // sender NOT in roster — sync lag scenario
    entities: {},
    inventory: {
      items: () => [
        { name: 'oak_planks', count: 64 },
        { name: 'cobblestone', count: 64 },
      ],
    },
    blockAt: () => ({ name: 'air' }),
  };
  const buildPrompts = [
    { id: 'tower', body: 'can you build a 5-tall stone tower right here?', expect: 'build_tower' },
    { id: 'house', body: 'can you build a small house for me here?', expect: 'build_schematic' },
    { id: 'treehouse', body: 'can you build a treehouse here?', expect: 'build_schematic' },
    { id: 'garden', body: 'design a small flower garden next to me', expect: 'build_schematic' },
  ];
  for (const bp of buildPrompts) {
    const route = await tryRoute(botNoPlayers, bp.body, 'Adalynn');
    assert.ok(route.matched, `${bp.id} must route even with empty player roster (got matched=false)`);
    assert.equal(route.action, bp.expect, `${bp.id} expected action=${bp.expect} got ${route.action}`);
  }
});

test('hotel-sized build prompts route to advanced Foreman pipeline', async () => {
  const route = await tryRoute(stubBot('Adalynn'), 'Rosie build me a grand hotel right here', 'Adalynn');
  assert.ok(route.matched, 'hotel prompt must match router');
  assert.equal(route.action, 'build_schematic_advanced');
  assert.equal(route.body.name, 'grand_hotel');
});

test('star tower and spell tower route to gallery schematics not procedural tower', async () => {
  for (const [body, expected] of [
    ['Rosie build a star tower here', 'crystal_observatory'],
    ['Rosie build a spell tower', 'wizard_tower'],
  ]) {
    const route = await tryRoute(stubBot('Adalynn'), body, 'Adalynn');
    assert.ok(route.matched, `${body} must match router`);
    assert.equal(route.action, 'build_schematic_advanced');
    assert.equal(route.body.name, expected);
  }
});

test('gallery regex matches compact schematic aliases without spaces', async () => {
  for (const [body, expected] of [
    ['Rosie build a skybridge here', 'sky_bridge'],
    ['Rosie make a beaconplaza', 'beacon_plaza'],
  ]) {
    const route = await tryRoute(stubBot('Adalynn'), body, 'Adalynn');
    assert.ok(route.matched, `${body} must match router`);
    assert.equal(route.body.name, expected);
  }
});

test('gallery build prompts route to advanced Foreman pipeline', async () => {
  for (const [body, expected] of [
    ['Rosie build a crystal observatory here', 'crystal_observatory'],
    ['Rosie make me a wizard tower', 'wizard_tower'],
    ['Rosie set up a marketplace', 'market_square'],
    ['Rosie build a sky bridge', 'sky_bridge'],
    ['Rosie make a beacon plaza', 'beacon_plaza'],
  ]) {
    const route = await tryRoute(stubBot('Adalynn'), body, 'Adalynn');
    assert.ok(route.matched, `${body} must match router`);
    assert.equal(route.action, 'build_schematic_advanced');
    assert.equal(route.body.name, expected);
  }
});

test('schematic routes normalize stale low player Y to nearby solid ground', async () => {
  const bot = stubBot('Adalynn', { x: 260, y: 63, z: 286 });
  bot.blockAt = (pos) => {
    if (pos.x === 262 && pos.z === 286 && pos.y === 64) return { name: 'grass_block', boundingBox: 'block' };
    return { name: 'air', boundingBox: 'empty' };
  };
  const route = await tryRoute(bot, 'Rosie build a sky bridge here', 'Adalynn');
  assert.ok(route.matched, 'sky bridge prompt must route');
  assert.equal(route.action, 'build_schematic_advanced');
  assert.equal(route.body.name, 'sky_bridge');
  assert.equal(route.body.y, 65);
});

test('schematic routes lift low surface Y when target chunk readback is missing', async () => {
  const bot = stubBot('Adalynn', { x: 260, y: 63, z: 286 });
  bot.blockAt = () => null;
  const route = await tryRoute(bot, 'Rosie build a sky bridge here', 'Adalynn');
  assert.ok(route.matched, 'sky bridge prompt must route');
  assert.equal(route.action, 'build_schematic_advanced');
  assert.equal(route.body.name, 'sky_bridge');
  assert.equal(route.body.y, 65);
});

for (const p of PROMPTS) {
  test(`kid prompt "${p.id}" — full pipeline (mention + strip + route)`, async () => {
    const target = p.expect_actions.includes('collect') ? 'Steve' : 'Rosie';
    // What test_player_build_design.js actually puts on the wire:
    const wireBody = `${target} ${p.body.replace(/^\[as [^\]]+\]\s*/, '')}`;
    // But also test with the "[as Adalynn] Rosie ..." form the harness
    // used before 2026-05-18 to catch the regression on the next prompt-prefix
    // experiment.
    const wireBodyWithAnno = `[as ${p.sender}] ${target} ${p.body.replace(/^\[as [^\]]+\]\s*/, '')}`;

    for (const variant of [wireBody, wireBodyWithAnno]) {
      const matched = broadcastMentionsMe(variant, target);
      assert.ok(
        matched,
        `mention detection failed for variant="${variant}" target="${target}" — router would never fire in live game`,
      );
      const stripped = stripMentionPrefix(variant, matched);
      const bot = stubBot(p.sender);
      const route = await tryRoute(bot, stripped, p.sender);
      assert.ok(
        route.matched,
        `prompt "${p.id}" (variant="${variant}", stripped="${stripped}") did not match any intent — kid would get chat-theater`,
      );
      assert.ok(
        p.expect_actions.includes(route.action),
        `prompt "${p.id}" stripped="${stripped}" matched intent="${route.intent_name}" but action="${route.action}" not in expected ${JSON.stringify(p.expect_actions)}`,
      );
    }
  });
}
