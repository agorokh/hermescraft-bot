import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_DIR = dirname(__dirname);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function listenOnLoopback(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

function createSpeakServer({ failFirst = false } = {}) {
  const messages = [];
  let calls = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/speak') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false }));
    }
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      calls++;
      messages.push(JSON.parse(data || '{}'));
      if (failFirst && calls === 1) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'temporary speaker failure' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return { server, messages };
}

async function startBotServer(env) {
  const portProbe = http.createServer((req, res) => res.end('ok'));
  const apiPort = await listenOnLoopback(portProbe);
  await closeServer(portProbe);
  const logs = [];
  const child = spawn(process.execPath, [
    'server.js',
    '--port', String(apiPort),
    '--mc-host', '127.0.0.1',
    '--mc-port', '1',
    '--username', 'Rosie',
  ], {
    cwd: BOT_DIR,
    env: {
      ...process.env,
      MC_AUTH: 'offline',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => logs.push(String(chunk)));
  child.stderr.on('data', chunk => logs.push(String(chunk)));
  try {
    await waitForHealth(apiPort, child, logs);
  } catch (e) {
    await stopBotServer(child);
    throw e;
  }
  return { apiPort, child, logs };
}

async function waitForHealth(apiPort, child, logs) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${apiPort}/health`);
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`server did not become healthy; exit=${child.exitCode}; logs=${logs.join('').slice(-2000)}`);
}

async function stopBotServer(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const killed = sleep(2000).then(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  await Promise.race([once(child, 'exit'), killed]);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

test('voice-utterance is hidden when source router flag is disabled', async () => {
  const { apiPort, child } = await startBotServer({
    HERMESCRAFT_VOICE_ROUTER_ENABLED: '0',
  });
  try {
    const { response, payload } = await postJson(`http://127.0.0.1:${apiPort}/voice-utterance`, {
      transcript: 'Rosie, can you hear me?',
    });
    assert.equal(response.status, 404);
    assert.equal(payload.ok, false);
  } finally {
    await stopBotServer(child);
  }
});

test('voice-utterance queues a voice turn and routes chat replies to sidecar speak', async () => {
  const { server: speakServer, messages } = createSpeakServer();
  const speakPort = await listenOnLoopback(speakServer);
  const { apiPort, child } = await startBotServer({
    HERMESCRAFT_VOICE_ROUTER_ENABLED: '1',
    HERMESCRAFT_VOICE_SPEAK_URL: 'http://127.0.0.1:1/speak',
  });
  try {
    const { response: queuedResponse, payload: queued } = await postJson(`http://127.0.0.1:${apiPort}/voice-utterance`, {
      transcript: 'Rosie, say hello',
      kid: 'DanceO3677',
      character: 'Rosie',
      turn_id: 'voice-turn-124',
      speak_url: `http://127.0.0.1:${speakPort}/speak`,
    });
    assert.equal(queuedResponse.status, 202);
    assert.equal(queued.ok, true);
    assert.equal(queued.delivery, 'sidecar');
    assert.equal(queued.turn_id, 'voice-turn-124');

    const commandsResponse = await fetch(`http://127.0.0.1:${apiPort}/commands?claim=1`);
    const commandsPayload = await commandsResponse.json();
    assert.equal(commandsPayload.ok, true);
    assert.equal(commandsPayload.data.commands[0].source, 'voice');
    assert.equal(commandsPayload.data.commands[0].voice_delivery, 'sidecar');
    assert.equal(commandsPayload.data.commands[0].turn_id, 'voice-turn-124');

    const { response: chatResponse, payload: chat } = await postJson(`http://127.0.0.1:${apiPort}/action/chat`, {
      message: 'Hi Dance, I can hear you.',
      in_reply_to: queued.id,
    });
    assert.equal(chatResponse.status, 200);
    assert.equal(chat.ok, true);
    assert.match(chat.result, /voice sidecar/);

    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, 'Hi Dance, I can hear you.');
    assert.equal(messages[0].turn_id, 'voice-turn-124');
    assert.equal(messages[0].kid, 'DanceO3677');
    assert.equal(messages[0].character, 'Rosie');
  } finally {
    await stopBotServer(child);
    await closeServer(speakServer);
  }
});

