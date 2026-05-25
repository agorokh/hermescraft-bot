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

test('non-building task verbs block pure movement fast path', () => {
  assert.equal(hasWorldMutationImperative('come here and cook food'), true);
  assert.equal(hasWorldMutationImperative('follow me and feed me'), true);
});

test('negated task clauses do not hide later positive task clauses', () => {
  assert.equal(hasWorldMutationImperative("come here and don't build, then cook food"), true);
});

test('combat imperatives are detected in mixed movement requests', () => {
  assert.equal(hasCombatImperative('come here and kill this zombie'), true);
});

test('bare attack verbs are combat imperatives', () => {
  assert.equal(hasCombatImperative('come here and fight'), true);
  assert.equal(hasCombatImperative('come here and attack'), true);
});

test('negated attack verbs are not combat imperatives', () => {
  assert.equal(hasCombatImperative("come here and don't fight"), false);
  assert.equal(hasCombatImperative('come here and no attack'), false);
});

test('negated combat clauses do not hide later positive combat clauses', () => {
  assert.equal(hasCombatImperative("come here and don't fight me, fight the zombie"), true);
});

test('casual get-it phrasing is not combat without a hostile target', () => {
  assert.equal(hasCombatImperative('come here and get it'), false);
});

test('get phrasing is combat when it names a hostile target', () => {
  assert.equal(hasCombatImperative('come here and get the zombie'), true);
});

test('save-it phrasing is not combat without a hostile or player target', () => {
  assert.equal(hasCombatImperative('come here and save it'), false);
  assert.equal(hasCombatImperative('come here and protect it'), false);
});

test('defend-me phrasing is combat even without a named hostile', () => {
  assert.equal(hasCombatImperative('come here and defend me'), true);
});
