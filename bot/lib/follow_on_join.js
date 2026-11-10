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
  homeRadius: 2,          // blocks: this close to the saved spot counts as back home
  rescanMs: 10000,        // an idle character looks again for a player nobody has
  claimBeatMs: 5000,      // a following character re-stamps its claim this often
  claimTtlMs: 30000,      // a claim not re-stamped for this long belonged to a dead process
});

// A claim file is written in one call, but a reader can still catch it empty.
// Only a file that has been unreadable for this long is treated as broken.
const BROKEN_CLAIM_AGE_MS = 2000;

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

// Default under the user's home, not the temp dir: every character run by this
// user sees the same directory (a per-process private tmp would hide the claims
// from each other), and no other local user can plant files in it.
export function claimDirFromEnv(env = process.env) {
  return env.HERMESCRAFT_FOLLOW_CLAIM_DIR || path.join(os.homedir(), '.hermescraft', 'follow-claims');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function validOrigin(origin) {
  return !!origin
    && DIMENSION_RE.test(String(origin.dim || ''))
    && [origin.x, origin.y, origin.z].every((v) => typeof v === 'number' && Number.isFinite(v));
}

export function homeDimensionFromEnv(env = process.env) {
  const dim = String(env.HERMESCRAFT_HOME_DIMENSION || 'overworld');
  return DIMENSION_RE.test(dim) ? dim : 'overworld';
}

export function isSafePlayerName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

// The roster of characters, lower-cased, from the same variable the launcher
// exports for the quest engine.
export function companionNamesFromEnv(env = process.env) {
  return new Set(String(env.HERMESCRAFT_COMPANION_NAMES || '')
    .split(',').map((s) => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean));
}

export function isFollowCandidate(username, botName, opts = {}) {
  if (!isSafePlayerName(username)) return false;
  const bare = username.toLowerCase().replace(/^\./, '');
  if (opts.companions) {
    if (bare === String(botName || '').toLowerCase() || opts.companions.has(bare)) return false;
  } else if (isCompanionSpeaker(username, botName)) {
    return false;
  }
  const prefixes = opts.exemptPrefixes || DEFAULT_EXEMPT_PREFIXES;
  return !prefixes.some((p) => username.startsWith(p));
}

function claimPath(dir, child) {
  return path.join(dir, `${child.toLowerCase()}.json`);
}

// A claim is only valid for the player its file is named after.
function validClaim(claim, stem) {
  return !!claim
    && typeof claim.character === 'string'
    && isSafePlayerName(claim.child)
    && claim.child.toLowerCase() === String(stem).toLowerCase();
}

export function readClaim(dir, child) {
  try {
    const claim = JSON.parse(fs.readFileSync(claimPath(dir, child), 'utf8'));
    return validClaim(claim, child) ? claim : null;
  } catch {
    return null;
  }
}

// Remove a claim file nobody can read (damaged, or planted with a bad body), so
// it cannot block a player forever. A file younger than BROKEN_CLAIM_AGE_MS is
// left alone: it may be a sibling's claim that is still being written.
export function removeBrokenClaim(file, now = Date.now()) {
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (now - stat.mtimeMs < BROKEN_CLAIM_AGE_MS) return false;
  try {
    const claim = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (validClaim(claim, path.basename(file, '.json'))) return false;
  } catch { /* unreadable: broken */ }
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

export function sweepBrokenClaims(dir, now = Date.now()) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('_home-'));
  } catch {
    return 0;
  }
  return names.filter((n) => removeBrokenClaim(path.join(dir, n), now)).length;
}

// A following character re-stamps its claim file every claimBeatMs. Returns
// false when the claim is no longer this character's (a sibling took it after
// this process stalled past the TTL), so the caller can let go.
export function refreshClaim(dir, child, character, now = Date.now()) {
  if (readClaim(dir, child)?.character !== character) return false;
  try {
    const stamp = new Date(now);
    fs.utimesSync(claimPath(dir, child), stamp, stamp);
    return true;
  } catch {
    return false;
  }
}

function claimAgeMs(file, now) {
  try { return now - fs.statSync(file).mtimeMs; } catch { return 0; }
}

