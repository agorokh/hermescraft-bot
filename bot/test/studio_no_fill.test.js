// No remote placement in a creative-studio session (agorokh/hermescraft#592).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { actionOutcomeFailed } from '../lib/action_outcome.js';
import { STUDIO_NO_REMOTE_PLACEMENT, studioSessionOn } from '../lib/studio_flight.js';

test('a studio session is the HERMESCRAFT_STUDIO_FLIGHT=1 the launcher sets', () => {
  assert.equal(studioSessionOn({ HERMESCRAFT_STUDIO_FLIGHT: '1' }), true);
  assert.equal(studioSessionOn({ HERMESCRAFT_STUDIO_FLIGHT: '0' }), false);
  assert.equal(studioSessionOn({}), false);
});

test('the refusal reads as a failure and tells the brain what to do instead', () => {
  assert.equal(actionOutcomeFailed({ result: STUDIO_NO_REMOTE_PLACEMENT }), true);
  assert.match(STUDIO_NO_REMOTE_PLACEMENT, /placed by hand/);
  assert.match(STUDIO_NO_REMOTE_PLACEMENT, /mc place/);
  assert.match(STUDIO_NO_REMOTE_PLACEMENT, /Nothing was placed\.$/);
});

test('place_fill refuses before it touches the body or sends /fill in a studio session', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = server.indexOf('async place_fill(');
  const body = server.slice(start, server.indexOf('\n  },', start));
  const guard = body.indexOf('if (studioSessionOn()) return { result: STUDIO_NO_REMOTE_PLACEMENT, refused: true };');
  assert.ok(guard > 0, 'the guard is in place_fill');
  assert.ok(guard < body.indexOf('ensureBot()'), 'before the body is touched');
  assert.ok(guard < body.indexOf('/fill '), 'before any /fill is built');
});
