import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const schematicsDir = join(__dirname, '..', 'bot', 'schematics');
const indexFile = join(schematicsDir, 'INDEX.json');

function makeBuilder() {
  const set = new Map();
  return {
    put(dx, dy, dz, block) {
      set.set(`${dx},${dy},${dz}`, [dx, dy, dz, block]);
    },
    line(x1, x2, y, z, block) {
      for (let x = x1; x <= x2; x++) this.put(x, y, z, block);
    },
    zline(x, y, z1, z2, block) {
      for (let z = z1; z <= z2; z++) this.put(x, y, z, block);
    },
    rect(x1, x2, z1, z2, y, block) {
      for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) this.put(x, y, z, block);
    },
    hollowRect(x1, x2, z1, z2, y, block) {
      for (let x = x1; x <= x2; x++) {
        this.put(x, y, z1, block);
        this.put(x, y, z2, block);
      }
      for (let z = z1 + 1; z <= z2 - 1; z++) {
        this.put(x1, y, z, block);
        this.put(x2, y, z, block);
      }
    },
    circle(cx, cz, y, radius, block) {
      const r2 = radius * radius;
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
        for (let z = Math.floor(cz - radius); z <= Math.ceil(cz + radius); z++) {
          const d2 = (x - cx) ** 2 + (z - cz) ** 2;
          if (d2 <= r2) this.put(x, y, z, block);
        }
      }
    },
    ring(cx, cz, y, outer, inner, block) {
      const outer2 = outer * outer;
      const inner2 = inner * inner;
      for (let x = Math.floor(cx - outer); x <= Math.ceil(cx + outer); x++) {
        for (let z = Math.floor(cz - outer); z <= Math.ceil(cz + outer); z++) {
          const d2 = (x - cx) ** 2 + (z - cz) ** 2;
          if (d2 <= outer2 && d2 >= inner2) this.put(x, y, z, block);
        }
      }
    },
    blocks() {
      return [...set.values()].sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);
    },
  };
}

function materialsFor(blocks) {
  const materials = {};
  for (const [, , , block] of blocks) materials[block] = (materials[block] || 0) + 1;
  return materials;
}

function payload(name, footprint, height, summary, buildFn) {
  const b = makeBuilder();
  buildFn(b);
  const blocks = b.blocks();
  return {
    name,
    file: `${name}.json`,
    footprint,
    height,
    summary,
    data: {
      schema_version: 1,
      name,
      footprint,
      height,
      materials: materialsFor(blocks),
      blocks,
    },
  };
}

