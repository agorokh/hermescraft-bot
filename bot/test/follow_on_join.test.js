import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { registerHighLevelSkills } from '../lib/skills.js';
import { findPlayerEntity, normalizePlayerName } from '../lib/player_utils.js';
import {
  FOLLOW_DEFAULTS,
  followEnabled,
  claimDirFromEnv,
  readClaim,
  sweepBrokenClaims,
  refreshClaim,
  isFollowCandidate,
  isSafePlayerName,
  tryClaim,
  releaseClaim,
  claimsHeldBy,
  saveHome,
  readHome,
  nextFollowAction,
  returnHomeCommand,
  installFollowOnJoin,
  worldNameFromPacket,
  trackWorldName,
  currentWorldName,
} from '../lib/follow_on_join.js';
import { torchSuppressedByVisit } from '../lib/survival.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hc-follow-test-'));
}

function withCompanions(names, fn) {
  const prev = process.env.HERMESCRAFT_COMPANION_NAMES;
  process.env.HERMESCRAFT_COMPANION_NAMES = names;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.HERMESCRAFT_COMPANION_NAMES;
    else process.env.HERMESCRAFT_COMPANION_NAMES = prev;
  }
}

test('off unless HERMESCRAFT_FOLLOW_ON_JOIN=1', () => {
  assert.equal(followEnabled({}), false);
  assert.equal(followEnabled({ HERMESCRAFT_FOLLOW_ON_JOIN: '0' }), false);
  assert.equal(followEnabled({ HERMESCRAFT_FOLLOW_ON_JOIN: '1' }), true);
});

test('player names that could carry a command are refused', () => {
  assert.equal(isSafePlayerName('KidOne'), true);
  assert.equal(isSafePlayerName('.BedrockKid_7'), true);
  assert.equal(isSafePlayerName('Kid One'), false);
  assert.equal(isSafePlayerName('Kid;op'), false);
  assert.equal(isSafePlayerName('@a'), false);
  assert.equal(isSafePlayerName(''), false);
  assert.equal(isSafePlayerName(null), false);
});

test('companions, the bot itself and judge cameras are not followed', () => {
  withCompanions('Rosie,Steve', () => {
    assert.equal(isFollowCandidate('KidOne', 'Rosie'), true);
    assert.equal(isFollowCandidate('.KidOne', 'Rosie'), true);
    assert.equal(isFollowCandidate('Steve', 'Rosie'), false);
    assert.equal(isFollowCandidate('Rosie', 'Rosie'), false);
    assert.equal(isFollowCandidate('JCam_ab12', 'Rosie'), false);
    assert.equal(isFollowCandidate('PCam_ab12', 'Rosie'), false);
  });
});

test('the first character to claim a player keeps them', () => {
  const dir = tmpDir();
  assert.equal(tryClaim(dir, 'KidOne', 'Rosie'), 'claimed');
  assert.equal(tryClaim(dir, 'KidOne', 'Steve'), 'taken');
  assert.equal(tryClaim(dir, 'kidone', 'Steve'), 'taken', 'claims ignore case');
  assert.equal(tryClaim(dir, 'KidOne', 'Rosie'), 'mine');
  assert.equal(releaseClaim(dir, 'KidOne', 'Steve'), false, 'only the owner releases');
  assert.equal(releaseClaim(dir, 'KidOne', 'Rosie'), true);
  assert.equal(tryClaim(dir, 'KidOne', 'Steve'), 'claimed');
});

test('claimsHeldBy lists only this character, and never the home file', () => {
  const dir = tmpDir();
  tryClaim(dir, 'KidOne', 'Rosie');
  tryClaim(dir, 'KidTwo', 'Steve');
  saveHome(dir, 'Rosie', { dim: 'overworld', x: 1, y: 64, z: 2 });
  assert.deepEqual(claimsHeldBy(dir, 'Rosie').map((c) => c.child), ['KidOne']);
  assert.deepEqual(claimsHeldBy(path.join(dir, 'missing'), 'Rosie'), []);
});

test('claims live under the user home by default, in a directory only that user can enter', () => {
  assert.equal(claimDirFromEnv({ HERMESCRAFT_FOLLOW_CLAIM_DIR: '/x/claims' }), '/x/claims');
  assert.equal(claimDirFromEnv({}), path.join(os.homedir(), '.hermescraft', 'follow-claims'));
  const dir = path.join(tmpDir(), 'nested', 'claims');
  tryClaim(dir, 'KidOne', 'Rosie');
  assert.equal(fs.statSync(dir).mode & 0o077, 0, 'no group or other access');
});

test('a damaged or planted file is never used', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '_home-rosie.json'), JSON.stringify({ dim: 'overworld run op x', x: 1, y: 2, z: 3 }));
  assert.equal(readHome(dir, 'Rosie'), null);
  fs.writeFileSync(path.join(dir, '_home-rosie.json'), JSON.stringify({ dim: 'overworld', x: '1', y: 2, z: 3 }));
  assert.equal(readHome(dir, 'Rosie'), null);
  fs.writeFileSync(path.join(dir, '_home-rosie.json'), 'not json');
  assert.equal(readHome(dir, 'Rosie'), null);
  assert.equal(saveHome(tmpDir(), 'Rosie', { dim: 'overworld', x: NaN, y: 2, z: 3 }), false);
  fs.writeFileSync(path.join(dir, 'kidone.json'), JSON.stringify({ child: 'Kid;op', character: 'Rosie' }));
  assert.equal(readClaim(dir, 'KidOne'), null);
});

test('the first saved home wins, so a later position abroad cannot replace it', () => {
  const dir = tmpDir();
  assert.equal(saveHome(dir, 'Rosie', { dim: 'overworld', x: 1, y: 64, z: 2 }), true);
  assert.equal(saveHome(dir, 'Rosie', { dim: 'overworld', x: 9, y: 9, z: 9 }), false);
  assert.equal(saveHome(dir, 'Rosie', null), false);
  assert.deepEqual(readHome(dir, 'Rosie'), { dim: 'overworld', x: 1, y: 64, z: 2 });
});

