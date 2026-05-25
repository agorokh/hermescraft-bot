// Tests for terrain-aware schematic grounding — the fix for "tower splitting in
// halves" / "build floating mid-air" symptoms.
//
// Verifies:
//   1. computeFloorCells returns only dy=0 cells with a real block
//   2. sampleFootprintGround scans every floor cell, not just a 5-cell cone
//   3. generateFoundation fills gaps under the build to ground it
//   4. Foundation respects maxFillDepth (no thousand-block fills over caves)
//   5. Foundation skipped for cells already supported (ground == baseY-1)

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFloorCells,
  sampleFootprintGround,
  generateFoundation,
} from '../lib/advanced_build_pipeline.js';

// ── computeFloorCells ────────────────────────────────────────────────────────

test('computeFloorCells extracts only dy=0 cells with non-air blocks', () => {
  const blocks = [
    [0, 0, 0, 'stone_bricks'],   // floor
    [1, 0, 0, 'stone_bricks'],   // floor
    [0, 1, 0, 'stone_bricks'],   // wall
    [2, 0, 0, 'air'],            // air at floor — should skip
    [0, 0, 1, 'cave_air'],       // air at floor — should skip
    [3, 5, 0, 'glass_pane'],     // upper — not floor
    [1, 0, 0, 'oak_planks'],     // duplicate floor cell — should dedupe
  ];
  const cells = computeFloorCells(blocks);
  const keys = cells.map((c) => `${c.dx},${c.dz}`).sort();
  // Expected: 0,0 (stone_bricks), 1,0 (stone_bricks; oak_planks dedup'd).
  // Skipped: 0,1,0 dy=1 (wall); 2,0,0 air; 0,0,1 cave_air; 3,5,0 dy=5.
  assert.deepEqual(keys, ['0,0', '1,0']);
  assert.equal(cells.length, 2);
});

test('computeFloorCells returns empty for schematic with no floor blocks', () => {
  const blocks = [[0, 2, 0, 'stone_bricks']];   // floats — no floor
  const cells = computeFloorCells(blocks);
  assert.deepEqual(cells, []);
});

// ── sampleFootprintGround ────────────────────────────────────────────────────

function makeBlockAtFlat(groundY, blockName = 'grass_block') {
  return (_x, y, _z) => {
    if (y <= groundY) return { name: blockName, boundingBox: 'block' };
    return { name: 'air', boundingBox: 'empty' };
  };
}

function makeBlockAtSloped(groundFn) {
  return (x, y, z) => {
    const gy = groundFn(x, z);
    if (y <= gy) return { name: 'grass_block', boundingBox: 'block' };
    return { name: 'air', boundingBox: 'empty' };
  };
}

function isSolid(block) {
  if (!block || block.boundingBox !== 'block') return false;
  return !['air', 'cave_air', 'void_air', 'water', 'lava'].includes(block.name);
}

test('sampleFootprintGround samples every floor cell on flat ground', () => {
  const floorCells = [
    { dx: 0, dz: 0 },
    { dx: 1, dz: 0 },
    { dx: 2, dz: 0 },
    { dx: 0, dz: 1 },
    { dx: 0, dz: 2 },
    { dx: 3, dz: 1 },
    { dx: 4, dz: 2 },
  ];
  const out = sampleFootprintGround({
    blockAt: makeBlockAtFlat(64),
    floorCells,
    baseX: 100,
    baseZ: 200,
    searchTopY: 80,
    searchBottomY: 40,
    isSolidGroundBlock: isSolid,
  });
  assert.equal(out.sampledCells, floorCells.length);
  assert.equal(out.maxGroundY, 64);
  assert.equal(out.minGroundY, 64);
  assert.deepEqual(out.missingCells, []);
  assert.equal(out.groundMap.get('0,0'), 64);
  assert.equal(out.groundMap.get('2,0'), 64);
});

