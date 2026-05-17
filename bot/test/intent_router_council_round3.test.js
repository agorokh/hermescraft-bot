// Council round 3 concrete pre-promotion tests (Gemini + Mistral).
//
// Mistral's 20-utterance compound-modifier corpus: utterances that SHOULD
// fire a skill (with the slot info ignored if necessary) — if >30% land in
// clarify, deadzone is too aggressive.
//
// Gemini's anaphora-on-failure: after a failed build, "another" must NOT
// replay; it should fall through so brain can apologize / kid clarifies.

import test from 'node:test';
import assert from 'node:assert/strict';
import { tryRoute, markLastSkillFailed, ACT_THRESHOLD, CLARIFY_THRESHOLD } from '../lib/intent_router_nlp.js';

function stubBot(name = 'Rosie') {
  return {
    username: name,
    entity: { position: { x: 5, y: 64, z: 5 }, yaw: 0 },
    players: { Adalynn: { entity: { type: 'player', username: 'Adalynn', position: { x: 0, y: 64, z: 0 } } } },
    entities: {},
    inventory: { items: () => [{ name: 'oak_planks', count: 64 }, { name: 'torch', count: 16 }, { name: 'bread', count: 8 }] },
    blockAt: () => ({ name: 'air' }),
  };
}

// ── COMPOUND-MODIFIER UTTERANCES (Mistral) ──────────────────────────────────
// Each should fire a skill (slot detail might be lost — we don't yet have
// slot extraction for color/shape/relative-pos, but the BASE INTENT must
// match). Acceptable: matched=true OR (matched=false AND zone=clarify) so
// brain can ask. Unacceptable: zone=oov (silent drop).
const COMPOUND_MODIFIER = [
  'build a tower but make it rainbow',
  'build a red tower please',
  'build a tower with blue stones',
  'build a tall stone tower with battlements',
  'build me a house with windows',
  'build me a small house with a red roof',
  'build a treehouse but big',
  'design a garden with poppies and dandelions and roses',
  'make me a tower like 10 blocks tall',
  'place a torch on the wall over there',
  'mine some stone but be quick',
  'come here but slowly',
  'follow me to the cave',
  'bring me some food and water',
  'build a shelter near the river',
  'build me a cozy little wooden cabin',
  'dig a hole like a moat around my house',
  'make a tower out of cobblestone please',
  'build me a treehouse in the oak forest',
  'place some torches around the perimeter',
];

test('NLP deadzone: clarify band sits below act threshold', () => {
  assert.ok(CLARIFY_THRESHOLD < ACT_THRESHOLD,
    `clarify (${CLARIFY_THRESHOLD}) must be < act (${ACT_THRESHOLD}) so deadzone routes to brain`);
});

test('compound-modifier corpus: ≥70% must fire OR clarify (no silent drops)', async () => {
  let fired = 0, clarify = 0, oov = 0;
  const oovCases = [];
  for (const body of COMPOUND_MODIFIER) {
    const r = await tryRoute(stubBot(), body, 'Adalynn');
    if (r.matched) fired++;
    else if (r.nlp_zone === 'clarify') clarify++;
    else if (r.nlp_zone === 'oov') { oov++; oovCases.push({ body, score: r.nlp_score, intent: r.nlp_intent }); }
  }
  const total = COMPOUND_MODIFIER.length;
  const handled = fired + clarify;
  const pct = 100 * handled / total;
  console.log(`  compound-modifier: fired=${fired} clarify=${clarify} oov=${oov} (${pct.toFixed(1)}% handled)`);
  if (oovCases.length > 0) {
    console.log('  silent drops (NLP returned oov):');
    for (const c of oovCases) console.log(`    score=${c.score?.toFixed(2)} intent=${c.intent || '-'} | ${c.body}`);
  }
  assert.ok(pct >= 70, `compound-modifier handling ${pct.toFixed(1)}% below Mistral 70% bar`);
  assert.equal(oov, 0, `compound-modifier had ${oov} silent OOV drops`);
});

// ── ANAPHORA-ON-FAILURE (Gemini) ────────────────────────────────────────────
test('repeat_last_action does NOT replay a failed action', async () => {
  const bot = stubBot('FailRepeatBot');
  await tryRoute(bot, 'build me a tower', 'Adalynn');
  markLastSkillFailed(bot);
  const replay = await tryRoute(bot, 'do it again', 'Adalynn');
  assert.notEqual(replay.nlp_zone, 'act', `repeat_last_action replayed failed skill: ${JSON.stringify(replay)}`);
});

test('anaphora does NOT replay a failed action', async () => {
  const bot = stubBot('FailReplayBot');
  const first = await tryRoute(bot, 'build me a tower', 'Adalynn');
  assert.equal(first.action, 'build_tower');
  // Simulate the action failing in production (no materials, blocked, etc.)
  markLastSkillFailed(bot);
  const replay = await tryRoute(bot, 'another one', 'Adalynn');
  // Anaphora must NOT have fired. Either: matched=false, OR matched via NLP
  // (not via anaphora) — i.e. zone != 'anaphora'.
  assert.notEqual(replay.nlp_zone, 'anaphora', `anaphora replayed failed action: zone=${replay.nlp_zone}`);
});

test('anaphora DOES replay a successful action', async () => {
  const bot = stubBot('SuccessReplayBot');
  const first = await tryRoute(bot, 'build me a tower', 'Adalynn');
  assert.equal(first.action, 'build_tower');
  // No failure mark — success default
  const replay = await tryRoute(bot, 'another one', 'Adalynn');
  assert.equal(replay.nlp_zone, 'anaphora', 'success path should still anaphora');
  assert.equal(replay.action, 'build_tower');
});

test('anaphora on "higher" after failed tower also blocked', async () => {
  const bot = stubBot('HigherFailBot');
  await tryRoute(bot, 'build me a tower', 'Adalynn');
  markLastSkillFailed(bot);
  const higher = await tryRoute(bot, 'higher', 'Adalynn');
  assert.notEqual(higher.nlp_zone, 'anaphora', `higher amended a failed action: zone=${higher.nlp_zone}`);
});
