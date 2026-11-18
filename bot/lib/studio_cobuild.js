import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vec3 } from 'vec3';
import { actionOutcomeFailed } from './action_outcome.js';
import { currentWorldName } from './follow_on_join.js';
import { findPlayerEntity } from './player_utils.js';
import { isCompanionSpeaker } from './quests.js';
import { studioFlightEnabled } from './studio_flight.js';

// Creative-studio co-build (hermescraft#592, preparation for the stage 3 sitting).
//
// A child asks one character for a landmark ("Rosie build the eiffel tower").
// That character writes a plan file. Every character in the studio works
// through the plan's sections: before each one it offers the section to the
// child ("Say mine!"), waits a few seconds, then either leaves it to the child
// or builds it by hand with build_schematic's `section`.
//
// Characters are separate processes, so they agree through files in one
// directory, created exclusively: one plan, one claim per section, one open
// offer at a time (so "mine" has exactly one meaning), a cancel marker.
// Zero LLM calls. Nothing here places a block; build_schematic does.

const SCHEMATICS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schematics');

// Library designs built as a studio co-build, with the name a child hears.
export const STUDIO_DESIGNS = Object.freeze({ eiffel_tower: 'Eiffel Tower' });

export function isStudioDesign(name) {
  return Object.hasOwn(STUDIO_DESIGNS, String(name ?? ''));
}

export const STUDIO_COBUILD_DEFAULTS = Object.freeze({
  offerMs: 8000,          // a character waits this long for an answer before it starts a section
  offerLockTtlMs: 20000,  // an offer lock older than this belonged to a dead process
  pollMs: 250,
  joinTickMs: 2000,       // an idle character looks for a plan to join this often
  watchMs: 1000,          // a building character looks for the cancel marker this often
  planTtlMs: 45 * 60 * 1000,
  joinRadius: 96,         // blocks from the site: farther characters do not join
  siteGap: 6,             // blocks between the child and the near face of the build
});

export function planDirFromEnv(env = process.env) {
  return env.HERMESCRAFT_STUDIO_PLAN_DIR || path.join(os.homedir(), '.hermescraft', 'studio-plans');
}

/** Turn a routed library build of a studio design into the co-build action. */
export function adaptStudioRoute(route, sender) {
  if (!route?.matched || route.action !== 'build_schematic' || !isStudioDesign(route.body?.name)) return route;
  return {
    ...route,
    intent_name: 'studio_build',
    action: 'studio_build',
    body: { name: route.body.name, player: sender },
  };
}

/**
 * What a short chat line means while a section is on offer.
 * @returns {'mine'|'yours'|null}
 */
