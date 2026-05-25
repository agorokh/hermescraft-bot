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

const TASK_VERB_PATTERN = /\b(build|make|construct|design|create|set up|place|put|dig|mine|fill|use|break|chop|plant|harvest|craft|cook|smelt|feed|give|bring|fetch|collect|gather|find|search|farm|fish|eat|equip|wear|open|close|tame|ride|throw|shoot)\b/;
const NEGATED_COMBAT_PATTERN = /\b(?:do not|don'?t|dont)\s+(?:kill|attack|fight|hit|punch|smack|defend|protect|save|get)\b[^.!?;:]*/g;
const NEGATED_NO_COMBAT_PATTERN = /\bno\s+(?:kill|attack|fight|hit|punch|smack|defend|protect|save|get)\b[^,.!?;:]*/g;

export function hasWorldMutationImperative(body) {
  const text = String(body || '').toLowerCase();
  const stripped = text
    .replace(/\b(?:do not|don'?t|dont)\b[^.!?;:]*/g, '')
    .replace(/\bno\b[^,.!?;:]*/g, '');
  return TASK_VERB_PATTERN.test(stripped);
}

export function hasCombatImperative(body) {
  const text = String(body || '').toLowerCase()
    .replace(NEGATED_COMBAT_PATTERN, '')
    .replace(NEGATED_NO_COMBAT_PATTERN, '');
  const hostileTargetPattern = /\b(mob|mobs|zombie|skeleton|creeper|spider|enderman|witch|blaze|phantom|drowned|husk|stray|slime|ghast|silverfish|pillager|vindicator|hoglin|piglin)\b/;
  const hasAttackVerb = /\b(kill|attack|fight|hit|punch|smack)\b/.test(text);
  const hasProtectionVerb = /\b(defend|protect|save)\b/.test(text);
  const hasProtectionTarget = /\b(me|us)\b/.test(text) || hostileTargetPattern.test(text);
  return hasAttackVerb
    || (hasProtectionVerb && hasProtectionTarget)
    || (/\bget\b/.test(text) && hostileTargetPattern.test(text))
    || /\bhelp\b.*\b(zombie|skeleton|creeper|spider|enderman|witch|blaze|phantom|drowned|husk|stray|slime|ghast|silverfish|pillager|vindicator|hoglin|piglin|mob|mobs)\b/.test(text);
}
