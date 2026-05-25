import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHighLevelSkills } from '../lib/skills.js';

test('advanced build actions are registered and Foreman rejects missing materials', async () => {
  const fakeBot = {
    inventory: {
      items: () => [{ name: 'cobblestone', count: 2 }],
    },
  };
  const actions = registerHighLevelSkills({}, () => fakeBot);

  assert.equal(typeof actions.plan_advanced_build, 'function');
  assert.equal(typeof actions.build_schematic_advanced, 'function');

  const result = await actions.plan_advanced_build({ name: 'well', x: 10, y: 64, z: 10 });
  assert.match(result.result, /Foreman rejected "well"/);
  assert.match(result.result, /cobblestone need 24, have 2/);
});

test('Foreman approves stocked grand_hotel plans', async () => {
  const fakeBot = {
    inventory: {
      items: () => [
        { name: 'cobblestone', count: 215 },
        { name: 'oak_planks', count: 449 },
        { name: 'glass_pane', count: 32 },
        { name: 'torch', count: 9 },
        { name: 'oak_fence', count: 47 },
      ],
    },
  };
  const actions = registerHighLevelSkills({}, () => fakeBot);

  const result = await actions.plan_advanced_build({ name: 'grand_hotel', x: 10, y: 64, z: 10 });
  assert.match(result.result, /Foreman approved "grand_hotel"/);
  assert.match(result.result, /752 blocks/);
  assert.match(result.result, /outside-footprint scaffold cells/);
});

test('trusted setblock auth bypasses survival material checks for op companions', async () => {
  const prior = process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH;
  process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH = '1';
  try {
    const fakeBot = {
      inventory: {
        items: () => [],
      },
    };
    const actions = registerHighLevelSkills({}, () => fakeBot);

    const result = await actions.plan_advanced_build({ name: 'grand_hotel', x: 10, y: 64, z: 10 });
    assert.match(result.result, /Foreman approved "grand_hotel"/);
    assert.doesNotMatch(result.result, /missing materials/);
  } finally {
    if (prior == null) {
      delete process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH;
    } else {
      process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH = prior;
    }
  }
});

test('setblock verification ignores unrelated generic command failures', async () => {
  const prior = process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH;
  const priorFallback = process.env.HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK;
  process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH = '1';
  process.env.HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK = '1';
  const blocks = new Map();
  class FakeBot extends EventEmitter {
    constructor() {
      super();
      this.inventory = { items: () => [] };
      this.entity = { position: { x: 0, y: 64, z: 0 } };
      this.username = 'Hermes';
      this._stopGeneration = 0;
    }

    chat(command) {
      const match = command.match(/^\/setblock\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)/);
      if (!match) return;
      const [, x, y, z, block] = match;
      queueMicrotask(() => {
        this.emit('message', { toString: () => 'Some unrelated task failed and is not allowed' }, 'system');
      });
      setTimeout(() => {
        blocks.set(`${x},${y},${z}`, block);
        this.emit('message', { toString: () => `Changed the block at ${x}, ${y}, ${z}` }, 'system');
      }, 5);
    }

    blockAt(pos) {
      return { name: blocks.get(`${pos.x},${pos.y},${pos.z}`) || 'air', boundingBox: 'empty' };
    }
  }

  try {
    const fakeBot = new FakeBot();
    const actions = registerHighLevelSkills({}, () => fakeBot);

    const result = await actions.build_schematic({ name: 'well', x: 10, y: 64, z: 10 });
    assert.match(result.result, /Built schematic "well"/);
  } finally {
    if (prior == null) {
      delete process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH;
    } else {
      process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH = prior;
    }
    if (priorFallback == null) {
      delete process.env.HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK;
    } else {
      process.env.HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK = priorFallback;
    }
  }
});

