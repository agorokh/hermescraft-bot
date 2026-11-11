import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import * as claims from '../lib/build_claims.js';
import { actionOutcomeFailed } from '../lib/action_outcome.js';

const tower = { x: 1, y: 64, z: 2, height: 4, material: 'stone' };
const request = { id: 1, command: '4-block wall' };

test('failed attempts cannot announce or vouch for matching blocks that existed before the action', async () => {
  const said = [];
  let finish;
  const actions = { build_tower: () => new Promise(resolve => { finish = resolve; }), chat: async () => ({}) };
  const read = claims.installBuildClaimExperiment(actions,
    () => ({ blockAt: () => ({ name: 'stone' }), chat: s => said.push(s) }),
    { actor: 'Rosie', getRequest: () => null });
  const running = actions.build_tower(tower);
  await assert.rejects(actions.chat({ message: 'The tower is done.' }), /suppressed/);
  finish({ result: 'No stone in my inventory.' });
  const result = await running;
  assert.equal(result.result, 'No stone in my inventory.');
  assert.notEqual(result.build_claim_announced, true);
  assert.equal(read().placed, 4);
  assert.equal(read().action_status, 'failed');
  assert.equal(read().verified_delta, 0);
  assert.deepEqual(said, []);
  await assert.rejects(actions.chat({ message: 'The tower is done.' }), /suppressed/);
  await assert.rejects(actions.chat({ message: 'I got 4 of 4 tower blocks down.' }), /suppressed/);
});

test('unknown baseline fails closed while verified new partial progress retains its cause and counts', async () => {
  for (const baseline of ['unloaded', 'air']) {
    let after = false;
    const said = [];
    const actions = { build_tower: async () => { after = true; return { result: 'build_tower interrupted' }; },
      chat: async () => ({}) };
    const read = claims.installBuildClaimExperiment(actions,
      () => ({ blockAt: p => !after && baseline === 'unloaded' ? null
        : ({ name: after && p.y === 64 ? 'stone' : 'air' }), chat: s => said.push(s) }),
      { actor: 'Rosie', getRequest: () => null });
    const result = await actions.build_tower(tower);
    assert.equal(read().action_status, 'failed');
    if (baseline === 'unloaded') {
      assert.equal(result.result, 'build_tower interrupted');
      assert.equal(read().verified_delta, null);
      assert.deepEqual(said, []);
      await assert.rejects(actions.chat({ message: 'I got 1 of 4 tower blocks down.' }), /suppressed/);
    } else {
      assert.equal(result.error, 'build_tower interrupted');
      assert.equal(result.build_failure_cause, 'build_tower interrupted');
      assert.equal(read().verified_delta, 1);
      assert.equal(result.build_claim_announced, true);
      assert.deepEqual(said, ['I got 1 of 4 tower blocks down.']);
      await actions.chat({ message: 'I got 1 of 4 tower blocks down.' });
    }
    await assert.rejects(actions.chat({ message: 'The tower is done.' }), /suppressed/);
  }
});

test('unsupported build boundaries invalidate old and in-flight evidence without changing native results', async () => {
  for (const name of ['build_schematic', 'build_schematic_advanced', 'place_fill']) {
    let finishPlace, finishOther;
    const said = [], bodies = [];
    const nativeResult = { result: 'Canonical native build result', detail: 1 };
    const actions = { place: () => new Promise(resolve => { finishPlace = resolve; }),
      [name]: body => { bodies.push(body); return new Promise(resolve => { finishOther = () => resolve(nativeResult); }); },
      chat: async () => ({}) };
    const read = claims.installBuildClaimExperiment(actions,
      () => ({ blockAt: () => ({ name: 'stone' }), chat: s => said.push(s) }),
      { actor: 'Rosie', getRequest: () => request });
    const old = actions.place({ x: 1, y: 64, z: 2, block: 'stone' });
    const body = Object.freeze({ name: 'small_house', x: 9, y: 64, z: 9 });
    const current = actions[name](body);
    assert.equal(read(), null, name);
    finishPlace({ result: 'Placed stone' });
    assert.equal((await old).build_claim_superseded, true);
    assert.equal(read(), null);
    finishOther();
    assert.equal(await current, nativeResult, 'result object and canonical text are untouched');
    assert.equal(bodies[0], body, 'the native body receives the original parameters');
    assert.deepEqual(said, [], 'clear-only observers do not narrate');
    await assert.rejects(actions.chat({ message: 'All done!' }), /suppressed/);
    await assert.rejects(actions.chat({ message: 'The wall is done.' }), /suppressed/);
    await assert.rejects(actions.chat({ message: 'I built the house.' }), /suppressed/);
  }
});

