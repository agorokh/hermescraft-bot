import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isCompanionSpeaker } from './quests.js';
import { findPlayerEntity } from './player_utils.js';

// Follow-on-join (hermescraft#544, stage 1).
//
// When a player who is not a companion joins, one character teleports to that
// player and stays with them, whichever world the server routed them to. The
// characters are separate processes, so they agree on who follows whom through
// claim files: the first character to create `<player>.json` exclusively owns
// that player until the player leaves. A character that already has a player
// takes no second one, which is how two children get two different characters.
//
// Off unless HERMESCRAFT_FOLLOW_ON_JOIN=1. Zero LLM calls. The follower places
// and breaks nothing: it only issues `/tp`.

const NAME_RE = /^\.?[A-Za-z0-9_]{1,16}$/;
const DIMENSION_RE = /^[a-z0-9_.\-/]{1,64}$/;
const DEFAULT_EXEMPT_PREFIXES = ['JCam_', 'PCam_'];

export const FOLLOW_DEFAULTS = Object.freeze({
  arriveRadius: 6,        // blocks: close enough, stop teleporting
  arriveWindowMs: 60000,  // after a claim, close any gap for this long
  arriveRetryMs: 5000,    // spacing of teleports while arriving
  stayRetryMs: 10000,     // spacing of teleports once settled
  tickMs: 2000,
  claimStaggerMs: 1500,   // per roster position, so the first-listed character wins ties
  leaveGraceMs: 3000,     // a Bedrock join drops and re-adds the tab-list entry; wait before believing a leave
});

// mineflayer's bot.game.dimension is the dimension TYPE: a skyblock world and
// the main world both read "overworld". The world's own name only appears in
// the login and respawn packets, so remember it from there.
export function worldNameFromPacket(packet) {
  const state = packet?.worldState || packet || {};
  const raw = state.name ?? state.worldName;
  return typeof raw === 'string' && raw ? raw.replace(/^minecraft:/, '') : null;
}

// Call right after createBot, before login, so the first world is seen too.
export function trackWorldName(bot) {
  const onPacket = (packet) => {
    const name = worldNameFromPacket(packet);
    if (name) bot._hc_world = name;
  };
  bot._client?.on('login', onPacket);
  bot._client?.on('respawn', onPacket);
}

export function currentWorldName(bot) {
  return bot._hc_world || String(bot.game?.dimension || '').replace(/^minecraft:/, '');
}

export function followEnabled(env = process.env) {
  return env.HERMESCRAFT_FOLLOW_ON_JOIN === '1';
}

export function claimDirFromEnv(env = process.env) {
  return env.HERMESCRAFT_FOLLOW_CLAIM_DIR || path.join(os.tmpdir(), 'hermescraft-follow-claims');
}

export function homeDimensionFromEnv(env = process.env) {
  const dim = String(env.HERMESCRAFT_HOME_DIMENSION || 'overworld');
  return DIMENSION_RE.test(dim) ? dim : 'overworld';
}

export function isSafePlayerName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

export function isFollowCandidate(username, botName, opts = {}) {
  if (!isSafePlayerName(username)) return false;
  if (isCompanionSpeaker(username, botName)) return false;
  const prefixes = opts.exemptPrefixes || DEFAULT_EXEMPT_PREFIXES;
  return !prefixes.some((p) => username.startsWith(p));
}

function claimPath(dir, child) {
  return path.join(dir, `${child.toLowerCase()}.json`);
}

export function readClaim(dir, child) {
  try {
    return JSON.parse(fs.readFileSync(claimPath(dir, child), 'utf8'));
  } catch {
    return null;
  }
}

// Returns 'claimed' (we now own it), 'mine' (we already did) or 'taken'.
export function tryClaim(dir, child, character) {
  if (!isSafePlayerName(child)) return 'taken';
  fs.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify({ child, character, claimed_at: new Date().toISOString() });
  try {
    fs.writeFileSync(claimPath(dir, child), body, { flag: 'wx' });
    return 'claimed';
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return readClaim(dir, child)?.character === character ? 'mine' : 'taken';
  }
}

