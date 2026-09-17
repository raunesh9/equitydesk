'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Quote } from './stocks';
import { mergeQuoteUpdates } from './quote-updates';
export function useQuotes(
  symbols: string,
  connected: boolean,
  enabled: boolean,
  interval: number,
  revision: number,
) {
  const [quotes, setQuotes] = useState<Record<string, Quote>>({}),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (!connected || !symbols || controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    try {
      const all: Record<string, Quote> = {};
      const failures: Record<string, string> = {};
      const list = symbols.split(',');
      let failure = '';
      for (let i = 0; i < list.length; i += 20) {
        const res = await fetch(
          '/api/quotes?symbols=' +
            encodeURIComponent(list.slice(i, i + 20).join(',')),
          { signal: abort.signal },
        );
        const result = (await res.json()) as {
          quotes: Record<string, Quote>;
          error?: string;
          errors?: Record<string, string>;
        };
        if (!res.ok) throw Error(result.error || 'Price update failed.');
        Object.assign(all, result.quotes);
        Object.assign(failures, result.errors);
        failure = result.error || failure;
      }
      if (!abort.signal.aborted) {
        setQuotes((previous) => mergeQuoteUpdates(previous, all, failures));
        setError(failure);
      }
    } catch (e) {
      if (!abort.signal.aborted) {
        const message = e instanceof Error ? e.message : 'Price update failed.';
        setError(message);
        setQuotes((previous) =>
          mergeQuoteUpdates(
            previous,
            {},
            Object.fromEntries(symbols.split(',').map((s) => [s, message])),
          ),
        );
      }
    } finally {
      if (controller.current === abort) {
        controller.current = null;
        setBusy(false);
      }
    }
  }, [symbols, connected, revision]);
  useEffect(() => {
    setQuotes({});
    setError('');
  }, [connected, revision]);
  useEffect(() => {
    void refresh();
    const timer = enabled
      ? setInterval(() => void refresh(), interval * 1000)
      : null;
    const onFocus = () => {
      if (enabled) void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      if (timer) clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      controller.current?.abort();
      controller.current = null;
      setBusy(false);
    };
  }, [refresh, enabled, interval]);
  return { quotes, error, busy, refresh };
}
