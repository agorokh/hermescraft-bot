// Kid-voice tolerant slot extraction for NLP/regex dispatchers.

/** Collapse stretched spellings: diamondssss → diamonds, wooood → wood. */
export function collapseKidStretch(s) {
  return s.replace(/(.)\1{2,}/gi, '$1');
}

/** @returns {'iron'|'coal'|'diamond'|'copper'|'gold'|null} */
export function extractOreFromBody(body) {
  const m = body.match(/\b(irons+|coals+|diamonds+|coppers+|golds+|iron|coal|diamond|copper|gold)\b/i);
  if (!m) return null;
  const t = collapseKidStretch(m[1].toLowerCase());
  for (const ore of ['diamond', 'iron', 'coal', 'copper', 'gold']) {
    if (t === ore || t.startsWith(ore)) return ore;
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
  const m = body.match(/\b(woods+|logs+|oaks+|dirts+|stones+|cobblestones+|cobbles+|sands+|wood|log|logs|oak|dirt|stone|cobblestone|cobble|sand)\b/i);
  if (!m) return null;
  const t = collapseKidStretch(m[1].toLowerCase());
  if (t.startsWith('wood')) return GATHER_BLOCK.wood;
  if (t.startsWith('log')) return GATHER_BLOCK.log;
  if (t.startsWith('oak')) return GATHER_BLOCK.oak;
  if (t.startsWith('dirt')) return GATHER_BLOCK.dirt;
  if (t.startsWith('cobblestone')) return GATHER_BLOCK.cobblestone;
  if (t.startsWith('cobble')) return GATHER_BLOCK.cobble;
  if (t.startsWith('stone')) return GATHER_BLOCK.stone;
  if (t.startsWith('sand')) return GATHER_BLOCK.sand;
  return GATHER_BLOCK[t] || null;
}
