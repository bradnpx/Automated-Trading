# Automated Trading Application

The Automated Trading Application is a high-velocity, multi-strategy algorithmic trading platform. It connects directly to the [Alpaca Trade API](https://alpaca.markets/) for real-time market data streaming and order execution, supplemented by [Polygon.io](https://polygon.io/) for pre-market volume and supply discovery. The system is architected as a monorepo containing a real-time TypeScript trading engine, an interactive Next.js dashboard, and shared packages for types and UI components.

---

## Operating the Application

The platform is managed as a Turborepo monorepo. It requires Node.js (version 18 or higher) and pnpm (version 9 or higher) to manage dependencies and orchestrate execution.

### Environment Configuration

Before running any services, you must configure your environment. Copy the `.env.template` file to `.env` in the root of the repository and populate it with your API credentials:

```bash
# Alpaca Brokerage Credentials
APCA_API_KEY_ID=your_alpaca_key_id
APCA_API_SECRET_KEY=your_alpaca_secret_key
APCA_API_BASE_URL=https://paper-api.alpaca.markets

# Market Data Providers
POLYGON_API_KEY=your_polygon_api_key
ALPHA_VANTAGE_API_KEY=your_alpha_vantage_api_key

# Strategy Watchlist Configurations
STRATEGY_001_NAME="Basic Momentum"
STRATEGY_001_ID="basicStrategy"
STRATEGY_001_WATCHLIST="AAPL,MSFT,TSLA"
```

### Local Development

To spin up the entire application suite in development mode, execute the following command from the root directory:

```bash
pnpm dev
```

This command parallelizes the execution of the following subsystems:
- **Trading Engine**: Starts the TypeScript trading core, connecting to Alpaca WebSockets and exposing an Express control API on port `4001` and a Socket.IO server on port `4000`.
- **Web Dashboard**: Launches the Next.js frontend on `http://localhost:3000` to visualize streaming telemetry, positions, and health.

### Deployment with Docker

The application includes a `docker-compose.yml` configuration for containerized environments. To build and run the services in production mode:

```bash
docker-compose up --build -d
```

---

## Core Architecture & Engine Subsystems

The trading engine is modularized into several decoupled layers, each responsible for a distinct phase of the trading lifecycle.

| Subsystem | Primary Responsibility | Key Files |
| :--- | :--- | :--- |
| **Discovery (Scanner)** | Scans market movers and filters candidates by supply metrics. | `scanner.ts`, `scanners/preMarketScanner.ts` |
| **Pipeline (Stream)** | Manages WebSocket connections, parses bars, and routes orders. | `pipeline.ts` |
| **Strategy Engine** | Hydrates historical indicators and evaluates entry rules. | `strategies/`, `strategies/StrategyFactory.ts` |
| **Position Manager** | Tracks open risk, high-water marks, and exit thresholds. | `positionManager.ts` |
| **Executor** | Routes buy, sell, and panic orders directly to the broker. | `executor.ts` |
| **Broadcaster** | Emits real-time engine telemetry to the dashboard. | `broadcaster.ts` |
| **Control API** | Exposes HTTP endpoints for manual interventions. | `api.ts` |
| **Background Tasks** | Polling loops that sync account state and verify exit rules. | `tasks.ts` |

### Discovery (Pre-Market Scanner)
The application initiates each trading session by executing a discovery scan. It queries Alpaca's free market movers screener to isolate the top gainers, filters them based on low-price momentum (typically $1.00 to $7.00 with a minimum 10% intraday gain), and then queries Polygon's API to analyze public free-float metrics. Tickers passing these supply filters are dynamically injected into the active trading watchlists.

### Stream Pipeline
The stream pipeline is the real-time coordinator of the engine. It connects to Alpaca's high-frequency market data stream to receive 1-minute bars and Alpaca's trade execution stream to receive order status updates. When a new bar arrives, the pipeline passes it through a series of sequential filters: checking exit conditions first, broadcasting telemetry next, updating indicators, and finally evaluating new entry setups.

### Strategy Engine & Warmup
At startup, the engine executes a warmup sequence. It pulls approximately three hours of historical 1-minute bars via Alpaca's historical data API for all watched symbols. These bars are parsed using Zod schemas and used to hydrate technical indicators (such as RSI, VWAP, and Relative Volume) inside individual strategy instances. Strategies are instantiated dynamically via a central `StrategyFactory` based on configuration mapping.

### Position Manager & Risk Controls
The Position Manager maintains an in-memory representation of the active portfolio, synchronized periodically with the broker. It monitors open positions against hardcoded or strategy-specific stop-loss (SL) and take-profit (TP) thresholds. It also tracks the "high-water mark" for each position to support trailing stop logic and manages temporary locks to prevent duplicate order submissions.

### Order Executor
The Executor is a clean wrapper around the Alpaca REST API. It handles the mechanics of placing market buy orders and managing position liquidations. Before closing a position, the Executor queries the broker for any outstanding open orders associated with that ticker and cancels them to prevent execution conflicts. It also provides a global "kill switch" method to instantly liquidate all open positions and cancel all active orders.

---

## Web Dashboard Sections

The dashboard is built as a single-page Next.js application that establishes a persistent WebSocket connection to the trading engine. It is divided into several visual modules designed to provide immediate situational awareness.

```
+----------------------------------------------------------------------------------+
| Total Equity: $105,420.00 | Buying Power: $210,840.00 | Daily P&L: +$1,250.00    |
+----------------------------------------------------------------------------------+
|                                                                                  |
|   Live Equity Curve (USD)                                  [ KILL ALL SYSTEMS ]  |
|   ~~~~~~~~~~~~~~~~~~~~~~~                                                        |
|                                                                                  |
+-------------------------------------------------------------------+--------------+
| Active Positions                                                  | Live Tickers |
| Symbol | Qty | Entry  | Current | Unrealized P&L | Action         | Symbol | Lst |
| ------ | --- | ------ | ------- | -------------- | -------------- | ------ | --- |
| AAPL   | 50  | 175.20 | 176.40  | +$60.00 (0.6%) | [ Sell ]       | AAPL   | 176 |
|        |     |        |         |                |                | TSLA   | 182 |
+-------------------------------------------------------------------+--------------+
| Scanner Alerts & Logs                                             | Performance  |
| [14:05:22] HOT: NVDA breakout detected (RVOL: 6.2x)               | Win Rate: 64%|
| [14:02:11] EXEC: AAPL filled buy order @ $175.20                  | Prof. Ftr:1.8|
+-------------------------------------------------------------------+--------------+
| Engine Status: ACTIVE | Latency: 12ms | Memory: 42MB | Uptime: 3450s             |
+----------------------------------------------------------------------------------+
```

- **Account Header**: Positioned at the top of the viewport, this module displays high-level financial metrics, including total account equity, available buying power, daily dollar profit and loss, and daily percentage change.
- **Live Equity Curve**: Renders an interactive area chart visualizing the historical progression of account equity over the trading session, updated in real time with each incoming account broadcast.
- **Active Positions Table**: Displays a grid of all open positions held by the broker. It shows the asset symbol, held quantity, average entry price, current market price, and unrealized profit or loss (both in absolute dollars and percentage). Each row includes a manual liquidation button.
- **Live Tickers Watchlist**: Displays a streaming grid of all tickers currently tracked by the engine, showing their last-traded price and indicating short-term price direction (up, down, or flat) with dynamic color coding.
- **Scanner Alerts Panel**: Renders floating, high-visibility alerts whenever the engine's volume scanner detects a high-velocity breakout candidate.
- **Performance Metrics**: Computes and displays key performance indicators derived from the local trade history file, including overall win rate, profit factor, average winning trade, and average losing trade.
- **Emergency Controls**: A prominent control interface containing the global "kill switch." Clicking this button invokes the engine's panic sequence, immediately canceling all orders and liquidating all positions.
- **Health Monitor Footer**: A persistent status bar at the bottom of the interface displaying engine telemetry, including API stream connection status, server-to-client latency, engine heap memory consumption, and engine runtime uptime.
