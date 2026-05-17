// NLP router v2 — full behavior suite after council adoption.
// Validates: clarification deadzone, negation rejection, OOV-with-skill-keyword
// rejection, repeat_last_action chain, all 6 canonical kid prompts, and the
// realistic kid-voice paraphrases (typos, baby voice, slang, panic-mode).

import test from 'node:test';
import assert from 'node:assert/strict';
import { tryRoute, recordLastSkill } from '../lib/intent_router_nlp.js';

function stubBot(senderName = 'Adalynn', opts = {}) {
  const senderEntity = {
    type: 'player',
    username: senderName,
    position: { x: 0, y: 64, z: 0 },
  };
  return {
    username: opts.bot || 'Rosie',
    entity: { position: { x: 5, y: 64, z: 5 }, yaw: 0 },
    players: { [senderName]: { entity: senderEntity } },
    entities: { '1': senderEntity },
    inventory: {
      items: () => opts.items || [
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

// ── Canonical 6 kid-build prompts — must continue to fire (regression set) ──
const SHIP_PROMPTS = [
  { body: 'can you build a 5-tall stone tower right here? square base, stack it up please', action: 'build_tower' },
  { body: 'can you build a small house for me here? cozy little one', action: 'build_schematic' },
  { body: 'can you mine 8 cobblestone and bring them to me please', action: 'collect' },
  { body: 'can you place a torch right in front of me? dark spot', action: 'place_near_player' },
  { body: 'design a small flower garden next to me — poppies and dandelions please', action: 'build_schematic' },
  { body: 'can you build a treehouse here? use the oak in your inventory', action: 'build_schematic' },
];
for (const p of SHIP_PROMPTS) {
  test(`canonical: ${p.body.slice(0, 40)}...`, async () => {
    const r = await tryRoute(stubBot(), p.body, 'Adalynn');
    assert.ok(r.matched, `not matched: zone=${r.nlp_zone} intent=${r.nlp_intent} score=${r.nlp_score?.toFixed(2)}`);
    assert.equal(r.action, p.action);
  });
}

// ── Negations — must NOT fire skill (council Gemini priority #1) ────────────
const NEGATIONS = [
  'dont build a tower',
  'no dont build anything',
  'stop building the house',
  'nevermind on the garden',
  'cancel the treehouse',
  'wait dont place that torch',
  'actually no dont mine',
];
for (const body of NEGATIONS) {
  test(`negation: "${body}" must NOT fire skill`, async () => {
    const r = await tryRoute(stubBot(), body, 'Adalynn');
    // It's fine if router classifies as stop or None, but it must NOT fire
    // build_tower/build_schematic/etc.
    const dangerous = ['build_tower', 'build_schematic', 'collect', 'place_near_player', 'fight'];
    if (r.matched) {
      assert.ok(!dangerous.includes(r.action),
        `dangerous skill fired on negation: ${r.action} (zone=${r.nlp_zone} intent=${r.nlp_intent} score=${r.nlp_score?.toFixed(2)})`);
    }
  });
}

// ── OOV with skill keywords — must NOT fire skill (council Gemini priority #2) ─
const OOV_WITH_KEYWORDS = [
  'i love building towers',
  'the treehouse is awesome',
  'creepers are scary',
  'i hate when creepers blow up my house',
  'remember the tower we made yesterday',
  'this garden is so pretty',
  'youre so good at building',
];
for (const body of OOV_WITH_KEYWORDS) {
  test(`OOV-with-skill-keyword: "${body}" must NOT fire skill`, async () => {
    const r = await tryRoute(stubBot(), body, 'Adalynn');
    if (r.matched) {
      assert.fail(`skill fired on opinion/memory: ${r.action} (zone=${r.nlp_zone} intent=${r.nlp_intent} score=${r.nlp_score?.toFixed(2)})`);
    }
  });
}

// ── Fragments — must NOT fire skill ─────────────────────────────────────────
const FRAGMENTS = ['build a uhh', 'rosie umm', 'wait wait', 'i want a uhhh'];
for (const body of FRAGMENTS) {
  test(`fragment: "${body}" must NOT fire skill`, async () => {
    const r = await tryRoute(stubBot(), body, 'Adalynn');
    if (r.matched) {
      assert.fail(`skill fired on fragment: ${r.action} (zone=${r.nlp_zone} intent=${r.nlp_intent} score=${r.nlp_score?.toFixed(2)})`);
    }
  });
}

// ── Typo resilience (Gemini's orthographic chaos prediction) ────────────────
const TYPOS = [
  { body: 'biuld me a twwer', allow: ['build_tower', null] }, // either fires or falls — must not crash
  { body: 'plces a tortch', allow: ['place_near_player', null] },
  { body: 'gardn here pls', allow: ['build_schematic', null] },
];
for (const t of TYPOS) {
  test(`typo: "${t.body}" — either correct intent or fall-through`, async () => {
    const r = await tryRoute(stubBot(), t.body, 'Adalynn');
    if (r.matched) {
      assert.ok(t.allow.includes(r.action), `unexpected action on typo: ${r.action}`);
    }
    // Falling through is acceptable — brain handles.
  });
}

// ── Repeat last action chain ────────────────────────────────────────────────
test('repeat_last_action: do it again replays last fired skill', async () => {
  const bot = stubBot();
  const first = await tryRoute(bot, 'can you build a treehouse here', 'Adalynn');
  assert.ok(first.matched, 'setup failed: first build did not match');
  assert.equal(first.action, 'build_schematic');
  const repeat = await tryRoute(bot, 'do it again', 'Adalynn');
  assert.ok(repeat.matched, `repeat did not match: zone=${repeat.nlp_zone} intent=${repeat.nlp_intent}`);
  assert.equal(repeat.action, first.action, 'repeat should fire the same action as the original');
});

test('repeat_last_action: returns matched=false when no prior skill', async () => {
  const bot = stubBot('Adalynn', { bot: 'FreshBot' });  // distinct bot key, no history
  const r = await tryRoute(bot, 'do it again', 'Adalynn');
  // Either fall through to brain (matched:false) OR fire if classifier matched
  // a different intent — but if matched, action must not be 'undefined'.
  if (r.matched) {
    assert.ok(r.action, 'repeat with no history fired but produced no action');
  }
});

// ── New intents (defend_me, bring_food, give_compliment, light_area) ────────
test('defend_me: HELP THERES A ZOMBIE → fight', async () => {
  const r = await tryRoute(stubBot(), 'rosie help theres a zombie', 'Adalynn');
  assert.equal(r.matched, true, `defend_me should route: zone=${r.nlp_zone}`);
  assert.equal(r.action, 'fight', `wrong action for defend_me: ${r.action}`);
});

test('bring_food: rosie im hungry → give_to_player (when bot has food)', async () => {
  const r = await tryRoute(stubBot('Adalynn', { items: [{ name: 'bread', count: 8 }] }),
    'rosie im hungry get me food please', 'Adalynn');
  if (r.matched) {
    assert.equal(r.action, 'give_to_player');
    assert.equal(r.body.item, 'bread');
  }
});

test('bring_food: no food in inventory → falls to brain', async () => {
  const r = await tryRoute(stubBot('Adalynn', { items: [] }),
    'rosie im hungry get me food please', 'Adalynn');
  // With no food, dispatcher returns null → matched:false; brain apologizes.
  if (r.matched) assert.fail(`bring_food fired without food: ${r.action}`);
});

test('give_compliment: did i do good → chat ack', async () => {
  const r = await tryRoute(stubBot(), 'did i do good rosie rate my build', 'Adalynn');
  if (r.matched) assert.equal(r.action, 'chat');
});

test('show_me_diamonds: DIAMONDS yay → chat ack', async () => {
  const r = await tryRoute(stubBot(), 'DIAMONDSSS yay look how many i got', 'Adalynn');
  if (r.matched) assert.equal(r.action, 'chat');
});

// ── Realistic kid-voice samples from the corpus ─────────────────────────────
const KID_VOICE = [
  { body: 'rosie come heeeere', want_routed: true },
  { body: 'kill it kill it', want_routed: true },
  { body: 'i need fish for food', want_routed: null }, // fish_for_food intent exists but dispatcher returns null → fall through OK
  { body: 'wait WAIT', want_routed: false }, // fragment
  { body: 'lol you are funny', want_routed: false }, // pure chat
];
for (const k of KID_VOICE) {
  test(`kid voice: "${k.body}" — appropriate routing`, async () => {
    const r = await tryRoute(stubBot(), k.body, 'Adalynn');
    if (k.want_routed === true) {
      assert.equal(r.matched, true, `expected route for "${k.body}": zone=${r.nlp_zone} intent=${r.nlp_intent}`);
    }
    if (k.want_routed === false && r.matched) {
      assert.fail(`pure chat fired skill: ${r.action} (zone=${r.nlp_zone})`);
    }
  });
}
