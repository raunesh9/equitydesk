'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { AppState } from '@/lib/stocks';

export function QuoteConnection({
  app,
  onConnect,
}: {
  app: AppState;
  onConnect: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const [feed, setFeed] = useState(app.quoteFeed ?? 'iex'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const form = e.currentTarget,
      data = new FormData(form);
    try {
      const result = await onConnect({
        key: data.get('key'),
        secret: data.get('secret'),
        feed,
      });
      if (result) form.reset();
      else
        setError(
          'Connection was not saved. Check the credentials and feed access.',
        );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="key-form" onSubmit={save}>
      <h2>Frequent prices & charts</h2>
      <p className="footnote">
        {app.quotesConfigured
          ? 'Alpaca is connected. Enter a new key pair to change the connection.'
          : 'Connect Alpaca market data to update the stocks you are viewing and tracking every 30 seconds.'}{' '}
        Only market-data endpoints are used.
      </p>
      <label className="field-label" htmlFor="alpaca-key">
        Alpaca API key
      </label>
      <Input
        id="alpaca-key"
        name="key"
        type="password"
        autoComplete="off"
        required
        minLength={8}
        maxLength={200}
      />
      <label className="field-label" htmlFor="alpaca-secret">
        Alpaca secret key
      </label>
      <Input
        id="alpaca-secret"
        name="secret"
        type="password"
        autoComplete="off"
        required
        minLength={8}
        maxLength={200}
      />
      <label className="field-label" htmlFor="alpaca-feed">
        Price feed
      </label>
      <Select value={feed} onValueChange={(v) => v && setFeed(v)}>
        <SelectTrigger id="alpaca-feed" className="feed-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="iex">IEX · limited exchange coverage</SelectItem>
          <SelectItem value="sip">
            SIP · all U.S. exchanges, subscription required
          </SelectItem>
        </SelectContent>
      </Select>
      <p className="footnote">
        IEX covers trades on one exchange, which can mean sparse prices for
        smaller stocks. SIP needs the matching Alpaca subscription. Refreshing
        every 30 seconds does not guarantee a new trade.{' '}
        <a
          href="https://docs.alpaca.markets/us/docs/about-market-data-api"
          target="_blank"
          rel="noreferrer"
        >
          Feed details ↗
        </a>{' '}
        ·{' '}
        <a href="https://app.alpaca.markets/" target="_blank" rel="noreferrer">
          Get Alpaca keys ↗
        </a>
      </p>
      <p className="footnote">
        Keys stay in a private file on this Mac and are sent only to Alpaca.
        Never enter your brokerage password.
      </p>
      <Button type="submit" disabled={busy}>
        {busy ? 'Checking connection…' : 'Connect prices'}
      </Button>
      {error && (
        <p role="alert" className="error-box">
          {error}
        </p>
      )}
    </form>
  );
}
