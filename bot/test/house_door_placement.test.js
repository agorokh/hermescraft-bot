import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { registerHighLevelSkills, safeSetblockCommand } from '../lib/skills.js';

const house = JSON.parse(await readFile(new URL('../schematics/small_house.json', import.meta.url)));
const index = JSON.parse(await readFile(new URL('../schematics/INDEX.json', import.meta.url)));
const lower = 'oak_door[half=lower,facing=south,hinge=left,open=false,powered=false]';
const upper = 'oak_door[half=upper,facing=south,hinge=left,open=false,powered=false]';

test('House contains supported matching door halves with no upper plank obstruction', () => {
  const at = (x, y, z) => house.blocks.find(b => b[0] === x && b[1] === y && b[2] === z)?.[3];
  assert.equal(house.blocks.length, 82);
  assert.equal(new Set(house.blocks.map(b => b.slice(0, 3).join(','))).size, 82);
  assert.equal(at(2, 0, 4), 'oak_planks');
  assert.equal(at(2, 1, 4), lower);
  assert.equal(at(2, 2, 4), upper);
  assert.equal(index.schematics.small_house.materials.oak_planks, 79);
  assert.equal(index.schematics.small_house.materials.oak_door, 1, 'one inventory door supplies both halves');
});

test('strict setblock mode stays a fixed command suffix rather than part of the block argument', () => {
  assert.equal(safeSetblockCommand(2, 65, 4, lower, { strict: true }), `setblock 2 65 4 minecraft:${lower} strict`);
  assert.throws(() => safeSetblockCommand(2, 65, 4, `${lower} strict\nop @a`, { strict: true }));
});

// Model the relevant neighbor/shape-update contract: an ordinary command
// removes orphan door halves, while strict commands preserve the state while
// the matching half is being assembled. The production Paper readback remains
// a separate live check; this fixture catches accidental ordering/mode changes.
class ShapeUpdatingWorld extends EventEmitter {
  constructor() {
    super();
    this.username = 'Rosie';
    this.entity = { position: { x: 0, y: 64, z: 0 } };
    this.inventory = { items: () => [] };
    this.blocks = new Map();
    this.commands = [];
  }
  blockAt(p) {
    const name = this.blocks.get(`${p.x},${p.y},${p.z}`);
    return name ? { name, boundingBox: 'block' }
      : p.y <= 63 ? { name: 'grass_block', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
  }
  chat(command) {
    this.commands.push(command);
    const m = command.match(/^\/setblock (-?\d+) (-?\d+) (-?\d+) (\S+)( strict)?$/);
    if (!m) return;
    const [, xRaw, yRaw, zRaw, rawBlock, strict] = m;
    const x = Number(xRaw), y = Number(yRaw), z = Number(zRaw);
    this.blocks.set(`${x},${y},${z}`, rawBlock.replace(/^minecraft:/, ''));
    if (!strict) {
      for (const [key, block] of this.blocks) {
        if (!block.startsWith('oak_door')) continue;
        const [dx, dy, dz] = key.split(',').map(Number);
        if (Math.abs(dx - x) + Math.abs(dy - y) + Math.abs(dz - z) > 1) continue;
        const half = /half=upper/.test(block) ? 'upper' : 'lower';
        const other = this.blocks.get(`${dx},${dy + (half === 'lower' ? 1 : -1)},${dz}`);
        if (!other?.startsWith('oak_door') || !other.includes(`half=${half === 'lower' ? 'upper' : 'lower'}`)) {
          this.blocks.delete(key);
        }
      }
    }
    queueMicrotask(() => this.emit('message', { toString: () => `Changed the block at ${x}, ${y}, ${z}` }, 'system'));
  }
}

test('House assembles both door halves after the surrounding structure, then survives a normal neighbor update', async () => {
  const trust = process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH;
  const fallback = process.env.HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK;
  process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH = '1';
  process.env.HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK = '1';
  try {
    const bot = new ShapeUpdatingWorld();
    const result = await registerHighLevelSkills({}, () => bot).build_schematic({ name: 'small_house', x: 10, y: 64, z: 10 });
    assert.match(result.result, /82\/82/);
    const doors = bot.commands.filter(c => c.includes('oak_door'));
    assert.equal(doors.length, 2);
    assert.ok(doors.every(c => c.endsWith(' strict')));
    assert.deepEqual(bot.commands.slice(-2), doors, 'no normal wall or roof command can update an orphan door half');
    assert.equal(bot.blocks.get('12,65,14'), lower);
    assert.equal(bot.blocks.get('12,66,14'), upper);
    bot.chat('/setblock 11 65 14 minecraft:oak_planks');
    assert.equal(bot.blocks.get('12,65,14'), lower);
    assert.equal(bot.blocks.get('12,66,14'), upper);
  } finally {
    if (trust == null) delete process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH;
    else process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH = trust;
    if (fallback == null) delete process.env.HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK;
    else process.env.HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK = fallback;
  }
});
