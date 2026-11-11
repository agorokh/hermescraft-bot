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
const RESULT = /\b(built|placed|put up|made|done|finished|completed|complete|ready)\b|\bgot\b.*\bdown\b/i;
const FUTURE = /\b(will|want to|going to|let's)\b/i;
const NEGATIVE = /\b(could not|couldn't|can't|cannot|did not|didn't|not yet)\b/i;

export function isBuildClaim(message) {
  const text = String(message || '');
  if (FUTURE.test(text) || NEGATIVE.test(text)) return false;
  return RESULT.test(text) && (OBJECT.test(text) || /\b(all done|finished|completed)\b/i.test(text));
}

export function checkBuildClaim(message, speaker, records) {
  const text = String(message || '');
  if (!isBuildClaim(text)) return { allow: true, claim: false, reason: 'no-result-claim' };
  const named = ['Rosie', 'Steve'].filter(name => new RegExp(`\\b${name}\\b`, 'i').test(text));
  const actors = [...new Set([
    ...named,
    ...(!named.length || /\b(i|my|we|our)\b/i.test(text) ? [speaker] : []),
  ])];
  const evidence = actors.map(name => records[name]);
  if (evidence.some(r => !r || r.unverified || !r.total)) {
    return { allow: false, claim: true, reason: 'missing-or-unverified-result' };
  }
  const shapes = [...new Set((text.toLowerCase().match(/\b(wall|tower|cottage|house|schematic)\b/g) || []))];
  if (shapes.some(shape => !evidence.some(r => r.shape === shape))) {
    return { allow: false, claim: true, reason: 'different-build' };
  }
  const ratio = text.match(/\b(\d+)\s*(?:of|\/)\s*(\d+)\b/i);
  if (ratio) {
    const allow = evidence.length === 1 && evidence[0].placed === Number(ratio[1])
      && evidence[0].total === Number(ratio[2]);
    return { allow, claim: true, reason: allow ? 'verified-count' : 'count-mismatch' };
  }
  const allow = evidence.every(r => r.placed === r.total);
  return { allow, claim: true, reason: allow ? 'verified-completion' : 'incomplete-build' };
}

// Keep one in-memory result per body. Free placements in one queue request are
// grouped by request id, not by time proximity. Unknown request size remains
// unknown rather than turning a successful one-block action into a whole wall.
export function expectedBuild(action, body, request, previous) {
  if (![body.x, body.y, body.z].every(Number.isFinite)) return null;
  if (action === 'place') {
    const count = String(request?.command || '').match(/\b(\d+)[ -]?(?:blocks?|tall)\b/i);
    const same = request?.id != null && previous?.request_id === request.id;
    return { actor: previous?.actor, request_id: request?.id,
      shape: /\btower\b/i.test(request?.command || '') ? 'tower' : 'wall',
      total: count ? Number(count[1]) : null,
      cells: [...(same ? previous.cells : []), { x: body.x, y: body.y, z: body.z, block: body.block }] };
  }
  if (action === 'build_tower') {
    if (body.height != null && !Number.isFinite(body.height)) return null;
    const total = Math.max(1, Math.min(20, Math.floor(body.height ?? 5)));
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
