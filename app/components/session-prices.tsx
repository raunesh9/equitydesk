import { money, sessionLabel, type Quote } from '@/lib/stocks';

export function SessionPrices({ quote }: { quote?: Quote }) {
  if (!quote?.sessions) return null;
  return (
    <details className="source-line sources">
      <summary>Pre-market, after-hours & overnight</summary>
      {(['regular', 'pre', 'post', 'overnight'] as const).map((session) => {
        const point = quote.sessions?.[session];
        return (
          <p key={session}>
            <strong>{sessionLabel(session)}: </strong>
            {point ? (
              <>
                {money(point.price, quote.currency)} ·{' '}
                {new Date(point.priceAt).toLocaleString()}
              </>
            ) : (
              'Not supplied by Yahoo'
            )}
          </p>
        );
      })}
      <p>
        The newest timestamped price is used for portfolio estimates and
        simulated trades. Quotes may be delayed or from a previous session.
        Overnight coverage is limited; daily charts exclude extended sessions.
      </p>
    </details>
  );
}
