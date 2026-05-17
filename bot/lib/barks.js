// HermesCraft idle-bark + reactive-event system.
//
// Inspired by Mindcraft's modes.js + "Adding Life to Worlds with Dialogue
// Barks" (Natalie, GameDeveloper). The hot-path that makes Rosie/Steve feel
// PRESENT (head-tracking, environmental noticing, micro-reactions) runs with
// ZERO LLM calls — pure scripted behavior reading the world state every few
// seconds and firing curated chat lines + look_at actions.
//
// This is the "presence beats smartness" insight from the kid-NPC research
// agent: Animal Crossing villagers feel alive not from clever dialogue but
// from constant tiny visible behaviors that show they're aware of you.
//
// Tunable cooldowns guard against spamming:
//   IDLE_BARK_COOLDOWN_MS    — min ms between two unprompted barks
//   REACTIVE_COOLDOWN_MS     — min ms between two reactive (event-triggered) barks
//   PLAYER_PROXIMITY_BLOCKS  — bark/look only when a player is closer than this

const IDLE_BARK_COOLDOWN_MS = 60_000;      // one bark per minute floor
const IDLE_BARK_JITTER_MS   = 60_000;      // up to +60s of randomness
const REACTIVE_COOLDOWN_MS  = 8_000;       // 8s between reactive barks
const PLAYER_PROXIMITY      = 16;          // blocks
const PLAYER_GAZE_DISTANCE  = 24;          // blocks; bot tracks closer players

// Hand-curated bark tables. The kid-NPC research agent's advice was explicit:
// use the LLM offline to generate these — hand-edit the result — and ONLY use
// the live LLM for context-aware barks where unique phrasing matters.
//
// Rosie's voice: chatty, 1-2 sentences, fashion-designer-ex-architect, warm.
// Steve's voice: 1 sentence max, brief, action-first, mining-focused.

const BARKS = {
  Rosie: {
    idle_environment: [
      'ooh, look at that flower',
      'this floor plan is giving me ideas honestly',
      'love the colors here',
      'london\'s grey today — perfect for inside building',
      'i could put a little garden right here',
      'the light is so nice this time of day',
      'amethyst would look amazing with this palette',
      'someone needs a porch here',
      'i\'m feeling a cottage moment',
      'should we plant flowers?',
    ],
    idle_self: [
      'just vibing',
      'sketching ideas',
      'mental floor-plan time',
      'thinking about the next build',
      'maybe a balcony next',
    ],
    on_player_block_placed: [
      'oooh nice',
      'love that placement',
      'classy',
      'okay i see you',
      'ohhh',
      'good eye',
      'love it',
    ],
    on_player_mined: [
      'nice find!',
      'oooh what was it?',
      'mining game strong',
      'ohh good one',
    ],
    on_player_join: [
      'hiii!',
      'heyy you\'re here!',
      'finally — welcome back',
      'oh good you\'re online',
    ],
    on_player_leave: [
      'bye!! play soon',
      'come back soon',
      'see ya',
    ],
  },
  Steve: {
    idle_environment: [
      'iron probably down 20 more',
      'nice rock here',
      'good vein direction',
      'cave below sounds promising',
      'should make more tools',
    ],
    idle_self: [
      'restocking',
      'checking gear',
      'thinking',
      'pickaxe could be better',
    ],
    on_player_block_placed: [
      'looks good',
      'nice',
      'solid',
      'cool',
    ],
    on_player_mined: [
      'good drop',
      'nice',
      'what is it?',
    ],
    on_player_join: [
      'hey',
      'welcome',
      'good timing',
    ],
    on_player_leave: [
      'gg',
      'cya',
      'bye',
    ],
  },
};

function pickRandom(arr) {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function distance(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function nearestPlayer(bot, maxRange) {
  let best = null, bestDist = maxRange + 1;
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity) continue;
    if (e.type !== 'player') continue;
    const d = distance(bot.entity.position, e.position);
    if (d < bestDist) { best = e; bestDist = d; }
  }
  return best;
}

// ── Public installer ──────────────────────────────────────────────────
//
// Wires:
//  1. idle bark loop  (tick every 15s; bark at most once per cooldown)
//  2. gaze-on-proximity loop (tick every 2s; track nearest player visually)
//  3. event hooks (playerJoined / playerLeft / blockUpdate on player blocks)
//
// Returns a tearDown() function so callers can clean up on disconnect.

export function installBarksAndPresence(bot, opts = {}) {
  const characterName = opts.characterName || bot._client?.username || 'Rosie';
  const character = BARKS[characterName] ? characterName : 'Rosie';
  const table = BARKS[character];

  let nextIdleBarkAt = 0;
  let lastReactiveAt = 0;
  let lastGazeTarget = null;
  let lastGazePos = null;
  let stopped = false;

  function shouldBark(category, cooldown) {
    if (stopped) return false;
    const now = Date.now();
    if (category === 'idle') {
      if (now < nextIdleBarkAt) return false;
      nextIdleBarkAt = now + IDLE_BARK_COOLDOWN_MS + Math.random() * IDLE_BARK_JITTER_MS;
      return true;
    } else {
      if (now - lastReactiveAt < cooldown) return false;
      lastReactiveAt = now;
      return true;
    }
  }

  function sayBark(category) {
    const line = pickRandom(table[category]);
    if (!line) return;
    try {
      bot.chat(line);
    } catch (e) { /* swallow — chat can fail right after spawn */ }
  }

  // 1. Idle bark loop
  const idleTimer = setInterval(() => {
    if (stopped || !bot || !bot.entity) return;
    const np = nearestPlayer(bot, PLAYER_PROXIMITY);
    if (!np) return; // only bark when a kid is around — silence in empty world saves tokens
    // Bias: 70% environmental, 30% self
    const category = Math.random() < 0.7 ? 'idle_environment' : 'idle_self';
    if (shouldBark('idle')) {
      sayBark(category);
    }
  }, 15_000);

  // 2. Gaze-on-proximity loop
  const gazeTimer = setInterval(() => {
    if (stopped || !bot || !bot.entity) return;
    const np = nearestPlayer(bot, PLAYER_GAZE_DISTANCE);
    if (!np) { lastGazeTarget = null; lastGazePos = null; return; }
    const gazePos = np.position.offset(0, 1.6, 0);
    const movedEnough = !lastGazePos || gazePos.distanceTo(lastGazePos) > 0.5;
    if (lastGazeTarget !== np.username || movedEnough) {
      try {
        bot.lookAt(gazePos);
        lastGazeTarget = np.username;
        lastGazePos = gazePos.clone();
      } catch (e) {}
    }
  }, 2_000);

  // 3. Event hooks
  const onPlayerJoined = (player) => {
    if (player.username === bot.username) return;
    if (shouldBark('reactive', REACTIVE_COOLDOWN_MS)) sayBark('on_player_join');
  };
  const onPlayerLeft = (player) => {
    if (player.username === bot.username) return;
    if (shouldBark('reactive', REACTIVE_COOLDOWN_MS)) sayBark('on_player_leave');
  };
  bot.on('playerJoined', onPlayerJoined);
  bot.on('playerLeft', onPlayerLeft);

  return function tearDown() {
    stopped = true;
    clearInterval(idleTimer);
    clearInterval(gazeTimer);
    try { bot.removeListener('playerJoined', onPlayerJoined); } catch {}
    try { bot.removeListener('playerLeft', onPlayerLeft); } catch {}
  };
}
