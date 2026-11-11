import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkBuildClaim, isBuildClaim } from '../lib/build_claims.js';

const record = (actor, shape, placed, total = 4) => ({ actor, shape, placed, total, unverified: 0 });
const incomplete = { Rosie: record('Rosie', 'wall', 0), Steve: record('Steve', 'tower', 0) };

test('unrelated future and negative clauses cannot authorize an unsupported affirmative proposition', () => {
  const claims = ['The wall is done', 'I built the wall', 'Rosie finished the wall', 'All done'];
  const unrelated = ['I will add flowers', 'I cannot find torches', 'I could not reach Steve',
    'I want to decorate later', 'I am going to look around', 'I will build a tower', 'I could not start the tower'];
  const connectors = ['. ', '; ', ', ', ' and ', ' but ', ' so ', ' or ', ': ', ' — ', '\n'];
  for (const claim of claims) for (const other of unrelated) for (const separator of connectors) {
    for (const message of [`${claim}${separator}${other}`, `${other}${separator}${claim}`]) {
      assert.equal(checkBuildClaim(message, 'Rosie', incomplete).allow, false, message);
      assert.equal(checkBuildClaim(message, 'Rosie', { Rosie: record('Rosie', 'wall', 4) }).allow, true,
        `unrelated clauses cannot add another actor's proof obligation: ${message}`);
    }
  }
});

test('attitude and speech predicates do not transfer their polarity or future to an embedded completion', () => {
  for (const frame of ['I cannot deny that', 'I did not say that', "I don't think that",
    'I will tell you that', 'I want you to know that', "I don't doubt that"]) {
    const message = `${frame} the wall is finished.`;
    assert.equal(checkBuildClaim(message, 'Rosie', incomplete).allow, false, message);
  }
  for (const message of ['The wall is not not finished.', 'The wall is not just finished.',
    'The wall must already be finished.', 'The child doubts the wall is not finished.',
    'The child doubts wall is not finished.']) {
    assert.equal(checkBuildClaim(message, 'Rosie', incomplete).allow, false, message);
  }
});

test('direct denial and prospective verb groups remain non-result speech', () => {
  for (const message of ['The wall is not done.', 'The tower has not been completed.',
    'I have not built the wall.', 'Rosie did not put up the wall.', 'The wall is not yet finished.',
    'My 4-block wall is not finished.',
    'The wall will be finished tomorrow.', 'I will have built the wall tomorrow.',
    'I will build a wall with you next.', 'I could not finish the tower.']) {
    assert.equal(checkBuildClaim(message, 'Rosie', incomplete).allow, true, message);
    assert.equal(isBuildClaim(message), false, message);
  }
});

test('each actor/build proposition needs its own proof while neighboring denials remain harmless', () => {
  const records = { Rosie: record('Rosie', 'wall', 4), Steve: record('Steve', 'tower', 0) };
  assert.equal(checkBuildClaim("My wall is done, but Steve's tower is not finished.", 'Rosie', records).allow, true);
  assert.equal(checkBuildClaim("My wall is not done, but Steve's tower is finished.", 'Rosie', records).allow, false);
  assert.equal(checkBuildClaim("My wall and Steve's tower are finished.", 'Rosie', records).allow, false);
  const swapped = { Rosie: record('Rosie', 'tower', 4), Steve: record('Steve', 'wall', 4) };
  assert.equal(checkBuildClaim("My wall and Steve's tower are finished.", 'Rosie', swapped).allow, false);
  assert.equal(checkBuildClaim("My stone wall and Steve's tower are finished.", 'Rosie',
    { Rosie: incomplete.Rosie, Steve: record('Steve', 'tower', 4) }).allow, false);
  assert.equal(checkBuildClaim("My wall, Steve's tower are finished.", 'Rosie',
    { Rosie: incomplete.Rosie, Steve: record('Steve', 'tower', 4) }).allow, false);
});

