# EquityDesk

A local Mac app for stock research, a manually entered portfolio, and practice investing with virtual money.

## Open it again

1. Open **Documents → Stock Tool** in Finder.
2. Double-click **EquityDesk.app**. It starts the app and opens its own Mac window.
3. To keep it handy, right-click its Dock icon and choose **Options → Keep in Dock**.

If a window was already open during this update, press **Command–R** to reload it. You can also double-click **Launch EquityDesk.command** to use your normal browser. The address while running is [http://127.0.0.1:8765](http://127.0.0.1:8765).

Keep this folder in Documents. **Stop EquityDesk.command** stops the local server without deleting saved data. Closing the app window pauses that window’s price checks; an open browser window can continue checking.

## Try practice investing

The app opens on **Practice investing**, with **$100,000 in virtual cash**.

1. Find a company by name, such as **Rivian**, **Hadron**, or **Rocket Lab**, and choose a result.
2. Select Buy and enter the number of shares. Fractional shares are supported.
3. Select **Preview practice buy**. Review the Yahoo price, its timestamp, and the virtual cost.
4. Confirm the virtual buy. Your cash, practice holdings, and trade history update together.
5. Select Sell beside a holding to sell some or all of your practice shares.

Practice trades and cash stay saved when you close and reopen the app. A preview expires after 60 seconds. Repeated confirmation does not create duplicate trades. You cannot spend more virtual cash or sell more practice shares than you own.

**Reset practice account** clears only practice holdings and trades and restores $100,000. It keeps your manually entered holdings and research notes.

This is a simulation, with no brokerage connection and no real orders. Fills use the displayed Yahoo regular-session price, including outside market hours; this price may be delayed. Fills do not model liquidity, bid/ask spreads, slippage, commissions, taxes, dividends, or stock splits. A recently checked price is required; unavailable, failed, non-USD, or prices more than seven days old cannot be used for a practice trade.

## Research and track actual holdings

- **Research:** search a company name and inspect its price chart, available annual financial reports, debt, cash flow, and valuation ratios.
- **Compare:** compare up to three companies. Charts use common trading dates.
- **Watchlist:** save companies and personal research notes. Select **Save notes** after editing.
- **My holdings:** choose **Add holding**, find the company by name, and enter shares and average purchase cost. Use the pencil to update it. This portfolio is separate from practice trades.
- **Cash & targets:** enter your actual cash balance, target percentages, and risk thresholds. Concentration and allocation-drift flags help you review your own plan; no trades are made for you.

## Company coverage and Yahoo data

Yahoo Finance is enabled by default and needs no API key. The app uses [yfinance](https://ranaroussi.github.io/yfinance/), an unofficial client for Yahoo’s public interfaces, for personal research and educational use. Yahoo can change availability, delay prices, or limit requests. It does not guarantee continuous real-time market data.

Company-name search uses a saved Nasdaq Trader directory covering Nasdaq, NYSE, NYSE American, NYSE Arca, and other U.S. venues. It included **12,776 listings** on September 9, 2026, including RIVN and HDRN. This includes ETFs and other securities, not just unique companies. A Yahoo search also runs when the local directory has no verified result. Coverage depends on Yahoo and is not a promise that every listing has a complete financial history.

The directory refreshes daily when searching and keeps its previous copy if the download fails. The Dow is an index; its members are found through exchange listings. [Nasdaq Trader directory source](https://www.nasdaqtrader.com/trader.aspx?id=symboldirdefs).

Prices are checked every **30 seconds while a window is open**, for the companies you are viewing and tracking. Pause with the **Automatic prices** switch. Use **Refresh prices** in Practice or **Refresh now** elsewhere for a manual check. Prices may stay unchanged when markets are closed or no new quote is available.

Each price shows its market timestamp and successful retrieval time. When a refresh fails, any saved price keeps its original timestamps and shows a warning. Requests back off when Yahoo limits them. Daily chart data refreshes every 15 minutes; company details and financial reports are saved for six hours. Nothing polls the entire exchange directory for quotes.

Rivian, Hadron, and Rocket Lab price histories and quotes were checked successfully during this update. Rivian and Hadron annual statements also loaded from Yahoo.

## Understand missing figures and portfolio estimates

Missing data says **Not available** and is never replaced by sample figures or zero. A zero is shown only when the provider reports zero. Open **Sources & update times** for source links, retrieval times, and financial period dates.

Charts show available unadjusted daily prices. Returns exclude dividends and may be affected by splits; “All” means all loaded history, currently up to one year. Annual reports can use different fiscal calendars. Free cash flow is provider-reported where available, or calculated from operating cash flow minus absolute capital expenditure when both inputs exist. Debt requires a provider total-debt figure. Ratios are provider-reported and may be older than the latest quote.

Full portfolio totals need a USD price for every holding. Saved or delayed quotes are estimates, not executable prices. Rebalancing uses your own targets and pauses when prices are missing, failed, or older than 15 minutes. Blank targets mean undecided; 0% means an intentional exit. Stock targets can total at most 100%; the remainder is cash. Review fees, taxes, liquidity, and actual prices before any real transaction.

Actual holdings, cost basis, and cash are entered manually. Dividends, tax lots, and sales history are not tracked for this manual portfolio. Risk flags cover concentration and allocation drift, not every investment risk.

## Previous demo data

**Data connection → Open demo archive** preserves the earlier eight-company offline demo, including its notes and holdings. That archive uses clearly labeled synthetic prices. **Open real workspace** restores full company search and Yahoo research. The practice trading account always uses Yahoo prices and remains separate from both workspaces.

## Saved data and backup

Everything you enter stays in this folder’s `data` directory. To back up, stop the app and copy `data` somewhere private. Older provider keys, if previously saved, remain private files there; the new Yahoo integration does not use them. The browser never receives these keys.

The server listens only on this Mac at 127.0.0.1. Yahoo receives the company names and symbols being requested, not your notes, positions, or account balances.

## Software and maintenance

All required software is installed on this Mac. The launcher uses the project’s `.venv-yahoo` Python 3.12 environment and pinned yfinance dependencies. The Mac window uses Apple’s WebKit. Node was used to build the interface and does not run while you use the finished app.

VS Code is optional: open this **Stock Tool** folder in VS Code to edit the project. `server.py` handles local API/storage, `yahoo_data.py` handles Yahoo, `paper.py` handles the virtual ledger, `market.py` handles the listing directory and the earlier provider adapter, `app/` contains the interface, and `native/` contains the Mac window. Browser output is in `app/dist/client`.

For future changes, ask Codex to edit this folder, run the Python and frontend tests, rebuild the interface, and restart the local server. `requirements.txt` pins the Yahoo client; `requirements-lock.txt` records its installed dependency versions. A moved or deleted Python runtime may require rebuilding `.venv-yahoo` with Python 3.12 and installing those requirements.
