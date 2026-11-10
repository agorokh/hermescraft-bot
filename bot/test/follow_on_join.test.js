import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  FOLLOW_DEFAULTS,
  followEnabled,
  claimDirFromEnv,
  readClaim,
  sweepBrokenClaims,
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

test('two players get two different characters; a lone player gets exactly one', async () => {
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
      assert.equal(steve._hc_follow.child(), null, 'a claimed player is not followed twice');
      assert.ok(rosie.sent.includes('/tp KidOne'));
      assert.equal(steve.sent.length, 0);

      for (const b of [rosie, steve]) {
        b.players.KidTwo = { username: 'KidTwo' };
        b.emit('playerJoined', { username: 'KidTwo' });
      }
      await wait(700);
      assert.equal(rosie._hc_follow.child(), 'KidOne', 'a busy character takes no second player');
      assert.equal(steve._hc_follow.child(), 'KidTwo');
      assert.ok(steve.sent.includes('/tp KidTwo'));
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
      assert.equal(steve._hc_follow.child(), null);
      downRosie();                                   // Rosie disconnects; her claim is released
      await wait(400);
      assert.equal(steve._hc_follow.child(), 'KidOne', 'no rejoin needed');
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