test('while arriving, any gap is closed, no faster than the retry spacing', () => {
  const cfg = FOLLOW_DEFAULTS;
  const base = { claimedAt: 0, lastTpAt: 0 };
  assert.equal(nextFollowAction({ ...base, childVisible: false, distance: Infinity }, 6000, cfg), 'tp');
  assert.equal(nextFollowAction({ ...base, childVisible: true, distance: 30 }, 6000, cfg), 'tp');
  assert.equal(nextFollowAction({ ...base, childVisible: true, distance: 3 }, 6000, cfg), 'wait');
  assert.equal(nextFollowAction({ ...base, lastTpAt: 4000, childVisible: false, distance: Infinity }, 6000, cfg), 'wait');
});

test('once settled, only a player gone from view pulls the character along', () => {
  const cfg = FOLLOW_DEFAULTS;
  const settled = { claimedAt: 0, lastTpAt: 0 };
  const now = cfg.arriveWindowMs + 30000;
  assert.equal(nextFollowAction({ ...settled, childVisible: true, distance: 40 }, now, cfg), 'wait');
  assert.equal(nextFollowAction({ ...settled, childVisible: false, distance: Infinity }, now, cfg), 'tp');
  assert.equal(
    nextFollowAction({ ...settled, lastTpAt: now - 3000, childVisible: false, distance: Infinity }, now, cfg),
    'wait',
  );
});

test('the way home is a fixed-shape command, or nothing', () => {
  assert.equal(
    returnHomeCommand({ dim: 'overworld', x: 1658.1, y: 63, z: 1723.3 }),
    '/execute in minecraft:overworld run minecraft:tp @s 1658.10 63.00 1723.30',
  );
  assert.equal(returnHomeCommand(null), null);
  assert.equal(returnHomeCommand({ dim: 'overworld run op x', x: 1, y: 2, z: 3 }), null);
  assert.equal(returnHomeCommand({ dim: 'overworld', x: 'a', y: 2, z: 3 }), null);
});

test('torches are suppressed only while visiting', () => {
  assert.equal(torchSuppressedByVisit({}), false);
  assert.equal(torchSuppressedByVisit({ isVisiting: () => false }), false);
  assert.equal(torchSuppressedByVisit({ isVisiting: () => true }), true);
});

