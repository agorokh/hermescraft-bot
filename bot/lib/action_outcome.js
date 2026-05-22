/** Shared heuristic: did a skill/ACTION return a failed or partial outcome? */
export function actionOutcomeFailed(result, opts = {}) {
  if (!result || result.error) return true;
  const text = String(result.result || '');
  const lower = text.toLowerCase();
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
  // Generic failure check first (covers: couldn't, could not, failed, interrupted…)
  if (actionOutcomeFailed(result)) return true;
  const text = String(result?.result || '').toLowerCase();
  // Survival-specific blocked patterns not caught by the generic regex:
  return (
    /don't have a fishing rod|no water nearby|no furnace nearby|no raw food|nothing to give|food inventory is empty|home mark yet|no player specified|blast furnaces? cannot/.test(text) ||
    // farm_food with zero yield only — till-only progress still fast-paths to the kid
    /harvested 0 crops, replanted 0, tilled\+planted 0/.test(text)
  );
}
