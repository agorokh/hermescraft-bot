// Chat repeat guard (agorokh/hermescraft#592).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CHAT_REPEAT_WINDOW_MS_DEFAULT,
  ROUTER_CHAT,
  chatRepeatRefusal,
  chatRepeatWindowMs,
  createChatRepeatGuard,
  isRepeatLine,
  normalizeChatLine,
} from '../lib/chat_repeat.js';

function clockAt(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('the live repeats from 2026-11-26 are caught inside the window', () => {
  const clock = clockAt();
  const guard = createChatRepeatGuard({ now: clock.now, windowMs: 120_000 });
  const a = 'castle or tower sounds fun! i can mine stone while you design.';
  const b = "i'm here too! what should we build first?";
  assert.equal(guard.check(a), null);
  guard.record(a);
  clock.advance(5_000);
  assert.equal(guard.check(b), null);
  guard.record(b);
  clock.advance(9_000);
  assert.deepEqual(guard.check(a), { secondsAgo: 14, previous: a });
  assert.deepEqual(guard.check('I’m here too!  What should we build first'), { secondsAgo: 9, previous: b });
});

test('a line is sendable again once the window has passed', () => {
  const clock = clockAt();
  const guard = createChatRepeatGuard({ now: clock.now, windowMs: 60_000 });
  const line = "i'm ready! just say the word.";
  guard.record(line);
  clock.advance(59_000);
  assert.ok(guard.check(line));
  clock.advance(2_000);
  assert.equal(guard.check(line), null);
  assert.equal(guard.size(), 0);
});

test('every line inside the window stays checkable, however many were said', () => {
  const clock = clockAt();
  const guard = createChatRepeatGuard({ now: clock.now, windowMs: 120_000 });
  const first = 'castle or tower sounds fun! i can mine stone while you design.';
  guard.record(first);
  for (let i = 0; i < 40; i += 1) {
    clock.advance(1_000);
    guard.record(`line number ${i} about block ${i * 7} and tower ${i}`);
  }
  assert.deepEqual(guard.check(first), { secondsAgo: 40, previous: first });
  assert.equal(guard.size(), 41);
});

test('the router marker is a Symbol, so a JSON request body cannot carry it', () => {
  assert.equal(typeof ROUTER_CHAT, 'symbol');
  const spoofed = JSON.parse(JSON.stringify({ message: 'hi there friend', [ROUTER_CHAT]: true, chat_origin: 'router' }));
  assert.equal(spoofed[ROUTER_CHAT], undefined);
  const routed = { ...{ message: 'on it!', [ROUTER_CHAT]: true } };
  assert.equal(routed[ROUTER_CHAT], true, 'spreading an in-process body keeps the marker');
});

test('near-repeats count; different lines and short acks do not', () => {
  assert.ok(isRepeatLine(
    'castle or tower sounds fun! i can mine stone while you design.',
    'castle or tower sounds fun - i can mine some stone while you design',
  ));
  assert.equal(isRepeatLine('i can mine stone while you design', 'the tower is 12 blocks tall now'), false);
  const clock = clockAt();
  const guard = createChatRepeatGuard({ now: clock.now, windowMs: 120_000 });
  guard.record('on it!');
  guard.record('ok');
  assert.equal(guard.check('on it!'), null);
  assert.equal(guard.check('OK'), null);
});

test('normalizing ignores case, punctuation, apostrophes and spacing', () => {
  assert.equal(normalizeChatLine("  I'M  here, too!! "), 'im here too');
  assert.equal(normalizeChatLine('I’m here too'), 'im here too');
  assert.equal(normalizeChatLine(''), '');
});

test('the window defaults to two minutes and can be set from the environment', () => {
  assert.equal(chatRepeatWindowMs({}), CHAT_REPEAT_WINDOW_MS_DEFAULT);
  assert.equal(CHAT_REPEAT_WINDOW_MS_DEFAULT, 120_000);
  assert.equal(chatRepeatWindowMs({ HERMESCRAFT_CHAT_REPEAT_WINDOW_MS: '60000' }), 60_000);
  assert.equal(chatRepeatWindowMs({ HERMESCRAFT_CHAT_REPEAT_WINDOW_MS: '0' }), 0);
  assert.equal(chatRepeatWindowMs({ HERMESCRAFT_CHAT_REPEAT_WINDOW_MS: 'nope' }), CHAT_REPEAT_WINDOW_MS_DEFAULT);
});

test('the refusal says nothing was sent and what to say instead', () => {
  const text = chatRepeatRefusal(14);
  assert.match(text, /14s ago/);
  assert.match(text, /Say something new/);
  assert.match(text, /Nothing was sent\.$/);
});

test('ACTIONS.chat checks for a repeat before every public send, and router replies are exempt', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = server.indexOf('  async chat({ message, in_reply_to, skip_voice_autocorrelate, [ROUTER_CHAT]: fromRouter }) {');
  assert.ok(start > 0, 'chat reads the router marker by Symbol');
  assert.equal(server.includes('chat_origin'), false, 'no body field can claim the exemption');
  const body = server.slice(start, server.indexOf('\n  },', start));
  const code = body.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.equal((code.match(/\bb\.chat\(/g) || []).length, 0, 'public sends go through sendPublicChat');
  const sends = [...body.matchAll(/sendPublicChat\(b, message\)/g)].map((m) => m.index);
  const guards = [...body.matchAll(/const repeated = refusePublicChat\(message, fromRouter\);\n\s+if \(repeated\) return repeated;/g)].map((m) => m.index);
  assert.equal(sends.length, 2);
  assert.equal(guards.length, 2);
  for (let i = 0; i < sends.length; i += 1) assert.ok(guards[i] < sends[i], 'guard before send');
  // Voice replies go to the speaker, never through the public guard.
  assert.ok(body.indexOf('postVoiceSpeak') < guards[0]);
  assert.match(server, /skip_voice_autocorrelate: true, \[ROUTER_CHAT\]: true \}/);
  assert.match(server, /if \(fromRouter === true \|\| String\(message\)\.trimStart\(\)\.startsWith\('\/'\)\) return null;/);
});
