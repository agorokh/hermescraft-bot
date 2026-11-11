// Experimental fixed-corpus claim check (hermescraft#545). English lexical
// coverage is intentionally bounded; this is not a general truth checker.
// No phrase exceptions may be added after the experiment corpus is frozen.
import { Vec3 } from 'vec3';
import { blockReadbackMatches } from './advanced_build_pipeline.js';
import { actionOutcomeFailed } from './action_outcome.js';

export function readBuildResult(bot, expected) {
  let placed = 0, unverified = 0;
  const canonical = expected.cells.map(c => ({ ...c, x: Math.floor(c.x), y: Math.floor(c.y), z: Math.floor(c.z) }));
  const cells = [...new Map(canonical.map(c => [`${c.x},${c.y},${c.z}`, c])).values()];
  for (const c of cells) {
    const actual = bot.blockAt(new Vec3(c.x, c.y, c.z));
    const match = blockReadbackMatches(c.block, actual);
    if (match === true) placed++;
    else if (match == null) unverified++;
  }
  return { ...expected, cells, placed, unverified, checked_at: Date.now() };
}

export function buildStatus(r) {
  const label = r.kid_name ? ` For "${r.kid_name}".` : '';
  if (r.total == null) return `I can verify ${r.placed} placed blocks, but cannot verify the whole build.` + label;
  return `I got ${r.placed} of ${r.total} ${r.shape} blocks down.`
    + (r.unverified ? ` I could not check ${r.unverified} cells.` : '') + label;
}

const OBJECT = /\b(wall|tower|cottage|house|schematic|build|blocks?)\b/i;
const RESULT = /\b(built|placed|put up|made|done|finished|completed|complete|ready)\b|\bgot\b(?=[\s\S]*\bdown\b)/i;
// This is a conservative grammar, not a general English semantic parser.
// Only a direct subject + auxiliary verb group can establish non-realis or
// negative scope. Embedded/unknown syntax must still obtain world proof.
const AUXILIARIES = new Set('am is are was were be been being have has had do does did will shall would could can may might must should not never yet'.split(' '));
const FUTURE_AUXILIARIES = new Set('will shall'.split(' '));
const PRONOUN_SUBJECTS = new Set('i we you he she it they rosie steve'.split(' '));
// Recognizing subject syntax does not resolve a builder's identity. There is
// no discourse/group ledger for the other personal or collective pronouns.
const RESOLVED_ACTOR_SUBJECTS = new Set('i rosie steve'.split(' '));
const DETERMINERS = new Set("the a an my our your his her their this that these those rosie's steve's".split(' '));
const SHAPES = /\b(wall|tower|cottage|house|schematic)\b/gi;
const NUMBER_WORDS = Object.fromEntries('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ').map((word, i) => [word, i]));
Object.assign(NUMBER_WORDS, { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 });
const ONES = 'one|two|three|four|five|six|seven|eight|nine';
const NUMBER = `(?:\\d+|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[ -](?:${ONES}))?|${Object.keys(NUMBER_WORDS).join('|')})`;
const numericValue = value => /^\d+$/.test(value) ? Number(value) : value.split(/[ -]+/).reduce((sum, word) => sum + NUMBER_WORDS[word], 0);

