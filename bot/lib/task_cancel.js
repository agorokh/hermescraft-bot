// `mc cancel` (POST /task/cancel): what a brain uses to drop its own background task.
//
// During a creative-studio co-build (agorokh/hermescraft#592) a cancel must not read as
// "this character was stopped". The co-build treats a bumped stop generation as a stop,
// and a stop by one character cancels the plan for every character. On the family server
// on 2026-11-20 Steve's brain cancelled its own walk 3 s after the child's request and
// ended the whole Eiffel Tower co-build at 0 blocks. Only `stop` (a player's "stop", or
// `mc stop`) ends a co-build.
export const STUDIO_KEEPS_GOING = 'The studio build with the player keeps going; mc stop ends it for everyone.';

/**
 * @param {object} bot mineflayer bot
 * @param {object|null} task the server's currentTask
 * @param {boolean} studioActive this body is taking part in a studio co-build
 * @returns {string} the result line for the brain
 */
export function cancelBackgroundTask(bot, task, studioActive) {
  const running = Boolean(task && task.status === 'running');
  if (studioActive && running && task.action === 'studio_build') {
    // The running task is the co-build itself: leave it, and the task slot, as they are.
    return `Nothing cancelled: the running task is the studio build. ${STUDIO_KEEPS_GOING}`;
  }
  // Nothing of the brain's to cancel: any interrupt would only reach the co-build.
  if (studioActive && !running) return `No background task to cancel. ${STUDIO_KEEPS_GOING}`;
  // Every interrupt a background task listens for, except the one the co-build reads.
  if (!studioActive) bot._stopGeneration = (bot._stopGeneration || 0) + 1;
  bot._actionEpoch = (bot._actionEpoch || 0) + 1;
  bot.interrupt_code = true;
  try { bot.pathfinder?.setGoal(null); } catch { /* not moving */ }
  try { bot.stopDigging?.(); } catch { /* not digging */ }
  if (running) task.status = 'cancelled';
  return studioActive ? `Task cancelled. ${STUDIO_KEEPS_GOING}` : 'Task cancelled.';
}
