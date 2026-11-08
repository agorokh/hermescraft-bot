// Build-request contract guard for the regex router (hermescraft#501).
//
// The NLP router applies the contract itself (intent_router_nlp.js tryRoute).
// The regex router does not, so server.js passes every regex route through
// here: in regex-primary mode (HERMES_NLP_PRIMARY=0) and in the NLP-primary
// fallback branches. Kept out of server.js so it can be tested without a bot.

import { checkBuildRequest, contractBuildRoute, contractCapabilityRoute, recordLastSkill } from './intent_router_nlp.js';

// Regex actions that change the world with a structure or placement.
export const REGEX_BUILD_ACTIONS = new Set([
  'build_tower', 'build_schematic', 'build_schematic_advanced', 'place_near_player',
]);

function cannotPlaceRoute(schematic) {
  const name = String(schematic || 'that').replace(/_/g, ' ');
  return {
    matched: true,
    intent_name: 'build_unsupported',
    action: 'chat',
    body: { text: `I can't place the ${name} right now.` },
    skill_id: null,
    nlp_zone: 'build_unsupported',
  };
}

/**
 * Apply the contract to one regex route.
 * - unsupported request → handled chat refusal (nlp_zone build_unsupported)
 * - the regex resolved a different structure than the object names ("build a
 *   garden near the hotel" → grand_hotel) → the named structure (nlp_zone
 *   catalog_remap), or a handled refusal when it cannot be anchored
 * - the object is a body capability but the regex placed a schematic ("build a
 *   tower near the hotel") → the capability's skill (nlp_zone catalog_remap)
 * - otherwise the route unchanged
 * Remapped routes come back with skill_id null (the caller records them) and
 * build_framed: whether the sentence was a request to the companion.
 */
export async function guardRegexBuildRoute(bot, body, sender, route, log = () => {}) {
  if (!route?.matched || !REGEX_BUILD_ACTIONS.has(route.action)) return route;
  const { route: refusal, contract } = checkBuildRequest(bot, body, sender, route.intent_name, null, { acting: true });
  if (refusal) return refusal;
  if (contract.status !== 'supported' || !route.body?.name) return route;
  // The object names a schematic, and the regex placed a different one.
  if (contract.schematic && route.body.name !== contract.schematic) {
    const remapped = await contractBuildRoute(bot, body, sender, contract.schematic);
    log(`[IntentRouter] regex ${route.action} ${route.body.name} -> ${remapped ? contract.schematic : 'refused'}: request names ${contract.schematic}`);
    return remapped ? { ...remapped, build_framed: contract.framed } : cannotPlaceRoute(contract.schematic);
  }
  // The object is a body capability ("a tower near the hotel"), and the regex
  // placed a schematic: use the capability's skill.
  if (!contract.schematic && contract.capability) {
    const skill = await contractCapabilityRoute(bot, body, sender, contract.capability);
    log(`[IntentRouter] regex ${route.action} ${route.body.name} -> ${skill ? skill.action : 'refused'}: request names ${contract.capability}`);
    return skill ? { ...skill, build_framed: contract.framed } : cannotPlaceRoute(contract.capability);
  }
  return route;
}

/**
 * Regex-primary routing (HERMES_NLP_PRIMARY=0) under the contract. An
 * unmatched, framed, unsupported "build ..." request is still a handled
 * refusal rather than a brain turn. A remapped build enters the repeat buffer.
 */
export async function routeRegexPrimary(bot, body, sender, tryRouteRegex, log = () => {}) {
  const regex = await guardRegexBuildRoute(bot, body, sender, await tryRouteRegex(bot, body, sender), log);
  if (regex.matched) {
    if (regex.nlp_zone === 'catalog_remap') {
      regex.skill_id = recordLastSkill(bot, regex.intent_name, regex.action, regex.body, body);
    }
    return regex;
  }
  return checkBuildRequest(bot, body, sender).route || regex;
}
