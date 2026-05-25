// NLP router v2 — full behavior suite after council adoption.
// Validates: clarification deadzone, negation rejection, OOV-with-skill-keyword
// rejection, repeat_last_action chain, all 6 canonical kid prompts, and the
// realistic kid-voice paraphrases (typos, baby voice, slang, panic-mode).

import test from 'node:test';
import assert from 'node:assert/strict';
import { tryRoute, recordLastSkill, resetContextBuffer } from '../lib/intent_router_nlp.js';
import { isSpeculativeBuildDiscussion, resolveSchematicName } from '../lib/schematic_resolve.js';
import { tryStopRoute, tryRoute as tryRouteRegex } from '../lib/intent_router.js';

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

test('regex stop hot path wins over explicit stop plus movement', async () => {
  const r = await tryStopRoute(stubBot(), 'stop building and come here', 'Adalynn');
  assert.equal(r.matched, true);
  assert.equal(r.action, 'stop');
});

test('negative build plus movement can still bypass regex stop hot path', async () => {
  const r = await tryStopRoute(stubBot(), "don't build a tower, come here", 'Adalynn');
  assert.equal(r.matched, false);
});

test('deterministic movement does not swallow combat commands', async () => {
  const r = await tryRoute(stubBot(), 'come here and kill the zombie', 'Adalynn');
  assert.equal(r.matched, true);
  assert.equal(r.action, 'fight');
});

test('deterministic combat keeps bare attack movement phrasing', async () => {
  const r = await tryRoute(stubBot(), 'come here and fight', 'Adalynn');
  assert.equal(r.matched, true);
  assert.equal(r.action, 'fight');
});

test('deterministic combat ignores negated attack movement phrasing', async () => {
  const r = await tryRoute(stubBot(), "come here and don't fight", 'Adalynn');
  assert.equal(r.matched, true);
  assert.equal(r.action, 'goto');
});

test('deterministic combat preserves later positive combat clause', async () => {
  const r = await tryRoute(stubBot(), "come here and don't fight me, fight the zombie", 'Adalynn');
  assert.equal(r.matched, true);
  assert.equal(r.action, 'fight');
});

test('deterministic combat ignores casual get-it movement phrasing', async () => {
  const r = await tryRoute(stubBot(), 'come here and get it', 'Adalynn');
  assert.equal(r.matched, true);
  assert.equal(r.action, 'goto');
});

test('deterministic combat keeps explicit get-hostile phrasing', async () => {
  const r = await tryRoute(stubBot(), 'come here and get the zombie', 'Adalynn');
  assert.equal(r.matched, true);
  assert.equal(r.action, 'fight');
});

test('deterministic combat ignores casual save-it movement phrasing', async () => {
  const r = await tryRoute(stubBot(), 'come here and save it', 'Adalynn');
  assert.equal(r.matched, true);
  assert.equal(r.action, 'goto');
});

test('deterministic combat keeps defend-me movement phrasing', async () => {
  const r = await tryRoute(stubBot(), 'come here and defend me', 'Adalynn');
  assert.equal(r.matched, true);
  assert.equal(r.action, 'fight');
});

test('standalone no before build intent does not force movement fast path', async () => {
  const r = await tryRoute(stubBot(), 'come here, no, build a tower', 'Adalynn');
  assert.notEqual(r.action, 'goto');
});

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
  { body: 'i need fish for food', want_routed: false }, // fish_for_food → brain queue (no chat stub)
  { body: 'wait WAIT', want_routed: false }, // fragment
  { body: 'lol you are funny', want_routed: false }, // pure chat
];
for (const k of KID_VOICE) {
  test(`kid voice: "${k.body}" — appropriate routing`, async () => {
    const r = await tryRoute(stubBot(), k.body, 'Adalynn');
    if (k.want_routed === true) {
      assert.equal(r.matched, true, `expected route for "${k.body}": zone=${r.nlp_zone} intent=${r.nlp_intent}`);
    }
    if (k.want_routed === 'chat') {
      assert.equal(r.matched, true, `expected chat ACK for "${k.body}": zone=${r.nlp_zone}`);
      assert.equal(r.action, 'chat');
    }
    if (k.want_routed === false && r.matched) {
      assert.fail(`pure chat fired skill: ${r.action} (zone=${r.nlp_zone})`);
    }
  });
}

test('house of ice → ice_castle schematic (keyword order)', async () => {
  const r = await tryRoute(stubBot(), 'build a house of ice', 'Adalynn');
  assert.equal(r.action, 'build_schematic');
  assert.equal(r.body.name, 'ice_castle');
});

test('hotel prompts route to advanced build schematic action', async () => {
  const r = await tryRoute(stubBot(), 'build me a huge fancy hotel right here', 'Adalynn');
  assert.equal(r.matched, true, `expected hotel route: zone=${r.nlp_zone} intent=${r.nlp_intent}`);
  assert.equal(r.action, 'build_schematic_advanced');
  assert.equal(r.body.name, 'grand_hotel');
});

