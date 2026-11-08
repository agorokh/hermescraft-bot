// Regex-router guard for the build-request contract (hermescraft#501).
// server.js passes every regex route through lib/build_request_guard.js, in
// regex-primary mode (HERMES_NLP_PRIMARY=0) and in the NLP-primary fallback.

import test from 'node:test';
import assert from 'node:assert/strict';
import { guardRegexBuildRoute, routeRegexPrimary } from '../lib/build_request_guard.js';
import { checkBuildRequest } from '../lib/intent_router_nlp.js';
import { tryRoute as tryRouteRegex } from '../lib/intent_router.js';

let n = 0;
function stubBot(senderName = 'Adalynn', opts = {}) {
  const senderEntity = { type: 'player', username: senderName, position: { x: 0, y: 64, z: 0 } };
  return {
    username: opts.bot || `GuardBot${++n}`,
    entity: opts.noEntity ? null : { position: { x: 5, y: 64, z: 5 }, yaw: 0 },
    players: opts.noEntity ? {} : { [senderName]: { entity: senderEntity } },
    entities: opts.noEntity ? {} : { 1: senderEntity },
    inventory: { items: () => [{ name: 'oak_planks', count: 64 }, { name: 'cobblestone', count: 64 }] },
    blockAt: () => ({ name: 'air' }),
  };
}

const guarded = async (bot, body) => guardRegexBuildRoute(bot, body, 'Adalynn', await tryRouteRegex(bot, body, 'Adalynn'));

test('regex build of an unsupported request becomes a handled refusal', async () => {
  const bot = stubBot();
  const raw = await tryRouteRegex(bot, 'lets build the eiffel tower', 'Adalynn');
  assert.equal(raw.action, 'build_tower', 'precondition: the regex router builds the pillar');
  const r = await guarded(bot, 'lets build the eiffel tower');
  assert.equal(r.matched, true);
  assert.equal(r.action, 'chat');
  assert.equal(r.nlp_zone, 'build_unsupported');
});

test('regex build of a different structure is remapped to the one the object names', async () => {
  const bot = stubBot();
  const raw = await tryRouteRegex(bot, 'build a garden near the hotel', 'Adalynn');
  assert.equal(raw.body?.name, 'grand_hotel', 'precondition: the regex router picks the hotel');
  const r = await guarded(bot, 'build a garden near the hotel');
  assert.equal(r.matched, true);
  assert.equal(r.action, 'build_schematic');
  assert.equal(r.body.name, 'garden');
  assert.equal(r.nlp_zone, 'catalog_remap');
});

// Review round 5: a capability object must not let the regex place a schematic.
test('regex schematic for a capability object becomes the capability skill', async () => {
  const bot = stubBot();
  const raw = await tryRouteRegex(bot, 'build a tower near the hotel', 'Adalynn');
  assert.equal(raw.body?.name, 'grand_hotel', 'precondition: the regex router picks the hotel');
  const r = await guarded(bot, 'build a tower near the hotel');
  assert.equal(r.matched, true);
  assert.equal(r.action, 'build_tower');
  assert.equal(r.nlp_zone, 'catalog_remap');
  assert.equal(r.build_framed, true);
});

// Review round 6: every capability head maps to a skill or an honest refusal.
test('capability heads with a skill get it; those without get an honest refusal', async () => {
  const bot = stubBot();
  const hotel = { matched: true, intent_name: 'build_schematic', action: 'build_schematic_advanced', body: { name: 'grand_hotel', x: 2, y: 64, z: 0 } };
  const shelter = await guardRegexBuildRoute(bot, 'build a shelter near the hotel', 'Adalynn', hotel);
  assert.equal(shelter.action, 'build_shelter_for_night');
  assert.equal(shelter.nlp_zone, 'catalog_remap');

  const garden = { matched: true, intent_name: 'build_schematic', action: 'build_schematic', body: { name: 'garden', x: 2, y: 64, z: 0 } };
  const farm = await guardRegexBuildRoute(bot, 'build a farm near the garden', 'Adalynn', garden);
  assert.equal(farm.action, 'chat');
  assert.equal(farm.nlp_zone, 'build_unsupported');
  assert.equal(farm.body.text, "I can't build a farm yet.");
});

// Review round 9: a capability object is checked against nameless regex builds too.
test('a nameless regex pillar for another capability becomes that capability or a refusal', async () => {
  const bot = stubBot();
  const pillar = { matched: true, intent_name: 'build_tower', action: 'build_tower', body: { x: 2, y: 64, z: 0, height: 5 } };
  const farm = await guardRegexBuildRoute(bot, 'build a farm next to my tower', 'Adalynn', pillar);
  assert.equal(farm.action, 'chat');
  assert.equal(farm.body.text, "I can't build a farm yet.");
  const shelter = await guardRegexBuildRoute(bot, 'build a shelter next to the tower', 'Adalynn', pillar);
  assert.equal(shelter.action, 'build_shelter_for_night');
});

// Review round 7: a nameless regex build is remapped when the object names a schematic.
test('a regex pillar for a schematic-named object becomes that schematic', async () => {
  const bot = stubBot();
  const pillar = { matched: true, intent_name: 'build_tower', action: 'build_tower', body: { x: 2, y: 64, z: 0, height: 5 } };
  const r = await guardRegexBuildRoute(bot, 'build a tower of wizards', 'Adalynn', pillar);
  assert.equal(r.action, 'build_schematic_advanced');
  assert.equal(r.body.name, 'wizard_tower');
  assert.equal(r.nlp_zone, 'catalog_remap');
  // A bare tower stays the pillar.
  assert.deepEqual(await guardRegexBuildRoute(bot, 'build a stone tower', 'Adalynn', pillar), pillar);
});

