"use client";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useMemo,
  ReactNode,
} from "react";
import { io } from "socket.io-client";
import {
  AccountPayload,
  HealthStatus,
  SOCKET_EVENTS,
  SocketBarPayload,
  StrategyEvaluationPayload,
  TradeSignal,
} from "@my-platform/types";

export interface TickerData {
  symbol: string;
  price?: number;
  timestamp?: Date | string;
  direction?: "up" | "down" | "flat";
  strategyEvaluation?: StrategyEvaluationPayload;
}

type PortfolioPayload = Record<string, unknown>;

interface ScannerAlertPayload {
  symbol: string;
  rvol: number;
  timestamp: string;
}

interface SocketContextValue {
  health: HealthStatus | null;
  tableData: TickerData[];
  signals: TradeSignal[];
  portfolio: PortfolioPayload[];
  account: AccountPayload | null;
  alerts: ScannerAlertPayload[];
  equityHistory: { time: string; equity: number }[];
  engineStatus: "ACTIVE" | "KILLED";
}

const SocketContext = createContext<SocketContextValue | null>(null);

export function SocketProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [tickerMap, setTickerMap] = useState<Record<string, TickerData>>({});
  const [strategyEvaluationMap, setStrategyEvaluationMap] = useState<
    Record<string, StrategyEvaluationPayload>
  >({});
  const [signals, setSignals] = useState<TradeSignal[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioPayload[]>([]);
  const [account, setAccount] = useState<AccountPayload | null>(null);
  const [alerts, setAlerts] = useState<ScannerAlertPayload[]>([]);
  const [equityHistory, setEquityHistory] = useState<
    { time: string; equity: number }[]
  >([]);
  const [engineStatus, setEngineStatus] = useState<"ACTIVE" | "KILLED">(
    "ACTIVE",
  );

  useEffect(() => {
    const socket = io("http://localhost:4000", {
      transports: ["websocket"],
    });

    // socket.onAny((eventName, ...args) => {
    //   console.log(`📡 [Socket] ${eventName}`, args);
    // });

    socket.on("connect", () => console.log("🟢 Socket Connected to Engine!"));
    socket.on("connect_error", (err) =>
      console.error("🔴 Socket Connection Error:", err),
    );

    socket.on(SOCKET_EVENTS.HEALTH, (data: HealthStatus) => {
      const arrivalTime = Date.now();
      const sentTime = new Date(data.timestamp).getTime();
      setHealth({ ...data, latency: arrivalTime - sentTime });
    });

    socket.on(SOCKET_EVENTS.BAR, (data: SocketBarPayload) => {
      setTickerMap((prev) => {
        const prevPrice = prev[data.symbol]?.price || data.price;
        const direction =
          data.price > prevPrice
            ? "up"
            : data.price < prevPrice
              ? "down"
              : "flat";
        return { ...prev, [data.symbol]: { ...data, direction } };
      });
    });

    socket.on(
      SOCKET_EVENTS.STRATEGY_EVALUATION,
      (evaluation: StrategyEvaluationPayload) => {
        setStrategyEvaluationMap((previous) => ({
          ...previous,
          [evaluation.symbol]: evaluation,
        }));
      },
    );

    socket.on(SOCKET_EVENTS.SIGNAL, (signal: TradeSignal) => {
      setSignals((prev) => [signal, ...prev].slice(0, 50));
    });

    socket.on(SOCKET_EVENTS.STATUS, (data: { status: "ACTIVE" | "KILLED" }) => {
      setEngineStatus(data.status);
    });

    socket.on(SOCKET_EVENTS.UPDATE, (data: PortfolioPayload[]) => {
      setPortfolio(data);
    });

    socket.on(SOCKET_EVENTS.SCANNER, (data: ScannerAlertPayload) => {
      setAlerts((prev) => [data, ...prev].slice(0, 5));
    });

    socket.on(SOCKET_EVENTS.ACCOUNT, (data: AccountPayload) => {
      setAccount(data);
      setEquityHistory((prev) => {
        const newPoint = {
          time: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }),
          equity: data.equity,
        };
        return [...prev, newPoint].slice(-100);
      });
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  const tableData = useMemo(() => {
    const symbols = new Set([
      ...Object.keys(tickerMap),
      ...Object.keys(strategyEvaluationMap),
    ]);

    return Array.from(symbols)
      .map((symbol) => ({
        ...tickerMap[symbol],
        symbol,
        strategyEvaluation: strategyEvaluationMap[symbol],
      }))
      .sort((left, right) => left.symbol.localeCompare(right.symbol));
  }, [strategyEvaluationMap, tickerMap]);

  const value: SocketContextValue = {
    health,
    tableData,
    signals,
    portfolio,
    account,
    alerts,
    equityHistory,
    engineStatus,
  };

  return (
    <SocketContext.Provider value={value}>{children}</SocketContext.Provider>
  );
}

export function useTradingSocket() {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error("useTradingSocket must be used within a SocketProvider");
  }
  return context;
}