test('gallery prompts route to advanced build schematic action', async () => {
  for (const [body, expected] of [
    ['build a crystal observatory here', 'crystal_observatory'],
    ['make me a wizard tower', 'wizard_tower'],
    ['build a market square', 'market_square'],
    ['build a sky bridge', 'sky_bridge'],
    ['build a beacon plaza', 'beacon_plaza'],
  ]) {
    const r = await tryRoute(stubBot(), body, 'Adalynn');
    assert.equal(r.matched, true, `expected gallery route for ${body}: zone=${r.nlp_zone} intent=${r.nlp_intent}`);
    assert.equal(r.action, 'build_schematic_advanced');
    assert.equal(r.body.name, expected);
  }
});


test('imperative remember-to-build gallery prompts still route', async () => {
  const r = await tryRouteRegex(stubBot(), 'remember to build a wizard tower here', 'Adalynn');
  assert.equal(r.matched, true, `expected imperative regex route: ${r.action}`);
  assert.equal(r.action, 'build_schematic_advanced');
  assert.equal(r.body.name, 'wizard_tower');
});


test('speculative build discussion guard does not block non-build intents', async () => {
  const bot = stubBot();
  const pos = await tryRouteRegex(bot, 'where are you', 'Adalynn');
  assert.equal(pos.matched, true, 'position report must still route');
  assert.equal(pos.action, 'chat');

  const mixed = await tryRouteRegex(bot, 'make me a sword, where is the village?', 'Adalynn');
  assert.equal(mixed.matched, false, 'non-build mixed prompt should fall through regex router');
});


test('speculative gallery discussion blocked before NLP dispatcher runs', async () => {
  const r = await tryRoute(stubBot(), 'should we build a sky bridge someday?', 'Adalynn');
  assert.equal(r.matched, false);
  assert.ok(['speculative_discussion', 'dispatcher_null', 'oov', 'clarify'].includes(r.nlp_zone), r.nlp_zone);
});

test('bare wizard/magic keywords route to resolved schematic not wizard_tower regex trap', async () => {
  const magicHouse = await tryRouteRegex(stubBot(), 'build me a magic house', 'Adalynn');
  assert.equal(magicHouse.matched, true);
  assert.equal(magicHouse.body.name, 'small_house');
  const wizardHouse = await tryRouteRegex(stubBot(), 'build a wizard house', 'Adalynn');
  assert.equal(wizardHouse.matched, true);
  assert.equal(wizardHouse.body.name, 'small_house');
});

test('NLP speculative guard does not block non-build emote intents', async () => {
  const r = await tryRoute(stubBot(), 'dance for me', 'Adalynn');
  assert.equal(r.matched, true, `expected emote route: zone=${r.nlp_zone}`);
  assert.equal(r.intent_name, 'emote_dance');
});


test('past-tense built recall is treated as speculative discussion', () => {
  assert.equal(isSpeculativeBuildDiscussion('do you remember that tower we built?'), true);
});



test('imperative build with trailing should-we qualifier is not speculative', () => {
  assert.equal(isSpeculativeBuildDiscussion('build a market square, should we put it here?'), false);
  assert.equal(isSpeculativeBuildDiscussion('build a beacon plaza, should we use the oak?'), false);
});

test('where-is recall matches schematic aliases via resolver', () => {
  assert.equal(isSpeculativeBuildDiscussion('where is the fire pit?'), true);
  assert.equal(isSpeculativeBuildDiscussion('where is the tree fort?'), true);
});

test('imperative build with where-is location qualifier is not speculative', () => {
  assert.equal(isSpeculativeBuildDiscussion('build a sky bridge where is best?'), false);
  assert.equal(isSpeculativeBuildDiscussion('make a wizard tower where are we?'), false);
});

test('imperative build with recall phrasing is not speculative', () => {
  assert.equal(isSpeculativeBuildDiscussion('build the wizard tower we talked about'), false);
  assert.equal(isSpeculativeBuildDiscussion('build wizard tower we talked about'), false);
  assert.equal(isSpeculativeBuildDiscussion('make the crystal observatory we talked about'), false);
  assert.equal(isSpeculativeBuildDiscussion('remember the crystal observatory we talked about'), true);
});

test('imperative build with trailing later qualifier is not speculative', () => {
  assert.equal(isSpeculativeBuildDiscussion('build me a wizard tower, I need it later'), false);
  assert.equal(isSpeculativeBuildDiscussion('build a market square, come back later'), false);
  assert.equal(isSpeculativeBuildDiscussion('i wish we could build a wizard tower later'), true);
});

test('wizard_tower requires compound wizard/magic + tower phrasing', () => {
  assert.equal(resolveSchematicName('build a spell tower'), 'wizard_tower');
  assert.equal(resolveSchematicName('build a castle with magic lights'), 'small_tower');
  assert.equal(resolveSchematicName('build a frozen magic castle'), 'ice_castle');
});