const gallery = [
  payload(
    'crystal_observatory',
    [11, 11],
    11,
    '11x11 crystal observatory with amethyst pylons, glass dome, glowstone telescope floor, and dark tile base',
    (b) => {
      b.circle(5, 5, 0, 5, 'deepslate_tiles');
      b.ring(5, 5, 1, 5, 4, 'quartz_block');
      b.circle(5, 5, 1, 3, 'amethyst_block');
      for (const [x, z] of [[1, 1], [1, 9], [9, 1], [9, 9]]) {
        for (let y = 1; y <= 8; y++) b.put(x, y, z, y % 3 === 0 ? 'glowstone' : 'amethyst_block');
      }
      for (let y = 2; y <= 6; y++) {
        b.ring(5, 5, y, 5, 4.2, y === 4 ? 'glass' : 'glass_pane');
      }
      b.circle(5, 5, 7, 4, 'glass');
      b.circle(5, 5, 8, 3, 'glass');
      b.circle(5, 5, 9, 2, 'glass');
      b.put(5, 10, 5, 'glowstone');
      b.zline(5, 2, 2, 8, 'oak_fence');
      b.line(2, 8, 2, 5, 'oak_fence');
      for (const [x, z] of [[5, 2], [8, 5], [5, 8], [2, 5]]) b.put(x, 3, z, 'glowstone');
    },
  ),
  payload(
    'wizard_tower',
    [9, 9],
    16,
    '9x9 wizard tower with stone-brick shaft, windows, balcony, purple roof, and torch-lit battlements',
    (b) => {
      b.circle(4, 4, 0, 4, 'stone_bricks');
      for (let y = 1; y <= 11; y++) {
        b.ring(4, 4, y, 4, 3, y % 4 === 0 ? 'mossy_stone_bricks' : 'stone_bricks');
        if ([3, 6, 9].includes(y)) {
          b.put(4, y, 0, 'glass_pane');
          b.put(4, y, 8, 'glass_pane');
          b.put(0, y, 4, 'glass_pane');
          b.put(8, y, 4, 'glass_pane');
        }
      }
      b.circle(4, 4, 12, 5, 'spruce_planks');
      b.ring(4, 4, 13, 5, 4.2, 'spruce_fence');
      b.circle(4, 4, 13, 4, 'purple_wool');
      b.circle(4, 4, 14, 3, 'purple_wool');
      b.circle(4, 4, 15, 1, 'glowstone');
      for (const [x, z] of [[2, 2], [2, 6], [6, 2], [6, 6]]) b.put(x, 13, z, 'torch');
    },
  ),
  payload(
    'market_square',
    [15, 15],
    5,
    '15x15 village market square with four colorful stalls, barrel counters, lanterns, and a central path cross',
    (b) => {
      b.rect(0, 14, 0, 14, 0, 'stone');
      for (let i = 0; i < 15; i++) {
        b.put(7, 1, i, 'oak_planks');
        b.put(i, 1, 7, 'oak_planks');
      }
      const stalls = [
        [1, 1, 'red_wool'],
        [9, 1, 'blue_wool'],
        [1, 9, 'yellow_wool'],
        [9, 9, 'green_wool'],
      ];
      for (const [sx, sz, wool] of stalls) {
        b.rect(sx, sx + 4, sz, sz + 4, 1, 'oak_planks');
        for (const [x, z] of [[sx, sz], [sx + 4, sz], [sx, sz + 4], [sx + 4, sz + 4]]) {
          b.put(x, 2, z, 'oak_fence');
          b.put(x, 3, z, 'oak_fence');
        }
        b.rect(sx - 1, sx + 5, sz - 1, sz + 5, 4, wool);
        b.line(sx + 1, sx + 3, 2, sz + 1, 'barrel');
        b.put(sx + 2, 3, sz + 2, 'lantern');
      }
      for (const [x, z] of [[7, 7], [7, 0], [7, 14], [0, 7], [14, 7]]) b.put(x, 2, z, 'lantern');
    },
  ),
  payload(
    'sky_bridge',
    [17, 5],
    7,
    '17x5 raised oak-and-cobblestone sky bridge with railings, arch supports, and torch markers',
    (b) => {
      for (let x = 0; x < 17; x++) {
        const arch = x < 5 ? Math.floor(x / 2) : x > 11 ? Math.floor((16 - x) / 2) : 2;
        for (let z = 0; z < 5; z++) b.put(x, 2 + arch, z, z === 2 ? 'oak_planks' : 'cobblestone');
        b.put(x, 3 + arch, 0, 'oak_fence');
        b.put(x, 3 + arch, 4, 'oak_fence');
        if (x % 4 === 0) {
          b.put(x, 4 + arch, 0, 'torch');
          b.put(x, 4 + arch, 4, 'torch');
        }
      }
      for (const x of [0, 4, 8, 12, 16]) {
        for (let y = 0; y <= 2; y++) {
          b.put(x, y, 0, 'cobblestone');
          b.put(x, y, 4, 'cobblestone');
        }
      }
    },
  ),
  payload(
    'beacon_plaza',
    [13, 13],
    6,
    '13x13 bright beacon plaza with quartz rings, sea-lantern corners, and a raised central beacon pedestal',
    (b) => {
      b.circle(6, 6, 0, 6, 'polished_andesite');
      b.ring(6, 6, 1, 6, 5, 'quartz_block');
      b.ring(6, 6, 1, 4, 3, 'sea_lantern');
      b.circle(6, 6, 1, 2, 'quartz_block');
      b.circle(6, 6, 2, 1, 'amethyst_block');
      b.put(6, 3, 6, 'beacon');
      for (const [x, z] of [[1, 1], [1, 11], [11, 1], [11, 11]]) {
        for (let y = 1; y <= 5; y++) b.put(x, y, z, y === 5 ? 'glowstone' : 'quartz_block');
      }
      for (const [x, z] of [[6, 0], [12, 6], [6, 12], [0, 6]]) {
        b.put(x, 2, z, 'lantern');
      }
    },
  ),
];

await mkdir(schematicsDir, { recursive: true });
const index = JSON.parse(await readFile(indexFile, 'utf8'));
for (const item of gallery) {
  await writeFile(join(schematicsDir, item.file), `${JSON.stringify(item.data, null, 2)}\n`, 'utf8');
  index.schematics[item.name] = {
    file: item.file,
    footprint: item.footprint,
    height: item.height,
    summary: item.summary,
    materials: item.data.materials,
  };
}
await writeFile(indexFile, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
for (const item of gallery) {
  console.log(`wrote ${item.file}: ${item.data.blocks.length} blocks`);
}
