// A character's line never reaches the speculative intent router (hermescraft#592).
// Runs the server's real handleChat against the real chat-routing helpers, without
// starting Minecraft or a listener.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CURRENT_CAST,
  buildKnownNames,
  parseMessageRouting,
  isMessageForMe,
  broadcastMentionsMe,
  stripMentionPrefix,
} from '../lib/chat.js';
import { isCompanionSpeaker } from '../lib/quests.js';

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

function serverFunction(name, next, globals) {
  const start = server.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} is in server.js`);
  const source = server.slice(start, server.indexOf(`\n${next}`, start));
  const asyncPrefix = server.slice(start - 6, start) === 'async ' ? 'async ' : '';
  return new Function(...Object.keys(globals), `return ${asyncPrefix}${source}`)(...Object.values(globals));
}

function withCompanions(names, fn) {
  const before = process.env.HERMESCRAFT_COMPANION_NAMES;
  process.env.HERMESCRAFT_COMPANION_NAMES = names;
  return Promise.resolve(fn()).finally(() => {
    if (before === undefined) delete process.env.HERMESCRAFT_COMPANION_NAMES;
    else process.env.HERMESCRAFT_COMPANION_NAMES = before;
  });
}

// Steve's server, with a router that would turn any line about a tower into a build.
function steveServer() {
  const seen = { routed: [], shadowed: [], actions: [], queued: [], said: [], logs: [] };
  const commandQueue = [];
  const chatLog = [];
  const handleChat = serverFunction('handleChat', 'function log(', {
    _studio: null,
    buildKnownNames, parseMessageRouting, isMessageForMe, broadcastMentionsMe, stripMentionPrefix,
    isCompanionSpeaker, CURRENT_CAST,
    getMyName: () => 'Steve',
    getNearbyPlayerNames: () => ['Rosie', 'KidOne'],
    bot: {
      chat: (m) => seen.said.push(m),
      // Rosie stands two blocks away, so her casual lines are heard, not "distant".
      entities: { 5: { username: 'Rosie', position: { x: 2, y: 64, z: 0 } } },
      entity: { position: { distanceTo: () => 2 } },
    },
    botReady: true,
    FAIR_PLAY: { LOS_ENTITY_RANGE: 48 },
    overheardLog: [], MAX_LOG: 100, chatLog, commandQueue,
    rememberSocialEvent: () => {},
    log: (m) => seen.logs.push(m),
    tryRoute: async (_bot, body, sender) => {
      seen.routed.push({ body, sender });
      return /tower/i.test(body)
        ? { matched: true, intent_name: 'build_tower', action: 'build_tower', body: { height: 5 } }
        : { matched: false };
    },
    shadowRoute: (_bot, body, sender) => { seen.shadowed.push({ body, sender }); },
    ackFor: () => 'on it!',
    ACTIONS: { build_tower: async () => ({ result: 'built' }) },
    actionBodyForRoute: (route) => route.body,
    markChatEntryHandledByRouter: () => {},
    clearChatEntryRouterMark: () => {},
    runIntentRoutedAction: async (action, body) => { seen.actions.push({ action, body }); return { result: 'built' }; },
    handleIntentRouterActionResult: async () => true,
    markLastSkillFailed: () => {},
    nextEnvelopeId: () => `env-${commandQueue.length + 1}`,
    nlpHintsForQueue: () => ({}),
    trimCommandQueue: () => {},
  });
  return { handleChat, seen, commandQueue, chatLog };
}

test('a player who asks a character for a tower by name gets one from the router', async () => {
  await withCompanions('Rosie,Steve', async () => {
    const { handleChat, seen, commandQueue } = steveServer();
    await handleChat('KidOne', 'Steve build a tower');
    assert.equal(seen.routed.length, 1);
    assert.deepEqual(seen.actions.map((a) => a.action), ['build_tower']);
    assert.deepEqual(seen.said, ['on it!']);
    assert.equal(commandQueue.length, 0, 'the router handled it, so nothing is queued for the brain');
  });
});

test('another character saying the same thing builds nothing: the line goes to the brain', async () => {
  await withCompanions('Rosie,Steve', async () => {
    for (const line of ['Steve im here by the tower with you', 'steve: lets build a tower']) {
      const { handleChat, seen, commandQueue } = steveServer();
      await handleChat('Rosie', line);
      assert.equal(seen.routed.length, 0, `router not consulted for "${line}"`);
      assert.equal(seen.shadowed.length, 0, 'nor its shadow');
      assert.deepEqual(seen.actions, [], 'no action fired');
      assert.deepEqual(seen.said, [], 'no acknowledgement in chat');
      assert.equal(commandQueue.length, 1, 'the addressed line is still queued for the brain');
      assert.equal(commandQueue[0].from, 'Rosie');
      assert.ok(seen.logs.some((m) => /skipped: <Rosie> is a character/.test(m)), 'and the log says why');
    }
  });
});

test('a Bedrock-prefixed character name is still a character', async () => {
  await withCompanions('Rosie,Steve', async () => {
    const { handleChat, seen } = steveServer();
    await handleChat('.Rosie', 'Steve build a tower');
    assert.equal(seen.routed.length, 0);
    assert.deepEqual(seen.actions, []);
  });
});

test('with no roster configured nobody is treated as a character, so players named like one still route', async () => {
  await withCompanions('', async () => {
    const { handleChat, seen } = steveServer();
    await handleChat('Rosie', 'Steve build a tower');
    assert.equal(seen.routed.length, 1);
    assert.deepEqual(seen.actions.map((a) => a.action), ['build_tower']);
  });
});

test('a character line that names nobody stays peer chat, as before', async () => {
  await withCompanions('Rosie,Steve', async () => {
    const { handleChat, seen, commandQueue, chatLog } = steveServer();
    await handleChat('Rosie', 'this tower is coming along nicely');
    assert.equal(seen.routed.length, 0);
    assert.equal(commandQueue.length, 0);
    assert.equal(chatLog.at(-1)?.companion_peer, true);
  });
});
