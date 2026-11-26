// Sky-claim guard for public chat (agorokh/hermescraft#592, finding 2).
//
// On the flat studio world the ground is at Y -60. Steve (Kimi) kept telling
// the child "y=-60 deep underground … dark down here" while his own `mc
// status` said open sky. A rule in the system prompt (#648) and one in the
// per-turn wake prompt (#649) each helped, and the line still came back. This
// is the body-side check: while the bot stands under open sky, a public line
// that says it is underground or in the dark is not sent, and the tool result
// tells the brain what to say.

const NEGATION = /\b(?:not|no|isnt|arent|never|nowhere near)\b[^.!?]{0,12}$/;
const INTENT = /\b(?:go|going|gonna|head|heading|will|ll|could|can|want|wanna|lets|dig|digging|mine|mining|tunnel|explore|find|found|see|look)\b/;

function normalize(message) {
  return String(message || '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/'/g, '')
    .replace(/\s+/g, ' ');
}

// Each pattern names the place the speaker is in right now. `gap` (when set)
// is the text between the speaker and the place: an intent word there
// ("we're going to mine underground") makes it a plan, not a claim.
const PAST = /^[^.!?]{0,25}\b(?:earlier|before|last time|yesterday|ago)\b/;
const ELSEWHERE = /\b(?:there|theres|found|find|see|saw|spotted|mine|mining|dig|digging|ore|vein)\b[^.!?]{0,25}$/;

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
      const before = text.slice(Math.max(0, m.index - 30), m.index);
      const after = text.slice(m.index + m[0].length);
      if (NEGATION.test(before)) continue;
      if (gap && INTENT.test(m[gap] || '')) continue;
      if (pre && ELSEWHERE.test(before)) continue;
      if (PAST.test(after)) continue;
      if (/\b(?:not|no)\b/.test(m[0])) continue;
      return true;
    }
  }
  return false;
}

export const SKY_CLAIM_REFUSAL = "Didn't send that: your ☁ Sky line says open sky, so you are outside on the surface "
  + 'in daylight — Y -60 is ground level in this world. Say where you are from the Sky line '
  + '(open sky, grass, bright). Nothing was sent.';

// sky: the body's own reading ('open' | 'covered' | 'underground' | 'unknown').
export function refuseSkyClaim(message, sky) {
  if (sky !== 'open') return null;
  return claimsUnderground(message) ? { result: SKY_CLAIM_REFUSAL, refused: true } : null;
}
