// Sky-claim guard (agorokh/hermescraft#592, finding 2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SKY_CLAIM_REFUSAL, claimsUnderground, refuseSkyClaim } from '../lib/chat_sky_claim.js';

// Lines the brains really sent on open grass at Y -60 (2026-11-19 .. 11-26),
// plus close variants.
const CLAIMS = [
  "we're at spawn! y=-60 deep underground but it's daytime up top. not dark here",
  "we're at bedrock level, y=-60! its daytime above but dark down here",
  'Deep underground at -2,-60,-65 with Rosie',
  "we're underground at y -60",
  'I am deep underground right now',
  'y: -60, so we are underground',
  "it's dark down here",
  'down here it gets pretty dark',
  "we're in a cave near spawn",
  'underground here, want torches?',
];

// Lines that must still go out under open sky.
const FINE = [
  'bright and sunny! open sky at -2,-60,-65. grass all around.',
  'on the surface! open sky, not dark at all… flat world at y-60',
  "we're at the flat grass world near 0,-60,-63 - bright afternoon, not dark!",
  'open sky, not underground — the ground here is just at y -60',
  "we're going to mine underground later",
  "i'm gonna dig underground for iron",
  'found a coal vein deep underground at 1657,59,1709',
  'there is a cave deep underground somewhere east',
  'we were in a cave earlier, now we are on grass',
  'what should we build first?',
  'is it dark here? nope, sunny!',
  'I was just there! must be underground or something, I only see grass',
];

test('the live underground lines are claims', () => {
  for (const line of CLAIMS) assert.equal(claimsUnderground(line), true, line);
});

test('plans, finds, past events and denials are not claims', () => {
  for (const line of FINE) assert.equal(claimsUnderground(line), false, line);
});

test('a claim is refused only while the body reads open sky', () => {
  const line = CLAIMS[0];
  assert.deepEqual(refuseSkyClaim(line, 'open'), { result: SKY_CLAIM_REFUSAL, refused: true });
  for (const sky of ['underground', 'covered', 'unknown', undefined]) {
    assert.equal(refuseSkyClaim(line, sky), null, String(sky));
  }
  assert.equal(refuseSkyClaim(FINE[0], 'open'), null);
});

test('the refusal says nothing was sent and what to say instead', () => {
  assert.match(SKY_CLAIM_REFUSAL, /open sky/);
  assert.match(SKY_CLAIM_REFUSAL, /Y -60 is ground level/);
  assert.match(SKY_CLAIM_REFUSAL, /Say where you are from the Sky line/);
  assert.match(SKY_CLAIM_REFUSAL, /Nothing was sent\.$/);
});

test('the public-chat check reads the body sky before the repeat guard', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = server.indexOf('function refusePublicChat(message, fromRouter) {');
  assert.ok(start > 0);
  const body = server.slice(start, server.indexOf('\n}\n', start));
  const exempt = body.indexOf("if (fromRouter === true || String(message).trimStart().startsWith('/')) return null;");
  const sky = body.indexOf('sky = skyAboveBot()');
  const claim = body.indexOf('refuseSkyClaim(message, sky)');
  const repeat = body.indexOf('chatRepeatGuard.check(message)');
  assert.ok(exempt >= 0 && exempt < sky && sky < claim && claim < repeat);
});
