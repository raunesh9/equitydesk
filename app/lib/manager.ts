import {
  portfolioTotals,
  type Holding,
  type Stock,
  type ManagerSettings,
} from './stocks.ts';

export function analyzePortfolio(
  holdings: Holding[],
  stocks: Record<string, Stock>,
  settings: ManagerSettings,
  now = Date.now(),
) {
  const totals = portfolioTotals(holdings, stocks);
  const total =
    totals.marketTotal === null ? null : totals.marketTotal + settings.cash;
  const symbols = [
    ...new Set([
      ...holdings.map((h) => h.symbol),
      ...Object.keys(settings.targets),
    ]),
  ];
  const positions = symbols.map((symbol) => {
    const lots = holdings.filter((h) => h.symbol === symbol);
    const shares = lots.reduce((sum, h) => sum + h.shares, 0);
    const stock = stocks[symbol];
    const price = stock?.currency === 'USD' ? stock.price : null;
    const value = shares === 0 ? 0 : price == null ? null : price * shares;
    const weight = total && value !== null ? (value / total) * 100 : null;
    const target = settings.targets[symbol];
    const drift =
      weight === null || target === undefined ? null : weight - target;
    return { symbol, shares, price, value, weight, target, drift };
  });
  const risks: { kind: 'warning' | 'info'; title: string; detail: string }[] =
    [];
  if (totals.missing.length)
    risks.push({
      kind: 'warning',
      title: 'Some holdings have no usable price',
      detail:
        'Total portfolio value and rebalancing are unavailable until every holding has a USD price.',
    });
  const stale = positions.filter((p) => {
    const stock = stocks[p.symbol];
    if (!stock || stock.mode === 'sample' || (!p.shares && !p.target))
      return false;
    const time = Date.parse(stock.quote?.priceAt ?? '');
    return (
      !Number.isFinite(time) ||
      now - time > 15 * 60 * 1000 ||
      now < time ||
      Boolean(stock.quote?.warning)
    );
  });
  if (stale.length)
    risks.push({
      kind: 'warning',
      title: 'Recent trade prices needed',
      detail:
        stale.map((p) => p.symbol).join(', ') +
        ': quotes are missing, older than 15 minutes, or the feed has an error. Markets may be closed or trading may be sparse. Rebalancing is paused.',
    });
  for (const p of positions) {
    if (p.weight !== null && p.shares && p.weight > settings.concentrationLimit)
      risks.push({
        kind: 'warning',
        title: p.symbol + ' concentration',
        detail:
          p.weight.toFixed(1) +
          '% of assets exceeds your ' +
          settings.concentrationLimit +
          '% single-company limit.',
      });
    if (p.drift !== null && Math.abs(p.drift) >= settings.driftLimit)
      risks.push({
        kind: 'info',
        title: p.symbol + ' allocation drift',
        detail:
          Math.abs(p.drift).toFixed(1) +
          ' percentage points ' +
          (p.drift > 0 ? 'above' : 'below') +
          ' your target.',
      });
  }
  const unset = positions.filter((p) => p.shares && p.target === undefined);
  const missingTargets = positions.filter((p) => p.target && p.price == null);
  const targetSum = Object.values(settings.targets).reduce((s, n) => s + n, 0);
  const complete = unset.length === 0 && targetSum <= 100.0000001;
  const canRebalance =
    total !== null &&
    total > 0 &&
    complete &&
    !totals.missing.length &&
    !missingTargets.length &&
    !stale.length;
  const cashTarget = Math.max(0, 100 - targetSum);
  const cashWeight = total ? (settings.cash / total) * 100 : 0;
  const needsRebalance =
    positions.some(
      (p) => p.drift !== null && Math.abs(p.drift) >= settings.driftLimit,
    ) || Math.abs(cashWeight - cashTarget) >= settings.driftLimit;
  const plan =
    canRebalance && needsRebalance
      ? positions
          .map((p) => {
            const targetValue = (total! * (p.target ?? 0)) / 100;
            const difference = targetValue - (p.value ?? 0);
            return {
              ...p,
              targetValue,
              difference,
              shareChange: p.price ? difference / p.price : 0,
            };
          })
          .filter((p) => Math.abs(p.difference) >= 0.005)
      : [];
  return {
    total,
    positions,
    risks,
    unset,
    canRebalance,
    plan,
    cashTarget,
    cashWeight,
    needsRebalance,
  };
}
