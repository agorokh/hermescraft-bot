import test from 'node:test';
import assert from 'node:assert/strict';

import {
  configuredCompanionNames,
  isCompanionSpeaker,
} from '../lib/quests.js';

test('quest trigger filter treats household companions as non-human speakers', () => {
  const previous = process.env.HERMESCRAFT_COMPANION_NAMES;
  try {
    delete process.env.HERMESCRAFT_COMPANION_NAMES;
    assert.equal(isCompanionSpeaker('Rosie', 'Rosie'), true);
    assert.equal(isCompanionSpeaker('Steve', 'Rosie'), false);
    assert.equal(isCompanionSpeaker('GalleryKid', 'Rosie'), false);
    assert.equal(isCompanionSpeaker('.DanceO3677', 'Rosie'), false);
  } finally {
    if (previous === undefined) {
      delete process.env.HERMESCRAFT_COMPANION_NAMES;
    } else {
      process.env.HERMESCRAFT_COMPANION_NAMES = previous;
    }
  }
});

test('quest trigger filter honors configured companion roster', () => {
  const previous = process.env.HERMESCRAFT_COMPANION_NAMES;
  try {
    process.env.HERMESCRAFT_COMPANION_NAMES = 'Rosie, Steve, Natalie';
    assert.deepEqual([...configuredCompanionNames()].sort(), ['natalie', 'rosie', 'steve']);
    assert.equal(isCompanionSpeaker('Steve', 'Rosie'), true);
    assert.equal(isCompanionSpeaker('.Steve', 'Rosie'), true);
    assert.equal(isCompanionSpeaker('Natalie', 'Rosie'), true);
    assert.equal(isCompanionSpeaker('SwimmerJay1995', 'Rosie'), false);
  } finally {
    if (previous === undefined) {
      delete process.env.HERMESCRAFT_COMPANION_NAMES;
    } else {
      process.env.HERMESCRAFT_COMPANION_NAMES = previous;
    }
  }
});
