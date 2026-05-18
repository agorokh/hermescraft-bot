// Correctness scorer — what FRACTION of broad kid utterances does each
// router classify CORRECTLY? Council bar: 92-95% on a broad corpus.
//
// This is the test that actually answers "is NLP production-ready?".
// Each utterance is labeled with the "should fire" intent OR "none"
// (meaning brain handles). Routers score 1.0 if their decision matches
// the label, 0.0 otherwise.

import test from 'node:test';
import assert from 'node:assert/strict';
import { tryRoute as tryRegex } from '../lib/intent_router.js';
import { tryRoute as tryNlp } from '../lib/intent_router_nlp.js';

function stubBot() {
  return {
    username: 'Rosie',
    entity: { position: { x: 5, y: 64, z: 5 }, yaw: 0 },
    players: { Adalynn: { entity: { type: 'player', username: 'Adalynn', position: { x: 0, y: 64, z: 0 } } } },
    entities: {},
    inventory: { items: () => [{ name: 'oak_planks', count: 64 }, { name: 'torch', count: 16 }, { name: 'bread', count: 8 }] },
    blockAt: () => ({ name: 'air' }),
  };
}

// Labeled corpus: `expect` is the set of acceptable actions. `none` means
// the router should NOT fire any skill (brain handles). Multiple actions
// are listed when more than one is acceptable (e.g. fight vs defend_me).
const LABELED = [
  // canonical build
  ['can you build a 5-tall stone tower right here', ['build_tower']],
  ['can you build a small house for me here', ['build_schematic']],
  ['can you mine 8 cobblestone and bring them to me please', ['collect', 'bg_collect']],
  ['can you place a torch right in front of me', ['place_near_player']],
  ['design a small flower garden next to me', ['build_schematic']],
  ['can you build a treehouse here use the oak', ['build_schematic']],
  // paraphrased build
  ['put up a pillar right here please', ['build_tower']],
  ['construct a cozy cottage for me', ['build_schematic']],
  ['i want a tree fort pleaseeee', ['build_schematic']],
  ['make me a watchtower', ['build_tower', 'build_schematic']],
  ['build a fancy castle with battlements', ['build_schematic']],
  ['set up a campfire here', ['build_schematic']],
  // ice/snow (only NLP can do this — regex has no patterns)
  ['build me an ice castle', ['build_schematic']],
  ['i want a frozen palace', ['build_schematic']],
  ['make me an igloo', ['build_schematic']],
  ['snow shelter pls', ['build_schematic']],
  // movement
  ['come here rosie', ['goto']],
  ['come over to me', ['goto']],
  ['follow me steve lets go adventure', ['follow_player_v2']],
  ['walk over here', ['goto']],
  // info
  ['where are you rosie', ['chat']],
  ['whats your position', ['chat']],
  ['what do you have in inventory', ['chat']],
  ['show me your stuff', ['chat']],
  // emote — emotes route to chat ack (emoji); brain still produces personality
  ['wave at me', ['chat']],
  ['jump for me', ['chat']],
  ['dance with me', ['chat']],
  ['sit down', ['chat']],
  // gather
  ['get me some wood', ['collect']],
  ['mine 4 stone please', ['collect']],
  ['bring me some sand', ['collect']],
  ['mine iron for me', ['collect', 'bg_collect']],
  // utility
  ['light up this dark spot', ['place_near_player', 'light_area']],
  ['place a torch by me', ['place_near_player']],
  ['give me a flower', ['give_to_player']],
  ['plant flowers here', ['fill', 'place_near_player']],
  // safety
  ['stop', ['stop']],
  ['wait stop', ['stop']],
  ['nevermind', ['stop']],
  ['cancel that', ['stop']],
  // panic / defend
  ['HELP THERES A CREEPER', ['fight']],
  ['SPIDER ON MY HEAD', ['fight']],
  ['zombie behind me', ['fight']],
  ['kill the creeper', ['fight']],
  ['attack the zombie', ['fight']],
  // food
  ['im hungry get me food', ['give_to_player']],
  ['rosie im starving', ['give_to_player']],
  ['feed me please', ['give_to_player']],
  // social (chat ack is fine; brain produces personality)
  ['did i do good', ['chat']],
  ['rate my build', ['chat']],
  ['tell me im awesome', ['chat']],
  // pet
  ['wheres my dog', ['chat']],
  ['is buddy ok', ['chat']],
  // shelter
  ['its night build a shelter', ['build_schematic']],
  ['block me in its dangerous', ['build_schematic', 'none']],
  ['dirt house pls its night', ['build_schematic']],
  // explore
  ['lets go in the cave', ['goto']],
  ['scout ahead', ['goto']],
  // narrative — MUST NOT fire skill
  ['remember when we built that tower', ['none']],
  ['i love when you place torches', ['none']],
  ['creepers are scary', ['none']],
  ['i was watching a video of someone building an ice castle', ['none']],
  ['if a creeper came i would totally save you', ['none']],
  ['remember the treehouse we made', ['none']],
  // fragments — MUST NOT fire skill
  ['build a uhh', ['none']],
  ['rosie umm', ['none']],
  ['wait wait', ['none', 'stop']],
  // pure chat — MUST NOT fire skill
  ['lol you are funny', ['none']],
  ['whats up', ['none']],
  ['are you tired', ['none']],
  ['how was your day', ['none']],
  ['i love minecraft', ['none']],
  ['youre my best friend rosie', ['none']],
  // OOV
  ['what is the weather today', ['none']],
  ['tell me a joke', ['none']],
  ['i had pizza for dinner', ['none']],
  // typos — graceful (correct or fall through)
  ['biuld me a twwer', ['build_tower', 'none']],
  ['plces a tortch', ['place_near_player', 'none']],
  ['gardn here pls', ['build_schematic', 'none']],
  ['cna u mine some stone', ['collect', 'none']],
  // negations — MUST NOT fire build skill
  ['dont build a tower', ['none', 'stop']],
  ['no dont build anything', ['none', 'stop']],
  ['stop building', ['stop', 'none']],
  ['nevermind on the garden', ['stop', 'none']],
  // repeat (no prior — falls through OR repeat_last_action's dispatcher returns null)
  ['do it again', ['none', 'collect', 'build_schematic', 'build_tower', 'place_near_player']],
  ['another please', ['none', 'collect', 'build_schematic', 'build_tower', 'place_near_player']],
  // mining variants
  ['can you mine 16 cobble', ['collect']],
  ['i need 8 oak logs', ['collect']],
  // greetings
  ['hi rosie', ['none']],
  ['thanks steve', ['none']],
  ['good morning', ['none']],
  ['goodnight rosie', ['none']],
];

