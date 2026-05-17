// Shared Mineflayer emote animations for regex and NLP intent routers.

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runEmoteWave(bot, dryRun = false) {
  if (dryRun || !bot) return;
  try {
    for (let i = 0; i < 3; i++) {
      bot.swingArm('right');
      await sleep(300);
    }
  } catch {}
}

export async function runEmoteJump(bot, dryRun = false) {
  if (dryRun || !bot) return;
  try {
    for (let i = 0; i < 3; i++) {
      bot.setControlState('jump', true);
      await sleep(120);
      bot.setControlState('jump', false);
      await sleep(250);
    }
  } catch {}
}

export async function runEmoteDance(bot, dryRun = false) {
  if (dryRun || !bot?.entity) return;
  try {
    const start = Date.now();
    let yaw = bot.entity.yaw;
    while (Date.now() - start < 3000) {
      yaw += Math.PI / 4;
      try { await bot.look(yaw, 0); } catch {}
      bot.setControlState('jump', true);
      await sleep(180);
      bot.setControlState('jump', false);
      await sleep(180);
    }
  } catch {}
}

export async function runEmoteSit(bot, dryRun = false) {
  if (dryRun || !bot) return;
  try {
    bot.setControlState('sneak', true);
    setTimeout(() => { try { bot.setControlState('sneak', false); } catch {} }, 5000);
  } catch {}
}
