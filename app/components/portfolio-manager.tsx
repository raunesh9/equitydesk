'use client';
import { useEffect, useState } from 'react';
import { ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { analyzePortfolio } from '@/lib/manager';
import { money, defaultManager, type AppState, type Stock } from '@/lib/stocks';

export function PortfolioManager({
  app,
  stocks,
  onSave,
}: {
  app: AppState;
  stocks: Record<string, Stock>;
  onSave: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const settings = app.manager ?? defaultManager;
  const analysis = analyzePortfolio(app.holdings, stocks, settings, clock);
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setSaving(true);
    const form = new FormData(e.currentTarget),
      targets: Record<string, number> = {};
    for (const p of analysis.positions) {
      const value = String(form.get('target-' + p.symbol) ?? '').trim();
      if (value !== '') targets[p.symbol] = Number(value);
    }
    try {
      const result = await onSave({
        cash: Number(form.get('cash')),
        concentrationLimit: Number(form.get('concentration')),
        driftLimit: Number(form.get('drift')),
        targets,
      });
      if (result) setOpen(false);
      else
        setError(
          'Could not save. Check the amounts and make sure target percentages total no more than 100%.',
        );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="manager-section">
      <div className="section-heading">
        <div>
          <p className="eyebrow">PORTFOLIO MANAGER</p>
          <h2>Your plan, kept in view.</h2>
          <p className="muted">Risk flags and rebalancing for your review.</p>
        </div>
        <Button variant="outline" onClick={() => setOpen(true)}>
          <SlidersHorizontal />
          Cash & targets
        </Button>
      </div>
      <div className="manager-summary">
        <div>
          <span>Total assets · including cash</span>
          <strong>{money(analysis.total)}</strong>
        </div>
        <div>
          <span>Cash balance</span>
          <strong>{money(settings.cash)}</strong>
        </div>
        <div>
          <span>Single-company limit</span>
          <strong>{settings.concentrationLimit}%</strong>
        </div>
      </div>
      <div className="manager-grid">
        <article className="panel">
          <div className="section-heading">
            <h2>Keep an eye on</h2>
            <ShieldCheck size={20} />
          </div>
          {analysis.risks.length ? (
            analysis.risks.map((r, i) => (
              <div className={'risk-item ' + r.kind} key={i}>
                <strong>{r.title}</strong>
                <p>{r.detail}</p>
              </div>
            ))
          ) : (
            <p className="muted">
              {app.holdings.length
                ? 'No flags from the checks above. This is not a complete assessment of investment risk.'
                : 'Add holdings to check prices, concentration, and allocation drift.'}
            </p>
          )}
          <p className="footnote">
            Thresholds start at 25% per company and 5 percentage points of
            drift. Adjust them to your own plan. Exposure to sectors, leverage,
            liquidity, and events needs your separate review.
          </p>
        </article>
        <article className="panel">
          <h2>Rebalance for review</h2>
          <p className="footnote">
            You choose the targets. A blank target means undecided; 0% means an
            intentional exit. Any remaining percentage is held as cash.
          </p>
          {analysis.unset.length > 0 ? (
            <p className="warning-box">
              Set a target for {analysis.unset.map((p) => p.symbol).join(', ')}{' '}
              to calculate a plan.
            </p>
          ) : !analysis.canRebalance ? (
            <p className="empty-inline">
              A plan needs a positive portfolio value, complete targets, and
              recent USD quotes for all relevant stocks.
            </p>
          ) : !analysis.plan.length ? (
            <p className="success-box">
              Your allocations are within the chosen drift threshold.
            </p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Company</TableHead>
                    <TableHead className="number">Current → target</TableHead>
                    <TableHead className="number">Suggested change</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {analysis.plan.map((p) => (
                    <TableRow key={p.symbol}>
                      <TableCell>{p.symbol}</TableCell>
                      <TableCell className="number">
                        {p.weight?.toFixed(1)}% → {p.target}%
                      </TableCell>
                      <TableCell className="number">
                        <strong>
                          {p.difference > 0 ? 'Buy ' : 'Sell '}
                          {money(Math.abs(p.difference))}
                        </strong>
                        <span className="table-subtitle">
                          ≈ {Math.abs(p.shareChange).toFixed(4)} shares
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="footnote">
                Cash after the illustrated changes:{' '}
                {money((analysis.total! * analysis.cashTarget) / 100)} (
                {analysis.cashTarget.toFixed(1)}%). Assumes fractional shares,
                unchanged prices, and no fees or taxes. Review costs, tax
                effects, and order prices with your broker. No orders are
                placed.
              </p>
            </>
          )}
          {app.mode === 'sample' && (
            <p className="sample-tag manager-sample">
              SAMPLE PRICES · PRACTICE PLAN
            </p>
          )}
        </article>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="settings-dialog">
          <DialogHeader>
            <DialogTitle>Cash & allocation targets</DialogTitle>
            <DialogDescription>
              Set your own plan. Settings are saved separately for sample and
              real holdings.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={save}>
            <label className="field-label" htmlFor="manager-cash">
              Cash balance (USD)
            </label>
            <Input
              name="cash"
              id="manager-cash"
              type="number"
              min="0"
              max="1000000000000"
              step="any"
              required
              defaultValue={settings.cash}
            />
            <div className="manager-fields">
              <div>
                <label className="field-label" htmlFor="manager-limit">
                  Company concentration limit (%)
                </label>
                <Input
                  name="concentration"
                  id="manager-limit"
                  type="number"
                  min="1"
                  max="100"
                  step="any"
                  required
                  defaultValue={settings.concentrationLimit}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="manager-drift">
                  Rebalance at drift (percentage points)
                </label>
                <Input
                  name="drift"
                  id="manager-drift"
                  type="number"
                  min="0.1"
                  max="100"
                  step="any"
                  required
                  defaultValue={settings.driftLimit}
                />
              </div>
            </div>
            <p className="footnote">
              Stock targets must total 100% or less. Unallocated weight becomes
              your cash target.
            </p>
            {analysis.positions.map((p) => (
              <div className="target-field" key={p.symbol}>
                <label htmlFor={'target-' + p.symbol}>
                  {p.symbol} target (%)
                </label>
                <Input
                  id={'target-' + p.symbol}
                  name={'target-' + p.symbol}
                  type="number"
                  min="0"
                  max="100"
                  step="any"
                  placeholder="Not decided"
                  defaultValue={p.target ?? ''}
                />
              </div>
            ))}
            {!analysis.positions.length && (
              <p className="footnote">
                Add holdings first to set company targets.
              </p>
            )}
            {error && (
              <p className="error-box" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" disabled={saving} className="save-targets">
              {saving ? 'Saving…' : 'Save my plan'}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
