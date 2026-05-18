// Council round-2 stress tests (Gemini + Mistral concrete predictions):
// 1. Narrative poisoning — long kid stories that contain skill keywords
//    but are conversational/inhibitory (kid talking ABOUT building, not
//    asking the bot to build).
// 2. Panic intent bleed — telegraphic high-stress kid speech where the
//    correct intent is defend_me but keyword collisions could mis-route.
//
// If any of these false-positive a skill, the bot will "ghost-act" while
// the kid is still talking — breaks the friend illusion. Both councilors
// independently flagged this as the #1 remaining risk.

import test from 'node:test';
import assert from 'node:assert/strict';
import { tryRoute } from '../lib/intent_router_nlp.js';

function stubBot() {
  return {
    username: 'Rosie',
    entity: { position: { x: 5, y: 64, z: 5 }, yaw: 0 },
    players: { Adalynn: { entity: { type: 'player', username: 'Adalynn', position: { x: 0, y: 64, z: 0 } } } },
    entities: {},
    inventory: { items: () => [{ name: 'oak_planks', count: 64 }, { name: 'torch', count: 8 }] },
    blockAt: () => ({ name: 'air' }),
  };
}

// ── NARRATIVE POISONING (Gemini's prediction) ────────────────────────────────
// Long kid sentences containing skill keywords but where intent is
// conversational/inhibitory. MUST NOT fire any skill — the kid is talking,
// not commanding. False positive here = bot ghost-acts during flavor text.
const NARRATIVE = [
  "i'm really scared because that zombie is coming and i don't want you to attack him yet because i want to try my new sword first",
  "remember yesterday when you built that tower for me and then a creeper blew it up",
  "i was thinking maybe we could build a treehouse later when steve gets back",
  "my mom said i can't play minecraft if i don't finish my homework so don't build anything yet",
  "the diamonds in this cave are scary because of the lava but i want them so bad",
  "i love when you place torches everywhere it makes the cave so much brighter",
  "i was watching this youtube video where someone built an ice castle and it looked so cool",
  "do you remember the garden we made last week with all the poppies",
  "the treehouse is leaking again i think we built it in the wrong spot",
  "if a creeper came right now i would totally save you with my diamond sword",
];
for (const body of NARRATIVE) {
  test(`narrative: must NOT fire skill — "${body.slice(0, 40)}..."`, async () => {
    const r = await tryRoute(stubBot(), body, 'Adalynn');
    if (r.matched) {
      assert.fail(`narrative ghost-acted: action=${r.action} intent=${r.intent_name} score=${r.nlp_score?.toFixed(2)} zone=${r.nlp_zone}`);
    }
  });
}

// ── PANIC INTENT BLEED (Mistral's prediction) ────────────────────────────────
// Telegraphic high-stress kid speech. CORRECT routing: defend_me or attack_mob
// or stop. WRONG routing: explore_cave (keyword collision on "creeper"),
// build_shelter_for_night (collision on "hide"), etc.
const PANIC = [
  { body: 'HELP THERES A CREEPER BEHIND ME', acceptable: ['defend_me', 'attack_mob', 'stop'] },
  { body: 'SPIDER ON MY HEAD ROSIE', acceptable: ['defend_me', 'attack_mob', null] },
  { body: 'IM DYING HELP HELP', acceptable: ['defend_me', null] },
  { body: 'CREEPER NEXT TO ME', acceptable: ['defend_me', 'attack_mob', null] },
  { body: 'zombie zombie zombie kill it', acceptable: ['attack_mob', 'defend_me'] },
  { body: 'rosie HELP creeper coming', acceptable: ['defend_me', 'attack_mob'] },
  { body: 'no no no save me', acceptable: ['defend_me', 'stop', null] },
  { body: 'protect me theres a zombie', acceptable: ['defend_me', 'attack_mob'] },
];
for (const p of PANIC) {
  test(`panic: "${p.body}" routes safely`, async () => {
    const r = await tryRoute(stubBot(), p.body, 'Adalynn');
    // Acceptable: NOT matched (brain handles) OR matched to one of the safe intents
    if (r.matched) {
      assert.ok(
        p.acceptable.includes(r.intent_name) || p.acceptable.includes(r.action),
        `panic mis-routed: intent=${r.intent_name} action=${r.action} score=${r.nlp_score?.toFixed(2)} — expected one of ${JSON.stringify(p.acceptable)} or null`,
      );
    }
  });
}

// ── CONTEXTUAL MODIFIERS (anaphora / context buffer) ───────────────────────
// Snapshot of modifier routing after the context buffer shipped in
// intent_router_nlp.js. Prints behavior for operator sanity-checks.
test('context modifiers — anaphora behavior snapshot (no assertion)', async () => {
  const bot = stubBot();
  await tryRoute(bot, 'build me a tower', 'Adalynn');  // prime
  for (const body of ['higher', 'now another one', 'do that again', 'over there', 'it']) {
    const r = await tryRoute(bot, body, 'Adalynn');
    console.log(`  "${body}" → matched=${r.matched} action=${r.action || '-'} intent=${r.nlp_intent || '-'} score=${r.nlp_score?.toFixed(2) || '-'} zone=${r.nlp_zone}`);
  }
});