function fakeBot(name, { dimension = 'overworld', players = [] } = {}) {
  const bot = new EventEmitter();
  bot.username = name;
  bot.game = { dimension };
  bot.players = Object.fromEntries(players.map((p) => [p, { username: p }]));
  bot.entities = {};
  bot.entity = { position: { x: 10, y: 64, z: 10, distanceTo: () => Infinity } };
  bot.sent = [];
  bot.chat = (m) => bot.sent.push(m);
  return bot;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FAST = { tickMs: 20, arriveRetryMs: 40, stayRetryMs: 40, claimStaggerMs: 60, leaveGraceMs: 120, rescanMs: 80 };

test('the world name comes from the login and respawn packets, not the dimension type', () => {
  assert.equal(worldNameFromPacket({ worldState: { dimension: 'minecraft:overworld', name: 'minecraft:bskyblock_world' } }), 'bskyblock_world');
  assert.equal(worldNameFromPacket({ dimension: 'minecraft:overworld', worldName: 'minecraft:scenario_world' }), 'scenario_world');
  assert.equal(worldNameFromPacket({ dimension: 'minecraft:overworld' }), null);
  assert.equal(worldNameFromPacket(null), null);

  const bot = { game: { dimension: 'overworld' }, _client: new EventEmitter() };
  assert.equal(currentWorldName(bot), 'overworld', 'falls back to the type until a packet arrives');
  trackWorldName(bot);
  bot._client.emit('login', { worldState: { name: 'minecraft:overworld' } });
  assert.equal(currentWorldName(bot), 'overworld');
  bot._client.emit('respawn', { worldState: { name: 'minecraft:bskyblock_world' } });
  assert.equal(bot.game.dimension, 'overworld', 'the type did not change');
  assert.equal(currentWorldName(bot), 'bskyblock_world');
});

test('installed but disabled: no listeners, nothing claimed', () => {
  const dir = tmpDir();
  const bot = fakeBot('Rosie', { players: ['KidOne'] });
  const teardown = installFollowOnJoin(bot, () => {}, { env: {}, claimDir: dir });
  assert.equal(bot.listenerCount('playerJoined'), 0);
  assert.equal(bot._hc_follow.isVisiting(), false);
  teardown();
});

test('a lone player gets both characters and the guest yields when a second player joins', async () => {
  await withCompanions('Rosie,Steve', async () => {
    const dir = tmpDir();
    const env = { HERMESCRAFT_FOLLOW_ON_JOIN: '1', HERMESCRAFT_COMPANION_NAMES: 'Rosie,Steve' };
    const rosie = fakeBot('Rosie', { players: ['Rosie', 'Steve'] });
    const steve = fakeBot('Steve', { players: ['Rosie', 'Steve'] });
    const logs = [];
    const downs = [rosie, steve].map((b) => installFollowOnJoin(b, (m) => logs.push(`${b.username} ${m}`), {
      env, claimDir: dir, config: FAST,
    }));
    try {
      for (const b of [rosie, steve]) {
        b.players.KidOne = { username: 'KidOne' };
        b.emit('playerJoined', { username: 'KidOne' });
      }
      await wait(700);
      assert.equal(rosie._hc_follow.child(), 'KidOne');
      assert.equal(steve._hc_follow.child(), 'KidOne', 'the spare character visits as a guest');
      assert.equal(readClaim(dir, 'KidOne').character, 'Rosie', 'only Rosie owns the primary claim');
      assert.deepEqual(claimsHeldBy(dir, 'Steve'), [], 'a guest owns no primary claim');
      assert.ok(rosie.sent.includes('/tp KidOne'));
      assert.ok(steve.sent.includes('/tp KidOne'));

      for (const b of [rosie, steve]) {
        b.players.KidTwo = { username: 'KidTwo' };
        b.emit('playerJoined', { username: 'KidTwo' });
      }
      await wait(700);
      assert.equal(rosie._hc_follow.child(), 'KidOne', 'a busy character takes no second player');
      assert.equal(steve._hc_follow.child(), 'KidTwo');
      assert.ok(steve.sent.includes('/tp KidTwo'));
      for (const b of [rosie, steve]) delete b.players.KidTwo;
      await wait(800);
      assert.equal(steve._hc_follow.child(), 'KidOne', 'two players back to one: spare visits again');
      assert.equal(readClaim(dir, 'KidOne').character, 'Rosie');
      downs[1]();
      assert.equal(readClaim(dir, 'KidOne').character, 'Rosie', 'guest teardown never releases another claim');
    } finally {
      downs.forEach((d) => d());
    }
    assert.deepEqual(fs.readdirSync(dir).filter((n) => !n.startsWith('_home-')), [], 'teardown releases claims');
  });
});

test('when the player leaves, the character goes back where it set out from', async () => {
  await withCompanions('Rosie,Steve', async () => {
    const dir = tmpDir();
    const env = { HERMESCRAFT_FOLLOW_ON_JOIN: '1', HERMESCRAFT_COMPANION_NAMES: 'Rosie,Steve' };
    const rosie = fakeBot('Rosie', { players: ['Rosie', 'KidOne'] });
    rosie.entity.position = { x: 1658.1, y: 63, z: 1723.3, distanceTo: () => 0 };
    const down = installFollowOnJoin(rosie, () => {}, { env, claimDir: dir, config: FAST });
    try {
      await wait(1300); // startup scan finds the player who was already online
      assert.equal(rosie._hc_follow.child(), 'KidOne');
      assert.deepEqual(readHome(dir, 'Rosie'), { dim: 'overworld', x: 1658.1, y: 63, z: 1723.3 });
      rosie._hc_world = 'bskyblock_world'; // game.dimension still says "overworld"
      assert.equal(rosie._hc_follow.isVisiting(), true);

      // A Bedrock join drops and re-adds the tab-list entry. That is not a leave.
      delete rosie.players.KidOne;
      await wait(50);
      rosie.players.KidOne = { username: 'KidOne' };
      await wait(200);
      assert.equal(rosie._hc_follow.child(), 'KidOne', 'a flicker shorter than the grace keeps the claim');
      assert.ok(!rosie.sent.some((m) => m.startsWith('/execute')), 'and sends nobody home');

      delete rosie.players.KidOne;
      await wait(300);
      assert.equal(rosie._hc_follow.child(), null);
      assert.equal(rosie._hc_follow.isVisiting(), true, 'still a guest until it is back in its own world');
      const home = '/execute in minecraft:overworld run minecraft:tp @s 1658.10 63.00 1723.30';
      assert.equal(rosie.sent.at(-1), home);
      assert.ok(readHome(dir, 'Rosie'), 'home is kept until the character is seen back');

      // The server refused that teleport: the character is still away, so it asks again.
      const before = rosie.sent.filter((m) => m === home).length;
      await wait(200);
      assert.ok(rosie.sent.filter((m) => m === home).length > before, 'a refused return is retried');

      rosie._hc_world = 'overworld';
      await wait(200);
      assert.equal(readHome(dir, 'Rosie'), null, 'back home: the saved spot is dropped');
      const settled = rosie.sent.length;
      await wait(150);
      assert.equal(rosie.sent.length, settled, 'and nothing more is sent');
    } finally {
      down();
    }
  });
});

test('a second player who joins while the first is briefly absent is not taken', async () => {
  await withCompanions('Rosie,Steve', async () => {
    const dir = tmpDir();
    const env = { HERMESCRAFT_FOLLOW_ON_JOIN: '1', HERMESCRAFT_COMPANION_NAMES: 'Rosie,Steve' };
    const rosie = fakeBot('Rosie', { players: ['Rosie', 'KidOne'] });
    const down = installFollowOnJoin(rosie, () => {}, { env, claimDir: dir, config: { ...FAST, leaveGraceMs: 600 } });
    try {
      await wait(1300);
      assert.equal(rosie._hc_follow.child(), 'KidOne');
      delete rosie.players.KidOne;                    // tab-list flicker begins
      rosie.players.KidTwo = { username: 'KidTwo' };
      rosie.emit('playerJoined', { username: 'KidTwo' });
      await wait(400);                                // inside the grace
      assert.equal(rosie._hc_follow.child(), 'KidOne', 'still the first player');
      assert.equal(readClaim(dir, 'KidTwo'), null, 'no second claim was written');
      assert.equal(readClaim(dir, 'KidOne')?.character, 'Rosie', 'and the first claim is intact');
    } finally {
      down();
    }
  });
});

test('following a player across its own world still ends with a trip back to the saved spot', async () => {
  await withCompanions('Rosie,Steve', async () => {
    const dir = tmpDir();
    const env = { HERMESCRAFT_FOLLOW_ON_JOIN: '1', HERMESCRAFT_COMPANION_NAMES: 'Rosie,Steve' };
    const rosie = fakeBot('Rosie', { players: ['Rosie', 'KidOne'] });
    rosie.entity.position = { x: 1658.1, y: 63, z: 1723.3, distanceTo: () => Infinity };
    const down = installFollowOnJoin(rosie, () => {}, { env, claimDir: dir, config: FAST });
    try {
      await wait(1300);
      assert.equal(rosie._hc_follow.child(), 'KidOne');
      // The teleport took her 100 blocks away, same world.
      rosie.entity.position = { x: 1760, y: 70, z: 1723, distanceTo: () => 0 };
      assert.equal(rosie._hc_follow.isVisiting(), false, 'her own world: not a guest');
      delete rosie.players.KidOne;
      await wait(300);
      const home = '/execute in minecraft:overworld run minecraft:tp @s 1658.10 63.00 1723.30';
      assert.ok(rosie.sent.includes(home), 'being in the home world is not the same as being home');
      assert.ok(readHome(dir, 'Rosie'), 'the saved spot is kept until she stands on it');
      rosie.entity.position = { x: 1658.1, y: 63, z: 1723.3, distanceTo: () => 0 };
      await wait(200);
      assert.equal(readHome(dir, 'Rosie'), null);
    } finally {
      down();
    }
  });
});

test('a broken claim file cannot block a player forever, but a fresh one is left alone', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'kidone.json');
  fs.writeFileSync(file, '');                                   // a sibling mid-write, or damage
  assert.equal(tryClaim(dir, 'KidOne', 'Rosie'), 'taken', 'too young to judge: leave it');
  const later = Date.now() + 5000;
  assert.equal(tryClaim(dir, 'KidOne', 'Rosie', later), 'claimed', 'old and unreadable: replaced');
  assert.equal(readClaim(dir, 'KidOne').character, 'Rosie');
  assert.equal(tryClaim(dir, 'KidOne', 'Steve', later + 5000), 'taken', 'a valid claim is never swept');

  fs.writeFileSync(path.join(dir, 'kidtwo.json'), JSON.stringify({ child: 'Kid;op', character: 'x' }));
  fs.writeFileSync(path.join(dir, '_home-steve.json'), 'not json');
  assert.equal(sweepBrokenClaims(dir, later), 1, 'only the bad claim goes');
  assert.ok(fs.existsSync(file), 'the valid claim stays');
  assert.ok(fs.existsSync(path.join(dir, '_home-steve.json')), 'home files are not claims');
});

