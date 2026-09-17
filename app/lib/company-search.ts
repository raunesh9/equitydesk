import aliases from './company-aliases.json' with { type: 'json' };

export function normalizeCompanyQuery(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\band\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function searchCompanies<T extends { symbol: string; name: string }>(
  companies: T[],
  query: string,
): T[] {
  const q = normalizeCompanyQuery(query);
  if (!q) return companies;
  const tokens = q.split(' ');
  return companies
    .map((company) => {
      const terms = [
        company.name,
        ...((aliases as Record<string, string[]>)[company.symbol] ?? []),
      ].map(normalizeCompanyQuery);
      const exactTicker =
        company.symbol.toLowerCase() === query.trim().toLowerCase();
      const namePrefix = terms.some((name) => name.startsWith(q));
      const matches = terms.some((name) =>
        tokens.every((token) => name.includes(token)),
      );
      const tickerPrefix = company.symbol
        .toLowerCase()
        .startsWith(query.trim().toLowerCase());
      return {
        company,
        score: exactTicker
          ? 0
          : namePrefix
            ? 1
            : matches
              ? 2
              : tickerPrefix
                ? 3
                : 99,
      };
    })
    .filter((result) => result.score < 99)
    .sort(
      (a, b) =>
        a.score - b.score || a.company.name.localeCompare(b.company.name),
    )
    .map((result) => result.company);
}