test('build_schematic grounds uneven terrain with foundation before schematic blocks', async () => {
  const prior = process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH;
  const priorFallback = process.env.HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK;
  process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH = '1';
  process.env.HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK = '1';
  const blocks = new Map();
  const commands = [];
  const terrainGroundY = (x, z) => {
    if (x === 10 && z === 10) return 67;
    return 62;
  };
  class FakeBot extends EventEmitter {
    constructor() {
      super();
      this.inventory = { items: () => [] };
      this.entity = { position: { x: 0, y: 64, z: 0 } };
      this.username = 'Hermes';
      this._stopGeneration = 0;
    }

    chat(command) {
      const match = command.match(/^\/setblock\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)/);
      if (!match) return;
      const [, xRaw, yRaw, zRaw, block] = match;
      const x = Number(xRaw);
      const y = Number(yRaw);
      const z = Number(zRaw);
      commands.push({ x, y, z, block });
      blocks.set(`${x},${y},${z}`, block);
      queueMicrotask(() => {
        this.emit('message', { toString: () => `Changed the block at ${x}, ${y}, ${z}` }, 'system');
      });
    }

    blockAt(pos) {
      const placed = blocks.get(`${pos.x},${pos.y},${pos.z}`);
      if (placed) return { name: placed, boundingBox: 'block' };
      const groundY = terrainGroundY(pos.x, pos.z);
      if (pos.y <= groundY) return { name: 'grass_block', boundingBox: 'block' };
      return { name: 'air', boundingBox: 'empty' };
    }
  }

  try {
    const fakeBot = new FakeBot();
    const actions = registerHighLevelSkills({}, () => fakeBot);

    const result = await actions.build_schematic({ name: 'well', x: 10, y: 64, z: 10 });

    assert.match(result.result, /Built schematic "well" at 10,68,10/);
    assert.match(result.result, /Foundation:/);
    const firstSchematicIndex = commands.findIndex((cmd) => cmd.y >= 68);
    assert.ok(firstSchematicIndex > 0, 'expected foundation commands before schematic blocks');
    assert.ok(
      commands.slice(0, firstSchematicIndex).every((cmd) => cmd.y < 68),
      'all pre-schematic commands should be foundation fill below baseY',
    );
  } finally {
    if (prior == null) {
      delete process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH;
    } else {
      process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH = prior;
    }
    if (priorFallback == null) {
      delete process.env.HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK;
    } else {
      process.env.HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK = priorFallback;
    }
  }
});

test('trusted setblock can use Paper console FIFO without bot chat spam', async () => {
  const priorTrust = process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH;
  const priorFifo = process.env.PAPER_CONSOLE_FIFO;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermescraft-fifo-test-'));
  const fifo = path.join(dir, 'console.in');
  execFileSync('mkfifo', [fifo]);
  const blocks = new Map();
  const consoleCommands = [];
  let pending = '';
  const fd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  const drain = () => {
    const buf = Buffer.alloc(4096);
    for (;;) {
      let n = 0;
      try {
        n = fs.readSync(fd, buf, 0, buf.length, null);
      } catch (e) {
        if (e.code === 'EAGAIN') break;
        throw e;
      }
      if (n <= 0) break;
      pending += buf.toString('utf8', 0, n);
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) {
        consoleCommands.push(line);
        const match = line.match(/^setblock\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)/);
        if (match) {
          const [, x, y, z, block] = match;
          blocks.set(`${x},${y},${z}`, block);
        }
      }
    }
  };
  const interval = setInterval(drain, 2);
  const chatCommands = [];
  class FakeBot extends EventEmitter {
    constructor() {
      super();
      this.inventory = { items: () => [] };
      this.entity = { position: { x: 0, y: 64, z: 0 } };
      this.username = 'Hermes';
      this._stopGeneration = 0;
    }

    chat(command) {
      chatCommands.push(command);
    }

    blockAt(pos) {
      return { name: blocks.get(`${pos.x},${pos.y},${pos.z}`) || 'air', boundingBox: 'empty' };
    }
  }

  try {
    process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH = '1';
    process.env.PAPER_CONSOLE_FIFO = fifo;
    const fakeBot = new FakeBot();
    const actions = registerHighLevelSkills({}, () => fakeBot);

    const result = await actions.build_schematic({ name: 'well', x: 10, y: 64, z: 10 });
    drain();
    assert.match(result.result, /Built schematic "well"/);
    assert.ok(consoleCommands.some((line) => line.startsWith('setblock ')), 'expected setblock via console FIFO');
    assert.equal(chatCommands.length, 0, `unexpected bot.chat commands: ${chatCommands.join(', ')}`);
  } finally {
    clearInterval(interval);
    fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
    if (priorTrust == null) {
      delete process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH;
    } else {
      process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH = priorTrust;
    }
    if (priorFifo == null) {
      delete process.env.PAPER_CONSOLE_FIFO;
    } else {
      process.env.PAPER_CONSOLE_FIFO = priorFifo;
    }
  }
});