test('an idle character picks up a player whose character went away', async () => {
  await withCompanions('Rosie,Steve', async () => {
    const dir = tmpDir();
    const env = { HERMESCRAFT_FOLLOW_ON_JOIN: '1', HERMESCRAFT_COMPANION_NAMES: 'Rosie,Steve' };
    const rosie = fakeBot('Rosie', { players: ['Rosie', 'Steve', 'KidOne'] });
    const steve = fakeBot('Steve', { players: ['Rosie', 'Steve', 'KidOne'] });
    const downRosie = installFollowOnJoin(rosie, () => {}, { env, claimDir: dir, config: FAST });
    const downSteve = installFollowOnJoin(steve, () => {}, { env, claimDir: dir, config: FAST });
    try {
      await wait(1400);
      assert.equal(rosie._hc_follow.child(), 'KidOne');
      assert.equal(steve._hc_follow.child(), 'KidOne');
      assert.equal(readClaim(dir, 'KidOne').character, 'Rosie');
      downRosie();                                   // Rosie disconnects; her claim is released
      await wait(400);
      assert.equal(steve._hc_follow.child(), 'KidOne', 'no rejoin needed');
      assert.equal(readClaim(dir, 'KidOne').character, 'Steve', 'the guest becomes primary after release');
      assert.ok(steve.sent.includes('/tp KidOne'));
    } finally {
      downRosie();                                   // idempotent; never leave a timer behind
      downSteve();
    }
  });
});

test('with no roster the follower refuses to run, so a character never follows a character', () => {
  const dir = tmpDir();
  const logs = [];
  const steve = fakeBot('Steve', { players: ['Rosie', 'Steve'] });
  const down = installFollowOnJoin(steve, (m) => logs.push(m), { env: { HERMESCRAFT_FOLLOW_ON_JOIN: '1' }, claimDir: dir });
  assert.equal(steve.listenerCount('playerJoined'), 0);
  assert.ok(logs.some((m) => m.includes('NOT installed')));
  assert.deepEqual(fs.readdirSync(dir), []);
  down();
});

test('the roster passed to the follower decides who is a character, whatever the process env says', () => {
  const companions = new Set(['rosie', 'steve']);
  assert.equal(isFollowCandidate('Rosie', 'Steve', { companions }), false);
  assert.equal(isFollowCandidate('.Rosie', 'Steve', { companions }), false);
  assert.equal(isFollowCandidate('Steve', 'Steve', { companions }), false);
  assert.equal(isFollowCandidate('KidOne', 'Steve', { companions }), true);
  assert.equal(isFollowCandidate('JCam_ab12', 'Steve', { companions }), false);
});

test('a damaged home file is replaced, a valid one is kept, and a strange character name gets none', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '_home-rosie.json'), '{"dim":"overw');     // crash mid-write
  assert.equal(readHome(dir, 'Rosie'), null);
  assert.equal(saveHome(dir, 'Rosie', { dim: 'overworld', x: 1, y: 64, z: 2 }), true, 'damaged: replaced');
  assert.deepEqual(readHome(dir, 'Rosie'), { dim: 'overworld', x: 1, y: 64, z: 2 });
  assert.equal(saveHome(dir, 'Rosie', { dim: 'overworld', x: 9, y: 9, z: 9 }), false, 'valid: kept');

  const outside = path.join(dir, '..', 'escaped.json');
  assert.equal(saveHome(dir, 'x/../../escaped', { dim: 'overworld', x: 1, y: 2, z: 3 }), false);
  assert.equal(readHome(dir, '../escaped'), null);
  assert.equal(fs.existsSync(outside), false);
  assert.deepEqual(fs.readdirSync(dir), ['_home-rosie.json'], 'nothing else was written');
});

test('a claim file only counts for the player it is named after', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'kidone.json');
  fs.writeFileSync(file, JSON.stringify({ child: 'OtherKid', character: 'Steve' }));
  assert.equal(readClaim(dir, 'KidOne'), null, 'the body names someone else');
  assert.deepEqual(claimsHeldBy(dir, 'Steve'), [], 'and it is not Steve\'s claim on anyone');
  assert.equal(tryClaim(dir, 'KidOne', 'Rosie', Date.now() + 5000), 'claimed', 'so it cannot block KidOne');
  assert.equal(readClaim(dir, 'KidOne').character, 'Rosie');
  assert.equal(readClaim(dir, 'kidone').character, 'Rosie', 'lookup ignores case');
});

test('if no way home can be recorded, the player is given back', async () => {
  await withCompanions('Rosie,Steve', async () => {
    const dir = tmpDir();
    const env = { HERMESCRAFT_FOLLOW_ON_JOIN: '1', HERMESCRAFT_COMPANION_NAMES: 'Rosie,Steve' };
    const rosie = fakeBot('Rosie', { players: ['Rosie', 'KidOne'] });
    fs.mkdirSync(path.join(dir, '_home-rosie.json'));   // a directory where the home file should go
    const logs = [];
    const down = installFollowOnJoin(rosie, (m) => logs.push(m), { env, claimDir: dir, config: { ...FAST, rescanMs: 60000 } });
    try {
      await wait(1300);
      assert.equal(rosie._hc_follow.child(), null);
      assert.equal(readClaim(dir, 'KidOne'), null, 'no claim is left behind');
      assert.ok(logs.some((m) => m.includes('cannot save home')));
    } finally {
      down();
    }
  });
});

