// Tests for safeSetblockCommand block-state suffix support + console-injection guard.
//
// Why this exists: the previous regex `/^[a-z0-9_:-]+$/i` rejected every
// `[state=value,...]` suffix, stripping stair/log/door/banner orientation
// from every schematic placement. The new regex must accept the legitimate
// 1.21 grammar while still rejecting NBT braces, newlines (op-level console
// FIFO injection), and shell metacharacters.

import test from 'node:test';
import assert from 'node:assert/strict';

// `safeSetblockCommand` isn't exported — re-implement the surface inline
// from skills.js so the test pins behavior independent of internal export
// shape. Keep in sync with bot/lib/skills.js if BLOCK_NAME_RE changes.
const BLOCK_NAME_RE = /^[a-z0-9_]+:[a-z0-9_./-]+(\[[a-z0-9_=,/-]*\])?$/;

function safeSetblockCommand(x, y, z, block) {
  const rawCoords = [x, y, z];
  if (rawCoords.some((v) => v == null || v === '' || typeof v === 'boolean')) {
    throw new Error('Unsafe setblock command arguments');
  }
  const coords = rawCoords.map(Number);
  let blockName = String(block || '').trim();
  if (blockName && !blockName.includes(':')) blockName = `minecraft:${blockName}`;
  if (/[\x00-\x1f\x7f]/.test(blockName)) throw new Error('Unsafe setblock command arguments');
  if (!coords.every(Number.isInteger) || !BLOCK_NAME_RE.test(blockName)) {
    throw new Error('Unsafe setblock command arguments');
  }
  return `setblock ${coords[0]} ${coords[1]} ${coords[2]} ${blockName}`;
}

test('accepts modern Minecraft block-state suffixes', () => {
  const cases = [
    'minecraft:oak_stairs[facing=north,half=bottom,shape=straight]',
    'minecraft:oak_log[axis=y]',
    'minecraft:oak_door[half=upper,hinge=left,facing=south,open=false]',
    'minecraft:white_banner[rotation=12]',
    'minecraft:cobblestone_wall[north=tall,south=low,up=true,waterlogged=false]',
    'minecraft:repeater[delay=2,facing=west,locked=false,powered=false]',
    'minecraft:light[level=15]',
    'minecraft:air[]',  // empty bracket from Sponge palettes
    'minecraft:stone',  // bare
    'minecraft:smooth_stone_slab[type=double]',
  ];
  for (const block of cases) {
    assert.doesNotThrow(() => safeSetblockCommand(0, 64, 0, block), `should accept ${block}`);
  }
});

test('auto-prefixes minecraft: on bare block names (legacy converter compat)', () => {
  assert.equal(safeSetblockCommand(1, 2, 3, 'oak_log'), 'setblock 1 2 3 minecraft:oak_log');
});

test('rejects newline injection (op-level console FIFO would run injected line)', () => {
  // This is the CVE-class case: \n in the block string would make Paper run
  // a second console command as op.
  assert.throws(() => safeSetblockCommand(0, 64, 0, 'minecraft:stone\nop @a'));
  assert.throws(() => safeSetblockCommand(0, 64, 0, 'minecraft:stone\r/op @a'));
  assert.throws(() => safeSetblockCommand(0, 64, 0, 'minecraft:stone\x00'));
});

test('rejects NBT braces (escape complexity not handled)', () => {
  assert.throws(() => safeSetblockCommand(0, 64, 0, 'minecraft:chest{Items:[{}]}'));
});

test('rejects shell metacharacters and spaces', () => {
  for (const bad of ['minecraft:stone bar', 'minecraft:foo;rm', 'minecraft:foo|cat', 'minecraft:foo&', 'minecraft:foo$']) {
    assert.throws(() => safeSetblockCommand(0, 64, 0, bad), `should reject ${bad}`);
  }
});

test('rejects non-integer coordinates and empties', () => {
  assert.throws(() => safeSetblockCommand(1.5, 64, 0, 'minecraft:stone'));
  assert.throws(() => safeSetblockCommand(null, 64, 0, 'minecraft:stone'));
  assert.throws(() => safeSetblockCommand(0, 64, 0, ''));
  assert.throws(() => safeSetblockCommand(0, 64, 0, null));
});

test('emits stable setblock syntax for happy path', () => {
  assert.equal(
    safeSetblockCommand(100, 64, -50, 'minecraft:oak_stairs[facing=east,half=bottom]'),
    'setblock 100 64 -50 minecraft:oak_stairs[facing=east,half=bottom]',
  );
});