// Returns 'claimed' (we now own it), 'mine' (we already did) or 'taken'.
// A valid claim that has not been re-stamped for ttlMs was left by a process
// that died without releasing it, and is replaced.
export function tryClaim(dir, child, character, now = Date.now(), ttlMs = FOLLOW_DEFAULTS.claimTtlMs) {
  if (!isSafePlayerName(child)) return 'taken';
  ensureDir(dir);
  const file = claimPath(dir, child);
  const body = JSON.stringify({ child, character, claimed_at: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, body, { flag: 'wx' });
      return 'claimed';
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = readClaim(dir, child)?.character;
      if (owner === character) return 'mine';
      if (owner) {
        if (claimAgeMs(file, now) < ttlMs) return 'taken';
        try { fs.unlinkSync(file); } catch { return 'taken'; } // stale: its owner is gone
        continue;
      }
      if (!removeBrokenClaim(file, now)) return 'taken'; // fresh: someone is writing it
    }
  }
  return 'taken';
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
      if (claim?.character === character && validClaim(claim, path.basename(n, '.json'))) held.push(claim);
    } catch { /* unreadable claim: leave it for its owner */ }
  }
  return held;
}

// Where a character was standing, in its home world, before it first left to
// follow someone. Kept apart from the claims so it survives a restart and a
// released claim. The '-' in the file name cannot occur in a player name, so it
// never collides with a claim file.
// The character name goes into a file name, so it must be a plain player name:
// anything else (a slash, a dot-dot) gets no home file at all.
function homePath(dir, character) {
  if (!isSafePlayerName(character) || character.startsWith('.')) return null;
  return path.join(dir, `_home-${character.toLowerCase()}.json`);
}

export function saveHome(dir, character, origin) {
  const file = homePath(dir, character);
  if (!file || !validOrigin(origin)) return false;
  ensureDir(dir);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(origin), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // A valid one is kept: later positions may already be abroad. A damaged
      // one would strand the character, and only this character writes this
      // file, so replace it.
      if (readHome(dir, character)) return false;
      try { fs.unlinkSync(file); } catch { return false; }
    }
  }
  return false;
}

export function readHome(dir, character) {
  const file = homePath(dir, character);
  if (!file) return null;
  try {
    const origin = JSON.parse(fs.readFileSync(file, 'utf8'));
    return validOrigin(origin) ? origin : null; // a damaged or planted file is not a destination
  } catch {
    return null;
  }
}