test('a character that is abroad with no home on file does not take a player', async () => {
  await withCompanions('Rosie,Steve', async () => {
    const dir = tmpDir();
    const env = { HERMESCRAFT_FOLLOW_ON_JOIN: '1', HERMESCRAFT_COMPANION_NAMES: 'Rosie,Steve' };
    const rosie = fakeBot('Rosie', { players: ['Rosie', 'KidOne'] });
    rosie._hc_world = 'bskyblock_world';               // restarted while visiting, breadcrumb gone
    const logs = [];
    const down = installFollowOnJoin(rosie, (m) => logs.push(m), { env, claimDir: dir, config: { ...FAST, rescanMs: 60000 } });
    try {
      await wait(1300);
      assert.equal(rosie._hc_follow.child(), null);
      assert.equal(readClaim(dir, 'KidOne'), null, 'the player stays free for another character');
      assert.ok(!rosie.sent.some((m) => m.startsWith('/tp ')), 'and she goes nowhere');
      assert.ok(logs.some((m) => m.includes('cannot save home')));
    } finally {
      down();
    }
  });
});

test('a character abroad with a home still on file may take the next player', async () => {
  await withCompanions('Rosie,Steve', async () => {
    const dir = tmpDir();
    const env = { HERMESCRAFT_FOLLOW_ON_JOIN: '1', HERMESCRAFT_COMPANION_NAMES: 'Rosie,Steve' };
    saveHome(dir, 'Rosie', { dim: 'overworld', x: 1658.1, y: 63, z: 1723.3 });
    const rosie = fakeBot('Rosie', { players: ['Rosie', 'KidOne'] });
    rosie._hc_world = 'bskyblock_world';
    const down = installFollowOnJoin(rosie, () => {}, { env, claimDir: dir, config: { ...FAST, stayRetryMs: 60000 } });
    try {
      await wait(1300);
      assert.equal(rosie._hc_follow.child(), 'KidOne');
      assert.deepEqual(readHome(dir, 'Rosie'), { dim: 'overworld', x: 1658.1, y: 63, z: 1723.3 }, 'the first home is kept');
    } finally {
      down();
    }
  });
});

test('characters started together take already-online players in roster order', async () => {
  const dir = tmpDir();
  const env = { HERMESCRAFT_FOLLOW_ON_JOIN: '1', HERMESCRAFT_COMPANION_NAMES: 'Rosie,Steve,Reed' };
  const config = { ...FAST, claimStaggerMs: 300, rescanMs: 60000 };
  const names = ['Rosie', 'Steve', 'Reed'];
  const online = [...names, 'KidA', 'KidB', 'KidC'];
  const bots = names.map((n) => fakeBot(n, { players: online }));
  // Installed in reverse, so start order cannot be what decides it.
  const downs = [...bots].reverse().map((b) => installFollowOnJoin(b, () => {}, { env, claimDir: dir, config }));
  try {
    await wait(2200);
    assert.deepEqual(bots.map((b) => b._hc_follow.child()), ['KidA', 'KidB', 'KidC']);
  } finally {
    downs.forEach((d) => d());
  }
});

test('a claim left by a dead process expires; a re-stamped one does not', () => {
  const dir = tmpDir();
  const t0 = Date.now();
  assert.equal(tryClaim(dir, 'KidOne', 'Rosie', t0), 'claimed');
  assert.equal(tryClaim(dir, 'KidOne', 'Steve', t0 + 29000, 30000), 'taken', 'inside the TTL');
  assert.equal(refreshClaim(dir, 'KidOne', 'Rosie', t0 + 29000), true, 'Rosie is alive and re-stamps it');
  assert.equal(tryClaim(dir, 'KidOne', 'Steve', t0 + 50000, 30000), 'taken', 'so it is still hers');
  assert.equal(tryClaim(dir, 'KidOne', 'Steve', t0 + 70000, 30000), 'claimed', 'no stamp for 41 s: her process is gone');
  assert.equal(refreshClaim(dir, 'KidOne', 'Rosie', t0 + 71000), false, 'a late Rosie learns she lost it');
  assert.equal(readClaim(dir, 'KidOne').character, 'Steve');
});

test('a following character keeps its claim fresh, and lets go if a sibling took it', async () => {
  await withCompanions('Rosie,Steve', async () => {
    const dir = tmpDir();
    const env = { HERMESCRAFT_FOLLOW_ON_JOIN: '1', HERMESCRAFT_COMPANION_NAMES: 'Rosie,Steve' };
    const rosie = fakeBot('Rosie', { players: ['Rosie', 'KidOne'] });
    const config = { ...FAST, claimBeatMs: 40, claimTtlMs: 400, rescanMs: 60000 };
    const down = installFollowOnJoin(rosie, () => {}, { env, claimDir: dir, config });
    try {
      await wait(1300);
      assert.equal(rosie._hc_follow.child(), 'KidOne');
      const file = path.join(dir, 'kidone.json');
      const before = fs.statSync(file).mtimeMs;
      await wait(600);                                   // longer than the TTL
      assert.ok(fs.statSync(file).mtimeMs > before, 'the claim was re-stamped');
      assert.equal(tryClaim(dir, 'KidOne', 'Steve', Date.now(), 400), 'taken', 'a live claim outlasts the TTL');

      fs.writeFileSync(file, JSON.stringify({ child: 'KidOne', character: 'Steve' }));   // a sibling took it
      await wait(200);
      assert.equal(rosie._hc_follow.child(), null, 'she lets go');
      assert.equal(readClaim(dir, 'KidOne').character, 'Steve', 'without touching the sibling\'s claim');
    } finally {
      down();
    }
  });
});

