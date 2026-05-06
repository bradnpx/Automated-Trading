import { useEffect, useState, useMemo } from "react";
import { io } from "socket.io-client";
import {
  AccountPayload,
  HealthStatus,
  SOCKET_EVENTS,
  SocketBarPayload,
  TradeSignal,
} from "@my-platform/types";
import { eventNames } from "process";

export type TickerData = SocketBarPayload & {
  direction: "up" | "down" | "flat";
};

export function useTradingSocket() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [tickerMap, setTickerMap] = useState<Record<string, TickerData>>({});
  const [signals, setSignals] = useState<TradeSignal[]>([]);
  const [portfolio, setPortfolio] = useState<any[]>([]);
  const [account, setAccount] = useState<AccountPayload | null>(null);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [equityHistory, setEquityHistory] = useState<
    { time: string; equity: number }[]
  >([]);
  const [engineStatus, setEngineStatus] = useState<"ACTIVE" | "KILLED">(
    "ACTIVE",
  );

  useEffect(() => {
    const socket = io("http://localhost:4000", {
      transports: ["websocket"]
    });

    socket.onAny((eventName, ...args) => {
      console.log(`📡 Incoming Socket Event: [${eventName}]`, args);
    })

    socket.on("connect", () => console.log("🟢 Socket Connected to Engine!"));
    socket.on("connect_error", (err) =>
      console.error("🔴 Socket Connection Error:", err),
    );

    socket.on(SOCKET_EVENTS.HEALTH, (data: HealthStatus) => {
      const arrivalTime = Date.now();
      const sentTime = new Date(data.timestamp).getTime();

      setHealth({
        ...data,
        latency: arrivalTime - sentTime,
      });
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
        return {
          ...prev,
          [data.symbol]: { ...data, direction },
        };
      });
    });

    socket.on(SOCKET_EVENTS.SIGNAL, (signal: TradeSignal) => {
      setSignals((prev) => [signal, ...prev].slice(0, 50)); // Keep last 50
    });

    socket.on(SOCKET_EVENTS.STATUS, (data: { status: "ACTIVE" | "KILLED" }) => {
      console.log("Engine status changed: ", data.status);
      setEngineStatus(data.status);
    });

    socket.on(SOCKET_EVENTS.UPDATE, (data: any[]) => {
      console.log("💼 PORTFOLIO DATA RECEIVED:", data)
      setPortfolio(data);
    });

    socket.on(SOCKET_EVENTS.SCANNER, (data) => {
      console.log("💎 SOCKET DATA ARRIVED:", data);
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
      console.log("🔴 Cleaning up socket...");
      socket.disconnect();
    };
  }, []);

  const tableData = useMemo(() => Object.values(tickerMap), [tickerMap]);

  return {
    signals,
    tableData,
    engineStatus,
    portfolio,
    account,
    equityHistory,
    alerts,
    health,
  };
}