test('actor-local state survives reinstall with fresh world/request callbacks and no wrapper nesting', async () => {
  assert.equal(typeof claims.createBuildClaimState, 'function');
  const state = claims.createBuildClaimState('Rosie');
  const said = [], invoked = [];
  let current = { blockAt: () => ({ name: 'stone' }), chat: s => said.push(s) };
  const actions = { place: async body => { invoked.push(body); return { result: 'Placed stone' }; },
    chat: async body => { said.push(body.message); return { result: 'sent' }; } };
  const read = claims.installBuildClaimExperiment(actions, () => current,
    { actor: 'Rosie', state, getRequest: () => request });
  await actions.place({ x: 1, y: 64, z: 2, block: 'stone' });
  assert.equal(read().placed, 1);
  const wrapped = { ...actions };
  current = { blockAt: () => ({ name: 'air' }), chat: s => said.push(s) };
  const freshRead = claims.installBuildClaimExperiment(actions, () => current,
    { actor: 'Rosie', state, getRequest: () => ({ id: 2, command: '2-block wall' }) });
  assert.equal(freshRead().cells.length, 1);
  assert.equal(freshRead().placed, 0, 'reconnect reads the new world instead of cached counts');
  assert.equal(read().placed, 0, 'existing readers use the updated runtime too');
  assert.equal(actions.place, wrapped.place);
  assert.equal(actions.chat, wrapped.chat);
  const result = await actions.place({ x: 8, y: 64, z: 2, block: 'stone' });
  assert.equal(result.build_readback.request_id, 2, 'reinstall does not retain a stale getRequest callback');
  assert.equal(result.build_readback.total, 2);
  assert.equal(invoked.length, 2);
  assert.throws(() => claims.installBuildClaimExperiment({ chat: async () => ({}) }, () => current,
    { actor: 'Steve', state, getRequest: () => null }), /actor/i);
  const steve = claims.installBuildClaimExperiment({ chat: async () => ({}) }, () => current,
    { actor: 'Steve', getRequest: () => null });
  assert.equal(steve(), null, 'separate bodies do not share actor evidence');
});

test('a pre-reconnect action cannot settle or announce into the new installation', async () => {
  assert.equal(typeof claims.createBuildClaimState, 'function');
  const state = claims.createBuildClaimState('Rosie');
  let finish;
  const said = [];
  const actions = { place: () => new Promise(resolve => { finish = resolve; }), chat: async () => ({}) };
  const options = { actor: 'Rosie', state, getRequest: () => request };
  claims.installBuildClaimExperiment(actions,
    () => ({ blockAt: () => ({ name: 'stone' }), chat: s => said.push(s) }), options);
  const old = actions.place({ x: 1, y: 64, z: 2, block: 'stone' });
  const read = claims.installBuildClaimExperiment(actions,
    () => ({ blockAt: () => ({ name: 'air' }), chat: s => said.push(s) }), options);
  finish({ result: 'Placed stone' });
  assert.equal((await old).build_claim_superseded, true);
  assert.equal(read().placed, 0);
  assert.deepEqual(said, []);
});

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
function nativeMessageAction(name, globals) {
  const start = server.indexOf(`  async ${name}(`);
  const source = server.slice(start, server.indexOf('\n  },', start) + 5);
  return new Function(...Object.keys(globals), `return ({${source}}).${name}`)(...Object.values(globals));
}