const FOLLOW_ENV = { HERMESCRAFT_FOLLOW_ON_JOIN: '1', HERMESCRAFT_COMPANION_NAMES: 'Rosie,Steve' };
const STONE = { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
const AIR = { name: 'air', boundingBox: 'empty', shapes: [] };

function clearanceBot(name = 'Rosie', yaw = 0) {
  const bot = fakeBot(name, { players: ['Rosie', 'Steve', 'KidOne'] });
  bot.entity = { id: name === 'Rosie' ? 1 : 2, position: new Vec3(10.5, 64, 10.5), width: 0.6, height: 1.8 };
  bot.players.KidOne.entity = { id: 3, username: 'KidOne', type: 'player', yaw, position: new Vec3(10.5, 64, 10.5), width: 0.6, height: 1.8 };
  bot.entities = { [bot.entity.id]: bot.entity, 3: bot.players.KidOne.entity };
  bot.blockAt = (p) => p.y === 63 ? STONE : AIR;
  return bot;
}

function localTeleports(bot) {
  return bot.sent.filter((m) => /^\/tp -?[\d.]+ -?[\d.]+ -?[\d.]+$/.test(m));
}

async function installedClearance(bot, fn, opts = {}) {
  const dir = opts.claimDir || tmpDir();
  const down = installFollowOnJoin(bot, () => {}, {
    env: FOLLOW_ENV, claimDir: dir, config: { ...FAST, rescanMs: 40 }, ...opts,
  });
  try {
    bot.emit('playerJoined', { username: 'KidOne' });
    await wait(440);
    await fn(dir);
  } finally { down(); }
}

function tpPosition(command) {
  return new Vec3(...command.split(' ').slice(1).map(Number));
}

test('overlapping idle follower clears the camera to a supported nearby side cell, then settles', async () => {
  const bot = clearanceBot();
  await installedClearance(bot, async () => {
    assert.ok(localTeleports(bot).length > 0, 'overlap is corrected even though distance is zero');
    assert.ok(!bot.sent.includes('/tp KidOne'), 'visible local arrival uses verified coordinates');
    const landing = tpPosition(localTeleports(bot)[0]);
    assert.ok(landing.distanceTo(bot.players.KidOne.entity.position) >= 3);
    assert.ok(landing.distanceTo(bot.players.KidOne.entity.position) <= 6);
    assert.equal(landing.y, 64);
    assert.ok(-(landing.z - 10.5) / Math.hypot(landing.x - 10.5, landing.z - 10.5) <= Math.cos(Math.PI / 12), 'yaw zero looks -Z; correction clears the central view');
    bot.entity.position = landing;
    const count = bot.sent.length;
    await wait(140);
    assert.equal(bot.sent.length, count, 'a clear idle position is stable');
    assert.ok(bot.sent.every((m) => /^\/tp -?[\d.]+ -?[\d.]+ -?[\d.]+$/.test(m)), 'only self coordinate teleports, no world edits');
  });
});

test('roster sides separate both companions, and camera turns use Mineflayer yaw', async () => {
  const dir = tmpDir();
  const rosie = clearanceBot();
  const steve = clearanceBot('Steve');
  await installedClearance(rosie, async () => {
    await installedClearance(steve, async () => {
      assert.ok(localTeleports(rosie).length > 0, 'Rosie must clear the camera');
      assert.ok(localTeleports(steve).length > 0, 'Steve must join and clear the camera');
      const r = tpPosition(localTeleports(rosie)[0]);
      const s = tpPosition(localTeleports(steve)[0]);
      assert.ok(r.distanceTo(s) >= 3, 'roster preference separates simultaneous destinations');
      rosie.entity.position = r;
      const kid = rosie.players.KidOne.entity;
      kid.yaw = Math.atan2(-(r.x - kid.position.x), -(r.z - kid.position.z));
      const before = localTeleports(rosie).length;
      await wait(140);
      assert.ok(localTeleports(rosie).length > before, 'turning toward the companion clears the new view');
      const moved = tpPosition(localTeleports(rosie).at(-1));
      const dx = moved.x - kid.position.x, dz = moved.z - kid.position.z;
      assert.ok((-Math.sin(kid.yaw) * dx - Math.cos(kid.yaw) * dz) / Math.hypot(dx, dz) <= Math.cos(Math.PI / 12));
    }, { claimDir: dir });
  }, { claimDir: dir });
});

for (const [label, change] of [
  ['unloaded chunks', (b) => { b.blockAt = () => null; }],
  ['unsupported air', (b) => { b.blockAt = () => AIR; }],
  ['partial support', (b) => { b.blockAt = (p) => p.y === 63 ? { ...STONE, shapes: [[0, 0, 0, 1, 0.5, 1]] } : AIR; }],
  ['unknown support identity', (b) => { b.blockAt = (p) => p.y === 63 ? { boundingBox: 'block', shapes: STONE.shapes } : AIR; }],
  ['missing collision data', (b) => { b.blockAt = (p) => p.y === 63 ? { name: 'stone', boundingBox: 'block' } : AIR; }],
  ['hazardous support', (b) => { b.blockAt = (p) => p.y === 63 ? { ...STONE, name: 'magma_block' } : AIR; }],
  ['waterlogged support', (b) => { b.blockAt = (p) => p.y === 63 ? { ...STONE, getProperties: () => ({ waterlogged: true }) } : AIR; }],
  ['water at feet', (b) => { b.blockAt = (p) => p.y === 63 ? STONE : { name: 'water', boundingBox: 'empty', shapes: [] }; }],
  ['blocked headroom', (b) => { b.blockAt = (p) => p.y === 63 || p.y >= 65 ? STONE : AIR; }],
  ['entity collision', (b) => { b.entities[9] = { position: new Vec3(10.5, 63, 10.5), width: 30, height: 10 }; }],
  ['unknown yaw', (b) => { delete b.players.KidOne.entity.yaw; }],
  ['nonfinite position', (b) => { b.players.KidOne.entity.position.x = NaN; }],
  ['nonfinite bot position', (b) => { b.entity.position.x = NaN; }],
]) {
  test(`idle camera correction waits honestly with ${label}`, async () => {
    const bot = clearanceBot();
    change(bot);
    await installedClearance(bot, async () => {
      assert.deepEqual(bot.sent, [], 'no unsafe player-target or vanilla fallback');
    });
  });
}

test('an occupied preferred cell is skipped rather than overlapping another entity', async () => {
  const first = clearanceBot();
  let preferred;
  await installedClearance(first, async () => {
    assert.ok(localTeleports(first).length > 0, 'a clear preferred cell must be found');
    preferred = tpPosition(localTeleports(first)[0]);
  });
  const bot = clearanceBot();
  bot.entities[9] = { position: preferred, width: 0.6, height: 1.8 };
  await installedClearance(bot, async () => {
    assert.ok(localTeleports(bot).length > 0, 'an unoccupied alternate cell must be found');
    const landing = tpPosition(localTeleports(bot)[0]);
    assert.ok(Math.abs(landing.x - preferred.x) >= 0.6 || Math.abs(landing.z - preferred.z) >= 0.6);
  });
});

test('requested tasks and stop suppress arrival and camera correction without losing ownership', async () => {
  for (const visible of [true, false]) {
    const bot = clearanceBot();
    if (!visible) { delete bot.players.KidOne.entity; delete bot.entities[3]; }
    let busy = true;
    await installedClearance(bot, async (dir) => {
      assert.equal(readClaim(dir, 'KidOne').character, 'Rosie');
      assert.deepEqual(bot.sent, [], 'active requested task owns movement');
      busy = false;
      bot.interrupt_code = true;
      await wait(100);
      assert.deepEqual(bot.sent, [], 'stop remains authoritative');
      bot.interrupt_code = false;
      await wait(100);
      assert.ok(bot.sent.length > 0, 'idle following resumes');
    }, { isKidTaskActive: () => busy });
  }
});

test('local clearance retries are throttled while server teleport confirmation is pending', async () => {
  const bot = clearanceBot();
  await installedClearance(bot, async () => {
    assert.equal(localTeleports(bot).length, 1, 'one correction pending, no per-tick teleport storm');
  }, { config: { ...FAST, arriveRetryMs: 1000 } });
});

test('guest keeps its own home and neither heartbeats nor releases the primary claim', async () => {
  const dir = tmpDir();
  tryClaim(dir, 'KidOne', 'Rosie');
  const file = path.join(dir, 'kidone.json');
  const stamp = fs.statSync(file).mtimeMs;
  const steve = clearanceBot('Steve');
  await installedClearance(steve, async () => {
    assert.equal(steve._hc_follow.child(), 'KidOne');
    assert.deepEqual(readHome(dir, 'Steve'), { dim: 'overworld', x: 10.5, y: 64, z: 10.5 });
    assert.equal(fs.statSync(file).mtimeMs, stamp, 'guest does not heartbeat');
    steve._hc_world = 'bskyblock_world';
    delete steve.players.KidOne;
    await wait(300);
    assert.equal(steve._hc_follow.child(), null);
    assert.ok(steve.sent.some((m) => m === '/execute in minecraft:overworld run minecraft:tp @s 10.50 64.00 10.50'));
    assert.equal(readClaim(dir, 'KidOne').character, 'Rosie');
    steve.players.KidOne = { username: 'KidOne' };
    steve.emit('playerJoined', { username: 'KidOne' });
    await wait(400);
    assert.equal(steve._hc_follow.child(), 'KidOne', 'guest can rejoin using its original home');
  }, { claimDir: dir, config: { ...FAST, claimBeatMs: 40 } });
  assert.equal(readClaim(dir, 'KidOne').character, 'Rosie');
});

test('a guest rides out a tab-list flicker and takes over a stale primary without rejoining', async () => {
  const dir = tmpDir();
  tryClaim(dir, 'KidOne', 'Rosie');
  const steve = clearanceBot('Steve');
  await installedClearance(steve, async () => {
    assert.equal(steve._hc_follow.child(), 'KidOne');
    assert.equal(readClaim(dir, 'KidOne').character, 'Rosie');
    const child = steve.players.KidOne;
    delete steve.players.KidOne;
    await wait(50);
    steve.players.KidOne = child;
    await wait(150);
    assert.equal(steve._hc_follow.child(), 'KidOne', 'guest survives the same leave grace as a primary');
    assert.ok(!steve.sent.some((m) => m.startsWith('/execute')));
    await wait(450);
    assert.equal(readClaim(dir, 'KidOne').character, 'Steve', 'a guest does not keep a dead primary alive');
  }, { claimDir: dir, config: { ...FAST, rescanMs: 40, claimBeatMs: 40, claimTtlMs: 800 } });
});

test('visible arrival with no loaded safe cell waits rather than falling back to a player teleport', async () => {
  const bot = clearanceBot();
  bot.entity.position = new Vec3(30.5, 64, 10.5);
  bot.blockAt = () => null;
  await installedClearance(bot, async () => { assert.deepEqual(bot.sent, []); });
});

test('an elevated-only landing inside horizontal clearance is refused without repeated corrections', async () => {
  const bot = clearanceBot();
  bot.players.KidOne.entity.position = new Vec3(10, 64, 10);
  bot.entity.position = new Vec3(10, 64, 10);
  bot.blockAt = (p) => {
    if (p.x === 12.5 && p.z === 11.5) {
      if (p.y === 64) return STONE;
      if (p.y === 65 || p.y === 66) return AIR;
    }
    return null;
  };
  await installedClearance(bot, async () => {
    assert.deepEqual(bot.sent, [], '3D distance above three cannot excuse horizontal overlap');
  });
});

test('an off-centre visible companion remains still while the player looks past it', async () => {
  const bot = clearanceBot();
  bot.entity.position = new Vec3(13.5, 64, 6.5); // five blocks away, 37 degrees off-centre
  await installedClearance(bot, async () => {
    assert.deepEqual(bot.sent, [], 'a companion near the edge of view is welcome to stay visible');
  });
});

// Execute the production synchronous action route, following the extraction
// pattern in build_claims_wiring.test.js. No listener or Minecraft is started.
const serverSource = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
function synchronousActionHarness(initialBot, ACTIONS) {
  const armStart = serverSource.indexOf('function armIntentRoutedAction(');
  const armSource = serverSource.slice(armStart, serverSource.indexOf('\nfunction isActionEpochCurrent', armStart));
  const routeStart = serverSource.indexOf('const actionName = actionMatch[1];', serverSource.indexOf('// Synchronous action:'));
  const routeSource = serverSource.slice(routeStart, serverSource.indexOf('\n    }\n\n    respond(res, 404', routeStart));
  return new Function('initialBot', 'ACTIONS', `
    let bot = initialBot;
    const actionHistory = [], MAX_ACTION_HISTORY = 40;
    const briefState = () => ({});
    const respond = (_res, status, payload) => ({ status, payload });
    ${armSource}
    return {
      handle: async (name, body = {}) => {
        const actionMatch = ['', name], res = {};
        ${routeSource}
      },
      replaceBot: (next) => { bot = next; },
      history: actionHistory,
    };
  `)(initialBot, ACTIONS);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const action of ['goto', 'give_to_player']) {
  test(`synchronous ${action} owns movement until the production route finishes awaiting it`, async () => {
    const bot = clearanceBot();
    const done = deferred();
    const result = { result: `${action} complete`, detail: { preserved: true } };
    const route = synchronousActionHarness(bot, { [action]: async () => { await done.promise; return result; } });
    const pending = route.handle(action);
    try {
      await installedClearance(bot, async () => {
        assert.deepEqual(bot.sent, [], 'idle correction cannot interrupt the requested synchronous action');
        assert.equal(bot._hc_intent_action_depth, 1);
        done.resolve();
        assert.deepEqual(await pending, { status: 200, payload: { ok: true, ...result, state: {} } });
        assert.equal(bot._hc_intent_action_depth, 0);
        await wait(100);
        assert.ok(localTeleports(bot).length > 0, 'idle clearance resumes after the action settles');
      });
    } finally { done.resolve(); await pending; }
    assert.equal(bot._actionEpoch, 1, 'ownership must not re-arm or replace the action epoch');
    assert.equal(route.history.length, 1);
    assert.equal(route.history[0].status, 'done');
  });
}

test('synchronous action ownership unwinds on rejection and synchronous throw without changing the error', async () => {
  for (const syncThrow of [false, true]) {
    const bot = clearanceBot();
    const failure = new Error('requested action failed');
    const done = deferred();
    const action = syncThrow ? () => { throw failure; } : async () => { await done.promise; throw failure; };
    const route = synchronousActionHarness(bot, { give_to_player: action });
    const pending = route.handle('give_to_player');
    const rejection = assert.rejects(pending, (error) => error === failure);
    try {
      if (!syncThrow) assert.equal(bot._hc_intent_action_depth, 1);
    } finally { done.resolve(); await rejection; }
    assert.equal(bot._hc_intent_action_depth, 0, 'no leaked busy depth after failure');
    assert.deepEqual(route.history, [], 'the existing error path does not report success');
    assert.equal(bot._actionEpoch, 1);
  }
});

test('overlapping synchronous requests retain ownership until both finish', async () => {
  const bot = clearanceBot(), first = deferred(), second = deferred();
  const route = synchronousActionHarness(bot, {
    goto: async () => { await first.promise; return { result: 'arrived' }; },
    give_to_player: async () => { await second.promise; return { result: 'given' }; },
  });
  const one = route.handle('goto'), two = route.handle('give_to_player');
  try {
    assert.equal(bot._hc_intent_action_depth, 2);
    first.resolve(); await one;
    assert.equal(bot._hc_intent_action_depth, 1, 'one completion cannot release the other request');
    second.resolve(); await two;
    assert.equal(bot._hc_intent_action_depth, 0);
    assert.equal(bot._actionEpoch, 2);
  } finally { first.resolve(); second.resolve(); await Promise.all([one, two]); }
});

test('reconnecting during a synchronous request releases the original bot only', async () => {
  const original = clearanceBot(), replacement = clearanceBot(), done = deferred();
  replacement._hc_intent_action_depth = 7;
  const route = synchronousActionHarness(original, { goto: async () => { await done.promise; return { result: 'arrived' }; } });
  const pending = route.handle('goto');
  try {
    assert.equal(original._hc_intent_action_depth, 1);
    route.replaceBot(replacement);
    done.resolve(); await pending;
    assert.equal(original._hc_intent_action_depth, 0);
    assert.equal(replacement._hc_intent_action_depth, 7, 'a completed old request cannot decrement the new connection');
  } finally { done.resolve(); await pending; }
});

function productionMovementAction(name, next, bot) {
  const start = serverSource.indexOf(`  async ${name}(`);
  const source = serverSource.slice(start, serverSource.indexOf(next, start));
  return new Function('ensureBot', 'goals', 'findPlayerEntity', 'normalizePlayerName', 'currentTask',
    `return ({${source}}).${name};`)(() => bot, pathfinderPkg.goals, findPlayerEntity, normalizePlayerName, null);
}

test('synchronous stop retains its stop generation, action epoch and response contracts', async () => {
  const bot = clearanceBot();
  bot.pathfinder = { goal: {}, setGoal(goal) { this.goal = goal; } };
  bot.stopDigging = () => {};
  const stop = productionMovementAction('stop', '\n  // ── Mining', bot);
  const route = synchronousActionHarness(bot, { stop });
  const response = await route.handle('stop');
  assert.deepEqual(response, { status: 200, payload: { ok: true, result: 'Stopped all actions.', state: {} } });
  assert.equal(bot._actionEpoch, 2, 'existing arm + stop epoch increments are preserved');
  assert.equal(bot._stopGeneration, 1);
  assert.equal(bot.interrupt_code, true);
  assert.equal(bot.pathfinder.goal, null);
  assert.equal(bot._hc_intent_action_depth, 0);
});

test('finishing a synchronous request after stop does not clear the stop or rewind its epoch', async () => {
  const bot = clearanceBot(), done = deferred();
  bot.pathfinder = { goal: {}, setGoal(goal) { this.goal = goal; } };
  bot.stopDigging = () => {};
  const route = synchronousActionHarness(bot, {
    goto: async () => { await done.promise; return { result: 'interrupted' }; },
    stop: productionMovementAction('stop', '\n  // ── Mining', bot),
  });
  const pending = route.handle('goto');
  try {
    await route.handle('stop');
    assert.equal(bot._hc_intent_action_depth, 1, 'the pending request retains its own depth after stop returns');
    assert.equal(bot._actionEpoch, 3);
    done.resolve(); await pending;
    assert.equal(bot._hc_intent_action_depth, 0);
    assert.equal(bot.interrupt_code, true, 'completion must not resume stopped idle movement');
    assert.equal(bot._actionEpoch, 3);
    assert.equal(bot._stopGeneration, 1);
  } finally { done.resolve(); await pending; }
});

for (const action of ['follow', 'follow_player_v2']) {
  test(`requested ${action} keeps its sustained goal after returning and suppresses idle clearance`, async () => {
    const bot = clearanceBot();
    bot.pathfinder = { goal: null, isMoving: () => false, setGoal(goal) { this.goal = goal; } };
    const actions = registerHighLevelSkills({}, () => bot);
    actions.follow = productionMovementAction('follow', '\n\n  async look(', bot);
    const route = synchronousActionHarness(bot, actions);
    const response = await route.handle(action, { player: 'KidOne' });
    assert.equal(response.status, 200);
    assert.ok(bot.pathfinder.goal instanceof pathfinderPkg.goals.GoalFollow);
    assert.match(response.payload.result, /Following KidOne/);
    await installedClearance(bot, async () => {
      assert.deepEqual(bot.sent, [], 'an active follow goal owns movement even while standing within its radius');
      bot.pathfinder.setGoal(null);
      await wait(100);
      assert.ok(localTeleports(bot).length > 0, 'idle correction resumes once the requested goal is cleared');
    });
  });
}
