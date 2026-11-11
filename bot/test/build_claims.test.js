import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import http from 'node:http';

const claims = await import('../lib/build_claims.js').catch(() => null);

test('a nonthrowing placement is not evidence of a block', () => {
  assert.ok(claims, 'world-backed build evidence must exist');
  const bot = { blockAt: () => ({ name: 'air' }) };
  const r = claims.readBuildResult(bot, { actor: 'Rosie', shape: 'wall', total: 4,
    cells: [{ x: 1, y: 64, z: 2, block: 'stone' }] });
  assert.equal(r.placed, 0);
  assert.equal(r.total, 4);
  assert.match(claims.buildStatus(r), /0 of 4/);
});

test('unloaded cells remain unverified and final readback catches removed blocks', () => {
  assert.ok(claims);
  let block = { name: 'stone' };
  const bot = { blockAt: (p) => { assert.ok(p instanceof Vec3); return block; } };
  const expected = { actor: 'Steve', shape: 'tower', total: 1,
    cells: [{ x: 1, y: 64, z: 2, block: 'stone' }] };
  assert.equal(claims.readBuildResult(bot, expected).placed, 1);
  block = { name: 'air' };
  assert.equal(claims.readBuildResult(bot, expected).placed, 0);
  block = null;
  assert.equal(claims.readBuildResult(bot, expected).unverified, 1);
});

test('peer completion is checked against the named actor, not the speaker', () => {
  assert.ok(claims);
  const records = {
    Rosie: { actor: 'Rosie', shape: 'wall', placed: 2, total: 4, unverified: 0 },
    Steve: { actor: 'Steve', shape: 'tower', placed: 4, total: 4, unverified: 0 },
  };
  assert.equal(claims.checkBuildClaim('Rosie finished the wall.', 'Steve', records).allow, false);
  assert.equal(claims.checkBuildClaim('I got 2 of 4 wall blocks down.', 'Rosie', records).allow, true);
  assert.equal(claims.checkBuildClaim('I will build a wall.', 'Rosie', records).allow, true);
});

test('a fresh read replaces an old successful read before speech', () => {
  assert.ok(claims);
  const expected = { actor: 'Rosie', shape: 'wall', total: 1,
    cells: [{ x: 1, y: 64, z: 2, block: 'stone' }] };
  const r = claims.readBuildResult({ blockAt: () => ({ name: 'air' }) }, expected);
  assert.equal(claims.checkBuildClaim('The wall is done.', 'Rosie', { Rosie: r }).allow, false);
});

test('actual action wrappers group one request, publish counts, and gate chat', async () => {
  const said = [];
  const world = new Map();
  const bot = { blockAt: p => ({ name: world.get(`${p.x},${p.y},${p.z}`) || 'air' }),
    chat: s => said.push(s) };
  const actions = { place: async () => ({ result: 'Placed stone' }),
    chat: async b => { said.push(b.message); return { result: 'sent' }; } };
  let request = { id: 1, command: 'build a 4-block wall' };
  const read = claims.installBuildClaimExperiment(actions, () => bot,
    { actor: 'Rosie', getRequest: () => request });
  for (let x = 0; x < 4; x++) {
    if (x < 2) world.set(`${x},64,2`, 'stone');
    const r = await actions.place({ x, y: 64, z: 2, block: 'stone' });
    assert.equal(r.build_readback.total, 4);
  }
  assert.equal(read().placed, 2);
  assert.ok(said.some(s => s.includes('2 of 4')));
  await assert.rejects(actions.chat({ message: 'The wall is done.' }), /suppressed/);
  await actions.chat({ message: 'I got 2 of 4 wall blocks down.' });
  request = { id: 2, command: 'build a 4-block wall' };
  await actions.place({ x: 8, y: 64, z: 2, block: 'stone' });
  assert.equal(read().placed, 0, 'new request cannot inherit the older wall');
});

