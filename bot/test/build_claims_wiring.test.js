// Exercise the server's actual wiring without starting Minecraft or a listener.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

function serverFunction(name, next, globals) {
  const start = server.indexOf(`function ${name}(`);
  const source = server.slice(start, server.indexOf(`\n${next}`, start));
  const asyncPrefix = server.slice(start - 6, start) === 'async ' ? 'async ' : '';
  return new Function(...Object.keys(globals), `return ${asyncPrefix}${source}`)(...Object.values(globals));
}

test('peer configuration is parsed once when enabled and never when disabled', () => {
  const start = server.indexOf('const BUILD_CLAIMS_EXPERIMENT =');
  const source = server.slice(start, server.indexOf('let readBuildClaimResult', start));
  for (const enabled of [false, true]) {
    let parses = 0;
    const configure = new Function('process', 'parseBuildClaimPeers', 'log', `${source} return BUILD_CLAIM_PEERS;`);
    const peers = configure({ env: { HERMESCRAFT_BUILD_CLAIMS_EXPERIMENT: enabled ? '1' : '0',
      HERMESCRAFT_BUILD_CLAIM_PEERS: '{malformed' } }, () => { parses++; return {}; }, () => {});
    assert.equal(parses, enabled ? 1 : 0);
    assert.deepEqual(peers, {});
  }
});

test('router does not repeat the terminal count already emitted by the body', () => {
  const publicResult = serverFunction('publicRouterResult', 'function publicRouterFailure', {
    buildStatus: () => 'duplicate count', publicNamedBuildResult: () => 'duplicate name',
    publicActionResult: () => 'ordinary result',
  });
  assert.equal(publicResult({ action: 'build_tower', body: { kid_name: 'Aurora' } },
    { build_claim_announced: true, build_readback: { placed: 2, total: 2 } }), null);
  assert.equal(publicResult({ action: 'place' }, { build_readback: { placed: 0, total: 2 } }), 'ordinary result');
  assert.equal(publicResult({ action: 'place' }, { build_claim_superseded: true,
    build_readback: { placed: 1, total: 2 } }), null);
  assert.equal(publicResult({ action: 'place' }, { result: 'Placed stone' }), 'ordinary result');
});

test('failed readback keeps failure bookkeeping without duplicate chat or schematic fallback', async () => {
  const said = []; let failed = 0; let fallback = 0;
  const handle = serverFunction('handleIntentRouterActionResult', 'async function handleChat', {
    isSurvivalBlock: () => false, intentRouterOutcomeFailed: () => true,
    intentRouterFailureWasInterrupted: () => false,
    tryNamedTowerFallback: async () => { fallback++; return null; },
    markLastSkillFailed: () => failed++, publicRouterFailure: () => 'duplicate failure',
    bot: { chat: text => said.push(text) }, log: () => {},
  });
  assert.equal(await handle({ username: 'Adalynn', route: { action: 'build_tower', skill_id: 1 },
    result: { result: 'I got 1 of 4 tower blocks down. (1/4)', build_claim_announced: true,
      build_readback: { placed: 1, total: 4 } } }), false);
  assert.equal(failed, 1);
  assert.equal(fallback, 0);
  assert.deepEqual(said, []);
  await handle({ username: 'Adalynn', route: { action: 'build_tower', skill_id: 2 },
    result: { result: 'No stone in my inventory.', build_readback: { placed: 0, total: 4 } } });
  assert.equal(failed, 2);
  assert.equal(fallback, 1);
  assert.deepEqual(said, ['duplicate failure'], 'unannounced failure retains normal presentation');
  await handle({ username: 'Adalynn', route: { action: 'build_tower', skill_id: 3 },
    result: { result: 'I got 1 of 4 tower blocks down. (1/4)', build_claim_superseded: true,
      build_readback: { placed: 1, total: 4 } } });
  assert.equal(failed, 3);
  assert.equal(fallback, 1, 'superseded work cannot launch an obsolete fallback');
  assert.deepEqual(said, ['duplicate failure']);
});

test('build-result route denies nonlocal sockets before evaluating evidence', () => {
  const start = server.indexOf("if (path === '/build-result'");
  const source = server.slice(start, server.indexOf("      if (path === '/health'", start));
  let reads = 0;
  const handle = new Function('req', 'res', 'readBuildClaimResult', 'respond',
    `const path='/build-result', BUILD_CLAIMS_EXPERIMENT=true; ${source}`);
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '192.168.1.20', '100.80.1.2', undefined]) {
    const before = reads;
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
    const response = handle({ socket: { remoteAddress: address } }, {},
      () => { reads++; return { actor: 'Rosie' }; }, (_res, status) => status);
    assert.equal(response, local ? 200 : 403, String(address));
    assert.equal(reads - before, local ? 1 : 0);
  }
});
