# Automated Trading App

Applies a strategy to a group of watched stocks and places orders using Alpaca API

## Current State

### Buy moves

1. Monitors hardcoded watchlist
2. Checks multistrategy criteria against attached tickers
3. if all criteria of strategy are a go:
   1. check if engine is either LIVE or KILLED (in Emergency Shutdown mode)
   2. check if stock is already in position
4. Place the order

Next Steps:

1. Dynamic watchlist - allow for UI-driven add/remove stocks to watchlist
2. Adjustable investment - UI-driven amount of portfolio to go in on.

### Auto-Sell moves

1. Monitors portfolio
2. Checks P&L% Against hardcoded stop-loss and take-profit margins
3. If either margin is crossed, close the order
4. Wait for close to execute
5. Update portfolio

Next Steps:

1. Adjustable P&L for strategies/stocks
2. Trailing Stop-loss
3. Half-out
4. Dog-ear 50% of profits for taxes, taking it out of total capital
   - Transfer to Robinhood acct.

### Manual Sell

1. Each stock in the portfolio has a sell button
2. If clicked, close the order
3. Update portfolio

### Emergency Kill Switch

1. Big red button in the upper right to sell EVERYTHING and kill the engine
2. When confirmed, sell all positions
3. Put engine in Emergency Shutdown mode
4. Click again to restart Engine

Next Steps:

1. Halt trades for the day if 3 consecutive losses OR >5% overall portfolio loss

### Logging

1. When positions are opened or closed, log the trade in an external JSON file
2. Calculates success rate based on number of winning trades

Next Steps:

1. Attach strategy to trade logs
2. Trade Log page with sorting and filtering
3. Show stats
   - Avg trades per day
   - Avg daily PnL
   - Avg daily success rate
   - total PnL
   - total success rate
   - split stats among strategies
4. Group open/close trades onto one row


### UI
- Top bar shows total equity, buying power, daily pnl and daily % change
- live equity curve showing overall equity
- win rate/profit factor/average winloss
- ticker watchlist
- active positions
- log
- scanner active

Next Steps:
1. line chart has no labels
2. line chart should allow for multiple time scales so I can see more than just the last minute
3. condense some of the stats, they don't need as much space as they have
4. break some components out into separate, tabbed views [scanner, logs]
5. manual sell needs a "selling..." message to confirm the click worked


## Todo

### AWS Deployment
1. purchase an AWS server to mount app
2. keep it perpetually running

### Push Notifications
1. send trades and important messages to my phone

### Failsafes
1. If there is a momentary outage, send an alert and monitor for extended outage
2. If the outage is extended, halt all purchases for the day and try to close positions asap
3. stop trading after 3 consecutive losses in a day
4. monitor stocks for haltages

### Backtesting

1. create backtesting portal

### APIs

1. balance API usage between Polygon, Alpaca, and maybe AlphaVantage

### Dynamic Strategies

1. Attach multiple strategies to a single stock - right now it's one strategy per ticker

### Scanner

1. Show potential stocks based on scanner criteria
2. Multiple scanners with varying criteria

### Adjustable Stop-loss/Take-profit

1. Slider to adjust the global SL/TP
2. Adjust by RR Ratio and stop-loss bottom
3. Stretch - separate SL/TP margins for separate strategies

### Global Indicators

- TICK
- VIX

### Strategies

- Day trades
- 1-day Swing
- Penny Stocks
- Ross Cameron
- TICK fade
- Gap fade
- Bear ETFs
- HOLP/LOHP