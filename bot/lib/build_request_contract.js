// Build-request contract (hermescraft#501).
//
// A build sentence either starts the library structure it names, or the
// companion says it cannot and does not change the world. The classifier score
// never decides that: on 2026-10-24 "make a roller coaster" routed to
// plant_flowers at 0.88, "lets build the eiffel tower" to build_tower at 0.97 and
// "design a castle with a moat" to small_tower at 0.99. Raising the act
// threshold to 0.989 stops those, but breaks five acts the tests require and
// still sends "build me a pirate ship" to the brain unhandled.
//
// The check reads every object of every build verb in the sentence:
//   - the head noun must resolve to a library entry (resolveSchematicName) or a
//     body capability (tower, shelter, flowers, farm) — "pirate ship" does not;
//   - a descriptive modifier is fine ("a haunted house", "a log cabin"), but a
//     definite unknown modifier names a specific other thing ("the eiffel tower");
//   - a "with ..." clause may only name what the structure already has
//     ("with battlements"), not a new part ("with a moat");
//   - a coordinated or compared object must pass too ("a castle and a moat",
//     "a tower like the eiffel tower");
//   - words after the head must be size words or filler ("4 tall"), not another
//     noun ("a house boat").
// One unsupported object makes the request unsupported.

import { isSpeculativeBuildDiscussion, resolveSchematicName } from './schematic_resolve.js';

// "make" / "create" mean "build" only when the classifier also picked a build
// intent: "make me a sword" is a crafting ask, while "make me a nether portal"
// was routed to plant_flowers. build / construct / design / set up / put up
// always count.
const SOFT_BUILD_VERBS = new Set(['make', 'create']);
const WORLD_BUILD_INTENTS = new Set(['build_schematic', 'build_tower', 'plant_flowers']);

// Intents the contract never overrides: stop is the safety primitive, and the
// survival intents have their own capability path (server.js regex fallback).
const EXEMPT_INTENTS = new Set([
  'stop', 'build_shelter_for_night', 'farm_food', 'fish_for_food', 'cook_food', 'return_home', 'feed_player',
]);

// Body capabilities that are not schematic names but are real builds.
const CAPABILITY_HEADS = new Set([
  'tower', 'pillar', 'column', 'spire',
  'shelter', 'base', 'bunker', 'hideout',
  'flower', 'farm',
]);

// Words the library resolver itself keys on, valid as modifiers.
const CATALOG_WORDS = new Set([
  'ice', 'frozen', 'frosty', 'snow', 'wizard', 'mage', 'magic', 'spell', 'star',
  'crystal', 'sky', 'beacon', 'gallery', 'light', 'flower', 'tree', 'fire',
  'market', 'village', 'town', 'shopping', 'stargazing', 'telescope', 'grand',
]);

// Style / size / material words. They never make a request unsupported, even
// after "the" ("the tallest tower ever"). Comparatives and superlatives count.
const STYLE_WORDS = new Set([
  'small', 'little', 'tiny', 'mini', 'big', 'huge', 'giant', 'massive', 'large',
  'tall', 'short', 'wide', 'long', 'high', 'cozy', 'cosy', 'comfy', 'cute', 'pretty',
  'nice', 'cool', 'awesome', 'fancy', 'simple', 'basic', 'quick', 'new', 'another',
  'super', 'really', 'very', 'even', 'beautiful', 'lovely', 'amazing', 'epic', 'fun',
  'secret', 'special', 'magical', 'fairy', 'sweet', 'neat', 'good', 'great', 'own',
  'raised', 'square', 'round', 'bright', 'shiny', 'sparkly', 'glowing', 'colorful',
  'colourful', 'wooden', 'wood', 'stone', 'cobble', 'cobblestone', 'oak', 'spruce',
  'birch', 'brick', 'glass', 'dirt', 'sand', 'snowy', 'same', 'last', 'other',
  'white', 'black', 'red', 'blue', 'green', 'yellow', 'pink', 'purple', 'orange',
  'brown', 'gray', 'grey', 'gold', 'golden',
]);

