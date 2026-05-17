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

for (const p of PROMPTS) {
  test(`kid prompt "${p.id}" routes to a build action`, async () => {
    const bot = stubBot(p.sender);
    const route = await tryRoute(bot, p.body, p.sender);
    assert.ok(
      route.matched,
      `prompt "${p.id}" did not match any intent — kid would get chat-theater. body="${p.body}"`,
    );
    assert.ok(
      p.expect_actions.includes(route.action),
      `prompt "${p.id}" matched intent="${route.intent_name}" but action="${route.action}" not in expected ${JSON.stringify(p.expect_actions)}`,
    );
  });
}
