import { type Stock } from '@/lib/stocks';
export function Sources({ stock }: { stock: Stock }) {
  if (stock.mode === 'sample')
    return (
      <div className="source-line">
        Illustrative sample dataset · Created Sep 9, 2026 · Not actual market
        figures
      </div>
    );
  return (
    <details className="source-line sources">
      <summary>Sources & update times · {stock.source}</summary>
      {stock.quote && (
        <>
          <p>
            Last regular-session price:{' '}
            {stock.quote.priceAt
              ? new Date(stock.quote.priceAt).toLocaleString()
              : 'Not available'}{' '}
            · {stock.quote.source}
          </p>
          <p>
            Last successful price check:{' '}
            {new Date(stock.quote.checkedAt).toLocaleString()}. A successful
            check does not mean a new trade occurred.
          </p>
        </>
      )}
      {stock.fetchedAt && (
        <p>
          Saved dataset retrieved: {new Date(stock.fetchedAt).toLocaleString()}
        </p>
      )}
      {stock.historyFeed && (
        <p>
          Historical daily prices: {stock.historyFeed}. Charts show daily bars;
          the latest price is shown separately above.
        </p>
      )}
      <p>
        <a href={stock.sourceUrl} target="_blank" rel="noreferrer">
          View company on Yahoo Finance ↗
        </a>
      </p>
      {Object.entries(stock.updated || {}).map(([k, v]) => (
        <p key={k}>
          {k.replaceAll('_', ' ').toLowerCase()}: retrieved{' '}
          {v ? new Date(v).toLocaleString() : 'Not available'}
        </p>
      ))}
      <p>
        Financial reports and ratios:{' '}
        <a
          href={stock.sourceUrl + 'financials/'}
          target="_blank"
          rel="noreferrer"
        >
          Yahoo Finance
        </a>
        , when available. Annual statement dates are shown in the table. Ratios
        are provider-reported and can be older than the latest trade price.
      </p>
    </details>
  );
}
