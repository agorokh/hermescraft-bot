export function hasPositiveMovementRequest(body) {
  const text = String(body || '');
  return /\bcome\s+(?:look|see|check|watch)\b.*\b(?:with me|over here|here|at this|at it)\b/i.test(text)
    || /\b(come|come over|come here|walk|run|head)\b.*\b(here|to me|over)\b/i.test(text)
    || /\bcome to my (spot|position|place)\b/i.test(text)
    || /\b(follow me|stay with me|come with me)\b/i.test(text);
}

export function hasNegativeMovementRequest(body) {
  return /\b(don'?t|do not)\s+(?:move|come|follow|walk|run|go|head)\b/i.test(String(body || ''));
}

export function hasFollowRequest(body) {
  return /\b(follow me|stay with me|come with me)\b/i.test(String(body || ''));
}

export function hasWorldMutationImperative(body) {
  const text = String(body || '').toLowerCase();
  const stripped = text
    .replace(/\b(?:do not|don'?t|dont)\b[^.!?;:]*/g, '')
    .replace(/\bno\b[^,.!?;:]*/g, '');
  return /\b(build|make|construct|design|create|set up|place|put|dig|mine|fill|use)\b/.test(stripped);
}

export function hasCombatImperative(body) {
  const text = String(body || '').toLowerCase();
  const hasCombatVerb = /\b(kill|attack|fight|defend|protect|save|get|hit|punch|smack)\b/.test(text);
  const hasCombatTarget = /\b(it|them|mob|mobs|zombie|skeleton|creeper|spider|enderman|witch|blaze|phantom|drowned|husk|stray|slime|ghast|silverfish|pillager|vindicator|hoglin|piglin)\b/.test(text);
  return (hasCombatVerb && hasCombatTarget)
    || /\bhelp\b.*\b(zombie|skeleton|creeper|spider|enderman|witch|blaze|phantom|drowned|husk|stray|slime|ghast|silverfish|pillager|vindicator|hoglin|piglin|mob|mobs)\b/.test(text);
}