test('sampleFootprintGround rejects invalid scan ranges', () => {
  assert.throws(() => sampleFootprintGround({
    blockAt: makeBlockAtFlat(64),
    floorCells: [{ dx: 0, dz: 0 }],
    baseX: 0,
    baseZ: 0,
    searchTopY: Number.NaN,
    searchBottomY: 40,
    isSolidGroundBlock: isSolid,
  }), /finite searchTopY/);

  assert.throws(() => sampleFootprintGround({
    blockAt: makeBlockAtFlat(64),
    floorCells: [{ dx: 0, dz: 0 }],
    baseX: 0,
    baseZ: 0,
    searchTopY: 40,
    searchBottomY: 80,
    isSolidGroundBlock: isSolid,
  }), /searchTopY must be >= searchBottomY/);
});

test('sampleFootprintGround captures slope spread', () => {
  // Slope: ground rises from y=60 at dx=0 to y=70 at dx=10
  const floorCells = [
    { dx: 0, dz: 0 },
    { dx: 5, dz: 0 },
    { dx: 10, dz: 0 },
  ];
  const out = sampleFootprintGround({
    blockAt: makeBlockAtSloped((wx, wz) => 60 + Math.floor((wx - 100) / 1)),
    floorCells,
    baseX: 100,
    baseZ: 200,
    searchTopY: 80,
    searchBottomY: 40,
    isSolidGroundBlock: isSolid,
  });
  assert.equal(out.sampledCells, 3);
  // maxGround at dx=10 → world x=110 → y=70
  assert.equal(out.maxGroundY, 70);
  assert.equal(out.minGroundY, 60);
  // 10-block spread on a slope — this is the "split tower" scenario.
});

test('sampleFootprintGround skips water/leaves/air, finds solid below', () => {
  const blockAt = (_x, y, _z) => {
    if (y === 64) return { name: 'water', boundingBox: 'block' };       // pretend water
    if (y === 63) return { name: 'oak_leaves', boundingBox: 'block' };  // leaves above
    if (y <= 62) return { name: 'dirt', boundingBox: 'block' };
    return { name: 'air', boundingBox: 'empty' };
  };
  // isSolid here uses the same predicate as production (excludes leaves/water).
  const isSolidProd = (block) => {
    if (!block || block.boundingBox !== 'block') return false;
    const bn = block.name || '';
    if (['air', 'cave_air', 'void_air', 'water', 'lava'].includes(bn)) return false;
    if (bn.endsWith('_leaves')) return false;
    return true;
  };
  const out = sampleFootprintGround({
    blockAt,
    floorCells: [{ dx: 0, dz: 0 }],
    baseX: 0, baseZ: 0,
    searchTopY: 80, searchBottomY: 40,
    isSolidGroundBlock: isSolidProd,
  });
  assert.equal(out.maxGroundY, 62);   // skipped water + leaves, found dirt
});

test('sampleFootprintGround tracks missing cells when no ground in range', () => {
  const floorCells = [
    { dx: 0, dz: 0 },
    { dx: 1, dz: 0 },
  ];
  const out = sampleFootprintGround({
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),   // nothing solid
    floorCells,
    baseX: 0, baseZ: 0,
    searchTopY: 80, searchBottomY: 40,
    isSolidGroundBlock: isSolid,
  });
  assert.equal(out.sampledCells, 0);
  assert.equal(out.maxGroundY, null);
  assert.deepEqual(out.missingCells.sort(), ['0,0', '1,0']);
});

// ── generateFoundation ───────────────────────────────────────────────────────

test('generateFoundation produces zero placements when ground == baseY-1', () => {
  // Build at baseY=65, ground at y=64 → already supported, no fill needed.
  const floorCells = [{ dx: 0, dz: 0 }, { dx: 1, dz: 0 }];
  const groundMap = new Map([['0,0', 64], ['1,0', 64]]);
  const { placements, stats } = generateFoundation({
    floorCells, groundMap,
    baseX: 100, baseY: 65, baseZ: 200,
    fillBlock: 'stone',
  });
  assert.equal(placements.length, 0);
  assert.equal(stats.blocksAdded, 0);
});