const NUMBER_WORDS = new Set([
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'fifteen', 'twenty', 'hundred', 'double', 'triple',
]);

// Features the library structures already carry: a "with ..." clause may name
// them, and a garden request may list its flowers after the head.
const FEATURE_WORDS = new Set([
  'battlements', 'window', 'windows', 'door', 'doors', 'roof', 'torch', 'torches',
  'lights', 'lamps', 'lanterns', 'stairs', 'ladder', 'chimney', 'fence', 'flowers',
  'path', 'balcony', 'porch', 'bed', 'beds', 'chest', 'chests', 'furniture', 'table', 'water',
  'poppy', 'poppies', 'dandelion', 'dandelions', 'tulip', 'tulips', 'rose', 'roses',
  'orchid', 'orchids',
]);

// Placeholder nouns that restate the head ("a hangout spot", "an apartment building").
const PLACEHOLDER_NOUNS = new Set(['spot', 'place', 'area', 'building', 'structure', 'zone', 'room']);

// Size units in "4 blocks tall", "two story house".
const UNIT_WORDS = new Set(['block', 'blocks', 'story', 'stories', 'storey', 'floor', 'floors']);

// Filler allowed after the head noun.
const TRAILING_WORDS = new Set([
  'quick', 'quickly', 'fast', 'now', 'today', 'later', 'tomorrow', 'soon', 'too', 'also',
  'real', 'really', 'ever', 'together', 'rn', 'again', 'first', 'lol', 'ok', 'okay',
  'pls', 'plz', 'please', 'thanks', 'thx', 'yay', 'rosie', 'steve', 'myself', 'yourself',
]);

// "build a house nvm" cancels the request.
const CANCEL_WORDS = new Set(['nvm', 'nevermind', 'jk', 'kidding', 'nah']);

const DETERMINERS = new Set([
  'a', 'an', 'the', 'some', 'my', 'our', 'your', 'me', 'us', 'this', 'that', 'these', 'those',
]);

// An object that starts with one of these is causative ("make it bright"), not
// a structure name.
const OBJECT_PRONOUNS = new Set(['it', 'them', 'him', 'her', 'everything', 'everyone']);

// Head words that do not name a structure: let the normal router handle them.
const NON_NAMING_HEADS = new Set([
  'it', 'them', 'one', 'ones', 'something', 'anything', 'everything', 'nothing', 'stuff',
  'thing', 'things', 'thingy', 'thingie', 'whatever', 'more', 'again', 'what', 'up', 'before',
]);

// Subject pronouns start a new clause ("a house i can sleep in", "with the oak you have").
const SUBJECT_PRONOUNS = new Set(['you', 'i', "i'll", "i'm", 'we', 'they', 'he', 'she', 'u']);

// Relative-clause openers end the object ("a tower thats 10 blocks high").
const RELATIVE_WORDS = new Set(['that', 'thats', "that's", 'which', 'who', 'whose']);

const BUILD_VERB_TOKENS = new Set(['build', 'construct', 'design', 'make', 'create']);

// Coordinators that may introduce another object ("a castle and a moat").
const COORDINATORS = new Set(['and', 'then', 'plus', '&']);

// Words that end an object noun phrase.
const BOUNDARY_WORDS = new Set([
  'for', 'here', 'there', 'right', 'next', 'near', 'nearby', 'by', 'at', 'in',
  'on', 'behind', 'beside', 'under', 'over', 'around', 'outside', 'inside', 'so',
  'to', 'using', 'use', 'from', 'but', 'because', 'cuz', 'called', 'named', 'name',
  'call', 'where', 'when', 'if', 'or', 'out', 'made',
]);

