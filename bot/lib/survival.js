import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;

// HermesCraft survival background tick — Mindcraft modes.js pattern.
//
// Design contract:
//   - Runs at ~1s intervals. Zero LLM calls. Pure rule-based reflexes.
//   - Mirrors barks.js pattern: installXxx(bot, opts) returns a teardown fn.
//   - Uses bot.interrupt_code semantics from skills.js (Mindcraft pattern).
//   - Three independent loops on staggered intervals so they don't fight for
//     Mineflayer attention in the same tick:
//       hunger / health   every 1.5s
//       hostile proximity every 2s
//       torch placement   every 8s
//       unstuck           every 4s
//
// Safe defaults: all loops are opt-out via env or opts. SURVIVAL_TICK_ENABLED
// defaults to true. Each sub-behaviour has its own guard.

// ── constants ────────────────────────────────────────────────────────────────

const HUNGER_EAT_THRESHOLD = 14;   // autoEat fires at 14 but we double-check
const HEALTH_FLEE_THRESHOLD = 4;   // flee when hearts ≤ 4 (2 hearts)
const HOSTILE_FLEE_RADIUS = 10;    // blocks — start fleeing at this distance
const TORCH_LIGHT_THRESHOLD = 7;   // place torch when block light ≤ 7
const TORCH_COOLDOWN_MS = 12000;   // don't torch-spam within 12s

const HOSTILE_MOB_TYPES = new Set([
  'zombie', 'skeleton', 'spider', 'cave_spider', 'creeper', 'witch',
  'enderman', 'phantom', 'drowned', 'husk', 'stray', 'vindicator',
  'pillager', 'ravager', 'blaze', 'ghast', 'slime', 'magma_cube',
]);

// ── helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isHostile(entity) {
  if (!entity || entity.type !== 'mob') return false;
  const name = (entity.name || entity.mobType || '').toLowerCase().replace('minecraft:', '');
  return HOSTILE_MOB_TYPES.has(name);
}

function nearestHostile(bot) {
  let closest = null;
  let closestDist = Infinity;
  for (const entity of Object.values(bot.entities || {})) {
    if (!isHostile(entity)) continue;
    const dist = bot.entity.position.distanceTo(entity.position);
    if (dist < closestDist) { closestDist = dist; closest = entity; }
  }
  return closest ? { entity: closest, dist: closestDist } : null;
}

function findFoodInInventory(bot) {
  const FOOD_PRIORITY = [
    'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken',
    'cooked_cod', 'cooked_salmon', 'cooked_rabbit', 'bread',
    'baked_potato', 'apple', 'golden_apple',
    'beef', 'porkchop', 'mutton', 'chicken', 'cod', 'salmon',
  ];
  for (const name of FOOD_PRIORITY) {
    const item = bot.inventory.items().find((i) => i.name === name);
    if (item) return item;
  }
  return null;
}

function hasTorchInInventory(bot) {
  return bot.inventory.items().some((i) => i.name === 'torch');
}

function lightAtBot(bot) {
  const pos = bot.entity.position.floored();
  const block = bot.blockAt(pos);
  if (!block) return { blockLight: 15, skyLight: 15 };
  return { blockLight: block.light, skyLight: block.skyLight ?? 0 };
}

function clearGoalIfStill(bot, goal) {
  try {
    if (bot.pathfinder?.goal === goal) {
      bot.pathfinder.setGoal(null);
    }
  } catch { /* swallow */ }
}