export function clearHome(dir, character) {
  const file = homePath(dir, character);
  if (!file) return;
  try { fs.unlinkSync(file); } catch { /* none saved */ }
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
  if (!validOrigin(origin)) return null;
  const [x, y, z] = [origin.x, origin.y, origin.z].map((v) => v.toFixed(2));
  // minecraft:tp, not tp: EssentialsX owns the bare command and refuses spots
  // it judges unsafe ("Hole in floor!"). The saved home is where the character
  // was standing, so the vanilla teleport is the right one.
  return `/execute in minecraft:${origin.dim} run minecraft:tp @s ${x} ${y} ${z}`;
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

  // Without the roster a character cannot tell another character from a player,
  // and would follow it. Refuse to run instead.
  const companions = opts.companions || companionNamesFromEnv(env);
  if (companions.size === 0) {
    log('follow-on-join NOT installed: HERMESCRAFT_COMPANION_NAMES is empty, so characters cannot be told from players');
    bot._hc_follow = { child: () => null, isVisiting: () => false };
    return () => {};
  }
  const candidateOpts = { companions, exemptPrefixes: opts.exemptPrefixes };
  if (!isSafePlayerName(bot.username) || String(bot.username).startsWith('.')) {
    log('follow-on-join NOT installed: this character has no plain player name');
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

  // Visiting is a fact about where the character is, not about whom it follows:
  // after its player leaves it is still a guest until it is back in its own world.
  bot._hc_follow = {
    child: () => state?.child || null,
    isVisiting: () => currentDim() !== homeDim,
  };

  function originNow() {
    const pos = bot.entity?.position;
    if (!pos || currentDim() !== homeDim) return null;
    return { dim: homeDim, x: pos.x, y: pos.y, z: pos.z };
  }

  // "Home" is the saved spot, not merely the home world: a character that
  // followed a player across its own world is still away. The saved spot is only
  // dropped once the character is seen standing on it, so a refused teleport is
  // retried by the tick instead of forgotten.
  let lastHomeTryAt = 0;
  function atSavedSpot(origin) {
    const pos = bot.entity?.position;
    if (!pos || currentDim() !== origin.dim) return false;
    return Math.hypot(pos.x - origin.x, pos.y - origin.y, pos.z - origin.z) <= cfg.homeRadius;
  }
  function goHome(why) {
    const origin = readHome(dir, me);
    if (!origin) {
      if (why && currentDim() !== homeDim) {
        logFollow(`${why}: no saved home, staying put (use the console's Anchor home)`);
      }
      return;
    }
    if (atSavedSpot(origin)) { clearHome(dir, me); return; }
    const cmd = returnHomeCommand(origin);
    lastHomeTryAt = Date.now();
    logFollow(`${why || 'still away'}: returning to ${origin.dim} ${Math.floor(origin.x)},${Math.floor(origin.y)},${Math.floor(origin.z)}`);
    say(cmd);
  }

  function consider(child) {
    if (!running || !isFollowCandidate(child, me, candidateOpts)) return;
    if (!isOnline(child)) return;
    // One player per character. Busy means "has a player", online or not: during
    // the leave grace the player is briefly absent, and taking a second one then
    // would orphan the first claim.
    if (state) return;
    let result;
    try {
      result = tryClaim(dir, child, me, Date.now(), cfg.claimTtlMs);
    } catch (e) {
      logFollow(`claim error for ${child}: ${e.message}`);
      return;
    }
    if (result === 'taken') return;
    // A character only follows with a way back on record: one saved just now
    // from its own world, or an earlier one still on file while it is abroad.
    // With none, it gives the player back rather than hold a claim it is not
    // acting on or travel with no way home.
    let homeProblem = null;
    try {
      saveHome(dir, me, originNow());
      if (!readHome(dir, me)) homeProblem = 'no readable home on file';
    } catch (e) {
      homeProblem = e.message;
    }
    if (homeProblem) {
      logFollow(`cannot save home (${homeProblem}); not following ${child}`);
      try { releaseClaim(dir, child, me); } catch { /* best effort */ }
      return;
    }
    state = { child, claimedAt: Date.now(), lastTpAt: 0, lastBeatAt: Date.now() };
    logFollow(`following ${child} (${result})`);
  }

  // Starts at "now", so the first scan is the staggered one scheduled at install
  // and not an early tick: with several characters started together, roster
  // order decides who gets a player who was already online.
  let lastScanAt = Date.now();
  function scanForUnclaimed() {
    lastScanAt = Date.now();
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
    if (!running || !bot.entity) return;
    if (!state) {
      if (Date.now() - lastHomeTryAt >= cfg.stayRetryMs) goHome('');
      // A sibling that disconnected has released its player: nobody announces
      // that, so an idle character looks again now and then.
      if (Date.now() - lastScanAt >= cfg.rescanMs) scanForUnclaimed();
      return;
    }
    if (!isOnline(state.child)) {
      state.missingSince = state.missingSince || Date.now();
      if (Date.now() - state.missingSince >= cfg.leaveGraceMs) release('left');
      return;
    }
    state.missingSince = 0;
    if (Date.now() - state.lastBeatAt >= cfg.claimBeatMs) {
      state.lastBeatAt = Date.now();
      if (!refreshClaim(dir, state.child, me)) {
        // This process stalled long enough for a sibling to take the player.
        const lost = state.child;
        state = null;
        goHome(`lost the claim on ${lost}`);
        return;
      }
    }
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
    // Bare /tp on purpose. Where EssentialsX owns it, a player-target teleport
    // refuses an unsafe landing instead of dropping the character into the void
    // under a player who is mid-air, and this tick simply asks again. The trip
    // home is different: that spot is known good, so it uses minecraft:tp.
    say(`/tp ${state.child}`);
  }

  // A previous run of this character may have died while visiting. Its claims
  // are stale: drop them, and go back to where that run set out from.
  for (const claim of claimsHeldBy(dir, me)) {
    try { releaseClaim(dir, claim.child, me); } catch { /* best effort */ }
  }
  try { sweepBrokenClaims(dir); } catch { /* best effort */ }
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