test('a verified partial-count proposition cannot authorize a separate completion predicate', () => {
  const records = { Rosie: record('Rosie', 'wall', 2) };
  for (const message of ['I got 2 of 4 wall blocks down and the wall is done.',
    'I got 2 of 4 wall blocks down, which is finished.',
    'I got 2 of 4 wall blocks down; all done.', 'The wall is done (2 of 4).',
    'I got 2 of 4 wall is finished blocks down.', 'I got 2 of 4 wall blocks down (4/4).']) {
    assert.equal(checkBuildClaim(message, 'Rosie', records).allow, false, message);
  }
  assert.equal(checkBuildClaim('The wall is not done, and I got 2 of 4 wall blocks down.', 'Rosie', records).allow, true);
  assert.equal(checkBuildClaim('I placed 2 of 4 wall blocks.', 'Rosie', records).allow, true);
  const mixed = { ...records, Steve: record('Steve', 'tower', 4) };
  assert.equal(checkBuildClaim("Steve's tower is finished and I got 2 of 4 wall blocks down.", 'Rosie', mixed).allow, true);
  assert.equal(checkBuildClaim('I got 2 of 4 wall blocks down and Steve got 4 of 4 tower blocks down.', 'Rosie', mixed).allow, true);
  assert.equal(checkBuildClaim('I got 2 of 4 wall blocks down and Steve got 2 of 4 tower blocks down.', 'Rosie', mixed).allow, false);
});

test('predicate-only coordination inherits its subject arguments but never polarity or counts', () => {
  const records = { Rosie: record('Rosie', 'wall', 2), Steve: record('Steve', 'tower', 4) };
  assert.equal(checkBuildClaim('Steve finished the tower and placed 2 of 4 blocks.', 'Rosie', records).allow, false);
  assert.equal(checkBuildClaim('Steve finished the tower and placed 4 of 4 blocks.', 'Rosie', records).allow, true);
  assert.equal(checkBuildClaim('My wall is not finished but complete.', 'Rosie', records).allow, false);
  assert.equal(checkBuildClaim('My wall is not finished and completed.', 'Rosie', records).allow, false);
  assert.equal(checkBuildClaim('My wall is not finished and is complete.', 'Rosie', records).allow, false);
  assert.equal(checkBuildClaim('I got 2 of 4 wall blocks down and finished.', 'Rosie', records).allow, false);
});

test('quantity arguments bind on both sides of action predicates and cannot be ignored', () => {
  const records = { Steve: record('Steve', 'wall', 10, 10) };
  for (const n of [1, 5, 9, 11, 20]) {
    for (const message of [`${n} of 10 wall blocks are placed.`, `I placed ${n} of 10 wall blocks.`,
      `${n} wall blocks are placed.`, `I placed ${n} blocks.`, `I built a ${n}-block wall.`]) {
      assert.equal(checkBuildClaim(message, 'Steve', records).allow, false, message);
    }
  }
  for (const message of ['10 of 10 wall blocks are placed.', 'I placed 10 of 10 wall blocks.',
    '10 wall blocks are placed.', 'I placed ten blocks.', 'I built a 10-block wall.']) {
    assert.equal(checkBuildClaim(message, 'Steve', records).allow, true, message);
  }
  assert.equal(checkBuildClaim('I placed all four blocks of the wall.', 'Steve', records).allow, false);
  assert.equal(checkBuildClaim('5 of 10 wall blocks are placed.', 'Steve',
    { Steve: record('Steve', 'wall', 5, 10) }).allow, true);
  for (const message of ['I placed a dozen blocks.', 'I placed two dozen blocks.',
    'I placed one hundred blocks.', 'A block is placed.']) {
    assert.equal(checkBuildClaim(message, 'Steve', records).allow, false, `uncovered cardinality: ${message}`);
  }
});

test('unresolved participants and result ellipses cannot disappear during segmentation', () => {
  const records = { Steve: record('Steve', 'wall', 10, 10) };
  for (const participant of ['Rosie', 'Alex', 'Taylor']) {
    for (const fragment of [`${participant} the tower`, `${participant} too`, `so did ${participant}`]) {
      for (const join of [', ', ' and ', '; ']) {
        const message = `I built the wall${join}${fragment}.`;
        assert.equal(checkBuildClaim(message, 'Steve', records).allow, false, message);
      }
    }
    for (const message of [`${participant} finished the wall.`, `${participant}'s wall is done.`]) {
      assert.equal(checkBuildClaim(message, 'Steve', records).allow, false, message);
    }
  }
});

test('all frozen forty body decisions retain their labeled truth without editing the corpus', () => {
  const { cases } = JSON.parse(readFileSync(new URL('./fixtures/build_claims_cases.json', import.meta.url), 'utf8'));
  const byId = new Map(cases.map(c => [c.id, c]));
  for (const c of cases) {
    const records = {};
    for (const source of [c.kind === 'scripted' ? c : byId.get(c.source_case), byId.get(c.second_source)]) {
      if (source) records[source.actor] = record(source.actor, source.shape, source.forced, source.total);
    }
    assert.equal(checkBuildClaim(c.candidate, c.actor, records).allow, c.truth, c.id);
  }
});