test('trusted setblock FIFO fails closed without bot chat fallback when no reader exists', async () => {
  const priorTrust = process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH;
  const priorFifo = process.env.PAPER_CONSOLE_FIFO;
  const priorFallback = process.env.HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermescraft-fifo-no-reader-'));
  const fifo = path.join(dir, 'console.in');
  execFileSync('mkfifo', [fifo]);
  const chatCommands = [];
  class FakeBot extends EventEmitter {
    constructor() {
      super();
      this.inventory = { items: () => [] };
      this.entity = { position: { x: 0, y: 64, z: 0 } };
      this.username = 'Hermes';
      this._stopGeneration = 0;
    }

    chat(command) {
      chatCommands.push(command);
    }

    blockAt(_pos) {
      return { name: 'air', boundingBox: 'empty' };
    }
  }

  try {
    process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH = '1';
    process.env.PAPER_CONSOLE_FIFO = fifo;
    delete process.env.HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK;
    const fakeBot = new FakeBot();
    const actions = registerHighLevelSkills({}, () => fakeBot);

    const result = await Promise.race([
      actions.build_schematic({ name: 'well', x: 10, y: 64, z: 10 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('FIFO send hung')), 1000)),
    ]);
    assert.match(result.result, /Built 0\/\d+ of "well"/);
    assert.equal(chatCommands.length, 0, `unexpected bot.chat fallback: ${chatCommands.join(', ')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (priorTrust == null) {
      delete process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH;
    } else {
      process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH = priorTrust;
    }
    if (priorFifo == null) {
      delete process.env.PAPER_CONSOLE_FIFO;
    } else {
      process.env.PAPER_CONSOLE_FIFO = priorFifo;
    }
    if (priorFallback == null) {
      delete process.env.HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK;
    } else {
      process.env.HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK = priorFallback;
    }
  }
});

async function withTrustedSetblockChatFallback(fn) {
  const priorTrust = process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH;
  const priorFallback = process.env.HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK;
  process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH = '1';
  process.env.HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK = '1';
  try {
    return await fn();
  } finally {
    if (priorTrust == null) {
      delete process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH;
    } else {
      process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH = priorTrust;
    }
    if (priorFallback == null) {
      delete process.env.HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK;
    } else {
      process.env.HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK = priorFallback;
    }
  }
}

function makeSlopedSetblockBot({ baseX = 10, lowGroundY = 63, highGroundY = 66 } = {}) {
  const blocks = new Map();
  const commands = [];
  class FakeBot extends EventEmitter {
    constructor() {
      super();
      this.inventory = { items: () => [] };
      this.entity = { position: { x: 0, y: 64, z: 0 } };
      this.username = 'Hermes';
      this._stopGeneration = 0;
    }

    chat(command) {
      commands.push(command);
      const match = command.match(/^\/setblock\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)/);
      if (!match) return;
      const [, x, y, z, block] = match;
      setTimeout(() => {
        blocks.set(`${x},${y},${z}`, block);
        this.emit('message', { toString: () => `Changed the block at ${x}, ${y}, ${z}` }, 'system');
      }, 1);
    }

    blockAt(pos) {
      const key = `${pos.x},${pos.y},${pos.z}`;
      const placed = blocks.get(key);
      if (placed) return { name: placed, boundingBox: 'block' };
      const groundY = pos.x >= baseX + 2 ? highGroundY : lowGroundY;
      if (pos.y <= groundY) return { name: 'grass_block', boundingBox: 'block' };
      return { name: 'air', boundingBox: 'empty' };
    }
  }
  return { fakeBot: new FakeBot(), commands };
}

test('build_schematic places terrain foundation before schematic blocks', async () => {
  await withTrustedSetblockChatFallback(async () => {
    const { fakeBot, commands } = makeSlopedSetblockBot();
    const actions = registerHighLevelSkills({}, () => fakeBot);

    const result = await actions.build_schematic({ name: 'well', x: 10, y: 64, z: 10 });

    assert.match(result.result, /Built schematic "well" at 10,67,10/);
    const firstFoundation = commands.findIndex((line) => line.endsWith(' stone'));
    const firstSchematic = commands.findIndex((line) => line.endsWith(' cobblestone'));
    assert.ok(firstFoundation >= 0, `expected foundation commands, saw: ${commands.join(', ')}`);
    assert.ok(firstSchematic > firstFoundation, `expected foundation before schematic, saw: ${commands.join(', ')}`);
  });
});

test('build_schematic preserves pinned baseY and skip_foundation bypasses grounding', async () => {
  await withTrustedSetblockChatFallback(async () => {
    const pinned = makeSlopedSetblockBot();
    const pinnedActions = registerHighLevelSkills({}, () => pinned.fakeBot);
    const pinnedResult = await pinnedActions.build_schematic({
      name: 'well',
      x: 10,
      y: 70,
      z: 10,
      respect_explicit_base_y: true,
    });
    assert.match(pinnedResult.result, /Built schematic "well" at 10,70,10/);

    const skipped = makeSlopedSetblockBot();
    const skippedActions = registerHighLevelSkills({}, () => skipped.fakeBot);
    const skippedResult = await skippedActions.build_schematic({
      name: 'well',
      x: 10,
      y: 64,
      z: 10,
      skip_foundation: true,
    });
    assert.match(skippedResult.result, /Built schematic "well" at 10,64,10/);
    assert.equal(skipped.commands.some((line) => line.endsWith(' stone')), false);
  });
});
