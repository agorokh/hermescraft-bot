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
  if (/\b(?:talked about|remember|recall|from memory|from today|later chat|landmarks?)\b/i.test(b)) {
    return false;
  }
  return /\bwhat\s+(?:can|could)\s+(?:u|you)\s+build\b/i.test(b)
    || /\bshow me\b.*\b(builds?|schematics?|templates?)\b/i.test(b)
    || /\blist\b.*\b(builds?|schematics?|templates?|build\s+options?)\b/i.test(b)
    || /\b(builds?|schematics?|templates?)\b.*\blist\b/i.test(b)
    || /\bwhat\s+builds?\b/i.test(b)
    || /\bbuilds?\s+(u|you)\s+got\b/i.test(b)
    || /\bwhat\s+r\s+ur\s+builds?\b/i.test(b);
}

/** @returns {string|null} schematic name, or 'list' for list_schematics */
export function resolveSchematicName(body) {
  const b = String(body).toLowerCase();
  if (wantsSchematicList(b)) return 'list';
  if (/\b(observatory|telescope|stargazing|star\s*tower|crystal\s*lab)\b/.test(b)) return 'crystal_observatory';
  if (/\b(ice|frozen|frosty)\b/.test(b) && /\b(castle|fort|house|palace|home|cottage)\b/.test(b)) {
    return 'ice_castle';
  }
  if (/\b(igloo|snow\s*house|snow\s*home|snow\s*shelter|snow\s*hut)\b/.test(b)) return 'igloo';
  if (/\b(?:wizard|mage|magic|spell)\s*(?:tower|spire|castle)\b/.test(b)
    || /\b(?:tower|spire|castle)\s*(?:of\s+)?(?:wizard|mage|magic|spell)s?\b/.test(b)) return 'wizard_tower';
  if (/\b(marketplace|bazaar|village\s*square|town\s*square|shopping\s*street|market\s*square)\b/.test(b)
    && !/\b(at|in|near|by|from|to|on)\s+(?:the\s+)?(?:bazaar|market(?:place|square)?|village\s*square|town\s*square|shopping\s*street)\b/.test(b)) {
    return 'market_square';
  }
  if (/\b(sky\s*bridge|sky\s*walkway|sky\s*overpass)\b/.test(b)) return 'sky_bridge';
  if (/\b(beacon\s*plaza|gallery\s*plaza|light\s*plaza)\b/.test(b)) return 'beacon_plaza';
  if (/\b(hotel|mansion|resort|apartment|apartments|lodge|villa)\b/.test(b)) return 'grand_hotel';
  if (/\b(treehouse|tree house|tree fort|tree home)\b/.test(b)) return 'treehouse';
  if (/\b(big|huge|giant|massive|fancy|grand|biggest)\b/.test(b) && /\b(house|home|building|structure)\b/.test(b)) {
    return 'grand_hotel';
  }
  if (/\b(house|cottage|home|cabin)\b/.test(b)) return 'small_house';
  if (/\b(well|fountain)\b/.test(b)) return 'well';
  if (/\b(garden|flower bed|flower patch|flower garden)\b/.test(b)) return 'garden';
  if (/\b(castle|fort|palace|tower|watchtower|outpost)\b/.test(b)) return 'small_tower';
  if (/\b(campfire|fire pit|firepit|sit spot|hangout)\b/.test(b)) return 'campfire_spot';
  if ((/\b(build|make|set up|construct|create|design)\b.*\b(?:a|an|the|our|my|me\s+(?:a|an))\s+market\b/.test(b)
    || /\bmarket\s+(?:square|place|stall|stalls|area|bazaar)\b/.test(b))
    && !/\b(at|in|near|by|from|to|on)\s+(?:the\s+)?market\b/.test(b)) return 'market_square';
  return null;
}

export function isAdvancedSchematicName(name) {
  return ADVANCED_SCHEMATICS.has(String(name || '').toLowerCase());
}
/** Recall / hypothetical build chat — must not dispatch a schematic placement. */
function hasImperativeBuildCommand(text) {
  if (/\bshould we\b/.test(text)) return false;
  if (/\b(someday|some day|wish we could)\b/.test(text)) return false;
  return /\b(build|make|put up|construct|design|create|set up)\b(?:\s+(?:the|a|an|me|our|my|that|this)\b|\s+\S+)/.test(text);
}

export function isSpeculativeBuildDiscussion(body) {
  const text = String(body || '').toLowerCase();
  const resolved = resolveSchematicName(text);
  const mentionsBuildTopic = /\b(build|building|built|construct|design|schematics?)\b/.test(text)
    || resolved != null;
  if (!mentionsBuildTopic) return false;
  const whereRecall = /\bwhere (is|are)\b/.test(text)
    && resolved != null
    && !/\b(build|make|put up|construct|design|create|set up)\b/.test(text);
  const softRecall = /\b(talked about|do you remember|remember when|tell me a story|later|another day)\b/.test(text);
  const hardRecall = /\b(should we (?:build|make|construct|have a|try to|get a|add a)|someday|some day|wish we could)\b/.test(text)
    || /\b(what did (we|you) build|what have (we|you) built|what was built|did (we|you) build)\b/.test(text)
    || /\bwhere did (we|you) build\b/.test(text);
  const imperativeBuild = hasImperativeBuildCommand(text);
  return hardRecall || (softRecall && !imperativeBuild) || whereRecall;
}
