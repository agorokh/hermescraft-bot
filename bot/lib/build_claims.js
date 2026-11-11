// Experimental fixed-corpus claim check (hermescraft#545). English lexical
// coverage is intentionally bounded; this is not a general truth checker.
// No phrase exceptions may be added after the experiment corpus is frozen.
import { Vec3 } from 'vec3';
import { blockReadbackMatches } from './advanced_build_pipeline.js';
import { actionOutcomeFailed } from './action_outcome.js';

export function readBuildResult(bot, expected) {
  let placed = 0, unverified = 0;
  const cells = [...new Map(expected.cells.map(c => [`${c.x},${c.y},${c.z}`, c])).values()];
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
const DETERMINERS = new Set("the a an my our your his her their this that these those rosie's steve's".split(' '));
const SHAPES = /\b(wall|tower|cottage|house|schematic)\b/gi;

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
        && !DETERMINERS.has(token) && !/^(to|if|when|because|which|who|only)$/.test(token)));
  });
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
      } else if (subjectPhrase(fragment, true) || pending.length) pending.push(fragment);
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
      const ratios = [...local.matchAll(/\b(\d+)\s*(?:of|\/)\s*(\d+)\b/g)];
      const quantifiedAction = /^(?:got|placed|built|made|put up)\s+\d+\s*(?:of|\/)\s*\d+\b/.test(local);
      claims.push({ span, ratios, completion: !quantifiedAction });
    }
  }
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
  for (const clause of chain.reverse()) {
    let own = directProofObligations(clause.text, speaker);
    // Predicate-only coordination inherits arguments, never auxiliary scope,
    // result status or ratios. Explicit subjects start a separate obligation.
    if (inherited && !actorNames(clause.text, speaker).length) {
      const shapes = [...clause.text.matchAll(SHAPES)].map(match => match[1]);
      own = shapes.length
        ? [...new Set(inherited.map(item => item.actor))].flatMap(actor => shapes.map(shape => ({ actor, shape })))
        : inherited;
    }
    inherited = own;
  }
  return inherited;
}

export function isBuildClaim(message) { return propositions(message).length > 0; }

export function checkBuildClaim(message, speaker, records) {
  const claims = propositions(message);
  if (!claims.length) return { allow: true, claim: false, reason: 'no-result-claim' };
  for (const claim of claims) {
    const obligations = proofObligations(claim.span, speaker);
    const evidence = obligations.map(item => records[item.actor]);
    if (evidence.some(r => !r || r.unverified || !r.total)) {
      return { allow: false, claim: true, reason: 'missing-or-unverified-result' };
    }
    if (obligations.some((item, i) => item.shape && evidence[i].shape !== item.shape)) {
      return { allow: false, claim: true, reason: 'different-build' };
    }
    if (claim.ratios.length) {
      const actors = new Set(obligations.map(item => item.actor));
      if (actors.size !== 1 || claim.ratios.some(ratio => evidence.some(r => r.placed !== Number(ratio[1]) || r.total !== Number(ratio[2])))) {
        return { allow: false, claim: true, reason: 'count-mismatch' };
      }
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
