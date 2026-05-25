import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCombatImperative, hasWorldMutationImperative } from '../lib/movement_requests.js';

test('standalone no does not strip later build intent after comma', () => {
  assert.equal(hasWorldMutationImperative('come here, no, build a tower'), true);
});

test('negated build clauses are still ignored for movement requests', () => {
  assert.equal(hasWorldMutationImperative("don't build a tower, come here"), false);
});

test('comma-separated do-not lists stay negated', () => {
  assert.equal(hasWorldMutationImperative('come here, but do not place, dig, fill, build, or use items'), false);
});

test('combat imperatives are detected in mixed movement requests', () => {
  assert.equal(hasCombatImperative('come here and kill this zombie'), true);
});
