/** Shared heuristic: did a skill/ACTION return a failed or partial outcome? */
export function actionOutcomeFailed(result, opts = {}) {
  if (!result || result.error) return true;
  const text = String(result.result || '');
  const lower = text.toLowerCase();
  if (/\bforeman rejected\b|\bmissing materials\b|\bpaused for sentry mode\b/.test(lower)) {
    return true;
  }
  if (/\b(couldn't|could not|can't see|unable|failed|interrupted|needs |no .* in my inventory)\b/.test(lower)) {
    return true;
  }
  if (opts.allowPartialPlacement) return false;
  const ratio = text.match(/\b(\d+)\s*\/\s*(\d+)\b/);
  if (ratio) {
    const num = parseInt(ratio[1], 10);
    const den = parseInt(ratio[2], 10);
    if (den > 0 && num < den) return true;
  }
  return false;
}

/**
 * Survival-specific block detector.
 *
 * Survival ACTIONs return English strings designed to feed back into LLM
 * context (Mindcraft pattern). Many "blocked" strings (no rod, no furnace,
 * empty food inventory, no home mark…) don't match the generic
 * actionOutcomeFailed regex — the bot would echo the raw function string to
 * the kid and skip the brain, producing zero character voice and no follow-up
 * plan.
 *
 * This function returns true whenever a survival skill result indicates the
 * action was blocked by a missing resource or precondition — signalling that
 * the brain should be escalated so it can plan a fix (craft the item, find
 * the resource, chain skills) and respond in character.
 *
 * "Clean success" strings (Caught N fish, Cooked X, Shelter built…) return
 * false so the fast-path result string reaches the kid without an extra LLM
 * round-trip.
 */
const SURVIVAL_ACTIONS = new Set([
  'fish_for_food', 'farm_food', 'cook_food',
  'return_home', 'feed_player', 'build_shelter_for_night',
]);

export function isSurvivalBlock(action, result) {
  if (!SURVIVAL_ACTIONS.has(action)) return false;
  const text = String(result?.result || '').toLowerCase();
  // Superseded by a newer action — not a missing-resource block.
  if (/\binterrupted\b/.test(text)) return false;
  // Generic failure check (couldn't, failed, needs… — not interrupted)
  if (actionOutcomeFailed(result)) return true;
  // Survival-specific blocked patterns not caught by the generic regex:
  return (
    /don't have a fishing rod|no water nearby|no furnace nearby|no raw food|nothing to give|food inventory is empty|home mark yet|no player specified|blast furnaces? cannot/.test(text) ||
    // farm_food with zero yield only — till-only progress still fast-paths to the kid
    /harvested 0 crops, replanted 0, tilled\+planted 0/.test(text)
  );
}

const BUILD_ACTIONS = new Set(['build_schematic', 'build_schematic_advanced']);
const PUBLIC_SUCCESS_ACTIONS = new Set([
  'fish_for_food', 'farm_food', 'cook_food',
  'return_home', 'feed_player', 'build_shelter_for_night',
  'follow_player_v2', 'light_area', 'give_to_player', 'place_near_player',
  'build_tower', 'list_schematics',
]);
const COMMAND_LEAK_RE = /(?:^|\s)\/(?:setblock|fill|tp|teleport|give|effect|gamemode|op|deop)\b|via\s+\/setblock|\bchanged block\b/i;

function safePublicText(text, maxLen = 140) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean || COMMAND_LEAK_RE.test(clean)) return null;
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1).trim()}...` : clean;
}

function partialBuildText(text) {
  const partial = String(text || '').match(/\bBuilt (\d+)\/(\d+) of "([^"]+)"/i);
  if (!partial) return null;
  const placed = parseInt(partial[1], 10);
  const total = parseInt(partial[2], 10);
  return total > 0 && placed < total
    ? `I started "${partial[3]}" but could not finish it yet.`
    : null;
}

export function publicActionResult(action, result, opts = {}) {
  if (!result?.result || action === 'chat') return null;
  const text = String(result.result);
  const failed = Boolean(opts.failed);

  if (BUILD_ACTIONS.has(action)) {
    const partial = partialBuildText(text);
    if (partial) return partial;
    if (failed) {
      if (/foreman rejected/i.test(text) && /missing materials/i.test(text)) {
        return "I can't build that yet - I'm missing materials.";
      }
      if (/paused for Sentry Mode/i.test(text)) {
        return 'I paused the build because the area did not look safe.';
      }
      return null;
    }
    const built = text.match(/\bBuilt schematic "([^"]+)" at (-?\d+),\s*(-?\d+),\s*(-?\d+)/i);
    if (built) return `Built schematic "${built[1]}" at ${built[2]},${built[3]},${built[4]}.`;
    const complete = text.match(/\bBuild "([^"]+)" at (-?\d+),\s*(-?\d+),\s*(-?\d+) is already complete/i);
    if (complete) return `"${complete[1]}" is already complete at ${complete[2]},${complete[3]},${complete[4]}.`;
    const builtRatio = text.match(/\bBuilt \d+\/\d+ of "([^"]+)" at (-?\d+),\s*(-?\d+),\s*(-?\d+)/i);
    if (builtRatio) return `Built schematic "${builtRatio[1]}" at ${builtRatio[2]},${builtRatio[3]},${builtRatio[4]}.`;
    return null;
  }

  if (failed) return null;
  if (!PUBLIC_SUCCESS_ACTIONS.has(action)) return null;
  return safePublicText(text);
}
