import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { skyNote } from '../lib/perception.js';

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

test('the bot\'s sky note is printed as it comes', async (t) => {
  const line = await statusLine(t, {
    ...base, position: { x: -2.5, y: -60, z: -65.5 }, sky: 'open', sky_note: skyNote(-60, 'open'),
  });
  assert.match(line, /Pos:-2\.5,-60,-65\.5/);
  assert.match(line, /\| Open sky \(ground level, not underground\)\]/);
});

test('a state without a sky note prints as before', async (t) => {
  const bare = await statusLine(t, { ...base, position: { x: 0, y: -60, z: 0 }, sky: 'open' });
  assert.match(bare, /☀ Day\]$/);
});

test('skyNote words each exposure', () => {
  assert.equal(skyNote(-60, 'open'), 'Open sky (ground level, not underground)');
  assert.equal(skyNote(70, 'open'), 'Open sky');
  assert.equal(skyNote(-60, 'covered'), 'Under cover');
  assert.equal(skyNote(11, 'underground'), 'Underground');
  assert.equal(skyNote(11, 'unknown'), null);
});
