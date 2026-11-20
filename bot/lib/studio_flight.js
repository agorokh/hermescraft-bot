// Creative-studio hand building (agorokh/hermescraft#592).
//
// In a creative-mode world a character may fly to reach a cell, then place the
// block with the same native hand placement the walking builder uses (#502).
// Flight replaces only the approach and the material stock; it never places a
// block. Nothing here issues a command, teleports, or breaks a block.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vec3 } from 'vec3';
import itemLoader from 'prismarine-item';

const HALF_WIDTH = 0.3;
const BODY_HEIGHT = 1.8;
const EYE_HEIGHT = 1.62;
// Server reach for a creative hand is 5 blocks from the eye; stay inside it.
const HAND_REACH = 4;
const SAMPLE_STEP = 0.25;
const HOP_LENGTH = 3;
const HOP_TIMEOUT_MS = 4000;
const FLIGHT_TIMEOUT_MS = 20000;
const ARRIVAL_TOLERANCE = 0.35;
const CRUISE_LIFTS = [2, 4, 8, 16, 32];
const MAX_CANDIDATES = 24;
const AIR = new Set(['air', 'cave_air', 'void_air']);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const key = (x, y, z) => `${x},${y},${z}`;

export function studioFlightEnabled(bot) {
  return process.env.HERMESCRAFT_STUDIO_FLIGHT === '1'
    && bot?.game?.gameMode === 'creative'
    && typeof bot.creative?.flyTo === 'function'
    && typeof bot.creative?.setInventorySlot === 'function';
}

function passable(bot, x, y, z) {
  const block = bot.blockAt(new Vec3(x, y, z));
  return Boolean(block) && block.boundingBox !== 'block';
}

// Every cell the 0.6 x 1.8 body touches at `feet` is loaded and not solid.
export function bodyClearAt(bot, feet) {
  const xs = new Set([Math.floor(feet.x - HALF_WIDTH), Math.floor(feet.x + HALF_WIDTH)]);
  const zs = new Set([Math.floor(feet.z - HALF_WIDTH), Math.floor(feet.z + HALF_WIDTH)]);
  const ys = new Set([Math.floor(feet.y), Math.floor(feet.y + BODY_HEIGHT / 2),
    Math.floor(feet.y + BODY_HEIGHT - 0.01)]);
  for (const x of xs) for (const y of ys) for (const z of zs) if (!passable(bot, x, y, z)) return false;
  return true;
}

export function segmentClear(bot, from, to) {
  const delta = to.minus(from);
  const steps = Math.max(1, Math.ceil(delta.norm() / SAMPLE_STEP));
  for (let i = 0; i <= steps; i++) {
    if (!bodyClearAt(bot, from.plus(delta.scaled(i / steps)))) return false;
  }
  return true;
}

// creative.flyTo moves in a straight line through anything, so only hand it
// legs already checked clear. Returns waypoints ending at `to`, or null.
export function planFlight(bot, from, to) {
  const routes = [
    [to],
    [new Vec3(from.x, to.y, from.z), to],
    [new Vec3(to.x, from.y, to.z), to],
    ...CRUISE_LIFTS.map(lift => Math.min(318, Math.max(from.y, to.y) + lift))
      .map(cruise => [new Vec3(from.x, cruise, from.z), new Vec3(to.x, cruise, to.z), to]),
  ];
  for (const route of routes) {
    let at = from;
    let clear = true;
    for (const waypoint of route) {
      if (!segmentClear(bot, at, waypoint)) { clear = false; break; }
      at = waypoint;
    }
    if (clear) return route.filter((waypoint, i) => waypoint.distanceTo(i ? route[i - 1] : from) > 0.05);
  }
  return null;
}

function otherActorNear(bot, feet) {
  return Object.entries(bot.players || {}).some(([name, player]) => {
    if (name === bot.username || player.entity === bot.entity) return false;
    const p = player.entity?.position;
    return p && Math.abs(p.x - feet.x) < 0.8 && Math.abs(p.z - feet.z) < 0.8 && Math.abs(p.y - feet.y) < 2;
  });
}

