// Shared kid-keyword → schematic name mapping for regex and NLP routers.

const ADVANCED_SCHEMATICS = new Set([
  'grand_hotel',
  'crystal_observatory',
  'wizard_tower',
  'market_square',
  'sky_bridge',
  'beacon_plaza',
]);

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
  if (/\b(observatory|telescope|stargazing|star\s*tower|crystal\s*lab)\b/.test(b)) return 'crystal_observatory';
  if (/\b(wizard|mage|magic|spell)\b/.test(b) && /\b(tower|spire|castle)\b/.test(b)) return 'wizard_tower';
  if (/\b(market|marketplace|bazaar|village\s*square|town\s*square|shopping\s*street)\b/.test(b)) return 'market_square';
  if (/\b(sky\s*bridge|sky\s*walkway|sky\s*overpass)\b/.test(b)) return 'sky_bridge';
  if (/\b(beacon\s*plaza|gallery\s*plaza|light\s*plaza)\b/.test(b)) return 'beacon_plaza';
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
/** Recall / hypothetical build chat — must not dispatch a schematic placement. */
export function isSpeculativeBuildDiscussion(body) {
  const text = String(body || '').toLowerCase();
  if (!/\b(build|building|built|construct|design|observatory|wizard tower|market square|sky bridge|beacon plaza|schematic)\b/.test(text)) {
    return false;
  }
  return /\b(should we|someday|some day|later|another day|wish we could|tell me a story|talked about|do you remember|remember when)\b/.test(text)
    || /\b(what did (we|you) build|what have (we|you) built|what was built|did (we|you) build)\b/.test(text)
    || /\bwhere (is|are) (the |our )?(sky bridge|beacon plaza|wizard tower|crystal observatory|market square|grand hotel|treehouse|garden|well|ice castle|small house|small tower|igloo|campfire)\b/.test(text)
    || /\bwhere did (we|you) build\b/.test(text);
}