export function releaseClaim(dir, child, character) {
  if (!isSafePlayerName(child)) return false;
  if (readClaim(dir, child)?.character !== character) return false;
  try {
    fs.unlinkSync(claimPath(dir, child));
    return true;
  } catch {
    return false;
  }
}

export function claimsHeldBy(dir, character) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('_home-'));
  } catch {
    return [];
  }
  const held = [];
  for (const n of names) {
    try {
      const claim = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (claim?.character === character && isSafePlayerName(claim.child)) held.push(claim);
    } catch { /* unreadable claim: leave it for its owner */ }
  }
  return held;
}

// Where a character was standing, in its home world, before it first left to
// follow someone. Kept apart from the claims so it survives a restart and a
// released claim. The '-' in the file name cannot occur in a player name, so it
// never collides with a claim file.
function homePath(dir, character) {
  return path.join(dir, `_home-${String(character).toLowerCase()}.json`);
}

export function saveHome(dir, character, origin) {
  if (!origin) return false;
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(homePath(dir, character), JSON.stringify(origin), { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return false; // keep the first one: later positions may already be abroad
  }
}

export function readHome(dir, character) {
  try {
    return JSON.parse(fs.readFileSync(homePath(dir, character), 'utf8'));
  } catch {
    return null;
  }
}

export function clearHome(dir, character) {
  try { fs.unlinkSync(homePath(dir, character)); } catch { /* none saved */ }
}

// What the follower should do on this tick. Pure, so the timing rules are testable.
export function nextFollowAction(state, now, cfg = FOLLOW_DEFAULTS) {
  const sinceTp = now - (state.lastTpAt || 0);
  const arriving = now - state.claimedAt < cfg.arriveWindowMs;
  if (state.childVisible && state.distance <= cfg.arriveRadius) return 'wait';
  if (arriving) return sinceTp >= cfg.arriveRetryMs ? 'tp' : 'wait';
  // Settled: a child who walked off is still in view, so leave them be. Only a
  // child who is gone from view (another world, or far away) pulls us along.
  if (state.childVisible) return 'wait';
  return sinceTp >= cfg.stayRetryMs ? 'tp' : 'wait';
}

export function returnHomeCommand(origin) {
  if (!origin || !DIMENSION_RE.test(String(origin.dim || ''))) return null;
  const coords = [origin.x, origin.y, origin.z].map((v) => Number(v));
  if (!coords.every(Number.isFinite)) return null;
  const [x, y, z] = coords.map((v) => v.toFixed(2));
  return `/execute in minecraft:${origin.dim} run tp @s ${x} ${y} ${z}`;
}

function rosterIndex(botName, env = process.env) {
  const names = String(env.HERMESCRAFT_COMPANION_NAMES || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const i = names.indexOf(String(botName || '').toLowerCase());
  return i < 0 ? 0 : i;
}

/**
 * installFollowOnJoin(bot, log, opts) → teardown fn
 *
 * Sets bot._hc_follow = { child(), isVisiting() } for other loops to read.
 */
export function installFollowOnJoin(bot, log, opts = {}) {
  const env = opts.env || process.env;
  if (!followEnabled(env) && opts.enabled !== true) {
    bot._hc_follow = { child: () => null, isVisiting: () => false };
    return () => {};
  }

  const cfg = { ...FOLLOW_DEFAULTS, ...(opts.config || {}) };
  const dir = opts.claimDir || claimDirFromEnv(env);
  const homeDim = opts.homeDimension || homeDimensionFromEnv(env);
  const me = bot.username;
  const stagger = rosterIndex(me, env) * cfg.claimStaggerMs;
  const logFollow = (msg) => log(`[follow] ${msg}`);

  let running = true;
  let state = null; // { child, claimedAt, lastTpAt, missingSince }
  const timers = new Set();

  const later = (fn, ms) => {
    const t = setTimeout(() => { timers.delete(t); if (running) fn(); }, ms);
    timers.add(t);
  };
  const currentDim = () => currentWorldName(bot);
  const isOnline = (name) => Object.keys(bot.players || {})
    .some((n) => n.toLowerCase() === String(name).toLowerCase());
  const say = (cmd) => { try { bot.chat(cmd); } catch (e) { logFollow(`chat failed: ${e.message}`); } };

  bot._hc_follow = {
    child: () => state?.child || null,
    isVisiting: () => !!state && currentDim() !== homeDim,
  };

  function originNow() {
    const pos = bot.entity?.position;
    if (!pos || currentDim() !== homeDim) return null;
    return { dim: homeDim, x: pos.x, y: pos.y, z: pos.z };
  }

  function goHome(why) {
    if (currentDim() === homeDim) { clearHome(dir, me); return; }
    const origin = readHome(dir, me);
    const cmd = returnHomeCommand(origin);
    if (!cmd) {
      logFollow(`${why}: no saved home, staying put (use the console's Anchor home)`);
      return;
    }
    logFollow(`${why}: returning to ${origin.dim} ${Math.floor(origin.x)},${Math.floor(origin.y)},${Math.floor(origin.z)}`);
    say(cmd);
    clearHome(dir, me);
  }

  function consider(child) {
    if (!running || !isFollowCandidate(child, me, opts)) return;
    if (!isOnline(child)) return;
    if (state && isOnline(state.child)) return; // one child per character
    let result;
    try {
      result = tryClaim(dir, child, me);
      if (result !== 'taken') saveHome(dir, me, originNow());
    } catch (e) {
      logFollow(`claim error for ${child}: ${e.message}`);
      return;
    }
    if (result === 'taken') return;
    state = { child, claimedAt: Date.now(), lastTpAt: 0 };
    logFollow(`following ${child} (${result})`);
  }

  function scanForUnclaimed() {
    const names = Object.keys(bot.players || {}).sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      if (state) break;
      consider(name);
    }
  }

  function release(why) {
    if (!state) return;
    const { child } = state;
    try { releaseClaim(dir, child, me); } catch { /* best effort */ }
    state = null;
    goHome(`${child} ${why}`);
    later(scanForUnclaimed, stagger + 500);
  }

  function tick() {
    if (!running || !state || !bot.entity) return;
    if (!isOnline(state.child)) {
      state.missingSince = state.missingSince || Date.now();
      if (Date.now() - state.missingSince >= cfg.leaveGraceMs) release('left');
      return;
    }
    state.missingSince = 0;
    const entity = findPlayerEntity(bot, state.child);
    const distance = entity ? bot.entity.position.distanceTo(entity.position) : Infinity;
    const action = nextFollowAction(
      { claimedAt: state.claimedAt, lastTpAt: state.lastTpAt, childVisible: !!entity, distance },
      Date.now(),
      cfg,
    );
    if (action !== 'tp') return;
    state.lastTpAt = Date.now();
    logFollow(`tp to ${state.child} (visible=${!!entity}, dim=${currentDim()})`);
    say(`/tp ${state.child}`);
  }

  // A previous run of this character may have died while visiting. Its claims
  // are stale: drop them, and go back to where that run set out from.
  for (const claim of claimsHeldBy(dir, me)) {
    try { releaseClaim(dir, claim.child, me); } catch { /* best effort */ }
  }
  goHome('start');

  const onJoin = (player) => later(() => consider(player?.username), stagger + 250);
  // No handler for playerLeft: the tick notices an absent player and releases
  // after leaveGraceMs, which rides out a tab-list flicker.
  bot.on('playerJoined', onJoin);
  later(scanForUnclaimed, stagger + 1000);
  const interval = setInterval(tick, cfg.tickMs);

  log(`follow-on-join installed for ${me} (home=${homeDim}, claims=${dir})`);

  return function tearDown() {
    running = false;
    clearInterval(interval);
    for (const t of timers) clearTimeout(t);
    timers.clear();
    try { bot.removeListener('playerJoined', onJoin); } catch {}
    if (state) { try { releaseClaim(dir, state.child, me); } catch {} state = null; }
  };
}