// Hover cells from which the target is inside hand reach. `avoid` holds the
// cells still to be built (by anyone), so a character never parks in a cell
// that has to be filled. `center` biases the stance to the outside of the
// structure, where the way out stays open.
export function hoverCandidates(bot, target, { avoid, center } = {}) {
  const from = bot.entity.position;
  const targetCenter = target.offset(0.5, 0.5, 0.5);
  const targetRadius = center ? Math.hypot(target.x + 0.5 - center.x, target.z + 0.5 - center.z) : 0;
  const candidates = [];
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      for (let dy = -3; dy <= 2; dy++) {
        const cell = target.offset(dx, dy, dz);
        const feet = cell.offset(0.5, 0, 0.5);
        if (feet.offset(0, EYE_HEIGHT, 0).distanceTo(targetCenter) > HAND_REACH) continue;
        const body = [cell, cell.offset(0, 1, 0)];
        if (body.some(c => c.equals(target) || avoid?.has(key(c.x, c.y, c.z)))) continue;
        if (!bodyClearAt(bot, feet) || otherActorNear(bot, feet)) continue;
        const inside = center
          && Math.hypot(feet.x - center.x, feet.z - center.z) < targetRadius - 0.5;
        candidates.push({ feet, cost: feet.distanceTo(from) + (inside ? 6 : 0) + (dy < -2 ? 1 : 0) });
      }
    }
  }
  return candidates.sort((a, b) => a.cost - b.cost).slice(0, MAX_CANDIDATES);
}

const CREATIVE_ABILITY_FLAGS = 0x01 | 0x04 | 0x08;
const FLYING_ABILITY_FLAG = 0x02;

function setFlyingFlag(bot, flying) {
  // Tell the server what the body is doing so other players see a flyer, not
  // a faller. Preserve creative/invulnerable/allow-flight bits (0x01|0x04|0x08)
  // and toggle only the flying bit (0x02).
  const baseFlags = Number.isInteger(bot.physics?.abilitiesFlags)
    ? (bot.physics.abilitiesFlags & ~FLYING_ABILITY_FLAG)
    : (bot.game?.gameMode === 'creative' ? CREATIVE_ABILITY_FLAGS : 0);
  const flags = flying ? (baseFlags | FLYING_ABILITY_FLAG) : (baseFlags & ~FLYING_ABILITY_FLAG);
  try { bot._client?.write?.('abilities', { flags }); } catch { /* cosmetic only */ }
}

// Slots this module filled, per body, so they can be emptied again afterwards.
const studioStock = new WeakMap();
const inFlightHop = new WeakMap();

async function cancelInFlightHop(bot) {
  const active = inFlightHop.get(bot);
  if (!active) return;
  const freeze = bot.entity?.position?.clone?.();
  if (freeze) active.hop.set(freeze.x, freeze.y, freeze.z);
  bot.emit?.('move');
  let timer;
  await Promise.race([
    active.promise,
    new Promise(resolve => {
      timer = setTimeout(() => {
        if (freeze) active.hop.set(freeze.x, freeze.y, freeze.z);
        bot.emit?.('move');
        resolve();
      }, 75);
    }),
  ]).finally(() => clearTimeout(timer));
  if (inFlightHop.get(bot)?.gen === active.gen) inFlightHop.delete(bot);
  if (freeze && bot.entity?.position) {
    bot.entity.position.set(freeze.x, freeze.y, freeze.z);
  }
}

async function flyRoute(bot, route, stopped, deadline, hopTimeoutMs = HOP_TIMEOUT_MS) {
  await cancelInFlightHop(bot);
  bot.creative.startFlying();
  setFlyingFlag(bot, true);
  for (const waypoint of route) {
    // Short hops keep a stop request responsive; flyTo itself cannot be cancelled.
    let remaining = waypoint.minus(bot.entity.position);
    while (remaining.norm() > 0.05) {
      if (stopped()) return { ok: false, reason: 'interrupted while flying' };
      if (performance.now() >= deadline) return { ok: false, reason: 'flight timed out', deadlineExceeded: true };
      const length = remaining.norm();
      const hop = (length <= HOP_LENGTH ? waypoint
        : bot.entity.position.plus(remaining.scaled(HOP_LENGTH / length))).clone();
      const gen = (inFlightHop.get(bot)?.gen || 0) + 1;
      const promise = Promise.resolve().then(() => bot.creative.flyTo(hop)).catch(() => {}).finally(() => {
        if (inFlightHop.get(bot)?.gen === gen) inFlightHop.delete(bot);
      });
      inFlightHop.set(bot, { gen, hop, promise });
      let timer;
      const timedOut = await Promise.race([
        promise.then(() => false),
        new Promise(resolve => { timer = setTimeout(() => resolve(true), hopTimeoutMs); }),
      ]).finally(() => clearTimeout(timer));
      if (timedOut) {
        await cancelInFlightHop(bot);
        return { ok: false, reason: 'flight timed out', hopTimedOut: true, deadlineExceeded: performance.now() >= deadline };
      }
      if (bot.entity.position.distanceTo(hop) > ARRIVAL_TOLERANCE) {
        return { ok: false, reason: 'the server moved the flying body back' };
      }
      remaining = waypoint.minus(bot.entity.position);
    }
  }
  return { ok: true };
}