test('all native message actions share the claim gate while preserving recipients, fanout and aliases', async () => {
  const said = [];
  const globals = { ensureBot: () => ({ chat: s => said.push(s) }), getMyName: () => 'rosie',
    rememberSocialEvent: () => {}, teamConfig: { team: 'blue', teammates: ['Kid1', 'Kid2'], teamChat: [] },
    sleep: async () => {}, config: { mc: { username: 'Rosie' } }, posObj: () => ({ x: 1, y: 64, z: 2 }) };
  const actions = { chat: async body => { said.push(body.message); return { result: 'sent' }; } };
  for (const name of ['chat_to', 'whisper', 'team_chat', 'report']) actions[name] = nativeMessageAction(name, globals);
  const read = claims.installBuildClaimExperiment(actions, globals.ensureBot,
    { actor: 'Rosie', getRequest: () => null });
  for (const name of ['chat', 'chat_to', 'whisper', 'team_chat', 'report']) {
    await assert.rejects(actions[name](Object.freeze({ player: 'Kid', message: 'The wall is done.' })), /suppressed/, name);
  }
  assert.deepEqual(said, []);
  const plan = 'I will build a wall.';
  for (const name of ['chat', 'chat_to', 'whisper', 'team_chat', 'report']) {
    await actions[name](Object.freeze({ player: 'Kid', message: plan }));
  }
  assert.deepEqual(said, [plan, `/msg Kid ${plan}`, `/msg Kid ${plan}`,
    `/msg Kid1 [BLUE] ${plan}`, `/msg Kid2 [BLUE] ${plan}`,
    `/msg Kid1 [INTEL] ${plan} (at 1,64,2)`, `/msg Kid2 [INTEL] ${plan} (at 1,64,2)`]);
  assert.equal(read(), null);
  const wrapped = { ...actions };
  claims.installBuildClaimExperiment(actions, globals.ensureBot, { actor: 'Rosie', getRequest: () => null });
  for (const name of Object.keys(wrapped)) assert.equal(actions[name], wrapped[name], name);
  actions.chat_to = body => actions.whisper(body);
  claims.installBuildClaimExperiment(actions, globals.ensureBot, { actor: 'Rosie', getRequest: () => null });
  const before = said.length;
  await actions.chat_to({ player: 'Kid', message: plan });
  assert.equal(said.length, before + 1, 'delegating aliases do not double-speak');
});

function installNativeAutoMemory(action, actions, remembered) {
  const labels = { build_schematic: ['_origBuildSchematic', '_origBuildSchematicAdvanced'],
    build_schematic_advanced: ['_origBuildSchematicAdvanced', '_origBuildTower'],
    build_tower: ['_origBuildTower', '_origGiveToPlayer'] };
  const [first, next] = labels[action];
  const start = server.indexOf(`        const ${first} =`);
  const source = server.slice(start, server.indexOf(`        const ${next} =`, start));
  new Function('ACTIONS', 'autoRememberFact', 'cleanKidBuildName', 'actionOutcomeFailed', source)
    (actions, fact => remembered.push(fact), claims.cleanKidBuildName, actionOutcomeFailed);
}

test('native auto-memory layers remain single across experiment reinstall', async () => {
  for (const action of ['build_schematic', 'build_schematic_advanced', 'build_tower']) {
    const state = claims.createBuildClaimState('Rosie');
    const remembered = [], said = [];
    let calls = 0;
    const native = { result: action === 'build_tower' ? 'Built 1-tall stone tower at 1,64,2.'
      : 'Built schematic "small_house" at 1,64,2 — 1/1 blocks placed.' };
    const actions = { [action]: async () => { calls++; return native; }, chat: async () => ({}) };
    const bot = { blockAt: () => ({ name: 'stone' }), chat: line => said.push(line) };
    const options = { actor: 'Rosie', state, getRequest: () => null };
    claims.installBuildClaimExperiment(actions, () => bot, options);
    installNativeAutoMemory(action, actions, remembered);
    const before = state.generation;
    claims.installBuildClaimExperiment(actions, () => bot, options);
    installNativeAutoMemory(action, actions, remembered);
    const result = await actions[action]({ ...tower, height: 1 });
    assert.equal(calls, 1);
    assert.equal(remembered.length, 1, action);
    assert.equal(state.generation - before, 1, 'one native action crosses one build boundary');
    assert.notEqual(result.build_claim_superseded, true, 'a current action must not supersede itself through nested wrappers');
    if (action !== 'build_tower') {
      assert.equal(result, native);
      assert.deepEqual(said, []);
    } else assert.equal(said.length, 1);
  }
});

