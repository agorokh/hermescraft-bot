// Kid-voice tolerant slot extraction for NLP/regex dispatchers.

const ORE_STEM_RE = /^(iron|coal|diamond|copper|gold)(s{0,3})$/;
const GATHER_STEM_RE = /^(wood|log|logs|oak|dirt|stone|cobblestone|cobble|sand)(s{0,3})$/;

function directRequestBody(bot, body) {
  let text = String(body || '').trim();
  const name = String(bot?.username || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (name) text = text.replace(new RegExp(`^${name}(?:\\s*[:,!]\\s*|\\s+)`, 'i'), '');
  return text.replace(/^(?:please\s+|pls\s+)?(?:(?:can|could|would|will)\s+(?:you|u)\s+)?(?:please\s+|pls\s+)?/i, '')
    .replace(/^(?:go\s+|let'?s\s+)/i, '');
}

function itemWords(name) {
  return String(name || '').toLowerCase().replace(/^minecraft:/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

function isRawGatherObject(text) {
  if (!extractGatherBlockFromBody(text)) return false;
  return (text.match(/[a-z]+|\d+/gi) || []).every(word =>
    wordLooksLikeGather(word)
      || /^(?:\d+|some|a|few|of|like|bunch|stack|million|lot+s|please|pls|rn|lol)$/.test(collapseKidStretch(word.toLowerCase())));
}

// Resolve an explicit inventory handoff before classification can turn a
// material noun ("oak plank") into gathering its source block (oak_log).
// A framed but unknown item is returned with item=null so the original request
// falls through to the brain rather than another guessed mutating skill.
export function extractExplicitGiveRequest(bot, body) {
  const match = directRequestBody(bot, body).match(/^(give|hand|pass|toss|get|grab|fetch|bring)\s+me\s+(.+?)[.!?]*$/i);
  if (!match) return null;
  const retrieval = /^(?:get|grab|fetch|bring)$/i.test(match[1]);
  let requested = match[2].replace(/\s+(?:please|pls)$/i, '').trim();
  const quantity = requested.match(/^([+-]?\d\S*|an?|some)\s+(.+)$/i);
  const count = quantity && /^[+-]?\d/.test(quantity[1]) ? Number(quantity[1]) : 1;
  if (quantity) requested = quantity[2];
  if (!Number.isSafeInteger(count) || count < 1) return { item: null, count };
  const names = [...new Set([
    ...Object.keys(bot?.registry?.itemsByName || {}),
    ...(bot?.inventory?.items?.() || []).map(item => item.name),
  ])];
  const words = itemWords(requested);
  const item = names.find(name => itemWords(name) === words)
    || names.find(name => itemWords(name).replace(/s$/, '') === words.replace(/s$/, ''));
  // "Get me wood/logs" retains gathering semantics. A crafted item such as
  // planks is a handoff, even when absent from inventory; never mine its noun.
  const rawBlock = extractGatherBlockFromBody(words);
  const rawAlias = isRawGatherObject(words);
  if (retrieval && ((item && item === rawBlock) || (!item && rawAlias))) return null;
  return { item: item || null, count };
}

// A classifier score is not authority to mine. Require a positive action
// frame; a platform/build/give sentence containing "stone" or "oak" is not
// a gathering request, and should retain its original command for the brain.
export function hasGatherRequest(bot, body) {
  const request = directRequestBody(bot, body);
  if (!extractGatherBlockFromBody(request)) return false;
  const need = request.match(/^i\s+(?:need|want)\s+(.+)$/i);
  if (need) return isRawGatherObject(need[1]);
  return /^(?:get|grab|chop|mine|fetch|bring)\b/i.test(request)
    || (request.match(/[a-z]+/gi) || []).every(word =>
      wordLooksLikeGather(word) || /^(?:please|pls)$/.test(collapseKidStretch(word.toLowerCase())));
}

/** Collapse kid stretching to at most a natural double: wooood → wood, ironnnn → iron. */
export function collapseKidStretch(s) {
  return s.replace(/(.)\1{2,}/gi, '$1$1');
}

function stretchedStemMatch(c, stem) {
  if (c === stem || c === `${stem}s`) return stem;
  if (!c.startsWith(stem)) return null;
  const suffix = c.slice(stem.length);
  if (!suffix) return stem;
  if (/^s{1,3}$/.test(suffix)) return stem;
  const tail = stem[stem.length - 1];
  if (suffix.length <= 4 && [...suffix].every((ch) => ch === tail)) return stem;
  return null;
}

function wordLooksLikeOre(word) {
  const c = collapseKidStretch(word.toLowerCase());
  const m = c.match(ORE_STEM_RE);
  if (m) return m[1];
  for (const ore of ['diamond', 'iron', 'coal', 'copper', 'gold']) {
    const hit = stretchedStemMatch(c, ore);
    if (hit) return hit;
  }
  return null;
}

function wordLooksLikeGather(word) {
  const c = collapseKidStretch(word.toLowerCase());
  const m = c.match(GATHER_STEM_RE);
  if (m) return m[1];
  for (const stem of ['cobblestone', 'cobble', 'wood', 'stone', 'logs', 'log', 'oak', 'dirt', 'sand']) {
    const hit = stretchedStemMatch(c, stem);
    if (hit) return hit;
  }
  return null;
}

/** @returns {'iron'|'coal'|'diamond'|'copper'|'gold'|null} */
export function extractOreFromBody(body) {
  const words = String(body).match(/[a-z]+/gi) || [];
  for (const word of words) {
    const ore = wordLooksLikeOre(word);
    if (ore) return ore;
  }
  return null;
}

const GATHER_BLOCK = {
  wood: 'oak_log', log: 'oak_log', logs: 'oak_log', oak: 'oak_log',
  dirt: 'dirt', stone: 'stone', cobble: 'cobblestone',
  cobblestone: 'cobblestone', sand: 'sand',
};

/** @returns {string|null} minecraft block id */
export function extractGatherBlockFromBody(body) {
  const words = String(body).match(/[a-z]+/gi) || [];
  for (const word of words) {
    const stem = wordLooksLikeGather(word);
    if (!stem) continue;
    if (stem.startsWith('wood')) return GATHER_BLOCK.wood;
    if (stem.startsWith('log')) return GATHER_BLOCK.log;
    if (stem.startsWith('oak')) return GATHER_BLOCK.oak;
    if (stem.startsWith('dirt')) return GATHER_BLOCK.dirt;
    if (stem.startsWith('cobblestone')) return GATHER_BLOCK.cobblestone;
    if (stem.startsWith('cobble')) return GATHER_BLOCK.cobble;
    if (stem.startsWith('stone')) return GATHER_BLOCK.stone;
    if (stem.startsWith('sand')) return GATHER_BLOCK.sand;
    return GATHER_BLOCK[stem] || null;
  }
  return null;
}

export function extractKidName(body) {
  const kidNameMatch = String(body).match(
    /\b(?:name(?:d)?\s+it|call(?:ed)?\s+it|called|named)\s+([A-Za-z][\w '-]{0,40}?)(?:\s*[,.!?;:]|\s+(?:and|save|please|then|so|with|to)\b|$)/i,
  );
  return kidNameMatch
    ? kidNameMatch[1].trim().replace(/\s+/g, ' ').slice(0, 60)
    : null;
}