// Fly to a stance within hand reach of `target`. `skip` stances were already
// tried for this cell, so a retry looks at the block from somewhere else.
export async function flyToPhysicalPlacement(bot, target, { stopped = () => false, avoid, center, skip, log, hopTimeoutMs = HOP_TIMEOUT_MS } = {}) {
  const from = bot.entity.position.clone();
  const deadline = performance.now() + FLIGHT_TIMEOUT_MS;
  let failure = 'could not find a clear place to hover near the next block';
  for (const { feet } of hoverCandidates(bot, target, { avoid, center })) {
    if (skip?.has(key(feet.x, feet.y, feet.z))) continue;
    if (stopped()) return { ok: false, reason: 'interrupted while flying' };
    if (performance.now() >= deadline) return { ok: false, reason: 'flight timed out' };
    const start = bot.entity.position.clone();
    const route = planFlight(bot, start, feet);
    if (!route) { failure = 'could not find a clear way to fly to the next block'; continue; }
    const flown = await flyRoute(bot, route, stopped, deadline, hopTimeoutMs);
    if (!flown.ok) {
      if (stopped() || flown.deadlineExceeded || performance.now() >= deadline) return { ok: false, reason: flown.reason };
      failure = flown.reason;
      continue;
    }
    bot.entity.velocity?.set?.(0, 0, 0);
    log?.('approach', { mode: 'flight', target, from, position: bot.entity.position.clone() });
    return { ok: true, stance: key(feet.x, feet.y, feet.z) };
  }
  return { ok: false, reason: failure };
}

// Creative inventory replaces the survival stock check: put one full stack of
// the material in an EMPTY hotbar slot when the character holds none. Hand
// placement in creative does not consume it. Whatever the character already
// carries (a survival kit, a gift) is not ours to lose.
// With no empty slot left, swap the material into a slot this build stocked
// itself, so a design with three materials needs one free slot, not three.
// A character that has played for weeks carries a full hotbar. Then one hotbar
// slot holding a plain stack (no name, enchantment, wear or other data, so it
// can be given back exactly) is set aside: the stack is written to disk first,
// the slot is used for the material, and the same stack goes back when the
// build ends, or at the next studio build if the body died in between.
export async function ensureCreativeStock(bot, itemName, normalize = name => name) {
  const wanted = normalize(itemName);
  await restoreStaleBorrow(bot, normalize);
  if (bot.inventory.items().some(item => normalize(item.name) === wanted)) return { ok: true };
  const type = bot.registry.itemsByName[wanted];
  if (!type) return { ok: false, reason: `${wanted} is not an item this character can hold` };
  let slot = HOTBAR.find(s => bot.inventory.slots[s] == null);
  if (slot === undefined) {
    for (const [ours, name] of studioStock.get(bot) || []) {
      const held = bot.inventory.slots[ours];
      if (held && normalize(held.name) === name) { slot = ours; break; }
    }
  }
  let borrowed = null;
  if (slot === undefined) {
    if (readBorrow(bot)) return { ok: false, reason: 'a hotbar slot set aside earlier has not been given back yet' };
    slot = [...HOTBAR].reverse().find(s => plainStack(bot, bot.inventory.slots[s]));
    if (slot === undefined) return { ok: false, reason: 'no empty hotbar slot for a creative building material, and no plain stack to set aside' };
    const held = bot.inventory.slots[slot];
    borrowed = { slot, name: held.name, count: held.count, materials: [wanted] };
    try {
      writeBorrow(bot, borrowed);
    } catch (error) {
      return { ok: false, reason: `could not note the stack set aside for the build: ${error.message}` };
    }
  } else {
    const record = readBorrow(bot);
    if (record?.slot === slot && !record.materials.includes(wanted)) {
      try {
        writeBorrow(bot, { ...record, materials: [...record.materials, wanted] });
      } catch (error) {
        return { ok: false, reason: `could not note the stack set aside for the build: ${error.message}` };
      }
    }
  }
  const Item = itemLoader(bot.registry);
  try {
    await bot.creative.setInventorySlot(slot, new Item(type.id, type.stackSize || 64));
  } catch (error) {
    if (borrowed && bot.inventory.slots[slot]?.name === borrowed.name && bot.inventory.slots[slot]?.count === borrowed.count) {
      dropBorrow(bot);
    } else if (borrowed) {
      if (!studioStock.has(bot)) studioStock.set(bot, new Map());
      studioStock.get(bot).set(slot, wanted);
    }
    return { ok: false, reason: `could not take ${wanted} from the creative inventory: ${error.message}` };
  }
  if (!studioStock.has(bot)) studioStock.set(bot, new Map());
  studioStock.get(bot).set(slot, wanted);
  const deadline = performance.now() + 1500;
  while (performance.now() < deadline) {
    if (bot.inventory.items().some(item => normalize(item.name) === wanted)) return { ok: true };
    await sleep(50);
  }
  await clearStudioStock(bot, normalize);
  return { ok: false, reason: `the creative inventory did not supply ${wanted}` };
}

