// Shared kid-keyword → schematic name mapping for regex and NLP routers.

const ADVANCED_SCHEMATICS = new Set(['grand_hotel']);

function wantsSchematicList(body) {
  const b = String(body).toLowerCase();
  return /\b(what can|what could|show me|list)\b/i.test(b)
    || /\bwhat\s+builds?\b/i.test(b)
    || /\bbuilds?\s+(u|you)\s+got\b/i.test(b)
    || /\bwhat\s+r\s+ur\s+builds?\b/i.test(b);
}

/** @returns {string|null} schematic name, or 'list' for list_schematics */
export function resolveSchematicName(body) {
  const b = String(body).toLowerCase();
  if (wantsSchematicList(b)) return 'list';
  if (/\b(hotel|mansion|resort|apartment|apartments|lodge|villa)\b/.test(b)) return 'grand_hotel';
  if (/\b(ice|frozen|frosty)\b/.test(b) && /\b(castle|fort|house|palace|home|cottage)\b/.test(b)) {
    return 'ice_castle';
  }
  if (/\b(igloo|snow\s*house|snow\s*home|snow\s*shelter|snow\s*hut)\b/.test(b)) return 'igloo';
  if (/\b(treehouse|tree house|tree fort|tree home)\b/.test(b)) return 'treehouse';
  if (/\b(big|huge|giant|massive|fancy|grand|biggest)\b/.test(b) && /\b(house|home|building|structure)\b/.test(b)) {
    return 'grand_hotel';
  }
  if (/\b(house|cottage|home|cabin)\b/.test(b)) return 'small_house';
  if (/\b(well|fountain)\b/.test(b)) return 'well';
  if (/\b(garden|flower bed|flower patch|flower garden)\b/.test(b)) return 'garden';
  if (/\b(castle|fort|palace|tower|watchtower|outpost)\b/.test(b)) return 'small_tower';
  if (/\b(campfire|fire pit|firepit|sit spot|hangout)\b/.test(b)) return 'campfire_spot';
  return null;
}

export function isAdvancedSchematicName(name) {
  return ADVANCED_SCHEMATICS.has(String(name || '').toLowerCase());
}