const NEGATION_RE = /\b(?:don'?t|do not|dont|never|no|not|stop|cancel|quit|nevermind|never mind|nvm|wait|can'?t|cannot|won'?t|shouldn'?t|mustn'?t|didn'?t)\b/;
// Subordinate or hypothetical framing before the verb: "when we build",
// "maybe we could build", "how to build".
const SUBORDINATE_RE = /\b(?:when|whenever|if|while|after|before|until|because|cuz|maybe|might|thinking|imagine|pretend|wish|how)\b/;
// Request frames: the only words allowed before the verb when the router builds
// on the catalog's word rather than the classifier's ("Rosie can you build ...").
const REQUEST_FRAME_WORDS = new Set([
  'can', 'could', 'will', 'would', 'you', 'u', 'please', 'pls', 'plz', 'lets', "let's", 'let',
  'us', 'go', 'ok', 'okay', 'now', 'hey', 'hi', 'rosie', 'steve', 'i', 'want', 'wanna', 'need',
  'to', 'just', 'and', 'so', 'quick', 'quickly', 'yo', 'pretty', 'oh', 'also', 'then',
  'help', 'me', 'even',
]);
// A stop / cancel anywhere before the verb: the sentence is not a build request.
const STOP_BEFORE_RE = /\b(?:stop|halt|cancel|quit|freeze)\b/;
const FILLER_RE = /^(?:u+h+|u+m+|h+m+|e+r+m*|a+h+)$/;
const SIZE_TOKEN_RE = /^\d+(?:x\d+)?(?:-?(?:tall|high|wide|long|blocks?|story|stories|floors?))?$/;
const PLEASE_RE = /^p+l+(?:e+a+)?s+e*$|^pl[sz]+$/;

function resolvedEntry(phrase) {
  const resolved = resolveSchematicName(`build a ${phrase}`);
  return resolved && resolved !== 'list' ? resolved : null;
}

function singular(word) {
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(?:ss|us)$/.test(word)) return word;
  if (/(?:ch|sh|x)es$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word)) return word.slice(0, -1);
  return word;
}

function isStyleWord(word) {
  if (STYLE_WORDS.has(word)) return true;
  const m = word.match(/^(.+?)(?:est|er)$/);
  if (!m) return false;
  const stem = m[1];
  const undoubled = stem.replace(/(.)\1$/, '$1');
  return STYLE_WORDS.has(stem) || STYLE_WORDS.has(undoubled) || STYLE_WORDS.has(`${stem}e`);
}

function isSizeOrStyle(word) {
  if (isStyleWord(word) || SIZE_TOKEN_RE.test(word) || UNIT_WORDS.has(word) || NUMBER_WORDS.has(word)) return true;
  // "two-story", "ten-block"
  const parts = word.split('-');
  return parts.length > 1 && parts.every((p) => isSizeOrStyle(p));
}

/** Library entry for one head noun, or null. 'capability' for body builds. */
function singleHeadEntry(word) {
  const direct = resolvedEntry(word);
  if (direct) return direct;
  const one = singular(word);
  const plural = one !== word ? resolvedEntry(one) : null;
  if (plural) return plural; // "towers" is small_tower like "tower"
  return CAPABILITY_HEADS.has(one) ? 'capability' : null;
}

/**
 * Library entry for a head span, or null. A two-word span is a compound head
 * only when neither word alone explains the entry ("tree house" is treehouse,
 * not small_house). "eiffel tower" resolves like "tower" and "house boat" like
 * "house", so "eiffel" and "boat" are left to the modifier / trailing checks.
 */
function headEntry(words) {
  if (words.length === 1) return singleHeadEntry(words[0]);
  const [first, last] = [words[0], words[words.length - 1]];
  const compound = resolvedEntry(`${first} ${last}`) || resolvedEntry(`${singular(first)} ${last}`);
  if (!compound) return null;
  if (compound === singleHeadEntry(first) || compound === singleHeadEntry(singular(first))) return null;
  if (compound === singleHeadEntry(last)) return null;
  return compound;
}

function isKnownWord(word) {
  return isSizeOrStyle(word) || CATALOG_WORDS.has(word) || FEATURE_WORDS.has(word)
    || TRAILING_WORDS.has(word) || DETERMINERS.has(word) || PLACEHOLDER_NOUNS.has(word)
    || BOUNDARY_WORDS.has(word) || NON_NAMING_HEADS.has(word) || singleHeadEntry(word) != null;
}

