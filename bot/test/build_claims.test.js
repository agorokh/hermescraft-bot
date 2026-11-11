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
