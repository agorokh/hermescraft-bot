import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const outFile = join(__dirname, '..', 'bot', 'schematics', 'grand_hotel.json');

const blocks = [];
const set = new Map();

function put(dx, dy, dz, block) {
  set.set(`${dx},${dy},${dz}`, [dx, dy, dz, block]);
}

const W = 13;
const L = 11;

// Foundation and floors.
for (let x = 0; x < W; x++) {
  for (let z = 0; z < L; z++) {
    put(x, 0, z, 'cobblestone');
    if (x > 0 && x < W - 1 && z > 0 && z < L - 1) put(x, 4, z, 'oak_planks');
  }
}

// Two hotel stories.
for (const y of [1, 2, 3, 5, 6, 7]) {
  for (let x = 0; x < W; x++) {
    for (let z = 0; z < L; z++) {
      const edge = x === 0 || x === W - 1 || z === 0 || z === L - 1;
      if (!edge) continue;
      const frontDoor = y <= 2 && z === 0 && (x === 6 || x === 7);
      const windowBay = (y === 2 || y === 6) && (
        (z === 0 && [2, 4, 9, 11].includes(x))
        || (z === L - 1 && [2, 4, 8, 10].includes(x))
        || (x === 0 && [2, 4, 7, 9].includes(z))
        || (x === W - 1 && [2, 4, 7, 9].includes(z))
      );
      if (frontDoor) continue;
      put(x, y, z, windowBay ? 'glass_pane' : 'oak_planks');
    }
  }
}

// Lobby divider and two upper-room dividers, with gaps for doorways.
for (let z = 2; z <= L - 3; z++) {
  if (z !== 5) {
    put(6, 1, z, 'oak_planks');
    put(6, 2, z, 'oak_planks');
    put(6, 5, z, 'oak_planks');
    put(6, 6, z, 'oak_planks');
  }
}
for (let x = 2; x <= W - 3; x++) {
  if (x !== 6) {
    put(x, 5, 5, 'oak_planks');
    put(x, 6, 5, 'oak_planks');
  }
}

// Corner columns and a raised roof line.
for (const [x, z] of [[0, 0], [0, L - 1], [W - 1, 0], [W - 1, L - 1]]) {
  for (let y = 1; y <= 8; y++) put(x, y, z, 'cobblestone');
}
for (let x = 0; x < W; x++) {
  for (let z = 0; z < L; z++) {
    const edge = x === 0 || x === W - 1 || z === 0 || z === L - 1;
    put(x, 8, z, edge ? 'cobblestone' : 'oak_planks');
  }
}

// Front balcony and roof railing.
for (let x = 3; x <= 9; x++) {
  put(x, 4, -1, 'oak_planks');
  put(x, 5, -1, 'oak_fence');
}
for (let x = 1; x < W - 1; x++) {
  put(x, 9, 0, 'oak_fence');
  put(x, 9, L - 1, 'oak_fence');
}
for (let z = 1; z < L - 1; z++) {
  put(0, 9, z, 'oak_fence');
  put(W - 1, 9, z, 'oak_fence');
}

// Warm visible lighting on interior floors (torch needs solid block below).
for (const [x, y, z] of [
  [3, 5, 2], [9, 5, 2], [3, 5, 8], [9, 5, 8],
  [3, 9, 2], [9, 9, 2], [3, 9, 8], [9, 9, 8],
  [6, 9, 5],
]) {
  put(x, y, z, 'torch');
}

for (const block of set.values()) blocks.push(block);
blocks.sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);

const materials = {};
for (const [, , , block] of blocks) materials[block] = (materials[block] || 0) + 1;

const payload = {
  schema_version: 1,
  name: 'grand_hotel',
  footprint: [13, 12],
  height: 10,
  materials,
  blocks,
};

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(`wrote ${outFile}: ${blocks.length} blocks`);
