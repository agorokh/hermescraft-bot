// Sky-claim guard for public chat (agorokh/hermescraft#592, finding 2).
//
// On the flat studio world the ground is at Y -60. Steve (Kimi) kept telling
// the child "y=-60 deep underground … dark down here" while his own `mc
// status` said open sky. A rule in the system prompt (#648) and one in the
// per-turn wake prompt (#649) each helped, and the line still came back. This
// is the body-side check: while the bot stands under open sky, a public line
// that says it is underground or in the dark is not sent, and the tool result
// tells the brain what to say.

// Words that make the sentence a plan or a suggestion, not a statement about
// where the speaker is now ("let's dig underground here", "we're going to
// mine underground"). Activity verbs (mining, digging, looking) are not here:
// "i am mining underground" is a claim about now.
const PLAN = /\b(?:go|going|gonna|head|heading|will|ill|well go|could|can|should|want|wanna|lets|need to|try|maybe)\b/;
// Words that deny or warn ("open sky, not underground", "don't go underground here").
const NEGATION = /\b(?:not|no|dont|do not|isnt|arent|never|nowhere near)\b/;
// For "deep underground": the thing is somewhere else ("found coal deep underground").
const ELSEWHERE = /\b(?:there|theres|found|find|see|saw|spotted|ore|vein|diamonds?|iron|coal)\b/;
const PAST = /^[^.!?]{0,25}\b(?:earlier|before|last time|yesterday|ago)\b/;

function normalize(message) {
  return String(message || '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/'/g, '')
    .replace(/\s+/g, ' ');
}

// The part of the sentence before the match, back to the last sentence end
// or clause break (comma, dash, "but"), so "no kids online, we're deep
// underground" is still a claim while "open sky, not underground" is not.
function clauseBefore(text, index) {
  const sentence = text.slice(0, index).split(/[.!?]/).pop();
  return sentence.split(/,|;|:| - | — | – |\bbut\b/).pop();
}

// Each pattern names the place the speaker is in right now. `gap` (when set)
// is the group between the speaker and the place.
const CLAIMS = [
  { re: /\bdeep underground\b/g, pre: true },
  { re: /\by\s*[=:]?\s*-?\d+\b([^.!?]{0,30})\bunderground\b/g, gap: 1 },
  { re: /\b(?:were|im|we are|i am)\b([^.!?]{0,40})\bunderground\b/g, gap: 1 },
  { re: /\bunderground\b[^.!?]{0,20}\b(?:here|right now)\b/g },
  { re: /\bdark down here\b/g },
  { re: /\bdown here\b[^.!?]{0,20}\bdark\b/g },
  { re: /\b(?:were|im|we are|i am)\b([^.!?]{0,20})\bin (?:a|the|this) cave\b/g, gap: 1 },
];

export function claimsUnderground(message) {
  const text = normalize(message);
  for (const { re, gap, pre } of CLAIMS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const before = clauseBefore(text, m.index);
      const after = text.slice(m.index + m[0].length);
      if (NEGATION.test(before) || NEGATION.test(m[0])) continue;
      if (PLAN.test(before) || (gap && PLAN.test(m[gap] || ''))) continue;
      if (pre && ELSEWHERE.test(before)) continue;
      if (PAST.test(after)) continue;
      return true;
    }
  }
  return false;
}

// Built from the body's own reading, so it never states a time or height the
// bot is not at.
export function skyClaimRefusal({ y, isDay } = {}) {
  const when = isDay === true ? ' in daylight' : isDay === false ? ' at night, under the stars' : '';
  const fy = Number.isFinite(y) ? Math.floor(y) : null;
  const height = fy !== null && fy < 50
    ? ` A low Y like ${fy} is ground level in this world, not underground.`
    : '';
  return `Didn't send that: your ☁ Sky line says open sky, so you are outside on the surface${when}.${height} `
    + 'Say where you are from the Sky line. Nothing was sent.';
}

// sky: the body's own reading ('open' | 'covered' | 'underground' | 'unknown').
export function refuseSkyClaim(message, { sky, y, isDay } = {}) {
  if (sky !== 'open') return null;
  return claimsUnderground(message) ? { result: skyClaimRefusal({ y, isDay }), refused: true } : null;
}
