import { useEffect, useState, useMemo } from "react";
import { io } from "socket.io-client";
import {
  AccountPayload,
  SOCKET_EVENTS,
  SocketBarPayload,
  TradeSignal,
} from "@my-platform/types";

export type TickerData = SocketBarPayload & {
  direction: "up" | "down" | "flat";
};

export function useTradingSocket() {
  const [tickerMap, setTickerMap] = useState<Record<string, TickerData>>({});
  const [signals, setSignals] = useState<TradeSignal[]>([]);
  const [portfolio, setPortfolio] = useState<any[]>([]);
  const [account, setAccount] = useState<AccountPayload | null>(null);
  const [equityHistory, setEquityHistory] = useState<
    { time: string; equity: number }[]
  >([]);
  const [engineStatus, setEngineStatus] = useState<"ACTIVE" | "KILLED">(
    "ACTIVE",
  );

  useEffect(() => {
    const socket = io("http://localhost:4000");

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
      setPortfolio(data);
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

  const tableData = useMemo(() => Object.values(tickerMap), [tickerMap]);

  return {
    signals,
    tableData,
    engineStatus,
    portfolio,
    account,
    equityHistory,
  };
}
