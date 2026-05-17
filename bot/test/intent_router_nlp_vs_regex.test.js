// Head-to-head: NLP.js router (intent_router_nlp.js, 503-utterance corpus)
// vs regex router (intent_router.js, 42 hand-rolled patterns).
//
// Acceptance bar for shipping the NLP router as default: it must match the
// regex on the canonical 6 kid prompts AND correctly REJECT out-of-vocab
// inputs that the regex would also reject (so the brain still owns free chat).

import test from 'node:test';
import assert from 'node:assert/strict';
import { tryRoute as tryRegex } from '../lib/intent_router.js';
import { tryRoute as tryNlp, MATCH_THRESHOLD } from '../lib/intent_router_nlp.js';
import { broadcastMentionsMe, stripMentionPrefix } from '../lib/chat.js';

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
    inventory: {
      items: () => [
        { name: 'oak_planks', count: 64 },
        { name: 'oak_log', count: 32 },
        { name: 'cobblestone', count: 64 },
        { name: 'torch', count: 16 },
        { name: 'poppy', count: 16 },
      ],
    },
    blockAt: () => ({ name: 'air' }),
  };
}

// Canonical 6 kid prompts from scripts/test_player_build_design.js, exactly
// as they appear on the wire after the test_player's say() wrapper applies
// the "[as Adalynn]" persona prefix and the chat handler strips the "Rosie "
// mention prefix.
const KID_PROMPTS = [
  { id: 'tower', body: 'can you build a 5-tall stone tower right here? square base, stack it up please', expect_action: 'build_tower', sender: 'Adalynn' },
  { id: 'house', body: 'can you build a small house for me here? cozy little one', expect_action: 'build_schematic', sender: 'Adalynn' },
  { id: 'mine', body: 'can you mine 8 cobblestone and bring them to me please', expect_action: 'collect', sender: 'SwimmerJay1995' },
  { id: 'torch', body: 'can you place a torch right in front of me? dark spot', expect_action: 'place_near_player', sender: 'Adalynn' },
  { id: 'garden', body: 'design a small flower garden next to me — poppies and dandelions please', expect_action: 'build_schematic', sender: 'Adalynn' },
  { id: 'treehouse', body: 'can you build a treehouse here? use the oak in your inventory', expect_action: 'build_schematic', sender: 'Adalynn' },
];

// Out-of-vocab chats the brain should handle (not the router). Both routers
// must REJECT these. If NLP.js mis-classifies one above MATCH_THRESHOLD,
// we lose conversational coverage — fix by adding the OOV to the
// "none" intent training or tightening threshold.
const OOV_PROMPTS = [
  "what's the weather today",
  "do you remember when we made that castle yesterday",
  "i'm bored what should we do",
  "tell me a joke",
  "is steve your best friend",
];

for (const p of KID_PROMPTS) {
  test(`[NLP] kid prompt "${p.id}" routes to ${p.expect_action}`, async () => {
    const route = await tryNlp(stubBot(p.sender), p.body, p.sender);
    assert.ok(route.matched, `NLP did not match (intent=${route.nlp_intent} score=${route.nlp_score?.toFixed(2)})`);
    assert.equal(route.action, p.expect_action, `expected ${p.expect_action}, got ${route.action} (intent=${route.intent_name})`);
    assert.ok(route.nlp_score >= MATCH_THRESHOLD, `confidence ${route.nlp_score?.toFixed(2)} below threshold ${MATCH_THRESHOLD}`);
  });
}

for (const oov of OOV_PROMPTS) {
  test(`[NLP] OOV "${oov}" falls through to brain`, async () => {
    const route = await tryNlp(stubBot(), oov, 'Adalynn');
    assert.equal(route.matched, false,
      `OOV unexpectedly matched intent=${route.intent_name} action=${route.action} score=${route.nlp_score?.toFixed(2)} — brain loses conversational coverage`);
  });
}

// Full pipeline parity test: NLP router must handle the same broadcast flow
// (mention detection → strip → route) that regex does for live game chat.
for (const p of KID_PROMPTS) {
  test(`[NLP] pipeline parity "${p.id}" — mention+strip+route`, async () => {
    const target = p.expect_action === 'collect' ? 'Steve' : 'Rosie';
    const wireBody = `[as ${p.sender}] ${target} ${p.body}`;
    const matched = broadcastMentionsMe(wireBody, target);
    assert.ok(matched, 'mention detection failed');
    const stripped = stripMentionPrefix(wireBody, matched);
    const route = await tryNlp(stubBot(p.sender), stripped, p.sender);
    assert.ok(route.matched, `NLP did not match after strip (intent=${route.nlp_intent} score=${route.nlp_score?.toFixed(2)})`);
    assert.equal(route.action, p.expect_action);
  });
}

// Head-to-head: where NLP and regex disagree, surface the diff. We don't
// fail on disagreement — just print it so the operator can sanity-check.
test('[NLP vs regex] agreement report on kid prompts', async () => {
  const disagreements = [];
  for (const p of KID_PROMPTS) {
    const r = await tryRegex(stubBot(p.sender), p.body, p.sender);
    const n = await tryNlp(stubBot(p.sender), p.body, p.sender);
    if (r.action !== n.action) {
      disagreements.push(`${p.id}: regex=${r.action || 'none'} nlp=${n.action || 'none'} (nlp_score=${n.nlp_score?.toFixed(2)})`);
    }
  }
  if (disagreements.length > 0) {
    console.log('  disagreements:\n    ' + disagreements.join('\n    '));
  } else {
    console.log('  full agreement on canonical 6 prompts');
  }
  // This test always passes — purely diagnostic.
});
