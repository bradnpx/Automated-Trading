# Automated Trading App Structure
## Config Layer
Set environment variables, defaults, CORS, rate-limit setups - Everything needed before the app initializes. Try not to include settings for other layers here.

## Stock Market Interaction Layer
This layer handles all of the interactions between the user and the stock market. It leverages multiple API sources to handle specific functions. This should be created as a single class that can handle the api interchange instead of explicitly calling this or that api per function.

### API Connect
    - Alpaca
    - Market
    - Massive

### Account / System Health
    - can it connect?
    - can it retrieve account information?

### Query the market - market.ts
    - get stock information
    - get indicator information
    - get biggest movers/gainers
    - get historical bars

### Buy/Sell Orders - executor.ts
    - create order
    - retrieve/manage pending orders

### Portfolio - positionManager.ts
    - queue current stock holdings
    - does stock p:l cross risk barriers? [SL/TP]

## Strategy Layer
This layer handles all of the available strategies, scanners, and criteria metrics. It makes calls to the Market layer to get specific metrics

### Strategy Collection
    - load strategies

#### Strategy Factory
    - Create strategy
    - Set criteria
    - Set SL/TP risk ratio
    - Identify stocks to use strategy on

#### Strategy Criteria Factory
    - define individual criteria to test against stock indicators

## User Layer
This controls User settings and defaults
    - % of Account to buy with
    - Default SL/TP
    - Metrics
        - win/loss ratio
        - avg trades / day
        - success rate
        - account value
        - buying power
        - day P:L
        - total account P:L