function normalizedSpeech(message) {
  return String(message || '').toLowerCase().replace(/[’‘]/g, "'")
    .replace(/\bcannot\b/g, 'can not').replace(/\bcan't\b/g, 'can not')
    .replace(/\bwon't\b/g, 'will not').replace(/\b([a-z]+)n't\b/g, '$1 not');
}

function words(text) { return text.match(/[a-z]+(?:'[a-z]+)?|\d+(?:-[a-z]+)?/g) || []; }

function subjectPhrase(text, descriptors = false) {
  return text.split(/\band\b/).every(part => {
    const tokens = words(part);
    if (!tokens.length) return false;
    if (tokens.length === 1 && PRONOUN_SUBJECTS.has(tokens[0])) return true;
    if (DETERMINERS.has(tokens[0])) tokens.shift();
    const noun = tokens.pop();
    if (!/^(wall|tower|cottage|house|schematic|build|blocks?)$/.test(noun || '')) return false;
    // Only closed subject forms can waive proof. Unknown lexical modifiers
    // may be predicates/embeddings, so they cannot establish negative scope.
    return tokens.every(token => /^\d+(?:-blocks?|-tall)?$/.test(token)
      || (descriptors && !PRONOUN_SUBJECTS.has(token) && !AUXILIARIES.has(token)
        && !DETERMINERS.has(token) && !token.endsWith("'s") && !/^(to|if|when|because|which|who|only)$/.test(token)));
  });
}

function independentNonResult(text) {
  const tokens = words(text);
  if (!PRONOUN_SUBJECTS.has(tokens.shift())) return false;
  let auxiliaries = 0;
  while (tokens.length && AUXILIARIES.has(tokens[0])) { tokens.shift(); auxiliaries++; }
  if (tokens[0] === 'want' && tokens[1] === 'to') { tokens.splice(0, 2); auxiliaries++; }
  if (tokens[0] === 'going' && tokens[1] === 'to') { tokens.splice(0, 2); auxiliaries++; }
  return auxiliaries > 0 && tokens.length > 0 && !PRONOUN_SUBJECTS.has(tokens[0]) && !DETERMINERS.has(tokens[0]);
}

function coveredSubject(prefix) {
  const tokens = words(prefix);
  while (AUXILIARIES.has(tokens.at(-1)) || ['just', 'already', 'now'].includes(tokens.at(-1))) tokens.pop();
  if (!tokens.length || (tokens.length === 1 && tokens[0] === 'all')) return true;
  if (subjectPhrase(tokens.join(' '), true)) {
    return tokens.join(' ').split(/\band\b/).every(part => {
      const subject = words(part);
      // A determiner+noun is an object subject, not a claim about who built
      // it. Only bare actor subjects need a resolved personal identity here.
      return subject.length !== 1 || !PRONOUN_SUBJECTS.has(subject[0])
        || RESOLVED_ACTOR_SUBJECTS.has(subject[0]);
    });
  }
  // A fronted imperative object may have a relative actor subject. Its object
  // and subject are explicit; an arbitrary unknown actor cannot use this form.
  if (tokens[0] === 'go' && RESOLVED_ACTOR_SUBJECTS.has(tokens.at(-1))) {
    return subjectPhrase(tokens.slice(2, -1).join(' '), true);
  }
  return false;
}

function quantityArguments(text) {
  const ratios = [], counts = [], sizes = [], ranges = [];
  const range = match => [match.index, match.index + match[0].length];
  const overlaps = match => ranges.some(([start, end]) => match.index >= start && match.index < end);
  for (const match of text.matchAll(new RegExp(`\\b(${NUMBER})\\s*(?:of|/)\\s*(${NUMBER})\\b`, 'g'))) {
    ratios.push([numericValue(match[1]), numericValue(match[2])]); ranges.push(range(match));
  }
  for (const match of text.matchAll(new RegExp(`\\b(${NUMBER})[ -]+(?:blocks?|tall)(?:[ -]+[a-z_]+){0,3}[ -]+(?:wall|tower|cottage|house|schematic)\\b`, 'g'))) {
    if (!overlaps(match)) { sizes.push(numericValue(match[1])); ranges.push(range(match)); }
  }
  for (const match of text.matchAll(new RegExp(`\\b(${NUMBER})((?:[ -]+[a-z_]+){0,3})[ -]+blocks?\\b`, 'g'))) {
    if (!overlaps(match)) {
      // Unit modifiers must also be covered. An unknown modifier may itself
      // be a cardinal multiplier, so treating it as decoration is unsafe.
      if (words(match[2]).some(word => !/^(wall|tower|cottage|house|schematic)$/.test(word))) return { invalid: true };
      counts.push(numericValue(match[1])); ranges.push(range(match));
      if (/\ball\s*$/.test(text.slice(0, match.index))) sizes.push(numericValue(match[1]));
    }
  }
  // A number outside a recognized quantity slot is unresolved, never ignored.
  for (const match of text.matchAll(/\b(?:\d+|[a-z]+)\b/g)) {
    if ((/^\d+$/.test(match[0]) || match[0] in NUMBER_WORDS || /^(hundred|thousand|million)$/.test(match[0])) && !overlaps(match)) return { invalid: true };
  }
  for (const match of text.matchAll(/\bblocks?\b/g)) {
    if (overlaps(match)) continue;
    if (ranges.some(([, end]) => end <= match.index && !text.slice(end, match.index).trim())) continue;
    const prefix = words(text.slice(0, match.index)).at(-1);
    if (prefix && !/^(the|my|our|your|his|her|their|these|those|all|wall|tower|cottage|house|schematic|placed|built|made)$/.test(prefix)) return { invalid: true };
  }
  return { ratios, counts, sizes, invalid: false };
}

function directNonResult(prefix) {
  const tokens = words(prefix);
  let start = tokens.length;
  while (start && AUXILIARIES.has(tokens[start - 1])) start--;
  const group = tokens.slice(start);
  const negatives = group.filter(token => token === 'not' || token === 'never');
  if (negatives.length > 1) return false;
  if (!negatives.length && !group.some(token => FUTURE_AUXILIARIES.has(token))) return false;
  const subject = tokens.slice(0, start).join(' ');
  return !subject || subjectPhrase(subject);
}

function propositions(message) {
  const spans = [];
  const uncovered = [];
  let prior = null;
  for (const sentence of normalizedSpeech(message).split(/[.!?;:\n—]+|\b(?:but|so|or|however|although|while|whereas)\b/)) {
    let pending = [];
    const coordinated = [];
    for (const fragment of sentence.split(/,|\band\b/).map(s => s.trim()).filter(Boolean)) {
      if (RESULT.test(fragment)) {
        const startsPredicate = new RegExp(RESULT.source, 'i').exec(fragment)?.index === 0;
        const context = !pending.length && (startsPredicate || AUXILIARIES.has(words(fragment)[0]))
          ? coordinated.at(-1) || prior : null;
        coordinated.push({ text: [...pending, fragment].join(' and '), context });
        pending = [];
      } else if (subjectPhrase(fragment, true)) pending.push(fragment);
      else if (!independentNonResult(fragment)) uncovered.push(fragment);
    }
    // A trailing nominal conjunct shares the preceding result predicate.
    if (pending.length && coordinated.length) coordinated.at(-1).text += ` and ${pending.join(' and ')}`;
    spans.push(...coordinated);
    prior = coordinated.at(-1) || prior;
  }
  const claims = [];
  for (const span of spans) {
    const { text } = span;
    if (!OBJECT.test(text) && !/\b(all done|finished|completed)\b/.test(text) && !span.context) continue;
    const predicates = [...text.matchAll(new RegExp(RESULT.source, 'gi'))];
    for (let i = 0; i < predicates.length; i++) {
      const predicate = predicates[i];
      if (directNonResult(text.slice(0, predicate.index))) continue;
      // Counts belong to their own predicate, never to a neighboring result.
      const local = text.slice(predicate.index, predicates[i + 1]?.index ?? text.length);
      const quantities = quantityArguments(text);
      const quantifiedAction = /^(?:got|placed|built|made|put up)\b/.test(local)
        && ((quantities.ratios?.length || quantities.counts?.length) > 0);
      claims.push({ span, ...quantities, invalid: quantities.invalid || !coveredSubject(text.slice(0, predicate.index)), completion: !quantifiedAction });
    }
  }
  if (claims.length && uncovered.length) claims.push({ invalid: true });
  return claims;
}

function actorNames(text, speaker) {
  return [...new Set([...text.matchAll(/\b(rosie|steve|i|my|we|our)\b/g)].map(match => {
    if (match[1] === 'rosie') return 'Rosie';
    if (match[1] === 'steve') return 'Steve';
    return speaker;
  }))];
}

function directProofObligations(text, speaker) {
  const obligations = [];
  let actors = [speaker], end = 0;
  const shapes = [...text.matchAll(SHAPES)];
  for (const shape of shapes) {
    const explicit = actorNames(text.slice(end, shape.index), speaker);
    if (explicit.length) actors = explicit;
    for (const actor of actors) obligations.push({ actor, shape: shape[1] });
    end = shape.index + shape[0].length;
  }
  if (!shapes.length) return (actorNames(text, speaker).length ? actorNames(text, speaker) : [speaker])
    .map(actor => ({ actor, shape: null }));
  // Postnominal actor subjects ("the tower Steve made") also require proof.
  for (const actor of actorNames(text.slice(end), speaker)) {
    if (!obligations.some(item => item.actor === actor)) obligations.push({ actor, shape: shapes.at(-1)[1] });
  }
  return obligations;
}

function proofObligations(span, speaker) {
  const chain = [];
  for (let cursor = span; cursor; cursor = cursor.context) chain.push(cursor);
  let inherited = null;
  let collective = false;
  for (const clause of chain.reverse()) {
    let own = directProofObligations(clause.text, speaker);
    // Predicate-only coordination inherits arguments, never auxiliary scope,
    // result status or ratios. Explicit subjects start a separate obligation.
    const explicit = actorNames(clause.text, speaker);
    if (inherited && !explicit.length) {
      const shapes = [...clause.text.matchAll(SHAPES)].map(match => match[1]);
      own = shapes.length
        ? [...new Set(inherited.map(item => item.actor))].flatMap(actor => shapes.map(shape => ({ actor, shape })))
        : inherited;
    } else {
      // Independent verb clauses were split earlier; retained coordination is
      // nominal number, even when participant aliases collapse to one body.
      collective = /\b(we|our|and)\b/.test(clause.text);
    }
    inherited = own;
  }
  return { obligations: inherited, collective };
}

export function isBuildClaim(message) { return propositions(message).length > 0; }

export function checkBuildClaim(message, speaker, records) {
  const claims = propositions(message);
  if (!claims.length) return { allow: true, claim: false, reason: 'no-result-claim' };
  for (const claim of claims) {
    if (claim.invalid) return { allow: false, claim: true, reason: 'unparsed-claim-arguments' };
    const { obligations, collective } = proofObligations(claim.span, speaker);
    const evidence = obligations.map(item => records[item.actor]);
    if (evidence.some(r => !r || r.unverified || !r.total)) {
      return { allow: false, claim: true, reason: 'missing-or-unverified-result' };
    }
    if (obligations.some((item, i) => item.shape && evidence[i].shape !== item.shape)) {
      return { allow: false, claim: true, reason: 'different-build' };
    }
    // Readback counts belong to individual bodies. No aggregate/distributive
    // ledger exists, so every kind of quantity needs one singular actor.
    const quantified = claim.ratios.length || claim.counts.length || claim.sizes.length;
    const actors = new Set(obligations.map(item => item.actor));
    if (quantified && (actors.size !== 1 || collective)) {
      return { allow: false, claim: true, reason: 'ambiguous-collective-quantity' };
    }
    if (claim.ratios.length) {
      if (claim.ratios.some(ratio => evidence.some(r => r.placed !== ratio[0] || r.total !== ratio[1]))) {
        return { allow: false, claim: true, reason: 'count-mismatch' };
      }
    }
    if (claim.counts.some(count => evidence.some(r => r.placed !== count)) || claim.sizes.some(size => evidence.some(r => r.total !== size))) {
      return { allow: false, claim: true, reason: 'count-mismatch' };
    }
    if (claim.completion && evidence.some(r => r.placed !== r.total)) {
      return { allow: false, claim: true, reason: 'incomplete-build' };
    }
  }
  return { allow: true, claim: true, reason: 'verified-propositions' };
}

// Keep one in-memory result per body. Free placements in one queue request are
// grouped by request id, not by time proximity. Unknown request size remains
// unknown rather than turning a successful one-block action into a whole wall.
function normalizeBuildInput(action, body) {
  if ([body.x, body.y, body.z].some(value => value == null)) return null;
  const normalized = { ...body, x: Number(body.x), y: Number(body.y), z: Number(body.z) };
  if (![normalized.x, normalized.y, normalized.z].every(Number.isFinite)) return null;
  for (const axis of ['x', 'y', 'z']) normalized[axis] = Math.floor(normalized[axis]);
  if (action === 'build_tower') {
    // Match the native skill's undefined-only default and Math.floor coercion.
    normalized.height = Number(body.height === undefined ? 5 : body.height);
    if (!Number.isFinite(normalized.height)) return null;
  }
  return normalized;
}

export function expectedBuild(action, body, request, previous) {
  body = normalizeBuildInput(action, body);
  if (!body) return null;
  if (action === 'place') {
    const count = String(request?.command || '').match(/\b(\d+)[ -]?(?:blocks?|tall)\b/i);
    const same = request?.id != null && previous?.request_id === request.id;
    return { actor: previous?.actor, request_id: request?.id,
      shape: /\btower\b/i.test(request?.command || '') ? 'tower' : 'wall',
      total: count ? Number(count[1]) : null,
      cells: [...(same ? previous.cells : []), { x: body.x, y: body.y, z: body.z, block: body.block }] };
  }
  if (action === 'build_tower') {
    const total = Math.max(1, Math.min(20, Math.floor(body.height)));
    return { shape: 'tower', total, cells: Array.from({ length: total }, (_, i) =>
      ({ x: Math.floor(body.x), y: Math.floor(body.y) + i, z: Math.floor(body.z), block: body.material || 'oak_planks' })) };
  }
  return null;
}

export function cleanKidBuildName(value) {
  const clean = String(value || '')
    .replace(/[`"'<>/\\{}[\]|$;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > 80 ? clean.slice(0, 80).trim() : clean;
}

// Only an explicit queue identity can bind independent place actions to a build.
export function resolveBuildRequest(queue, body = {}) {
  const raw = body.request_id ?? body.in_reply_to;
  const id = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (!Number.isSafeInteger(id)) return null;
  return queue.find(request => request.id === id) || null;
}

export function parseBuildClaimPeers(value, warn = () => {}) {
  try {
    const peers = JSON.parse(value || '{}');
    if (!peers || typeof peers !== 'object' || Array.isArray(peers)) throw new Error('invalid peers');
    return peers;
  } catch {
    warn('[build-claims] Invalid HERMESCRAFT_BUILD_CLAIM_PEERS; peer evidence disabled.');
    return {};
  }
}

export function installBuildClaimExperiment(actions, ensureBot, { actor, getRequest, peers = {} }) {
  let last = null;
  const read = () => last ? readBuildResult(ensureBot(), last) : null;
  for (const action of ['place', 'build_tower']) {
    const current = actions[action];
    if (!current) continue;
    const original = current._buildClaimOriginal || current;
    const wrapped = async body => {
      const normalized = normalizeBuildInput(action, body);
      if (!normalized) {
        // The native tower validates missing coordinates before any mutation.
        if (action === 'build_tower' && [body.x, body.y, body.z].some(value => value == null)) return original(body);
        return { error: 'Build readback needs finite numeric coordinates and height.' };
      }
      // Vec3 preserves strings and its offsets concatenate them. Execute the
      // same numeric coordinates used by the evidence plan for both actions.
      body = normalized;
      const request = getRequest(body);
      // Clear evidence for a new build before awaiting its outcome: a concurrent
      // chat must not vouch for the preceding successful request.
      const previous = last;
      const known = expectedBuild(action, body, request, previous);
      // An invalid body is validation work, not a new build. Preserve the
      // existing evidence and let the original action report its validation.
      if (!known) return original(body);
      const kidName = cleanKidBuildName(body.kid_name);
      const expected = { ...known, actor, ...(kidName ? { kid_name: kidName } : {}) };
      last = expected;
      let result;
      try { result = await original(body); }
      catch (error) {
        result = { error: error.message };
      }
      // Record identity is the generation token. An older completion reads
      // only its own cells and cannot restore or announce superseded work.
      const superseded = last !== expected;
      const verified = readBuildResult(ensureBot(), expected);
      const failed = actionOutcomeFailed(result, { allowPartialPlacement: true });
      // Validation/skill failures still need their original presentation. A
      // readback record alone does not mean this wrapper announced anything.
      if (failed && verified.placed === 0) return { ...result, build_readback: verified,
        ...(superseded ? { build_claim_superseded: true } : {}) };
      const line = buildStatus(verified);
      if (!superseded) ensureBot().chat(line);
      return { ...result, result: `${line} (${verified.placed}/${verified.total ?? '?'})`,
        ...(failed ? { error: result.error || result.result,
          build_failure_cause: result.error || result.result } : {}),
        build_readback: verified,
        ...(superseded ? { build_claim_superseded: true } : { build_claim_announced: true }) };
    };
    wrapped._buildClaimOriginal = original;
    actions[action] = wrapped;
  }
  const currentChat = actions.chat;
  const originalChat = currentChat._buildClaimOriginal || currentChat;
  const wrappedChat = async body => {
    if (isBuildClaim(body.message)) {
      const records = { [actor]: read() };
      for (const name of ['Rosie', 'Steve']) {
        if (name === actor || !new RegExp(`\\b${name}\\b`, 'i').test(body.message)) continue;
        // Experiment configuration permits only loopback body endpoints. There
        // is no arbitrary URL or credential-bearing fetch from model input.
        try {
          const url = new URL('/build-result', peers[name]);
          if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:') continue;
          const response = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'error' });
          if (response.ok) {
            const record = (await response.json()).data;
            if (record?.actor === name) records[name] = record;
          }
        } catch { /* missing peer evidence fails closed below */ }
      }
      const decision = checkBuildClaim(body.message, actor, records);
      if (!decision.allow) {
        const error = new Error(`Build claim suppressed: ${decision.reason}`);
        error.statusCode = 409;
        throw error;
      }
    }
    return originalChat(body);
  };
  wrappedChat._buildClaimOriginal = originalChat;
  actions.chat = wrappedChat;
  return read;
}
