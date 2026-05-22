/** Shared heuristic: did a skill/ACTION return a failed or partial outcome? */
export function actionOutcomeFailed(result) {
  if (!result || result.error) return true;
  const text = String(result.result || '');
  const lower = text.toLowerCase();
  if (/\b(couldn't|could not|can't see|unable|failed|interrupted|needs |no .* in my inventory)\b/.test(lower)) {
    return true;
  }
  const ratio = text.match(/\b(\d+)\s*\/\s*(\d+)\b/);
  if (ratio) {
    const num = parseInt(ratio[1], 10);
    const den = parseInt(ratio[2], 10);
    if (den > 0 && num < den) return true;
  }
  return false;
}