test('a failed full readback neither announces completion nor writes an auto-memory success', async () => {
  const remembered = [], said = [];
  let placed = false;
  const native = { result: 'Built 4-tall stone tower at 1,64,2.', error: 'build_tower interrupted' };
  const actions = { build_tower: async () => { placed = true; return native; }, chat: async () => ({}) };
  const read = claims.installBuildClaimExperiment(actions,
    () => ({ blockAt: () => ({ name: placed ? 'stone' : 'air' }), chat: line => said.push(line) }),
    { actor: 'Rosie', getRequest: () => null });
  installNativeAutoMemory('build_tower', actions, remembered);
  const result = await actions.build_tower(tower);
  assert.equal(result.result, native.result);
  assert.equal(result.error, native.error);
  assert.notEqual(result.build_claim_announced, true);
  assert.equal(read().verified_delta, 4);
  assert.deepEqual(said, []);
  assert.deepEqual(remembered, []);
  await assert.rejects(actions.chat({ message: 'The tower is done.' }), /suppressed/);
});

test('peer lookup cannot preserve local proof across build invalidation, reconnect or a changed world', async () => {
  for (const change of ['invalidate', 'reconnect', 'world']) {
    let reply, arrived;
    const requested = new Promise(resolve => { arrived = resolve; });
    const peer = http.createServer((_req, res) => { reply = res; arrived(); });
    await new Promise(resolve => peer.listen(0, '127.0.0.1', resolve));
    try {
      let present = true;
      const said = [];
      const bot = { blockAt: () => ({ name: present ? 'stone' : 'air' }), chat: text => said.push(text) };
      const state = claims.createBuildClaimState('Rosie');
      const actions = { place: async () => ({ result: 'Placed stone' }), build_schematic: async () => ({ result: 'native' }),
        chat: async body => { said.push(body.message); return { result: 'sent' }; } };
      const options = { actor: 'Rosie', state, getRequest: () => ({ id: 1, command: '1-block wall' }),
        peers: { Steve: `http://127.0.0.1:${peer.address().port}` } };
      claims.installBuildClaimExperiment(actions, () => bot, options);
      await actions.place({ x: 1, y: 64, z: 2, block: 'stone' });
      said.length = 0;
      const speech = actions.chat({ message: "My wall and Steve's tower are finished." });
      await requested;
      if (change === 'invalidate') await actions.build_schematic({ name: 'small_house' });
      if (change === 'reconnect') claims.installBuildClaimExperiment(actions, () => bot, options);
      if (change === 'world') present = false;
      reply.end(JSON.stringify({ data: { actor: 'Steve', shape: 'tower', total: 1, placed: 1, unverified: 0 } }));
      await assert.rejects(speech, /suppressed/, change);
      assert.deepEqual(said, []);
    } finally { await new Promise(resolve => peer.close(resolve)); }
  }
});

test('speech checks its generation after validator resolution and before native send', async () => {
  const previousFetch = globalThis.fetch;
  const said = [];
  const actions = { place: async () => ({ result: 'Placed stone' }), build_schematic: async () => ({ result: 'native' }),
    chat: async body => { said.push(body.message); return { result: 'sent' }; } };
  const read = claims.installBuildClaimExperiment(actions,
    () => ({ blockAt: () => ({ name: 'stone' }), chat: () => {} }),
    { actor: 'Rosie', getRequest: () => ({ id: 1, command: '1-block wall' }), peers: { Steve: 'http://127.0.0.1:3302' } });
  await actions.place({ x: 1, y: 64, z: 2, block: 'stone' });
  globalThis.fetch = async () => ({ ok: true, json: () => ({ then(resolve) {
    resolve({ data: { actor: 'Steve', shape: 'tower', total: 1, placed: 1, unverified: 0 } });
    queueMicrotask(() => { actions.build_schematic({ name: 'small_house' }); });
  } }) });
  try {
    await assert.rejects(actions.chat({ message: "My wall and Steve's tower are finished." }), /suppressed/);
    assert.equal(read(), null, 'invalidation ran in the validator-resolution gap');
    assert.deepEqual(said, []);
  } finally { globalThis.fetch = previousFetch; }
});

test('a changed build does not suppress a non-result greeting or plan', async () => {
  const said = [];
  const actions = { build_schematic: async () => ({ result: 'native' }),
    chat: async body => { said.push(body.message); return { result: 'sent' }; } };
  claims.installBuildClaimExperiment(actions, () => ({}), { actor: 'Rosie', getRequest: () => null });
  for (const message of ['Hello!', 'I will build a wall.']) {
    const pending = actions.chat({ message });
    await actions.build_schematic({ name: 'small_house' });
    await pending;
  }
  assert.deepEqual(said, ['Hello!', 'I will build a wall.']);
});
