// Sky-claim guard (agorokh/hermescraft#592, finding 2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { claimsUnderground, refuseSkyClaim, skyClaimRefusal } from '../lib/chat_sky_claim.js';

// Lines the brains really sent on open grass at Y -60 (2026-11-19 .. 11-26),
// plus close variants and present-tense activity.
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
  'i am mining underground',
  'i am digging in a cave',
  'we are looking underground',
  "no kids online, we're deep underground",
];

// Lines that must still go out under open sky.
const FINE = [
  'bright and sunny! open sky at -2,-60,-65. grass all around.',
  'on the surface! open sky, not dark at all… flat world at y-60',
  "we're at the flat grass world near 0,-60,-63 - bright afternoon, not dark!",
  'open sky, not underground — the ground here is just at y -60',
  "we're going to mine underground later",
  "i'm gonna dig underground for iron",
  "let's dig underground here",
  "don't go underground here, it's dark down there",
  'maybe we tunnel underground right now?',
  'found a coal vein deep underground at 1657,59,1709',
  'there is a cave deep underground somewhere east',
  'we were in a cave earlier, now we are on grass',
  'what should we build first?',
  'is it dark here? nope, sunny!',
  'I was just there! must be underground or something, I only see grass',
];

test('the live underground lines and present-tense activity are claims', () => {
  for (const line of CLAIMS) assert.equal(claimsUnderground(line), true, line);
});

test('plans, warnings, finds, past events and denials are not claims', () => {
  for (const line of FINE) assert.equal(claimsUnderground(line), false, line);
});

test('a claim is refused only while the body reads open sky', () => {
  const line = CLAIMS[0];
  const refused = refuseSkyClaim(line, { sky: 'open', y: -60, isDay: true });
  assert.equal(refused.refused, true);
  assert.equal(refused.result, skyClaimRefusal({ y: -60, isDay: true }));
  for (const sky of ['underground', 'covered', 'unknown', undefined]) {
    assert.equal(refuseSkyClaim(line, { sky, y: -60, isDay: true }), null, String(sky));
  }
  assert.equal(refuseSkyClaim(FINE[0], { sky: 'open', y: -60, isDay: true }), null);
});

test('the refusal states only the time and height the body reads', () => {
  const studioNoon = skyClaimRefusal({ y: -60.2, isDay: true });
  assert.match(studioNoon, /open sky/);
  assert.match(studioNoon, /in daylight\./);
  assert.match(studioNoon, /A low Y like -61 is ground level/);
  assert.match(studioNoon, /Say where you are from the Sky line\. Nothing was sent\.$/);

  const night = skyClaimRefusal({ y: 70, isDay: false });
  assert.match(night, /at night, under the stars\./);
  assert.doesNotMatch(night, /daylight|Y -60|low Y/);

  const unknown = skyClaimRefusal({});
  assert.doesNotMatch(unknown, /daylight|night|Y/);
  assert.match(unknown, /Nothing was sent\.$/);
});

test('the public-chat check reads the body sky before the repeat guard', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = server.indexOf('function refusePublicChat(message, fromRouter) {');
  assert.ok(start > 0);
  const body = server.slice(start, server.indexOf('\n}\n', start));
  const exempt = body.indexOf("if (fromRouter === true || String(message).trimStart().startsWith('/')) return null;");
  const sky = body.indexOf('here.sky = skyAboveBot(b)');
  const y = body.indexOf('here.y = b.entity.position.y');
  const day = body.indexOf('here.isDay = b.time.timeOfDay < 12000');
  const claim = body.indexOf('refuseSkyClaim(message, here)');
  const repeat = body.indexOf('chatRepeatGuard.check(message)');
  assert.ok(exempt >= 0 && exempt < sky && sky < claim && y < claim && day < claim && claim < repeat);
});
