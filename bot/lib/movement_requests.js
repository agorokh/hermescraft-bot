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

const TASK_VERBS = 'build|make|construct|design|create|set up|place|put|dig|mine|fill|use|break|chop|plant|harvest|craft|cook|smelt|feed|give|bring|fetch|collect|gather|find|search|farm|fish|eat|equip|wear|open|close|tame|ride|throw|shoot';
const COMBAT_VERBS = 'kill|attack|fight|hit|punch|smack|defend|protect|save|get';
const POST_NEGATION_TASK_VERBS = 'break|chop|plant|harvest|craft|cook|smelt|feed|give|bring|fetch|collect|gather|find|search|farm|fish|eat|equip|wear|open|close|tame|ride|throw|shoot';
const TASK_VERB_PATTERN = new RegExp(`\\b(?:${TASK_VERBS})\\b`);
const NEGATED_TASK_PATTERN = new RegExp(`(?:\\b(?:do not|don'?t|dont)\\s+|\\b(?:and|or)\\s+no\\s+|^\\s*no\\s+)(?:${TASK_VERBS})\\b`, 'i');
const NEGATED_COMBAT_PATTERN = new RegExp(`(?:\\b(?:do not|don'?t|dont)\\s+|\\b(?:and|or)\\s+no\\s+|^\\s*no\\s+)(?:${COMBAT_VERBS})\\b`, 'i');
const TASK_LIST_CONTINUATION_PATTERN = new RegExp(`^(?:(?:and|or)\\s+)?(?:${TASK_VERBS})\\b(?:\\s+items?)?$|^or\\s+(?:${TASK_VERBS})\\b(?:\\s+[^,.!?;:]*)?$`, 'i');
const COMBAT_LIST_CONTINUATION_PATTERN = new RegExp(`^(?:(?:and|or)\\s+(?:${COMBAT_VERBS})|(?:${COMBAT_VERBS}))\\b$|^or\\s+(?:${COMBAT_VERBS})\\b(?:\\s+[^,.!?;:]*)?$`, 'i');
const POST_NEGATION_TASK_TAIL_PATTERN = new RegExp(`\\b(?:then|but)\\s+.*\\b(?:${TASK_VERBS})\\b|\\band\\s+(?:${POST_NEGATION_TASK_VERBS})\\b`, 'i');
const POST_NEGATION_COMBAT_TAIL_PATTERN = new RegExp(`\\b(?:then|but|and)\\s+.*\\b(?:${COMBAT_VERBS})\\b`, 'i');

function stripNegatedClauses(text, negatedPattern, continuationPattern, positiveTailPattern) {
  let inNegatedList = false;
  return String(text || '').split(/[,.!?;:]/).map((part) => {
    const trimmed = part.trim();
    const match = negatedPattern.exec(trimmed);
    if (match) {
      inNegatedList = true;
      const before = trimmed.slice(0, match.index);
      const after = trimmed.slice(match.index + match[0].length);
      const tailMatch = positiveTailPattern?.exec(after);
      return tailMatch ? `${before} ${after.slice(tailMatch.index).trim()}` : before;
    }
    if (inNegatedList && continuationPattern.test(trimmed)) {
      return '';
    }
    inNegatedList = false;
    return part;
  }).join(',');
}

export function hasWorldMutationImperative(body) {
  const stripped = stripNegatedClauses(
    String(body || '').toLowerCase(),
    NEGATED_TASK_PATTERN,
    TASK_LIST_CONTINUATION_PATTERN,
    POST_NEGATION_TASK_TAIL_PATTERN,
  );
  return TASK_VERB_PATTERN.test(stripped);
}

export function combatImperativeText(body) {
  return stripNegatedClauses(
    String(body || '').toLowerCase(),
    NEGATED_COMBAT_PATTERN,
    COMBAT_LIST_CONTINUATION_PATTERN,
    POST_NEGATION_COMBAT_TAIL_PATTERN,
  );
}

export function hasCombatImperative(body) {
  const text = combatImperativeText(body);
  const hostileTargetPattern = /\b(mob|mobs|zombie|skeleton|creeper|spider|enderman|witch|blaze|phantom|drowned|husk|stray|slime|ghast|silverfish|pillager|vindicator|hoglin|piglin)\b/;
  const hasAttackVerb = /\b(kill|attack|fight|hit|punch|smack)\b/.test(text);
  const hasProtectionVerb = /\b(defend|protect|save)\b/.test(text);
  const hasProtectionTarget = /\b(defend|protect|save)\s+(me|us)\b/.test(text)
    || hostileTargetPattern.test(text);
  return hasAttackVerb
    || (hasProtectionVerb && hasProtectionTarget)
    || (/\bget\b/.test(text) && hostileTargetPattern.test(text))
    || /\bhelp\b.*\b(zombie|skeleton|creeper|spider|enderman|witch|blaze|phantom|drowned|husk|stray|slime|ghast|silverfish|pillager|vindicator|hoglin|piglin|mob|mobs)\b/.test(text);
}
