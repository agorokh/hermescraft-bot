// Kid-voice tolerant slot extraction for NLP/regex dispatchers.

const ORE_STEM_RE = /^(iron|coal|diamond|copper|gold)(s{0,3})$/;
const GATHER_STEM_RE = /^(wood|log|logs|oak|dirt|stone|cobblestone|cobble|sand)(s{0,3})$/;

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