export function classifyStudioAnswer(text) {
  const line = String(text ?? '').toLowerCase()
    .replace(/^\s*[a-z0-9_.]+\s*[:,]\s*/, '')
    .replace(/[^a-z' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!line || line.split(' ').length > 6) return null;
  if (/\b(?:stop|cancel|wait|quit|nvm|never ?mind)\b/.test(line)) return null;
  if (/\b(?:no|nope|nah|you|u|yours|go ahead|go on)\b/.test(line)) return 'yours';
  if (/\b(?:mine|me|yes|yeah|yep|yup|ok|okay|sure|i will|i'll|ill|i want|i wanna|let me|my turn|i can|i got it|myself)\b/.test(line)) {
    return 'mine';
  }
  return null;
}

/** Where the design goes: on the ground, a few blocks east of the child, centred on them. */
export function studioSiteFor(bot, anchor, footprint, gap = STUDIO_COBUILD_DEFAULTS.siteGap) {
  const cx = Math.floor(anchor.x);
  const cz = Math.floor(anchor.z);
  const feet = Math.floor(anchor.y);
  let y = feet;
  // A child in creative is often hovering: build on the ground below them.
  for (let down = 0; down <= 64; down += 1) {
    const below = bot.blockAt?.(new Vec3(cx, feet - 1 - down, cz));
    if (below && below.boundingBox === 'block') { y = feet - down; break; }
  }
  const length = Number.isInteger(footprint?.[1]) ? footprint[1] : 16;
  return { x: cx + gap, y, z: cz - Math.floor(length / 2) };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function createExclusive(file, value) {
  try {
    fs.writeFileSync(file, JSON.stringify(value), { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

function validPlan(plan) {
  return Boolean(plan && typeof plan.id === 'string' && /^[0-9]+$/.test(plan.id)
    && isStudioDesign(plan.design)
    && Number.isInteger(plan.origin?.x) && Number.isInteger(plan.origin?.y) && Number.isInteger(plan.origin?.z)
    && Number.isFinite(plan.created_at)
    && Array.isArray(plan.sections) && plan.sections.length > 0
    && plan.sections.every(s => typeof s?.name === 'string' && /^[a-z0-9_]{1,32}$/.test(s.name)));
}

export function readPlan(dir) {
  const plan = readJson(path.join(dir, 'plan.json'));
  return validPlan(plan) ? plan : null;
}

const marker = (dir, plan, suffix) => path.join(dir, `${plan.id}.${suffix}`);

/** Claims, finished sections and markers of one plan, read fresh from disk. */
export function planState(dir, plan) {
  const claims = new Map();
  const done = new Set();
  for (const section of plan.sections) {
    const claim = readJson(marker(dir, plan, `${section.name}.claim`));
    if (claim && typeof claim.by === 'string') claims.set(section.name, claim);
    if (fs.existsSync(marker(dir, plan, `${section.name}.done`))) done.add(section.name);
  }
  const open = plan.sections.filter(s => !claims.has(s.name));
  const building = plan.sections.filter(s => claims.has(s.name) && !claims.get(s.name).child && !done.has(s.name));
  return {
    claims,
    done,
    open,
    building,
    cancelled: fs.existsSync(marker(dir, plan, 'cancel')),
    closed: fs.existsSync(marker(dir, plan, 'closing')),
  };
}

/** A plan somebody may still be working on. */
export function planIsLive(dir, plan, now = Date.now(), ttlMs = STUDIO_COBUILD_DEFAULTS.planTtlMs) {
  if (!plan || now - plan.created_at > ttlMs) return false;
  const state = planState(dir, plan);
  if (state.cancelled || state.closed) return false;
  return state.open.length > 0 || state.building.length > 0;
}

/** Replace whatever plan was there with a new one. False when another character got there first. */
export function writeNewPlan(dir, plan) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (name === 'plan.json' || /^[0-9]+\.[a-z0-9_.]+$/.test(name)) {
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* another character removed it */ }
    }
  }
  return createExclusive(path.join(dir, 'plan.json'), plan);
}

export function claimSection(dir, plan, section, by, child = false, now = Date.now()) {
  return createExclusive(marker(dir, plan, `${section}.claim`), { by, child, at: now });
}

export function cancelPlan(dir, plan, reason, now = Date.now()) {
  try { createExclusive(marker(dir, plan, 'cancel'), { reason, at: now }); } catch { /* the plan directory is gone */ }
}

function tryOfferLock(dir, plan, who, now, ttlMs) {
  const file = marker(dir, plan, 'offer');
  if (createExclusive(file, { by: who, at: now })) return true;
  const held = readJson(file);
  let at = held?.at;
  if (!Number.isFinite(at)) {
    try { at = fs.statSync(file).mtimeMs; } catch { return false; }
  }
  if (now - at > ttlMs) {
    try { fs.unlinkSync(file); } catch { /* another character removed it */ }
  }
  return false;
}

function releaseOfferLock(dir, plan, who) {
  const file = marker(dir, plan, 'offer');
  if (readJson(file)?.by !== who) return;
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

/** The next section for this character: one it left unfinished, else the next open one. */
export function pickSection(plan, state, who, role) {
  const unfinished = plan.sections.find(s => state.claims.get(s.name)?.by === who
    && !state.claims.get(s.name).child && !state.done.has(s.name));
  if (unfinished) return { section: unfinished, resume: true };
  // The helper starts from the far end of the list, so two characters work on
  // opposite sides and meet in the middle.
  const ordered = role === 'helper' ? [...plan.sections].reverse() : plan.sections;
  const open = ordered.find(s => !state.claims.has(s.name));
  return open ? { section: open, resume: false } : null;
}

function listLabels(labels) {
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

function loadDesign(name) {
  const data = readJson(path.join(SCHEMATICS_DIR, `${name}.json`));
  const sections = Object.entries(data?.sections || {})
    .map(([key, value]) => ({ name: key, label: String(value?.label || key.replace(/_/g, ' ')) }));
  return sections.length > 0 ? { sections, footprint: data.footprint } : null;
}

/**
 * @param {object} deps
 * @param {object} deps.bot mineflayer bot
 * @param {object} deps.actions the server's ACTIONS map (build_schematic and stop are read at call time)
 * @param {(msg: string) => void} [deps.log]
 * @param {() => boolean} [deps.isBusy] true while the character runs some other task
 */
export function createStudioCoBuild({ bot, actions, log = () => {}, isBusy = () => false, dir, env = process.env,
  timing = {}, loadDesignFn = loadDesign }) {
  const cfg = { ...STUDIO_COBUILD_DEFAULTS, ...timing };
  const planDir = dir || planDirFromEnv(env);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let active = false;
  let pendingOffer = null;
  let tornDown = false; // the connection ended: stop working, but leave the plan for a reconnect

  const say = (text) => {
    try { bot.chat(text); } catch { /* chat can fail while reconnecting */ }
  };

  function waitForAnswer(stopped) {
    return new Promise((resolve) => {
      const started = Date.now();
      const offer = {
        finish(answer) {
          if (pendingOffer !== offer) return;
          pendingOffer = null;
          clearInterval(timer);
          resolve(answer);
        },
      };
      const timer = setInterval(() => {
        if (stopped()) offer.finish({ kind: 'stopped' });
        else if (Date.now() - started >= cfg.offerMs) offer.finish({ kind: 'timeout' });
      }, Math.min(cfg.pollMs, cfg.offerMs));
      pendingOffer = offer;
    });
  }

  /** Feed every chat line here. True when the line answered this character's open offer. */
  function onChat(username, message) {
    if (!pendingOffer || !username || isCompanionSpeaker(username, bot.username)) return false;
    const kind = classifyStudioAnswer(message);
    if (!kind) return false;
    pendingOffer.finish({ kind, from: username });
    return true;
  }

  function sayClosingOnce(plan) {
    const state = planState(planDir, plan);
    if (state.cancelled || state.open.length > 0 || state.building.length > 0) return;
    if (!createExclusive(marker(planDir, plan, 'closing'), { by: bot.username, at: Date.now() })) return;
    const childs = plan.sections.filter(s => state.claims.get(s.name)?.child).map(s => s.label);
    if (childs.length === 0) say(`The ${plan.label} is finished!`);
    else if (childs.length === plan.sections.length) say(`The ${plan.label} is all yours to build!`);
    else say(`Our parts are done. The ${listLabels(childs)} ${childs.length === 1 ? 'is' : 'are'} yours to build!`);
  }

  async function run(plan, role) {
    if (active) return { result: `Studio co-build ${plan.design}: this character is already at work.` };
    active = true;
    bot._studioPlanActive = true;
    const me = bot.username;
    const stopGen = bot._stopGeneration || 0;
    const stopped = () => (bot._stopGeneration || 0) !== stopGen;
    // An offer also ends early when another character's stop cancelled the plan.
    const halted = () => tornDown || stopped() || planState(planDir, plan).cancelled;
    let built = 0;
    let outcome = 'done';
    try {
      for (;;) {
        if (tornDown) { outcome = 'disconnected'; break; }
        if (stopped()) { cancelPlan(planDir, plan, `stopped by ${me}`); outcome = 'stopped'; break; }
        const state = planState(planDir, plan);
        if (state.cancelled) { outcome = 'cancelled'; break; }
        const pick = pickSection(plan, state, me, role);
        if (!pick) break;
        const section = pick.section;
        if (!pick.resume) {
          if (!tryOfferLock(planDir, plan, me, Date.now(), cfg.offerLockTtlMs)) {
            await sleep(cfg.pollMs);
            continue;
          }
          let mine = false;
          try {
            // Another character may have taken it while this one waited its turn to ask.
            if (planState(planDir, plan).claims.has(section.name)) continue;
            say(`Next: the ${section.label}. Want to build it yourself? Say "mine"!`);
            const answer = await waitForAnswer(halted);
            if (answer.kind === 'stopped') continue;
            if (answer.kind === 'mine') {
              if (claimSection(planDir, plan, section.name, answer.from, true)) say(`The ${section.label} is yours!`);
              continue;
            }
            mine = claimSection(planDir, plan, section.name, me, false);
          } finally {
            releaseOfferLock(planDir, plan, me);
          }
          if (!mine) continue;
        }
        // Another character's stop reaches this one through the cancel marker.
        let stoppedByPlan = false;
        const watcher = setInterval(() => {
          if (!stopped() && planState(planDir, plan).cancelled) {
            stoppedByPlan = true;
            Promise.resolve(actions.stop?.()).catch(() => {});
          }
        }, cfg.watchMs);
        let result;
        try {
          result = await actions.build_schematic({
            name: plan.design, section: section.name, x: plan.origin.x, y: plan.origin.y, z: plan.origin.z,
          });
        } catch (error) {
          result = { error: error.message };
        } finally {
          clearInterval(watcher);
        }
        if (tornDown) { outcome = 'disconnected'; break; }
        if (stoppedByPlan) { outcome = 'cancelled'; break; }
        if (stopped()) { cancelPlan(planDir, plan, `stopped by ${me}`); outcome = 'stopped'; break; }
        if (actionOutcomeFailed(result)) {
          log(`[studio] ${section.name} did not finish: ${String(result?.error || result?.result || '').slice(0, 200)}`);
          cancelPlan(planDir, plan, `${section.name} did not finish for ${me}`);
          say(result?.site_refused
            ? `I can't finish the ${section.label} here. Something is in the way.`
            : `I had to stop building the ${section.label}.`);
          outcome = 'halted';
          break;
        }
        createExclusive(marker(planDir, plan, `${section.name}.done`), { by: me, at: Date.now() });
        built += 1;
      }
      if (outcome === 'done') sayClosingOnce(plan);
      // Only the character that was told to stop answers; the other just stops.
      else if (outcome === 'stopped') say('ok, stopped.');
    } finally {
      active = false;
      bot._studioPlanActive = false;
    }
    return { result: `Studio co-build ${plan.design}: ${outcome}; ${me} built ${built} part${built === 1 ? '' : 's'}.` };
  }

  /** The `studio_build` action: start a co-build of a studio design for a player. */
  async function start({ name, player } = {}) {
    const design = String(name ?? '');
    if (!isStudioDesign(design)) return { error: `"${design}" is not a studio design.` };
    const label = STUDIO_DESIGNS[design];
    if (!studioFlightEnabled(bot)) {
      say(`I can only build the ${label} in the creative world.`);
      return { result: `Studio co-build ${design} declined: this is not a creative studio session.` };
    }
    const existing = readPlan(planDir);
    if (active || (existing && planIsLive(planDir, existing, Date.now(), cfg.planTtlMs))) {
      say(`We're already building the ${existing?.label || label}. Come and help!`);
      return { result: `Studio co-build ${design} declined: a plan is already under way.` };
    }
    const loaded = loadDesignFn(design);
    if (!loaded) return { error: `Studio design "${design}" has no sections.` };
    const anchor = findPlayerEntity(bot, player)?.position || bot.entity?.position;
    if (!anchor) return { error: 'No position to place the studio design at.' };
    const plan = {
      id: String(Date.now()),
      design,
      label,
      origin: studioSiteFor(bot, anchor, loaded.footprint, cfg.siteGap),
      world: currentWorldName(bot) || null,
      child: player || null,
      lead: bot.username,
      created_at: Date.now(),
      sections: loaded.sections,
    };
    if (!writeNewPlan(planDir, plan)) {
      say(`We're already building the ${label}. Come and help!`);
      return { result: `Studio co-build ${design} declined: another character started the plan.` };
    }
    log(`[studio] ${bot.username} leads ${design} at ${plan.origin.x},${plan.origin.y},${plan.origin.z} for ${player || 'nobody'}`);
    say(`Yes! The ${label}. We build it by hand, one part at a time.`);
    return run(plan, 'lead');
  }

  /** Let an idle character join a plan another character started. Returns a teardown. */
  function install() {
    const timer = setInterval(() => {
      if (active || !bot.entity || !studioFlightEnabled(bot) || isBusy()) return;
      const plan = readPlan(planDir);
      if (!plan || !planIsLive(planDir, plan, Date.now(), cfg.planTtlMs)) return;
      const here = currentWorldName(bot);
      if (plan.world && here && plan.world !== here) return;
      const origin = new Vec3(plan.origin.x, plan.origin.y, plan.origin.z);
      if (bot.entity.position.distanceTo(origin) > cfg.joinRadius) return;
      const state = planState(planDir, plan);
      if (!pickSection(plan, state, bot.username, 'helper')) return;
      run(plan, plan.lead === bot.username ? 'lead' : 'helper')
        .then(result => log(`[studio] ${result.result}`))
        .catch(error => log(`[studio] join ended with an error: ${error.message}`));
    }, cfg.joinTickMs);
    return () => {
      clearInterval(timer);
      tornDown = true;
      if (pendingOffer) pendingOffer.finish({ kind: 'stopped' });
    };
  }

  return { start, onChat, install, isActive: () => active };
}
