apps/
    dashboard/          # React-based visual dashboard tracking open trades and logs
        app/            # layouts
        components/     # UI components

    engine/             # TS-based trading engine
        src/    
            config/     # Environment variables, CORS, rate-limit setups
            middleware/         # Global Express/Hono middlewares (auth, logging, validation)
                auth.ts         # Validates JWTs / sessions
                errorHandler.ts # Catches all uncaught errors and formats response
                logger.ts       # Request/Response logging.
            modules/ # Domain-specific folders (Your features)
                trades/
                    trades.controller.ts    # Handles HTTP requests/routing logic
                    trades.service.ts       # Business logic & data transformations
                    trades.schema.ts        # Request validation schemas (Zod)
                    trades.types.ts         # TypeScript interfaces
                indicators/
            strategies/ # Trading Strategies and their components
                rules/
                    registry.ts # global registry of rules
                    types.ts    # Types pertaining directly to stragety variables
                <strategyName>.ts # Strategy name and collection of criteria. repeatable, file named by strategy
            services/ # Global third-party API clients or SDK wrappers
                index.ts    # Application entry point (Server initialization)
                supabase.ts # Internal DB client
                alpaca.ts   # alpaca trading API endpoint
                polygon.ts  # polygon trading API emdpoint
                yfinance.ts # yfinance API endpoint
                massive.ts  # massive API endpoint
    docker/             # Docker build to host app