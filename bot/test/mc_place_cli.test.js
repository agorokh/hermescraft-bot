import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installBuildClaimExperiment, resolveBuildRequest } from '../lib/build_claims.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../bin/mc', import.meta.url));

async function runCli(url, args) {
  const home = await mkdtemp(join(tmpdir(), 'hermescraft-mc-cli-'));
  try {
    const result = await exec('bash', [cli, '--json', ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        MC_API_URL: url,
        NO_PROXY: '127.0.0.1,localhost',
      },
      timeout: 5000,
    });
    return { ...result, code: 0 };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function endpoint(t) {
  const requests = [], world = new Map();
  const queue = [{ id: 42, command: 'Rosie, build a 2-block stone wall.' }];
  const bot = {
    blockAt: p => ({ name: world.get(`${p.x},${p.y},${p.z}`) || 'air' }),
    chat() {},
  };
  const actions = {
    place: async body => {
      world.set(`${body.x},${body.y},${body.z}`, body.block);
      return { result: 'Placed stone' };
    },
    chat: async () => ({ result: 'Sent' }),
  };
  const read = installBuildClaimExperiment(actions, () => bot, {
    actor: 'Rosie', getRequest: body => resolveBuildRequest(queue, body),
  });
  const server = http.createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const request = { path: req.url };
      requests.push(request);
      const body = request.body = JSON.parse(raw);
      const action = req.url === '/action/place' ? actions.place
        : req.url === '/action/chat' ? actions.chat : null;
      assert.equal(req.method, 'POST');
      assert.ok(action, `unexpected endpoint ${req.url}`);
      const result = await action(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { requests, read, url: `http://127.0.0.1:${server.address().port}` };
}

test('actual place/pl CLI binds two placements to the same queued build', async t => {
  const { url, requests, read } = await endpoint(t);
  const first = await runCli(url, ['place', 'stone', '10', '64', '-3', '--request-id', '42']);
  const second = await runCli(url, ['pl', 'stone', '11', '64', '-3', '--in-reply-to', '42']);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(first.stdout).ok, true, first.stdout);
  assert.equal(JSON.parse(second.stdout).ok, true, second.stdout);
  assert.deepEqual(requests, [
    { path: '/action/place', body: { block: 'stone', x: 10, y: 64, z: -3, request_id: 42 } },
    { path: '/action/place', body: { block: 'stone', x: 11, y: 64, z: -3, in_reply_to: 42 } },
  ]);
  assert.equal(JSON.parse(first.stdout).build_readback.placed, 1);
  const result = JSON.parse(second.stdout).build_readback;
  assert.equal(result.request_id, 42);
  assert.equal(result.total, 2);
  assert.equal(result.placed, 2);
  assert.equal(result.cells.length, 2);
  assert.equal(read().placed, 2);
});

test('legacy four-positional placement still sends only its original payload', async t => {
  const { url, requests } = await endpoint(t);
  const result = await runCli(url, ['place', 'stone', '10', '64', '-3']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true, result.stdout);
  assert.deepEqual(requests[0].body, { block: 'stone', x: 10, y: 64, z: -3 });
});

test('placement arguments are JSON data and safe integer binding remains exact', async t => {
  const { url, requests } = await endpoint(t);
  const block = 'stone"\\quoted';
  const result = await runCli(url, ['pl', block, '10', '64', '-3', '--request-id', '9007199254740991']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  assert.deepEqual(requests[0].body, { block, x: 10, y: 64, z: -3, request_id: Number.MAX_SAFE_INTEGER });
});

test('invalid, missing, unknown, and conflicting binding flags never reach HTTP', async t => {
  const { url, requests } = await endpoint(t);
  const cases = [
    ...['0', '-1', '1.5', '1e2', '9007199254740992', '1,"request_id":99', '$(echo unsafe)']
      .map(id => ['--request-id', id]),
    ['--in-reply-to'], ['--request-id', ''], ['--other', '42'],
    ['--request-id', '42', '--in-reply-to', '43'],
  ];
  for (const flags of cases) {
    const result = await runCli(url, ['place', 'stone', '10', '64', '-3', ...flags]);
    assert.equal(result.code, 2, JSON.stringify(flags));
  }
  assert.deepEqual(requests, []);
});

test('chat/say reply binding and quoted messages survive the shared parser', async t => {
  const { url, requests } = await endpoint(t);
  const message = 'hello "friend"\\path\nnext line';
  const unbound = await runCli(url, ['chat', message]);
  assert.equal(unbound.code, 0, unbound.stderr);
  for (const [command, flag] of [['chat', '--in-reply-to'], ['say', '-r']]) {
    const result = await runCli(url, [command, message, flag, '42']);
    assert.equal(result.code, 0, result.stderr);
  }
  assert.deepEqual(requests.map(r => r.body), [
    { message }, { message, in_reply_to: 42 }, { message, in_reply_to: 42 },
  ]);
  const invalid = await runCli(url, ['chat', message, '--in-reply-to', '9007199254740992']);
  assert.equal(invalid.code, 2);
  assert.equal(requests.length, 3);
});

test('CLI help explains binding all placements to the mc commands request id', async () => {
  const result = await runCli('http://127.0.0.1:1', ['help']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /mc place.*--(?:request-id|in-reply-to)/);
  assert.match(result.stdout, /same.*(?:id|ID).*mc commands/i);
});
