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
// So this reads the object of the build verb and asks whether the library can
// honor every word of it:
//   - the head noun resolves to a library entry (resolveSchematicName) or a
//     body capability (tower, shelter, flowers, farm);
//   - words before the head are style, size, material or catalog words;
//   - an "of ..." clause carries only those same words ("a house of ice");
//   - a "with ..." clause names only features the library already has
//     ("with battlements"), not new structure ("with a moat");
//   - words after the head are size words or filler ("4 tall", "real quick").
// Anything else means the library does not contain what the child asked for.

import { isSpeculativeBuildDiscussion, resolveSchematicName } from './schematic_resolve.js';

// "make" / "create" mean "build" only when the classifier also picked a build
// intent: "make me a sword" is a crafting ask, while "make me a nether portal"
// was routed to plant_flowers. build / construct / design always count.
const SOFT_BUILD_VERBS = new Set(['make', 'create', 'set up', 'put up']);
const WORLD_BUILD_INTENTS = new Set(['build_schematic', 'build_tower', 'plant_flowers']);

// Survival intents have their own capability path (server.js regex fallback,
// dirt shelter). The library contract does not judge them.
const SURVIVAL_INTENTS = new Set([
  'build_shelter_for_night', 'farm_food', 'fish_for_food', 'cook_food', 'return_home', 'feed_player',
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

// Style, size, material and theme words that do not change which structure is
// built. Comparatives and superlatives of these count too ("tallest").
const STYLE_WORDS = new Set([
  'small', 'little', 'tiny', 'mini', 'big', 'huge', 'giant', 'massive', 'large',
  'tall', 'short', 'wide', 'long', 'high', 'cozy', 'cosy', 'comfy', 'cute', 'pretty',
  'nice', 'cool', 'awesome', 'fancy', 'simple', 'basic', 'quick', 'new', 'another',
  'super', 'really', 'very', 'beautiful', 'lovely', 'amazing', 'epic', 'fun', 'secret',
  'special', 'magical', 'fairy', 'unicorn', 'rainbow', 'sweet', 'neat', 'good', 'great',
  'own', 'raised', 'square', 'round', 'bright', 'shiny', 'sparkly', 'glowing', 'colorful',
  'colourful', 'wooden', 'wood', 'stone', 'cobble', 'cobblestone', 'oak', 'spruce',
  'birch', 'brick', 'glass', 'dirt', 'sand', 'snowy',
  'white', 'black', 'red', 'blue', 'green', 'yellow', 'pink', 'purple', 'orange',
  'brown', 'gray', 'grey', 'gold', 'golden',
]);

// Features the library structures already carry: a "with ..." clause may name
// them, and a garden request may list its flowers after the head.
const FEATURE_WORDS = new Set([
  'battlements', 'window', 'windows', 'door', 'doors', 'roof', 'torch', 'torches',
  'lights', 'lamps', 'lanterns', 'stairs', 'ladder', 'chimney', 'fence', 'flowers',
  'path', 'balcony', 'porch', 'bed', 'beds', 'chest', 'chests', 'furniture', 'table',
  'poppy', 'poppies', 'dandelion', 'dandelions', 'tulip', 'tulips', 'rose', 'roses',
  'orchid', 'orchids',
]);

// Placeholder nouns that restate the head ("a hangout spot", "an apartment building").
const PLACEHOLDER_NOUNS = new Set([
  'spot', 'place', 'area', 'building', 'structure', 'zone', 'room',
]);

// Filler allowed after the head noun.
const TRAILING_WORDS = new Set([
  'quick', 'quickly', 'fast', 'now', 'today', 'later', 'tomorrow', 'soon', 'too', 'also',
  'real', 'really', 'ever', 'together', 'rn', 'again', 'first', 'lol', 'ok', 'okay',
  'pls', 'plz', 'please', 'thanks', 'thx', 'yay', 'rosie', 'steve',
]);

// Size units in "4 blocks tall".
const UNIT_WORDS = new Set(['block', 'blocks', 'story', 'stories', 'floor', 'floors']);

const DETERMINERS = new Set([
  'a', 'an', 'the', 'some', 'my', 'our', 'your', 'me', 'us', 'this', 'that', 'these', 'those',
]);

// An object that starts with one of these is causative ("make it bright"), not
// a structure name.
const OBJECT_PRONOUNS = new Set(['it', 'them', 'him', 'her', 'everything', 'everyone']);

// Head words that do not name a structure: let the normal router handle them.
const NON_NAMING_HEADS = new Set([
  'it', 'them', 'one', 'ones', 'something', 'anything', 'everything', 'nothing', 'stuff',
  'thing', 'things', 'thingy', 'thingie', 'whatever', 'more', 'again', 'what', 'up',
]);

// Subject pronouns end a "with ..." clause ("with the oak you have").
const SUBJECT_PRONOUNS = new Set(['you', 'i', 'we', 'they', 'he', 'she', 'it', 'u']);

// Words that end the object noun phrase.
const BOUNDARY_WORDS = new Set([
  'and', 'for', 'here', 'there', 'right', 'next', 'near', 'nearby', 'by', 'at', 'in',
  'on', 'behind', 'beside', 'under', 'over', 'around', 'outside', 'inside', 'so',
  'which', 'who', 'to', 'using', 'use', 'out', 'from', 'then', 'but', 'because', 'cuz',
  'called', 'named', 'name', 'call', 'like', 'where', 'when', 'if', 'or',
]);

const NEGATION_RE = /\b(?:don'?t|do not|dont|never|no|not|stop|cancel|quit|nevermind|never mind|wait)\b/;
// Subordinate or hypothetical framing before the verb: "when we build",
// "maybe we could build", "i was thinking ... build".
const SUBORDINATE_RE = /\b(?:when|whenever|if|while|after|before|until|because|cuz|maybe|might|thinking|imagine|pretend|wish)\b/;
const FILLER_RE = /^(?:u+h+|u+m+|h+m+|e+r+m*|a+h+)$/;
const SIZE_TOKEN_RE = /^\d+(?:-?(?:tall|high|wide|long|blocks?))?$/;
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

/** Library entry for one head noun, or null. 'capability' for body builds. */
function singleHeadEntry(word) {
  const direct = resolvedEntry(word);
  if (direct) return direct;
  const one = singular(word);
  if (CAPABILITY_HEADS.has(one)) return 'capability';
  return one !== word ? resolvedEntry(one) : null;
}

/**
 * Library entry for a head span, or null. A two-word span is a compound head
 * only when neither word alone explains the entry ("tree house" is treehouse,
 * not small_house). "eiffel tower" resolves like "tower" and "house boat" like
 * "house", so "eiffel" and "boat" are left for the modifier / trailing checks.
 */
function headEntry(words) {
  if (words.length === 1) return singleHeadEntry(words[0]);
  const compound = resolvedEntry(words.join(' '));
  if (!compound) return null;
  if (compound === singleHeadEntry(words[0])) return null;
  if (compound === singleHeadEntry(words[words.length - 1])) return null;
  return compound;
}

function isKnownWord(word) {
  return isStyleWord(word) || CATALOG_WORDS.has(word) || FEATURE_WORDS.has(word)
    || TRAILING_WORDS.has(word) || UNIT_WORDS.has(word) || DETERMINERS.has(word) || PLACEHOLDER_NOUNS.has(word)
    || BOUNDARY_WORDS.has(word) || NON_NAMING_HEADS.has(word) || singleHeadEntry(word) != null;
}

/** Undo kid elongation ("houseee", "towerrr") when the shorter form is a known word. */
function normalizeToken(raw) {
  const word = raw.replace(/^['"(]+|['")]+$/g, '');
  if (isKnownWord(word)) return word;
  const collapsed = word.replace(/(.)\1+$/, '$1');
  return collapsed !== word && isKnownWord(collapsed) ? collapsed : word;
}

function isSizeOrStyle(word) {
  return isStyleWord(word) || SIZE_TOKEN_RE.test(word) || UNIT_WORDS.has(word);
}

/**
 * Parse an imperative build sentence and check it against the library.
 * @param {string} body raw chat text
 * @param {{ nlpIntent?: string|null, names?: string[] }} [opts]
 *   nlpIntent: the classifier's (or regex router's) top intent, any zone
 *   names: companion / player names allowed after the head noun
 * @returns {{ status: 'none'|'supported'|'unsupported', phrase?: string,
 *   schematic?: string|null, reason?: string }}
 */
export function buildRequestContract(body, opts = {}) {
  const text = String(body || '').toLowerCase().replace(/[’`]/g, "'");
  if (!text.trim()) return { status: 'none' };
  if (SURVIVAL_INTENTS.has(opts.nlpIntent)) return { status: 'none' };
  if (isSpeculativeBuildDiscussion(text)) return { status: 'none' };
  if (/^\s*(?:how|why|what|when|where|who|which)\b/.test(text)) return { status: 'none' };
  const worldIntent = WORLD_BUILD_INTENTS.has(opts.nlpIntent);
  const names = new Set((opts.names || []).map((n) => String(n).toLowerCase()));

  const verbRe = /\b(build|construct|design|make|create|set up|put up)\b/g;
  let m;
  while ((m = verbRe.exec(text)) !== null) {
    const verb = m[1];
    if (SOFT_BUILD_VERBS.has(verb) && !worldIntent) continue;
    const clauseStart = Math.max(...[',', '.', ';', '!', '?'].map((c) => text.lastIndexOf(c, m.index)));
    const prefix = text.slice(clauseStart + 1, m.index);
    // "dont build a tower" / "i love when we build stuff" are not commands.
    if (NEGATION_RE.test(prefix) || SUBORDINATE_RE.test(prefix)) return { status: 'none' };

    const clause = text.slice(m.index + verb.length).split(/[?.!,;:()—–]|\s-\s/)[0];
    const tokens = clause.split(/\s+/).filter(Boolean).map(normalizeToken).filter(Boolean);
    let i = 0;
    if (tokens[i] === 'for' && (tokens[i + 1] === 'me' || tokens[i + 1] === 'us')) i += 2;
    while (i < tokens.length && DETERMINERS.has(tokens[i])) i += 1;
    if (OBJECT_PRONOUNS.has(tokens[i])) return { status: 'none' };

    const object = [];
    const ofWords = [];
    const withWords = [];
    let mode = 'object';
    for (; i < tokens.length; i += 1) {
      const t = tokens[i];
      if (PLEASE_RE.test(t)) break;
      if (t === 'with' && mode !== 'with') { mode = 'with'; continue; }
      if (t === 'of' && mode === 'object') { mode = 'of'; continue; }
      if (mode === 'with' && SUBJECT_PRONOUNS.has(t)) break;
      if (mode === 'with' && t === 'and') continue; // "with windows and a door"
      if (BOUNDARY_WORDS.has(t)) break;
      if (mode === 'object') object.push(t);
      else if (mode === 'of') ofWords.push(t);
      else withWords.push(t);
    }
    // Trailing filler / names do not count toward the structure.
    while (object.length && (TRAILING_WORDS.has(object[object.length - 1]) || names.has(object[object.length - 1]))) {
      object.pop();
    }
    if (object.length === 0) return { status: 'none' };
    if (object.some((t) => FILLER_RE.test(t))) return { status: 'none' };
    if (NON_NAMING_HEADS.has(object[object.length - 1])) return { status: 'none' };
    // "build another", "build 10 tall": no structure named; the normal router decides.
    if (object.every((t) => isSizeOrStyle(t))) return { status: 'none' };

    const phrase = [
      ...object,
      ...(ofWords.length ? ['of', ...ofWords] : []),
      ...(withWords.length ? ['with', ...withWords] : []),
    ].join(' ');

    // The head is the rightmost one- or two-word span that names a library entry.
    let headStart = -1;
    let headEnd = -1;
    let schematic = null;
    for (let end = object.length; end > 0 && headStart < 0; end -= 1) {
      for (const len of [2, 1]) {
        const start = end - len;
        if (start < 0) continue;
        const entry = headEntry(object.slice(start, end));
        if (entry) {
          headStart = start;
          headEnd = end;
          schematic = entry === 'capability' ? null : entry;
          break;
        }
      }
    }
    if (headStart < 0) return { status: 'unsupported', phrase, reason: 'not_in_library' };

    const isModifier = (t) => isSizeOrStyle(t) || CATALOG_WORDS.has(t) || DETERMINERS.has(t);
    const badBefore = object.slice(0, headStart).find((t) => !isModifier(t));
    if (badBefore) return { status: 'unsupported', phrase, reason: `modifier:${badBefore}` };
    const badAfter = object.slice(headEnd).find((t) => !isSizeOrStyle(t) && !names.has(t)
      && !PLACEHOLDER_NOUNS.has(t) && !FEATURE_WORDS.has(t));
    if (badAfter) return { status: 'unsupported', phrase, reason: `trailing:${badAfter}` };
    const badOf = ofWords.find((t) => !isModifier(t));
    if (badOf) return { status: 'unsupported', phrase, reason: `of:${badOf}` };
    const badWith = withWords.find((t) => !FEATURE_WORDS.has(t) && !isModifier(t) && !TRAILING_WORDS.has(t));
    if (badWith) return { status: 'unsupported', phrase, reason: `feature:${badWith}` };
    return { status: 'supported', phrase, schematic };
  }
  return { status: 'none' };
}

const LIBRARY_OFFER = 'a house, treehouse, tower, garden, well, igloo, ice castle, campfire spot, '
  + 'hotel, wizard tower, observatory, market square, sky bridge or beacon plaza';

/** Kid-facing refusal for an unsupported build request. */
export function unsupportedBuildReply(contract) {
  const phrase = String(contract?.phrase || 'that')
    .replace(/[^a-z0-9 '-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim() || 'that';
  const article = /^[aeiou]/.test(phrase) ? 'an' : 'a';
  return `I can't build ${article} ${phrase} yet. I can build ${LIBRARY_OFFER}.`;
}