/** Strip quotes and possessives; undo kid elongation ("houseee") when the shorter word is known. */
function normalizeToken(raw) {
  if (raw === ',') return raw;
  let word = raw.replace(/^['"(]+|['")]+$/g, '');
  if (word === 'w/' || word === 'w') return 'with';
  if (/^[a-z]+'s$/.test(word) && !RELATIVE_WORDS.has(word)) word = word.slice(0, -2);
  if (isKnownWord(word)) return word;
  const collapsed = word.replace(/(.)\1+$/, '$1');
  return collapsed !== word && isKnownWord(collapsed) ? collapsed : word;
}

/** Split a sentence remainder into word tokens, keeping soft separators as ','. */
function tokenize(rest) {
  return rest
    .replace(/[(),—–]|\s-\s/g, ' , ')
    .split(/\s+/)
    .filter(Boolean)
    .map(normalizeToken)
    .filter(Boolean);
}

const isModifier = (t) => isSizeOrStyle(t) || CATALOG_WORDS.has(t) || DETERMINERS.has(t);

/**
 * Parse the objects of one build verb: the main object, coordinated objects
 * ("and a moat"), and a "like ..." comparison. Each object carries its own
 * of-clause and with-clause words.
 */
function parseObjects(tokens) {
  const objects = [];
  let cur = null;
  let mode = 'start';
  const open = () => {
    cur = { det: null, words: [], ofWords: [], withWords: [] };
    objects.push(cur);
    mode = 'object';
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (PLEASE_RE.test(t)) break;
    if (mode === 'start') {
      if (t === 'for' && (next === 'me' || next === 'us')) { i += 1; continue; }
      open();
    }
    if (t === ',') {
      // A comma before "with" / "and a ..." does not end the request.
      if (next === 'with' || COORDINATORS.has(next)) continue;
      break;
    }
    if (mode === 'object' && cur.words.length === 0 && DETERMINERS.has(t)) {
      if (cur.det == null && t !== 'me' && t !== 'us') cur.det = t;
      continue;
    }
    if (t === 'with') { mode = 'with'; continue; }
    if ((t === 'of' && mode === 'object') || (t === 'made' && next === 'of') || (t === 'out' && next === 'of')) {
      if (t !== 'of') i += 1;
      mode = 'of';
      continue;
    }
    if (t === 'like') { open(); cur.compare = true; continue; }
    if (COORDINATORS.has(t)) {
      if (mode === 'with' && t === 'and') continue; // "with windows and a door"
      let j = i + 1;
      while (tokens[j] === 'also' || tokens[j] === 'then' || tokens[j] === 'and') j += 1;
      if (DETERMINERS.has(tokens[j]) && tokens[j] !== 'me' && tokens[j] !== 'us') {
        i = j - 1;
        open();
        continue;
      }
      break;
    }
    // A second build verb starts its own request; the caller checks it separately.
    if (BUILD_VERB_TOKENS.has(t)) break;
    if (RELATIVE_WORDS.has(t) || SUBJECT_PRONOUNS.has(t) || BOUNDARY_WORDS.has(t)) break;
    if (mode === 'object') cur.words.push(t);
    else if (mode === 'of') cur.ofWords.push(t);
    else cur.withWords.push(t);
  }
  return objects;
}

function phraseOf(obj) {
  return [
    ...obj.words,
    ...(obj.ofWords.length ? ['of', ...obj.ofWords] : []),
    ...(obj.withWords.length ? ['with', ...obj.withWords] : []),
  ].join(' ');
}

/** Check one object against the library. */
function checkObject(obj, names) {
  const words = [...obj.words];
  if (words.some((t) => CANCEL_WORDS.has(t))) return { status: 'none' };
  // Names are only accepted after a confirmed head (below), never stripped first:
  // a word that happens to be a name must not hide "a house boat".
  while (words.length && TRAILING_WORDS.has(words[words.length - 1])) words.pop();
  if (words.length === 0) return { status: 'none' };
  if (words.some((t) => FILLER_RE.test(t))) return { status: 'none' };
  if (NON_NAMING_HEADS.has(words[words.length - 1])) return { status: 'none' };
  // "build another", "build 10 tall": no structure named; the normal router decides.
  if (words.every((t) => isSizeOrStyle(t))) return { status: 'none' };

  const phrase = phraseOf({ ...obj, words });
  let headStart = -1;
  let headEnd = -1;
  let entry = null;
  for (let end = words.length; end > 0 && headStart < 0; end -= 1) {
    for (const len of [2, 1]) {
      const start = end - len;
      if (start < 0) continue;
      const found = headEntry(words.slice(start, end));
      if (found) {
        headStart = start;
        headEnd = end;
        entry = found;
        break;
      }
    }
  }
  if (headStart < 0) return { status: 'unsupported', phrase, reason: 'not_in_library' };
  // The structure is what the resolver makes of the whole object, not the head
  // alone: "a house of ice" is ice_castle, "a tower of wizards" wizard_tower.
  // Only the object is resolved, never the whole sentence, so "a garden near
  // the hotel" stays a garden.
  const objectEntry = resolvedEntry([...words, ...(obj.ofWords.length ? ['of', ...obj.ofWords] : [])].join(' '));
  const headWords = words.slice(headStart, headEnd);
  const headOnly = entry === 'capability' ? null : entry;
  let schematic = objectEntry || headOnly;
  // A bare body capability ("a stone tower 4 tall") is the build_tower skill,
  // not the small_tower schematic the resolver maps "tower" to. Only a word
  // that changes the structure ("a tower of wizards") names a schematic.
  const headLast = singular(headWords[headWords.length - 1]);
  if (headWords.length === 1 && CAPABILITY_HEADS.has(headLast)
    && (!objectEntry || objectEntry === headOnly)) {
    schematic = null;
  }
  const base = { phrase, schematic, head: headWords.join(' ') };

  // A descriptive modifier is fine ("a haunted house"). After "the", an unknown
  // modifier names one specific other thing ("the eiffel tower").
  if (obj.det === 'the') {
    const named = words.slice(0, headStart).find((t) => !isModifier(t) && !isModifier(singular(t)));
    if (named) return { ...base, status: 'unsupported', reason: `named:${named}` };
  }
  const badAfter = words.slice(headEnd).find((t) => !isSizeOrStyle(t) && !names.has(t)
    && !PLACEHOLDER_NOUNS.has(t) && !FEATURE_WORDS.has(t));
  if (badAfter) return { ...base, status: 'unsupported', reason: `trailing:${badAfter}` };
  const badOf = obj.ofWords.find((t) => !isModifier(t) && !isModifier(singular(t)));
  if (badOf) return { ...base, status: 'unsupported', reason: `of:${badOf}` };
  // A with-word may name what the structure already is ("a castle with towers").
  const badWith = obj.withWords.find((t) => !FEATURE_WORDS.has(t) && !isModifier(t)
    && !TRAILING_WORDS.has(t) && singleHeadEntry(t) !== entry);
  if (badWith) return { ...base, status: 'unsupported', reason: `feature:${badWith}` };
  return { ...base, status: 'supported' };
}

/**
 * Parse an imperative build sentence and check every object against the library.
 * @param {string} body raw chat text
 * @param {{ nlpIntent?: string|null, names?: string[] }} [opts]
 *   nlpIntent: the classifier's (or regex router's) top intent, any zone
 *   names: companion / player names allowed after the head noun
 * @returns {{ status: 'none'|'supported'|'unsupported', phrase?: string,
 *   schematic?: string|null, head?: string, reason?: string, framed?: boolean }}
 *   framed: the verb sits in a plain request frame ("can you build ...").
 */
export function buildRequestContract(body, opts = {}) {
  const text = String(body ?? '').toLowerCase().replace(/[’`]/g, "'");
  if (!text.trim()) return { status: 'none' };
  if (EXEMPT_INTENTS.has(opts.nlpIntent)) return { status: 'none' };
  if (isSpeculativeBuildDiscussion(text)) return { status: 'none' };
  if (/^\s*(?:how|why|what|when|where|who|which)\b/.test(text)) return { status: 'none' };
  const worldIntent = WORLD_BUILD_INTENTS.has(opts.nlpIntent);
  const names = new Set((opts.names || []).filter((n) => typeof n === 'string').map((n) => n.toLowerCase()));

  let firstSupported = null;
  const verbRe = /\b(build|construct|design|make|create|set up|put up)\b/g;
  let m;
  while ((m = verbRe.exec(text)) !== null) {
    const verb = m[1];
    if (SOFT_BUILD_VERBS.has(verb) && !worldIntent) continue;
    const before = text.slice(0, m.index);
    const clauseStart = Math.max(...[',', '.', ';', '!', '?', ':'].map((c) => before.lastIndexOf(c)));
    const prefix = before.slice(clauseStart + 1);
    // "dont build a tower" / "i love when we build stuff" are not commands.
    if (NEGATION_RE.test(prefix) || SUBORDINATE_RE.test(prefix)) continue;
    if (STOP_BEFORE_RE.test(before)) return { status: 'none' };

    const after = text.slice(m.index + verb.length);
    const sentenceEnd = after.search(/[.!?;:]/);
    const rest = sentenceEnd < 0 ? after : after.slice(0, sentenceEnd);
    const tokens = tokenize(rest);
    let k = 0;
    if (tokens[k] === 'for' && (tokens[k + 1] === 'me' || tokens[k + 1] === 'us')) k += 2;
    while (k < tokens.length && DETERMINERS.has(tokens[k])) k += 1;
    if (OBJECT_PRONOUNS.has(tokens[k])) continue;

    const prefixWords = prefix.split(/\s+/).filter(Boolean);
    const framed = prefixWords.every((w) => REQUEST_FRAME_WORDS.has(w) || names.has(w));
    for (const obj of parseObjects(tokens)) {
      const result = checkObject(obj, names);
      if (result.status === 'unsupported') return { ...result, framed };
      if (result.status === 'supported' && !firstSupported && !obj.compare) firstSupported = { ...result, framed };
    }
  }
  return firstSupported || { status: 'none' };
}

const DISPLAY_NAMES = {
  small_house: 'small house',
  small_tower: 'small tower',
  treehouse: 'treehouse',
  garden: 'garden',
  well: 'well',
  igloo: 'igloo',
  ice_castle: 'ice castle',
  campfire_spot: 'campfire spot',
  grand_hotel: 'grand hotel',
  crystal_observatory: 'crystal observatory',
  wizard_tower: 'wizard tower',
  market_square: 'market square',
  sky_bridge: 'sky bridge',
  beacon_plaza: 'beacon plaza',
};

const LIBRARY_OFFER = 'a house, treehouse, tower, garden, well, igloo, ice castle, campfire spot, '
  + 'hotel, wizard tower, observatory, market square, sky bridge or beacon plaza';

function cleanPhrase(value) {
  return String(value || '')
    .replace(/[^a-z0-9 '-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim();
}

/** Kid-facing refusal for an unsupported build request. */
export function unsupportedBuildReply(contract) {
  const phrase = cleanPhrase(contract?.phrase) || 'that';
  const article = /^[aeiou]/.test(phrase) ? 'an' : 'a';
  const lead = `I can't build ${article} ${phrase} yet.`;
  // The head is in the library but the extra part is not: offer the plain build.
  const offer = contract?.schematic ? DISPLAY_NAMES[contract.schematic] : cleanPhrase(contract?.head);
  if (offer) return `${lead} I can build ${/^[aeiou]/.test(offer) ? 'an' : 'a'} ${offer}, though.`;
  return `${lead} I can build ${LIBRARY_OFFER}.`;
}