// Hand back what ensureCreativeStock took, so creative materials do not ride
// home in the character's inventory, and return a stack set aside for the
// build to its slot. Only slots still holding our own stack are emptied.
export async function clearStudioStock(bot, normalize = name => name) {
  const stocked = studioStock.get(bot);
  studioStock.delete(bot);
  for (const [slot, name] of stocked || []) {
    const held = bot.inventory.slots[slot];
    if (!held || normalize(held.name) !== name) continue;
    try { await bot.creative.setInventorySlot(slot, null); } catch { /* left for the next build to reuse */ }
  }
  await giveBackBorrowed(bot, normalize);
}

const HOTBAR = Array.from({ length: 9 }, (_, i) => 36 + i);

// A stack that is only an item type and a count: putting a new stack of that
// type and count back reproduces it exactly.
function plainStack(bot, item) {
  if (!item || !bot.registry.itemsByName[item.name] || !(item.count > 0)) return false;
  if (item.nbt) return false;
  if (item.components?.length || item.removedComponents?.length || item.componentMap?.size) return false;
  return true;
}

export function borrowDirFromEnv(env = process.env) {
  return env.HERMESCRAFT_STUDIO_BORROW_DIR || path.join(os.homedir(), '.hermescraft', 'studio-borrowed');
}

function borrowFile(bot) {
  return path.join(borrowDirFromEnv(), `${String(bot.username || 'body').replace(/[^A-Za-z0-9_]/g, '_')}.json`);
}

export function readBorrow(bot) {
  try {
    const record = JSON.parse(fs.readFileSync(borrowFile(bot), 'utf8'));
    if (!Number.isInteger(record?.slot) || typeof record.name !== 'string' || !Number.isInteger(record.count)
      || !Array.isArray(record.materials)) return null;
    return record;
  } catch {
    return null;
  }
}

function writeBorrow(bot, record) {
  const file = borrowFile(bot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, file);
}

function dropBorrow(bot) {
  try { fs.unlinkSync(borrowFile(bot)); } catch { /* already gone */ }
}

// A set-aside stack this process is not using (the body restarted mid-build,
// or an earlier give-back failed) goes back before anything else is stocked.
async function restoreStaleBorrow(bot, normalize) {
  const record = readBorrow(bot);
  if (!record || studioStock.get(bot)?.has(record.slot)) return;
  await giveBackBorrowed(bot, normalize);
}

async function giveBackBorrowed(bot, normalize) {
  const record = readBorrow(bot);
  if (!record) return true;
  const type = bot.registry.itemsByName[record.name];
  if (!type) return false;
  let slot = record.slot;
  const held = bot.inventory.slots[slot];
  // Back already: the same stack, or (after a give-back whose readback timed out)
  // the same type, some of it since used, e.g. torches the survival tick placed.
  if (held?.name === record.name && (held.count === record.count || record.givingBack)) {
    dropBorrow(bot);
    return true;
  }
  if (held && (held.name === record.name || !record.materials.includes(normalize(held.name)))) {
    // Something else of the character's is there now, or the same type at another
    // count before any give-back was sent (the character's own new stack): the
    // set-aside stack is still owed, so it goes to an empty slot.
    slot = Array.from({ length: 36 }, (_, i) => 9 + i).find(s => bot.inventory.slots[s] == null);
    if (slot === undefined) return false;
  }
  const Item = itemLoader(bot.registry);
  try {
    writeBorrow(bot, { ...record, slot, givingBack: true });
    await bot.creative.setInventorySlot(slot, new Item(type.id, record.count));
  } catch {
    if (!bot.inventory.slots[slot]) {
      try { writeBorrow(bot, { ...record, givingBack: false }); } catch { /* the flag only widens the match */ }
    }
    return false;
  }
  const deadline = performance.now() + 1500;
  while (performance.now() < deadline) {
    const back = bot.inventory.slots[slot];
    if (back?.name === record.name && back.count === record.count) {
      dropBorrow(bot);
      studioStock.get(bot)?.delete(slot);
      return true;
    }
    await sleep(50);
  }
  return false;
}