test('market alias does not hijack house builds near a market', () => {
  assert.equal(resolveSchematicName('build a house near the market'), 'small_house');
  assert.equal(resolveSchematicName('build a marketplace'), 'market_square');
  assert.equal(resolveSchematicName('build a mansion near the market'), 'grand_hotel');
  assert.equal(resolveSchematicName('build a fire pit by the market'), 'campfire_spot');
  assert.equal(resolveSchematicName('make me a sword at the market'), null);
  assert.equal(resolveSchematicName('make me a sword on the market'), null);
  assert.equal(resolveSchematicName('make me a sword at the bazaar'), null);
  assert.equal(resolveSchematicName('build a market'), 'market_square');
  assert.equal(resolveSchematicName('build a bazaar'), 'market_square');
  assert.equal(resolveSchematicName('make market news'), null);
});

test('list schematic prompts bypass speculative recall guard', () => {
  assert.equal(resolveSchematicName('show me your schematics we talked about'), 'list');
  assert.equal(isSpeculativeBuildDiscussion('show me your schematics we talked about'), true);
});

test('where-is recall for legacy schematics is speculative', () => {
  assert.equal(isSpeculativeBuildDiscussion('where is the treehouse?'), true);
  assert.equal(isSpeculativeBuildDiscussion('where is the garden?'), true);
});

test('gallery discussion prompts do not dispatch advanced builds', async () => {
  const bot = stubBot();
  resetContextBuffer(bot);
  for (const body of [
    'should we build a sky bridge someday?',
    'i wish we could build a wizard tower later',
    'can you tell me a story about building a beacon plaza',
    'remember the crystal observatory we talked about',
    'that market square idea sounds cool for another day',
    'what did we build in the gallery plaza today?',
    'do you remember the beacon plaza?',
    'where is the sky bridge?',
  ]) {
    const r = await tryRoute(bot, body, 'Adalynn');
    assert.equal(r.matched, false, `NLP fired on discussion prompt: ${body} -> ${r.action}`);

    const regex = await tryRouteRegex(bot, body, 'Adalynn');
    assert.equal(regex.matched, false, `regex fired on discussion prompt: ${body} -> ${regex.action}`);
  }
});

test('ride_horse phrasing is no_dispatcher and not emote_jump regex', async () => {
  const bot = stubBot();
  const r = await tryRoute(bot, 'i want to jump on the horse', 'Adalynn');
  assert.equal(r.matched, false);
  assert.equal(r.nlp_zone, 'no_dispatcher');
  const regex = await tryRouteRegex(bot, 'i want to jump on the horse', 'Adalynn');
  assert.equal(regex.matched, false, 'emote_jump must not steal ride_horse phrasing');
});

const STOP_CORPUS = [
  'quit it', 'knock it off', 'stahp', 'freeze', 'dont move', 'ugh stop pls', 'stop stop', 'stop stop stop',
];
for (const body of STOP_CORPUS) {
  test(`stop hot-path: "${body}"`, async () => {
    const r = await tryStopRoute(stubBot(), body, 'Adalynn');
    assert.equal(r.matched, true, `expected stop for "${body}"`);
    assert.equal(r.action, 'stop');
  });
}

test('stop hot-path: does not match gameplay phrasing', async () => {
  const r = await tryStopRoute(stubBot(), 'freeze the water', 'Adalynn');
  assert.equal(r.matched, false);
});

test('stop hot-path yields to positive movement with no-build constraint', async () => {
  const body = 'Steve come look at the sky bridge with me, but do not place, dig, fill, build, or use items.';
  const stop = await tryStopRoute(stubBot(), body, 'Adalynn');
  assert.equal(stop.matched, false);
  const routed = await tryRouteRegex(stubBot(), body, 'Adalynn');
  assert.equal(routed.matched, true);
  assert.equal(routed.action, 'goto');
});

test('movement preprocessor does not swallow mixed build commands', async () => {
  const body = 'come here and build a wizard tower';
  const routed = await tryRoute(stubBot(), body, 'Adalynn');
  assert.notEqual(routed.nlp_zone, 'deterministic_movement');
  assert.notEqual(routed.action, 'goto');
});

test('movement preprocessor does not swallow mixed task commands', async () => {
  const body = 'come here and cook food';
  const routed = await tryRoute(stubBot(), body, 'Adalynn');
  assert.notEqual(routed.nlp_zone, 'deterministic_movement');
  assert.notEqual(routed.action, 'goto');
});

test('movement preprocessor preserves task after negated build clause', async () => {
  const body = "come here and don't build, then cook food";
  const routed = await tryRoute(stubBot(), body, 'Adalynn');
  assert.notEqual(routed.nlp_zone, 'deterministic_movement');
  assert.notEqual(routed.action, 'goto');
});

test('regex and NLP movement helpers agree on come-to-my-place phrasing', async () => {
  const body = 'come to my place';
  const regex = await tryRouteRegex(stubBot(), body, 'Adalynn');
  const nlp = await tryRoute(stubBot(), body, 'Adalynn');
  assert.equal(regex.matched, true);
  assert.equal(regex.action, 'goto');
  assert.equal(nlp.matched, true);
  assert.equal(nlp.action, 'goto');
});