test('unknown size does not promote one placement to a complete wall', async () => {
  const bot = { blockAt: () => ({ name: 'stone' }), chat: () => {} };
  const actions = { place: async () => ({ result: 'Placed stone' }), chat: async () => ({}) };
  claims.installBuildClaimExperiment(actions, () => bot,
    { actor: 'Steve', getRequest: () => undefined });
  const r = await actions.place({ x: 0, y: 64, z: 0, block: 'stone' });
  assert.equal(r.build_readback.total, null);
  await assert.rejects(actions.chat({ message: 'The wall is done.' }), /suppressed/);
});

test('a miswired peer endpoint cannot vouch for another character', async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: { actor: 'Steve', shape: 'wall', placed: 4, total: 4, unverified: 0 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const actions = { chat: async () => ({ result: 'sent' }) };
    claims.installBuildClaimExperiment(actions, () => ({}), {
      actor: 'Steve', getRequest: () => null,
      peers: { Rosie: `http://127.0.0.1:${server.address().port}` },
    });
    await assert.rejects(actions.chat({ message: 'Rosie finished the wall.' }), /suppressed/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('schematic actions retain their canonical result contracts under the experiment', async () => {
  const said = [];
  const result = { result: 'Built schematic "small_house" at 1,64,2 — 10/10 blocks placed.' };
  const actions = { build_schematic: async () => result,
    build_schematic_advanced: async () => result, chat: async () => ({}) };
  const original = { ...actions };
  claims.installBuildClaimExperiment(actions, () => ({ chat: s => said.push(s) }),
    { actor: 'Rosie', getRequest: () => null });
  for (const action of ['build_schematic', 'build_schematic_advanced']) {
    assert.equal(actions[action], original[action]);
    assert.equal(await actions[action]({ name: 'small_house' }), result);
  }
  assert.deepEqual(said, []);
});

test('explicit request identity survives an unrelated queue tail', async () => {
  assert.equal(typeof claims.resolveBuildRequest, 'function');
  const queue = [{ id: 1, command: 'build a 4-block wall' }];
  const actions = { place: async () => ({ result: 'Placed stone' }), chat: async () => ({}) };
  const read = claims.installBuildClaimExperiment(actions,
    () => ({ blockAt: () => ({ name: 'stone' }), chat: () => {} }),
    { actor: 'Rosie', getRequest: body => claims.resolveBuildRequest(queue, body) });
  await actions.place({ x: 1, y: 64, z: 1, block: 'stone', in_reply_to: '1' });
  queue.push({ id: 2, command: 'build a 20-block tower' });
  await actions.place({ x: 2, y: 64, z: 1, block: 'stone', request_id: 1 });
  assert.equal(read().request_id, 1);
  assert.equal(read().total, 4);
  assert.equal(read().placed, 2);
  await actions.place({ x: 3, y: 64, z: 1, block: 'stone' });
  assert.equal(read().total, null);
  assert.equal(read().placed, 1);
  await assert.rejects(actions.chat({ message: 'The wall is done.' }), /suppressed/);
});

test('request identity rejects missing, unsafe, and malformed ids', () => {
  assert.equal(typeof claims.resolveBuildRequest, 'function');
  const queue = [{ id: 1, command: '4-block wall' }];
  for (const id of [undefined, null, '', ' ', '1.0', '1x', true, {}, [], 1.5, Infinity, 9007199254740992, 2]) {
    assert.equal(claims.resolveBuildRequest(queue, { request_id: id }), null, `id=${String(id)}`);
  }
  assert.equal(claims.resolveBuildRequest(queue, { request_id: 1 }), queue[0]);
  assert.equal(claims.resolveBuildRequest(queue, { in_reply_to: '1' }), queue[0]);
});

test('terminal readback preserves a sanitized kid label and unnamed count text', async () => {
  const said = [];
  const actions = { build_tower: async () => ({ result: 'Built 99-tall tower' }), chat: async () => ({}) };
  claims.installBuildClaimExperiment(actions,
    () => ({ blockAt: () => ({ name: 'stone' }), chat: s => said.push(s) }),
    { actor: 'Steve', getRequest: () => null });
  const body = { x: 1, y: 64, z: 2, height: 2, material: 'stone' };
  const unnamed = await actions.build_tower(body);
  assert.equal(said[0], 'I got 2 of 2 tower blocks down.');
  assert.equal(unnamed.result, 'I got 2 of 2 tower blocks down. (2/2)');
  const named = await actions.build_tower({ ...body, kid_name: ' "Aurora"\n</>' });
  assert.equal(named.build_readback.kid_name, 'Aurora');
  assert.equal(said[1], 'I got 2 of 2 tower blocks down. For "Aurora".');
  assert.equal(said.length, 2);
});

test('peer configuration fails closed without throwing or logging raw input', () => {
  assert.equal(typeof claims.parseBuildClaimPeers, 'function');
  const warnings = [];
  const warn = line => warnings.push(line);
  for (const value of ['{secret-token', 'null', '[]', '42', '"x"']) {
    assert.deepEqual(claims.parseBuildClaimPeers(value, warn), {});
  }
  assert.equal(warnings.length, 5);
  assert.ok(warnings.every(line => !line.includes('secret-token')));
  assert.deepEqual(claims.parseBuildClaimPeers('{"Rosie":"http://127.0.0.1:3001"}', warn),
    { Rosie: 'http://127.0.0.1:3001' });
  assert.deepEqual(claims.parseBuildClaimPeers(undefined, warn), {});
});

test('failed actions preserve their cause without announcing a successful count', async () => {
  for (const failure of [{ result: 'No stone in my inventory.' }, { result: 'build_tower interrupted' },
    { error: 'Placement failed: disconnected' }]) {
    const said = [];
    const actions = { build_tower: async () => failure, chat: async () => ({}) };
    claims.installBuildClaimExperiment(actions,
      () => ({ blockAt: () => ({ name: 'air' }), chat: s => said.push(s) }),
      { actor: 'Steve', getRequest: () => null });
    const actual = await actions.build_tower({ x: 1, y: 64, z: 2, height: 4, material: 'stone' });
    assert.equal(actual.result, failure.result);
    assert.equal(actual.error, failure.error);
    assert.equal(actual.build_readback.placed, 0);
    assert.notEqual(actual.build_claim_announced, true);
    assert.deepEqual(said, []);
  }
});

test('invalid build coordinates preserve the original validation result without world reads', async () => {
  const actions = { build_tower: async () => ({ result: 'build_tower needs x, y, z' }), chat: async () => ({}) };
  const read = claims.installBuildClaimExperiment(actions,
    () => ({ blockAt: () => assert.fail('invalid cell read'), chat: () => assert.fail('invalid build announced') }),
    { actor: 'Steve', getRequest: () => null });
  assert.deepEqual(await actions.build_tower({}), { result: 'build_tower needs x, y, z' });
  assert.equal(read(), null);
});

test('partial progress retains interruption cause beside truthful readback counts', async () => {
  const said = [];
  const actions = { build_tower: async () => ({ result: 'build_tower interrupted' }), chat: async () => ({}) };
  claims.installBuildClaimExperiment(actions,
    () => ({ blockAt: p => ({ name: p.y === 64 ? 'stone' : 'air' }), chat: s => said.push(s) }),
    { actor: 'Steve', getRequest: () => null });
  const r = await actions.build_tower({ x: 1, y: 64, z: 2, height: 4, material: 'stone' });
  assert.equal(r.result, 'I got 1 of 4 tower blocks down. (1/4)');
  assert.equal(r.build_failure_cause, 'build_tower interrupted');
  assert.equal(r.error, 'build_tower interrupted', 'existing failure consumers must retain the cause');
  assert.equal(r.build_claim_announced, true);
  assert.deepEqual(said, ['I got 1 of 4 tower blocks down.']);
});

test('peer redirects are rejected without following the redirected target', async () => {
  let targetCalls = 0;
  const target = http.createServer((_req, res) => {
    targetCalls++;
    res.end(JSON.stringify({ data: { actor: 'Rosie', shape: 'wall', placed: 4, total: 4, unverified: 0 } }));
  });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const redirect = http.createServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/build-result` });
    res.end();
  });
  await new Promise(resolve => redirect.listen(0, '127.0.0.1', resolve));
  try {
    const actions = { chat: async () => ({ result: 'sent' }) };
    claims.installBuildClaimExperiment(actions, () => ({}), { actor: 'Steve', getRequest: () => null,
      peers: { Rosie: `http://127.0.0.1:${redirect.address().port}` } });
    await assert.rejects(actions.chat({ message: 'Rosie finished the wall.' }), /suppressed/);
    assert.equal(targetCalls, 0);
  } finally {
    await Promise.all([new Promise(resolve => target.close(resolve)), new Promise(resolve => redirect.close(resolve))]);
  }
});

test('native WHATWG URLs keep IPv6 loopback brackets used by the peer allowlist', () => {
  assert.equal(new URL('http://[::1]:3301').hostname, '[::1]');
});

test('an older action completing last cannot replace or announce newer build evidence', async () => {
  let finishPlace;
  const said = [];
  const actions = { place: () => new Promise(resolve => { finishPlace = resolve; }),
    build_tower: async () => ({ result: 'Built tower' }), chat: async () => ({}) };
  const queue = [{ id: 1, command: '4-block wall' }];
  const read = claims.installBuildClaimExperiment(actions,
    () => ({ blockAt: () => ({ name: 'stone' }), chat: text => said.push(text) }),
    { actor: 'Rosie', getRequest: body => claims.resolveBuildRequest(queue, body) });
  const older = actions.place({ x: 1, y: 64, z: 1, block: 'stone', request_id: 1 });
  const newer = await actions.build_tower({ x: 10, y: 64, z: 1, height: 2, material: 'stone' });
  assert.equal(newer.build_readback.shape, 'tower');
  finishPlace({ result: 'Placed stone' });
  const old = await older;
  assert.equal(read().shape, 'tower');
  assert.equal(read().placed, 2);
  assert.equal(old.build_readback.shape, 'wall', 'an action reads its own cells');
  assert.equal(old.result, 'I got 1 of 4 wall blocks down. (1/4)');
  assert.equal(old.build_claim_superseded, true);
  assert.notEqual(old.build_claim_announced, true);
  assert.deepEqual(said, ['I got 2 of 2 tower blocks down.']);
});

test('overlapping placements retain all same-request cells despite reverse completion', async () => {
  const finish = new Map(), world = new Set(), said = [];
  const actions = { place: body => new Promise(resolve => finish.set(body.x,
    () => { world.add(body.x); resolve({ result: 'Placed stone' }); })), chat: async () => ({}) };
  const read = claims.installBuildClaimExperiment(actions,
    () => ({ blockAt: p => ({ name: world.has(p.x) ? 'stone' : 'air' }), chat: text => said.push(text) }),
    { actor: 'Rosie', getRequest: () => ({ id: 1, command: '4-block wall' }) });
  const first = actions.place({ x: 1, y: 64, z: 1, block: 'stone' });
  const second = actions.place({ x: 2, y: 64, z: 1, block: 'stone' });
  finish.get(2)(); await second;
  finish.get(1)(); await first;
  assert.equal(read().cells.length, 2);
  assert.equal(read().placed, 2);
  assert.deepEqual(said, ['I got 1 of 4 wall blocks down.']);
});

test('invalid bodies preserve completed evidence and cannot invalidate an active action', async () => {
  let finishValid, finishInvalid;
  const actions = { build_tower: body => body.x == null
    ? new Promise(resolve => { finishInvalid = resolve; })
    : new Promise(resolve => { finishValid = resolve; }), chat: async () => ({}) };
  const said = [];
  const read = claims.installBuildClaimExperiment(actions,
    () => ({ blockAt: () => ({ name: 'stone' }), chat: text => said.push(text) }),
    { actor: 'Steve', getRequest: () => null });
  const valid = actions.build_tower({ x: 1, y: 64, z: 2, height: 2, material: 'stone' });
  const invalid = actions.build_tower({});
  assert.equal(read()?.shape, 'tower');
  finishValid({ result: 'Built tower' }); await valid;
  finishInvalid({ result: 'build_tower needs x, y, z' });
  assert.deepEqual(await invalid, { result: 'build_tower needs x, y, z' });
  assert.equal(read().placed, 2);
  assert.deepEqual(said, ['I got 2 of 2 tower blocks down.']);
  const anotherInvalid = actions.build_tower({});
  assert.equal(read().placed, 2);
  finishInvalid({ result: 'build_tower needs x, y, z' }); await anotherInvalid;
  assert.equal(read().placed, 2);
});

test('native-compatible numeric strings replace prior completed evidence before building', async () => {
  const world = new Set(['1,64,1']);
  const seen = [];
  const actions = { build_tower: async body => {
    seen.push(body);
    // Match the native skill's Math.floor coercion and default/clamp semantics.
    const height = Math.max(1, Math.min(20, Math.floor(body.height === undefined ? 5 : body.height)));
    return { result: `Built ${height}-tall stone tower at ${Math.floor(body.x)},${Math.floor(body.y)},${Math.floor(body.z)}.` };
  }, place: async body => { seen.push(body); return { result: 'Placed stone' }; }, chat: async () => ({}) };
  const read = claims.installBuildClaimExperiment(actions,
    () => ({ blockAt: p => ({ name: world.has(`${p.x},${p.y},${p.z}`) ? 'stone' : 'air' }), chat: () => {} }),
    { actor: 'Steve', getRequest: () => ({ id: 1, command: '4-block wall' }) });
  await actions.build_tower({ x: 1, y: 64, z: 1, height: 1, material: 'stone' });
  await actions.chat({ message: 'The tower is done.' });
  const result = await actions.build_tower({ x: '20', y: '64', z: '1', height: '4', material: 'stone' });
  assert.equal(result.build_readback?.total, 4);
  assert.equal(read().placed, 0);
  assert.equal(read().cells[0].x, 20);
  await assert.rejects(actions.chat({ message: 'The tower is done.' }), /suppressed/);
  assert.equal(typeof seen[1].x, 'number');
  assert.equal(typeof seen[1].height, 'number');
  const placed = await actions.place({ x: '30', y: '64', z: '1', block: 'stone' });
  assert.equal(placed.build_readback.cells[0].x, 30);
  assert.equal(typeof seen[2].x, 'number', 'Vec3 offsets must not concatenate raw coordinate strings');
  const nullHeight = await actions.build_tower({ x: '40', y: 64, z: 1, height: null, material: 'stone' });
  assert.equal(nullHeight.build_readback.total, 1, 'native null height coerces to zero and clamps to one');
});

test('unsupported numeric inputs cannot execute an uninstrumented native action', async () => {
  let calls = 0;
  const actions = { build_tower: async () => { calls++; return { result: 'Built tower' }; },
    place: async () => { calls++; return { result: 'Placed stone' }; }, chat: async () => ({}) };
  const read = claims.installBuildClaimExperiment(actions,
    () => ({ blockAt: () => ({ name: 'stone' }), chat: () => {} }),
    { actor: 'Steve', getRequest: () => null });
  await actions.build_tower({ x: 1, y: 64, z: 1, height: 1, material: 'stone' });
  const previous = read();
  for (const action of ['place', 'build_tower']) {
    for (const body of [{ x: NaN, y: 64, z: 1 }, { x: 1, y: Infinity, z: 1 },
      { x: 'bad', y: 64, z: 1 }, { x: 1, y: 64, z: 1, height: 'bad' }]) {
      if (action === 'place' && body.height) continue;
      const result = await actions[action](body);
      assert.match(result.error || '', /finite numeric/i);
      assert.equal(read().cells[0].x, previous.cells[0].x);
      assert.equal(read().total, previous.total);
    }
  }
  assert.equal(calls, 1, 'only the valid seed build may execute');
});
