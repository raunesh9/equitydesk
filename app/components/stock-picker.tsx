'use client';
import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
} from '@/components/ui/combobox';
import { sampleStocks } from '@/lib/stocks';
import { searchCompanies } from '@/lib/company-search';
type Option = {
  symbol: string;
  name: string;
  currency?: string;
  exchange?: string;
};
export function StockPicker({
  mode,
  onPick,
  label = 'Search by company name',
  inputId,
  disabled = false,
}: {
  mode: 'sample' | 'live';
  onPick: (s: Option) => void;
  label?: string;
  inputId?: string;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState(''),
    [remote, setRemote] = useState<Option[]>([]),
    [status, setStatus] = useState('');
  useEffect(() => {
    if (mode !== 'live' || query.trim().length < 1) {
      setRemote([]);
      setStatus('');
      return;
    }
    const abort = new AbortController();
    setRemote([]);
    setStatus('Searching…');
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(
          '/api/search?q=' + encodeURIComponent(query.trim()),
          { signal: abort.signal },
        );
        const d = (await r.json()) as { results: Option[]; error?: string };
        if (!r.ok) throw Error(d.error || 'Search is unavailable.');
        setRemote(d.results);
        setStatus(d.results.length ? '' : 'No matching U.S. stocks.');
      } catch (e) {
        if (!abort.signal.aborted)
          setStatus(e instanceof Error ? e.message : 'Search is unavailable.');
      }
    }, 180);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [query, mode]);
  const options =
    mode === 'sample' ? searchCompanies(sampleStocks, query) : remote;
  return (
    <div className="stock-picker">
      <Combobox
        items={options}
        value={null}
        inputValue={query}
        onInputValueChange={setQuery}
        itemToStringLabel={(o: Option) => o.name + ' — ' + o.symbol}
        filter={null}
        onValueChange={(o: Option | null) => {
          if (o) {
            onPick(o);
            setQuery('');
          }
        }}
      >
        <ComboboxInput
          id={inputId}
          disabled={disabled}
          aria-label={label}
          placeholder={
            mode === 'sample'
              ? 'Company name · e.g. Rivian or Hadron'
              : 'Company name · e.g. Apple or Rivian'
          }
          className="stock-search"
          showTrigger={false}
        >
          <Search size={18} className="search-icon" />
        </ComboboxInput>
        <ComboboxContent>
          <ComboboxEmpty>
            {status ||
              (mode === 'live' && query.length < 1
                ? 'Search any company name or ticker.'
                : 'No matching companies.')}
          </ComboboxEmpty>
          <ComboboxList>
            {(o: Option) => (
              <ComboboxItem key={o.symbol} value={o}>
                <span className="company-result">
                  <strong>{o.name}</strong>
                  <small className="picker-exchange">
                    {o.symbol}
                    {o.exchange ? ' · ' + o.exchange : ''}
                  </small>
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}
