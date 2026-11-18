// Creative-studio co-build: "build the eiffel tower" in chat (agorokh/hermescraft#592).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vec3 } from 'vec3';
import {
  adaptStudioRoute,
  claimSection,
  classifyStudioAnswer,
  createStudioCoBuild,
  planIsLive,
  planState,
  readPlan,
  studioSiteFor,
  withStartLock,
  writeNewPlan,
} from '../lib/studio_cobuild.js';

const TIMING = { offerMs: 60, pollMs: 5, joinTickMs: 10, watchMs: 10 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const GROUND_Y = 63; // top solid layer; feet stand at y=64

function withEnv(t, env) {
  const prior = Object.keys(env).map(k => process.env[k]);
  Object.entries(env).forEach(([k, v]) => { if (v == null) delete process.env[k]; else process.env[k] = v; });
  t.after(() => Object.keys(env).forEach((k, i) => {
    if (prior[i] == null) delete process.env[k]; else process.env[k] = prior[i];
  }));
}

function studioEnv(t) {
  withEnv(t, { HERMESCRAFT_STUDIO_FLIGHT: '1', HERMESCRAFT_COMPANION_NAMES: 'Rosie,Steve' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-plan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function character(name, { gameMode = 'creative', at = new Vec3(2.5, 64, 0.5) } = {}) {
  const kid = { username: 'Kid', type: 'player', position: new Vec3(0.5, 64, 0.5) };
  return {
    username: name,
    game: { gameMode, dimension: 'overworld' },
    creative: { flyTo: async () => {}, setInventorySlot: async () => {} },
    entity: { position: at },
    players: { Kid: { entity: kid } },
    lines: [],
    onLine: null,
    chat(text) { this.lines.push(text); this.onLine?.(text); },
    blockAt: p => ({ boundingBox: p.y <= GROUND_Y ? 'block' : 'empty' }),
    _stopGeneration: 0,
  };
}

/** A build_schematic stand-in that records each section and takes `ms` to "build" it. */
function builder(bot, log, { ms = 15, fail = null } = {}) {
  return {
    async build_schematic(body) {
      log.push({ by: bot.username, ...body, started: Date.now() });
      const gen = bot._stopGeneration;
      for (let waited = 0; waited < ms; waited += 5) {
        if (bot._stopGeneration !== gen) return { result: `Build of "${body.name}" interrupted after 3/150 blocks.` };
        await sleep(5);
      }
      if (fail === body.section) {
        return { result: `Refused further "${body.name}" placements after 0/150 blocks: no room.`, site_refused: true };
      }
      return { result: `Built schematic "${body.name}" at ${body.x},${body.y},${body.z} — 150/150 blocks placed via physical placement (flight), section ${body.section}.` };
    },
    async stop() { bot._stopGeneration += 1; return { result: 'Stopped all actions.' }; },
  };
}

test('short answers to an open offer', () => {
  for (const line of ['mine', 'Mine!', 'me', 'yes', 'ok', 'i want it', "i'll do it", 'let me', 'Rosie: mine', 'yes, me']) {
    assert.equal(classifyStudioAnswer(line), 'mine', line);
  }
  for (const line of ['no', 'nah', 'you do it', 'no you', 'go ahead', 'Rosie, you build it', 'ok you do it']) {
    assert.equal(classifyStudioAnswer(line), 'yours', line);
  }
  for (const line of ['', 'stop', 'Rosie stop', 'wait', 'what is that', 'look at the lantern on top',
    'can you make it a lot taller than the last one please']) {
    assert.equal(classifyStudioAnswer(line), null, line);
  }
});

test('a routed library build of a studio design becomes the co-build action', () => {
  const route = { matched: true, intent_name: 'build_schematic', action: 'build_schematic',
    body: { name: 'eiffel_tower', x: 2, y: 64, z: 0 }, skill_id: 7 };
  assert.deepEqual(adaptStudioRoute(route, 'Kid'), { matched: true, intent_name: 'studio_build',
    action: 'studio_build', body: { name: 'eiffel_tower', player: 'Kid' }, skill_id: 7 });
  const house = { matched: true, intent_name: 'build_schematic', action: 'build_schematic', body: { name: 'small_house' } };
  assert.equal(adaptStudioRoute(house, 'Kid'), house, 'other library builds are untouched');
  const refusal = { matched: true, action: 'chat', body: { text: 'no' } };
  assert.equal(adaptStudioRoute(refusal, 'Kid'), refusal);
  assert.deepEqual(adaptStudioRoute({ matched: false }, 'Kid'), { matched: false });
});

test('the site is on the ground east of the child, even when the child is hovering', () => {
  const bot = character('Rosie');
  assert.deepEqual(studioSiteFor(bot, new Vec3(10.7, 64, -3.2), [16, 16]), { x: 16, y: 64, z: -12 });
  assert.deepEqual(studioSiteFor(bot, new Vec3(10.7, 81.4, -3.2), [16, 16]), { x: 16, y: 64, z: -12 });
});

test('outside a creative studio session the character says so and changes nothing', async (t) => {
  const dir = studioEnv(t);
  const built = [];
  for (const bot of [character('Rosie', { gameMode: 'survival' })]) {
    const studio = createStudioCoBuild({ bot, actions: builder(bot, built), dir, timing: TIMING });
    const result = await studio.start({ name: 'eiffel_tower', player: 'Kid' });
    assert.deepEqual(bot.lines, ['I can only build the Eiffel Tower in the creative world.']);
    assert.match(result.result, /declined/);
  }
  assert.deepEqual(built, []);
  assert.equal(readPlan(dir), null);
});

test('one character offers every leg first, leaves the one the child takes, and builds the rest', { timeout: 20000 }, async (t) => {
  const dir = studioEnv(t);
  const bot = character('Rosie');
  const built = [];
  const studio = createStudioCoBuild({ bot, actions: builder(bot, built), dir, timing: TIMING });
  bot.onLine = (text) => {
    if (text.startsWith('Next: the south-east leg')) setTimeout(() => studio.onChat('Kid', 'mine'), 5);
  };
  const result = await studio.start({ name: 'eiffel_tower', player: 'Kid' });

  assert.deepEqual(built.map(b => b.section), ['leg_ne', 'leg_sw', 'leg_nw']);
  for (const b of built) assert.deepEqual([b.name, b.x, b.y, b.z], ['eiffel_tower', 6, 64, -8]);
  assert.deepEqual(bot.lines, [
    'Yes! The Eiffel Tower. We build it by hand, one part at a time.',
    'Next: the north-east leg. Want to build it yourself? Say "mine"!',
    'Next: the south-east leg. Want to build it yourself? Say "mine"!',
    'The south-east leg is yours!',
    'Next: the south-west leg. Want to build it yourself? Say "mine"!',
    'Next: the north-west leg. Want to build it yourself? Say "mine"!',
    'Our parts are done. The south-east leg is yours to build!',
  ]);
  assert.match(result.result, /done; Rosie built 3 parts/);
  const plan = readPlan(dir);
  assert.equal(planState(dir, plan).claims.get('leg_se').child, true);
  assert.equal(planIsLive(dir, plan), false, 'a finished plan does not block the next request');
  assert.equal(bot._studioPlanActive, false);
});

test('"you do it" starts the leg at once instead of waiting out the offer', { timeout: 20000 }, async (t) => {
  const dir = studioEnv(t);
  const bot = character('Rosie');
  const built = [];
  const studio = createStudioCoBuild({ bot, actions: builder(bot, built), dir, timing: { ...TIMING, offerMs: 5000 } });
  bot.onLine = (text) => { if (text.startsWith('Next:')) setTimeout(() => studio.onChat('Kid', 'you do it'), 5); };
  const started = Date.now();
  await studio.start({ name: 'eiffel_tower', player: 'Kid' });
  assert.equal(built.length, 4);
  assert.ok(Date.now() - started < 4000, 'four offers did not each wait five seconds');
  assert.equal(bot.lines.at(-1), 'The Eiffel Tower is finished!');
});

test('only the child answers an offer, and only while one is open', async (t) => {
  const dir = studioEnv(t);
  const bot = character('Rosie');
  const studio = createStudioCoBuild({ bot, actions: builder(bot, []), dir, timing: TIMING });
  assert.equal(studio.onChat('Kid', 'mine'), false, 'no offer is open');
  let consumedSteve = null;
  let consumedLong = null;
  bot.onLine = (text) => {
    if (!text.startsWith('Next: the north-east leg')) return;
    consumedSteve = studio.onChat('Steve', 'mine');
    consumedLong = studio.onChat('Kid', 'look at the lantern on top of it');
  };
  await studio.start({ name: 'eiffel_tower', player: 'Kid' });
  assert.equal(consumedSteve, false, 'another character cannot take the child\'s turn');
  assert.equal(consumedLong, false, 'ordinary chat is left for the router and the brain');
  assert.equal(bot.lines.at(-1), 'The Eiffel Tower is finished!');
});

test('two characters split the legs from opposite ends and build each exactly once', { timeout: 20000 }, async (t) => {
  const dir = studioEnv(t);
  const rosie = character('Rosie');
  const steve = character('Steve', { at: new Vec3(-2.5, 64, 0.5) });
  const built = [];
  const offers = [];
  for (const bot of [rosie, steve]) {
    bot.onLine = (text) => { if (text.startsWith('Next:')) offers.push({ by: bot.username, at: Date.now() }); };
  }
  const lead = createStudioCoBuild({ bot: rosie, actions: builder(rosie, built, { ms: 40 }), dir, timing: TIMING });
  const helper = createStudioCoBuild({ bot: steve, actions: builder(steve, built, { ms: 40 }), dir, timing: TIMING });
  const stopHelper = helper.install();
  t.after(stopHelper);
  await lead.start({ name: 'eiffel_tower', player: 'Kid' });
  for (let i = 0; i < 200 && helper.isActive(); i++) await sleep(10);

  assert.deepEqual(built.map(b => b.section).sort(), ['leg_ne', 'leg_nw', 'leg_se', 'leg_sw']);
  const by = name => built.filter(b => b.by === name).map(b => b.section);
  assert.deepEqual(by('Rosie'), ['leg_ne', 'leg_se'], 'the lead works from the start of the list');
  assert.deepEqual(by('Steve'), ['leg_nw', 'leg_sw'], 'the helper works from the far end');
  assert.ok(built.every(b => b.x === 6 && b.y === 64 && b.z === -8), 'both build at the one origin in the plan');
  // One offer is open at a time, so "mine" can only mean one leg.
  offers.sort((a, b) => a.at - b.at);
  for (let i = 1; i < offers.length; i++) {
    assert.ok(offers[i].at - offers[i - 1].at >= TIMING.offerMs - 15, `offers ${i - 1} and ${i} overlap`);
  }
  const closing = [...rosie.lines, ...steve.lines].filter(l => l === 'The Eiffel Tower is finished!');
  assert.equal(closing.length, 1, 'one closing line between them');
  await sleep(3 * TIMING.joinTickMs);
  assert.equal(steve._studioPlanNearby, false, 'the quiet flag clears once the plan is finished');
});

test('a second request while a plan is under way does not start a second tower', { timeout: 20000 }, async (t) => {
  const dir = studioEnv(t);
  const rosie = character('Rosie');
  const steve = character('Steve');
  const built = [];
  const lead = createStudioCoBuild({ bot: rosie, actions: builder(rosie, built, { ms: 60 }), dir, timing: TIMING });
  const other = createStudioCoBuild({ bot: steve, actions: builder(steve, built), dir, timing: TIMING });
  const running = lead.start({ name: 'eiffel_tower', player: 'Kid' });
  await sleep(30);
  const result = await other.start({ name: 'eiffel_tower', player: 'Kid' });
  assert.match(result.result, /already under way/);
  assert.deepEqual(steve.lines, ["We're already building the Eiffel Tower. Come and help!"]);
  await running;
  assert.equal(built.filter(b => b.by === 'Steve').length, 0);
});

test('stopping one character stops the plan for both', { timeout: 20000 }, async (t) => {
  const dir = studioEnv(t);
  const rosie = character('Rosie');
  const steve = character('Steve', { at: new Vec3(-2.5, 64, 0.5) });
  const built = [];
  const rosieActions = builder(rosie, built, { ms: 2000 });
  const steveActions = builder(steve, built, { ms: 2000 });
  const lead = createStudioCoBuild({ bot: rosie, actions: rosieActions, dir, timing: TIMING });
  const helper = createStudioCoBuild({ bot: steve, actions: steveActions, dir, timing: TIMING });
  const stopHelper = helper.install();
  t.after(stopHelper);
  const running = lead.start({ name: 'eiffel_tower', player: 'Kid' });
  for (let i = 0; i < 300 && built.length < 2; i++) await sleep(10);
  assert.equal(built.length, 2, 'both are building a leg');
  await rosieActions.stop(); // "Rosie stop"
  const result = await running;
  for (let i = 0; i < 300 && helper.isActive(); i++) await sleep(10);

  assert.match(result.result, /stopped; Rosie built 0 parts/);
  assert.equal(helper.isActive(), false, 'the other character stopped too');
  assert.equal(built.length, 2, 'nobody started another leg');
  assert.equal(planState(dir, readPlan(dir)).cancelled, true);
  assert.equal([...rosie.lines, ...steve.lines].some(l => /finished|yours to build/.test(l)), false);
  assert.equal(rosie.lines.at(-1), 'ok, stopped.', 'the character that was told to stop says so');
  assert.equal(steve.lines.includes('ok, stopped.'), false, 'the other one just stops');
});

test('a leg that cannot be built ends the plan with one plain line', { timeout: 20000 }, async (t) => {
  const dir = studioEnv(t);
  const bot = character('Rosie');
  const built = [];
  const studio = createStudioCoBuild({ bot, actions: builder(bot, built, { fail: 'leg_ne' }), dir, timing: TIMING });
  const result = await studio.start({ name: 'eiffel_tower', player: 'Kid' });
  assert.deepEqual(built.map(b => b.section), ['leg_ne']);
  assert.equal(bot.lines.at(-1), "I can't finish the north-east leg here. Something is in the way.");
  assert.match(result.result, /halted/);
  assert.equal(planIsLive(dir, readPlan(dir)), false);
});

test('a character that reconnects finishes the leg it had claimed without asking again', { timeout: 20000 }, async (t) => {
  const dir = studioEnv(t);
  const first = character('Rosie');
  const built = [];
  const before = createStudioCoBuild({ bot: first, actions: builder(first, built, { ms: 2000 }), dir, timing: TIMING });
  const stopFirst = before.install();
  const running = before.start({ name: 'eiffel_tower', player: 'Kid' });
  for (let i = 0; i < 300 && built.length < 1; i++) await sleep(10);
  stopFirst(); // the connection ended mid-leg
  first._stopGeneration += 1; // the dead body's build returns
  assert.match((await running).result, /disconnected/);
  assert.equal(planState(dir, readPlan(dir)).cancelled, false, 'a dropped connection does not cancel the plan');

  const again = character('Rosie');
  const after = createStudioCoBuild({ bot: again, actions: builder(again, built), dir, timing: TIMING });
  const stopAgain = after.install();
  t.after(stopAgain);
  for (let i = 0; i < 400 && planIsLive(dir, readPlan(dir)); i++) await sleep(10);
  assert.deepEqual(built.map(b => b.section), ['leg_ne', 'leg_ne', 'leg_se', 'leg_sw', 'leg_nw']);
  assert.equal(again.lines.filter(l => l.includes('north-east leg')).length, 0, 'no second offer for its own leg');
  assert.equal(again.lines.at(-1), 'The Eiffel Tower is finished!');
});

const DESIGN = {
  footprint: [16, 16],
  sections: [
    { name: 'leg_ne', label: 'north-east leg' }, { name: 'leg_se', label: 'south-east leg' },
    { name: 'leg_sw', label: 'south-west leg' }, { name: 'leg_nw', label: 'north-west leg' },
  ],
};

test('the start lock admits one holder and clears a dead one', (t) => {
  const dir = studioEnv(t);
  let inner = 'unset';
  const outer = withStartLock(dir, 'Rosie', () => {
    inner = withStartLock(dir, 'Steve', () => 'second');
    return 'first';
  });
  assert.equal(outer, 'first');
  assert.equal(inner, null, 'a second character cannot enter while the first is inside');
  assert.equal(withStartLock(dir, 'Steve', () => 'free again'), 'free again');
  fs.writeFileSync(path.join(dir, 'start.lock'), JSON.stringify({ by: 'Rosie', at: Date.now() - 60000 }));
  assert.equal(withStartLock(dir, 'Steve', () => 'too soon'), null, 'a dead lock is cleared, not entered, on this call');
  assert.equal(withStartLock(dir, 'Steve', () => 'entered'), 'entered');
});

test('two characters asked in the same moment start one plan, not two', { timeout: 20000 }, async (t) => {
  const dir = studioEnv(t);
  const rosie = character('Rosie');
  const steve = character('Steve');
  const built = [];
  const lead = createStudioCoBuild({ bot: rosie, actions: builder(rosie, built), dir, timing: TIMING });
  let racing = null;
  // Steve has already seen "no plan" when Rosie's plan lands: the gap the lock closes.
  const late = createStudioCoBuild({ bot: steve, actions: builder(steve, built), dir, timing: TIMING,
    loadDesignFn: () => { racing = lead.start({ name: 'eiffel_tower', player: 'Kid' }); return DESIGN; } });
  const result = await late.start({ name: 'eiffel_tower', player: 'Kid' });
  assert.match(result.result, /already under way/);
  assert.deepEqual(steve.lines, ["We're already building the Eiffel Tower. Come and help!"]);
  assert.equal(readPlan(dir).lead, 'Rosie', "Rosie's plan was not deleted and replaced");
  await racing;
  assert.deepEqual(built.map(b => `${b.by} ${b.section}`),
    ['Rosie leg_ne', 'Rosie leg_se', 'Rosie leg_sw', 'Rosie leg_nw']);
});

test("an answer counts from the plan's child or a player standing near, not from across the server", { timeout: 20000 }, async (t) => {
  const dir = studioEnv(t);
  const bot = character('Rosie');
  bot.players.Sibling = { entity: { username: 'Sibling', type: 'player', position: new Vec3(5.5, 64, 0.5) } };
  bot.players.Faraway = { entity: null }; // in another world: on the player list, no body here
  const built = [];
  const studio = createStudioCoBuild({ bot, actions: builder(bot, built), dir, timing: TIMING });
  const seen = {};
  bot.onLine = (text) => {
    if (text.startsWith('Next: the north-east leg')) {
      seen.faraway = studio.onChat('Faraway', 'ok');
      seen.stranger = studio.onChat('Stranger', 'mine');
    }
    if (text.startsWith('Next: the south-east leg')) setTimeout(() => { seen.sibling = studio.onChat('Sibling', 'mine'); }, 5);
  };
  await studio.start({ name: 'eiffel_tower', player: 'Kid' });
  assert.deepEqual(seen, { faraway: false, stranger: false, sibling: true });
  assert.deepEqual(built.map(b => b.section), ['leg_ne', 'leg_sw', 'leg_nw']);
  assert.equal(planState(dir, readPlan(dir)).claims.get('leg_se').by, 'Sibling');
});

test("a character that is not offering keeps the answer to another character's offer away from its router", { timeout: 20000 }, async (t) => {
  const dir = studioEnv(t);
  const rosie = character('Rosie');
  const steve = character('Steve');
  const lead = createStudioCoBuild({ bot: rosie, actions: builder(rosie, []), dir, timing: TIMING });
  const other = createStudioCoBuild({ bot: steve, actions: builder(steve, []), dir, timing: TIMING });
  assert.equal(other.onChat('Kid', 'mine'), false, 'no plan, so the line is ordinary chat');
  const seen = {};
  rosie.onLine = (text) => {
    if (!text.startsWith('Next: the north-east leg')) return;
    seen.answer = other.onChat('Kid', 'you do it');
    seen.chatter = other.onChat('Kid', 'look at that lantern');
    seen.companion = other.onChat('Rosie', 'mine');
  };
  await lead.start({ name: 'eiffel_tower', player: 'Kid' });
  assert.deepEqual(seen, { answer: true, chatter: false, companion: false });
  assert.deepEqual(steve.lines, [], 'it says nothing and takes nothing');
  assert.equal(other.onChat('Kid', 'mine'), false, 'the plan is finished, so the line is ordinary chat again');
});

test('a plan stays live while it keeps moving, and stops blocking once its last step is old', (t) => {
  const dir = studioEnv(t);
  const old = Date.now() - 2 * 60 * 60 * 1000;
  const plan = { id: String(old), design: 'eiffel_tower', label: 'Eiffel Tower', origin: { x: 0, y: 64, z: 0 },
    world: null, child: 'Kid', lead: 'Rosie', created_at: old, sections: DESIGN.sections.slice(0, 2) };
  assert.equal(writeNewPlan(dir, plan), true);
  assert.equal(planIsLive(dir, plan), false, 'nothing has moved for two hours');
  assert.equal(claimSection(dir, plan, 'leg_ne', 'Rosie'), true);
  assert.equal(planIsLive(dir, plan), true, 'a long co-build whose section was claimed just now is live');
  fs.utimesSync(path.join(dir, `${plan.id}.leg_ne.claim`), old / 1000, old / 1000);
  assert.equal(planIsLive(dir, plan), false, 'a claim left by a process that died long ago no longer blocks');
});
