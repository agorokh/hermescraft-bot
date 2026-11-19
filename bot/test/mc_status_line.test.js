import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../bin/mc', import.meta.url));

// The status line every `mc` action prints is what the brain reads first;
// in the #592 studio it showed only Pos y=-60 and both characters said
// "deep underground" on open grass.
async function statusLine(t, state) {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: 'Sent: hi', state }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const home = await mkdtemp(join(tmpdir(), 'hermescraft-mc-status-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { stdout } = await exec('bash', [cli, 'chat', 'hi'], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      MC_API_URL: `http://127.0.0.1:${server.address().port}`,
      NO_PROXY: '127.0.0.1,localhost',
    },
    timeout: 5000,
  });
  return stdout.split('\n').find((l) => l.includes('Pos:')) || '';
}

const base = { health: 20, food: 16, holding: 'torch', isDay: true };

test('open sky at a flat world Y -60 says ground level, not underground', async (t) => {
  const line = await statusLine(t, { ...base, position: { x: -2.5, y: -60, z: -65.5 }, sky: 'open' });
  assert.match(line, /Pos:-2\.5,-60,-65\.5/);
  assert.match(line, /Open sky \(ground level, not underground\)/);
});

test('open sky at a normal height needs no explanation', async (t) => {
  const line = await statusLine(t, { ...base, position: { x: 0, y: 70, z: 0 }, sky: 'open' });
  assert.match(line, /\| Open sky\]/);
});

test('underground and covered are named, and a missing sky adds nothing', async (t) => {
  assert.match(await statusLine(t, { ...base, position: { x: 0, y: 11, z: 0 }, sky: 'underground' }), /\| Underground\]/);
  assert.match(await statusLine(t, { ...base, position: { x: 0, y: -60, z: 0 }, sky: 'covered' }), /\| Under cover\]/);
  const bare = await statusLine(t, { ...base, position: { x: 0, y: -60, z: 0 } });
  assert.match(bare, /☀ Day\]$/);
});
