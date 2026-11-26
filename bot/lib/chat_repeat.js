// Chat repeat guard (agorokh/hermescraft#592).
//
// A companion brain on Kimi repeated the same public chat line 2–3 times
// inside 30 s while idle next to a player (live check 2026-11-26 on
// mint-dev). The dedup rule in MINECRAFT_RULES.md §1.0c is prompt text and
// did not hold. This is the body-side guard: a public `mc chat` line that
// matches one this bot said inside the window is not sent, and the tool
// result tells the brain what to say instead.

export const CHAT_REPEAT_WINDOW_MS_DEFAULT = 120_000;
// Lines of two words or fewer ("ok!", "on it!", "yes") stay sendable: they
// answer different questions and read fine twice.
export const CHAT_REPEAT_MIN_WORDS = 3;
const NEAR_REPEAT_JACCARD = 0.8;
const NEAR_REPEAT_RUN_WORDS = 8;
const NEAR_REPEAT_CONTAINED = 0.8;
const NEAR_REPEAT_CONTAINED_MIN_WORDS = 6;

// Marks a chat action body that an intent router built in-process. A Symbol
// key cannot arrive in an HTTP JSON body, so a caller of /action/chat cannot
// claim the router exemption.
export const ROUTER_CHAT = Symbol('hermescraft.routerChat');

export function chatRepeatWindowMs(env = process.env) {
  const raw = Number(env.HERMESCRAFT_CHAT_REPEAT_WINDOW_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return CHAT_REPEAT_WINDOW_MS_DEFAULT;
}

export function normalizeChatLine(message) {
  return String(message || '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/'/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(normalized) {
  return normalized ? normalized.split(' ') : [];
}

// Longest run of words the two lines share in the same order.
function longestSharedRun(a, b) {
  let best = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k += 1;
      if (k > best) best = k;
    }
  }
  return best;
}

// A line repeats another when it is the same line reworded a little:
// - most of the words of both lines are shared (Jaccard), or
// - a long phrase is said again word for word, or
// - nearly all of the shorter line is inside the longer one.
// Rosie's live near-repeat (2026-11-26, 85 s apart) shared a 10-word run and
// 83% of the shorter line but only 61% Jaccard.
export function isRepeatLine(a, b) {
  const na = normalizeChatLine(a);
  const nb = normalizeChatLine(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const la = words(na);
  const lb = words(nb);
  const wa = new Set(la);
  const wb = new Set(lb);
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  const union = wa.size + wb.size - shared;
  if (union > 0 && shared / union >= NEAR_REPEAT_JACCARD) return true;
  if (longestSharedRun(la, lb) >= NEAR_REPEAT_RUN_WORDS) return true;
  const smaller = Math.min(wa.size, wb.size);
  return smaller >= NEAR_REPEAT_CONTAINED_MIN_WORDS && shared / smaller >= NEAR_REPEAT_CONTAINED;
}

export function chatRepeatRefusal(secondsAgo) {
  return `Didn't send that: you said the same line ${secondsAgo}s ago and it is still on the players' screens. `
    + 'Say something new — answer what the player just said, tell them what you did or found, '
    + 'or keep quiet and act until something changes. Nothing was sent.';
}

export function createChatRepeatGuard({ now = () => Date.now(), windowMs } = {}) {
  let history = [];
  const window = () => (windowMs ?? chatRepeatWindowMs());

  function prune(at) {
    const w = window();
    // Time is the only bound: every line said inside the window stays checkable.
    history = history.filter((entry) => at - entry.time < w);
  }

  return {
    // Returns { secondsAgo, previous } when `message` repeats a recent line.
    check(message) {
      const at = now();
      prune(at);
      if (words(normalizeChatLine(message)).length < CHAT_REPEAT_MIN_WORDS) return null;
      for (let i = history.length - 1; i >= 0; i -= 1) {
        if (isRepeatLine(message, history[i].message)) {
          return {
            secondsAgo: Math.max(0, Math.round((at - history[i].time) / 1000)),
            previous: history[i].message,
          };
        }
      }
      return null;
    },
    record(message) {
      const at = now();
      history.push({ time: at, message: String(message || '') });
      prune(at);
    },
    size() {
      return history.length;
    },
  };
}