const NEIGHBOURS = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];

// Order cells so each one has something solid to be placed against when its
// turn comes: lowest layer first, and within reach of the previous cell where
// possible. `solidAt(x, y, z)` reports what already stands in the world.
// Cells left over can never be placed by hand and are returned as `floating`.
export function orderForHandPlacement(cells, solidAt) {
  const pending = new Map(cells.map(cell => [key(cell[0], cell[1], cell[2]), cell]));
  const placed = new Set();
  const supported = ([x, y, z]) => NEIGHBOURS.some(([dx, dy, dz]) =>
    placed.has(key(x + dx, y + dy, z + dz)) || solidAt(x + dx, y + dy, z + dz));
  const ordered = [];
  let last = null;
  while (pending.size) {
    let best = null;
    let bestScore = Infinity;
    for (const cell of pending.values()) {
      if (!supported(cell)) continue;
      const hop = last ? Math.abs(cell[0] - last[0]) + Math.abs(cell[2] - last[2]) : 0;
      const score = cell[1] * 1000 + hop;
      if (score < bestScore) { best = cell; bestScore = score; }
    }
    if (!best) break;
    pending.delete(key(best[0], best[1], best[2]));
    placed.add(key(best[0], best[1], best[2]));
    ordered.push(best);
    last = best;
  }
  return { ordered, floating: [...pending.values()] };
}

// Every cell of a studio build must be loaded and either empty or already the
// block the design wants there. Anything else is someone's work: never replace.
export function checkStudioCells(bot, placements, matches) {
  for (const { x, y, z, block } of placements) {
    const current = bot.blockAt(new Vec3(x, y, z));
    if (!current) return { ok: false, code: 'unknown', reason: 'part of the build space has not loaded' };
    if (!AIR.has(current.name) && !matches(x, y, z, block)) {
      return { ok: false, code: 'occupied', reason: 'something is already built where this would go' };
    }
  }
  return { ok: true };
}

// Come down beside the finished work instead of dropping onto it.
export async function landBesideBuild(bot, { origin, footprint }, { stopped = () => false, hopTimeoutMs = HOP_TIMEOUT_MS } = {}) {
  try {
    await cancelInFlightHop(bot);
    const from = bot.entity.position.clone();
    const [width, length] = footprint;
    const spots = [];
    for (let dx = -3; dx < width + 3; dx++) {
      for (let dz = -3; dz < length + 3; dz++) {
        const outside = dx < -1 || dz < -1 || dx > width || dz > length;
        if (!outside) continue;
        const feet = new Vec3(origin.x + dx + 0.5, origin.y, origin.z + dz + 0.5);
        const ground = bot.blockAt(new Vec3(origin.x + dx, origin.y - 1, origin.z + dz));
        if (ground?.boundingBox !== 'block' || !bodyClearAt(bot, feet) || otherActorNear(bot, feet)) continue;
        spots.push({ feet, distance: Math.hypot(feet.x - from.x, feet.z - from.z) });
      }
    }
    spots.sort((a, b) => a.distance - b.distance);
    const deadline = performance.now() + FLIGHT_TIMEOUT_MS;
    for (const { feet } of spots.slice(0, 8)) {
      const route = planFlight(bot, bot.entity.position.clone(), feet);
      if (!route) continue;
      const flown = await flyRoute(bot, route, stopped, deadline, hopTimeoutMs);
      if (flown.ok || flown.deadlineExceeded || performance.now() >= deadline || stopped()) break;
    }
  } catch { /* landing is a courtesy; never fail a finished build on it */ } finally {
    await cancelInFlightHop(bot);
    try { bot.creative.stopFlying(); } catch { /* body already gone */ }
    setFlyingFlag(bot, false);
  }
}