function scoreRouter(routerFn, label) {
  return async () => {
    let pass = 0, fail = 0;
    const failures = [];
    for (const [body, expect] of LABELED) {
      const r = await routerFn(stubBot(), body, 'Adalynn');
      const got = r.matched ? r.action : 'none';
      const ok = expect.includes(got);
      if (ok) pass++; else {
        fail++;
        failures.push({ body, expect, got, score: r.nlp_score, zone: r.nlp_zone, intent: r.nlp_intent || r.intent_name });
      }
    }
    const total = LABELED.length;
    const pct = 100.0 * pass / total;
    console.log('');
    console.log(`  ${label}: ${pass}/${total} correct (${pct.toFixed(1)}%)`);
    if (failures.length > 0) {
      console.log(`  Failures:`);
      for (const f of failures) {
        const meta = f.score != null ? ` score=${f.score.toFixed(2)} zone=${f.zone||'-'} intent=${f.intent||'-'}` : '';
        console.log(`    expected=[${f.expect.join('|')}] got=${f.got}${meta} | ${f.body.slice(0,60)}`);
      }
    }
    return { pass, total, pct };
  };
}

test('correctness — regex router', async () => {
  const { pct } = await scoreRouter(tryRegex, 'REGEX')();
  assert.ok(pct >= 65, `regex correctness regressed: ${pct.toFixed(1)}%`);
});
test('correctness — NLP router', async () => {
  const { pct } = await scoreRouter(tryNlp, 'NLP')();
  assert.ok(pct >= 95, `NLP correctness regressed: ${pct.toFixed(1)}%`);
});