// Review round 8: narration is never turned into a build, on any path.
test('a mismatched regex build on narration goes to the brain', async () => {
  const bot = stubBot();
  const body = 'my brother wants to build a garden near the house';
  const raw = await tryRouteRegex(bot, body, 'Adalynn');
  assert.equal(raw.body?.name, 'small_house', 'precondition: the regex router picks the house');
  const r = await guarded(bot, body);
  assert.equal(r.matched, false);
  assert.equal(r.nlp_zone, 'regex_build_unframed');
  const primary = await routeRegexPrimary(bot, body, 'Adalynn', tryRouteRegex);
  assert.equal(primary.matched, false);
});

test('a remap that cannot be anchored is a handled refusal, not a silent drop', async () => {
  const bot = stubBot('Adalynn', { noEntity: true });
  const route = { matched: true, intent_name: 'build_schematic', action: 'build_schematic_advanced', body: { name: 'grand_hotel', x: 0, y: 64, z: 0 } };
  const r = await guardRegexBuildRoute(bot, 'build a garden near the hotel', 'Adalynn', route);
  assert.equal(r.matched, true);
  assert.equal(r.action, 'chat');
  assert.equal(r.nlp_zone, 'build_unsupported');
});

test('matching regex builds and non-build routes pass unchanged', async () => {
  const bot = stubBot();
  const house = await tryRouteRegex(bot, 'build a small house here', 'Adalynn');
  assert.deepEqual(await guardRegexBuildRoute(bot, 'build a small house here', 'Adalynn', house), house);
  const chat = { matched: true, intent_name: 'report_position', action: 'chat', body: { text: 'at 0 64 0' } };
  assert.equal(await guardRegexBuildRoute(bot, 'where are you', 'Adalynn', chat), chat);
  const none = { matched: false };
  assert.equal(await guardRegexBuildRoute(bot, 'hello', 'Adalynn', none), none);
});

test('regex-primary: an unmatched framed unsupported request is refused', async () => {
  const bot = stubBot();
  const r = await routeRegexPrimary(bot, 'build me a pirate ship', 'Adalynn', tryRouteRegex);
  assert.equal(r.matched, true);
  assert.equal(r.nlp_zone, 'build_unsupported');
});

test('regex-primary: narration is not refused', async () => {
  const r = await routeRegexPrimary(stubBot(), 'my brother wants to build a pirate ship', 'Adalynn', tryRouteRegex);
  assert.notEqual(r.nlp_zone, 'build_unsupported');
});

test('regex-primary: a remapped build enters the repeat buffer', async () => {
  const bot = stubBot();
  const r = await routeRegexPrimary(bot, 'build a garden near the hotel', 'Adalynn', tryRouteRegex);
  assert.equal(r.nlp_zone, 'catalog_remap');
  assert.equal(typeof r.skill_id, 'number');
});

test("the sender's name never masks a trailing noun", () => {
  const { contract } = checkBuildRequest(stubBot('Boat'), 'build me a house boat', 'Boat');
  assert.equal(contract.status, 'unsupported');
  assert.equal(contract.reason, 'trailing:boat');
});


test('unsupported narration matching a regex build is deferred rather than refused', async () => {
  const bot = stubBot();
  const body = 'my brother wants to build the eiffel tower';
  const raw = await tryRouteRegex(bot, body, 'Adalynn');
  assert.equal(raw.action, 'build_tower');
  for (const r of [await guarded(bot, body), await routeRegexPrimary(bot, body, 'Adalynn', tryRouteRegex)]) {
    assert.equal(r.matched, false);
    assert.equal(r.nlp_zone, 'regex_build_unframed');
    assert.equal(r.action, undefined);
  }
  const { route } = checkBuildRequest(bot, body, 'Adalynn', 'build_tower', 0.99, { acting: true });
  assert.equal(route.matched, false, 'a confident NLP placement must also defer');
  assert.equal(route.nlp_zone, 'build_unframed');
});

test('a flower capability remaps torch placement despite the shared action', async () => {
  const bot = stubBot();
  const body = 'build a flower near the torch here';
  const torch = await tryRouteRegex(bot, body, 'Adalynn');
  assert.equal(torch.intent_name, 'torch_near_me');
  assert.equal(torch.action, 'place_near_player');
  const r = await guardRegexBuildRoute(bot, body, 'Adalynn', torch);
  assert.equal(r.intent_name, 'plant_flowers');
  assert.equal(r.action, 'place_near_player');
  assert.notEqual(r.body.item, 'torch');
  assert.equal(r.nlp_zone, 'catalog_remap');
  assert.equal(await guardRegexBuildRoute(bot, body, 'Adalynn', r), r, 'the correct flower skill passes unchanged');
});

test('regex-primary keeps stop ahead of builds using the regex router stop path', async () => {
  for (const body of ['stop', 'Rosie stop', 'stop building the tower', 'cancel']) {
    const r = await routeRegexPrimary(stubBot(), body, 'Adalynn', tryRouteRegex);
    assert.equal(r.action, 'stop', body);
    assert.equal(r.intent_name, 'stop', body);
  }
});
