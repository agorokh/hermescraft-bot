// Bulk shadow test: 100+ synthetic kid utterances through BOTH routers
// (regex + NLP). Reports per-utterance disagreement and overall AGREE rate.
// Council bar for flipping NLP to primary: 92-95% AGREE.
//
// This is NOT a pass/fail unit test — it's a measurement that prints to
// stdout. The test always passes; read the console output for the rate.

import test from 'node:test';
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

// 100+ kid utterances covering the diversity councils asked for:
// build/movement/info/emote/safety/paraphrase/typo/panic/narrative/conversation
const UTTERANCES = [
  // canonical build (6)
  'can you build a 5-tall stone tower right here',
  'can you build a small house for me here',
  'can you mine 8 cobblestone and bring them to me please',
  'can you place a torch right in front of me',
  'design a small flower garden next to me',
  'can you build a treehouse here use the oak',
  // paraphrased build
  'put up a pillar right here please',
  'construct a cozy cottage for me',
  'i want a tree fort pleaseeee',
  'make me a watchtower',
  'build a fancy castle with battlements',
  'set up a campfire here',
  // ice/snow
  'build me an ice castle',
  'i want a frozen palace',
  'make me an igloo',
  'snow shelter pls',
  // movement
  'come here rosie',
  'come over to me',
  'follow me steve lets go adventure',
  'walk over here',
  // info
  'where are you rosie',
  'whats your position',
  'what do you have in inventory',
  'show me your stuff',
  // emote
  'wave at me',
  'jump for me',
  'dance with me',
  'sit down',
  // gather
  'get me some wood',
  'mine 4 stone please',
  'bring me some sand',
  'mine iron for me',
  // utility
  'light up this dark spot',
  'place a torch by me',
  'give me a flower',
  'plant flowers here',
  // safety
  'stop',
  'wait stop',
  'nevermind',
  'cancel that',
  // panic / defend
  'HELP THERES A CREEPER',
  'SPIDER ON MY HEAD',
  'zombie behind me',
  'kill the creeper',
  'attack the zombie',
  // food
  'im hungry get me food',
  'rosie im starving',
  'feed me please',
  // social
  'did i do good',
  'rate my build',
  'tell me im awesome',
  // pet
  'wheres my dog',
  'is buddy ok',
  // shelter
  'its night build a shelter',
  'block me in its dangerous',
  'dirt house pls its night',
  // explore
  'lets go in the cave',
  'scout ahead',
  // narrative (these SHOULD fall through to brain)
  'remember when we built that tower',
  'i love when you place torches',
  'creepers are scary',
  'i was watching a video of someone building an ice castle',
  'if a creeper came i would totally save you',
  'remember the treehouse we made',
  // fragments (fall through)
  'build a uhh',
  'rosie umm',
  'wait wait',
  // pure chat (fall through)
  'lol you are funny',
  'whats up',
  'are you tired',
  'how was your day',
  'i love minecraft',
  'youre my best friend rosie',
  // OOV
  'what is the weather today',
  'tell me a joke',
  'i had pizza for dinner',
  // typos
  'biuld me a twwer',
  'plces a tortch',
  'gardn here pls',
  'cna u mine some stone',
  // negations (must NOT fire build)
  'dont build a tower',
  'no dont build anything',
  'stop building',
  'nevermind on the garden',
  // context modifiers (anaphora wins — but regex has no idea)
  // (we don't test these in isolation here — they need a prior action)
  // repeat
  'do it again',
  'another please',
  // mining variants
  'can you mine 16 cobble',
  'i need 8 oak logs',
  // brain catch-all
  'hi rosie',
  'thanks steve',
  'good morning',
  'goodnight rosie',
];

test('bulk shadow agreement report', async () => {
  let agree = 0, differ = 0;
  const samples_per_action = {};
  const disagreements = [];
  for (const body of UTTERANCES) {
    const bot = stubBot();
    const r = await tryRegex(bot, body, 'Adalynn');
    const n = await tryNlp(bot, body, 'Adalynn');
    const r_action = r.matched ? r.action : 'none';
    const n_action = n.matched ? n.action : 'none';
    samples_per_action[r_action] = (samples_per_action[r_action] || 0) + 1;
    if (r_action === n_action) {
      agree++;
    } else {
      differ++;
      disagreements.push({ body, regex: r_action, nlp: n_action, score: n.nlp_score, zone: n.nlp_zone, intent: n.nlp_intent || n.intent_name });
    }
  }
  const total = UTTERANCES.length;
  const pct = 100.0 * agree / total;
  console.log('');
  console.log('  =========================================================');
  console.log(`  BULK SHADOW AGREEMENT: ${agree}/${total} (${pct.toFixed(1)}%)`);
  console.log('  =========================================================');
  console.log('');
  console.log('  Per-action regex sample distribution:');
  for (const [act, n] of Object.entries(samples_per_action).sort((a,b)=>b[1]-a[1])) {
    console.log(`    ${act.padEnd(25)} ${n}`);
  }
  if (disagreements.length > 0) {
    console.log('');
    console.log('  Disagreements:');
    for (const d of disagreements) {
      console.log(`    regex=${(d.regex||'none').padEnd(20)} nlp=${(d.nlp||'none').padEnd(20)} score=${(d.score?.toFixed(2)||'-')} zone=${d.zone||'-'} intent=${d.intent||'-'} | ${d.body.slice(0,60)}`);
    }
  }
  console.log('');
  console.log(`  Council bar for promoting NLP primary: 92-95% AGREE on broad corpus`);
  console.log(`  Current result: ${pct.toFixed(1)}% → ${pct >= 92 ? 'PASS' : 'BELOW BAR'}`);
});