test('voice-utterance keeps sidecar turns retryable after a speak failure', async () => {
  const { server: speakServer, messages } = createSpeakServer({ failFirst: true });
  const speakPort = await listenOnLoopback(speakServer);
  const { apiPort, child } = await startBotServer({
    HERMESCRAFT_VOICE_ROUTER_ENABLED: '1',
    HERMESCRAFT_VOICE_SPEAK_URL: `http://127.0.0.1:${speakPort}/speak`,
  });
  try {
    const { payload: queued } = await postJson(`http://127.0.0.1:${apiPort}/voice-utterance`, {
      transcript: 'Rosie, retry this',
      kid: 'DanceO3677',
      turn_id: 'voice-turn-retry',
    });

    await fetch(`http://127.0.0.1:${apiPort}/commands?claim=1`);

    const { response: failedResponse, payload: failed } = await postJson(`http://127.0.0.1:${apiPort}/action/chat`, {
      message: 'First try',
      in_reply_to: queued.id,
    });
    assert.equal(failedResponse.status, 502);
    assert.equal(failed.ok, false);

    const commandsAfterFailure = await fetch(`http://127.0.0.1:${apiPort}/commands`);
    const commandsPayload = await commandsAfterFailure.json();
    assert.equal(commandsPayload.data.commands[0].status, 'pending');

    const { response: retryResponse, payload: retry } = await postJson(`http://127.0.0.1:${apiPort}/action/chat`, {
      message: 'Second try',
      in_reply_to: queued.id,
    });
    assert.equal(retryResponse.status, 200);
    assert.equal(retry.ok, true);
    assert.equal(messages.length, 2);
    assert.equal(messages[1].text, 'Second try');
    assert.equal(messages[1].turn_id, 'voice-turn-retry');
  } finally {
    await stopBotServer(child);
    await closeServer(speakServer);
  }
});

test('read-only commands peeks do not arm voice auto-correlation or block public chat', async () => {
  const { server: speakServer, messages } = createSpeakServer();
  const speakPort = await listenOnLoopback(speakServer);
  const { apiPort, child } = await startBotServer({
    HERMESCRAFT_VOICE_ROUTER_ENABLED: '1',
    HERMESCRAFT_VOICE_SPEAK_URL: `http://127.0.0.1:${speakPort}/speak`,
  });
  try {
    const { payload: queued } = await postJson(`http://127.0.0.1:${apiPort}/voice-utterance`, {
      transcript: 'Rosie, this is only a peek',
      kid: 'DanceO3677',
      turn_id: 'voice-turn-peek',
    });

    const peekResponse = await fetch(`http://127.0.0.1:${apiPort}/commands`);
    const peekPayload = await peekResponse.json();
    assert.equal(peekPayload.ok, true);
    assert.equal(peekPayload.data.commands[0].id, queued.id);

    const { response: peekChatResponse } = await postJson(`http://127.0.0.1:${apiPort}/action/chat`, {
      message: 'This should not be spoken yet.',
    });
    assert.equal(peekChatResponse.status, 503);
    assert.equal(messages.length, 0);

    await fetch(`http://127.0.0.1:${apiPort}/commands?claim=1`);
    const { response: claimedChatResponse, payload: claimed } = await postJson(`http://127.0.0.1:${apiPort}/action/chat`, {
      message: 'This should be spoken after claim.',
    });
    assert.equal(claimedChatResponse.status, 200);
    assert.equal(claimed.ok, true);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, 'This should be spoken after claim.');
  } finally {
    await stopBotServer(child);
    await closeServer(speakServer);
  }
});

test('voice-utterance rejects unsafe speak URLs before queueing', async () => {
  const { apiPort, child } = await startBotServer({
    HERMESCRAFT_VOICE_ROUTER_ENABLED: '1',
  });
  try {
    const { response, payload } = await postJson(`http://127.0.0.1:${apiPort}/voice-utterance`, {
      transcript: 'Rosie, do not queue this',
      speak_url: 'https://example.com/speak',
    });
    assert.equal(response.status, 400);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, 'invalid_speak_url');

    const commandsResponse = await fetch(`http://127.0.0.1:${apiPort}/commands`);
    const commandsPayload = await commandsResponse.json();
    assert.equal(commandsPayload.data.commands.length, 0);
  } finally {
    await stopBotServer(child);
  }
});
