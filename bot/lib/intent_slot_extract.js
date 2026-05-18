// Kid-voice tolerant slot extraction for NLP/regex dispatchers.

const ORE_STEMS = ['diamond', 'iron', 'coal', 'copper', 'gold'];
const GATHER_STEMS = ['cobblestone', 'cobble', 'wood', 'stone', 'logs', 'log', 'oak', 'dirt', 'sand'];

/** Collapse kid stretching to at most a natural double: wooood → wood, ironnnn → iron. */
export function collapseKidStretch(s) {
  return s.replace(/(.)\1{2,}/gi, '$1$1');
}

function normalizeKidWord(word) {
  const c = collapseKidStretch(word.toLowerCase());
  for (const stem of ORE_STEMS) {
    if (c === stem || c.startsWith(stem)) return stem;
  }
  for (const stem of GATHER_STEMS) {
    if (c === stem || c.startsWith(stem)) return stem;
  }
  return c;
}

function normalizeKidBody(body) {
  return body.replace(/[a-z]+/gi, (word) => normalizeKidWord(word));
}

/** @returns {'iron'|'coal'|'diamond'|'copper'|'gold'|null} */
export function extractOreFromBody(body) {
  const normalized = normalizeKidBody(body);
  const m = normalized.match(/\b(iron|coal|diamond|copper|gold)s?\b/i);
  if (!m) return null;
  return m[1].toLowerCase();
}

const GATHER_BLOCK = {
  wood: 'oak_log', log: 'oak_log', logs: 'oak_log', oak: 'oak_log',
  dirt: 'dirt', stone: 'stone', cobble: 'cobblestone',
  cobblestone: 'cobblestone', sand: 'sand',
};

/** @returns {string|null} minecraft block id */
export function extractGatherBlockFromBody(body) {
  const normalized = normalizeKidBody(body);
  const m = normalized.match(/\b(wood|log|oak|dirt|stone|cobblestone|cobble|sand)s?\b/i);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  if (raw.startsWith('wood')) return GATHER_BLOCK.wood;
  if (raw.startsWith('log')) return GATHER_BLOCK.log;
  if (raw.startsWith('oak')) return GATHER_BLOCK.oak;
  if (raw.startsWith('dirt')) return GATHER_BLOCK.dirt;
  if (raw.startsWith('cobblestone')) return GATHER_BLOCK.cobblestone;
  if (raw.startsWith('cobble')) return GATHER_BLOCK.cobble;
  if (raw.startsWith('stone')) return GATHER_BLOCK.stone;
  if (raw.startsWith('sand')) return GATHER_BLOCK.sand;
  return GATHER_BLOCK[raw] || null;
}
