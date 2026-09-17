import type { Quote } from './stocks';

// A failure for one company must not label every successful quote as failed.
export function mergeQuoteUpdates(
  previous: Record<string, Quote>,
  fresh: Record<string, Quote>,
  failures: Record<string, string>,
) {
  const next = { ...previous, ...fresh };
  for (const [symbol, message] of Object.entries(failures)) {
    if (next[symbol] && !fresh[symbol])
      next[symbol] = { ...next[symbol], warning: message };
  }
  return next;
}