test('generateFoundation fills 1 cell gap', () => {
  // Build at baseY=65, ground at y=62 → fill y=63, y=64 with stone.
  const floorCells = [{ dx: 0, dz: 0 }];
  const groundMap = new Map([['0,0', 62]]);
  const { placements, stats } = generateFoundation({
    floorCells, groundMap,
    baseX: 100, baseY: 65, baseZ: 200,
    fillBlock: 'stone',
  });
  assert.equal(placements.length, 2);
  assert.equal(stats.blocksAdded, 2);
  assert.equal(stats.cellsFilled, 1);
  assert.equal(stats.maxDepth, 2);
  // Coords
  const ys = placements.map((p) => p.y).sort();
  assert.deepEqual(ys, [63, 64]);
  // Block name + coords XZ
  for (const p of placements) {
    assert.equal(p.block, 'stone');
    assert.equal(p.x, 100);
    assert.equal(p.z, 200);
    assert.equal(p.foundation, true);
  }
});

test('generateFoundation handles slope — uneven fill depths per cell', () => {
  // Schematic floor at baseY=70. Ground varies per cell.
  const floorCells = [
    { dx: 0, dz: 0 },   // ground at 60 → fill 9 blocks (61..69)
    { dx: 1, dz: 0 },   // ground at 65 → fill 4 blocks (66..69)
    { dx: 2, dz: 0 },   // ground at 69 → fill 0 blocks (already supported)
  ];
  const groundMap = new Map([['0,0', 60], ['1,0', 65], ['2,0', 69]]);
  const { placements, stats } = generateFoundation({
    floorCells, groundMap,
    baseX: 0, baseY: 70, baseZ: 0,
    fillBlock: 'stone',
  });
  assert.equal(stats.cellsFilled, 2);          // only cells where ground < baseY-1
  assert.equal(stats.blocksAdded, 9 + 4);
  assert.equal(stats.maxDepth, 9);
  // Verify cell 2,0 was NOT filled
  const cellTwoFills = placements.filter((p) => p.dx === 2);
  assert.equal(cellTwoFills.length, 0);
});

test('generateFoundation caps depth at maxFillDepth', () => {
  // 50-block gap, cap at 16
  const floorCells = [{ dx: 0, dz: 0 }];
  const groundMap = new Map([['0,0', 10]]);
  const { placements, stats } = generateFoundation({
    floorCells, groundMap,
    baseX: 0, baseY: 70, baseZ: 0,
    fillBlock: 'stone',
    maxFillDepth: 16,
  });
  assert.equal(placements.length, 16);
  assert.equal(stats.capped, 1);
  // Fill from baseY-16 (54) to baseY-1 (69)
  const ys = placements.map((p) => p.y);
  assert.equal(Math.min(...ys), 54);
  assert.equal(Math.max(...ys), 69);
});

test('generateFoundation skips fill when maxFillDepth is not positive', () => {
  const { placements, stats } = generateFoundation({
    floorCells: [{ dx: 0, dz: 0 }],
    groundMap: new Map([['0,0', 60]]),
    baseX: 0,
    baseY: 70,
    baseZ: 0,
    fillBlock: 'stone',
    maxFillDepth: 0,
  });
  assert.deepEqual(placements, []);
  assert.equal(stats.cellsFilled, 0);
  assert.equal(stats.blocksAdded, 0);
});

test('generateFoundation skips cells without ground sample', () => {
  const floorCells = [
    { dx: 0, dz: 0 },
    { dx: 1, dz: 0 },
  ];
  // Only cell 0,0 has ground info
  const groundMap = new Map([['0,0', 60]]);
  const { placements } = generateFoundation({
    floorCells, groundMap,
    baseX: 0, baseY: 65, baseZ: 0,
    fillBlock: 'stone',
  });
  // Only cell 0,0 gets fill (4 blocks: 61..64)
  assert.equal(placements.length, 4);
  for (const p of placements) {
    assert.equal(p.dx, 0);
  }
});