export function formatStuckPos(pos) {
  return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

// ── main export ───────────────────────────────────────────────────────────────

/**
 * startSurvivalTick(bot, log, opts) → teardown fn
 *
 * opts:
 *   enabled:          boolean (default true, override with SURVIVAL_TICK_ENABLED=0)
 *   eatEnabled:       boolean (default true)
 *   fleeEnabled:      boolean (default true)
 *   torchEnabled:     boolean (default true)
 *   unstuckEnabled:   boolean (default true)
 */
export function startSurvivalTick(bot, log, opts = {}) {
  const envEnabled = process.env.SURVIVAL_TICK_ENABLED !== '0';
  if (!envEnabled || opts.enabled === false) {
    log('survival tick DISABLED (SURVIVAL_TICK_ENABLED=0 or opts.enabled=false)');
    return () => {};
  }

  let running = true;
  let lastTorchAt = 0;
  let stuckPos = null;
  let stuckCount = 0;
  let survivalFleeGoal = null;

  const logSurv = (msg) => log(`[survival] ${msg}`);

  function shouldDeferSurvivalFlee() {
    if (bot.interrupt_code) return true;
    if (typeof opts.isKidTaskActive === 'function' && opts.isKidTaskActive()) return true;
    const moving = typeof bot.pathfinder?.isMoving === 'function' && bot.pathfinder.isMoving();
    if (moving && bot.pathfinder?.goal && bot.pathfinder.goal !== survivalFleeGoal) return true;
    return false;
  }

  // ── Hunger + health loop (~1.5s) ──────────────────────────────────────────
  async function hungerHealthLoop() {
    while (running) {
      await sleep(1500);
      if (!running || !bot.entity) continue;

      // Hunger — only if autoEat didn't fire (belt-and-suspenders)
      if (opts.eatEnabled !== false && bot.food !== undefined && bot.food <= HUNGER_EAT_THRESHOLD) {
        const food = findFoodInInventory(bot);
        if (food && !bot.pathfinder?.isMoving()) {
          try {
            await bot.equip(food, 'hand');
            await bot.consume();
            logSurv(`ate ${food.name} (food=${bot.food})`);
          } catch (e) { /* bot may be moving */ }
        }
      }

      // Health — flee if very low (don't hijack kid-directed pathfinder goals)
      if (opts.fleeEnabled !== false && bot.health !== undefined && bot.health <= HEALTH_FLEE_THRESHOLD) {
        const hostile = nearestHostile(bot);
        if (hostile && !shouldDeferSurvivalFlee()) {
          logSurv(`health ${bot.health} ≤ ${HEALTH_FLEE_THRESHOLD} + hostile near — fleeing`);
          try {
            // GoalInvert(GoalFollow) — Mindcraft creeper back-pedal pattern
            const awayGoal = new goals.GoalInvert(new goals.GoalFollow(hostile.entity, 4));
            survivalFleeGoal = awayGoal;
            bot.pathfinder.setGoal(awayGoal, true);
            await sleep(3000);
            clearGoalIfStill(bot, awayGoal);
            survivalFleeGoal = null;
          } catch (e) { logSurv(`flee error: ${e.message}`); survivalFleeGoal = null; }
        }
      }
    }
  }

  // ── Hostile proximity loop (~2s) ─────────────────────────────────────────
  async function hostileLoop() {
    while (running) {
      await sleep(2000);
      if (!running || !bot.entity) continue;
      if (opts.fleeEnabled === false) continue;

      const hostile = nearestHostile(bot);
      if (!hostile) continue;

      // Creeper special case: ALWAYS flee, never fight
      const isCrpr = (hostile.entity.name || hostile.entity.mobType || '').toLowerCase().includes('creeper');
      if (isCrpr && hostile.dist < HOSTILE_FLEE_RADIUS && !shouldDeferSurvivalFlee()) {
        logSurv(`creeper at ${hostile.dist.toFixed(1)}m — fleeing (never fight creepers)`);
        try {
          const awayGoal = new goals.GoalInvert(
            new goals.GoalFollow(hostile.entity, 2)
          );
          survivalFleeGoal = awayGoal;
          bot.pathfinder.setGoal(awayGoal, true);
          await sleep(2500);
          clearGoalIfStill(bot, awayGoal);
          survivalFleeGoal = null;
        } catch (e) { logSurv(`creeper flee error: ${e.message}`); survivalFleeGoal = null; }
      }
    }
  }

  // ── Torch placement loop (~8s) ────────────────────────────────────────────
  async function torchLoop() {
    while (running) {
      await sleep(8000);
      if (!running || !bot.entity) continue;
      if (opts.torchEnabled === false) continue;

      const now = Date.now();
      if (now - lastTorchAt < TORCH_COOLDOWN_MS) continue;

      const { blockLight, skyLight } = lightAtBot(bot);
      const light = Math.max(blockLight, skyLight);
      const isDay = bot.time?.timeOfDay < 12000;
      // Outdoors in daylight, block.light can be 0 while skyLight keeps the area bright.
      if (isDay && blockLight === 0 && skyLight > TORCH_LIGHT_THRESHOLD) continue;
      if (light > TORCH_LIGHT_THRESHOLD) continue;
      if (!hasTorchInInventory(bot)) continue;

      logSurv(`light=${light} ≤ ${TORCH_LIGHT_THRESHOLD} — placing torch`);
      try {
        // Find a solid block nearby to place torch against
        const pos = bot.entity.position.floored();
        const referenceBlock = bot.blockAt(pos.offset(0, -1, 0));
        if (referenceBlock && referenceBlock.boundingBox === 'block') {
          const torchItem = bot.inventory.items().find((i) => i.name === 'torch');
          await bot.equip(torchItem, 'hand');
          await bot.lookAt(referenceBlock.position.offset(0.5, 1, 0.5));
          await bot.placeBlock(referenceBlock, new Vec3(0, 1, 0));
          lastTorchAt = Date.now();
          logSurv('torch placed');
        }
      } catch (e) { /* couldn't place, no solid surface */ }
    }
  }

  // ── Unstuck loop (~4s) ────────────────────────────────────────────────────
  async function unstuckLoop() {
    while (running) {
      await sleep(4000);
      if (!running || !bot.entity) continue;
      if (opts.unstuckEnabled === false) continue;

      const pos = bot.entity.position;
      const isActivelyPathing = typeof bot.pathfinder?.isMoving === 'function' && bot.pathfinder.isMoving();

      if (!isActivelyPathing) {
        stuckPos = pos.clone();
        stuckCount = 0;
        continue;
      }

      if (stuckPos && pos.distanceTo(stuckPos) < 0.5) {
        stuckCount++;
        if (stuckCount >= 3 && !shouldDeferSurvivalFlee()) {
          logSurv(`stuck (${stuckCount}x same pos ${formatStuckPos(pos)}) — jiggling`);
          try {
            // Try jumping + moving forward
            bot.setControlState('jump', true);
            bot.setControlState('forward', true);
            await sleep(600);
            bot.setControlState('jump', false);
            bot.setControlState('forward', false);
            stuckCount = 0;
          } catch (e) { /* swallow */ }
        }
      } else {
        stuckPos = pos.clone();
        stuckCount = 0;
      }
    }
  }

  // Launch all loops concurrently (they don't await each other)
  hungerHealthLoop().catch((e) => logSurv(`hungerHealth crash: ${e.message}`));
  hostileLoop().catch((e) => logSurv(`hostile crash: ${e.message}`));
  torchLoop().catch((e) => logSurv(`torch crash: ${e.message}`));
  unstuckLoop().catch((e) => logSurv(`unstuck crash: ${e.message}`));

  log(`survival tick installed (hunger≤${HUNGER_EAT_THRESHOLD} eat, health≤${HEALTH_FLEE_THRESHOLD} flee, light≤${TORCH_LIGHT_THRESHOLD} torch, unstuck)`);

  // Teardown
  return () => { running = false; };
}
