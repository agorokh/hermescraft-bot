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
  const stdout = await runMc(t, ['chat', 'hi'], { ok: true, result: 'Sent: hi', state });
  return stdout.split('\n').find((l) => l.includes('Pos:')) || '';
}

async function runMc(t, args, payload) {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const home = await mkdtemp(join(tmpdir(), 'hermescraft-mc-status-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { stdout } = await exec('bash', [cli, ...args], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      MC_API_URL: `http://127.0.0.1:${server.address().port}`,
      NO_PROXY: '127.0.0.1,localhost',
    },
    timeout: 5000,
  });
  return stdout;
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

// Steve's first call in the live check was `mc status`, then `mc nearby`
// listed 289 bedrock blocks four below him; he said "deep underground near
// bedrock" before any status line could correct him.
const full = {
  health: 20, food: 16, saturation: 0, position: { x: -2.5, y: -60, z: -65.5 },
  dimension: 'overworld', biome: 'unknown', time: 6000, timePhase: 'afternoon',
  holding: 'torch x64', inventory: [], inventoryCount: 0, nearbyBlocks: [], notableBlocks: [],
  nearbyEntities: [], nearbyPlayers: [],
};

test('mc status prints the sky right under the position', async (t) => {
  const out = await runMc(t, ['status'], {
    ok: true, data: { ...full, sky: 'open', sky_note: skyNote(-60, 'open') },
  });
  const lines = out.split('\n');
  const at = lines.findIndex((l) => l.includes('Position: -2.5, -60, -65.5'));
  assert.ok(at >= 0, out);
  assert.equal(lines[at + 1].trim(), '☁ Sky: Open sky (ground level, not underground)');
});

test('mc nearby prints the sky after the blocks, and nothing without a note', async (t) => {
  const data = {
    entities: [], scanRadius: 32,
    blocks: [{ name: 'bedrock', count: 289, nearest: { x: -3, y: -64, z: -66 } }],
  };
  const out = await runMc(t, ['nearby'], { ok: true, data: { ...data, sky: 'open', sky_note: skyNote(-60, 'open') } });
  assert.match(out, /bedrock x289[^\n]*\n\s*☁ Sky: Open sky \(ground level, not underground\)/);
  const bare = await runMc(t, ['nearby'], { ok: true, data });
  assert.doesNotMatch(bare, /Sky:/);
});

// Rosie's cave session carried "deep underground" through a teleport; the
// arrival note sits under the status line and in `mc status` (#592).
const moved = 'You were just moved here from 1658,59,1718 in world; what you saw before no longer applies. '
  + 'Here: Open sky (ground level, not underground).';

test('an action prints the arrival note right under the status line', async (t) => {
  const out = await runMc(t, ['chat', 'hi'], {
    ok: true, result: 'Sent: hi',
    state: { ...base, position: { x: 3.5, y: -60, z: -65.5 }, sky: 'open', sky_note: skyNote(-60, 'open'), arrival_note: moved },
  });
  const lines = out.split('\n');
  const at = lines.findIndex((l) => l.includes('Pos:3.5,-60,-65.5'));
  assert.ok(at >= 0, out);
  assert.equal(lines[at + 1].trim(), `📍 ${moved}`);
  const bare = await runMc(t, ['chat', 'hi'], { ok: true, result: 'Sent: hi', state: { ...base, position: { x: 0, y: 64, z: 0 } } });
  assert.doesNotMatch(bare, /📍/);
});

test('mc status prints the arrival note under the sky', async (t) => {
  const out = await runMc(t, ['status'], {
    ok: true, data: { ...full, sky: 'open', sky_note: skyNote(-60, 'open'), arrival_note: moved },
  });
  const lines = out.split('\n');
  const at = lines.findIndex((l) => l.includes('☁ Sky:'));
  assert.ok(at >= 0, out);
  assert.equal(lines[at + 1].trim(), `📍 ${moved}`);
});
